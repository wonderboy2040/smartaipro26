// ============================================================
// scripts/lib/stats.js — v21.32.0 PHASE A STATS UTILITIES
// ------------------------------------------------------------
// MASTER PLAN (18.1 / 18.2): Wilson interval, deterministic bootstrap,
// ECE, Brier, profit factor, expectancy, max drawdown — sab PURE.
// Deterministic seed ke saath (har run same CI deta hai — reproducible
// reports ke liye zaroori).
//
// Tests: test/statsUtilsV21320.test.ts
// ============================================================

/** Wilson 95% (default z=1.96) interval. n=0 → {lo:null, hi:null, p:null}. */
export function wilson(k, n, z = 1.96) {
  if (!n) return { lo: null, hi: null, p: null };
  const p = k / n, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d;
  const h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
  return { p, lo: c - h, hi: c + h };
}

/** Deterministic LCG random in [0,1) — same seed = same resamples. */
export function _lcg(seed = 1) {
  let s = Math.abs(Math.floor(Number(seed) || 1)) % 4294967296 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

/** Bootstrap mean CI (default 2000 iters, deterministic seed).
 *  Empty array → {lo:null, hi:null, mean:null}. */
export function bootstrapMeanCI(xs, iters = 2000, seed = 1) {
  if (!Array.isArray(xs) || xs.length === 0) return { lo: null, hi: null, mean: null };
  const rnd = _lcg(seed);
  const means = [];
  for (let i = 0; i < iters; i++) {
    let sum = 0;
    for (let j = 0; j < xs.length; j++) sum += xs[(rnd() * xs.length) | 0];
    means.push(sum / xs.length);
  }
  means.sort((a, b) => a - b);
  return {
    lo: means[(iters * 0.025) | 0],
    hi: means[(iters * 0.975) | 0],
    mean: xs.reduce((a, b) => a + b, 0) / xs.length,
  };
}

/**
 * Bootstrap P(lower-set mean <= upper-set mean) style one-sided p-value:
 * "kya B (e.g. taken-set) ka mean A (blocked-set) se better hai?"
 * Deterministic. Returns {p, diffMeans} — p chhota = B significantly better.
 */
export function bootstrapCompareMean(a, b, { iters = 2000, seed = 7 } = {}) {
  const A = (Array.isArray(a) ? a : []).map(Number).filter(Number.isFinite);
  const B = (Array.isArray(b) ? b : []).map(Number).filter(Number.isFinite);
  if (A.length === 0 || B.length === 0) return { p: null, diffMeans: null };
  const meanA = A.reduce((x, y) => x + y, 0) / A.length;
  const meanB = B.reduce((x, y) => x + y, 0) / B.length;
  const rnd = _lcg(seed);
  // H0: dono same distribution — pooled resample.
  const pooled = [...A, ...B];
  let count = 0;
  for (let i = 0; i < iters; i++) {
    let sA = 0, sB = 0;
    for (let j = 0; j < A.length; j++) sA += pooled[(rnd() * pooled.length) | 0];
    for (let j = 0; j < B.length; j++) sB += pooled[(rnd() * pooled.length) | 0];
    if (sB / B.length - sA / A.length >= meanB - meanA) count++;
  }
  return { p: Math.max(1 / (iters + 1), count / iters), diffMeans: meanB - meanA };
}

/** ECE (18.1): Σ_b (n_b/N)·|mean(p_b) − hit_b| over claimed-prob buckets. */
export function expectedCalibrationError(pairs, { buckets = 10 } = {}) {
  const rows = (Array.isArray(pairs) ? pairs : [])
    .filter((r) => Number.isFinite(Number(r?.p)) && Number.isFinite(Number(r?.y)));
  if (rows.length === 0) return null;
  const nb = Math.max(2, Math.floor(Number(buckets) || 10));
  const sums = new Array(nb).fill(0).map(() => ({ p: 0, y: 0, n: 0 }));
  for (const r of rows) {
    const idx = Math.min(nb - 1, Math.max(0, Math.floor(Number(r.p) * nb)));
    sums[idx].p += Number(r.p);
    sums[idx].y += Number(r.y);
    sums[idx].n += 1;
  }
  let ece = 0;
  for (const b of sums) {
    if (!b.n) continue;
    ece += (b.n / rows.length) * Math.abs(b.p / b.n - b.y / b.n);
  }
  return ece;
}

/** Brier: mean((p − y)²). Empty → null. */
export function brierScore(pairs) {
  const rows = (Array.isArray(pairs) ? pairs : [])
    .filter((r) => Number.isFinite(Number(r?.p)) && Number.isFinite(Number(r?.y)));
  if (rows.length === 0) return null;
  return rows.reduce((s, r) => s + (Number(r.p) - Number(r.y)) ** 2, 0) / rows.length;
}

/** Profit factor: Σwins / |Σlosses| (net R). No losses → null (∞ nahi bolte). */
export function profitFactor(rs) {
  const xs = (Array.isArray(rs) ? rs : []).map(Number).filter(Number.isFinite);
  if (xs.length === 0) return null;
  const wins = xs.filter((x) => x > 0).reduce((a, b) => a + b, 0);
  const losses = xs.filter((x) => x < 0).reduce((a, b) => a + b, 0);
  if (losses === 0) return null;
  return wins / Math.abs(losses);
}

/** Net expectancy: avg R (fees/slippage already net ho chuke hone chahiye). */
export function expectancyR(rs) {
  const xs = (Array.isArray(rs) ? rs : []).map(Number).filter(Number.isFinite);
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Max drawdown in R on the cumulative-R equity path. */
export function maxDrawdownR(rs) {
  const xs = (Array.isArray(rs) ? rs : []).map(Number).filter(Number.isFinite);
  if (xs.length === 0) return { ddR: null, peakR: null };
  let cum = 0, peak = 0, dd = 0;
  for (const x of xs) {
    cum += x;
    if (cum > peak) peak = cum;
    dd = Math.max(dd, peak - cum);
  }
  return { ddR: dd, peakR: peak };
}

/** 95th-percentile bootstrap drawdown (I1.8: equity curve ek hi path hai). */
export function bootstrapDrawdownP95(rs, { iters = 2000, seed = 11 } = {}) {
  const xs = (Array.isArray(rs) ? rs : []).map(Number).filter(Number.isFinite);
  if (xs.length === 0) return null;
  const rnd = _lcg(seed);
  const dds = [];
  for (let i = 0; i < iters; i++) {
    let cum = 0, peak = 0, dd = 0;
    for (let j = 0; j < xs.length; j++) {
      cum += xs[(rnd() * xs.length) | 0];
      if (cum > peak) peak = cum;
      dd = Math.max(dd, peak - cum);
    }
    dds.push(dd);
  }
  dds.sort((a, b) => a - b);
  return dds[(iters * 0.95) | 0];
}

/** A1 min-n gate state (ACCURACY-DEFINITIONS.md §3). */
export function minNGate(n) {
  const k = Math.max(0, Math.floor(Number(n) || 0));
  if (k < 30) return { state: 'insufficient', decisionGrade: false, reviewable: false };
  if (k < 100) return { state: 'early', decisionGrade: false, reviewable: false };
  if (k < 150) return { state: 'reviewable', decisionGrade: false, reviewable: true };
  return { state: 'decision-grade', decisionGrade: true, reviewable: true };
}
