/* ============================================================
   SPIRAL RUSH — rate limiter (abuse prevention)
   File: lib/ratelimit.js
   ------------------------------------------------------------
   Per-key token-bucket limiter. Used to throttle socket events
   per connection (spam / flood / abuse protection). Memory-only,
   self-pruning. For multi-instance, back this with Redis (same API).
   ============================================================ */
'use strict';

/* event → { capacity, refillPerSec }  (sensible defaults; tune in prod) */
const POLICIES = {
  default:        { capacity: 30, refillPerSec: 15 },
  progress:       { capacity: 40, refillPerSec: 30 },   // gameplay stream
  'board:get':    { capacity: 12, refillPerSec: 4 },
  'profile:set':  { capacity: 5,  refillPerSec: 0.5 },
  'profile:customize': { capacity: 8, refillPerSec: 1 },
  'friend:request':    { capacity: 6, refillPerSec: 0.2 },  // anti-spam
  'daily:submit': { capacity: 6,  refillPerSec: 0.5 },
  'ghost:save':   { capacity: 8,  refillPerSec: 1 },
};

class RateLimiter {
  constructor() {
    this.buckets = new Map();           // key -> { tokens, last }
    this._prune = setInterval(() => this.prune(), 60000);
    if (this._prune.unref) this._prune.unref();
  }
  policy(event) { return POLICIES[event] || POLICIES.default; }

  /* returns true if allowed, false if rate-limited */
  allow(key, event = 'default') {
    const p = this.policy(event);
    const id = event + '|' + key;
    const now = Date.now();
    let b = this.buckets.get(id);
    if (!b) { b = { tokens: p.capacity, last: now }; this.buckets.set(id, b); }
    // refill
    const elapsed = (now - b.last) / 1000;
    b.tokens = Math.min(p.capacity, b.tokens + elapsed * p.refillPerSec);
    b.last = now;
    if (b.tokens >= 1) { b.tokens -= 1; return true; }
    return false;
  }

  prune() {
    const now = Date.now();
    for (const [id, b] of this.buckets) {
      if (now - b.last > 300000) this.buckets.delete(id);  // 5 min idle
    }
  }
  reset() { this.buckets.clear(); }
}

module.exports = new RateLimiter();
module.exports.RateLimiter = RateLimiter;
