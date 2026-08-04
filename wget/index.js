var execFile = require('child_process').execFile;
var crypto = require('crypto');
var fs = require('fs');
var path = require('path');
var archive = require('../archiver');
var discoverAssetHosts = require('./discover');
var collectSitemapUrls = require('./sitemap');
var classifyHosts = require('./classify');
var createTracker = require('./progress');
var lazyImages = require('./lazy-images');
var writeThirdPartyReport = require('./third-party');
var writeStartHere = require('./start-here');

// Trackers, ad pixels, consent banners and chat widgets are dropped from the
// allowlist by default: none of them do anything in an offline copy. Set
// KEEP_TRACKERS=1 to mirror the page exactly as served instead.
var KEEP_TRACKERS = process.env.KEEP_TRACKERS === '1';

// Extra starting points handed to wget, written inside the job directory and
// removed before anything is archived so it never lands in a user's zip.
var SEED_FILE = '.wget-seeds.txt';
var LAZY_FILE = '.wget-lazy-images.txt';
var ALL_IMAGE_SIZES = process.env.ALL_IMAGE_SIZES === '1';

// How many pages the asset lookup reads before the mirror starts, the entry
// page included. Enough that a thin front page does not decide the allowlist
// for the whole site, few enough that nobody waits on it.
var HOST_SAMPLE_PAGES = 4;

// Nothing new arriving for this long means the mirror has wedged rather than
// finished. Set generously above the pause one large file or a slow server can
// produce, so a working download is never cut short.
var STALL_MS = Number(process.env.DOWNLOAD_STALL_MS) || 120 * 1000;
var STALL_CHECK_MS = 15 * 1000;

/**
 * Every download gets its own directory under downloads/, which keeps two
 * people downloading the same site from writing into each other's files and
 * keeps cleanup from ever reaching outside this folder.
 */
var DOWNLOAD_ROOT = path.join(__dirname, '..', 'downloads');

// wget mirrors recursively, so without a ceiling a single request can fill the
// disk. This runs on the operator's own machine rather than a shared host, so
// the ceilings are set high enough to take a whole media-heavy site in one go
// and exist mainly to stop a runaway crawl. Both are overridable, and hitting
// either is reported rather than passed off as a finished download.
var QUOTA = process.env.DOWNLOAD_QUOTA || '2g';
var TIMEOUT_MS = Number(process.env.DOWNLOAD_TIMEOUT_MS) || 30 * 60 * 1000;

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
  var tracker = null;
  var statsTimer = null;
  var hostReport = null;
  var mirrorDomains = null;
  var mirrorFinished = false;
  var stallTimer = null;
  var stalled = false;

  // The server-wide default can be overridden per download from the page, so
  // one person can take an archive to read and the next can take everything to
  // move a site with.
  var keepTrackers = KEEP_TRACKERS || data.includeTrackers === true;

  // wget can save hundreds of files a second. Redrawing that often is wasted
  // work, so updates are coalesced onto a fixed tick.
  function scheduleStats() {
    if (statsTimer || !tracker) return;
    statsTimer = setTimeout(function () {
      statsTimer = null;
      if (!settled && tracker) send({ stats: tracker.snapshot(Date.now()) });
    }, 400);
  }

  function flushStats() {
    if (statsTimer) {
      clearTimeout(statsTimer);
      statsTimer = null;
    }
    if (tracker) send({ stats: tracker.snapshot(Date.now()) });
  }

  var fail = (message) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (statsTimer) { clearTimeout(statsTimer); statsTimer = null; }
    if (stallTimer) { clearInterval(stallTimer); stallTimer = null; }
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
    if (statsTimer) { clearTimeout(statsTimer); statsTimer = null; }
    if (stallTimer) { clearInterval(stallTimer); stallTimer = null; }
    removeJobDir(jobDir);
    done();
  };

  // The clock covers the whole job, discovery included, so the ceiling the
  // operator configured is the real one.
  var timer = setTimeout(() => {
    // Once the mirror itself is done the site is on disk, and everything still
    // running is only trying to improve it. Throwing that away over a deadline
    // would be the wrong trade, so the repairs are abandoned and the archive is
    // built from what is there.
    if (mirrorFinished) {
      if (child) { try { child.kill(); } catch (err) { /* already gone */ } }
      send({ progress: 'Taking longer than expected; packaging what has been downloaded\n' });
      finishAfterMirror();
      return;
    }
    timedOut = true;
    if (child) {
      child.kill();
    } else {
      fail(timeoutMessage());
    }
  }, TIMEOUT_MS);

  // Set by startMirror so the deadline above can reach the archive step.
  var finishAfterMirror = function () { /* replaced once the mirror starts */ };

  // The sitemap is read first so the asset lookup has more than the front page
  // to go on. A crawl only reaches pages something links to; the sitemap is
  // where the orphans are, and it doubles as a list of pages worth sampling.
  collectSitemapUrls(target, function (seeds) {
    if (settled) return;
    if (cancelled) { abandon(); return; }
    if (timedOut) { fail(timeoutMessage()); return; }

    send({ progress: 'Looking up where ' + target.hostname + ' keeps its assets\n' });
    discoverAssetHosts.discoverAcross(target, seeds, HOST_SAMPLE_PAGES, (discoveryError, hosts) => {
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
      var domains = null;
      if (!discoveryError) {
        hostReport = classifyHosts(hosts);
        var wanted = keepTrackers ? hosts : hostReport.keep;
        domains = discoverAssetHosts.buildDomainList(target, wanted);
        // Say what was left out. Filtering the user cannot see is the same class
        // of problem as an empty archive reported as a finished download.
        if (!keepTrackers && hostReport.skip.length) {
          send({
            progress: 'Skipping ' + hostReport.skip.map(function (s) {
              return s.host + ' (' + s.why + ')';
            }).join(', ') + '\n'
          });
        }
      }

      startMirror(domains, seeds);
    });
  });

  function startMirror(domains, seeds) {
    mirrorDomains = domains;
    finishAfterMirror = function () { finish(); };
    var args = ['-mkEp', '-np'];
    if (domains && domains.length) {
      args.push('-H', '--domains=' + domains.join(','));
      send({ progress: 'Including assets from: ' + domains.join(', ') + '\n' });
    }

    if (seeds && seeds.length) {
      try {
        fs.writeFileSync(path.join(jobDir, SEED_FILE), seeds.join('\n'));
        args.push('--input-file=' + SEED_FILE);
        send({ progress: 'Sitemap lists ' + seeds.length + ' pages; adding them as starting points\n' });
      } catch (err) {
        // Seeding is an improvement, not a requirement. Mirror anyway.
        console.error('Could not write the sitemap seed file: ' + err.message);
      }
    }

    // Skip the fixed-width re-renders behind every responsive srcset. The
    // originals are still fetched, and rewrite() removes the srcset afterwards
    // so the browser uses them. Worth roughly half the download on an
    // image-heavy site. ALL_IMAGE_SIZES=1 mirrors the site exactly as served.
    if (!ALL_IMAGE_SIZES) {
      args.push('--reject-regex=' + lazyImages.REJECT_REGEX, '--regex-type=posix');
    }

    // --trust-server-names would remove a real duplicate: the allowlist has to
    // hold both the apex and its www twin so a redirect between them is not
    // treated as leaving the site, and the same page can then be written under
    // both names. caminoverde.org came back as 79 pages plus 78 more.
    //
    // It is left off for now because it was not possible to separate its
    // effects from this site's own behaviour: runs stalled part way through
    // both with and without it. The stall watchdog below is the thing that
    // actually made downloads finish, and the duplication is wasteful rather
    // than harmful. Worth revisiting against a site that mirrors cleanly.

    // Bound every request. wget's defaults are a 900 second read timeout and
    // twenty attempts, so one asset whose server accepts the connection and
    // then stops talking holds the whole mirror open for hours: the process is
    // alive, the file count never moves, and nothing in the output says why.
    // A download of caminoverde.org stalled here at 766 files with no
    // explanation until the process was inspected directly.
    args.push('--timeout=30', '--tries=3', '--waitretry=2');

    args.push('--no-if-modified-since', '--quota=' + QUOTA, target.href);

    tracker = createTracker(Date.now(), seeds ? seeds.length : 0);

    // A watchdog on actual progress, not on wget's own promises.
    //
    // --timeout is not enough. Mirroring caminoverde.org, wget settled with two
    // established TLS connections to the CDN that simply stopped sending: no
    // bytes, no CPU, no output, and the request timeout never fired. The job
    // sat like that indefinitely with the site already downloaded, because
    // nothing was watching whether the download was still moving.
    //
    // So progress is measured here. If nothing new arrives for long enough,
    // wget is stopped and what has been collected goes on to be archived,
    // which is a far better answer than waiting forever for one asset.
    // Progress is judged by what reaches the disk, not by what wget says it is
    // doing. Those are not the same thing: a mirror caught in a redirect loop
    // reports a steady stream of fetches while writing nothing new, so a
    // watchdog reading only wget's output sees a healthy download forever.
    var lastCount = -1;
    var lastMovedAt = Date.now();
    stallTimer = setInterval(function () {
      if (!tracker || settled) return;
      var onDisk;
      try {
        onDisk = countFiles(jobDir);
      } catch (err) {
        return;                       // unreadable for a moment; try again next tick
      }
      if (onDisk !== lastCount) {
        lastCount = onDisk;
        lastMovedAt = Date.now();
        return;
      }
      if (Date.now() - lastMovedAt < STALL_MS) return;

      clearInterval(stallTimer);
      stallTimer = null;
      send({
        progress: 'No new files for ' + Math.round(STALL_MS / 1000) +
                  ' seconds; stopping the download and keeping what arrived\n'
      });
      stalled = true;
      if (child) { try { child.kill(); } catch (err) { /* already gone */ } }
    }, STALL_CHECK_MS);

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

      // Counts rather than raw output. A media-heavy site produces tens of
      // thousands of stderr lines, and forwarding every one of them floods the
      // socket to render text nobody reads.
      if (tracker.feed(text)) scheduleStats();
    });

    child.on('close', (code) => {
      if (settled) return;
      if (stallTimer) { clearInterval(stallTimer); stallTimer = null; }
      // The overall timer deliberately keeps running. Everything after this
      // point - a second fetch for lazily loaded images, then the markup
      // repairs - is still work that can hang, and clearing the deadline here
      // left a stalled job with nothing to stop it. It is cleared in finish()
      // and in fail() instead, once there is an outcome.

      if (cancelled) {
        abandon();
        return;
      }
      if (timedOut) {
        fail(timeoutMessage());
        return;
      }

      mirrorFinished = true;

      // Before anything counts the directory: the seed file is ours, not the
      // site's. Leaving it would both ship it in the zip and make an empty
      // download look like it had content.
      try {
        fs.unlinkSync(path.join(jobDir, SEED_FILE));
      } catch (err) {
        if (err.code !== 'ENOENT') console.error('Could not remove the seed file: ' + err.message);
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

      // Pick up the images the markup does not admit to having before anything
      // is packed up. See lazy-images.js: on a site built with Squarespace or
      // similar, most photographs are in a data-src attribute that a mirror
      // cannot follow, and the script that would expand them cannot run offline.
      recoverLazyImages(domains, function () {
        finish();
      });
    });

    function finish() {
      if (settled) return;
      clearTimeout(timer);
      flushStats();
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

      // Same reasoning: a nicety must never cost someone a finished download.
      if (hostReport) {
        try {
          writeThirdPartyReport(jobDir, target, hostReport, keepTrackers);
        } catch (err) {
          console.error('Could not add THIRD-PARTY.txt: ' + err.message);
        }
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
        } else if (stalled) {
          // Saying "Completed" alone here would be the same lie as reporting an
          // empty archive as a finished download.
          send({
            progress: 'Completed',
            file: name,
            warning: 'This archive may be incomplete. The site stopped responding part ' +
                     'way through and the download was ended so the files already ' +
                     'collected were not lost. Running it again usually picks up the rest.'
          });
        } else {
          send({ progress: 'Completed', file: name });
        }
        done();
      });
    }
  }

  /**
   * Fetches the lazily-referenced images, then points the markup at them.
   *
   * Everything here is best-effort. The mirror has already succeeded by this
   * point, so a failure to improve it must never turn into a failed download -
   * every path ends in next().
   */
  function recoverLazyImages(domains, next) {
    var found;
    try {
      found = lazyImages.collect(jobDir, domains);
    } catch (err) {
      console.error('Could not scan for lazily-loaded images: ' + err.message);
      return next();
    }

    // Even with nothing to fetch there is still repair work: a page can have
    // every image present and a srcset pointing at sizes that were refused.
    if (!found.urls.length) return repairMarkup(next);

    send({ progress: 'Found ' + found.urls.length + ' images loaded by script; fetching them\n' });

    var listFile = path.join(jobDir, LAZY_FILE);
    try {
      fs.writeFileSync(listFile, found.urls.join('\n'));
    } catch (err) {
      console.error('Could not write the lazy image list: ' + err.message);
      return next();
    }

    // -nc so anything already mirrored is left alone, and no -p or recursion:
    // these are a flat list of images, not pages to crawl from.
    //
    // The timeouts are not decoration. wget defaults to a 900 second read
    // timeout and twenty attempts, so one address that accepts a connection
    // and then goes quiet can hold this stage open for hours. The mirror has
    // already succeeded by now; no single image is worth waiting on.
    var args = ['-x', '-nc', '--no-if-modified-since', '--quota=' + QUOTA,
                '--timeout=20', '--tries=2', '--input-file=' + LAZY_FILE];

    var pass = execFile('wget', args, { cwd: jobDir, maxBuffer: 32 * 1024 * 1024 });
    child = pass;

    pass.stderr.on('data', function (chunk) {
      var text = chunk.toString();
      if (/Download quota of .* EXCEEDED/i.test(text)) quotaExceeded = true;
      if (tracker.feed(text)) scheduleStats();
    });

    pass.on('error', function (err) {
      console.error('The second pass for lazy images could not run: ' + err.message);
      next();
    });

    pass.on('close', function () {
      try {
        fs.unlinkSync(listFile);
      } catch (err) {
        if (err.code !== 'ENOENT') console.error('Could not remove the lazy image list: ' + err.message);
      }

      if (cancelled) { abandon(); return; }
      repairMarkup(next);
    });
  }

  /** Points the markup at what is actually on disk. Never fatal. */
  function repairMarkup(next) {
    send({ progress: 'Checking the copy is self-contained\n' });
    var changed;
    try {
      changed = lazyImages.rewrite(jobDir);
    } catch (err) {
      console.error('Could not repair the image markup: ' + err.message);
      return next();
    }

    if (changed.images) {
      send({
        progress: 'Repaired images on ' + changed.files + ' pages (' +
                  changed.srcsets + ' responsive sets collapsed to the original)\n'
      });
    }

    // Then check wget's own link conversion rather than assuming it finished.
    var relinked;
    try {
      relinked = lazyImages.relink(jobDir, mirrorDomains);
    } catch (err) {
      console.error('Could not check the converted links: ' + err.message);
      return next();
    }

    if (relinked.links) {
      send({
        progress: 'Pointed ' + relinked.links + ' addresses on ' + relinked.files +
                  ' pages at the downloaded copy\n'
      });
    }

    // Say what is genuinely absent rather than letting the gaps pass unmentioned.
    if (relinked.missing && relinked.missing.length) {
      try {
        lazyImages.writeMissingReport(jobDir, relinked.missing);
        send({
          progress: relinked.missing.length + ' files could not be saved; ' +
                    'they are listed in ' + lazyImages.MISSING_FILENAME + '\n'
        });
      } catch (err) {
        console.error('Could not write the missing-files report: ' + err.message);
      }
    }

    // Last, make sure nothing downloaded is left invisible.
    try {
      lazyImages.injectReveal(jobDir);
    } catch (err) {
      console.error('Could not add the image reveal snippet: ' + err.message);
    }
    next();
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
/**
 * How many files exist under a directory. Used by the stall watchdog, which
 * needs a measure of real progress rather than of wget's own reporting.
 */
function countFiles(directory) {
  var total = 0;
  var entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (err) {
    return 0;
  }
  for (var i = 0; i < entries.length; i++) {
    if (entries[i].isDirectory()) {
      total += countFiles(path.join(directory, entries[i].name));
    } else {
      total++;
    }
  }
  return total;
}

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
