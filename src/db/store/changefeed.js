'use strict';

/**
 * Which collections changed recently, so open pages refresh within seconds
 * instead of polling everything. In memory: a restart just tells browsers to
 * refresh once (reset: true). Token format: "<boot>:<seq>".
 */
class ChangeFeed {
  constructor({ max = 2000 } = {}) {
    this.boot = Date.now().toString(36);
    this.seq = 0;
    this.max = max;
    this.recent = []; // { seq, collection }
  }
  note(collection) {
    this.seq += 1;
    this.recent.push({ seq: this.seq, collection });
    if (this.recent.length > this.max) this.recent.splice(0, this.recent.length - this.max);
  }
  token() { return `${this.boot}:${this.seq}`; }
  /** { seq, collections, reset } for a client that last saw `since`. */
  since(since) {
    const [boot, n] = String(since || '').split(':');
    const from = parseInt(n, 10);
    const { recent, seq } = this;
    if (boot !== this.boot || !Number.isFinite(from) || from > seq || (recent.length && from < recent[0].seq - 1)) {
      return { seq: this.token(), collections: [], reset: !!since };
    }
    const cols = new Set(recent.filter((r) => r.seq > from).map((r) => r.collection));
    return { seq: this.token(), collections: [...cols], reset: false };
  }
}

module.exports = { ChangeFeed };
