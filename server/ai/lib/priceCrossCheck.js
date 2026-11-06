// ============================================================
// server/ai/lib/priceCrossCheck.js — v21.32.0 [PHASE B2]
// ------------------------------------------------------------
// MASTER PLAN: multi-source price cross-check (PURE).
//   Crypto: CoinDCX exec price vs Binance perp mark
//   India:  Dhan/Groww/Finnhub quote disagreement
// Divergence > max(0.15%, 1.5×spread) → 'DIVERGED' → entry block
// (stale/fat-finger protection). Telemetry `priceSources[]`.
//
// Fail-open on missing data (D4: missing data par block Nahi —
// coverage metric alag se track hota hai): koi source missing →
// 'UNKNOWN', kabhi 'DIVERGED' nahi.
//
// Tests: test/priceCrossCheckV21320.test.ts
// ============================================================

export const CROSS_CHECK_DEFAULTS = Object.freeze({
  minDivergencePct: 0.15,
  spreadMult: 1.5,
});

/**
 * Compare execution-venue price vs reference-venue price.
 *
 * @param {object} p
 * @param {number} p.execPrice      CoinDCX (ya Dhan) — jahan order jayega
 * @param {number} [p.refPrice]     Binance perp mark (ya Groww/Finnhub ref)
 * @param {number} [p.spreadBps]    exec venue ka current spread (bps)
 * @param {object} [p.opts]
 * @returns {{verdict:'OK'|'DIVERGED'|'UNKNOWN', divergencePct:number|null,
 *   thresholdPct:number|null, spreadBps:number|null, reason:string}}
 */
export function crossCheckPrice(
  { execPrice, refPrice, spreadBps = null },
  {
    minDivergencePct = CROSS_CHECK_DEFAULTS.minDivergencePct,
    spreadMult = CROSS_CHECK_DEFAULTS.spreadMult,
  } = {},
) {
  const e = Number(execPrice), r = Number(refPrice), sp = Number(spreadBps);
  const spread = Number.isFinite(sp) && sp > 0 ? sp : null;
  if (!Number.isFinite(e) || e <= 0) {
    return { verdict: 'UNKNOWN', divergencePct: null, thresholdPct: null, spreadBps: spread, reason: 'exec price missing' };
  }
  if (!Number.isFinite(r) || r <= 0) {
    return { verdict: 'UNKNOWN', divergencePct: null, thresholdPct: null, spreadBps: spread, reason: 'reference price missing (fail-open — coverage separately tracked)' };
  }
  const divergencePct = Math.abs(e - r) / r * 100;
  // threshold = max(0.15%, 1.5×spread%) — spread bps → pct = bps/100
  const fromSpread = spread != null ? spreadMult * (spread / 100) : 0;
  const thresholdPct = Math.max(minDivergencePct, fromSpread);
  const verdict = divergencePct > thresholdPct ? 'DIVERGED' : 'OK';
  return {
    verdict,
    divergencePct: Math.round(divergencePct * 100) / 100,
    thresholdPct: Math.round(thresholdPct * 100) / 100,
    spreadBps: spread,
    reason: verdict === 'DIVERGED'
      ? `divergence ${divergencePct.toFixed(3)}% > threshold ${thresholdPct.toFixed(3)}% — stale/fat-finger guard`
      : `divergence ${divergencePct.toFixed(3)}% within threshold ${thresholdPct.toFixed(3)}%`,
  };
}

/**
 * Multi-source telemetry row (K1 `priceSources[]` shape) — sources ki
 * list + cross-check summary. PURE.
 */
export function priceSourceTelemetry({ execPrice, refPrice, refName = 'reference', spreadBps = null, opts } = {}) {
  const check = crossCheckPrice({ execPrice, refPrice, spreadBps }, opts);
  return {
    execPrice: Number.isFinite(Number(execPrice)) ? Number(execPrice) : null,
    refPrice: Number.isFinite(Number(refPrice)) ? Number(refPrice) : null,
    refName: String(refName || 'reference').slice(0, 32),
    spreadBps: check.spreadBps,
    crossCheck: check.verdict,
    divergencePct: check.divergencePct,
    thresholdPct: check.thresholdPct,
    reason: check.reason,
    at: null, // caller stamp karega (pure function — clock nahi)
  };
}
