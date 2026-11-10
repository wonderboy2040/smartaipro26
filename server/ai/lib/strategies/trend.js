// ============================================================
// server/ai/lib/strategies/trend.js — the 8 trend-following classics
// ------------------------------------------------------------
// Specs (from the strategy playbook):
//   1. EMA Cross 9/21 (+ EMA filter)
//   2. Supertrend ATR 10 × 3
//   3. Golden Cross 50/200
//   4. Triple EMA 8/21/55
//   5. ADX 14 (20/50 ladder, ≥25 tradeable)
//   6. Parabolic SAR 0.02 / 0.2
//   7. Ichimoku 9/26/52
//   8. Heikin-Ashi 3-candle colour streak
// ============================================================
import {
  adx, emaSeries, heikinAshi, ichimokuCloud, psar, supertrend,
} from '../indicators.js';
import {
  closeArr, lastCross, rrLevels, smaSeries, trendFilter, vote,
} from './common.js';

function emaCross921(candles) {
  const closes = closeArr(candles);
  if (closes.length < 55) return null;
  const e9 = emaSeries(closes, 9);
  const e21 = emaSeries(closes, 21);
  const cross = lastCross(e9, e21, 3);
  const filter = trendFilter(closes, 50);
  const close = closes[closes.length - 1];
  const e9Now = e9[e9.length - 1];
  const e21Now = e21[e21.length - 1];
  const stack = e9Now > e21Now ? 1 : e9Now < e21Now ? -1 : 0;
  const dir = cross?.dir ?? stack;
  if (!dir) return vote({ id: 'ema_cross_9_21', name: 'EMA Cross 9/21', family: 'trend', reasons: ['EMA9/21 flat — no trend vote'] });
  const fresh = cross != null && cross.bars <= 1;
  let strength = fresh ? 0.72 : (cross ? 0.58 : 0.38);
  if (filter != null && filter === dir) strength += 0.12;
  if (filter != null && filter === -dir) strength -= 0.18;
  const reason = fresh
    ? `Fresh EMA9/21 cross ${dir === 1 ? 'bullish' : 'bearish'}`
    : `EMA9 ${dir === 1 ? 'above' : 'below'} EMA21 (${filter === dir ? 'with' : filter === -dir ? 'against' : 'no'} EMA50 filter)`;
  const a = closes.length >= 20 ? Math.abs(close - e21Now) : null;
  return vote({
    id: 'ema_cross_9_21', name: 'EMA Cross 9/21', family: 'trend',
    dir, strength,
    reasons: [reason, filter === dir ? 'EMA50 trend filter aligned' : filter === -dir ? 'EMA50 filter opposes' : 'EMA50 filter unavailable'],
    levels: rrLevels({ dir, entry: close, stop: dir === 1 ? Math.min(...closes.slice(-10)) : Math.max(...closes.slice(-10)) }),
    meta: { ema9: e9Now, ema21: e21Now, fresh, bars: cross?.bars ?? null, distPct: a != null && close > 0 ? a / close * 100 : null },
  });
}

function supertrend103(candles) {
  const st = supertrend(candles, 10, 3);
  if (!st) return null;
  const prev = candles.length > 25 ? supertrend(candles.slice(0, -1), 10, 3) : null;
  const freshFlip = Boolean(prev && prev.direction !== st.direction);
  const dir = st.direction;
  const close = candles[candles.length - 1].close;
  return vote({
    id: 'supertrend_10_3', name: 'Supertrend 10×3', family: 'trend',
    dir,
    strength: freshFlip ? 0.8 : 0.55,
    reasons: [freshFlip ? `Supertrend flipped ${dir === 1 ? 'bullish' : 'bearish'}` : `Supertrend ${dir === 1 ? 'bullish' : 'bearish'} trend intact`],
    levels: rrLevels({ dir, entry: close, stop: st.line }),
    meta: { line: st.line, upper: st.upper, lower: st.lower, freshFlip },
  });
}

function goldenCross50200(candles) {
  const closes = closeArr(candles);
  if (closes.length < 205) return null;
  const s50 = smaSeries(closes, 50);
  const s200 = smaSeries(closes, 200);
  if (!s50 || !s200) return null;
  const cross = lastCross(s50, s200, 10);
  const now50 = s50[s50.length - 1];
  const now200 = s200[s200.length - 1];
  const dir = cross?.dir ?? (now50 > now200 ? 1 : now50 < now200 ? -1 : 0);
  if (!dir) return vote({ id: 'golden_cross_50_200', name: 'Golden Cross 50/200', family: 'trend', reasons: ['SMA50/200 flat'] });
  return vote({
    id: 'golden_cross_50_200', name: 'Golden Cross 50/200', family: 'trend',
    dir,
    strength: cross ? 0.85 : 0.48,
    reasons: [cross ? `${cross.dir === 1 ? 'Golden' : 'Death'} cross ${cross.bars} bars ago` : `SMA50 ${dir === 1 ? 'above' : 'below'} SMA200`],
    meta: { sma50: now50, sma200: now200, bars: cross?.bars ?? null },
  });
}

function tripleEma82155(candles) {
  const closes = closeArr(candles);
  if (closes.length < 60) return null;
  const e8 = emaSeries(closes, 8);
  const e21 = emaSeries(closes, 21);
  const e55 = emaSeries(closes, 55);
  if (!e8 || !e21 || !e55) return null;
  const i = closes.length - 1;
  const a = e8[i], b = e21[i], c = e55[i];
  const ia = e8[i - 1], ib = e21[i - 1], ic = e55[i - 1];
  const dir = a > b && b > c ? 1 : a < b && b < c ? -1 : 0;
  const prevDir = ia > ib && ib > ic ? 1 : ia < ib && ib < ic ? -1 : 0;
  const fresh = dir !== 0 && dir !== prevDir;
  return vote({
    id: 'triple_ema_8_21_55', name: 'Triple EMA 8/21/55', family: 'trend',
    dir,
    strength: dir === 0 ? 0 : fresh ? 0.8 : 0.55,
    reasons: [dir === 0 ? 'EMA 8/21/55 mixed — no stack' : `EMA 8/21/55 ${dir === 1 ? 'bull stack' : 'bear stack'}${fresh ? ' (fresh)' : ''}`],
    meta: { ema8: a, ema21: b, ema55: c, fresh },
  });
}

function adxTrend2050(candles) {
  const a = adx(candles, 14);
  if (!a) return null;
  const dir = a.plusDI > a.minusDI ? 1 : a.plusDI < a.minusDI ? -1 : 0;
  const strong = a.adx >= 25;
  const veryStrong = a.adx >= 50;
  const strength = !strong ? 0 : veryStrong ? 0.85 : 0.35 + Math.min(0.4, (a.adx - 25) / 25 * 0.4);
  const close = candles[candles.length - 1].close;
  return vote({
    id: 'adx_trend_20_50', name: 'ADX Trend 14 (20/50)', family: 'trend',
    dir: strong ? dir : 0,
    strength,
    reasons: [strong
      ? `ADX ${a.adx.toFixed(1)} ${veryStrong ? 'very strong' : 'trending'} — ${dir === 1 ? '+DI' : '−DI'} dominance`
      : `ADX ${a.adx.toFixed(1)} < 25 — chop, no trend vote`],
    levels: strong ? rrLevels({ dir, entry: close, stop: dir === 1 ? Math.min(...candles.slice(-10).map(c => c.low)) : Math.max(...candles.slice(-10).map(c => c.high)) }) : null,
    meta: { adx: a.adx, plusDI: a.plusDI, minusDI: a.minusDI },
  });
}

function psarStrategy(candles) {
  const p = psar(candles, { step: 0.02, max: 0.2 });
  if (!p) return null;
  const fresh = p.flipBars != null && p.flipBars <= 2;
  const close = candles[candles.length - 1].close;
  return vote({
    id: 'psar_002_02', name: 'Parabolic SAR 0.02/0.2', family: 'trend',
    dir: p.dir,
    strength: fresh ? 0.78 : 0.5,
    reasons: [fresh ? `PSAR flipped ${p.dir === 1 ? 'bullish' : 'bearish'} ${p.flipBars} bar(s) ago` : `PSAR ${p.dir === 1 ? 'below' : 'above'} price — ${p.dir === 1 ? 'bullish' : 'bearish'}`],
    levels: rrLevels({ dir: p.dir, entry: close, stop: p.value }),
    meta: { sar: p.value, flipBars: p.flipBars, ep: p.ep },
  });
}

function ichimokuStrategy(candles) {
  const cloud = ichimokuCloud(candles, { tenkanPeriod: 9, kijunPeriod: 26, senkouBPeriod: 52 });
  if (!cloud) return null;
  const { dir, priceVsCloud, tkCross, cloudTop, cloudBottom, kijun } = cloud;
  const close = candles[candles.length - 1].close;
  let strength = 0.45;
  if (dir !== 0 && priceVsCloud === dir) strength += 0.2;
  if (dir !== 0 && tkCross === dir) strength += 0.15;
  return vote({
    id: 'ichimoku_9_26_52', name: 'Ichimoku 9/26/52', family: 'trend',
    dir,
    strength,
    reasons: [dir === 0
      ? 'Price inside Kumo cloud — no Ichimoku trend'
      : `Price ${priceVsCloud === 1 ? 'above' : priceVsCloud === -1 ? 'below' : 'at'} cloud, TK ${tkCross === 1 ? 'bull' : tkCross === -1 ? 'bear' : 'flat'}`],
    levels: dir !== 0 ? rrLevels({ dir, entry: close, stop: dir === 1 ? Math.min(cloudBottom, kijun) : Math.max(cloudTop, kijun) }) : null,
    meta: { tenkan: cloud.tenkan, kijun, cloudTop, cloudBottom, tkCross, priceVsCloud },
  });
}

function heikinAshi3(candles) {
  const ha = heikinAshi(candles, { keep: 6 });
  if (!ha) return null;
  const streak = ha.streak;
  const dir = Math.abs(streak) >= 3 ? (streak > 0 ? 1 : -1) : 0;
  const closes = closeArr(candles);
  const filter = trendFilter(closes, 100);
  let strength = dir === 0 ? 0 : 0.5 + Math.min(0.2, (Math.abs(streak) - 3) * 0.07);
  if (dir !== 0 && filter === dir) strength += 0.1;
  if (dir !== 0 && filter === -dir) strength -= 0.12;
  const close = closes[closes.length - 1];
  return vote({
    id: 'heikin_ashi_3', name: 'Heikin-Ashi 3-bar', family: 'trend',
    dir,
    strength,
    reasons: [dir === 0 ? `HA streak ${streak} — 3-bar colour rule not met` : `${Math.abs(streak)} consecutive ${dir === 1 ? 'green' : 'red'} HA candles${filter === dir ? ' + EMA100 filter' : ''}`],
    levels: dir !== 0 ? rrLevels({ dir, entry: close, stop: dir === 1 ? Math.min(...candles.slice(-5).map(c => c.low)) : Math.max(...candles.slice(-5).map(c => c.high)) }) : null,
    meta: { streak, haClose: ha.close, haOpen: ha.open },
  });
}

export const TREND_STRATEGIES = [
  { id: 'ema_cross_9_21', name: 'EMA Cross 9/21', family: 'trend', fn: emaCross921 },
  { id: 'supertrend_10_3', name: 'Supertrend 10×3', family: 'trend', fn: supertrend103 },
  { id: 'golden_cross_50_200', name: 'Golden Cross 50/200', family: 'trend', fn: goldenCross50200 },
  { id: 'triple_ema_8_21_55', name: 'Triple EMA 8/21/55', family: 'trend', fn: tripleEma82155 },
  { id: 'adx_trend_20_50', name: 'ADX Trend 14 (20/50)', family: 'trend', fn: adxTrend2050 },
  { id: 'psar_002_02', name: 'Parabolic SAR 0.02/0.2', family: 'trend', fn: psarStrategy },
  { id: 'ichimoku_9_26_52', name: 'Ichimoku 9/26/52', family: 'trend', fn: ichimokuStrategy },
  { id: 'heikin_ashi_3', name: 'Heikin-Ashi 3-bar', family: 'trend', fn: heikinAshi3 },
];
