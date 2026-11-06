// ============================================================
// server/ai/entryGates.js — v21.35.4 · PRE-TRADE "HIGHER-PROFIT" GATES
// ------------------------------------------------------------
// TWO deterministic entry-quality gates (pure, no I/O, no order placement):
//
//   1. MONTE-CARLO ODDS GATE (pre-trade "time machine")
//      Resamples the symbol's OWN closed trigger-TF bars into N random-walk
//      scenarios of the planned entry→SL→T2 geometry and reports:
//        pStop   : % of paths where the stop is hit before T2
//        pTarget : % where T2 is reached first
//        pGreen  : % where at least T1 is reached
//        evRealisticR : mean net R after round-trip fees across all paths
//      "Higher profit" = only carry the entry when the odds are genuinely in
//      our favour (positive fee-aware EV, stop not the likely outcome).
//      HONEST low-sample: < 40 usable bars → available=false, NEVER blocks.
//
//   2. BREAKOUT-CONFIRM GATE (last-CLOSED-bar confirmation, wick-immune)
//      A trigger whose most recent CLOSED bar closed AGAINST the trade or is
//      STALE is the classic fake-out entry. Confirms:
//        • last closed bar's close is on the trade's side of entry
//        • the confirming bar is fresh (≤ freshMin old, when it has a ts)
//      Missing bars / missing data → fail-open (never block on data we lack).
//
// MODES (same discipline as every R3–R9 guard):
//   off | shadow (DEFAULT — records would-block evidence in shadowStats,
//   never blocks) | enforce (explicit operator choice, blocks entries).
// Both gates ride evaluateEntryGuards() → the existing shadowHarness
// (recordShadowDecision), so shadow evidence → later flip is the same path
// as scoreCalibration / preTp1Trail.
// ============================================================

import { normalizeSide } from './directionCertificate.js';

/** Round-trip fee % by market — single source matches exec/sizing.js
 *  (FUTURES/CRYPTO 0.12, INDIA 0.08). Kept local so the module stays pure. */
const _feePct = (market) => (String(market || '').toUpperCase() === 'INDIA' ? 0.08 : 0.12);

/** Deterministic mulberry32 — same seed + same candle set = same odds. */
function _mulberry32(seed) {
  let a = Number(seed) >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ 0;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const _num = (v, f = 0) => { const n = Number(v); return Number.isFinite(n) ? n : f; };
const _normSide = (s) => normalizeSide(s);
function _guardModeV(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (['enforce', 'on', '1', 'true', 'active'].includes(v)) return 'enforce';
  if (['off', '0', 'false', 'disabled', 'none'].includes(v)) return 'off';
  return 'shadow';
}

/**
 * 1. MONTE-CARLO ODDS GATE.
 * @param {object} i
 *   row         { symbol, side, market|execMarket, plan:{entry,stopLoss,t1,t2} }
 *   candles     closed trigger-TF candles [{time,open,high,low,close,volume}]
 *   mode        off | shadow (default) | enforce
 *   minEvR      block when evRealisticR < this (default 0.1 R, fee-aware)
 *   maxPStopPct block when pStop% > this (default 55)
 *   scenarios   default 4000 (capped 100000)
 *   horizonSteps default 48 resampled steps
 *   seed        default 1337 (deterministic)
 * @returns pure telemetry; `blocked` true ONLY when mode==='enforce' && wouldBlock.
 */
export function evaluateMonteCarloOddsGate({
  row = {}, candles = null, mode = 'shadow',
  minEvR = 0.1, maxPStopPct = 55, scenarios = 4000, horizonSteps = 48, seed = 1337,
} = {}) {
  const base = {
    filter: 'monteCarloOdds', mode: _guardModeV(mode), available: false,
    wouldBlock: false, blocked: false,
    pStop: null, pTarget: null, pGreen: null, evRealisticR: null,
    breakEvenPct: null, scenarios: 0, horizonSteps, nCandles: 0, seed,
    reason: null,
  };
  if (base.mode === 'off') return { ...base, reason: 'gate_off' };

  const side = _normSide(row.side);
  const entry = _num(row.plan?.entry ?? row.entry);
  const sl = _num(row.plan?.stopLoss ?? row.stopLoss);
  const t1 = _num(row.plan?.t1 ?? row.target1);
  const t2 = _num(row.plan?.t2 ?? row.target2);
  const market = String(row.execMarket || row.market || 'FUTURES').toUpperCase();
  if (!side || !(entry > 0) || !(sl > 0) || !(t1 > 0) || !(t2 > 0)) {
    return { ...base, reason: 'incomplete_ticket' };
  }
  const risk = Math.abs(entry - sl);
  if (!(risk > 0)) return { ...base, reason: 'zero_risk' };

  // Usable per-bar returns: consecutive closed-bar close→close, sane moves only.
  const closes = (Array.isArray(candles) ? candles : [])
    .map(c => Number(c?.close)).filter(v => Number.isFinite(v) && v > 0);
  const returns = [];
  for (let i = 1; i < closes.length; i++) {
    const r = (closes[i] - closes[i - 1]) / closes[i - 1];
    if (Number.isFinite(r) && Math.abs(r) < 0.5) returns.push(r); // <50%/bar = sane
  }
  base.nCandles = closes.length;
  if (returns.length < 40) {
    return { ...base, reason: 'insufficient_candles (need ≥40 usable bars, have ' + returns.length + ')' };
  }
  base.available = true;

  const isLong = side === 'LONG';
  const feeR = (_feePct(market) / 100) * entry / risk;   // round-trip fees in R units
  const N = Math.min(100_000, Math.max(200, Math.floor(_num(scenarios, 4000))));
  const H = Math.min(480, Math.max(4, Math.floor(_num(horizonSteps, 48))));
  const rng = _mulberry32(Number.isFinite(Number(seed)) ? Number(seed) : 1337);
  const t1R = Math.abs(t1 - entry) / risk;
  const t2R = Math.abs(t2 - entry) / risk;

  let nStop = 0, nTarget = 0, nGreen = 0, sumR = 0;
  for (let s = 0; s < N; s++) {
    let px = entry;
    let hitStop = false, hitT2 = false, green = false;
    for (let k = 0; k < H; k++) {
      const r = returns[Math.floor(rng() * returns.length)];
      // px = the MARKET price across the horizon, identical path for BOTH sides.
      // The resampled returns are MARKET close-to-close, so a LONG and a SHORT
      // position are both marked against the same market path — the side only
      // differs in WHERE stop/target sit (LONG: stop below, target above;
      // SHORT: stop above, target below) and in the P&L sign.
      px = px * (1 + r);
      if (isLong ? px <= sl : px >= sl) { hitStop = true; break; }
      if (!hitT2 && (isLong ? px >= t2 : px <= t2)) { hitT2 = true; break; }
      if (isLong ? px >= t1 : px <= t1) green = true;
    }
    if (hitStop) nStop++;
    if (hitT2) { nTarget++; green = true; }
    if (green) nGreen++;
    const rEnd = hitStop ? -1 : hitT2 ? t2R : Math.max(-1, Math.min(t2R, isLong ? (px - entry) / risk : (entry - px) / risk));
    sumR += rEnd - feeR; // fees paid on entry + exit in every scenario
  }
  const pStop = nStop / N, pTarget = nTarget / N, pGreen = nGreen / N;
  const evRealisticR = sumR / N;
  // Fee-aware fair win-share: P(target) should exceed P(stop) by enough that,
  // against (feeR + 1)R stop-cost vs t2R target-book, edge is positive.
  const breakEvenPct = Math.round((pStop * 100) / (pStop + pTarget) * 10) / 10 || null;

  const negEdge = evRealisticR < Number(minEvR);
  const stopHeavy = pStop * 100 > Number(maxPStopPct) || (pStop > pTarget && evRealisticR <= 0);
  const wouldBlock = negEdge || stopHeavy;
  return {
    ...base,
    wouldBlock, blocked: base.mode === 'enforce' && wouldBlock,
    pStop: +(pStop * 100).toFixed(1), pTarget: +(pTarget * 100).toFixed(1),
    pGreen: +(pGreen * 100).toFixed(1), evRealisticR: +evRealisticR.toFixed(3),
    breakEvenPct, scenarios: N, nCandles: closes.length,
    reason: !wouldBlock ? 'odds-ok' : (negEdge && stopHeavy ? 'neg-edge+stop-heavy' : negEdge ? 'negative-fee-aware-EV' : 'stop-outcome-dominant'),
  };
}

/**
 * 2. BREAKOUT-CONFIRM GATE (last-CLOSED-bar, wick-immune).
 * @param {object} i
 *   row      { side, plan:{entry}, trigger:{volRatio} }
 *   candles  closed trigger-TF candles (last element = most recent CLOSED bar)
 *   mode     off | shadow (default) | enforce
 *   freshMin confirming bar must be ≤ this old when it has a timestamp (default 60)
 * @returns pure telemetry; `blocked` only when mode==='enforce' && wouldBlock.
 */
export function evaluateBreakoutConfirmGate({
  row = {}, candles = null, mode = 'shadow', freshMin = 60, now = null,
} = {}) {
  const base = {
    filter: 'breakoutConfirm', mode: _guardModeV(mode), available: false,
    wouldBlock: false, blocked: false,
    lastCloseConfirmed: null, barAgeMin: null,
    lastClose: null, entry: null, side: null, reason: null,
  };
  if (base.mode === 'off') return { ...base, reason: 'gate_off' };
  const side = _normSide(row.side);
  const entry = _num(row.plan?.entry ?? row.entry);
  if (!side || !(entry > 0)) return { ...base, reason: 'incomplete_ticket' };
  const bars = (Array.isArray(candles) ? candles : []).filter(c => Number(c?.close) > 0);
  if (bars.length < 2) return { ...base, reason: 'insufficient_candles' };
  base.available = true;

  const last = bars[bars.length - 1];
  const lastClose = Number(last.close);
  base.lastClose = +lastClose.toFixed(8);
  base.side = side; base.entry = entry;
  const isLong = side === 'LONG';
  const eps = entry * 0.001; // hair tolerance for float
  // The confirming bar's CLOSE must sit on the trade's side of entry.
  // Wicks never count — only the close (this is the wick-immune part).
  const closeInFavDir = isLong ? lastClose >= entry - eps : lastClose <= entry + eps;
  // Freshness — only when the bar carries a timestamp.
  const ts = Number(last.time ?? last.ts ?? last.t ?? 0);
  if (ts > 0 && Number(now) > 0) base.barAgeMin = +Math.max(0, (Number(now) - ts) / 60000).toFixed(1);
  const stale = Number.isFinite(base.barAgeMin) ? base.barAgeMin > Number(freshMin) : false;

  base.lastCloseConfirmed = closeInFavDir ? true : false;
  // wouldBlock ONLY on the adverse close (fake-out signature) or a stale
  // confirming bar. A neutral same-side close is NOT blocked — the gate is
  // anti-fake-out, not a market-timing vote.
  const wouldBlock = !closeInFavDir || stale;
  return {
    ...base,
    wouldBlock, blocked: base.mode === 'enforce' && wouldBlock,
    reason: !wouldBlock ? 'confirmed' : (!closeInFavDir ? 'last-closed-bar-against-trade' : 'confirm-bar-stale'),
  };
}

/**
 * 3. LATE-WAVE / EXHAUSTION GATE (anti-late-entry — v21.35.5).
 * Observed failure mode (user-reported, 9/10 last MTF trades): the board
 * fires AFTER the trend wave has already run most of its distance, so the
 * entry lands at the END of the move — the trade creeps a little in favour
 * and then the wave reverts. Two deterministic, closed-bar/wick-immune
 * signatures of a late entry:
 *   • WAVE-PROGRESS: within the last `windowBars` closed bars the wave range
 *     (HIGH↔LOW) is already ≥ `maxWaveProgressPct` travelled toward the
 *     trade's target before entry.
 *   • REWARD-CONSUMED: live price has already eaten most of the way to T1
 *     (remaining T1 distance < `minT1RemainR` × current risk) AND the wave
 *     is past its midpoint — the profit-to-be is small, the reversal zone
 *     is large.
 * Flat/chop range (< 0.3 × ATR) is NOT a wave → fail-open. Missing
 * candles/live price → never block.
 *
 * @param {object} i
 *   row     { side, plan:{entry,stopLoss,t1,t2} }
 *   candles closed trigger-TF candles (last element = most recent CLOSED bar)
 *   livePrice optional live quote (falls back to last closed close)
 *   mode    off | shadow (default) | enforce
 *   maxWaveProgressPct  default 85
 *   minT1RemainR        default 0.5 (in R, at the live price)
 *   windowBars          default 36 closed bars
 *   atrBars             default 14
 * @returns pure telemetry; `blocked` only when mode==='enforce' && wouldBlock.
 */
export function evaluateLateWaveGate({
  row = {}, candles = null, livePrice = null, mode = 'shadow',
  maxWaveProgressPct = 85, minT1RemainR = 0.5, windowBars = 36, atrBars = 14,
} = {}) {
  const base = {
    filter: 'lateWave', mode: _guardModeV(mode), available: false,
    wouldBlock: false, blocked: false,
    waveProgressPct: null, t1RemainR: null, atrPct: null,
    waveHigh: null, waveLow: null, side: null, livePx: null, reason: null,
  };
  if (base.mode === 'off') return { ...base, reason: 'gate_off' };
  const side = _normSide(row.side);
  const entry = _num(row.plan?.entry ?? row.entry);
  const sl = _num(row.plan?.stopLoss ?? row.stopLoss);
  const t1 = _num(row.plan?.t1 ?? row.target1);
  if (!side || !(entry > 0) || !(sl > 0)) return { ...base, reason: 'incomplete_ticket' };
  base.side = side;
  const bars = (Array.isArray(candles) ? candles : []).filter(c => Number(c?.high) > 0 && Number(c?.low) > 0);
  if (bars.length < Math.max(4, Math.min(atrBars, bars.length))) return { ...base, reason: 'insufficient_candles' };
  base.available = true;
  const win = bars.slice(-Math.max(4, Math.min(Number(windowBars) || 36, bars.length)));
  const waveHigh = Math.max(...win.map(c => Number(c.high)));
  const waveLow = Math.min(...win.map(c => Number(c.low)));
  base.waveHigh = +waveHigh.toFixed(8);
  base.waveLow = +waveLow.toFixed(8);
  const atrWindow = bars.slice(-Math.max(3, Math.min(Number(atrBars) || 14, bars.length)));
  let atrSum = 0;
  for (const c of atrWindow) atrSum += (Number(c.high) - Number(c.low)) / Math.max(1e-8, Number(c.close) || 1);
  const atrPct = atrSum / atrWindow.length; // mean bar range as % of close
  base.atrPct = +(atrPct * 100).toFixed(4);
  const range = waveHigh - waveLow;
  // No real wave (flat/chop) → nothing to be "late" into. Fail-open.
  const waveDistPct = waveHigh > 0 ? range / waveHigh : 0;
  if (!(range > 0) || waveDistPct < atrPct * 0.3) {
    return { ...base, reason: 'no-wave (flat/chop range < 0.3×ATR)' };
  }
  const px = Number(livePrice) > 0 ? Number(livePrice) : Number(win[win.length - 1]?.close);
  base.livePx = Number.isFinite(px) && px > 0 ? +px.toFixed(8) : null;
  if (!(px > 0)) return { ...base, reason: 'no_live_price' };
  const isLong = side === 'LONG';
  // Wave progress toward the target: LONG measures rise from waveLow,
  // SHORT measures fall from waveHigh. 1.0 = wave already at its extreme.
  const progress = isLong
    ? (px - waveLow) / range
    : (waveHigh - px) / range;
  const progressClamped = Math.max(0, Math.min(1, progress));
  base.waveProgressPct = +(progressClamped * 100).toFixed(1);
  // Reward remaining to T1, measured from the LIVE price (not the plan entry):
  // once price has eaten most of the entry→T1 leg, the booking zone is tiny.
  const liveRisk = Math.abs(px - sl);
  let t1RemainR = null;
  if (t1 > 0 && liveRisk > 1e-9) {
    t1RemainR = Math.abs(px - t1) / liveRisk;
    base.t1RemainR = +t1RemainR.toFixed(2);
  }
  const waveLate = progressClamped * 100 >= Number(maxWaveProgressPct);
  const rewardConsumed = t1RemainR != null
    && t1RemainR < Number(minT1RemainR)
    && progressClamped >= 0.5;
  const wouldBlock = waveLate || rewardConsumed;
  return {
    ...base,
    wouldBlock, blocked: base.mode === 'enforce' && wouldBlock,
    reason: !wouldBlock ? 'wave-open'
      : (waveLate && rewardConsumed ? `wave-${base.waveProgressPct}%+reward-consumed`
        : waveLate ? `wave-${base.waveProgressPct}%-consumed (late-entry)`
          : 'reward-consumed (T1 zone reached, reversal-prone)'),
  };
}

export const __entryGatesTest = { _mulberry32, _feePct, _guardModeV };
