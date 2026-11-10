// ============================================================
// server/ai/lib/strategies/breakout.js — the 5 breakout classics
// ------------------------------------------------------------
//   1. Channel breakout 20/10 (Donchian)
//   2. Bollinger squeeze 20/2 (lookback 100, window 12)
//   3. Keltner channel EMA20 + ATR10×2
//   4. ATR breakout ATR14×1.5 (3×ATR trail)
//   5. Session range breakout (UTC 00:00–02:00 box)
// ============================================================
import {
  atr, bollinger, bollingerWidthPercentile, donchian, keltner,
} from '../indicators.js';
import {
  closeArr, rrLevels, sessionRange, swingHigh, swingLow, vote,
} from './common.js';

function channelBreakout2010(candles) {
  const d = donchian(candles, 20, 10);
  if (!d) return null;
  const close = candles[candles.length - 1].close;
  const dir = d.breakoutDir;
  const range = d.upper - d.lower;
  const volOk = range > 0 && Math.abs(close - d.mid) / range > 0.35;
  return vote({
    id: 'channel_breakout_20_10', name: 'Channel Breakout 20/10', family: 'breakout',
    dir,
    strength: dir === 0 ? 0 : 0.55 + (volOk ? 0.15 : 0),
    reasons: [dir === 0
      ? `Inside Donchian 20 (${d.lower.toFixed(4)}–${d.upper.toFixed(4)})`
      : `Close broke ${dir === 1 ? 'above 20-bar high' : 'below 20-bar low'} (${dir === 1 ? d.priorUpper.toFixed(4) : d.priorLower.toFixed(4)})`],
    levels: dir !== 0 ? rrLevels({ dir, entry: close, stop: dir === 1 ? d.exitLower : d.exitUpper }) : null,
    meta: { upper: d.upper, lower: d.lower, position: d.position, widthPct: d.widthPct },
  });
}

function bollingerSqueeze202(candles) {
  const closes = closeArr(candles);
  const bb = bollinger(closes, 20, 2);
  const pctNow = bollingerWidthPercentile(closes, { period: 20, lookback: 100 });
  const pct12 = closes.length > 112
    ? bollingerWidthPercentile(closes.slice(0, -12), { period: 20, lookback: 100 })
    : pctNow;
  if (!bb || pctNow == null) return null;
  const wasSqueezed = (pct12 != null && pct12 <= 25) || pctNow <= 25;
  const close = closes[closes.length - 1];
  const prevClose = closes[closes.length - 2];
  const dir = close > bb.upper ? 1 : close < bb.lower ? -1 : 0;
  const expanding = dir !== 0 && ((dir === 1 && close > prevClose) || (dir === -1 && close < prevClose));
  let strength = 0;
  if (dir !== 0 && wasSqueezed) strength = expanding ? 0.8 : 0.62;
  else if (dir !== 0) strength = 0.42;
  return vote({
    id: 'bollinger_squeeze_20_2', name: 'Bollinger Squeeze 20/2', family: 'breakout',
    dir: strength > 0 ? dir : 0,
    strength,
    reasons: [dir === 0
      ? (wasSqueezed ? `Squeeze active (width percentile ${pctNow}) — coiling, no break` : 'Bands normal — no squeeze setup')
      : `${wasSqueezed ? 'Post-squeeze ' : ''}${dir === 1 ? 'upper' : 'lower'} band break (width pct ${pctNow})`],
    levels: dir !== 0 ? rrLevels({ dir, entry: close, stop: dir === 1 ? bb.mid : bb.mid }) : null,
    meta: { widthPct: bb.widthPct, pctNow, pct12, squeeze: wasSqueezed, percentB: bb.percentB },
  });
}

function keltnerBreak(candles) {
  const kc = keltner(candles, { period: 20, mult: 2, atrPeriod: 10 });
  if (!kc) return null;
  const close = candles[candles.length - 1].close;
  const dir = close > kc.upper ? 1 : close < kc.lower ? -1 : 0;
  return vote({
    id: 'keltner_ema20_atr10_2', name: 'Keltner Break EMA20/ATR10×2', family: 'breakout',
    dir,
    strength: dir === 0 ? 0 : 0.6,
    reasons: [dir === 0
      ? `Inside Keltner channel (${kc.lower.toFixed(4)}–${kc.upper.toFixed(4)})`
      : `Close ${dir === 1 ? 'above upper' : 'below lower'} Keltner band`],
    levels: dir !== 0 ? rrLevels({ dir, entry: close, stop: kc.mid }) : null,
    meta: { upper: kc.upper, mid: kc.mid, lower: kc.lower, position: kc.position },
  });
}

function atrBreakout1415(candles) {
  const a = atr(candles, 14);
  if (!a || !(a > 0) || candles.length < 25) return null;
  const close = candles[candles.length - 1].close;
  const prevClose = candles[candles.length - 2].close;
  const disp = close - prevClose;
  const dir = disp >= 1.5 * a ? 1 : disp <= -1.5 * a ? -1 : 0;
  const hi20 = swingHigh(candles, 20, 1);
  const lo20 = swingLow(candles, 20, 1);
  const confirmsRange = dir === 1 ? (hi20 != null && close > hi20) : dir === -1 ? (lo20 != null && close < lo20) : false;
  return vote({
    id: 'atr_breakout_14_1_5', name: 'ATR Breakout 14×1.5', family: 'breakout',
    dir,
    strength: dir === 0 ? 0 : 0.6 + (confirmsRange ? 0.15 : 0),
    reasons: [dir === 0
      ? `No 1.5×ATR displacement (move ${(Math.abs(disp) / a).toFixed(2)}×ATR)`
      : `${(Math.abs(disp) / a).toFixed(2)}×ATR ${dir === 1 ? 'up' : 'down'} displacement${confirmsRange ? ' + 20-bar extreme break' : ''}`],
    levels: dir !== 0 ? rrLevels({ dir, entry: close, stop: close - dir * 3 * a }) : null,
    meta: { atr: a, displacementAtr: Math.abs(disp) / a, confirmsRange },
  });
}

function sessionRangeBreak(candles) {
  const sr = sessionRange(candles, { startUtcHour: 0, hours: 2 });
  if (!sr) return null;
  const a = atr(candles, 14);
  const dir = sr.breakoutDir;
  const rangeAtr = a != null && a > 0 ? sr.range / a : null;
  let strength = 0;
  if (dir !== 0 && sr.hasOutsideBars) {
    strength = 0.55;
    if (rangeAtr != null && rangeAtr >= 0.8 && rangeAtr <= 4) strength += 0.15;
    if (rangeAtr != null && rangeAtr < 0.4) strength -= 0.15;
  }
  return vote({
    id: 'session_range_utc_0_2h', name: 'Session Range Break (UTC 0–2h)', family: 'breakout',
    dir: strength > 0 ? dir : 0,
    strength,
    reasons: [dir === 0
      ? `Inside UTC 00–02 box (${sr.lower.toFixed(4)}–${sr.upper.toFixed(4)})`
      : `Broke ${dir === 1 ? 'above' : 'below'} UTC 00–02 range${rangeAtr != null ? ` (box ${rangeAtr.toFixed(1)}×ATR)` : ''}`],
    levels: dir !== 0 ? rrLevels({ dir, entry: sr.close, stop: dir === 1 ? sr.lower : sr.upper }) : null,
    meta: { upper: sr.upper, lower: sr.lower, rangeAtr, bars: sr.bars },
  });
}

export const BREAKOUT_STRATEGIES = [
  { id: 'channel_breakout_20_10', name: 'Channel Breakout 20/10', family: 'breakout', fn: channelBreakout2010 },
  { id: 'bollinger_squeeze_20_2', name: 'Bollinger Squeeze 20/2', family: 'breakout', fn: bollingerSqueeze202 },
  { id: 'keltner_ema20_atr10_2', name: 'Keltner Break EMA20/ATR10×2', family: 'breakout', fn: keltnerBreak },
  { id: 'atr_breakout_14_1_5', name: 'ATR Breakout 14×1.5', family: 'breakout', fn: atrBreakout1415 },
  { id: 'session_range_utc_0_2h', name: 'Session Range Break (UTC 0–2h)', family: 'breakout', fn: sessionRangeBreak },
];
