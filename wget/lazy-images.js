var fs = require('fs');
var path = require('path');

/**
 * Recovers images that are not in the markup as far as a mirror is concerned.
 *
 * Squarespace, and most builders like it, ship an <img> with no src at all:
 *
 *   <img data-src="https://images.../6.jpg" data-image="..." data-load="false">
 *
 * The real src is filled in by their script once the browser works out how big
 * the image needs to be. wget follows src, srcset and url() in CSS, so it never
 * sees these, and they are exactly the photographs a page is built around. On
 * caminoverde.org two thirds of the images on a page are loaded this way.
 *
 * Fetching them is only half the job. That script cannot run offline either, so
 * even with the file present the page would stay blank. The src has to be
 * written into the markup, which is what the rewrite below does.
 */

// Attributes that carry a real image address. data-src is the common one;
// the others turn up on galleries and background blocks.
var ATTRS = ['data-src', 'data-image', 'data-original', 'data-lazy-src'];

/**
 * Finds every lazily-loaded image address across the mirrored HTML.
 *
 * @param {string} root directory wget wrote into
 * @param {string[]} allowedHosts hosts the mirror was allowed to touch
 * @returns {{urls: string[], pages: number}}
 */
function collect(root, allowedHosts) {
  var allowed = {};
  (allowedHosts || []).forEach(function (h) { allowed[h.toLowerCase()] = true; });

  var found = {};
  var pages = 0;

  eachHtmlFile(root, function (file) {
    var html = readIfText(file);
    if (html === null) return;
    var before = Object.keys(found).length;

    ATTRS.forEach(function (attr) {
      var re = new RegExp(attr + '=["\']([^"\']+)["\']', 'gi');
      var m;
      while ((m = re.exec(html)) !== null) {
        var url = absolute(m[1]);
        if (!url) continue;
        var host = hostOf(url);
        // An allowlist was applied to the mirror; the same one applies here, so
        // a lazy attribute cannot pull in a host that was deliberately skipped.
        if (allowedHosts && allowedHosts.length && !allowed[host]) continue;
        found[url] = true;
      }
    });

    if (Object.keys(found).length > before) pages++;
  });

  return { urls: Object.keys(found), pages: pages };
}

/**
 * Points the markup at the files now sitting on disk.
 *
 * Two repairs, one pass over each <img>:
 *
 *   1. Fill in a src where there is not one, from the lazy attribute.
 *   2. Drop srcset and sizes once a usable src is present.
 *
 * The second is what makes REJECT_REGEX safe. A responsive srcset offers the
 * same photograph at seven widths and the browser picks one, so mirroring all
 * seven wastes most of the download - on caminoverde.org, 897 MB of a 1.6 GB
 * archive. Those addresses are refused during the mirror, but wget leaves an
 * address it did not fetch pointing at the live site, so a srcset left in place
 * would send the browser back to the internet for an image already on disk.
 * Removing it falls back to src, which is the full-size original.
 *
 * An image the mirror handled correctly and that has no srcset is untouched.
 *
 * @returns {{files: number, images: number, srcsets: number}}
 */
function rewrite(root) {
  var changedFiles = 0;
  var changedImages = 0;
  var strippedSrcsets = 0;

  eachHtmlFile(root, function (file) {
    var html = readIfText(file);
    if (html === null) return;
    var dir = path.dirname(file);
    var touched = 0;

    var out = html.replace(/<img\b[^>]*>/gi, function (tag) {
      var result = tag;
      var hasSrc = /\ssrc\s*=\s*["'][^"']+["']/i.test(tag);

      if (!hasSrc) {
        var url = null;
        for (var i = 0; i < ATTRS.length && !url; i++) {
          var m = tag.match(new RegExp(ATTRS[i] + '=["\']([^"\']+)["\']', 'i'));
          if (m) url = absolute(m[1]);
        }
        var local = url ? localPathFor(root, url) : null;
        if (local) {
          var rel = path.relative(dir, local).split(path.sep).join('/');
          // Also drop the loader's own flag, which otherwise tells the script
          // the image is not ready and leaves it hidden.
          result = result.replace(/\sdata-load\s*=\s*["']false["']/i, '')
                         .replace(/<img\b/i, '<img src="' + rel.replace(/"/g, '&quot;') + '"');
          hasSrc = true;
          touched++;
        }
      }

      // Only once there is something to fall back to. An image carrying nothing
      // but a srcset would be left with no source at all.
      if (hasSrc && /\ssrcset\s*=/i.test(result)) {
        result = result.replace(/\s(?:data-)?srcset\s*=\s*(["'])[\s\S]*?\1/gi, '')
                       .replace(/\ssizes\s*=\s*(["'])[^"']*\1/gi, '');
        strippedSrcsets++;
        touched++;
      }

      return result;
    });

    if (touched) {
      try {
        fs.writeFileSync(file, out);
        changedFiles++;
        changedImages += touched;
      } catch (err) {
        // A page that cannot be rewritten is still a readable page.
        console.error('Could not rewrite ' + file + ': ' + err.message);
      }
    }
  });

  return { files: changedFiles, images: changedImages, srcsets: strippedSrcsets };
}

/**
 * Works out where a downloaded address landed on disk.
 *
 * wget's naming depends on platform and on --restrict-file-names, so rather
 * than reimplement it this tries the plausible spellings and returns whichever
 * actually exists.
 */
function localPathFor(root, url) {
  var u;
  try { u = new URL(url); } catch (err) { return null; }

  var rel = u.pathname.replace(/^\//, '');
  if (!rel || rel.slice(-1) === '/') rel += 'index.html';

  var candidates = [];

  // A query string is part of the filename wget writes, and how it spells it
  // depends on the platform: Windows cannot use ? in a name and substitutes @.
  // Typekit hangs its whole font on a query, so getting this wrong costs the
  // site its typefaces.
  if (u.search) {
    candidates.push(rel + u.search.replace(/^\?/, '@'));
    candidates.push(rel + u.search);
  }
  candidates.push(rel);
  try { candidates.push(decodeURIComponent(rel)); } catch (err) { /* leave it */ }
  // wget percent-escapes characters Windows will not accept in a filename.
  candidates.push(rel.replace(/[?*:"<>|]/g, function (c) {
    return '%' + c.charCodeAt(0).toString(16).toUpperCase();
  }));
  // --adjust-extension gives pages an .html they did not have in the address.
  if (!/\.[a-z0-9]{1,5}$/i.test(rel)) {
    candidates.push(rel + '.html');
    try { candidates.push(decodeURIComponent(rel) + '.html'); } catch (err) { /* leave it */ }
  }

  for (var i = 0; i < candidates.length; i++) {
    var full = path.join(root, u.hostname, candidates[i]);
    try {
      if (fs.statSync(full).isFile()) return full;
    } catch (err) { /* try the next spelling */ }
  }
  return null;
}

/**
 * Points any address still written out in full at the copy already on disk.
 *
 * --convert-links is supposed to do this and mostly does, but it is not
 * reliable: on caminoverde.org it rewrote 93 image references on a page and
 * left twelve script tags pointing at assets.squarespace.com, including the
 * bundle every other script depends on. The page then loaded, found no
 * Squarespace global, and rendered blank - a mirror that had in fact downloaded
 * every file it needed.
 *
 * So rather than trust the conversion, check it. Anything absolute that has a
 * matching file underneath the archive gets pointed at it; anything genuinely
 * missing is left alone, because an address that still works online beats a
 * relative path to nothing.
 *
 * @returns {{files: number, links: number}}
 */
function relink(root, allowedHosts) {
  var changedFiles = 0;
  var changedLinks = 0;

  // Addresses on a host the mirror was told to cover, which nonetheless have
  // no file underneath the archive. These are the genuine holes: something the
  // download was supposed to capture and did not. Silence about them is how an
  // incomplete archive passes for a complete one.
  var allowed = Object.create(null);
  (allowedHosts || []).forEach(function (h) { allowed[String(h).toLowerCase()] = true; });
  var missing = Object.create(null);

  function noteMissing(url) {
    if (!allowedHosts || !allowedHosts.length) return;
    var host;
    try { host = new URL(url).hostname.toLowerCase(); } catch (err) { return; }
    if (!allowed[host]) return;             // somewhere we never meant to fetch
    if (Object.keys(missing).length > 500) return;
    missing[url.split('#')[0]] = true;
  }

  // Stylesheets matter as much as pages here. @font-face lives in CSS, so a
  // stylesheet left pointing at the web costs the site its typefaces - and a
  // page whose webfont never arrives can render its navigation as nothing at
  // all, which looks like missing content rather than a missing font.
  eachFile(root, /\.(x?html?|css)$/i, function (file) {
    var text = readIfText(file);
    if (text === null) return;
    var dir = path.dirname(file);
    var touched = 0;

    function toLocal(url) {
      var local = localPathFor(root, url);
      if (!local) { noteMissing(url); return null; }
      return path.relative(dir, local).split(path.sep).join('/');
    }

    var out = text;

    // src= and href= in markup.
    out = out.replace(/\b(src|href)=(["'])(https?:)?\/\/([^"'\s]+)\2/gi,
      function (whole, attr, quote, scheme, rest) {
        var rel = toLocal('https://' + rest);
        if (!rel) return whole;
        touched++;
        return attr + '=' + quote + rel.replace(/"/g, '&quot;') + quote;
      });

    // url(...) in stylesheets and inline <style> blocks.
    out = out.replace(/url\(\s*(["']?)(https?:)?\/\/([^"')\s]+)\1\s*\)/gi,
      function (whole, quote, scheme, rest) {
        var rel = toLocal('https://' + rest);
        if (!rel) return whole;
        touched++;
        return 'url(' + quote + rel + quote + ')';
      });

    if (touched) {
      try {
        fs.writeFileSync(file, out);
        changedFiles++;
        changedLinks += touched;
      } catch (err) {
        console.error('Could not relink ' + file + ': ' + err.message);
      }
    }
  });

  return {
    files: changedFiles,
    links: changedLinks,
    missing: Object.keys(missing).sort()
  };
}

/**
 * Records the addresses the mirror was meant to hold and does not.
 *
 * Worth writing down because the reasons are rarely obvious and never
 * announced. The one that cost this the site's typeface: Adobe Fonts serves
 * its loader from a 513-character address, and Windows will not accept a path
 * that long, so wget failed to write it and said nothing. The archive looked
 * complete and rendered in a fallback serif.
 */
function writeMissingReport(root, missing) {
  if (!missing || !missing.length) return null;

  var longOnes = missing.filter(function (u) { return u.length > 200; });
  var lines = [];

  lines.push('Files this archive is missing');
  lines.push('=============================');
  lines.push('');
  lines.push('Addresses on hosts the download was set up to cover, which have no');
  lines.push('file here. Pages referring to them will reach for the live site.');
  lines.push('');

  if (longOnes.length) {
    lines.push('Too long to save (' + longOnes.length + ')');
    lines.push('-----------------------');
    lines.push('Windows limits a path to 260 characters. Anything longer cannot be');
    lines.push('written, whatever it contains. Running the download on Linux or macOS,');
    lines.push('or enabling long paths on Windows, will capture these.');
    lines.push('');
    longOnes.slice(0, 40).forEach(function (u) {
      lines.push('  [' + u.length + ' chars] ' + u.slice(0, 110) + '...');
    });
    if (longOnes.length > 40) lines.push('  ...and ' + (longOnes.length - 40) + ' more');
    lines.push('');
  }

  var rest = missing.filter(function (u) { return u.length <= 200; });
  if (rest.length) {
    lines.push('Not downloaded (' + rest.length + ')');
    lines.push('----------------------');
    lines.push('Usually a file the site builds an address for in JavaScript, which a');
    lines.push('mirror cannot see, or one the server refused.');
    lines.push('');
    rest.slice(0, 60).forEach(function (u) { lines.push('  ' + u); });
    if (rest.length > 60) lines.push('  ...and ' + (rest.length - 60) + ' more');
    lines.push('');
  }

  fs.writeFileSync(path.join(root, MISSING_FILENAME), lines.join('\n'), 'utf8');
  return MISSING_FILENAME;
}

var MISSING_FILENAME = 'MISSING.txt';

function eachHtmlFile(dir, fn) {
  eachFile(dir, /\.x?html?$/i, fn);
}

function eachFile(dir, pattern, fn) {
  var entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (err) { return; }
  entries.forEach(function (entry) {
    var full = path.join(dir, entry.name);
    if (entry.isDirectory()) { eachFile(full, pattern, fn); return; }
    // A stylesheet fetched from a query-string address keeps that query in its
    // filename, so the extension is not always last.
    if (pattern.test(entry.name) || pattern.test(entry.name.split('@')[0])) fn(full);
  });
}

function readIfText(file) {
  try {
    // A mirror of a large site can contain very big files; skip anything that
    // is clearly not a page rather than pulling it into memory.
    if (fs.statSync(file).size > 8 * 1024 * 1024) return null;
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    return null;
  }
}

function absolute(value) {
  var v = String(value).trim();
  if (!v) return null;
  if (v.indexOf('//') === 0) v = 'https:' + v;
  if (!/^https?:\/\//i.test(v)) return null;   // relative ones the mirror already has
  // The size variants are generated on demand; the bare address is the original.
  return v.split('#')[0];
}

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch (err) { return ''; }
}

/**
 * Addresses the mirror should not spend time on: the same image re-rendered at
 * a fixed width, which is what a responsive srcset is made of. The originals
 * have no such parameter and are still fetched. Paired with the srcset removal
 * in rewrite() above - one without the other leaves broken images.
 */
var REJECT_REGEX = '[?&]format=[0-9]+w';

// Marks the snippet below so a second run does not add it twice.
var REVEAL_MARK = 'website-downloader-reveal';

/**
 * Shows images that downloaded, laid out, and then stayed invisible.
 *
 * Gallery scripts commonly render an image at opacity zero and fade it in once
 * their own loader reports it ready. Offline that report never arrives, so the
 * page ends up with a correctly sized, fully decoded photograph at zero
 * opacity - a block of white space where the content is. It looks like the
 * mirror missed the images when in fact it has every one of them.
 *
 * The snippet only touches an image that has actually decoded and is still at
 * zero opacity, so a fade that is working is left to finish on its own. It runs
 * twice because galleries are often built after the first pass.
 */
function injectReveal(root) {
  var snippet = '<script>/*' + REVEAL_MARK + '*/(function(){' +
    'function r(){var i=document.images,n=0;' +
    'for(var k=0;k<i.length;k++){var e=i[k];' +
    'if(e.naturalWidth>0&&getComputedStyle(e).opacity==="0"){' +
    'e.style.setProperty("opacity","1","important");n++;}}return n;}' +
    'function go(){setTimeout(r,1200);setTimeout(r,4000);}' +
    'if(document.readyState==="loading")' +
    'document.addEventListener("DOMContentLoaded",go);else go();' +
    '})();<\/script>';

  var files = 0;
  eachHtmlFile(root, function (file) {
    var html = readIfText(file);
    if (html === null || html.indexOf(REVEAL_MARK) !== -1) return;
    if (!/<\/body>/i.test(html)) return;
    try {
      fs.writeFileSync(file, html.replace(/<\/body>/i, snippet + '</body>'));
      files++;
    } catch (err) {
      console.error('Could not add the reveal snippet to ' + file + ': ' + err.message);
    }
  });
  return { files: files };
}

module.exports = {
  collect: collect,
  rewrite: rewrite,
  relink: relink,
  injectReveal: injectReveal,
  writeMissingReport: writeMissingReport,
  localPathFor: localPathFor,
  MISSING_FILENAME: MISSING_FILENAME,
  ATTRS: ATTRS,
  REJECT_REGEX: REJECT_REGEX,
  REVEAL_MARK: REVEAL_MARK
};
