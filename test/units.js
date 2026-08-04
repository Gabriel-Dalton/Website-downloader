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

check('never predicts a time remaining', function () {
  // A page-count estimate was tried and removed: pages and assets interleave,
  // so the figure wandered up and down. Kept as a test so it does not creep
  // back in.
  var t = createTracker(0, 100);
  for (var i = 0; i < 10; i++) t.feed("- 'p" + i + ".html' saved [10]\n");
  assert.strictEqual(t.snapshot(10000).remainingMs, undefined);
});

check('measures download speed', function () {
  var t = createTracker(0, 0);
  t.feed("- 'a' saved [1000000]\n");
  var s = t.snapshot(1000);
  // A megabyte in the first second, so roughly a megabyte per second.
  assert.ok(s.bytesPerSec > 900000 && s.bytesPerSec <= 1000000,
            'expected about 1 MB/s, got ' + s.bytesPerSec);
});

check('smooths speed rather than jumping to each sample', function () {
  var t = createTracker(0, 0);
  t.feed("- 'a' saved [1000000]\n");
  t.snapshot(1000);
  var steady = t.snapshot(2000).bytesPerSec;   // nothing new arrived
  assert.ok(steady < 1000000, 'a quiet second should pull the rate down');
  assert.ok(steady > 0, 'but not straight to zero');
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

console.log('third-party report');

check('names what was kept and what was left out', function () {
  var fs = require('fs');
  var os = require('os');
  var pathmod = require('path');
  var dir = fs.mkdtempSync(pathmod.join(os.tmpdir(), 'wd-test-'));
  var writeReport = require('../wget/third-party');
  var sorted = {
    keep: ['example.com', 'www.example.com', 'cdn.example.net'],
    skip: [{ host: 'www.googletagmanager.com', why: 'tag manager' }]
  };
  writeReport(dir, new URL('https://example.com/'), sorted, false);
  var text = fs.readFileSync(pathmod.join(dir, 'THIRD-PARTY.txt'), 'utf8');

  assert.ok(text.indexOf('cdn.example.net') !== -1, 'lists a downloaded host');
  assert.ok(text.indexOf('www.googletagmanager.com') !== -1, 'lists a skipped host');
  assert.ok(text.indexOf('tag manager') !== -1, 'gives the reason');
  assert.ok(text.indexOf('NOT DOWNLOADED') !== -1, 'says it was not fetched');
  // The site's own hostname is not a third party.
  assert.ok(text.indexOf('\n  example.com') === -1, 'excludes the site itself');

  fs.rmSync(dir, { recursive: true, force: true });
});

check('says so when trackers were fetched anyway', function () {
  var fs = require('fs');
  var os = require('os');
  var pathmod = require('path');
  var dir = fs.mkdtempSync(pathmod.join(os.tmpdir(), 'wd-test-'));
  var writeReport = require('../wget/third-party');
  writeReport(dir, new URL('https://example.com/'), {
    keep: ['example.com'],
    skip: [{ host: 'analytics.google.com', why: 'analytics' }]
  }, true);
  var text = fs.readFileSync(pathmod.join(dir, 'THIRD-PARTY.txt'), 'utf8');
  assert.ok(text.indexOf('DOES NOTHING OFFLINE') !== -1);
  assert.ok(text.indexOf('NOT DOWNLOADED') === -1);
  fs.rmSync(dir, { recursive: true, force: true });
});

console.log('lazily-loaded images');

var lazyImages = require('../wget/lazy-images');
var os = require('os');

// The shape Squarespace actually ships: no src at all, the address parked on
// data-src, and a flag telling their script the image is not ready yet.
var LAZY_TAG = '<img data-src="https://cdn.test/photos/6.jpg" ' +
               'data-image="https://cdn.test/photos/6.jpg" data-load="false" alt="" />';

function fixture(html) {
  var fs = require('fs');
  var pathmod = require('path');
  var dir = fs.mkdtempSync(pathmod.join(os.tmpdir(), 'wd-lazy-'));
  fs.mkdirSync(pathmod.join(dir, 'site.test'), { recursive: true });
  fs.writeFileSync(pathmod.join(dir, 'site.test', 'page.html'), html);
  return dir;
}

check('finds an image that has no src', function () {
  var dir = fixture(LAZY_TAG);
  var found = lazyImages.collect(dir, ['cdn.test']);
  assert.deepStrictEqual(found.urls, ['https://cdn.test/photos/6.jpg']);
  require('fs').rmSync(dir, { recursive: true, force: true });
});

check('will not pull in a host the mirror was told to skip', function () {
  var dir = fixture(LAZY_TAG);
  assert.strictEqual(lazyImages.collect(dir, ['site.test']).urls.length, 0);
  require('fs').rmSync(dir, { recursive: true, force: true });
});

check('treats a protocol-relative address as absolute', function () {
  var dir = fixture('<img data-src="//cdn.test/a.jpg">');
  assert.deepStrictEqual(lazyImages.collect(dir, ['cdn.test']).urls, ['https://cdn.test/a.jpg']);
  require('fs').rmSync(dir, { recursive: true, force: true });
});

check('writes a src pointing at the downloaded file', function () {
  var fs = require('fs');
  var pathmod = require('path');
  var dir = fixture(LAZY_TAG);
  // Stand in for what the second wget pass fetches.
  fs.mkdirSync(pathmod.join(dir, 'cdn.test', 'photos'), { recursive: true });
  fs.writeFileSync(pathmod.join(dir, 'cdn.test', 'photos', '6.jpg'), 'x');

  var changed = lazyImages.rewrite(dir);
  assert.strictEqual(changed.images, 1);

  var out = fs.readFileSync(pathmod.join(dir, 'site.test', 'page.html'), 'utf8');
  assert.ok(/src="\.\.\/cdn\.test\/photos\/6\.jpg"/.test(out), 'relative src, got: ' + out);
  assert.ok(out.indexOf('data-load="false"') === -1, 'the not-ready flag must go');
  fs.rmSync(dir, { recursive: true, force: true });
});

check('leaves an image the mirror already handled alone', function () {
  var fs = require('fs');
  var pathmod = require('path');
  var before = '<img src="../cdn.test/photos/6.jpg" data-src="https://cdn.test/photos/6.jpg">';
  var dir = fixture(before);
  fs.mkdirSync(pathmod.join(dir, 'cdn.test', 'photos'), { recursive: true });
  fs.writeFileSync(pathmod.join(dir, 'cdn.test', 'photos', '6.jpg'), 'x');

  assert.strictEqual(lazyImages.rewrite(dir).images, 0);
  assert.strictEqual(fs.readFileSync(pathmod.join(dir, 'site.test', 'page.html'), 'utf8'), before);
  fs.rmSync(dir, { recursive: true, force: true });
});

check('drops a srcset once there is a src to fall back to', function () {
  var fs = require('fs');
  var pathmod = require('path');
  // The shape that made the archive twice the size it needed to be.
  var dir = fixture('<img src="../cdn.test/a.png" sizes="240px" srcset="' +
                    '//cdn.test/a.png?format=100w 100w, //cdn.test/a.png?format=1500w 1500w">');
  fs.mkdirSync(pathmod.join(dir, 'cdn.test'), { recursive: true });
  fs.writeFileSync(pathmod.join(dir, 'cdn.test', 'a.png'), 'x');

  var changed = lazyImages.rewrite(dir);
  assert.strictEqual(changed.srcsets, 1);
  var out = fs.readFileSync(pathmod.join(dir, 'site.test', 'page.html'), 'utf8');
  assert.ok(out.indexOf('srcset') === -1, 'srcset must go: ' + out);
  assert.ok(out.indexOf('sizes') === -1, 'sizes goes with it');
  assert.ok(out.indexOf('src="../cdn.test/a.png"') !== -1, 'src survives untouched');
  fs.rmSync(dir, { recursive: true, force: true });
});

check('keeps a srcset when it is the only source', function () {
  var fs = require('fs');
  var pathmod = require('path');
  // Stripping here would leave the image with nothing at all.
  var dir = fixture('<img srcset="//cdn.test/a.png?format=100w 100w">');
  assert.strictEqual(lazyImages.rewrite(dir).srcsets, 0);
  assert.ok(fs.readFileSync(pathmod.join(dir, 'site.test', 'page.html'), 'utf8').indexOf('srcset') !== -1);
  fs.rmSync(dir, { recursive: true, force: true });
});

check('adds the reveal snippet once, before the closing body tag', function () {
  var fs = require('fs');
  var pathmod = require('path');
  var dir = fixture('<body><img src="a.jpg"></body>');
  assert.strictEqual(lazyImages.injectReveal(dir).files, 1);
  var page = pathmod.join(dir, 'site.test', 'page.html');
  var out = fs.readFileSync(page, 'utf8');
  assert.ok(out.indexOf(lazyImages.REVEAL_MARK) !== -1, 'snippet present');
  assert.ok(out.indexOf(lazyImages.REVEAL_MARK) < out.indexOf('</body>'), 'sits before </body>');
  // Running the repair twice must not stack copies.
  assert.strictEqual(lazyImages.injectReveal(dir).files, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

check('skips a fragment with no body tag', function () {
  var dir = fixture('<div>partial</div>');
  assert.strictEqual(lazyImages.injectReveal(dir).files, 0);
  require('fs').rmSync(dir, { recursive: true, force: true });
});

check('the reject pattern matches variants but not the original', function () {
  var re = new RegExp(lazyImages.REJECT_REGEX);
  assert.ok(re.test('https://cdn.test/a.png?format=1500w'), 'matches a variant');
  assert.ok(re.test('https://cdn.test/a.png?v=2&format=100w'), 'matches as a later parameter');
  assert.ok(!re.test('https://cdn.test/a.png'), 'leaves the original alone');
  assert.ok(!re.test('https://cdn.test/format-guide.html'), 'not fooled by the word in a path');
});

check('does not invent a src when the file was never fetched', function () {
  var dir = fixture(LAZY_TAG);
  // Nothing on disk, so a src would point at a 404 and look worse than no image.
  assert.strictEqual(lazyImages.rewrite(dir).images, 0);
  require('fs').rmSync(dir, { recursive: true, force: true });
});

console.log('');
console.log(failed ? ('FAILED ' + failed + ' of ' + (passed + failed)) : ('all ' + passed + ' checks passed'));
process.exit(failed ? 1 : 0);
