"use strict";

class TTLCache {
  constructor(defaultTtlMs) {
    this.defaultTtlMs = defaultTtlMs;
    this.data = new Map();
  }
  get(key) {
    const entry = this.data.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.data.delete(key);
      return undefined;
    }
    return entry.value;
  }
  set(key, value, ttlMs = this.defaultTtlMs) {
    this.data.set(key, { value, expiresAt: Date.now() + ttlMs });
    return value;
  }
  delete(key) { this.data.delete(key); }
}

module.exports = { TTLCache };
