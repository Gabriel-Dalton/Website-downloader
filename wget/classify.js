/**
 * Sorts discovered asset hosts into the ones worth mirroring and the ones that
 * only exist to phone home.
 *
 * The discovery pass is deliberately broad: it takes every hostname the page
 * loads something from. That is right for stylesheets, fonts and images, and
 * wrong for analytics beacons, ad pixels, consent banners and chat widgets.
 * None of those do anything in an offline copy. They cost download time, they
 * bloat the archive, and several of them sit there throwing console errors
 * because the endpoint they want is unreachable.
 *
 * The rule of thumb: keep anything that changes how the page looks, drop
 * anything that only reports on it. When in doubt, keep it — a missing
 * stylesheet ruins a mirror, a stray tracker only makes it slightly larger.
 */

// Matched against the end of a hostname, so "google-analytics.com" also covers
// "ssl.google-analytics.com". Kept as full registrable names to avoid a short
// entry swallowing something unrelated.
var NOISE = [
  // Analytics and product telemetry
  { suffix: 'google-analytics.com',      why: 'analytics' },
  { suffix: 'analytics.google.com',      why: 'analytics' },
  { suffix: 'googletagmanager.com',      why: 'tag manager' },
  { suffix: 'segment.com',               why: 'analytics' },
  { suffix: 'segment.io',                why: 'analytics' },
  { suffix: 'mixpanel.com',              why: 'analytics' },
  { suffix: 'amplitude.com',             why: 'analytics' },
  { suffix: 'hotjar.com',                why: 'session recording' },
  { suffix: 'hotjar.io',                 why: 'session recording' },
  { suffix: 'fullstory.com',             why: 'session recording' },
  { suffix: 'mouseflow.com',             why: 'session recording' },
  { suffix: 'clarity.ms',                why: 'session recording' },
  { suffix: 'matomo.cloud',              why: 'analytics' },
  { suffix: 'plausible.io',              why: 'analytics' },
  { suffix: 'statcounter.com',           why: 'analytics' },
  { suffix: 'quantserve.com',            why: 'analytics' },
  { suffix: 'scorecardresearch.com',     why: 'analytics' },
  { suffix: 'newrelic.com',              why: 'monitoring' },
  { suffix: 'nr-data.net',               why: 'monitoring' },
  { suffix: 'sentry.io',                 why: 'error reporting' },

  // Advertising and conversion pixels
  { suffix: 'doubleclick.net',           why: 'ad tracking' },
  { suffix: 'googlesyndication.com',     why: 'ad tracking' },
  { suffix: 'googleadservices.com',      why: 'ad tracking' },
  { suffix: 'connect.facebook.net',      why: 'ad tracking' },
  { suffix: 'ads-twitter.com',           why: 'ad tracking' },
  { suffix: 'bat.bing.com',              why: 'ad tracking' },
  { suffix: 'snap.licdn.com',            why: 'ad tracking' },
  { suffix: 'analytics.tiktok.com',      why: 'ad tracking' },

  // Consent and cookie banners, which are worse than useless offline
  { suffix: 'cookiebot.com',             why: 'cookie banner' },
  { suffix: 'cookielaw.org',             why: 'cookie banner' },
  { suffix: 'onetrust.com',              why: 'cookie banner' },
  { suffix: 'termly.io',                 why: 'cookie banner' },
  { suffix: 'iubenda.com',               why: 'cookie banner' },
  { suffix: 'usercentrics.eu',           why: 'cookie banner' },

  // Live chat and support widgets, which need a live backend
  { suffix: 'intercom.io',               why: 'chat widget' },
  { suffix: 'intercomcdn.com',           why: 'chat widget' },
  { suffix: 'drift.com',                 why: 'chat widget' },
  { suffix: 'crisp.chat',                why: 'chat widget' },
  { suffix: 'tawk.to',                   why: 'chat widget' },
  { suffix: 'zdassets.com',              why: 'chat widget' },

  // Beacons that sit alongside something genuinely useful. p.typekit.net is
  // the tracking pixel; use.typekit.net serves the actual fonts and is kept.
  { suffix: 'p.typekit.net',             why: 'font usage beacon' }
];

/**
 * @param {string[]} hosts hostnames from the discovery pass
 * @returns {{keep: string[], skip: Array<{host: string, why: string}>}}
 */
function classify(hosts) {
  var keep = [];
  var skip = [];

  for (var i = 0; i < hosts.length; i++) {
    var host = String(hosts[i] || '').toLowerCase();
    if (!host) continue;
    var reason = noiseReason(host);
    if (reason) {
      skip.push({ host: host, why: reason });
    } else {
      keep.push(host);
    }
  }

  return { keep: keep, skip: skip };
}

function noiseReason(host) {
  for (var i = 0; i < NOISE.length; i++) {
    var suffix = NOISE[i].suffix;
    // Exact match, or a subdomain of it. Comparing against "." + suffix stops
    // "notgoogle-analytics.com" matching "google-analytics.com".
    if (host === suffix || host.slice(-(suffix.length + 1)) === '.' + suffix) {
      return NOISE[i].why;
    }
  }
  return null;
}

module.exports = classify;
module.exports.noiseReason = noiseReason;
module.exports.NOISE = NOISE;
