// ============================================================
// server/ai/lib/strategies/meanReversion.js — the 4 mean-reversion classics
// ------------------------------------------------------------
//   1. RSI 14 (30/70) wait-for-turn
//   2. Bollinger 20/2 band re-entry
//   3. Z-score 50 (entry |z| ≥ 2, exit 0)
//   4. VWAP 48 × 2σ band reversion
// ============================================================
import { bollinger, priceZScore, rsi, rollingVwapBands } from '../indicators.js';
import {
  closeArr, rrLevels, vote,
} from './common.js';

function rsiReversal143070(candles) {
  const closes = closeArr(candles);
  const now = rsi(closes, 14);
  const prev = closes.length > 20 ? rsi(closes.slice(0, -1), 14) : null;
  if (now == null) return null;
  let dir = 0, strength = 0, note = `RSI ${now.toFixed(1)}`;
  if (prev != null && prev < 30 && now >= 30) {
    dir = 1; strength = 0.72; note = `RSI reclaimed 30 (${prev.toFixed(1)} → ${now.toFixed(1)}) — wait-for-turn long`;
  } else if (prev != null && prev > 70 && now <= 70) {
    dir = -1; strength = 0.72; note = `RSI lost 70 (${prev.toFixed(1)} → ${now.toFixed(1)}) — wait-for-turn short`;
  } else if (now < 30) {
    note = `RSI ${now.toFixed(1)} oversold — waiting for turn above 30`;
  } else if (now > 70) {
    note = `RSI ${now.toFixed(1)} overbought — waiting for turn below 70`;
  }
  const close = closes[closes.length - 1];
  return vote({
    id: 'rsi_reversal_14_30_70', name: 'RSI Reversal 14 (30/70)', family: 'meanReversion',
    dir, strength,
    reasons: [note],
    levels: dir !== 0 ? rrLevels({ dir, entry: close, stop: dir === 1 ? Math.min(...candles.slice(-6).map(c => c.low)) : Math.max(...candles.slice(-6).map(c => c.high)) }) : null,
    meta: { rsi: now, prev },
  });
}

function bollingerReversion202(candles) {
  const closes = closeArr(candles);
  const bb = bollinger(closes, 20, 2);
  if (!bb) return null;
  const c = candles[candles.length - 1];
  const close = c.close;
  const bullReclaim = c.low <= bb.lower && close > bb.lower && close > c.open;
  const bearReject = c.high >= bb.upper && close < bb.upper && close < c.open;
  const dir = bullReclaim ? 1 : bearReject ? -1 : 0;
  return vote({
    id: 'bollinger_reversion_20_2', name: 'Bollinger Reversion 20/2', family: 'meanReversion',
    dir,
    strength: dir === 0 ? 0 : 0.7,
    reasons: [dir === 1
      ? `Lower-band reclaim (${bb.lower.toFixed(4)}) with bullish close`
      : dir === -1
        ? `Upper-band rejection (${bb.upper.toFixed(4)}) with bearish close`
        : `No band re-entry — %B ${bb.percentB.toFixed(2)}`],
    levels: dir !== 0 ? rrLevels({ dir, entry: close, stop: dir === 1 ? c.low : c.high }) : null,
    meta: { upper: bb.upper, mid: bb.mid, lower: bb.lower, percentB: bb.percentB },
  });
}

// v21.36.4 DEDUP — the standalone Z-Score 50 (2σ → 0) vote was REMOVED:
// it faded a 2σ extreme by PRICE POSITION ALONE, with no turn bar — a
// knife-catch double-count of the VWAP/BB reversion family (both of which
// REQUIRE a confirming close before voting). A position-only fade is
// exactly the "against-signal" entry that reverses on the way through,
// so dropping it is a quality gain, not a loss. The 50-bar 2σ extreme
// read now feeds the VWAP Reversion vote as context (see its meta).

function vwapReversion482(candles) {
  const bands = rollingVwapBands(candles, { period: 48, mult: 2 });
  if (!bands) return null;
  const c = candles[candles.length - 1];
  const close = c.close;
  const prevClose = candles.length > 1 ? candles[candles.length - 2].close : close;
  const long = (close <= bands.lower && close > c.open) || (bands.z <= -2 && close > prevClose);
  const short = (close >= bands.upper && close < c.open) || (bands.z >= 2 && close < prevClose);
  const dir = long && !short ? 1 : short && !long ? -1 : 0;
  let strength = dir === 0 ? 0 : 0.65;
  // v21.36.4 UPGRADE — now carries the removed Z-Score vote's job: a
  // 50-bar 2σ+ extreme CONFIRMING the same fade is independent
  // statistical evidence (two different mean definitions agree on the
  // deviation) → bounded bonus. Quality kept, knife-catch removed: the
  // VWAP band-turn requirement still gates the vote (see the DEDUP note
  // above this function).
  let zNote = null;
  if (dir !== 0) {
    const closes = closeArr(candles);
    const zs = priceZScore(closes, 50);
    if (zs && Math.abs(zs.z) >= 2 && Math.sign(zs.z) === -dir) {
      strength = Math.min(1, strength + 0.1);
      zNote = `50-bar z ${zs.z.toFixed(1)} confirms the extreme`;
    }
  }
  return vote({
    id: 'vwap_reversion_48_2', name: 'VWAP Reversion 48 (2σ)', family: 'meanReversion',
    dir,
    strength,
    reasons: [dir === 1
      ? `Price at/below −2σ VWAP band (${bands.lower.toFixed(4)}) and turning up`
      : dir === -1
        ? `Price at/above +2σ VWAP band (${bands.upper.toFixed(4)}) and turning down`
        : `VWAP z ${bands.z.toFixed(2)} — no band extreme`, zNote].filter(Boolean),
    levels: dir !== 0 ? rrLevels({ dir, entry: close, stop: dir === 1 ? Math.min(c.low, bands.lower) : Math.max(c.high, bands.upper) }) : null,
    meta: { vwap: bands.vwap, upper: bands.upper, lower: bands.lower, z: bands.z },
  });
}

export const MEAN_REVERSION_STRATEGIES = [
  { id: 'rsi_reversal_14_30_70', name: 'RSI Reversal 14 (30/70)', family: 'meanReversion', fn: rsiReversal143070 },
  { id: 'bollinger_reversion_20_2', name: 'Bollinger Reversion 20/2', family: 'meanReversion', fn: bollingerReversion202 },
  // v21.36.4: zscore_50_2_0 REMOVED (knife-catch double-count of the
  // VWAP/BB reversion family — its 50-bar 2σ read now feeds the VWAP
  // Reversion vote as a confirmation bonus, see the upgrade note there).
  { id: 'vwap_reversion_48_2', name: 'VWAP Reversion 48 (2σ)', family: 'meanReversion', fn: vwapReversion482 },
];
