import { createHash } from 'node:crypto';

// Dedup keyed on header + payload (excluding path, so flood retransmissions
// from different relays collapse to one).
export class Dedup {
  constructor({ ttlMs = 60_000, maxEntries = 1024 } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.map = new Map(); // key -> expiresAt
  }

  _key(packet) {
    const h = createHash('sha256');
    h.update(Buffer.from([packet.header]));
    h.update(packet.payload);
    return h.digest('base64');
  }

  _prune(now) {
    for (const [k, exp] of this.map) {
      if (exp <= now) this.map.delete(k);
      else break; // Map preserves insertion order; entries added with same TTL are ordered
    }
    while (this.map.size > this.maxEntries) {
      const first = this.map.keys().next().value;
      this.map.delete(first);
    }
  }

  // Returns true if this packet was already seen recently.
  seen(packet) {
    const now = Date.now();
    this._prune(now);
    const key = this._key(packet);
    if (this.map.has(key)) {
      // Refresh TTL so repeated reflections keep being suppressed.
      this.map.delete(key);
      this.map.set(key, now + this.ttlMs);
      return true;
    }
    this.map.set(key, now + this.ttlMs);
    return false;
  }
}
