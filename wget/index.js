var execFile = require('child_process').execFile;
var crypto = require('crypto');
var fs = require('fs');
var path = require('path');
var archive = require('../archiver');
var discoverAssetHosts = require('./discover');
var writeStartHere = require('./start-here');

/**
 * Every download gets its own directory under downloads/, which keeps two
 * people downloading the same site from writing into each other's files and
 * keeps cleanup from ever reaching outside this folder.
 */
var DOWNLOAD_ROOT = path.join(__dirname, '..', 'downloads');

// wget mirrors recursively, so without a ceiling a single request can fill the
// disk. Both limits can be raised through the environment. They are far more
// generous than they were when only HTML came down: a real site's images and
// fonts dwarf its markup, and they take longer to fetch.
var QUOTA = process.env.DOWNLOAD_QUOTA || '500m';
var TIMEOUT_MS = Number(process.env.DOWNLOAD_TIMEOUT_MS) || 10 * 60 * 1000;

/**
 * wget --mirror --convert-links --adjust-extension --page-requisites
 * --no-parent --span-hosts --domains=<allowlist> http://example.org
 * --mirror – Makes (among other things) the download recursive.
 * --convert-links – convert all the links (also to stuff like CSS stylesheets) to relative, so it will be suitable for offline viewing.
 * --adjust-extension – Adds suitable extensions to filenames (html or css) depending on their content-type.
 * --page-requisites – Download things like CSS style-sheets and images required to properly display the page offline.
 * --no-parent – When recurring do not ascend to the parent directory. It useful for restricting the download to only a portion of the site.
 * --span-hosts – Allow the mirror to leave the site's own hostname, which is
 *   the only way --page-requisites will follow a stylesheet or an image onto a
 *   CDN. On its own this would let wget wander off into the rest of the web,
 *   so it is always paired with:
 * --domains – The allowlist worked out by the discovery pass below: the site
 *   itself plus exactly the hosts its front page loads assets from.
 *
 * This all has to happen in one invocation. --convert-links only rewrites
 * references to files fetched during the same run, so splitting the CDN assets
 * into a second wget would leave the HTML still pointing at the live internet.
 */
module.exports = (socket, data, onFinished) => {
  var done = typeof onFinished === 'function' ? onFinished : function () {};
  var send = (payload) => socket.emit(data.token, payload);

  var target = parseTarget(data.website);
  if (!target) {
    send({ error: 'That does not look like a website address. Try something like https://example.com' });
    done();
    return null;
  }

  var jobId = crypto.randomBytes(8).toString('hex');
  var jobDir = path.join(DOWNLOAD_ROOT, jobId);
  try {
    fs.mkdirSync(jobDir, { recursive: true });
  } catch (err) {
    send({ error: 'Could not create a working directory on the server: ' + err.message });
    done();
    return null;
  }

  var settled = false;
  var cancelled = false;
  var timedOut = false;
  var quotaExceeded = false;
  var stderrTail = [];
  var child = null;

  var fail = (message) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    removeJobDir(jobDir);
    send({ error: message });
    done();
  };

  // Used when the caller hung up: the job is closed out quietly, with no error
  // sent to a socket that is no longer listening.
  var abandon = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    removeJobDir(jobDir);
    done();
  };

  // The clock covers the whole job, discovery included, so the ceiling the
  // operator configured is the real one.
  var timer = setTimeout(() => {
    timedOut = true;
    if (child) {
      child.kill();
    } else {
      fail(timeoutMessage());
    }
  }, TIMEOUT_MS);

  send({ progress: 'Looking up where ' + target.hostname + ' keeps its assets\n' });
  discoverAssetHosts(target, (discoveryError, hosts) => {
    if (settled) return;
    if (cancelled) {
      abandon();
      return;
    }
    if (timedOut) {
      fail(timeoutMessage());
      return;
    }
    // A failed lookup is not a failed download. Fall back to the old
    // same-host-only behaviour rather than refusing to mirror anything.
    startMirror(discoveryError ? null : discoverAssetHosts.buildDomainList(target, hosts));
  });

  function startMirror(domains) {
    var args = ['-mkEp', '-np'];
    if (domains && domains.length) {
      args.push('-H', '--domains=' + domains.join(','));
      send({ progress: 'Including assets from: ' + domains.join(', ') + '\n' });
    }
    args.push('--no-if-modified-since', '--quota=' + QUOTA, target.href);

    // execFile rather than exec: the address is passed as a separate argument
    // and never reaches a shell, so it cannot be used to run other commands.
    child = execFile('wget', args, { cwd: jobDir, maxBuffer: 32 * 1024 * 1024 });

    // Fires when wget itself cannot be started, which on a fresh machine
    // almost always means it is not installed.
    child.on('error', (err) => {
      if (err.code === 'ENOENT') {
        fail('wget is not installed on the server. Install it and restart the app: ' +
             'apt install wget, brew install wget, or winget install JernejSimoncic.Wget');
        return;
      }
      fail('Could not start the download: ' + err.message);
    });

    child.stderr.on('data', (chunk) => {
      var text = chunk.toString();
      // wget stops cleanly once the quota is reached, having printed
      // "Download quota of 500m EXCEEDED!". Everything downloaded so far is
      // intact, but the mirror is short pages and assets. Saying "Completed"
      // and nothing else would hand back a partial site that looks whole.
      if (/Download quota of .* EXCEEDED/i.test(text)) quotaExceeded = true;
      stderrTail = stderrTail.concat(text.split('\n')).slice(-60);
      send({ progress: text });
    });

    child.on('close', (code) => {
      if (settled) return;
      clearTimeout(timer);

      if (cancelled) {
        abandon();
        return;
      }
      if (timedOut) {
        fail(timeoutMessage());
        return;
      }

      // Trust the filesystem rather than wget's output. wget writes nothing at
      // all for an off-site redirect, a robots.txt exclusion or a 403, and the
      // previous approach of naming the folder from the first "Resolving" line
      // then archived a directory that was never created.
      if (!containsFiles(jobDir)) {
        fail('Nothing could be downloaded from ' + target.hostname + '. ' +
             explainFailure(stderrTail, code));
        return;
      }

      settled = true;
      send({ progress: 'Converting' });

      // Assets now arrive in a folder per hostname, so the archive root needs
      // something that says which file to open. A landing page is a nicety, so
      // it must never be the reason a finished download is lost - and throwing
      // from inside this event handler would take the whole server with it.
      try {
        writeStartHere(jobDir, target);
      } catch (err) {
        console.error('Could not add START-HERE.html: ' + err.message);
      }

      var zipName = target.hostname.replace(/[^a-zA-Z0-9._-]/g, '_') + '-' + jobId;
      archive(jobDir, zipName, (err, name) => {
        removeJobDir(jobDir);
        if (err) {
          send({ error: 'The site downloaded but could not be compressed: ' + err.message });
        } else if (quotaExceeded) {
          send({
            progress: 'Completed',
            file: name,
            warning: 'This archive is incomplete. The download stopped at the ' + QUOTA +
                     ' size limit, so some pages and assets are missing. Raise ' +
                     'DOWNLOAD_QUOTA on the server to capture the whole site.'
          });
        } else {
          send({ progress: 'Completed', file: name });
        }
        done();
      });
    });
  }

  function timeoutMessage() {
    return 'The download took longer than ' + Math.round(TIMEOUT_MS / 1000) +
           ' seconds and was stopped. Try a smaller site or a specific page.';
  }

  return {
    cancel: function () {
      cancelled = true;
      // The mirror may not have started yet, in which case there is no process
      // to stop and the job has to be closed out here instead.
      if (child) {
        child.kill();
      } else {
        abandon();
      }
    }
  };
};

/**
 * Accepts what the user typed and returns a URL only if it is a real http(s)
 * address. Anything else is rejected before it reaches wget.
 */
function parseTarget(input) {
  if (typeof input !== 'string' || !input.trim()) return null;
  var raw = input.trim();
  var url;
  try {
    // Only assume http:// when no scheme was given at all. Prefixing a value
    // that already has one turns file:///etc/passwd into a request for a host
    // called "file" instead of rejecting it.
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : 'http://' + raw);
  } catch (err) {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.hostname) return null;
  return url;
}

/**
 * wget's closing lines are usually a summary, so the last line is rarely the
 * reason anything failed. Prefer the last line that actually looks like one.
 */
function explainFailure(lines, exitCode) {
  var interesting = /failed|unable|refused|denied|ERROR \d|error \d|robots|No such|not found|forbidden|timed out|giving up|Unsupported scheme/i;
  for (var i = lines.length - 1; i >= 0; i--) {
    var line = lines[i].trim();
    if (line && interesting.test(line)) return line;
  }
  if (exitCode === 8) return 'The server refused the request (it may block automated downloads).';
  return 'wget exited with code ' + exitCode + ' without saving any files.';
}

/**
 * True as soon as one file is found anywhere under directory. Only the
 * question "did anything come down at all" is being asked, and stopping at the
 * first answer matters now that a mirror routinely holds thousands of files:
 * this runs synchronously inside an event handler, so every extra readdir
 * stalls every other connected user.
 */
function containsFiles(directory) {
  var entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (err) {
    return false;
  }
  for (var i = 0; i < entries.length; i++) {
    if (!entries[i].isDirectory()) return true;
  }
  for (var j = 0; j < entries.length; j++) {
    if (containsFiles(path.join(directory, entries[j].name))) return true;
  }
  return false;
}

/**
 * Deletes a single job directory. The guard matters: the previous version
 * joined an empty string onto the app root and recursively deleted the whole
 * application whenever the hostname had not been captured yet.
 */
function removeJobDir(directory) {
  var resolved = path.resolve(directory);
  var root = path.resolve(DOWNLOAD_ROOT);
  if (resolved === root || !resolved.startsWith(root + path.sep)) {
    console.error('Refusing to delete a path outside the downloads folder: ' + resolved);
    return;
  }
  fs.rm(resolved, { recursive: true, force: true }, (err) => {
    if (err) console.error('Could not clean up ' + resolved + ': ' + err.message);
  });
}
