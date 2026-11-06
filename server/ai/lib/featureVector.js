// ============================================================
// server/ai/lib/featureVector.js — v21.33.0 [PHASE C F2/F8/F9/F11/F13]
// ------------------------------------------------------------
// MASTER PLAN Phase C completion: decision-grade feature snapshot
// (fv: 2) jo ledger + meta-model (Phase E) consume karte hain.
//
// PURE module — koi exchange call nahi, koi IO nahi, deterministic.
// NON-REPAINTING GOLDEN RULE (C1): saare features SIRF closed bars
// se compute hote hain (caller `closedCandles` pass karta hai —
// forming last bar pehle drop kar diya gaya hai). Missing → null
// (kabhi 0 nahi — 0 ek jhoota "fact" hai, null honest "unknown").
//
// Features (plan C3):
//   F2  realizedVolRatio   — short/long realized-vol ratio (expansion vs contraction)
//   F8  rsiDivergence      — pivot-based RSI regular divergence (closed pivots only)
//   F8  macdDivergence     — pivot-based MACD histogram divergence
//   F9  relativeStrengthVsBtc — rolling symbol-vs-BTC return spread + beta/corr
//   F11 sessionFeatures    — hourOfDay bucket, dayOfWeek, minutes-to-funding,
//                            minutes-to-India-open/close
//   F13 barShape           — body%, wick%, close-location-value of trigger bar
//   F12 liquidity passthrough — spreadBps / liquidityUSD (execution se aata hai)
//   F10 derivatives passthrough — fundingBps8h / longShortRatio / basisPct
//
// Divergence GATING-only hai (plan F8): ye direction FLIP nahi karta —
// sirf exhaustion flag deta hai jo guards consume karte hain.
// ============================================================

const HOUR_MIN = 60;
const DAY_MIN = 24 * 60;
const IST_OFFSET_MIN = 330;

function _num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function _r2(v) {
  return v == null ? null : +Number(v).toFixed(2);
}

function _r4(v) {
  return v == null ? null : +Number(v).toFixed(4);
}

// ------------------------------------------------------------
// F2 — Realized-vol ratio (short window vs long window)
// vol expansion (>1) ya contraction (<1). ADX/ER ka independent
// volatility cross-check; regime + SL-sizing dono use karte hain.
// ------------------------------------------------------------
export function realizedVolRatio(closes, shortN = 14, longN = 56) {
  if (!Array.isArray(closes) || closes.length < longN + 1) return null;
  const rets = [];
  for (let i = closes.length - longN; i < closes.length; i++) {
    if (closes[i - 1] > 0) rets.push(Math.log(closes[i] / closes[i - 1]));
  }
  if (rets.length < longN) return null;
  const _std = (xs) => {
    const m = xs.reduce((s, x) => s + x, 0) / xs.length;
    return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length);
  };
  const shortRets = rets.slice(-shortN);
  const longStd = _std(rets);
  if (!(longStd > 0)) return null;
  const shortStd = _std(shortRets);
  return +(shortStd / longStd).toFixed(4);
}

// ------------------------------------------------------------
// F8 — Confirmed pivots (k-bar confirmation → NO REPAINT)
// Pivot high: high[i] > highs of k bars dono taraf. Pivot confirm
// hota hai i+k bar close hone par — isliye last k bars me pivot
// kabhi nahi banta. Divergence sirf in confirmed pivots se.
// ------------------------------------------------------------
export function confirmedPivots(candles, k = 3, { maxPivots = 8 } = {}) {
  if (!Array.isArray(candles) || candles.length < 2 * k + 1) return [];
  const found = [];
  // iterate only up to length-k-1: pivot i needs i+k <= length-1 (closed)
  for (let i = candles.length - 1 - k; i >= k && found.length < maxPivots; i--) {
    const c = candles[i];
    if (!c || !Number.isFinite(c.high) || !Number.isFinite(c.low)) continue;
    let isHigh = true;
    let isLow = true;
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue;
      if (candles[j].high >= c.high) isHigh = false;
      if (candles[j].low <= c.low) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) found.push({ i, t: c.time ?? null, price: c.high, kind: 'high' });
    if (isLow) found.push({ i, t: c.time ?? null, price: c.low, kind: 'low' });
  }
  return found; // newest-first order
}

/**
 * RSI regular divergence on confirmed pivots (closed bars only).
 * Bullish: price LOWER low + RSI HIGHER low (nearest two low pivots).
 * Bearish: price HIGHER high + RSI LOWER high.
 * GATING-ONLY (exhaustion flag) — direction flip kabhi nahi.
 */
export function rsiDivergence(candles, rsiPeriod = 14, k = 3) {
  if (!Array.isArray(candles) || candles.length < rsiPeriod + 2 * k + 6) return null;
  const piv = confirmedPivots(candles, k);
  const highs = piv.filter(p => p.kind === 'high').slice(0, 2);
  const lows = piv.filter(p => p.kind === 'low').slice(0, 2);
  const rsiAt = (idx) => {
    if (idx < rsiPeriod) return null;
    return _rsiSimple(candles.slice(0, idx + 1).map(c => c.close), rsiPeriod).rsi;
  };
  if (lows.length === 2) {
    const [newL, oldL] = lows; // newest-first
    const rNew = rsiAt(newL.i);
    const rOld = rsiAt(oldL.i);
    if (rNew != null && rOld != null && newL.price < oldL.price && rNew > rOld + 1.5) {
      return { kind: 'BULLISH', since: newL.i, strength: _r2(rNew - rOld) };
    }
  }
  if (highs.length === 2) {
    const [newH, oldH] = highs;
    const rNew = rsiAt(newH.i);
    const rOld = rsiAt(oldH.i);
    if (rNew != null && rOld != null && newH.price > oldH.price && rNew < rOld - 1.5) {
      return { kind: 'BEARISH', since: newH.i, strength: _r2(rOld - rNew) };
    }
  }
  return { kind: 'NONE', since: null, strength: null };
}

/** MACD-histogram divergence (same confirmed-pivot scaffolding). */
export function macdDivergence(candles, k = 3, { fast = 12, slow = 26, signal = 9 } = {}) {
  if (!Array.isArray(candles) || candles.length < slow + signal + 2 * k + 6) return null;
  const closes = candles.map(c => c.close);
  const histSeries = _macdHistSeries(closes, fast, slow, signal);
  if (!histSeries) return null;
  const piv = confirmedPivots(candles, k);
  const highs = piv.filter(p => p.kind === 'high').slice(0, 2);
  const lows = piv.filter(p => p.kind === 'low').slice(0, 2);
  if (lows.length === 2) {
    const [newL, oldL] = lows;
    const hNew = histSeries[newL.i];
    const hOld = histSeries[oldL.i];
    if (hNew != null && hOld != null && newL.price < oldL.price && hNew > hOld) {
      return { kind: 'BULLISH', since: newL.i, strength: _r4(hNew - hOld) };
    }
  }
  if (highs.length === 2) {
    const [newH, oldH] = highs;
    const hNew = histSeries[newH.i];
    const hOld = histSeries[oldH.i];
    if (hNew != null && hOld != null && newH.price > oldH.price && hNew < hOld) {
      return { kind: 'BEARISH', since: newH.i, strength: _r4(hOld - hNew) };
    }
  }
  return { kind: 'NONE', since: null, strength: null };
}

// Lightweight internal RSI (Wilder) — indicators.js ka rsi import karne
// par bhi yahi math hai; local copy circular-import se bachati hai.
function _rsiSimple(closes, period = 14) {
  if (!Array.isArray(closes) || closes.length < period + 1) return { rsi: null };
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let avgGain = gain / period, avgLoss = loss / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(0, d)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -d)) / period;
  }
  if (avgLoss === 0) return { rsi: avgGain === 0 ? 50 : 100 };
  return { rsi: 100 - 100 / (1 + avgGain / avgLoss) };
}

function _emaArr(values, period) {
  const k = 2 / (period + 1);
  const out = new Array(values.length).fill(null);
  let e = null;
  let seedCount = 0;
  let seedSum = 0;
  for (let i = 0; i < values.length; i++) {
    if (e == null) {
      seedSum += values[i];
      seedCount++;
      if (seedCount === period) {
        e = seedSum / period;
        out[i] = e;
      }
    } else {
      e = values[i] * k + e * (1 - k);
      out[i] = e;
    }
  }
  return out;
}

function _macdHistSeries(closes, fast, slow, signal) {
  if (closes.length < slow + signal) return null;
  const f = _emaArr(closes, fast);
  const s = _emaArr(closes, slow);
  const macdLine = closes.map((_, i) => (f[i] != null && s[i] != null ? f[i] - s[i] : null));
  const firstIdx = macdLine.findIndex(v => v != null);
  if (firstIdx < 0) return null;
  const tailIdx = [];
  const tailVals = [];
  for (let i = firstIdx; i < closes.length; i++) {
    if (macdLine[i] != null) { tailIdx.push(i); tailVals.push(macdLine[i]); }
  }
  if (tailVals.length < signal) return null;
  const sig = _emaArr(tailVals, signal);
  const hist = new Array(closes.length).fill(null);
  for (let j = 0; j < tailIdx.length; j++) {
    if (sig[j] != null) hist[tailIdx[j]] = tailVals[j] - sig[j];
  }
  return hist;
}

// ------------------------------------------------------------
// F9 — Relative strength vs BTC (rolling window)
// rsSpread > 0 = symbol BTC ko outperform kar raha hai (LONG quality
// boost ke liye), < 0 = underperform (alt-LONG penalty). Beta/corr
// rolling — sirf dono series me common tail window par.
// ------------------------------------------------------------
export function relativeStrengthVsBtc(symbolCloses, btcCloses, window = 60) {
  if (!Array.isArray(symbolCloses) || !Array.isArray(btcCloses)) return null;
  const n = Math.min(symbolCloses.length, btcCloses.length);
  if (n < window + 1) return null;
  const sym = symbolCloses.slice(-window - 1);
  const btc = btcCloses.slice(-window - 1);
  const symRet = sym[window] > 0 ? (sym[window] - sym[0]) / sym[0] : null;
  const btcRet = btc[window] > 0 ? (btc[window] - btc[0]) / btc[0] : null;
  if (symRet == null || btcRet == null) return null;
  // rolling beta / corr on overlapping returns
  const sRets = [];
  const bRets = [];
  for (let i = 1; i <= window; i++) {
    if (sym[i - 1] > 0 && btc[i - 1] > 0) {
      sRets.push(Math.log(sym[i] / sym[i - 1]));
      bRets.push(Math.log(btc[i] / btc[i - 1]));
    }
  }
  let beta = null;
  let corr = null;
  if (sRets.length >= 20) {
    const mS = sRets.reduce((a, b) => a + b, 0) / sRets.length;
    const mB = bRets.reduce((a, b) => a + b, 0) / bRets.length;
    let cov = 0, varS = 0, varB = 0;
    for (let i = 0; i < sRets.length; i++) {
      cov += (sRets[i] - mS) * (bRets[i] - mB);
      varS += (sRets[i] - mS) ** 2;
      varB += (bRets[i] - mB) ** 2;
    }
    if (varB > 0) beta = +(cov / varB).toFixed(4);
    if (varS > 0 && varB > 0) corr = +(cov / Math.sqrt(varS * varB)).toFixed(4);
  }
  return {
    rsSpread: _r4(symRet - btcRet),
    symbolRet: _r4(symRet),
    btcRet: _r4(btcRet),
    beta,
    corr,
    window,
  };
}

// ------------------------------------------------------------
// F11 — Session / time features (UTC-anchored, deterministic)
// Crypto: funding 00/08/16 UTC ±window; India: NSE 09:15–15:30 IST.
// ------------------------------------------------------------
export function sessionFeatures(now = Date.now(), { desk = 'CRYPTO' } = {}) {
  const d = new Date(Number(now) || Date.now());
  if (Number.isNaN(d.getTime())) return null;
  const utcMin = d.getUTCHours() * HOUR_MIN + d.getUTCMinutes();
  const istMin = (utcMin + IST_OFFSET_MIN) % DAY_MIN;
  const hourOfDay = d.getUTCHours();
  const dayOfWeek = d.getUTCDay(); // 0=Sun
  const minutesToFunding = (() => {
    let best = Infinity;
    for (const h of [0, 8, 16]) {
      const f = h * HOUR_MIN;
      let diff = f - utcMin;
      if (diff < 0) diff += DAY_MIN;
      if (diff < best) best = diff;
    }
    return best === Infinity ? null : best;
  })();
  const nseOpen = 9 * HOUR_MIN + 15;
  const nseClose = 15 * HOUR_MIN + 30;
  const minutesToIndiaOpen = (() => {
    let diff = nseOpen - istMin;
    if (diff < 0) diff += DAY_MIN;
    return diff;
  })();
  const minutesToIndiaClose = (() => {
    let diff = nseClose - istMin;
    if (diff < 0) diff += DAY_MIN;
    return diff;
  })();
  // Buckets: quiet hours liquidity seasonality ke liye (categorical).
  const hourBucket = hourOfDay < 2 ? '00-02'
    : hourOfDay < 4 ? '02-04'
      : hourOfDay < 8 ? '04-08'
        : hourOfDay < 12 ? '08-12'
          : hourOfDay < 16 ? '12-16'
            : hourOfDay < 20 ? '16-20'
              : '20-24';
  const indiaSessionActive = istMin >= nseOpen && istMin <= nseClose;
  return {
    hourOfDay,
    hourBucket,
    dayOfWeek,
    dayName: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dayOfWeek],
    minutesToFunding,
    minutesToIndiaOpen,
    minutesToIndiaClose,
    indiaSessionActive,
    desk: String(desk || 'CRYPTO').toUpperCase(),
  };
}

// ------------------------------------------------------------
// F13 — Bar-shape features (trigger bar quality, closed bar)
// bodyPct / upperWickPct / lowerWickPct / clv (close location value:
// +1 close at high, −1 at low) — trigger-bar strength ke liye.
// ------------------------------------------------------------
export function barShapeFeatures(candle) {
  if (!candle || !Number.isFinite(candle.open) || !Number.isFinite(candle.close)) return null;
  const hi = Number.isFinite(candle.high) ? candle.high : Math.max(candle.open, candle.close);
  const lo = Number.isFinite(candle.low) ? candle.low : Math.min(candle.open, candle.close);
  const range = hi - lo;
  if (!(range > 0)) return null;
  const body = Math.abs(candle.close - candle.open);
  return {
    bodyPct: _r2((body / range) * 100),
    upperWickPct: _r2(((hi - Math.max(candle.open, candle.close)) / range) * 100),
    lowerWickPct: _r2(((Math.min(candle.open, candle.close) - lo) / range) * 100),
    clv: _r2(((candle.close - lo - (hi - candle.close)) / range)),
    bullBar: candle.close > candle.open,
  };
}

// ------------------------------------------------------------
// fv: 2 — Full decision-grade feature snapshot
// row.context/trigger + closed candles + optional BTC reference +
// perpIntel/execution telemetry se ek FLAT, versioned object.
// Lookahead-free: sirf signal-time tak ka data.
// ------------------------------------------------------------
export function buildFeatureVector({
  row = {},
  ctxClosedCandles = null,
  trigClosedCandles = null,
  btcCloses = null,
  perpIntel = null,
  spreadBps = null,
  liquidityUSD = null,
  now = Date.now(),
} = {}) {
  const ctx = row.context && typeof row.context === 'object' ? row.context : {};
  const trig = row.trigger && typeof row.trigger === 'object' ? row.trigger : {};
  const ctxCloses = Array.isArray(ctxClosedCandles) ? ctxClosedCandles.map(c => c.close) : null;
  const trigBars = Array.isArray(trigClosedCandles) ? trigClosedCandles : null;
  const lastClosedTrigger = trigBars && trigBars.length ? trigBars[trigBars.length - 1] : null;

  const fv = {
    fv: 2,
    // — passthrough (already computed closed-bar by tradePlanner) —
    dir: _num(ctx.dir),
    score: _num(ctx.score),
    adx: _r2(ctx.adx),
    atrPct: _r2(ctx.atrPct),
    rsi: _r2(ctx.rsi),
    er: _r2(ctx.er),
    bbWidthPct: _r2(ctx.bbWidthPct),
    squeeze: typeof ctx.squeeze === 'boolean' ? ctx.squeeze : null,
    squeezeFired: typeof ctx.squeezeFired === 'boolean' ? ctx.squeezeFired : null,
    barsInTrend: _num(ctx.barsInTrend),
    exhausted: typeof ctx.exhausted === 'boolean' ? ctx.exhausted : null,
    // — F2: volatility expansion/contraction —
    realizedVolRatio: ctxCloses ? realizedVolRatio(ctxCloses) : null,
    // — F8: divergence (gating-only exhaustion flags) —
    rsiDivergence: trigBars ? rsiDivergence(trigBars) : null,
    macdDivergence: trigBars ? macdDivergence(trigBars) : null,
    // — F13: trigger bar shape —
    barShape: lastClosedTrigger ? barShapeFeatures(lastClosedTrigger) : null,
    // — F9: relative strength vs BTC (alt-signal quality) —
    relativeStrength: ctxCloses && Array.isArray(btcCloses) && btcCloses.length > 60
      ? relativeStrengthVsBtc(ctxCloses, btcCloses)
      : null,
    // — F11: session/time —
    session: sessionFeatures(now, { desk: row.market || row.desk || 'CRYPTO' }),
    // — F10/F12: derivatives + liquidity telemetry (row se) —
    fundingBps8h: _r2(perpIntel?.fundingBps8h ?? row.fundingBps8h ?? row.perpIntel?.fundingBps8h),
    longShortRatio: _r4(perpIntel?.longShortRatio ?? row.longShortRatio ?? row.perpIntel?.longShortRatio),
    basisPct: _r2(perpIntel?.basisPct ?? row.basisPct ?? row.perpIntel?.basisPct),
    spreadBps: _r2(spreadBps ?? row.spreadBps ?? row.execution?.spreadBps),
    liquidityUSD: _num(liquidityUSD ?? row.liquidityUSD ?? row.execution?.liquidityUSD),
    // — trigger passthrough —
    trigDir: _num(trig.dir),
    trigScore: _num(trig.score),
    trigVolRatio: _r2(trig.volRatio),
    trigBodyPct: _r2(trig.bodyPct),
    trigRsi: _r2(trig.rsi),
    trigPullbackReclaim: typeof trig.pullbackReclaim === 'boolean' ? trig.pullbackReclaim : null,
    trigReversalRisk: typeof trig.reversalRisk === 'boolean' ? trig.reversalRisk : null,
    // — board context —
    tier: row.tier || null,
    regime: row.regime ?? null,
    side: typeof row.side === 'string' ? row.side : null,
    superScore: _num(row.superScore),
    builtAt: _num(row.builtAt),
  };
  return fv;
}

/**
 * Divergence → exhaustion gate verdict (plan F8: gating only, never
 * a direction flip). Counter-side divergence = adverse exhaustion.
 */
export function divergenceExhaustionFor(side, { rsiDivergence: rd = null, macdDivergence: md = null } = {}) {
  const s = String(side || '').toUpperCase();
  if (s !== 'LONG' && s !== 'SHORT') return { adverse: false, favourable: false, reason: null };
  const bearish = rd?.kind === 'BEARISH' || md?.kind === 'BEARISH';
  const bullish = rd?.kind === 'BULLISH' || md?.kind === 'BULLISH';
  if (s === 'LONG' && bearish) return { adverse: true, favourable: false, reason: 'bearish divergence on LONG' };
  if (s === 'SHORT' && bullish) return { adverse: true, favourable: false, reason: 'bullish divergence on SHORT' };
  if (s === 'LONG' && bullish) return { adverse: false, favourable: true, reason: 'bullish divergence with LONG' };
  if (s === 'SHORT' && bearish) return { adverse: false, favourable: true, reason: 'bearish divergence with SHORT' };
  return { adverse: false, favourable: false, reason: null };
}
