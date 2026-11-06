// ============================================================
// server/ai/mtfBoard.js — v21.16.0 MTF DUAL-TIMEFRAME SIGNALS BOARD
//              + SUPERINTELLIGENCE LAYER + AUTO-TRADE LINK
// ------------------------------------------------------------
// USER SPEC (15m+5m intraday / 1h+15m swing, time-boxed exits):
//   INTRADAY desk → analysis TF = 15m (candles ko DEEP samjho:
//     trend + structure + momentum + key levels + candle quality)
//                     action  TF = 5m  (kab ENTRY, kab SL, kab TP)
//     exit window    = 15–20 minute (3–4 bars of 5m)
//   SWING desk (1–1.5hr) → analysis TF = 1h, action TF = 15m,
//     exit window = 60–90 minute (4–6 bars of 15m)
//
// Core idea — TOP-DOWN CONFLUENCE GATE:
//   1. Analysis TF decides the BIAS (long/short/flat) — ye the
//      "direction" ka boss hai. Bina bias ke koi entry nahi.
//   2. Action TF sirf TIMING deta hai — pullback / breakout /
//      momentum-cross trigger arm hota hai to entry+SL+TP levels
//      milte hain. LTF kabhi bias FLIP nahi kar sakta.
//   3. Confluence states:
//        ARMED    — bias set + action trigger ACTIVE → trade-ready
//        WAIT     — bias set, LTF abhi trigger nahi diya (patience)
//        CONFLICT — LTF strongly against HTF bias → NO trade
//        NO-BIAS  — analysis TF range/chop hai → NO trade
//
// Accuracy discipline (kya MTF sach me accuracy deta hai?): sirf
// TF count se accuracy NAHI aati — ALIGNMENT se aati hai. Isliye
// har signal me `confluenceScore` (0-100) sirf tab badhta hai jab
// (a) HTF trend + structure ek direction me hon, (b) LTF trigger
// usi direction me ho, (c) entry-timing RSI zone sahi ho. A single
// TF ya conflicting TFs score ko kaat dete hain (honest scoring).
//
// Data chain: ZERO new upstreams — rawTfCandles() (mtf.js) wahi
// cached Yahoo-INDIA / CoinDCX→Binance chain use karta hai jo
// MTF-6 board bhi use karta hai (per-TF TTL caches shared, isliye
// ye board board-cycle me almost free hai). Honest degrade: candle
// na mile → symbol skip, kabhi throw nahi.
//
// Analysis module + SUPERINTELLIGENCE scoring (paper auto-entry
// engine mtfAutoEntry.js levels blueprint uthata hai — order paths
// wahan bhi nahi hain, sirf openPaperTrade virtual tickets).
// ============================================================
import { rawTfCandles } from './mtf.js';
import { computeIndicatorsFromCandles, atr as atrOf, emaSeries } from './lib/indicators.js';
import { INDIA_UNIVERSE, CRYPTO_UNIVERSE } from './data.js';
import { computeSuperScore, superTier, buildSuperBlueprint, SUPER_TIERS } from './superIntel.js';

// ---------------- mode config ----------------
export const MTF_MODES = {
  intraday: {
    key: 'intraday',
    label: 'Intraday',
    analysisTf: '15m',
    actionTf: '5m',
    analysisTfMin: 15,
    actionTfMin: 5,
    holdWindowMin: [15, 20],       // USER SPEC: 15–20 min exit
    analysisNote: '15m — deep candle read (bias boss)',
    actionNote: '5m — entry/SL/TP timing',
  },
  swing: {
    key: 'swing',
    label: 'Swing (1–1.5hr)',
    analysisTf: '1h',
    actionTf: '15m',
    analysisTfMin: 60,
    actionTfMin: 15,
    holdWindowMin: [60, 90],       // USER SPEC: 1hr–1:30hr exit
    analysisNote: '1h — deep candle read (bias boss)',
    actionNote: '15m — entry/SL/TP timing',
  },
};

// default universes — tight & liquid (cost discipline: 12 symbols
// × 2 TFs = 24 fetches, sab cached chain se)
const INTRADAY_INDIA_DEFAULT = [
  'RELIANCE', 'HDFCBANK', 'ICICIBANK', 'INFY', 'TCS', 'SBIN',
  'BHARTIARTL', 'ITC', 'LT', 'AXISBANK', 'TATAMOTORS', 'MARUTI',
];
const SWING_INDIA_DEFAULT = [
  'RELIANCE', 'HDFCBANK', 'ICICIBANK', 'SBIN', 'LT', 'TATAMOTORS',
  'TATASTEEL', 'JSWSTEEL', 'HINDALCO', 'INFY', 'TCS', 'BHARTIARTL',
];

// v21.16.0 AUTO-LINK BAR — the user spec: "75+ score wale strong
// signals paper trade auto se link ho jayein". Sirf ARMED + fresh
// signals qualify; WAIT/CONFLICT kabhi 75+ cross nahi kar sakte
// (score ladder ne unhe 70/40 par cap kiya hai — by construction).
export const MTF_AUTO_BAR = 75;

const BOARD_TTL_MS = 90_000;       // 90s board cache (cadence parity with main board)
const BOARD_CACHE_MAX = 8;         // (market, mode) combos
const _boardCache = new Map();     // key → { at, payload }
const _inflight = new Map();       // single-flight guard

const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
const r1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const num = (v) => (Number.isFinite(v) ? v : null);

/** price rounding — NSE style (₹ >500 → 1dp) / crypto (small coins 4dp) */
function px(v, market) {
  if (!Number.isFinite(v)) return null;
  if (market === 'CRYPTO') return v >= 100 ? r2(v) : v >= 1 ? r2(v) : Math.round(v * 10000) / 10000;
  return v >= 500 ? r1(v) : r2(v);
}

// ------------------------------------------------------------
// Structure — fractal swing pivots (2-bar each side)
// ------------------------------------------------------------
/** Find swing highs/lows in the last `lookback` bars. */
export function findSwings(candles, lookback = 40) {
  const out = { highs: [], lows: [] };
  if (!Array.isArray(candles) || candles.length < 7) return out;
  const start = Math.max(1, candles.length - lookback);
  for (let i = start; i < candles.length - 1; i++) {
    const c = candles[i], p = candles[i - 1], n = candles[i + 1];
    if (!c || !p || !n) continue;
    if (c.high > p.high && c.high > n.high) out.highs.push({ i, price: c.high, time: c.time });
    if (c.low < p.low && c.low < n.low) out.lows.push({ i, price: c.low, time: c.time });
  }
  return out;
}

/** Structure verdict from the last two swing highs + lows. */
function structureVerdict(swings) {
  const h = swings.highs.slice(-2);
  const l = swings.lows.slice(-2);
  if (h.length < 2 || l.length < 2) return { label: 'insufficient data', dir: 0 };
  const hh = h[1].price > h[0].price;
  const hl = l[1].price > l[0].price;
  if (hh && hl) return { label: 'HH + HL — uptrend structure', dir: 1 };
  if (!hh && !hl) return { label: 'LH + LL — downtrend structure', dir: -1 };
  if (hh && !hl) return { label: 'expansion (range widen)', dir: 0 };
  return { label: 'contraction (coil)', dir: 0 };
}

// ------------------------------------------------------------
// Candle-quality read — the "candles ko ache se samajho" layer
// ------------------------------------------------------------
function candleQuality(candles, n = 3) {
  const last = candles.slice(-n);
  if (!last.length) return null;
  let bodySum = 0, rangeSum = 0, bullCount = 0, closePosSum = 0;
  for (const c of last) {
    const range = Math.max(1e-9, (c.high ?? 0) - (c.low ?? 0));
    const body = Math.abs((c.close ?? 0) - (c.open ?? 0));
    bodySum += body; rangeSum += range;
    if ((c.close ?? 0) >= (c.open ?? 0)) bullCount++;
    closePosSum += range > 0 ? ((c.close ?? 0) - (c.low ?? 0)) / range : 0.5;
  }
  const bodyPct = rangeSum > 0 ? Math.round((bodySum / rangeSum) * 100) : null;
  const closePos = Math.round((closePosSum / last.length) * 100);
  const dir = bullCount >= 2 ? 1 : bullCount === 0 ? -1 : 0;
  return { bars: last.length, bodyPct, closePos, dir };
}

// ------------------------------------------------------------
// ANALYSIS TF read (15m intraday / 1h swing) — the bias boss
// ------------------------------------------------------------
export function readAnalysisTf(candles, market) {
  if (!Array.isArray(candles) || candles.length < 50) return null;
  const ind = computeIndicatorsFromCandles(candles);
  if (!ind || !(ind.ltp > 0)) return null;
  const last = candles[candles.length - 1];
  const close = ind.ltp;

  const ema20 = num(ind.ema20), ema50 = num(ind.ema50), ema100 = num(ind.ema100);
  const rsiV = num(ind.rsi);
  const adxObj = ind.adx && typeof ind.adx === 'object' ? ind.adx : {};
  const adxV = num(adxObj.adx) ?? num(ind.adx);
  const plusDI = num(adxObj.plusDI), minusDI = num(adxObj.minusDI);
  const macdHist = num(ind.macd?.hist);
  const supDir = ind.supertrend && Number.isFinite(ind.supertrend.direction) ? ind.supertrend.direction : 0;
  const a = num(ind.atr);
  const vwapV = num(ind.vwap);
  const rocV = num(ind.roc);

  // trend: EMA stack + price position — STRICT three-way (flat/equal → 0,
  // v21.15.0 fix: `a > b ? 1 : -1` equality par bhi -1 de deta tha aur
  // ek dead/flat series ko BEARISH bana deta tha)
  let trendDir = 0;
  if (ema20 != null && ema50 != null) trendDir += ema20 > ema50 ? 1 : ema20 < ema50 ? -1 : 0;
  if (ema50 != null && ema100 != null) trendDir += ema50 > ema100 ? 1 : ema50 < ema100 ? -1 : 0;
  if (ema20 != null) trendDir += close > ema20 ? 0.5 : close < ema20 ? -0.5 : 0;
  trendDir = clamp(trendDir, -2.5, 2.5);

  // structure
  const swings = findSwings(candles, 44);
  const struct = structureVerdict(swings);

  // key levels — last swing high/low (the levels the action TF trades against)
  const keyHigh = swings.highs.length ? swings.highs[swings.highs.length - 1].price : Math.max(...candles.slice(-20).map(c => c.high));
  const keyLow = swings.lows.length ? swings.lows[swings.lows.length - 1].price : Math.min(...candles.slice(-20).map(c => c.low));

  // momentum + strength components
  const momoDir = (rsiV != null ? (rsiV > 52 ? 1 : rsiV < 48 ? -1 : 0) : 0)
    + (macdHist != null ? (macdHist > 0 ? 1 : -1) : 0)
    + (rocV != null ? (rocV > 0.05 ? 1 : rocV < -0.05 ? -1 : 0) : 0);

  const candleQ = candleQuality(candles, 3);

  // v21.16.0 SUPERINTEL INPUTS — SMC supply/demand proximity + tape
  // stats + HONEST ATR%-of-price (ind.atrPct ek PERCENTILE rank hai,
  // % nahi — superIntel exitClock ko % chahiye, isliye alag field)
  const smcZones = ind.supplyDemand || null;
  const priceAction = ind.priceAction || null;
  const atrPctOfPrice = (a != null && close > 0) ? r2((a / close) * 100) : null;

  // ---- bias verdict (weighted) ----
  // trend ×2.0 | structure ×1.5 | momentum ×1.2 | supertrend ×0.8 | DI ×0.5
  let vote = trendDir * 2.0 + struct.dir * 1.5 + clamp(momoDir, -3, 3) * 1.2 + supDir * 0.8;
  if (plusDI != null && minusDI != null) vote += (plusDI > minusDI ? 0.5 : -0.5);
  // ADX scaling — chop me vote half (sirf aligned TF count kaafi nahi,
  // STRENGTH bhi chahiye — yahi accuracy ka asli raaz hai)
  const adxScale = adxV != null ? clamp(0.55 + adxV / 60, 0.55, 1.45) : 1.0;
  vote = vote * adxScale;

  const bias = vote >= 1.4 ? 'BULLISH' : vote <= -1.4 ? 'BEARISH' : 'NEUTRAL';
  const strength = Math.round(clamp(Math.abs(vote) / 5.5, 0, 1) * 100);

  const reasons = [];
  if (ema20 != null && ema50 != null) reasons.push(ema20 > ema50 ? `EMA20>EMA50 (trend up)` : `EMA20<EMA50 (trend down)`);
  if (struct.dir !== 0) reasons.push(struct.label);
  if (rsiV != null) reasons.push(`RSI ${Math.round(rsiV)}`);
  if (adxV != null) reasons.push(`ADX ${Math.round(adxV)}${adxV < 18 ? ' (chop — size down)' : adxV > 25 ? ' (trending)' : ''}`);
  if (macdHist != null && macdHist !== 0) reasons.push(macdHist > 0 ? 'MACD hist +' : 'MACD hist −');
  if (supDir !== 0) reasons.push(`Supertrend ${supDir > 0 ? 'long' : 'short'}`);
  if (candleQ) reasons.push(`last ${candleQ.bars} candles: ${candleQ.bodyPct ?? '—'}% body, close @ ${candleQ.closePos}% of range (${candleQ.dir > 0 ? 'bull' : candleQ.dir < 0 ? 'bear' : 'mixed'})`);

  // candle-read narrative (Hinglish, the "samajh" layer)
  let candleReadNote = 'mixed candles — koi clear control nahi';
  if (candleQ) {
    if (candleQ.dir > 0 && (candleQ.closePos ?? 50) >= 65) candleReadNote = `${candleQ.bars} bull candles, close range ke upper side — buyers in control`;
    else if (candleQ.dir < 0 && (candleQ.closePos ?? 50) <= 35) candleReadNote = `${candleQ.bars} bear candles, close range ke lower side — sellers in control`;
    else if ((candleQ.bodyPct ?? 0) < 35) candleReadNote = 'chhoti bodies, lambi wicks — indecision / stop-hunt zone';
    else if (candleQ.dir > 0) candleReadNote = 'bull candles par close weak — follow-through missing';
    else if (candleQ.dir < 0) candleReadNote = 'bear candles par bounce attempts — pressure build ho raha hai';
  }

  // freshness of the analysis series itself
  const lastTime = Number(last?.time) || 0;
  return {
    tf: null, // filled by caller (mode-specific)
    bias, strength, vote: Math.round(vote * 10) / 10,
    trend: { dir: trendDir > 0.5 ? 1 : trendDir < -0.5 ? -1 : 0, ema20: num(ema20), ema50: num(ema50), ema100: ema100 != null ? num(ema100) : null, label: trendDir >= 1.5 ? 'strong up stack' : trendDir > 0 ? 'mild up stack' : trendDir <= -1.5 ? 'strong down stack' : trendDir < 0 ? 'mild down stack' : 'flat stack' },
    structure: { label: struct.label, dir: struct.dir, keyHigh: num(keyHigh), keyLow: num(keyLow) },
    momentum: { rsi: rsiV != null ? Math.round(rsiV * 10) / 10 : null, macdHist, roc: rocV },
    strengthAdx: { adx: adxV != null ? Math.round(adxV * 10) / 10 : null, plusDI, minusDI },
    supertrendDir: supDir,
    vwap: vwapV != null ? r2(vwapV) : null,
    poc: ind.volumeProfile && Number.isFinite(ind.volumeProfile?.poc) ? num(ind.volumeProfile.poc) : null,
    atr: a != null ? (market === 'CRYPTO' ? r2(a) : r2(a)) : null,
    atrPct: num(ind.atrPct),
    candleQuality: candleQ,
    candleReadNote,
    smc: smcZones ? {
      demand: smcZones.demand ? { top: num(smcZones.demand.top), bottom: num(smcZones.demand.bottom), fresh: !!smcZones.demand.fresh, nearPct: num(smcZones.demand.nearPct), inZone: !!smcZones.demand.inZone } : null,
      supply: smcZones.supply ? { top: num(smcZones.supply.top), bottom: num(smcZones.supply.bottom), fresh: !!smcZones.supply.fresh, nearPct: num(smcZones.supply.nearPct), inZone: !!smcZones.supply.inZone } : null,
    } : null,
    priceAction: priceAction ? {
      clv: num(priceAction.clv), bodyRatio: num(priceAction.bodyRatio),
      upBars: priceAction.upBars ?? null, downBars: priceAction.downBars ?? null,
      rangePositionPct: num(priceAction.rangePositionPct), trendBias: priceAction.trendBias ?? 0,
    } : null,
    atrPctOfPrice,
    lastTime,
    reasons,
  };
}

// ------------------------------------------------------------
// ACTION TF read (5m intraday / 15m swing) — the timing trigger
// ------------------------------------------------------------
export function buildActionPlan(actionCandles, analysis, market, cfg) {
  if (!Array.isArray(actionCandles) || actionCandles.length < 40) return null;
  const ind = computeIndicatorsFromCandles(actionCandles);
  if (!ind || !(ind.ltp > 0)) return null;
  const close = ind.ltp;
  const ema20 = num(ind.ema20), ema50 = num(ind.ema50);
  const rsiV = num(ind.rsi);
  const macdHist = num(ind.macd?.hist);
  const a = atrOf(actionCandles, 14);
  if (!(a > 0) || ema20 == null || ema50 == null) return null;
  const avgVol20 = actionCandles.slice(-20).reduce((s, c) => s + (c.volume || 0), 0) / 20;
  const lastVol = actionCandles[actionCandles.length - 1].volume || 0;
  const volRatio = avgVol20 > 0 ? lastVol / avgVol20 : null;
  const lastCandle = actionCandles[actionCandles.length - 1];
  const bullBar = (lastCandle.close ?? 0) >= (lastCandle.open ?? 0);

  const bias = analysis?.bias || 'NEUTRAL';
  const side = bias === 'BULLISH' ? 'LONG' : bias === 'BEARISH' ? 'SHORT' : null;
  if (!side) {
    return {
      tf: cfg.actionTf, trigger: null, state: 'NO-BIAS', triggerNote: 'analysis TF neutral — koi side nahi',
      rsi: rsiV != null ? Math.round(rsiV * 10) / 10 : null, macdHist, volRatio: volRatio != null ? r2(volRatio) : null,
      entry: null, entryZone: null, stopLoss: null, target1: null, target2: null, rr: null, riskPct: null,
      timing: { quality: 'N/A', note: 'no bias' },
    };
  }
  const long = side === 'LONG';

  // ---- LTF regime (conflict check) — three-way (flat → 0) ----
  const ltfTrendDir = (ema20 > ema50 ? 1 : ema20 < ema50 ? -1 : 0) + (close > ema20 ? 0.5 : close < ema20 ? -0.5 : 0);
  const ltfBearish = ltfTrendDir <= -1 && (rsiV != null && rsiV < 46);
  const ltfBullish = ltfTrendDir >= 1 && (rsiV != null && rsiV > 54);
  const conflict = long ? ltfBearish : ltfBullish;

  // ---- trigger ladder ----
  // 1) PULLBACK — price action-TF EMA20 ke paas lauta hai (1.0×ATR
  //    band) aur reversal/hold candle band hui. Best risk entry.
  // 2) BREAKOUT — analysis-TF key level tod + volume confirm.
  // 3) MOMENTUM-CROSS — MACD hist fresh flip + RSI zone + trend side.
  let trigger = null, triggerNote = '', entry = null, zoneLo = null, zoneHi = null, slBasis = null;

  const nearEma = Math.abs(close - ema20) <= 1.0 * a;
  const emaHold = long ? (close >= ema20 || (bullBar && Math.abs(close - ema20) <= 1.0 * a)) : (close <= ema20 || (!bullBar && Math.abs(close - ema20) <= 1.0 * a));
  const keyHigh = analysis?.structure?.keyHigh, keyLow = analysis?.structure?.keyLow;

  if (nearEma && emaHold) {
    trigger = 'PULLBACK';
    triggerNote = long
      ? `5m pullback EMA20 (${px(ema20, market)}) tak lauta, hold candle — entry zone me aa gaye`
      : `5m pullback EMA20 (${px(ema20, market)}) tak lauta, rejection candle — entry zone me aa gaye`;
    entry = close;
    zoneLo = close - 0.35 * a; zoneHi = close + 0.35 * a;
  } else if (keyHigh != null && keyLow != null && ((long && close > keyHigh && (close - keyHigh) < 1.2 * a) || (!long && close < keyLow && (keyLow - close) < 1.2 * a))) {
    const volOk = volRatio == null || volRatio >= 1.15;
    trigger = 'BREAKOUT';
    triggerNote = long
      ? `${cfg.analysisTf} swing-high (${px(keyHigh, market)}) break${volOk ? ' + volume confirm' : ' (volume thin — caution)'}`
      : `${cfg.analysisTf} swing-low (${px(keyLow, market)}) break${volOk ? ' + volume confirm' : ' (volume thin — caution)'}`;
    entry = long ? keyHigh : keyLow;
    zoneLo = entry - 0.3 * a; zoneHi = entry + 0.3 * a;
  } else {
    // momentum-cross: hist sign flipped in last 3 bars
    const closes = actionCandles.map(c => c.close);
    const hist3 = macdSeriesHist(actionCandles);
    const freshFlip = hist3 ? (long ? hist3.flippedUp : hist3.flippedDown) : false;
    const rsiZone = long ? (rsiV != null && rsiV > 52 && rsiV < 72) : (rsiV != null && rsiV < 48 && rsiV > 28);
    const trendSide = long ? close > ema20 : close < ema20;
    if (freshFlip && rsiZone && trendSide) {
      trigger = 'MOMENTUM-CROSS';
      triggerNote = `${cfg.actionTf} MACD hist fresh ${long ? 'up' : 'down'}-flip + RSI ${rsiV != null ? Math.round(rsiV) : '—'} zone me — momentum shuru`;
      entry = close;
      zoneLo = close - 0.35 * a; zoneHi = close + 0.35 * a;
    }
  }

  // ---- WAIT / CONFLICT states (trigger na mile to honest patience) ----
  if (!trigger && !conflict) {
    const ext = long ? (close - ema20) / a : (ema20 - close) / a;
    if (ext > 2.5) triggerNote = `price EMA20 se ${ext.toFixed(1)}×ATR extend — pullback ka wait karo (chase mat karo)`;
    else if (ext < -1.0) triggerNote = `${cfg.actionTf} abhi EMA20 ke against — settle hone do`;
    else triggerNote = `${cfg.actionTf} trigger abhi arm nahi hua — level pe patience`;
  }
  if (conflict) {
    // v21.16.0: CONFLICT = timing BLOCKED — pehle default 'GOOD'
    // reh jata tha jo confluenceScore me +10 dishonestly jodta tha
    // (auto-link ke liye ye fire nahi hona chahiye tha)
    triggerNote = `${cfg.actionTf} trend analysis-TF ke AGAINST hai — counter-trade mat karo, wait karo flip ka`;
  }

  // ---- SL / TP blueprint (sirf trigger par — WAIT par levels nahi) ----
  let stopLoss = null, target1 = null, target2 = null, rr = null, riskPct = null, slBasisNote = null;
  if (trigger && !conflict) {
    // action-TF swing (last 10 bars) + 0.35×ATR buffer — the "structure stop"
    const swings = findSwings(actionCandles, 12);
    const swingLow = swings.lows.length ? swings.lows[swings.lows.length - 1].price : Math.min(...actionCandles.slice(-10).map(c => c.low));
    const swingHigh = swings.highs.length ? swings.highs[swings.highs.length - 1].price : Math.max(...actionCandles.slice(-10).map(c => c.high));
    if (long) {
      stopLoss = Math.min(swingLow - 0.35 * a, (entry ?? close) - 0.9 * a);
      slBasisNote = `${cfg.actionTf} swing-low ${px(swingLow, market)} − 0.35×ATR buffer`;
    } else {
      stopLoss = Math.max(swingHigh + 0.35 * a, (entry ?? close) + 0.9 * a);
      slBasisNote = `${cfg.actionTf} swing-high ${px(swingHigh, market)} + 0.35×ATR buffer`;
    }
    const risk = Math.abs((entry ?? close) - stopLoss);
    if (risk > 0) {
      target1 = long ? (entry ?? close) + 1.5 * risk : (entry ?? close) - 1.5 * risk;
      target2 = long ? (entry ?? close) + 2.5 * risk : (entry ?? close) - 2.5 * risk;
      rr = 2.5;
      riskPct = r2((risk / (entry ?? close)) * 100);
    }
    // honest note: TP1 time-window me realistic hai?
    const barsInWindow = Math.max(1, Math.round(cfg.holdWindowMin[1] / cfg.actionTfMin));
    const reach = risk * 1.5 / (a * Math.sqrt(barsInWindow));
    if (reach > 1.6) slBasisNote += ` · note: TP1 ambitious for ${cfg.holdWindowMin[0]}-${cfg.holdWindowMin[1]}min window (needs ${(reach).toFixed(1)}× ATR-move)`;
  }

  // ---- entry timing quality (RSI gate — chase protection) ----
  // v21.16.0: CONFLICT → 'BLOCKED' (v21.15 me default 'GOOD' reh jata
  // tha — dishonest +10 confluence points counter-trend signal par)
  let timing = conflict
    ? { quality: 'BLOCKED', note: 'entry blocked — counter-trend conflict' }
    : { quality: 'GOOD', note: 'timing theek hai' };
  if (trigger && !conflict) {
    if (long) {
      if (rsiV != null && rsiV > 74) timing = { quality: 'POOR', note: `RSI ${Math.round(rsiV)} — overbought chase, entry me pullback expect karo` };
      else if (rsiV != null && rsiV > 66) timing = { quality: 'CAUTION', note: `RSI ${Math.round(rsiV)} — thoda garam, chhota pullback possible` };
    } else {
      if (rsiV != null && rsiV < 26) timing = { quality: 'POOR', note: `RSI ${Math.round(rsiV)} — oversold bounce risk` };
      else if (rsiV != null && rsiV < 34) timing = { quality: 'CAUTION', note: `RSI ${Math.round(rsiV)} — bounce possible` };
    }
  }

  const state = conflict ? 'CONFLICT' : trigger ? 'ARMED' : 'WAIT';
  return {
    tf: cfg.actionTf, trigger, state, triggerNote,
    rsi: rsiV != null ? Math.round(rsiV * 10) / 10 : null, macdHist, volRatio: volRatio != null ? r2(volRatio) : null,
    entry: entry != null ? px(entry, market) : null,
    entryZone: zoneLo != null ? [px(zoneLo, market), px(zoneHi, market)] : null,
    stopLoss: stopLoss != null ? px(stopLoss, market) : null,
    target1: target1 != null ? px(target1, market) : null,
    target2: target2 != null ? px(target2, market) : null,
    rr, riskPct, slBasis: slBasisNote,
    timing,
    barsInWindow: Math.max(1, Math.round(cfg.holdWindowMin[1] / cfg.actionTfMin)),
  };
}

/** MACD histogram flip check over the last 3 bars (pure helper).
 *  v21.16.0 FIX: emaSeries() null-warmup arrays return karta hai —
 *  pehla code `f[i] - s[i]` 0..25 index par null−null=0 / num−null=num
 *  coerce karta tha (garbage line + contaminated EMA(9) signal).
 *  Ab sirf VALID overlap region (i ≥ 25) par compute hota hai. */
function macdSeriesHist(candles) {
  try {
    const closes = candles.map(c => c.close);
    if (closes.length < 40) return null;
    const f = emaSeries(closes, 12), s = emaSeries(closes, 26);
    if (!f || !s) return null;
    // valid overlap: dono EMAs defined (26-period EMA first valid at i=25)
    const line = [];
    for (let i = 25; i < closes.length; i++) {
      if (f[i] == null || s[i] == null) continue;
      line.push(f[i] - s[i]);
    }
    if (line.length < 14) return null;
    const sig = emaSeries(line, 9);
    if (!sig) return null;
    const hist = [];
    for (let i = 0; i < line.length; i++) {
      if (sig[i] == null) continue;
      hist.push(line[i] - sig[i]);
    }
    const h3 = hist.slice(-4);
    if (h3.length < 4) return null;
    return {
      flippedUp: h3[0] <= 0 && h3[3] > 0,
      flippedDown: h3[0] >= 0 && h3[3] < 0,
      last: hist[hist.length - 1],
    };
  } catch { return null; }
}

// ------------------------------------------------------------
// Confluence score — TF ALIGNMENT se accuracy (count se nahi)
// ------------------------------------------------------------
function confluenceScore(analysis, action, cfg) {
  let score = 0;
  const bias = analysis?.bias;
  if (bias === 'NEUTRAL' || !bias) return 0;
  // v21.16.0: CONFLICT = 0 — counter-trend setup ko kabhi bhi score
  // nahi milta (auto-link 75+ bar ke liye ye hard gate hai)
  if (action?.state === 'CONFLICT') return 0;
  const long = bias === 'BULLISH';
  const dirMult = long ? 1 : -1;

  // 1. analysis strength (0-40) — trend+structure+momentum power
  score += clamp((analysis.strength / 100) * 40, 0, 40);

  // 2. ADX regime (0-15) — trending market me hi MTF edge hota hai
  const adx = analysis.strengthAdx?.adx;
  if (adx != null) score += adx >= 25 ? 15 : adx >= 18 ? 9 : 3;

  // 3. action trigger (0-25) — ARMED full, WAIT partial, CONFLICT zero
  if (action?.state === 'ARMED') score += action.trigger === 'PULLBACK' ? 25 : action.trigger === 'BREAKOUT' ? 22 : 18;
  else if (action?.state === 'WAIT') score += 6;

  // 4. timing quality (0-10)
  const q = action?.timing?.quality;
  score += q === 'GOOD' ? 10 : q === 'CAUTION' ? 5 : q === 'POOR' ? 0 : 3;

  // 5. candle-quality agreement (0-10) — analysis TF candles bhi side me
  const cq = analysis.candleQuality;
  if (cq && cq.dir === dirMult && (cq.closePos ?? 50) >= 60) score += 10;
  else if (cq && cq.dir === dirMult) score += 5;

  return Math.round(clamp(score, 0, 100));
}

// ------------------------------------------------------------
// v21.16.0 SUPERINTELLIGENCE LAYER 1 — the 7-factor expert score
// (superIntel.intradayExpertFactors ka MTF twin — yahan HUMARE
// paas real indicator reads hain: ADX/trend/RSI/volRatio/ATR%/
// SMC-zones/R:R — koi SMC-abstain nahi, sab GRADED)
// ------------------------------------------------------------
export function mtfExpertFactors(analysis, action, cfg) {
  if (!analysis) return null;
  const long = analysis.bias === 'BULLISH';
  const sgn = long ? 1 : -1;
  const atrPct = analysis.atrPctOfPrice ?? null;

  // 1. TREND — ADX strength + EMA stack + structure dir (0-100)
  const adx = analysis.strengthAdx?.adx ?? null;
  let trend = 50;
  if (adx != null) trend += adx >= 28 ? 24 : adx >= 22 ? 15 : adx >= 16 ? 4 : -14;
  const stack = analysis.trend?.label || '';
  if (stack.includes('strong')) trend += 12; else if (stack.includes('mild')) trend += 5; else if (stack === 'flat stack') trend -= 8;
  trend += sgn * (analysis.structure?.dir ?? 0) * 8;
  trend = clamp(trend, 0, 100);

  // 2. MOMENTUM — action-TF RSI sweet-zone + analysis RSI side (0-100)
  const rsiAct = action?.rsi ?? null, rsiAna = analysis.momentum?.rsi ?? null;
  let momentum = 50;
  if (rsiAct != null) {
    if (long ? (rsiAct >= 52 && rsiAct <= 70) : (rsiAct >= 30 && rsiAct <= 48)) momentum += 22;
    else if (long ? rsiAct > 76 : rsiAct < 24) momentum -= 16;
    else momentum -= 4;
  }
  if (rsiAna != null) {
    if (long ? rsiAna > 52 : rsiAna < 48) momentum += 10;
    else if (long ? rsiAna < 45 : rsiAna > 55) momentum -= 8;
  }
  if ((analysis.momentum?.macdHist ?? 0) * sgn > 0) momentum += 8;
  momentum = clamp(momentum, 0, 100);

  // 3. VOLUME — action-TF relative volume (0-100)
  const vr = action?.volRatio ?? null;
  let volume = 50;
  if (vr != null) {
    if (vr >= 2.0) volume += 32; else if (vr >= 1.5) volume += 24; else if (vr >= 1.2) volume += 14;
    else if (vr >= 0.9) volume += 4; else volume -= 14;
  }
  volume = clamp(volume, 0, 100);

  // 4. SMC / ICT — supply-demand zone proximity (REAL zones, 0-100)
  //    LONG: fresh demand zone ke paas/under = premium; supply me = penalty
  let smc = 50;
  const z = analysis.smc;
  if (z) {
    const near = long ? z.demand : z.supply;    // supportive zone
    const against = long ? z.supply : z.demand; // opposing zone
    if (near?.inZone) smc += near.fresh ? 28 : 18;
    else if (near?.nearPct != null && near.nearPct <= 1.2) smc += 12;
    if (against?.inZone) smc -= 20;
    else if (against?.nearPct != null && against.nearPct <= 0.8) smc -= 8;
  }
  if (analysis.poc != null && analysis.atr != null) {
    const keyLow = analysis.structure?.keyLow, keyHigh = analysis.structure?.keyHigh;
    if (keyLow != null && keyHigh != null && keyHigh > keyLow) {
      const pos = (keyHigh + keyLow) / 2; // midpoint
      const above = analysis.poc > pos;
      if (long === above) smc += 6; else smc -= 4;
    }
  }
  smc = clamp(smc, 0, 100);

  // 5. VOLATILITY — ATR% rideable for the hold window (0-100)
  let volatility = 50;
  if (atrPct != null) {
    // intraday 15-20min / swing 60-90min window ke liye rideable band:
    // intraday sweet 0.35-1.2% · swing sweet 0.6-2.2% (per action-TF ATR)
    const lo = cfg.analysisTfMin >= 60 ? 0.6 : 0.35;
    const hi = cfg.analysisTfMin >= 60 ? 2.2 : 1.2;
    if (atrPct >= lo && atrPct <= hi) volatility += 20;
    else if (atrPct > hi * 2) volatility -= 18;   // over-heated — SL hunt
    else if (atrPct < lo * 0.4) volatility -= 10; // dead — TP window me move hi nahi
  }
  if (analysis.atrPct != null) {
    // percentile-rank (0-100): >85 = abnormally volatile vs history
    if (analysis.atrPct > 85) volatility -= 6;
    else if (analysis.atrPct < 15) volatility -= 4;
  }
  volatility = clamp(volatility, 0, 100);

  // 6. REGIME — analysis-TF vote power (board ka apna regime proxy)
  let regime = 50;
  const vote = analysis.vote ?? 0;
  if (vote * sgn >= 2.5) regime += 24; else if (vote * sgn >= 1.4) regime += 14;
  else if (vote * sgn <= -1.4) regime -= 18;
  if ((analysis.supertrendDir ?? 0) === sgn) regime += 8;
  regime = clamp(regime, 0, 100);

  // 7. R:R — risk geometry of the actual plan (0-100)
  let rr = 50;
  if (action?.rr != null && action.riskPct != null) {
    if (action.rr >= 2.2) rr += 30; else if (action.rr >= 1.8) rr += 22; else rr += 6;
    if (action.riskPct <= (cfg.analysisTfMin >= 60 ? 1.2 : 0.9)) rr += 10;   // tight risk = geometry fit
    else if (action.riskPct > (cfg.analysisTfMin >= 60 ? 3.5 : 2.2)) rr -= 16; // wide risk = window-miss
  }
  rr = clamp(rr, 0, 100);

  const W = { trend: 0.24, momentum: 0.18, volume: 0.14, smc: 0.12, volatility: 0.12, regime: 0.12, rr: 0.08 };
  const sc = Math.round(clamp(
    W.trend * trend + W.momentum * momentum + W.volume * volume + W.smc * smc
    + W.volatility * volatility + W.regime * regime + W.rr * rr, 0, 100));
  return {
    score: sc, atrPct,
    factors: [
      { key: 'trend', label: 'Trend Structure', value: Math.round(trend), weight: W.trend },
      { key: 'momentum', label: 'Momentum Zone', value: Math.round(momentum), weight: W.momentum },
      { key: 'volume', label: 'Volume Flow', value: Math.round(volume), weight: W.volume },
      { key: 'smc', label: 'SMC Zones', value: Math.round(smc), weight: W.smc },
      { key: 'volatility', label: 'Volatility Fit', value: Math.round(volatility), weight: W.volatility },
      { key: 'regime', label: 'Bias Regime', value: Math.round(regime), weight: W.regime },
      { key: 'rr', label: 'R:R Geometry', value: Math.round(rr), weight: W.rr },
    ],
  };
}

// ------------------------------------------------------------
// v21.16.0 SUPERINTELLIGENCE LAYER 2 — quality verdict flags
// (superIntel.computeSuperScore ke `quality` contract ke saath)
// ------------------------------------------------------------
export function mtfQualityFlags(analysis, action, cfg, stale) {
  // extension veto — honest version: PULLBACK trigger near-EMA par hi
  // hota hai; BREAKOUT key-level ke 1.2×ATR andar; overextension
  // board WAIT-note me already khud bata deta hai ("chase mat karo").
  // Veto sirf tab jab entry-timing khud POOR grade ho (RSI exhaustion).
  const timingQ = action?.timing?.quality;
  const extensionVeto = timingQ === 'POOR';
  return {
    extension: { veto: extensionVeto, note: extensionVeto ? 'entry-timing POOR (RSI exhaustion zone) — score capped' : 'timing ok' },
    session: { tradeable: !stale, note: stale ? 'candle data stale — session closed lagta hai' : 'fresh data' },
    mtf: { available: true, aligned: action?.state === 'ARMED' },
    quorumCapped: false,
  };
}

// ------------------------------------------------------------
// v21.16.0 SUPERINTELLIGENCE — composite super score per signal
// ------------------------------------------------------------
function superLayer(analysis, action, cfg, score, stale) {
  const expert = mtfExpertFactors(analysis, action, cfg);
  const quality = mtfQualityFlags(analysis, action, cfg, stale);
  // state-aware HARD CAP — auto-link bar (75+) sirf ARMED + fresh signals
  // ke liye reachable hai. WAIT = watch-only (70 cap). CONFLICT/NO-BIAS
  // = 40 cap. Ye BY CONSTRUCTION guarantee hai, weighted-luck nahi.
  let cap = null;
  if (action?.state === 'WAIT') cap = 70;
  else if (action?.state === 'CONFLICT' || action?.state === 'NO-BIAS' || !action) cap = 40;
  else if (stale) cap = 65; // stale ARMED — dekha jaa sakta hai, trade nahi
  const sup = computeSuperScore({
    engineConf: score,
    expertScore: expert?.score ?? null,
    aiConf: null,                     // no LLM on this path — honest
    quality,
    cap,
  });
  const tier = superTier(sup.aiScore);
  const autoEligible = action?.state === 'ARMED'
    && sup.aiScore >= MTF_AUTO_BAR
    && !stale
    && action?.entry != null && action?.stopLoss != null && action?.target1 != null;
  const autoBlockReason = autoEligible ? null
    : action?.state !== 'ARMED' ? `state ${action?.state ?? '—'} — sirf ARMED signals auto-link hote hain`
    : stale ? 'data stale (session band)'
    : sup.aiScore < MTF_AUTO_BAR ? `super score ${sup.aiScore} < ${MTF_AUTO_BAR} bar`
    : 'entry/SL/TP1 blueprint incomplete';
  return { ...sup, tier, expert, quality, autoEligible, autoBlockReason };
}

// ------------------------------------------------------------
// Per-symbol signal builder (async — candle fetch + pure reads)
// ------------------------------------------------------------
export async function buildMtfBoardSignal(symbol, market, modeKey, opts = {}) {
  const sym = String(symbol || '').trim().toUpperCase();
  const mkt = String(market || 'INDIA').toUpperCase() === 'CRYPTO' ? 'CRYPTO' : 'INDIA';
  const cfg = MTF_MODES[modeKey] || MTF_MODES.intraday;
  if (!sym) return null;

  const [analysisCandles, actionCandles] = await Promise.all([
    rawTfCandles(sym, mkt, cfg.analysisTf).catch(() => null),
    rawTfCandles(sym, mkt, cfg.actionTf).catch(() => null),
  ]);
  if (!Array.isArray(analysisCandles) || analysisCandles.length < 50) return null;

  const analysis = readAnalysisTf(analysisCandles, mkt);
  if (!analysis) return null;
  analysis.tf = cfg.analysisTf;

  const action = buildActionPlan(actionCandles, analysis, mkt, cfg);

  // LTP + change% from the analysis series (honest, candle-derived)
  const closes = analysisCandles.map(c => c.close);
  const ltp = closes[closes.length - 1];
  const prevClose = closes.length > Math.max(1, Math.round(cfg.analysisTfMin >= 60 ? 1 : 4)) ? closes[closes.length - (cfg.analysisTfMin >= 60 ? 2 : 5)] : closes[0];
  const changePct = prevClose > 0 ? ((ltp - prevClose) / prevClose) * 100 : null;

  // staleness — analysis candle age vs 3× TF width (market-closed honest note)
  const lastTime = Number(analysisCandles[analysisCandles.length - 1]?.time) || 0;
  const ageMs = lastTime ? Date.now() - lastTime : Infinity;
  const stale = ageMs > cfg.analysisTfMin * 60_000 * 3 + 5 * 60_000;

  const score = confluenceScore(analysis, action, cfg);
  const side = analysis.bias === 'BULLISH' ? 'LONG' : analysis.bias === 'BEARISH' ? 'SHORT' : null;

  // v21.16.0 SUPERINTELLIGENCE — composite score + tier + expert
  // factors + quality flags + auto-link eligibility (mtfAutoEntry.js
  // isko consume karta hai)
  const sup = superLayer(analysis, action, cfg, score, stale);

  // v21.16.0 SUPER BLUEPRINT — ARMED signals ke liye staged-exit
  // pro-trader ticket (T1 40% + BE-lock / T2 40% / runner 20% trail).
  // NOTE: blueprint ACTION-plan ke EXACT levels par build hota hai
  // (entry = trigger level, T1/T2 = card wale hi) — optionsAutoEntry
  // ki "card plan ke EXACT displayed levels" discipline. LTP sirf
  // blueprint null-path ka fallback hai.
  const blueprint = (action?.state === 'ARMED' && action?.entry != null && action?.stopLoss != null && action?.target1 != null && ltp > 0)
    ? buildSuperBlueprint({
        side: side || 'LONG', ltp: action.entry, atr: analysis.atr, aiScore: sup.aiScore, market: mkt,
        ema20: analysis.trend?.ema20 ?? null,
        entryZoneLow: action.entryZone?.[0] ?? null, entryZoneHigh: action.entryZone?.[1] ?? null,
        stopLoss: action.stopLoss, target1: action.target1, target2: action.target2,
        atrPctLtp: analysis.atrPctOfPrice ?? null,
      })
    : null;

  // top-level summary reasons (max 5, UI chips)
  const reasons = [];
  if (analysis.bias !== 'NEUTRAL') reasons.push(`${cfg.analysisTf} bias ${analysis.bias} (${analysis.strength}/100) — ${analysis.candleReadNote}`);
  if (action?.trigger && action.state === 'ARMED') reasons.push(`${cfg.actionTf} ${action.trigger} trigger ARMED — ${action.triggerNote}`);
  else if (action?.state === 'WAIT') reasons.push(`${cfg.actionTf} abhi wait — ${action.triggerNote}`);
  else if (action?.state === 'CONFLICT') reasons.push(`CONFLICT — ${action.triggerNote}`);
  if (action?.slBasis) reasons.push(`SL basis: ${action.slBasis}`);
  if (sup.aiScore >= MTF_AUTO_BAR && action?.state === 'ARMED') reasons.push(`SUPER ${sup.aiScore}/100 (${sup.tier}) — 75+ AUTO-LINK eligible`);
  else if (sup.expert?.score != null && action?.state === 'ARMED') reasons.push(`SUPER ${sup.aiScore}/100 (${sup.tier}) · expert factors ${Math.round(sup.expert.score)}/100`);
  if (stale) reasons.push(`${mkt === 'INDIA' ? 'NSE' : 'market'} data stale (last candle ${(Math.round(ageMs / 60000))}m old) — session closed ho sakti hai`);

  return {
    ok: true, symbol: sym, market: mkt, mode: cfg.key,
    side, state: action?.state || 'NO-BIAS',
    confluenceScore: score, ltp: px(ltp, mkt),
    changePct: changePct != null ? r2(changePct) : null,
    super: {
      aiScore: sup.aiScore, tier: sup.tier, drivers: sup.drivers,
      expertScore: sup.expert?.score ?? null,
      factors: sup.expert?.factors ?? null,
      quality: {
        extensionVeto: sup.quality?.extension?.veto ?? false,
        sessionTradeable: sup.quality?.session?.tradeable ?? true,
        mtfAligned: sup.quality?.mtf?.aligned ?? null,
      },
    },
    autoTrade: {
      eligible: !!sup.autoEligible,
      bar: MTF_AUTO_BAR,
      reason: sup.autoBlockReason,
    },
    analysis: {
      tf: analysis.tf, bias: analysis.bias, strength: analysis.strength,
      trend: analysis.trend, structure: analysis.structure,
      momentum: analysis.momentum, strengthAdx: analysis.strengthAdx,
      supertrendDir: analysis.supertrendDir, vwap: analysis.vwap, poc: analysis.poc,
      atr: analysis.atr, atrPct: analysis.atrPct, atrPctOfPrice: analysis.atrPctOfPrice,
      candleQuality: analysis.candleQuality, candleReadNote: analysis.candleReadNote,
      smc: analysis.smc, priceAction: analysis.priceAction,
      reasons: analysis.reasons,
    },
    action: action ? {
      tf: action.tf, trigger: action.trigger, state: action.state, triggerNote: action.triggerNote,
      entry: action.entry, entryZone: action.entryZone, stopLoss: action.stopLoss,
      target1: action.target1, target2: action.target2, rr: action.rr, riskPct: action.riskPct,
      slBasis: action.slBasis, timing: action.timing, rsi: action.rsi,
      macdHist: action.macdHist, volRatio: action.volRatio, barsInWindow: action.barsInWindow,
    } : null,
    exit: {
      holdWindowMin: cfg.holdWindowMin,
      expectedBars: `${Math.max(1, Math.round(cfg.holdWindowMin[0] / cfg.actionTfMin))}-${Math.max(1, Math.round(cfg.holdWindowMin[1] / cfg.actionTfMin))} bars of ${cfg.actionTf}`,
      timeStopNote: `TP hit na ho to ${cfg.holdWindowMin[1]}min par TIME-EXIT (market close) — intraday me profit gholne mat dena`,
      trailNote: 'TP1 ke baad SL → entry (breakeven) — free trade banao',
    },
    blueprint,
    stale, ts: Date.now(), reasons: reasons.slice(0, 6),
  };
}

// ------------------------------------------------------------
// Board builder — cache + single-flight + honest degrade
// ------------------------------------------------------------
export async function getMtfBoard(market, modeKey = 'intraday', symbols) {
  const mkt = String(market || 'INDIA').toUpperCase() === 'CRYPTO' ? 'CRYPTO' : 'INDIA';
  const cfg = MTF_MODES[modeKey] ? modeKey : 'intraday';
  const key = `${mkt}:${cfg}`;

  const hit = _boardCache.get(key);
  if (hit && Date.now() - hit.at < BOARD_TTL_MS) return hit.payload;
  const inflight = _inflight.get(key);
  if (inflight) return inflight;

  const task = (async () => {
    const universe = Array.isArray(symbols) && symbols.length
      ? symbols.slice(0, 14)
      : (mkt === 'CRYPTO' ? CRYPTO_UNIVERSE.slice(0, 12) : (cfg === 'swing' ? SWING_INDIA_DEFAULT : INTRADAY_INDIA_DEFAULT));

    const settled = await Promise.allSettled(universe.map(s => buildMtfBoardSignal(s, mkt, cfg)));
    const all = settled.map(s => s.status === 'fulfilled' ? s.value : null).filter(Boolean);

    // v21.16.0: sorting ab SUPER score se (confluence + 7-factor expert
    // blend) — auto-link engine bhi isi priority se pick karta hai
    const armed = all.filter(s => s.state === 'ARMED').sort((a, b) => (b.super?.aiScore ?? 0) - (a.super?.aiScore ?? 0));
    const wait = all.filter(s => s.state === 'WAIT').sort((a, b) => (b.super?.aiScore ?? 0) - (a.super?.aiScore ?? 0));
    const conflict = all.filter(s => s.state === 'CONFLICT');
    const noBias = all.filter(s => s.state === 'NO-BIAS');
    const autoReady = armed.filter(s => s.autoTrade?.eligible && (s.super?.aiScore ?? 0) >= MTF_AUTO_BAR && !s.stale);

    // default wire: ARMED pehle (super score desc), phir top WAITs —
    // CONFLICT/NO-BIAS sirf counts me (board clean, honesty meta me)
    const signals = [...armed, ...wait.slice(0, 6)].slice(0, 12);

    const payload = {
      ok: true, market: mkt, mode: cfg,
      modeCfg: {
        label: MTF_MODES[cfg].label,
        analysisTf: MTF_MODES[cfg].analysisTf, actionTf: MTF_MODES[cfg].actionTf,
        analysisNote: MTF_MODES[cfg].analysisNote, actionNote: MTF_MODES[cfg].actionNote,
        holdWindowMin: MTF_MODES[cfg].holdWindowMin,
      },
      generatedAt: Date.now(), scanned: universe.length,
      counts: { armed: armed.length, wait: wait.length, conflict: conflict.length, noBias: noBias.length, autoReady: autoReady.length },
      conflictSymbols: conflict.map(s => s.symbol).slice(0, 8),
      autoReadySymbols: autoReady.map(s => `${s.symbol}:${s.super?.aiScore ?? '—'}`).slice(0, 8),
      autoBar: MTF_AUTO_BAR,
      signals,
      methodology: 'Confluence = ALIGNMENT (bias TF + trigger TF ek direction) — sirf TF count se accuracy nahi, ALIGNED TFs se aati hai. ARMED = trade-ready, WAIT = bias set + trigger pending, CONFLICT = LTF against HTF (no-trade). v21.16 SUPERINTELLIGENCE: har signal ka super score = confluence (engine conviction) + 7-factor expert (trend/momentum/volume/SMC-zones/volatility/regime/R:R) blend — 75+ (STRONG+) ARMED signals paper auto-link eligible; WAIT 70 cap, CONFLICT 0/40 cap (by construction).',
      disclaimer: 'Analysis + paper-trade auto-link — levels blueprint hain, execution guarantee nahi. Auto entries PAPER (virtual) tickets hain. Position size risk-1R rule se karo.',
    };
    _boardCache.set(key, { at: Date.now(), payload });
    while (_boardCache.size > BOARD_CACHE_MAX) {
      const k = _boardCache.keys().next().value;
      if (k === undefined) break;
      _boardCache.delete(k);
    }
    return payload;
  })().finally(() => { _inflight.delete(key); });

  _inflight.set(key, task);
  return task;
}

/** test hook — clear board cache between hermetic cases */
export function __clearMtfBoardCaches() { _boardCache.clear(); _inflight.clear(); }
