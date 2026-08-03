var fs = require('fs');
var path = require('path');

/**
 * Writes START-HERE.html at the root of a finished download.
 *
 * Now that assets are mirrored from CDNs as well, the archive root holds one
 * folder per hostname (caminoverde.org/, static1.squarespace.com/, ...) rather
 * than a single obvious one. Unzipping that and guessing which file to open is
 * unpleasant, so a tiny landing page is added that both redirects to the entry
 * page and offers a plain link for anyone whose browser blocks meta refresh on
 * file:// URLs.
 *
 * Nothing wget wrote is ever touched: if a file of this name already came down
 * from the site, the landing page is skipped.
 */
var FILE_NAME = 'START-HERE.html';

module.exports = function writeStartHere(jobDir, target) {
  var destination = path.join(jobDir, FILE_NAME);
  if (fs.existsSync(destination)) return null;

  var entry = findEntryPage(jobDir, target);
  if (!entry) return null;

  var href = entry.split(path.sep).map(encodeURIComponent).join('/');
  try {
    fs.writeFileSync(destination, page(href, target.href, entry, countTopLevelDirs(jobDir)), 'utf8');
  } catch (err) {
    // A missing landing page is a cosmetic problem, not a failed download.
    console.error('Could not write ' + FILE_NAME + ': ' + err.message);
    return null;
  }
  return FILE_NAME;
};

module.exports.findEntryPage = findEntryPage;

/**
 * Finds the saved copy of the page the user actually asked for, as a path
 * relative to jobDir. wget's naming depends on --adjust-extension, on whether
 * the URL was a directory and on how query strings were escaped, so the
 * likely names are tried first and a scan of the tree is the safety net.
 */
function findEntryPage(jobDir, target) {
  var hostDirs = preferredHostDirs(jobDir, target);
  // A stray percent sign survives URL parsing (/foo% stays /foo%) and makes
  // decodeURIComponent throw, so the raw path is the fallback.
  var pathname;
  try {
    pathname = decodeURIComponent(target.pathname || '/');
  } catch (err) {
    pathname = target.pathname || '/';
  }
  // A percent-encoded %2e%2e survives URL normalisation and would otherwise
  // produce a guess that walks out of the job directory. Anything with a
  // traversal segment simply falls through to the scan below.
  var segments = pathname.split('/').filter(function (segment) {
    return segment && segment !== '.' && segment !== '..';
  });
  if (segments.length !== pathname.split('/').filter(Boolean).length) segments = [];
  var last = segments.length ? segments[segments.length - 1] : '';
  var parents = segments.slice(0, -1);

  var relatives = [];
  var push = function (parts) {
    var relative = parts.filter(Boolean).join(path.sep);
    if (relative && relatives.indexOf(relative) === -1) relatives.push(relative);
  };

  for (var h = 0; h < hostDirs.length; h++) {
    var host = hostDirs[h];
    if (!last) {
      push([host, 'index.html']);
    } else if (/\.x?html?$/i.test(last)) {
      push([host].concat(segments));
    } else {
      push([host].concat(parents, last + '.html'));
      push([host].concat(segments, 'index.html'));
      push([host].concat(segments));
    }
    push([host, 'index.html']);
  }

  for (var i = 0; i < relatives.length; i++) {
    if (isFile(path.join(jobDir, relatives[i]))) return relatives[i];
  }

  // Nothing matched, so fall back to the shallowest HTML file, preferring one
  // inside a directory named after the site.
  var found = null;
  for (var j = 0; j < hostDirs.length && !found; j++) {
    found = shallowestHtml(jobDir, hostDirs[j]);
  }
  return found || shallowestHtml(jobDir, '');
}

/**
 * Directory names wget may have used for the target, most likely first. wget
 * names the directory after the host it ended up on, which after an
 * apex-to-www redirect is not the host that was typed.
 */
function preferredHostDirs(jobDir, target) {
  var host = target.hostname.toLowerCase();
  var twin = host.indexOf('www.') === 0 ? host.slice(4) : 'www.' + host;
  var wanted = [host, twin];
  var present = [];
  var entries;
  try {
    entries = fs.readdirSync(jobDir, { withFileTypes: true });
  } catch (err) {
    return wanted;
  }
  for (var i = 0; i < wanted.length; i++) {
    for (var j = 0; j < entries.length; j++) {
      if (entries[j].isDirectory() && entries[j].name.toLowerCase() === wanted[i]) {
        present.push(entries[j].name);
      }
    }
  }
  return present.length ? present : wanted;
}

/**
 * Breadth-first walk for the HTML file closest to the top of the tree, so the
 * home page wins over a deeply nested one. index.html beats its siblings.
 */
function shallowestHtml(jobDir, subdirectory) {
  var start = subdirectory ? path.join(jobDir, subdirectory) : jobDir;
  if (!isDirectory(start)) return null;

  var queue = [subdirectory || ''];
  var guard = 0;
  while (queue.length && guard++ < 5000) {
    var relative = queue.shift();
    var absolute = relative ? path.join(jobDir, relative) : jobDir;
    var entries;
    try {
      entries = fs.readdirSync(absolute, { withFileTypes: true });
    } catch (err) {
      continue;
    }
    var files = [];
    for (var i = 0; i < entries.length; i++) {
      var name = entries[i].name;
      var child = relative ? path.join(relative, name) : name;
      if (entries[i].isDirectory()) {
        queue.push(child);
      } else if (/\.x?html?$/i.test(name)) {
        files.push(child);
      }
    }
    if (files.length) {
      files.sort(function (a, b) {
        var aIndex = /(^|[\\/])index\.x?html?$/i.test(a) ? 0 : 1;
        var bIndex = /(^|[\\/])index\.x?html?$/i.test(b) ? 0 : 1;
        return aIndex - bIndex || a.length - b.length || a.localeCompare(b);
      });
      return files[0];
    }
  }
  return null;
}

function isFile(candidate) {
  try {
    return fs.statSync(candidate).isFile();
  } catch (err) {
    return false;
  }
}

function isDirectory(candidate) {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch (err) {
    return false;
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function countTopLevelDirs(jobDir) {
  try {
    return fs.readdirSync(jobDir, { withFileTypes: true }).filter(function (entry) {
      return entry.isDirectory();
    }).length;
  } catch (err) {
    return 1;
  }
}

function page(href, originalUrl, relativePath, folderCount) {
  var safeHref = escapeHtml(href);
  var keepTogether = folderCount > 1
    ? 'The other folders next to it hold the stylesheets, scripts, images and ' +
      'fonts the pages need, so keep them all together.'
    : 'Keep the folder next to this file: it holds everything the pages need.';
  return '<!doctype html>\n' +
    '<html lang="en">\n' +
    '<head>\n' +
    '<meta charset="utf-8">\n' +
    '<meta http-equiv="refresh" content="0; url=' + safeHref + '">\n' +
    '<title>Start here</title>\n' +
    '<style>\n' +
    'body{font-family:system-ui,-apple-system,"Segoe UI",Arial,sans-serif;' +
    'margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;' +
    'background:#f6f7f9;color:#1c1f23}\n' +
    'main{max-width:34rem;padding:2rem;text-align:center}\n' +
    'a{color:#0b5fff}\n' +
    'p{line-height:1.5}\n' +
    'code{background:#e9ecf1;padding:.1rem .3rem;border-radius:.2rem;word-break:break-all}\n' +
    '</style>\n' +
    '</head>\n' +
    '<body>\n' +
    '<main>\n' +
    '<h1>Your copy of ' + escapeHtml(hostOf(originalUrl)) + '</h1>\n' +
    '<p>Opening <a href="' + safeHref + '">' + escapeHtml(relativePath.split(/[\\/]/).join('/')) + '</a>&hellip;</p>\n' +
    '<p>If nothing happens, use the link above. ' + keepTogether + '</p>\n' +
    '<p>Downloaded from <code>' + escapeHtml(originalUrl) + '</code></p>\n' +
    '</main>\n' +
    '</body>\n' +
    '</html>\n';
}

function hostOf(value) {
  try {
    return new URL(value).hostname;
  } catch (err) {
    return value;
  }
}
