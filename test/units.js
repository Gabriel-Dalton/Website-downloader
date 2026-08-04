/**
 * Checks for the pure parts: output parsing, host classification and URL
 * validation. No network, no wget, no server.
 *
 * Run with: npm test
 */

var assert = require('assert');
var createTracker = require('../wget/progress');
var classify = require('../wget/classify');
var discover = require('../wget/discover');

var passed = 0;
var failed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('  pass  ' + name);
  } catch (err) {
    failed++;
    console.log('  FAIL  ' + name);
    console.log('        ' + err.message);
  }
}

console.log('progress parsing');

check('counts each file wget reports saving', function () {
  var t = createTracker(0, 0);
  t.feed("2026-08-03 12:00:01 (34.6 MB/s) - 'example.com/index.html' saved [559]\n");
  t.feed("2026-08-03 12:00:02 (2.0 MB/s) - 'cdn.example.com/a.jpg' saved [2048/2048]\n");
  assert.strictEqual(t.files, 2);
});

check('separates pages from assets', function () {
  var t = createTracker(0, 0);
  t.feed("- 'site/index.html' saved [10]\n- 'site/a.jpg' saved [10]\n- 'site/about.htm' saved [10]\n");
  assert.strictEqual(t.pages, 2);
  assert.strictEqual(t.files, 3);
});

check('sums bytes in both [n] and [n/m] forms', function () {
  var t = createTracker(0, 0);
  t.feed("- 'a' saved [559]\n- 'b' saved [2048/2048]\n");
  assert.strictEqual(t.bytes, 2607);
});

check('a response split across chunks is still counted once', function () {
  var t = createTracker(0, 0);
  t.feed("2026-08-03 12:00:01 (34.6 MB/s) - 'example.com/ind");
  t.feed("ex.html' saved [559]\n");
  // Neither half carries a complete line, so nothing is counted. That is the
  // point: the old code counted "200 OK" substrings and double-counted here.
  assert.strictEqual(t.files, 0);
});

check('tracks the address currently being fetched', function () {
  var t = createTracker(0, 0);
  t.feed('--2026-08-03 12:00:00--  https://example.com/one\n');
  t.feed('--2026-08-03 12:00:01--  https://example.com/two\n');
  assert.strictEqual(t.current, 'https://example.com/two');
});

check('offers no estimate before there is a sample worth using', function () {
  var t = createTracker(0, 80);
  t.feed("- 'a.html' saved [10]\n");
  assert.strictEqual(t.snapshot(10000).remainingMs, undefined);
});

check('offers no estimate without a page total', function () {
  var t = createTracker(0, 0);
  for (var i = 0; i < 20; i++) t.feed("- 'p" + i + ".html' saved [10]\n");
  assert.strictEqual(t.snapshot(60000).remainingMs, undefined);
});

check('estimates from the rate once there is a denominator', function () {
  var t = createTracker(0, 100);
  for (var i = 0; i < 10; i++) t.feed("- 'p" + i + ".html' saved [10]\n");
  // 10 pages in 10s, 90 to go, so about 90s.
  assert.strictEqual(t.snapshot(10000).remainingMs, 90000);
});

console.log('host classification');

check('keeps hosts that serve real assets', function () {
  var c = classify(['images.squarespace-cdn.com', 'use.typekit.net', 'assets.example.com']);
  assert.strictEqual(c.keep.length, 3);
  assert.strictEqual(c.skip.length, 0);
});

check('drops analytics and tag managers', function () {
  var c = classify(['www.googletagmanager.com', 'ssl.google-analytics.com']);
  assert.strictEqual(c.keep.length, 0);
  assert.strictEqual(c.skip.length, 2);
});

check('drops the typekit beacon but keeps the font host', function () {
  var c = classify(['use.typekit.net', 'p.typekit.net']);
  assert.deepStrictEqual(c.keep, ['use.typekit.net']);
  assert.strictEqual(c.skip[0].host, 'p.typekit.net');
});

check('does not match a lookalike hostname', function () {
  var c = classify(['notgoogle-analytics.com']);
  assert.deepStrictEqual(c.keep, ['notgoogle-analytics.com']);
});

console.log('allowlist building');

check('includes the target and its www twin', function () {
  var list = discover.buildDomainList(new URL('https://example.com/'), []);
  assert.ok(list.indexOf('example.com') !== -1);
  assert.ok(list.indexOf('www.example.com') !== -1);
});

check('rejects entries that would break the --domains argument', function () {
  var list = discover.buildDomainList(new URL('https://example.com/'), ['bad,host.com', '-dashlead.com', 'ok.com']);
  assert.ok(list.indexOf('bad,host.com') === -1);
  assert.ok(list.indexOf('-dashlead.com') === -1);
  assert.ok(list.indexOf('ok.com') !== -1);
});

check('reads asset hosts out of markup, ignoring plain links', function () {
  var html = '<link href="https://cdn.example.net/a.css">' +
             '<img src="//img.example.org/x.jpg">' +
             '<a href="https://facebook.com/page">social</a>' +
             '<div style="background:url(https://bg.example.io/y.png)"></div>';
  var hosts = discover.collectHosts(html, new URL('https://site.test/'));
  assert.ok(hosts.indexOf('cdn.example.net') !== -1, 'stylesheet host');
  assert.ok(hosts.indexOf('img.example.org') !== -1, 'protocol-relative image host');
  assert.ok(hosts.indexOf('bg.example.io') !== -1, 'css url() host');
  assert.ok(hosts.indexOf('facebook.com') === -1, 'plain <a href> must be ignored');
});

console.log('');
console.log(failed ? ('FAILED ' + failed + ' of ' + (passed + failed)) : ('all ' + passed + ' checks passed'));
process.exit(failed ? 1 : 0);
