// ============================================================
// server/ai/lib/strategies/momentum.js — the 7 momentum classics
// ------------------------------------------------------------
//   1. MACD 12/26/9
//   2. Stochastic 14/3/3 (20/80)
//   3. Stochastic RSI 14/14/3/3 (20/80)
//   4. Williams %R 14 (−80/−20) + EMA100 filter
//   5. CCI 20 (±100)
//   6. ROC 24 + EMA6 of ROC
//   7. MACD + RSI(14) combo (RSI < 70 long / > 30 short)
// ============================================================
import {
  cci, ema, emaSeries, macd, rsi, stochastic, stochRsi, williamsR,
} from '../indicators.js';
import {
  closeArr, crossUp, rrLevels, vote,
} from './common.js';

function macdStrategy(candles) {
  const closes = closeArr(candles);
  const m = macd(closes, 12, 26, 9);
  if (!m) return null;
  const prevHist = m.hist - m.histSlope;
  const fresh = (m.hist > 0 && prevHist <= 0) || (m.hist < 0 && prevHist >= 0);
  const dir = m.hist > 0 ? 1 : m.hist < 0 ? -1 : 0;
  const close = closes[closes.length - 1];
  return vote({
    id: 'macd_12_26_9', name: 'MACD 12/26/9', family: 'momentum',
    dir,
    strength: dir === 0 ? 0 : fresh ? 0.75 : 0.45,
    reasons: [dir === 0 ? 'MACD histogram flat' : `MACD histogram ${dir === 1 ? 'positive' : 'negative'}${fresh ? ' — fresh cross' : ''} (slope ${m.histSlope >= 0 ? 'up' : 'down'})`],
    levels: rrLevels({ dir, entry: close, stop: dir === 1 ? Math.min(...closes.slice(-8)) : Math.max(...closes.slice(-8)) }),
    meta: { macd: m.macd, signal: m.signal, hist: m.hist, histSlope: m.histSlope, fresh },
  });
}

function stochastic1433(candles) {
  const now = stochastic(candles, 14, 3, 3);
  const prev = candles.length > 20 ? stochastic(candles.slice(0, -1), 14, 3, 3) : null;
  if (!now) return null;
  const cross = prev ? crossUp(prev.k, prev.d, now.k, now.d) : 0;
  let dir = 0, strength = 0, note = '';
  if (cross === 1 && (prev.k < 20 || now.k < 30)) {
    dir = 1; strength = 0.7; note = `Stoch %K crossed up in oversold (${now.k.toFixed(1)})`;
  } else if (cross === -1 && (prev.k > 80 || now.k > 70)) {
    dir = -1; strength = 0.7; note = `Stoch %K crossed down in overbought (${now.k.toFixed(1)})`;
  } else if (now.k >= 80) {
    dir = -1; strength = 0.32; note = `Stoch overbought ${now.k.toFixed(1)} — exhaustion bias`;
  } else if (now.k <= 20) {
    dir = 1; strength = 0.32; note = `Stoch oversold ${now.k.toFixed(1)} — exhaustion bias`;
  } else {
    note = `Stoch neutral K ${now.k.toFixed(1)} D ${now.d.toFixed(1)}`;
  }
  const close = candles[candles.length - 1].close;
  return vote({
    id: 'stochastic_14_3_3', name: 'Stochastic 14/3/3', family: 'momentum',
    dir, strength,
    reasons: [note],
    levels: dir !== 0 ? rrLevels({ dir, entry: close, stop: dir === 1 ? Math.min(...candles.slice(-6).map(c => c.low)) : Math.max(...candles.slice(-6).map(c => c.high)) }) : null,
    meta: { k: now.k, d: now.d, cross },
  });
}

function stochRsi1433(candles) {
  const closes = closeArr(candles);
  const now = stochRsi(closes, { rsiPeriod: 14, stochPeriod: 14 });
  const prev = closes.length > 35 ? stochRsi(closes.slice(0, -1), { rsiPeriod: 14, stochPeriod: 14 }) : null;
  if (!now) return null;
  const cross = prev ? crossUp(prev.k, prev.d, now.k, now.d) : 0;
  let dir = 0, strength = 0, note = '';
  if (cross === 1 && prev.k <= 25) {
    dir = 1; strength = 0.72; note = `StochRSI bullish cross from ${prev.k.toFixed(1)}`;
  } else if (cross === -1 && prev.k >= 75) {
    dir = -1; strength = 0.72; note = `StochRSI bearish cross from ${prev.k.toFixed(1)}`;
  } else if (now.k <= 20 && now.k > now.d) {
    dir = 1; strength = 0.42; note = `StochRSI oversold turn up (${now.k.toFixed(1)})`;
  } else if (now.k >= 80 && now.k < now.d) {
    dir = -1; strength = 0.42; note = `StochRSI overbought turn down (${now.k.toFixed(1)})`;
  } else {
    note = `StochRSI neutral K ${now.k.toFixed(1)} D ${now.d.toFixed(1)}`;
  }
  const close = closes[closes.length - 1];
  return vote({
    id: 'stoch_rsi_14_14_3_3', name: 'Stochastic RSI 14/14/3/3', family: 'momentum',
    dir, strength,
    reasons: [note],
    levels: dir !== 0 ? rrLevels({ dir, entry: close, stop: dir === 1 ? Math.min(...closes.slice(-6)) : Math.max(...closes.slice(-6)) }) : null,
    meta: { k: now.k, d: now.d, cross },
  });
}

function williamsR14(candles) {
  const now = williamsR(candles, 14);
  const prev = candles.length > 20 ? williamsR(candles.slice(0, -1), 14) : null;
  if (now == null) return null;
  const closes = closeArr(candles);
  const ema100 = closes.length >= 100 ? emaSeries(closes, 100) : null;
  const filter = ema100 ? (closes[closes.length - 1] > ema100[ema100.length - 1] ? 1 : -1) : null;
  let dir = 0, strength = 0, note = `Williams %R ${now.toFixed(1)}`;
  if (prev != null && prev <= -80 && now > -80 && (filter == null || filter === 1)) {
    dir = 1; strength = 0.7; note = `Williams %R exited oversold (${prev.toFixed(1)} → ${now.toFixed(1)})${filter === 1 ? ' + EMA100' : ''}`;
  } else if (prev != null && prev >= -20 && now < -20 && (filter == null || filter === -1)) {
    dir = -1; strength = 0.7; note = `Williams %R exited overbought (${prev.toFixed(1)} → ${now.toFixed(1)})${filter === -1 ? ' + EMA100' : ''}`;
  } else if (now <= -80) {
    dir = 0; strength = 0; note = `Williams %R oversold ${now.toFixed(1)} — waiting for turn`;
  } else if (now >= -20) {
    dir = 0; strength = 0; note = `Williams %R overbought ${now.toFixed(1)} — waiting for turn`;
  }
  const close = closes[closes.length - 1];
  return vote({
    id: 'williams_r_14', name: 'Williams %R 14', family: 'momentum',
    dir, strength,
    reasons: [note],
    levels: dir !== 0 ? rrLevels({ dir, entry: close, stop: dir === 1 ? Math.min(...candles.slice(-8).map(c => c.low)) : Math.max(...candles.slice(-8).map(c => c.high)) }) : null,
    meta: { value: now, prev, filter },
  });
}

function cci20(candles) {
  const now = cci(candles, 20);
  const prev = candles.length > 25 ? cci(candles.slice(0, -1), 20) : null;
  if (now == null) return null;
  const cross = prev != null ? crossUp(prev, -100, now, -100) : 0;
  const crossDown = prev != null ? crossUp(prev, 100, now, 100) : 0;
  let dir = 0, strength = 0, note = `CCI ${now.toFixed(1)}`;
  if (cross === 1) { dir = 1; strength = 0.68; note = `CCI reclaimed −100 (${prev.toFixed(1)} → ${now.toFixed(1)})`; }
  else if (crossDown === -1) { dir = -1; strength = 0.68; note = `CCI lost +100 (${prev.toFixed(1)} → ${now.toFixed(1)})`; }
  else if (now > 100) { dir = 1; strength = 0.38; note = `CCI ${now.toFixed(1)} > 100 — strong momentum`; }
  else if (now < -100) { dir = -1; strength = 0.38; note = `CCI ${now.toFixed(1)} < −100 — strong downside`; }
  const close = candles[candles.length - 1].close;
  return vote({
    id: 'cci_20', name: 'CCI 20 (±100)', family: 'momentum',
    dir, strength,
    reasons: [note],
    levels: dir !== 0 ? rrLevels({ dir, entry: close, stop: dir === 1 ? Math.min(...candles.slice(-8).map(c => c.low)) : Math.max(...candles.slice(-8).map(c => c.high)) }) : null,
    meta: { value: now, prev },
  });
}

function roc24Ema6(candles) {
  const closes = closeArr(candles);
  if (closes.length < 32) return null;
  const rocSeries = [];
  for (let i = 24; i < closes.length; i++) {
    const past = closes[i - 24];
    if (past > 0) rocSeries.push(((closes[i] - past) / past) * 100);
  }
  if (rocSeries.length < 7) return null;
  const emaRoc = ema(rocSeries, 6);
  const now = rocSeries[rocSeries.length - 1];
  if (emaRoc == null || now == null) return null;
  const dir = now > 0 && now > emaRoc ? 1 : now < 0 && now < emaRoc ? -1 : 0;
  const close = closes[closes.length - 1];
  return vote({
    id: 'roc_24_ema6', name: 'ROC 24 + EMA6', family: 'momentum',
    dir,
    strength: dir === 0 ? 0 : 0.45 + Math.min(0.3, Math.abs(now) / 10),
    reasons: [dir === 0
      ? `ROC24 ${now.toFixed(2)}% vs EMA6 ${emaRoc.toFixed(2)}% — no acceleration`
      : `ROC24 ${now.toFixed(2)}% ${dir === 1 ? 'above' : 'below'} its EMA6 (${emaRoc.toFixed(2)}%)`],
    levels: rrLevels({ dir, entry: close, stop: dir === 1 ? Math.min(...closes.slice(-10)) : Math.max(...closes.slice(-10)) }),
    meta: { roc: now, rocEma6: emaRoc },
  });
}

function macdRsiCombo(candles) {
  const closes = closeArr(candles);
  const m = macd(closes, 12, 26, 9);
  const r = rsi(closes, 14);
  if (!m || r == null) return null;
  let dir = 0, strength = 0, note = '';
  if (m.hist > 0 && r < 70) { dir = 1; strength = 0.5 + (r < 55 ? 0.1 : 0); note = `MACD bull + RSI ${r.toFixed(1)} < 70 (not overbought)`; }
  else if (m.hist < 0 && r > 30) { dir = -1; strength = 0.5 + (r > 45 ? 0.1 : 0); note = `MACD bear + RSI ${r.toFixed(1)} > 30 (not oversold)`; }
  else if (m.hist > 0 && r >= 70) { note = `MACD bull but RSI ${r.toFixed(1)} overbought — combo blocked`; }
  else if (m.hist < 0 && r <= 30) { note = `MACD bear but RSI ${r.toFixed(1)} oversold — combo blocked`; }
  else { note = 'MACD/RSI combo flat'; }
  const close = closes[closes.length - 1];
  return vote({
    id: 'macd_rsi_combo', name: 'MACD + RSI 14 combo', family: 'momentum',
    dir, strength,
    reasons: [note],
    levels: dir !== 0 ? rrLevels({ dir, entry: close, stop: dir === 1 ? Math.min(...closes.slice(-8)) : Math.max(...closes.slice(-8)) }) : null,
    meta: { hist: m.hist, rsi: r },
  });
}

export const MOMENTUM_STRATEGIES = [
  { id: 'macd_12_26_9', name: 'MACD 12/26/9', family: 'momentum', fn: macdStrategy },
  { id: 'stochastic_14_3_3', name: 'Stochastic 14/3/3', family: 'momentum', fn: stochastic1433 },
  { id: 'stoch_rsi_14_14_3_3', name: 'Stochastic RSI 14/14/3/3', family: 'momentum', fn: stochRsi1433 },
  { id: 'williams_r_14', name: 'Williams %R 14', family: 'momentum', fn: williamsR14 },
  { id: 'cci_20', name: 'CCI 20 (±100)', family: 'momentum', fn: cci20 },
  { id: 'roc_24_ema6', name: 'ROC 24 + EMA6', family: 'momentum', fn: roc24Ema6 },
  { id: 'macd_rsi_combo', name: 'MACD + RSI 14 combo', family: 'momentum', fn: macdRsiCombo },
];
