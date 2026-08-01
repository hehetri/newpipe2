"use strict";

class TTLCache {
  constructor(defaultTtlMs) {
    this.defaultTtlMs = defaultTtlMs;
    this.values = new Map();
  }

  get(key) {
    const entry = this.values.get(key);
    if (!entry) return undefined;
    if (Date.now() >= entry.expiresAt) {
      this.values.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key, value, ttlMs = this.defaultTtlMs) {
    this.values.set(key, { value, expiresAt: Date.now() + ttlMs });
    return value;
  }

  delete(key) {
    this.values.delete(key);
  }
}

module.exports = { TTLCache };
