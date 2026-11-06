// ============================================================
// server/ai/adaptiveTargets.js — v21.33.0 [PHASE G2/G6]
// ------------------------------------------------------------
// MASTER PLAN Phase G: data-driven TP + volatility targeting.
//
//   G2  ADAPTIVE TP    TP1 ≈ p40–50 · TP2 ≈ p75 of WINNERS' MFE (R)
//                      us family/regime me — static 1R/2R ki jagah.
//                      Ledger (A2/A3 mfeR) se; n<30 winners → honest
//                      fallback 1R/2R. SHADOW default: suggestion
//                      compute hoti hai, apply nahi hoti.
//   G6  VOL TARGETING  risk multiplier m = clamp(σ_target/σ_realized,
//                      0.5, 1.0) — kabhi > 1.0 nahi (plan: "size
//                      modulation initially capped"). DEFAULT OFF.
//
// DIRECTION SAFETY (invariant): geometry suggestions sirf tab valid
// jab LONG ke liye sl < entry < t1 < t2 aur SHORT ke liye mirror
// ho. Violating suggestion REJECT hota hai — direction certificate
// chain (LONG→BUY, TP upar) kabhi compromise nahi hota.
//
// PURE module — no IO, deterministic.
// ============================================================

export const ADAPTIVE_TP_DEFAULTS = Object.freeze({
  tp1Percentile: 0.45,   // p40–50 band ka midpoint (plan G2)
  tp2Percentile: 0.75,   // p75 (plan G2)
  minWinners: 30,        // n<30 → fallback (insufficient)
  minT1R: 0.5,
  maxT1R: 1.5,
  minT2R: 1.2,
  maxT2R: 3.5,
  t2OverT1Min: 1.4,      // TP2 ≥ 1.4×TP1 (ladder sanity)
});

export const VOL_TARGET_DEFAULTS = Object.freeze({
  targetVolPct: 1.0,     // daily σ target (hypothesis — I-phase se tune)
  clampLow: 0.5,
  clampHigh: 1.0,        // kabhi > 1 nahi (plan G6)
});

function _num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function normalizeTargetMode(raw, fallback = 'shadow') {
  const v = String(raw ?? '').trim().toLowerCase();
  if (v === 'enforce' || v === 'on' || v === '1' || v === 'true') return 'enforce';
  if (v === 'off' || v === '0' || v === 'false' || v === 'disabled') return 'off';
  if (v === 'shadow' || v === 'dry-run' || v === 'observe') return 'shadow';
  return fallback === 'enforce' || fallback === 'off' ? fallback : 'shadow';
}

function _percentile(sorted, q) {
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * Math.max(0, Math.min(1, q));
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * G2 — MFE distribution se TP R-multiples.
 * rows: resolved ledger rows ({resolved:true, outcome, mfeR, regime, tier}).
 * family/regime filter optional (null = all).
 * v21.35.0 [A15 DE-CENSOR]: pehle sirf WINNERS (T1_HIT/T2_HIT) aate the —
 * par rows static TP touch bar par resolve hote hain, isliye winners ka
 * MFE ≈ static t1R/t2R par CAP ho jaata tha aur estimator wahi static
 * levels re-derive karta tha (0.7R TP1 / 3R TP2 kabhi discover hi nahi
 * ho sakta tha). Ab population = SAB resolved rows with mfeR > 0 —
 * losers jo +0.5R run kar ke stop hue wahi lower TP1 band ka asli
 * evidence hain. n<30 → honest fallback 1R/2R (math same).
 * Returns { available, nWinners, population, tp1R, tp2R, source } —
 * insufficient par available:false + fallback 1R/2R.
 */
export function mfePercentileTargets({
  rows = [], family = null, regime = null, side = null,
  cfg = {},
} = {}) {
  const c = { ...ADAPTIVE_TP_DEFAULTS, ...cfg };
  const list = (Array.isArray(rows) ? rows : []).filter((r) => {
    if (r?.resolved !== true) return false;
    // v21.35.0 [A15]: outcome filter HATA — de-censored population. Sirf
    // mfeR > 0 chahiye (MFE ≈ 0 rows me koi TP evidence hi nahi).
    const mfe = _num(r.mfeR);
    if (mfe == null || mfe <= 0) return false;
    if (regime != null && String(r.regime || '').toUpperCase() !== String(regime).toUpperCase()) return false;
    if (side != null && String(r.side || '').toUpperCase() !== String(side).toUpperCase()) return false;
    if (family != null && String(r.family || '').toUpperCase() !== String(family).toUpperCase()) return false;
    return true;
  });
  const mfes = list.map((r) => _num(r.mfeR)).filter((v) => v != null).sort((a, b) => a - b);
  // v21.35.0 [A16a]: empty mfes (ya minWinners<=0 edge) par pehle
  // _percentile([]) → null.toFixed TypeError aata tha — ab honest static
  // fallback (n=0 hamesha insufficient hai, chahe minWinners 0 ho).
  if (mfes.length === 0 || mfes.length < c.minWinners) {
    return {
      available: false,
      reason: `insufficient resolved-mfe rows (n=${mfes.length} < ${c.minWinners}) — static 1R/2R fallback`,
      nWinners: mfes.length,
      population: 'all-resolved-mfe>0',
      tp1R: 1, tp2R: 2,
      source: 'static-fallback',
    };
  }
  let tp1R = +_percentile(mfes, c.tp1Percentile).toFixed(3);
  let tp2R = +_percentile(mfes, c.tp2Percentile).toFixed(3);
  // sanity clamps (starting hypotheses — I-phase grid se validate)
  tp1R = Math.min(c.maxT1R, Math.max(c.minT1R, tp1R));
  tp2R = Math.min(c.maxT2R, Math.max(c.minT2R, Math.max(tp2R, tp1R * c.t2OverT1Min)));
  return {
    available: true,
    nWinners: mfes.length,
    population: 'all-resolved-mfe>0', // v21.35.0 [A15]: de-censored population
    tp1R: +tp1R.toFixed(3),
    tp2R: +tp2R.toFixed(3),
    p25: +_percentile(mfes, 0.25).toFixed(3),
    median: +_percentile(mfes, 0.5).toFixed(3),
    source: family || regime || 'all',
  };
}

/**
 * G2 — plan levels par adaptive TP evaluation (shadow default).
 * plan: { side, entry, stopLoss, t1, t2 } (tradePlanner output).
 * Returns suggested t1/t2 (prices) with geometry invariant check.
 * Enforce me bhi geometry fail → reject + fallback original levels.
 */
export function evaluateAdaptiveTargets({
  plan = {}, rows = [], regime = null, side = null, family = null, mode = 'shadow', cfg = {},
} = {}) {
  const m = normalizeTargetMode(mode);
  const s = String(plan.side || side || '').toUpperCase();
  const entry = _num(plan.entry);
  const sl = _num(plan.stopLoss);
  const t1 = _num(plan.t1);
  const t2 = _num(plan.t2);
  if ((s !== 'LONG' && s !== 'SHORT') || entry == null || !(entry > 0) || sl == null) {
    return { filter: 'adaptiveTargets', mode: m, active: m !== 'off', available: false, reason: 'missing plan geometry', applied: false, suggested: null };
  }
  const risk = Math.abs(entry - sl);
  if (!(risk > 0)) {
    return { filter: 'adaptiveTargets', mode: m, active: m !== 'off', available: false, reason: 'zero risk distance', applied: false, suggested: null };
  }
  const targets = mfePercentileTargets({ rows, regime, side: s, family, cfg });
  const base = {
    filter: 'adaptiveTargets', mode: m, active: m !== 'off', side: s, regime: regime || null,
    available: targets.available, nWinners: targets.nWinners,
    tp1R: targets.tp1R, tp2R: targets.tp2R, source: targets.source,
  };
  if (!targets.available) {
    return { ...base, shadow: m === 'shadow', wouldApply: false, applied: false, suggested: null, reason: targets.reason };
  }
  // geometry: LONG → t1 = entry + tp1R·risk, t2 = entry + tp2R·risk
  const sT1 = s === 'LONG' ? entry + targets.tp1R * risk : entry - targets.tp1R * risk;
  const sT2 = s === 'LONG' ? entry + targets.tp2R * risk : entry - targets.tp2R * risk;
  const geometryOk = s === 'LONG'
    ? (sl < entry && entry < sT1 && sT1 < sT2)
    : (sl > entry && entry > sT1 && sT1 > sT2);
  if (!geometryOk) {
    return {
      ...base, shadow: m === 'shadow', wouldApply: false, applied: false, suggested: null,
      reason: 'suggested TP geometry INVALID — original levels kept (direction invariant)',
    };
  }
  const applied = m === 'enforce';
  return {
    ...base,
    shadow: m === 'shadow',
    original: t1 != null && t2 != null ? { t1: +t1.toFixed(6), t2: +t2.toFixed(6) } : null,
    suggested: { t1: +sT1.toFixed(6), t2: +sT2.toFixed(6) },
    wouldApply: m === 'shadow',
    applied,
    appliedLevels: applied ? { t1: +sT1.toFixed(6), t2: +sT2.toFixed(6) } : null,
    reason: applied ? 'applied (enforce)' : 'shadow suggestion (apply nahi hota)',
  };
}

// ------------------------------------------------------------
// G6 — Volatility targeting multiplier (DEFAULT OFF)
// m = clamp(σ_target / σ_realized, 0.5, 1.0) — high realized vol
// = smaller size; low vol kabhi size BADHATA nahi (cap 1.0).
// ------------------------------------------------------------
export function volTargetMultiplier({
  realizedVolPct = null, targetVolPct = VOL_TARGET_DEFAULTS.targetVolPct,
  clampLow = VOL_TARGET_DEFAULTS.clampLow, clampHigh = VOL_TARGET_DEFAULTS.clampHigh,
} = {}) {
  const rv = _num(realizedVolPct);
  const tv = _num(targetVolPct);
  if (rv == null || !(rv > 0) || tv == null || !(tv > 0)) {
    return { available: false, multiplier: 1, reason: 'missing realized/target vol — multiplier 1 (neutral)' };
  }
  const raw = tv / rv;
  const lo = Math.min(clampLow, clampHigh);
  const hi = Math.max(clampLow, clampHigh);
  const multiplier = +Math.min(hi, Math.max(lo, raw)).toFixed(3);
  return {
    available: true,
    raw: +raw.toFixed(3),
    multiplier,
    clamped: raw !== multiplier,
    reason: raw > hi ? 'realized vol < target — capped at 1.0 (size kabhi badhata nahi)' : null,
  };
}

/**
 * G6 — Kelly research fraction (plan: research-only, default off).
 * f* = p − (1−p)/b with calibrated p; use ≤ 0.25·f*, hard-capped by
 * risk cap. ECE > 5pt, n<150, ya ece/n UNKNOWN → refuse (honest).
 * NOTE: agent.js me half-Kelly sizing pehle se hai — ye ledger-based
 * research helper hai, koi live wiring NAHI.
 */
export function kellyResearchFraction({
  pWin = null, avgWinR = null, avgLossR = null, ece = null, n = null, riskCapPct = 1,
} = {}) {
  const p = _num(pWin);
  const b = _num(avgWinR) != null && _num(avgLossR) != null && _num(avgLossR) > 0 ? _num(avgWinR) / _num(avgLossR) : null;
  if (p == null || b == null || !(b > 0)) {
    return { available: false, fractionPct: 0, reason: 'missing p/b inputs' };
  }
  // v21.35.0 [A16b]: ece/n UNKNOWN → refuse. Pehle missing values
  // chhoot jaati thi (ece!=null && ece>0.05 pattern) — uncalibrated Kelly
  // fraction confidently compute ho jaata tha. Unknown calibration =
  // refuse (honest) — nulls kabhi pass nahi honge.
  if (ece == null || n == null) {
    return { available: false, fractionPct: 0, reason: 'ece/n unknown — uncalibrated Kelly refuse' };
  }
  if (ece > 0.05) {
    return { available: false, fractionPct: 0, reason: `calibration ECE ${(ece * 100).toFixed(1)}pt > 5pt — Kelly research refuse` };
  }
  if (n < 150) {
    return { available: false, fractionPct: 0, reason: `n=${n} < 150 — Kelly research refuse` };
  }
  const fStar = p - (1 - p) / b;
  if (fStar <= 0) {
    return { available: true, fractionPct: 0, fStar: +fStar.toFixed(4), reason: 'edge <= 0 — fraction 0 (negative-edge refusal)' };
  }
  const f = Math.min(0.25 * fStar, riskCapPct / 100);
  return {
    available: true,
    fStar: +fStar.toFixed(4),
    fractionPct: +(f * 100).toFixed(3),
    cap: '0.25·f* (quarter-Kelly) + riskCap hard cap',
  };
}
