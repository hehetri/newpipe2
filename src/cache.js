"use strict";

/**
 * Cache com TTL e janela "stale": depois que o valor expira ele continua
 * disponível via `peek()` para ser servido enquanto a atualização roda em
 * segundo plano. É isso que impede o catálogo de voltar vazio quando o site
 * demora a responder ou fica fora do ar.
 */
class TTLCache {
  constructor(defaultTtlMs, defaultStaleMs = defaultTtlMs * 8) {
    this.defaultTtlMs = defaultTtlMs;
    this.defaultStaleMs = defaultStaleMs;
    this.data = new Map();
  }

  peek(key) {
    const entry = this.data.get(key);
    if (!entry) return undefined;
    const now = Date.now();
    if (now > entry.dropAt) {
      this.data.delete(key);
      return undefined;
    }
    return { value: entry.value, fresh: now <= entry.expiresAt, updatedAt: entry.updatedAt };
  }

  get(key) {
    const entry = this.peek(key);
    return entry && entry.fresh ? entry.value : undefined;
  }

  set(key, value, ttlMs = this.defaultTtlMs, staleMs = this.defaultStaleMs) {
    const now = Date.now();
    this.data.set(key, {
      value,
      updatedAt: now,
      expiresAt: now + ttlMs,
      dropAt: now + ttlMs + staleMs
    });
    return value;
  }

  delete(key) { this.data.delete(key); }
  keys() { return [...this.data.keys()]; }
}

/**
 * Garante uma execução simultânea por chave: várias requisições do Stremio
 * para o mesmo item compartilham o mesmo trabalho em vez de multiplicá-lo.
 */
class SingleFlight {
  constructor() { this.pending = new Map(); }

  run(key, factory) {
    const existing = this.pending.get(key);
    if (existing) return existing;
    const promise = Promise.resolve().then(factory).finally(() => {
      if (this.pending.get(key) === promise) this.pending.delete(key);
    });
    this.pending.set(key, promise);
    return promise;
  }

  has(key) { return this.pending.has(key); }
}

/** Resolve com `fallback` se a promessa não terminar dentro do orçamento. */
function withBudget(promise, budgetMs, fallback) {
  const settle = () => (typeof fallback === "function" ? fallback() : fallback);
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(settle());
    }, budgetMs);
    if (typeof timer.unref === "function") timer.unref();

    Promise.resolve(promise).then(
      (value) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } },
      () => { if (!settled) { settled = true; clearTimeout(timer); resolve(settle()); } }
    );
  });
}

/** Cronômetro simples para orçamentos de tempo. */
function deadline(budgetMs) {
  const end = Date.now() + budgetMs;
  return {
    remaining: () => Math.max(0, end - Date.now()),
    expired: () => Date.now() >= end
  };
}

module.exports = { TTLCache, SingleFlight, withBudget, deadline };
