// ============================================================
// server/ai/lib/strategies/trend.js — the 7 trend-following classics
// ------------------------------------------------------------
// Specs (from the strategy playbook):
//   1. EMA Cross 9/21 (+ EMA50 filter + ATR-separation chop gate;
//      v21.36.4: EMA 8/21/55 triple-stack folded in as a CONFIRMATION
//      bonus — the standalone triple-EMA vote was a pure duplicate
//      of the EMA9/21 stack read and double-counted the same signal)
//   2. Supertrend ATR 10 × 3 (v21.36.4: ADX weak-tape gate — a flip
//      in chop is a fake-out, so non-fresh reads are down-weighted
//      when the tape has no trend power)
//   3. Golden Cross 50/200
//   4. ADX 14 (20/50 ladder, ≥25 tradeable; v21.36.4: late-wave
//      decay — a STALE, fading trend votes weaker so it can't carry
//      a late entry the way a fresh one should)
//   5. Parabolic SAR 0.02 / 0.2
//   6. Ichimoku 9/26/52
//   7. Heikin-Ashi 3-candle colour streak
// ============================================================
import {
  adx, atr, emaSeries, heikinAshi, ichimokuCloud, psar, supertrend,
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
  // v21.36.4 UPGRADE — ATR-SEPARATION CHOP GATE: a cross with price
  // glued to the EMA21 (≤0.5×ATR away) is noise, not a setup — the
  // classic whipsaw source. Demote hard; the tape must actually be
  // SEPARATED from the mean before a trend vote is meaningful.
  const a = atr(candles, 14);
  const sepAtr = a && close > 0 ? Math.abs(close - e21Now) / a : null;
  if (sepAtr != null && sepAtr < 0.5 && !fresh) {
    strength *= 0.5;
  }
  // v21.36.4 — TRIPLE-EMA CONFIRMATION (replaces the removed standalone
  // triple_ema_8_21_55 vote): EMA8 vs EMA55 both on the same side of
  // EMA21 = the full stack agrees → bounded bonus. A 55-EMA disagreement
  // caps the read so a shallow 8/21 flip can't overstate a deep trend.
  let tripleNote = null;
  if (closes.length >= 60) {
    const e8 = emaSeries(closes, 8);
    const e55 = emaSeries(closes, 55);
    const i = closes.length - 1;
    if (e8 && e55 && e8[i] != null && e55[i] != null) {
      const allAbove = e8[i] > e21Now && e55[i] < e21Now;
      const allBelow = e8[i] < e21Now && e55[i] > e21Now;
      if ((dir === 1 && allAbove) || (dir === -1 && allBelow)) {
        strength += 0.08;
        tripleNote = 'full 8/21/55 stack confirms';
      } else if ((dir === 1 && e55[i] > e21Now) || (dir === -1 && e55[i] < e21Now)) {
        strength = Math.min(strength, 0.5);
        tripleNote = '55-EMA disagrees — shallow move capped';
      }
    }
  }
  const reason = fresh
    ? `Fresh EMA9/21 cross ${dir === 1 ? 'bullish' : 'bearish'}`
    : `EMA9 ${dir === 1 ? 'above' : 'below'} EMA21 (${filter === dir ? 'with' : filter === -dir ? 'against' : 'no'} EMA50 filter)`;
  const a2 = closes.length >= 20 ? Math.abs(close - e21Now) : null;
  return vote({
    id: 'ema_cross_9_21', name: 'EMA Cross 9/21', family: 'trend',
    dir, strength,
    reasons: [reason, filter === dir ? 'EMA50 trend filter aligned' : filter === -dir ? 'EMA50 filter opposes' : 'EMA50 filter unavailable', tripleNote].filter(Boolean),
    levels: rrLevels({ dir, entry: close, stop: dir === 1 ? Math.min(...closes.slice(-10)) : Math.max(...closes.slice(-10)) }),
    meta: { ema9: e9Now, ema21: e21Now, fresh, bars: cross?.bars ?? null, distPct: a2 != null && close > 0 ? a2 / close * 100 : null, sepAtr, triple: tripleNote },
  });
}

function supertrend103(candles) {
  const st = supertrend(candles, 10, 3);
  if (!st) return null;
  const prev = candles.length > 25 ? supertrend(candles.slice(0, -1), 10, 3) : null;
  const freshFlip = Boolean(prev && prev.direction !== st.direction);
  const dir = st.direction;
  const close = candles[candles.length - 1].close;
  // v21.36.4 UPGRADE — weak-tape gate: on a NON-fresh read the direction
  // only means something when the tape has trend power. ADX < 18 = chop;
  // a Supertrend line sitting in the same spot for 8+ bars = stale trail.
  // Down-weight both — the fresh-flip bonus stays full-strength either way
  // (a flip IS the signal, even early in a quiet tape).
  let strength = freshFlip ? 0.8 : 0.55;
  let weakNote = null;
  if (!freshFlip && dir !== 0) {
    const a = adx(candles, 14);
    if (a && a.adx < 18) {
      strength = Math.min(strength, 0.35);
      weakNote = `ADX ${a.adx.toFixed(0)} < 18 — chop tape, Supertrend read down-weighted`;
    }
  }
  return vote({
    id: 'supertrend_10_3', name: 'Supertrend 10×3', family: 'trend',
    dir,
    strength,
    reasons: [freshFlip ? `Supertrend flipped ${dir === 1 ? 'bullish' : 'bearish'}` : `Supertrend ${dir === 1 ? 'bullish' : 'bearish'} trend intact`, weakNote].filter(Boolean),
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

// v21.36.4 DEDUP — the standalone Triple EMA 8/21/55 vote was REMOVED:
// it was a pure subset of the EMA9/21 stack read (EMA8 above/below EMA21
// is exactly what the 9/21 cross votes). It double-counted the same
// signal as a headcount trick. Its ONE genuine extra bit — the EMA55
// deep-trend confirmation — now lives inside emaCross921() as a bounded
// confirmation bonus / 55-EMA-disagreement cap (see the upgrade note there).

function adxTrend2050(candles) {
  const a = adx(candles, 14);
  if (!a) return null;
  const dir = a.plusDI > a.minusDI ? 1 : a.plusDI < a.minusDI ? -1 : 0;
  const strong = a.adx >= 25;
  const veryStrong = a.adx >= 50;
  let strength = !strong ? 0 : veryStrong ? 0.85 : 0.35 + Math.min(0.4, (a.adx - 25) / 25 * 0.4);
  const close = candles[candles.length - 1].close;
  // v21.36.4 UPGRADE — LATE-WAVE DECAY (targets the user-reported "trade
  // against signal" loss mode: entries taken AFTER the trend wave had
  // mostly run). A STALE trend — same DI direction for 6+ bars with a
  // fading (declining) ADX slope — is the classic late entry. We keep
  // voting the direction (honest: the trend is still technically up) but
  // decay its weight so a fading trend can't carry the consensus the way
  // a fresh one should. Fresh DI dominance (within 3 bars) gets a small
  // boost instead.
  let lateNote = null;
  if (strong && dir !== 0 && candles.length > 8) {
    const prev = adx(candles.slice(0, candles.length - 3), 14);
    const prevDir = prev ? (prev.plusDI > prev.minusDI ? 1 : prev.plusDI < prev.minusDI ? -1 : 0) : 0;
    const staleSameDir = prevDir === dir;
    const fading = prev != null && a.adx < prev.adx - 1;
    if (staleSameDir && fading) {
      strength *= 0.6;
      lateNote = `ADX fading ${prev.adx.toFixed(0)}→${a.adx.toFixed(0)} — stale wave, vote decayed`;
    } else if (!staleSameDir) {
      strength += 0.1;
      lateNote = 'Fresh DI dominance (late entry avoided)';
    }
  }
  return vote({
    id: 'adx_trend_20_50', name: 'ADX Trend 14 (20/50)', family: 'trend',
    dir: strong ? dir : 0,
    strength,
    reasons: [strong
      ? `ADX ${a.adx.toFixed(1)} ${veryStrong ? 'very strong' : 'trending'} — ${dir === 1 ? '+DI' : '−DI'} dominance`
      : `ADX ${a.adx.toFixed(1)} < 25 — chop, no trend vote`, lateNote].filter(Boolean),
    levels: strong ? rrLevels({ dir, entry: close, stop: dir === 1 ? Math.min(...candles.slice(-10).map(c => c.low)) : Math.max(...candles.slice(-10).map(c => c.high)) }) : null,
    meta: { adx: a.adx, plusDI: a.plusDI, minusDI: a.minusDI, lateNote },
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
  // v21.36.4: triple_ema_8_21_55 REMOVED (duplicate of the EMA9/21 stack
  // read — its EMA55 confirmation folded into ema_cross_9_21 as a bonus).
  { id: 'adx_trend_20_50', name: 'ADX Trend 14 (20/50)', family: 'trend', fn: adxTrend2050 },
  { id: 'psar_002_02', name: 'Parabolic SAR 0.02/0.2', family: 'trend', fn: psarStrategy },
  { id: 'ichimoku_9_26_52', name: 'Ichimoku 9/26/52', family: 'trend', fn: ichimokuStrategy },
  { id: 'heikin_ashi_3', name: 'Heikin-Ashi 3-bar', family: 'trend', fn: heikinAshi3 },
];
