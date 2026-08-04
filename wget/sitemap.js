var discover = require('./discover');

/**
 * Collects the page addresses a site publishes in its sitemap.
 *
 * A mirror follows links, so it only ever reaches pages something links to.
 * Real sites routinely have pages that nothing links to any more: an old
 * campaign page, a donation form reached from an email, a tag listing. On
 * caminoverde.org thirteen of the eighty addresses in the sitemap were
 * unreachable that way, and no amount of crawling would have found them.
 *
 * Handing those addresses to wget as extra starting points closes the gap.
 * Anything found here is filtered back to the site's own hostname, so a
 * sitemap that lists other people's pages cannot widen what gets mirrored.
 */

var TYPE = /xml|text\/plain/i;
var MAX_URLS = 500;        // bounds the seed file and the crawl it implies
var MAX_CHILD_SITEMAPS = 5; // large sites publish an index pointing at more

/**
 * @param {URL} target site being mirrored, already validated
 * @param {function(string[])} callback always called, with [] when there is
 *        nothing to add. A missing sitemap is normal, not an error.
 */
module.exports = function collectSitemapUrls(target, callback) {
  var origin = target.protocol + '//' + target.host;
  var found = Object.create(null);
  var order = [];

  var add = function (raw) {
    if (order.length >= MAX_URLS) return;
    var url;
    try {
      url = new URL(raw.trim());
    } catch (err) {
      return;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
    // Only the site's own pages. A sitemap is site-controlled input, and
    // without this an entry pointing elsewhere would widen the mirror.
    if (url.hostname.toLowerCase() !== target.hostname.toLowerCase()) return;
    var key = url.href;
    if (found[key]) return;
    found[key] = true;
    order.push(key);
  };

  // robots.txt is where a site is supposed to declare its sitemap, and plenty
  // put it somewhere other than /sitemap.xml.
  fetchOne(origin + '/robots.txt', function (err, body) {
    var candidates = [origin + '/sitemap.xml'];
    if (!err && body) {
      var declared = body.match(/^\s*sitemap:\s*(\S+)/gim) || [];
      for (var i = 0; i < declared.length && candidates.length <= MAX_CHILD_SITEMAPS; i++) {
        var value = declared[i].replace(/^\s*sitemap:\s*/i, '').trim();
        if (candidates.indexOf(value) === -1) candidates.push(value);
      }
    }
    walk(candidates, 0, 0);
  });

  function walk(queue, index, depth) {
    if (index >= queue.length || order.length >= MAX_URLS) {
      callback(order);
      return;
    }
    fetchOne(queue[index], function (err, body) {
      if (!err && body) {
        var locs = body.match(/<loc>\s*([^<\s]+)\s*<\/loc>/gi) || [];
        var children = [];
        var isIndex = /<sitemapindex/i.test(body);
        for (var i = 0; i < locs.length; i++) {
          var value = locs[i].replace(/<\/?loc>/gi, '').trim();
          if (isIndex) {
            if (children.length < MAX_CHILD_SITEMAPS) children.push(value);
          } else {
            add(value);
          }
        }
        // A sitemap index lists more sitemaps rather than pages. Follow one
        // level only; that is enough for every real site and keeps a hostile
        // or looping index from running away.
        if (isIndex && depth === 0 && children.length) {
          walk(children, 0, 1);
          return;
        }
      }
      walk(queue, index + 1, depth);
    });
  }

  function fetchOne(url, done) {
    var parsed;
    try {
      parsed = new URL(url);
    } catch (err) {
      done(err);
      return;
    }
    discover.fetchText(parsed, discover.MAX_REDIRECTS, TYPE, function (err, body) {
      done(err, body);
    });
  }
};
