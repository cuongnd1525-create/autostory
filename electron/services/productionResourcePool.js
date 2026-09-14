const pools = new Map();
async function withSlot(key, limit, signal, work) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('Resource limit must be a positive integer.');
  const pool = pools.get(key) || { active: 0, waiting: [] };
  pools.set(key, pool);
  signal?.throwIfAborted();
  if (pool.active >= limit) await new Promise((resolve, reject) => {
    const item = { resolve: () => { signal?.removeEventListener('abort', abort); resolve(); } };
    const abort = () => { const i = pool.waiting.indexOf(item); if (i >= 0) pool.waiting.splice(i, 1); reject(signal.reason || new Error('Cancelled')); };
    pool.waiting.push(item); signal?.addEventListener('abort', abort, { once: true });
  });
  else pool.active++;
  try { signal?.throwIfAborted(); return await work(); }
  finally { const next = pool.waiting.shift(); if (next) next.resolve(); else pool.active--; }
}
module.exports = { withSlot };
