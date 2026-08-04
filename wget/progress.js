/**
 * Reads wget's chatter and keeps a running count of real work done.
 *
 * The page used to count occurrences of "200 OK" in the output, which drifts
 * badly: stderr arrives in arbitrary chunks, so a single response can be split
 * across two of them or two responses can land in one. wget prints a definite
 * line for every file it actually writes, and that is what gets counted here:
 *
 *   2026-08-03 15:45:43 (34.6 MB/s) - 'example.com/index.html' saved [559]
 *
 * Pages are tracked apart from assets so the sitemap can be used as a
 * denominator. Assets have no denominator - there is no way to know how many
 * images a site has until they have all been found.
 */

var SAVED = /- '([^']+)' saved \[(\d+)/g;
var FETCHING = /^--\d{4}-\d{2}-\d{2} [\d:]+--\s+(\S+)/gm;
var PAGE = /\.x?html?$/i;

function createTracker(startedAt, totalPages) {
  return {
    files: 0,
    pages: 0,
    bytes: 0,
    current: '',
    totalPages: totalPages || 0,
    startedAt: startedAt,

    // Rolling state for the speed reading.
    rate: null,
    sampledAt: startedAt,
    sampledBytes: 0,

    /**
     * Folds one chunk of stderr in. Returns true when something worth
     * redrawing changed.
     */
    feed: function (text) {
      var changed = false;
      var match;

      SAVED.lastIndex = 0;
      while ((match = SAVED.exec(text)) !== null) {
        this.files++;
        this.bytes += Number(match[2]) || 0;
        if (PAGE.test(match[1])) this.pages++;
        changed = true;
      }

      FETCHING.lastIndex = 0;
      var last = null;
      while ((match = FETCHING.exec(text)) !== null) last = match[1];
      if (last && last !== this.current) {
        this.current = last;
        changed = true;
      }

      return changed;
    },

    /**
     * A plain snapshot for the browser.
     *
     * There is deliberately no estimate of time remaining. One was tried and
     * removed: the only denominator available is the sitemap's page count, but
     * pages and assets interleave, a photo-heavy page costs many times what a
     * text one does, and assets keep arriving long after the last page. The
     * resulting figure wandered up and down and told nobody anything. Speed is
     * measured rather than predicted, so it is reported instead.
     */
    snapshot: function (now) {
      var elapsedMs = now - this.startedAt;

      // Smoothed rate over the gap since the last snapshot. A plain average
      // across the whole run barely moves once it is a few minutes in, so it
      // stops reflecting what is happening now.
      var gapMs = now - this.sampledAt;
      if (gapMs >= 250) {
        var instant = (this.bytes - this.sampledBytes) / (gapMs / 1000);
        this.rate = this.rate === null ? instant : (this.rate * 0.7 + instant * 0.3);
        this.sampledAt = now;
        this.sampledBytes = this.bytes;
      }

      var out = {
        files: this.files,
        pages: this.pages,
        bytes: this.bytes,
        current: this.current,
        elapsedMs: elapsedMs
      };
      if (this.totalPages) out.totalPages = this.totalPages;
      if (this.rate !== null && this.rate >= 0) out.bytesPerSec = Math.round(this.rate);
      return out;
    }
  };
}

module.exports = createTracker;
