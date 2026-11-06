// ============================================================
// server/ai/lib/latencyStats.js — v21.32.0 [PHASE B3]
// ------------------------------------------------------------
// MASTER PLAN: latency budget & measurement (PURE core + thin store).
//   tick→row builtAt, row→order sent, order→ack — P50/P95 store.
//
// HONEST CONTRACT: koi "1ms" claim nahi — real latency upstream feeds
// ki hai (v21.31 sahi bol chuka). Ye module sirf MEASURE karta hai.
//
// In-memory ring buffer (per-lane, capped) — koi IO nahi. `now` caller
// deta hai → tests deterministic. Server boot par ye reset hota hai
// (telemetry hai, ledger nahi).
// Tests: test/latencyStatsV21320.test.ts
// ============================================================

export const LATENCY_LANES = Object.freeze(['tickToRow', 'rowToOrder', 'orderToAck']);
const MAX_SAMPLES = 500;

function _lane(lane) {
  const l = String(lane || '').trim();
  return LATENCY_LANES.includes(l) ? l : null;
}

/**
 * In-memory latency recorder. Ek module-level store (server singleton).
 * Usage:
 *   const rec = createLatencyRecorder();
 *   rec.record('rowToOrder', 42, { now });
 *   rec.summary({ now });   // { lanes: { rowToOrder: { n, p50Ms, p95Ms, ... } } }
 */
export function createLatencyRecorder({ maxSamples = MAX_SAMPLES } = {}) {
  const lanes = Object.fromEntries(LATENCY_LANES.map((l) => [l, []]));
  const lastAt = Object.fromEntries(LATENCY_LANES.map((l) => [l, null]));
  return {
    record(lane, ms, { now = Date.now(), symbol = null } = {}) {
      const l = _lane(lane);
      const v = Number(ms);
      if (!l || !Number.isFinite(v) || v < 0) return false;
      lanes[l].push({ ms: Math.round(v * 10) / 10, at: Number(now) || Date.now(), symbol: symbol ? String(symbol).slice(0, 24) : null });
      if (lanes[l].length > maxSamples) lanes[l] = lanes[l].slice(-maxSamples);
      lastAt[l] = Number(now) || Date.now();
      return true;
    },
    /** Elapsed-style helper: stamp aja lo, baad me delta record karo. */
    stamp(lane, { now = Date.now() } = {}) {
      const l = _lane(lane);
      if (!l) return null;
      return { lane: l, t0: Number(now) || Date.now() };
    },
    finish(stampObj, { now = Date.now(), symbol = null } = {}) {
      if (!stampObj || !stampObj.lane || !Number.isFinite(Number(stampObj.t0))) return false;
      return this.record(stampObj.lane, (Number(now) || Date.now()) - Number(stampObj.t0), { now, symbol });
    },
    summary({ now = Date.now(), budgetMs = null } = {}) {
      const out = {};
      for (const l of LATENCY_LANES) {
        const xs = lanes[l].map((s) => s.ms).filter(Number.isFinite).sort((a, b) => a - b);
        const n = xs.length;
        const pick = (q) => (n ? Math.round(xs[Math.min(n - 1, Math.max(0, Math.ceil(q * n) - 1))] * 10) / 10 : null);
        const last = lanes[l][n - 1] ?? null;
        out[l] = {
          n,
          p50Ms: pick(0.5),
          p95Ms: pick(0.95),
          maxMs: n ? xs[n - 1] : null,
          lastMs: last ? last.ms : null,
          lastAt: lastAt[l],
          ageMs: lastAt[l] ? Math.max(0, (Number(now) || Date.now()) - lastAt[l]) : null,
          budgetMs: Number.isFinite(Number(budgetMs)) ? Number(budgetMs) : null,
          withinBudgetP95: n && Number.isFinite(Number(budgetMs))
            ? (pick(0.95) <= Number(budgetMs))
            : null,
        };
      }
      return { lanes: out, generatedAt: Number(now) || Date.now(), note: 'Latency upstream feeds ki hai — honest measurement, koi sub-ms claim nahi.' };
    },
    __reset() {
      for (const l of LATENCY_LANES) { lanes[l] = []; lastAt[l] = null; }
    },
  };
}

/** Module-level singleton (server telemetry). */
const _recorder = createLatencyRecorder();
export function latencyRecorder() { return _recorder; }

/** P50/P95 pure helper (array of ms) — nearest-rank percentile. */
export function percentileMs(xs, q = 0.5) {
  const s = (Array.isArray(xs) ? xs : []).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return null;
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1));
  return Math.round(s[idx] * 10) / 10;
}
