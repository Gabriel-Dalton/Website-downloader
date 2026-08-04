var fs = require('fs');
var path = require('path');

/**
 * Writes a plain-text account of every other hostname the site loads from, and
 * what happened to each one.
 *
 * Two reasons this exists. Filtering nobody can see is indistinguishable from
 * a bug, so anything left out is named here rather than quietly dropped. And
 * moving a site somewhere else means dealing with its third parties by hand:
 * the analytics property, the font licence, the embed that will not work on a
 * new domain. That list is worth having written down.
 */

var FILENAME = 'THIRD-PARTY.txt';

/**
 * @param {string} jobDir directory being archived
 * @param {URL} target the site that was mirrored
 * @param {{keep: string[], skip: Array<{host: string, why: string}>}} sorted
 * @param {boolean} includedEverything whether trackers were downloaded anyway
 */
module.exports = function writeThirdPartyReport(jobDir, target, sorted, includedEverything) {
  var own = [target.hostname.toLowerCase()];
  own.push(own[0].indexOf('www.') === 0 ? own[0].slice(4) : 'www.' + own[0]);

  var external = sorted.keep.filter(function (h) { return own.indexOf(h) === -1; });
  var lines = [];

  lines.push('Third-party hosts used by ' + target.hostname);
  lines.push(new Array(('Third-party hosts used by ' + target.hostname).length + 1).join('='));
  lines.push('');
  lines.push('Everything this site loads from somewhere other than its own domain,');
  lines.push('and whether it ended up in this archive.');
  lines.push('');

  if (!external.length && !sorted.skip.length) {
    lines.push('None. Everything came from ' + target.hostname + ' itself.');
    lines.push('');
  }

  if (external.length) {
    lines.push('DOWNLOADED');
    lines.push('----------');
    lines.push('Stylesheets, scripts, images and fonts. The archive needs these to');
    lines.push('render, and they are in the folders next to this file.');
    lines.push('');
    external.forEach(function (host) {
      lines.push('  ' + host);
    });
    lines.push('');
  }

  if (sorted.skip.length) {
    if (includedEverything) {
      lines.push('DOWNLOADED, BUT DOES NOTHING OFFLINE');
      lines.push('------------------------------------');
      lines.push('Fetched because trackers were requested. None of it will work in an');
      lines.push('offline copy; it is here for moving the site somewhere else.');
    } else {
      lines.push('NOT DOWNLOADED');
      lines.push('--------------');
      lines.push('Analytics, advertising, consent and support widgets. They need a live');
      lines.push('backend, so they do nothing in an offline copy except add weight and');
      lines.push('throw console errors. Tick "include third-party trackers" to fetch');
      lines.push('them anyway, or set KEEP_TRACKERS=1 on the server.');
    }
    lines.push('');
    var width = 0;
    sorted.skip.forEach(function (s) { if (s.host.length > width) width = s.host.length; });
    sorted.skip.forEach(function (s) {
      lines.push('  ' + pad(s.host, width) + '  ' + s.why);
    });
    lines.push('');
  }

  lines.push('MOVING THIS SITE?');
  lines.push('-----------------');
  lines.push('Each host above is a dependency that will not follow the files. Fonts');
  lines.push('are usually licensed per domain, analytics needs a new property, and');
  lines.push('embeds often check where they are being served from.');
  lines.push('');
  lines.push('Only the front page was inspected, so a host used solely on a deeper');
  lines.push('page may not appear here.');
  lines.push('');

  fs.writeFileSync(path.join(jobDir, FILENAME), lines.join('\n'), 'utf8');
  return FILENAME;
};

module.exports.FILENAME = FILENAME;

function pad(text, width) {
  var out = text;
  while (out.length < width) out += ' ';
  return out;
}
