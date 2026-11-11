// ============================================================
// server/ai/lib/strategies/common.js — shared pure helpers for the
// 25-strategy classic engine (v21.36.4 dedup from 29).
// ------------------------------------------------------------
// Contract: every evaluator receives oldest-first candles and returns
// either `null` (insufficient data — honest abstain, never a fake 0)
// or a vote:
//   { id, name, family, dir: 1|-1|0, strength: 0..1, ready: true,
//     reasons: string[], levels?: object|null, meta?: object }
// `dir: 0` means "evaluated, no setup right now" — still counted in
// readyCount so the UI can distinguish "no setup" from "no data".
// ============================================================
import { atr, emaSeries } from '../indicators.js';

export const clamp01 = (v) => Math.min(1, Math.max(0, Number(v) || 0));
export const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
export const round2 = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 100) / 100 : null);

export function candleTs(c) {
  const raw = Number(c?.ts ?? c?.time ?? c?.t ?? c?.timestamp);
  if (!(raw > 0)) return null;
  return raw < 1e11 ? raw * 1000 : raw;
}

export function closeArr(candles) {
  return candles.map(c => c.close);
}

export function smaSeries(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  const out = new Array(period - 1).fill(null);
  let sum = values.slice(0, period).reduce((a, b) => a + b, 0);
  out.push(sum / period);
  for (let i = period; i < values.length; i++) {
    sum += values[i] - values[i - period];
    out.push(sum / period);
  }
  return out;
}

/** Most recent fast/slow cross within `lookback` bars. */
export function lastCross(fastSeries, slowSeries, lookback = 3) {
  if (!Array.isArray(fastSeries) || !Array.isArray(slowSeries)) return null;
  const n = Math.min(fastSeries.length, slowSeries.length);
  if (n < 3) return null;
  for (let i = n - 1; i >= Math.max(1, n - lookback); i--) {
    const f = fastSeries[i], s = slowSeries[i], fp = fastSeries[i - 1], sp = slowSeries[i - 1];
    if (f == null || s == null || fp == null || sp == null) continue;
    const sign = f > s ? 1 : f < s ? -1 : 0;
    const prev = fp > sp ? 1 : fp < sp ? -1 : 0;
    if (sign !== 0 && prev !== 0 && sign !== prev) return { dir: sign, bars: n - 1 - i };
  }
  return null;
}

export function crossUp(prevA, prevB, nowA, nowB) {
  if ([prevA, prevB, nowA, nowB].some(v => v == null)) return 0;
  if (prevA <= prevB && nowA > nowB) return 1;
  if (prevA >= prevB && nowA < nowB) return -1;
  return 0;
}

/** Close vs a slow EMA regime filter. null when not enough data. */
export function trendFilter(closes, period = 200) {
  const e = period <= closes.length ? emaSeries(closes, period) : null;
  if (!e) return null;
  const v = e[e.length - 1];
  if (v == null) return null;
  const close = closes[closes.length - 1];
  return close > v ? 1 : close < v ? -1 : 0;
}

export function vote({ id, name, family, dir = 0, strength = 0, reasons = [], levels = null, meta = null }) {
  return {
    id, name, family,
    dir: dir === 1 || dir === -1 ? dir : 0,
    strength: dir === 1 || dir === -1 ? clamp01(strength) : 0,
    ready: true,
    reasons: (Array.isArray(reasons) ? reasons : [reasons]).filter(Boolean).slice(0, 3),
    levels: levels || null,
    meta: meta || null,
  };
}

export function atrValue(candles, period = 14) {
  return atr(candles, period);
}

/** UTC-hour window check — used by session-range + ICT Silver Bullet. */
export function utcHour(ts) {
  const t = Number(ts);
  if (!(t > 0)) return null;
  return new Date(t).getUTCHours();
}

export function inUtcWindow(ts, fromHour, toHour) {
  const h = utcHour(ts);
  if (h == null) return false;
  if (fromHour <= toHour) return h >= fromHour && h < toHour;
  return h >= fromHour || h < toHour; // wraps midnight
}

/**
 * Session range (e.g. first 2h of the UTC day). Returns the high/low of
 * the window, how many bars formed it, and whether price has since
 * broken out. `null` when candle timestamps are unavailable.
 */
export function sessionRange(candles, { startUtcHour = 0, hours = 2 } = {}) {
  if (!Array.isArray(candles) || candles.length < 6) return null;
  const lastTs = candleTs(candles[candles.length - 1]);
  if (lastTs == null) return null;
  const dayStart = Date.UTC(
    new Date(lastTs).getUTCFullYear(),
    new Date(lastTs).getUTCMonth(),
    new Date(lastTs).getUTCDate(),
  );
  const from = dayStart + startUtcHour * 3_600_000;
  const to = from + hours * 3_600_000;
  const bars = candles.filter((c) => {
    const t = candleTs(c);
    return t != null && t >= from && t < to;
  });
  if (bars.length < 2) return null;
  const upper = Math.max(...bars.map(c => c.high));
  const lower = Math.min(...bars.map(c => c.low));
  const close = candles[candles.length - 1].close;
  const outsideBars = candles.filter((c) => {
    const t = candleTs(c);
    return t != null && t >= to;
  });
  const retest = outsideBars.length > 0 ? outsideBars[outsideBars.length - 1] : null;
  return {
    upper, lower, mid: (upper + lower) / 2, range: upper - lower,
    bars: bars.length, close,
    breakoutDir: close > upper ? 1 : close < lower ? -1 : 0,
    hasOutsideBars: outsideBars.length > 0,
    lastOutsideClose: retest ? retest.close : null,
    at: Date.now(),
  };
}

export function swingHigh(candles, lookback = 20, excludeLast = 1) {
  const end = candles.length - excludeLast;
  const start = Math.max(0, end - lookback);
  if (end <= start) return null;
  let hi = -Infinity;
  for (let i = start; i < end; i++) if (candles[i].high > hi) hi = candles[i].high;
  return Number.isFinite(hi) ? hi : null;
}

export function swingLow(candles, lookback = 20, excludeLast = 1) {
  const end = candles.length - excludeLast;
  const start = Math.max(0, end - lookback);
  if (end <= start) return null;
  let lo = Infinity;
  for (let i = start; i < end; i++) if (candles[i].low < lo) lo = candles[i].low;
  return Number.isFinite(lo) ? lo : null;
}

/** Simple deterministic entry/stop/target geometry (RR 2 by default). */
export function rrLevels({ dir, entry, stop, rr = 2 }) {
  if (!(entry > 0) || !(stop > 0) || dir === 0) return null;
  const risk = Math.abs(entry - stop);
  if (!(risk > 0)) return null;
  return {
    entry,
    stop,
    target: dir === 1 ? entry + rr * risk : entry - rr * risk,
    rr,
  };
}
