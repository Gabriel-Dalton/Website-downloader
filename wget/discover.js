var http = require('http');
var https = require('https');

/**
 * Works out which other hostnames a page pulls its assets from.
 *
 * wget's --page-requisites stops at the hostname boundary unless it is told to
 * span hosts, so a site that serves its CSS, JavaScript, images and fonts from
 * a CDN (Squarespace, Wix, Webflow, Shopify and friends all do) mirrors as
 * bare HTML. Handing wget --span-hosts on its own is far too broad: it would
 * happily start mirroring every site the page links to. So the entry page is
 * fetched once up front and the hostnames it actually loads assets from are
 * collected into an allowlist that --domains can be pointed at.
 *
 * Only asset-bearing positions count: src, srcset, poster, the lazy-loading
 * data-src family, <link href> and CSS url(). Plain <a href> links are
 * deliberately ignored, because those are the ones that point at Facebook,
 * YouTube and the rest of the web, and wget recurses into every host it is
 * allowed to touch.
 */

// A page's markup. Generous (caminoverde.org's home page is 360 KB) but
// capped, because everything below scans it and the body is attacker-chosen.
var MAX_BODY_BYTES = 1536 * 1024;
var MAX_REDIRECTS = 5;
var REQUEST_TIMEOUT_MS = 15 * 1000;
var MAX_HOSTS = 24; // a ceiling so a hostile page cannot build an unbounded command line

var USER_AGENT = 'Mozilla/5.0 (compatible; website-downloader/1.0; +https://github.com/AhmadIbrahiim/Website-downloader)';

// A hostname wget will accept in --domains. Must not contain a comma (that is
// the list separator) and must not start with a dash (that would look like a
// flag). new URL() has already punycoded anything international by this point.
var SAFE_HOST = /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/;

/**
 * Fetches url and calls back with the hostnames it loads assets from.
 * An error is reported rather than swallowed so the caller can tell "this page
 * genuinely has no third-party assets" apart from "the page could not be
 * read", and fall back to the plain same-host mirror in the second case.
 *
 * @param {URL} url entry point, already validated as http(s)
 * @param {function(Error, string[])} callback
 */
module.exports = function discoverAssetHosts(url, callback) {
  var settled = false;
  var finish = function (err, hosts) {
    if (settled) return;
    settled = true;
    callback(err, hosts || []);
  };

  fetchText(url, MAX_REDIRECTS, /text\/html|application\/xhtml|text\/plain/i, function (err, body, finalUrl) {
    if (err) {
      finish(err);
      return;
    }
    if (!body) {
      finish(new Error('The page came back empty'));
      return;
    }
    // Only the parsing goes in the try. Calling finish() inside it would make
    // this catch anything the consumer's own callback throws, relabel it as a
    // parse failure and then drop it, because finish() has already settled.
    var hosts;
    try {
      hosts = collectHosts(body, finalUrl);
    } catch (parseError) {
      finish(parseError);
      return;
    }
    finish(null, hosts);
  });
};

/**
 * The same lookup, across several pages instead of one.
 *
 * Looking only at the entry page is a real weakness. caminoverde.org answers
 * its front page with a language chooser: 97 characters of text, five images,
 * and none of the hosts the rest of the site is built from. A host missed here
 * is not in --domains, so every asset on it is skipped for the whole download -
 * the site mirrors as bare HTML and the cause is nowhere in the output.
 *
 * Pages that are already known (from the sitemap) are cheap to check and make
 * the allowlist reflect the site rather than whatever the front door happens to
 * be. Failures are ignored: this only ever adds hosts, so a page that will not
 * load costs nothing but the hosts it would have contributed.
 *
 * @param {URL} url the entry point
 * @param {string[]} extraPages absolute addresses to sample as well
 * @param {number} limit how many of them to look at
 * @param {function(Error, string[])} callback
 */
function discoverAcross(url, extraPages, limit, callback) {
  var pages = [url];
  for (var i = 0; i < (extraPages || []).length && pages.length <= limit; i++) {
    try {
      var candidate = new URL(extraPages[i]);
      if (candidate.href !== url.href) pages.push(candidate);
    } catch (err) { /* not an address we can use */ }
  }

  var hosts = [];
  var seen = Object.create(null);
  var pending = pages.length;
  var firstError = null;

  pages.forEach(function (page, index) {
    fetchText(page, MAX_REDIRECTS, /text\/html|application\/xhtml|text\/plain/i, function (err, body, finalUrl) {
      if (!err && body) {
        try {
          collectHosts(body, finalUrl).forEach(function (host) {
            if (!seen[host]) { seen[host] = true; hosts.push(host); }
          });
        } catch (parseError) {
          if (index === 0) firstError = parseError;
        }
      } else if (index === 0) {
        // Only the entry page failing is worth reporting; it is the one the
        // caller falls back on when there is nothing to allow.
        firstError = err || new Error('The page came back empty');
      }

      if (--pending === 0) {
        callback(hosts.length ? null : firstError, hosts);
      }
    });
  });
}

module.exports.buildDomainList = buildDomainList;
module.exports.collectHosts = collectHosts;
module.exports.discoverAcross = discoverAcross;
// Shared with the sitemap reader, which needs the same bounded, redirect
// following fetch but expects XML rather than markup.
module.exports.fetchText = fetchText;
module.exports.MAX_REDIRECTS = MAX_REDIRECTS;

/**
 * Turns the entry URL and the discovered hosts into the value for wget's
 * --domains. The target host is always first, along with its www/apex twin so
 * a redirect between the two does not fall outside the allowlist.
 *
 * Worth knowing: wget matches --domains entries as suffixes rather than as
 * whole names, so a short entry admits slightly more than it names. Full
 * hostnames are passed for that reason, never bare registrable domains.
 */
function buildDomainList(url, discovered) {
  var seen = Object.create(null);
  var list = [];
  var add = function (host) {
    if (typeof host !== 'string') return;
    var clean = host.trim().toLowerCase().replace(/\.$/, '');
    if (!clean || !SAFE_HOST.test(clean)) return;
    if (seen[clean]) return;
    if (list.length >= MAX_HOSTS) return;
    seen[clean] = true;
    list.push(clean);
  };

  var target = url.hostname.toLowerCase();
  add(target);
  if (target.indexOf('www.') === 0) {
    add(target.slice(4));
  } else {
    add('www.' + target);
  }
  for (var i = 0; i < discovered.length; i++) add(discovered[i]);

  return list;
}

/**
 * Pulls hostnames out of every place a browser would load an asset from.
 * Deliberately regex-based rather than a real parser: there is no HTML parser
 * in the dependency list, and a hostname only has to be spotted, not resolved
 * to a correct DOM node.
 */
function collectHosts(html, baseUrl) {
  var candidates = [];

  // Every quantifier below is bounded. A greedy run followed by a character
  // the run itself cannot match (a closing quote, a closing bracket) is the
  // classic quadratic-backtracking shape, and the page being scanned comes
  // from a URL somebody typed into the box. An unbounded version of the
  // url() pattern took 21 seconds on 320 KB of "url(" with no closing
  // bracket, which would have blocked the whole server for that long.
  var VALUE = '{1,2048}';

  // src="…", poster="…" and the usual lazy-loading stand-ins.
  addMatches(candidates, html, new RegExp('\\b(?:src|poster|data-src|data-lazy-src|data-original|data-image)\\s*=\\s*["\']([^"\']' + VALUE + ')["\']', 'gi'), 1);
  // Unquoted attribute values, which are rare but legal.
  addMatches(candidates, html, new RegExp('\\bsrc\\s*=\\s*([^\\s"\'<>`]' + VALUE + ')', 'gi'), 1);
  // href, but only on <link>, which is where stylesheets, icons, fonts and
  // preloads live. <a href> is skipped on purpose - see the note at the top.
  addMatches(candidates, html, new RegExp('<link\\b[^>]{0,1200}?\\bhref\\s*=\\s*["\']([^"\']' + VALUE + ')["\']', 'gi'), 1);
  // CSS url(), covering both <style> blocks and style="" attributes. The
  // closing bracket is not required: only the address is wanted, and asking
  // for it is what makes the pattern backtrack.
  addMatches(candidates, html, new RegExp('url\\(\\s*["\']?([^"\')\\s]' + VALUE + ')', 'gi'), 1);

  // srcset is a comma separated list of "url descriptor" pairs.
  var srcset = new RegExp('\\b(?:srcset|data-srcset|imagesrcset)\\s*=\\s*["\']([^"\']' + VALUE + ')["\']', 'gi');
  var match;
  while ((match = srcset.exec(html)) !== null) {
    var parts = match[1].split(',');
    for (var i = 0; i < parts.length; i++) {
      var candidate = parts[i].trim().split(/\s+/)[0];
      if (candidate) candidates.push(candidate);
    }
  }

  var hosts = [];
  var seen = Object.create(null);
  for (var j = 0; j < candidates.length; j++) {
    var host = hostOf(candidates[j], baseUrl);
    if (host && !seen[host]) {
      seen[host] = true;
      hosts.push(host);
    }
  }
  return hosts;
}

function addMatches(into, html, pattern, group) {
  var match;
  while ((match = pattern.exec(html)) !== null) {
    var value = match[group];
    if (value) into.push(value.trim());
  }
}

/**
 * Resolves one reference against the page it came from and returns its
 * hostname, or null when it is not something wget could fetch over http(s).
 * Protocol-relative references (//cdn.example.com/app.css) matter here:
 * Squarespace writes its stylesheet links that way.
 */
function hostOf(reference, baseUrl) {
  if (!reference) return null;
  if (/^(data|blob|javascript|mailto|tel|about):/i.test(reference)) return null;
  var resolved;
  try {
    resolved = new URL(reference, baseUrl);
  } catch (err) {
    return null;
  }
  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null;
  var host = resolved.hostname.toLowerCase();
  return SAFE_HOST.test(host) ? host : null;
}

/**
 * A small GET that follows redirects, gives up quickly and refuses to read an
 * unbounded body. Node's own http/https rather than a new dependency.
 */
function fetchText(url, redirectsLeft, typePattern, callback) {
  var settled = false;
  var finish = function (err, body, finalUrl) {
    if (settled) return;
    settled = true;
    callback(err, body, finalUrl);
  };

  var lib = url.protocol === 'https:' ? https : http;
  var request;
  try {
    request = lib.get({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      path: (url.pathname || '/') + (url.search || ''),
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
        'Accept-Encoding': 'identity'
      }
    });
  } catch (err) {
    finish(err);
    return;
  }

  request.setTimeout(REQUEST_TIMEOUT_MS, function () {
    request.destroy();
    finish(new Error('Timed out looking up ' + url.hostname));
  });

  request.on('error', function (err) {
    finish(err);
  });

  request.on('response', function (response) {
    var status = response.statusCode;

    if (status >= 300 && status < 400 && response.headers.location) {
      // Nothing here needs the body. Destroying it rather than draining it
      // matters: request.setTimeout is an idle timeout that every chunk
      // refreshes, so a slow endless response would hold the socket open for
      // the life of the process.
      response.destroy();
      if (redirectsLeft <= 0) {
        finish(new Error('Too many redirects'));
        return;
      }
      var next;
      try {
        next = new URL(response.headers.location, url);
      } catch (err) {
        finish(err);
        return;
      }
      if (next.protocol !== 'http:' && next.protocol !== 'https:') {
        finish(new Error('Redirected to an unsupported scheme'));
        return;
      }
      settled = true; // this request is done with; the recursive call owns the callback now
      fetchText(next, redirectsLeft - 1, typePattern, callback);
      return;
    }

    if (status !== 200) {
      response.destroy();
      finish(new Error('Unexpected status ' + status));
      return;
    }

    var type = String(response.headers['content-type'] || '');
    if (type && typePattern && !typePattern.test(type)) {
      response.destroy();
      finish(new Error('Unexpected content type ' + type));
      return;
    }

    var chunks = [];
    var length = 0;
    response.setEncoding('utf8');
    response.on('data', function (chunk) {
      if (length >= MAX_BODY_BYTES) return;
      length += Buffer.byteLength(chunk);
      chunks.push(chunk);
      if (length >= MAX_BODY_BYTES) {
        response.destroy();
        finish(null, chunks.join(''), url);
      }
    });
    response.on('end', function () {
      finish(null, chunks.join(''), url);
    });
    response.on('error', function (err) {
      finish(err);
    });
  });
}
