// ============================================================
// server/ai/metaModel.js — v21.33.0 [PHASE E META-LABELING]
// ------------------------------------------------------------
// MASTER PLAN Phase E: rules ka signal = PRIMARY (side decide karta
// hai — direction certificate intact). Ye chhota SECONDARY model
// sirf TAKE/SKIP + p(win) decide karta hai. SIDE KABHI FLIP NAHI
// HOTA — metaDecision sirf probability aur take verdict deta hai.
//
// v21.35.0 [A11 SIDE-AWARE DIVERGENCE ENCODING]: divergenceAdverse /
// divergenceFavourable ab trade-side ke perspective se encode hote hain
// (BEARISH = LONG ke liye adverse, SHORT ke liye favourable). Pehle
// side-blind tha → pooled logistic SHORT rows ka pWin systematically
// miscalibrate karta tha. META_FEATURES ka naam/count UNCHANGED — abhi
// koi trained artifact exist nahi karta, cold-start schema change safe.
//
// Modes (E4): META_MODEL=off|shadow|enforce
//   off     → inactive (champion default v21.32)
//   shadow  → would-take/would-skip sirf record hota hai (A5 data)
//   enforce → take/skip LIVE gate; skip = entry block (side same)
// Mode bina model artifact ke hamesha INACTIVE rehta hai — trainer
// (scripts/train-meta.mjs) n≥300 aur OOS-beats-baseline pass hone
// ke bina artifact likhta hi nahi (honest cold-start).
//
// Artifact: models/meta-<date>.json — { version, features, weights,
// bias, means, stds, isotonic (knots), metrics, thresholds }.
// Inference = dot-product + sigmoid + isotonic interpolation —
// Node me sub-millisecond, koi native dep nahi.
//
// PURE inference module (fs sirf artifact load ke liye, cached).
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODELS_DIR = path.resolve(__dirname, '../../models');

export const META_MODEL_MODES = Object.freeze(['off', 'shadow', 'enforce']);

// Ordered numeric feature columns (fv: 1/2 dono se extract hote hain;
// missing → null → inference me mean se impute — honest unknown).
export const META_FEATURES = Object.freeze([
  'score', 'superScore', 'adx', 'atrPct', 'rsi', 'er', 'bbWidthPct',
  'barsInTrend', 'realizedVolRatio',
  'trigScore', 'trigVolRatio', 'trigBodyPct', 'trigRsi',
  'fundingBps8h', 'longShortRatio', 'basisPct', 'spreadBps',
  'divergenceAdverse', 'divergenceFavourable',
  'squeezeOn', 'squeezeFired', 'exhausted', 'trigPullbackReclaim',
  'hourOfDay', 'minutesToFunding',
]);

const TIER_ORDER = { WATCH: 0, ACTION: 1, STRONG: 2, ELITE: 3 };

function _num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function normalizeMetaMode(raw, fallback = 'off') {
  // v21.35.0 [A10d]: explicitly-empty raw ('' ya whitespace-only) ko UNSET
  // maano — pehle '' nullish nahi thi isliye env fallback bypass ho jata
  // tha (callers jo '' default ke saath aate the wo META_MODEL env kabhi
  // read nahi karwate the). Real values ('0', 'off', 'shadow') env ko
  // override karte hi rehte hain.
  const rawSet = raw != null && String(raw).trim() !== '';
  const v = String(rawSet ? raw : (process.env.META_MODEL ?? '')).trim().toLowerCase();
  if (v === 'enforce' || v === 'on' || v === '1' || v === 'true') return 'enforce';
  if (v === 'off' || v === '0' || v === 'false' || v === 'disabled') return 'off';
  if (v === 'shadow' || v === 'dry-run' || v === 'observe') return 'shadow';
  return fallback === 'enforce' || fallback === 'shadow' ? fallback : 'off';
}

/**
 * featureSnapshot (fv:1/2) → ordered numeric feature row.
 * v21.35.0 [A11 SIDE-AWARE]: divergenceAdverse/Favourable ab trade ke
 * SIDE ke hisaab se encode hote hain — BEARISH divergence LONG ke liye
 * adverse hai, SHORT ke liye FAVOURABLE (aur mirror). Pehle encoding
 * side-blind thi — pooled logistic me SHORT rows ka pWin systematically
 * miscalibrate hota tha. Side unknown → null (mean-impute + imputeCount
 * me honest count). META_FEATURES naam/count UNCHANGED — koi artifact
 * abhi exist nahi karta, cold-start schema change safe hai.
 */
export function featureRowFromSnapshot(fv = {}) {
  const ctx = fv && typeof fv === 'object' ? fv : {};
  const trig = ctx.trig && typeof ctx.trig === 'object' ? ctx.trig : {};
  // v21.35.0 [A11]: trade-side sign — fv:2 flat snapshots me `side` field
  // hota hai (buildFeatureVector passthrough); fv:1 nested me absent → 0.
  const sideSign = (() => {
    const sd = String(ctx.side ?? '').toUpperCase();
    return sd === 'LONG' ? 1 : sd === 'SHORT' ? -1 : 0;
  })();
  const flat = {
    score: _num(ctx.score ?? ctx.ctx?.score),
    superScore: _num(ctx.superScore),
    adx: _num(ctx.adx ?? ctx.ctx?.adx),
    atrPct: _num(ctx.atrPct ?? ctx.ctx?.atrPct),
    rsi: _num(ctx.rsi ?? ctx.ctx?.rsi),
    er: _num(ctx.er ?? ctx.ctx?.er),
    bbWidthPct: _num(ctx.bbWidthPct ?? ctx.ctx?.bbWidthPct),
    barsInTrend: _num(ctx.barsInTrend ?? ctx.ctx?.barsInTrend),
    realizedVolRatio: _num(ctx.realizedVolRatio),
    trigScore: _num(trig.score ?? ctx.trigScore),
    trigVolRatio: _num(trig.volRatio ?? ctx.trigVolRatio),
    trigBodyPct: _num(trig.bodyPct ?? ctx.trigBodyPct),
    trigRsi: _num(trig.rsi ?? ctx.trigRsi),
    fundingBps8h: _num(ctx.fundingBps8h),
    longShortRatio: _num(ctx.longShortRatio),
    basisPct: _num(ctx.basisPct),
    spreadBps: _num(ctx.spreadBps),
    divergenceAdverse: (() => {
      // v21.34.0 [NONE ≠ MISSING]: 'NONE' ek DEFINITE observation hai
      // (dono indicators ne dekha, koi divergence nahi) — use 0 encode
      // karo. null sirf tab jab dono divergence objects absent hon
      // (data hi nahi aaya). Pehle NONE bhi null ban raha tha → majority
      // rows pe mean-imputation (feature ko training-mean ki taraf kheench
      // deti thi, imputed-count inflate).
      // v21.35.0 [A11 SIDE-AWARE]: adverse = divergence TRADE ke against —
      // LONG + BEARISH ya SHORT + BULLISH. Side unknown → null (honest
      // impute; side-blind 0/1 fabricate nahi).
      const rObj = ctx.rsiDivergence, mObj = ctx.macdDivergence;
      if (!rObj && !mObj) return null;
      if (sideSign === 0) return null;
      const rd = rObj?.kind, md = mObj?.kind;
      return (sideSign > 0 && (rd === 'BEARISH' || md === 'BEARISH'))
        || (sideSign < 0 && (rd === 'BULLISH' || md === 'BULLISH')) ? 1 : 0;
    })(),
    divergenceFavourable: (() => {
      // v21.35.0 [A11 SIDE-AWARE]: favourable = divergence TRADE ke saath —
      // LONG + BULLISH ya SHORT + BEARISH. Side unknown → null.
      const rObj = ctx.rsiDivergence, mObj = ctx.macdDivergence;
      if (!rObj && !mObj) return null;
      if (sideSign === 0) return null;
      const rd = rObj?.kind, md = mObj?.kind;
      return (sideSign > 0 && (rd === 'BULLISH' || md === 'BULLISH'))
        || (sideSign < 0 && (rd === 'BEARISH' || md === 'BEARISH')) ? 1 : 0;
    })(),
    squeezeOn: ctx.squeeze == null && ctx.ctx?.squeeze == null ? null : (ctx.squeeze ?? ctx.ctx?.squeeze) ? 1 : 0,
    squeezeFired: ctx.squeezeFired == null && ctx.ctx?.squeezeFired == null ? null : (ctx.squeezeFired ?? ctx.ctx?.squeezeFired) ? 1 : 0,
    exhausted: ctx.exhausted == null && ctx.ctx?.exhausted == null ? null : (ctx.exhausted ?? ctx.ctx?.exhausted) ? 1 : 0,
    trigPullbackReclaim: trig.pullbackReclaim == null ? null : trig.pullbackReclaim ? 1 : 0,
    hourOfDay: _num(ctx.session?.hourOfDay),
    minutesToFunding: _num(ctx.session?.minutesToFunding),
  };
  return META_FEATURES.map((k) => flat[k] ?? null);
}

/** Isotonic knots interpolation (signalLedger.isotonicFit ka artifact form). */
export function interpolateIsotonic(knots = [], p) {
  if (!Array.isArray(knots) || knots.length === 0) return null;
  const x = Number(p);
  if (!Number.isFinite(x)) return null;
  if (x <= knots[0].p) return knots[0].v;
  if (x >= knots[knots.length - 1].p) return knots[knots.length - 1].v;
  for (let k = 0; k < knots.length - 1; k++) {
    if (x >= knots[k].p && x <= knots[k + 1].p) {
      const t = (x - knots[k].p) / Math.max(1e-12, knots[k + 1].p - knots[k].p);
      return +(knots[k].v + t * (knots[k + 1].v - knots[k].v)).toFixed(4);
    }
  }
  return knots[knots.length - 1].v;
}

/**
 * E2 inference — logistic (JSON weights) + isotonic calibration.
 * fv: featureSnapshot object (ledger row) ya pre-built numeric row.
 * tierThreshold: pWin cal ≥ threshold → take (E4).
 * Returns { pWinRaw, pWin, take, modelVersion, imputed }.
 */
export function metaDecision({ fv = {}, featureRow = null, model = null, tierThreshold = 0.55 } = {}) {
  if (!model || !Array.isArray(model.weights) || typeof model.bias !== 'number') {
    return { available: false, reason: 'no_model', pWin: null, take: null, modelVersion: null };
  }
  const row = Array.isArray(featureRow) && featureRow.length === META_FEATURES.length
    ? featureRow
    : featureRowFromSnapshot(fv);
  const means = Array.isArray(model.means) ? model.means : META_FEATURES.map(() => 0);
  const stds = Array.isArray(model.stds) ? model.stds : META_FEATURES.map(() => 1);
  let z = model.bias;
  let imputed = 0;
  for (let i = 0; i < META_FEATURES.length; i++) {
    const v = row[i];
    const std = stds[i] > 0 ? stds[i] : 1;
    const x = v == null ? (means[i] ?? 0) : v;
    if (v == null) imputed += 1;
    z += (Number(model.weights[i]) || 0) * ((x - (means[i] ?? 0)) / std);
  }
  const pRaw = 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
  const pCal = model.isotonic ? interpolateIsotonic(model.isotonic, pRaw) : pRaw;
  const pWin = pCal == null ? null : Math.min(0.92, Math.max(0.01, pCal));
  // v21.35.0 [A10a]: pWin null (empty isotonic knots / NaN z) par pehle
  // available:true + take:null return hota tha — enforce gate silently
  // no-op ho jaata tha (na take, na skip). Ab honest refuse: available:false
  // + reason 'calibration_failed' → consumers isse inactive treat karte
  // hain (evaluateMetaGate fail-open skip path leta hai, pWin null).
  if (pWin == null) {
    return {
      available: false,
      reason: 'calibration_failed',
      pWinRaw: +pRaw.toFixed(4),
      pWin: null,
      take: null,
      modelVersion: model.version || null,
      imputed,
      features: META_FEATURES,
    };
  }
  return {
    available: true,
    pWinRaw: +pRaw.toFixed(4),
    pWin: +pWin.toFixed(4),
    take: pWin >= Number(tierThreshold),
    modelVersion: model.version || null,
    imputed,
    features: META_FEATURES,
  };
}

// ------------------------------------------------------------
// Artifact loading (cached, mtime-refresh, missing → null)
// ------------------------------------------------------------
let _cache = { file: null, mtime: 0, model: null };

export function loadMetaModel(modelsDir = MODELS_DIR) {
  try {
    if (!fs.existsSync(modelsDir)) return null;
    const files = fs.readdirSync(modelsDir)
      .filter((f) => /^meta-.*\.json$/i.test(f))
      .sort();
    if (!files.length) return null;
    const file = files[files.length - 1]; // latest by name (dated)
    const full = path.join(modelsDir, file);
    const st = fs.statSync(full);
    if (_cache.file === full && _cache.mtime === st.mtimeMs && _cache.model) return _cache.model;
    const raw = JSON.parse(fs.readFileSync(full, 'utf8'));
    // v21.35.0 [A10b DEEP VALIDATION]: sirf length/naam check kaafi nahi —
    //   • features ABSENT → positional weights vacuous (kisi ka pata hi
    //     nahi kaunsa feature kis weight se map hota hai)
    //   • means/stds missing/wrong-length/non-finite → standardization
    //     silently jhooth bolti (NaN z → pWin null → pehle no-op gate)
    //   • isotonic corrupt (descending p ya decreasing v) → calibration
    //     monotone nahi — interpolation galat pWin deta
    // Koi bhi violation → honest refuse (null), corrupted cache NAHI hota.
    if (!Array.isArray(raw.features)) return null;
    if (!Array.isArray(raw.weights) || !Array.isArray(raw.means) || !Array.isArray(raw.stds)) return null;
    if (raw.weights.length !== raw.features.length
      || raw.means.length !== raw.features.length
      || raw.stds.length !== raw.features.length) return null;
    // v21.35.0 [A10b]: null/''/boolean reject — Number(null)=0 aur
    // Number('')=0 silently finite ban jaate hain (fabricated zero).
    const allFiniteNums = (xs) => xs.every((v) => (typeof v === 'number' || (typeof v === 'string' && v !== ''))
      && Number.isFinite(Number(v)));
    if (!allFiniteNums(raw.weights) || !allFiniteNums(raw.means) || !allFiniteNums(raw.stds)) return null;
    if (raw.isotonic != null) {
      if (!Array.isArray(raw.isotonic) || raw.isotonic.length === 0) return null;
      for (let k = 0; k < raw.isotonic.length; k++) {
        const kn = raw.isotonic[k] && typeof raw.isotonic[k] === 'object' ? raw.isotonic[k] : null;
        const p = _num(kn?.p);
        const v = _num(kn?.v);
        if (p == null || v == null) return null;
        if (k > 0) {
          const prev = raw.isotonic[k - 1];
          // ascending p (ties OK — trainer PAVA equal-p knots de sakta hai)
          // + monotone non-decreasing v — dono isotonic ki shart hain.
          if (p < _num(prev?.p) || v < _num(prev?.v)) return null;
        }
      }
    }
    const model = {
      version: String(raw.version || file.replace(/\.json$/i, '')),
      trainedAt: raw.trainedAt || null,
      n: Number(raw.n) || 0,
      features: Array.isArray(raw.features) ? raw.features : META_FEATURES,
      weights: Array.isArray(raw.weights) ? raw.weights.map(Number) : [],
      bias: Number(raw.bias) || 0,
      means: Array.isArray(raw.means) ? raw.means.map(Number) : [],
      stds: Array.isArray(raw.stds) ? raw.stds.map(Number) : [],
      isotonic: Array.isArray(raw.isotonic) ? raw.isotonic : null,
      thresholds: raw.thresholds && typeof raw.thresholds === 'object' ? raw.thresholds : null,
      metrics: raw.metrics && typeof raw.metrics === 'object' ? raw.metrics : null,
    };
    // v21.34.0 [FEATURE-SCHEMA DEEP VALIDATION]: sirf lengths match karna
    // kaafi nahi — artifact me features ka NAAM+ORDER META_FEATURES se
    // exactly match hona chahiye. Same-length different-order (purana/
    // hand-edited artifact) positional weight-multiply se silently GALAT
    // pWin bana deta tha. Order mismatch → honest refuse (null).
    if (model.weights.length !== model.features.length) return null; // corrupt artifact → honest refuse
    if (model.features.length !== META_FEATURES.length
      || model.features.some((f, idx) => String(f) !== String(META_FEATURES[idx]))) {
      return null; // feature schema mismatch → honest refuse
    }
    _cache = { file: full, mtime: st.mtimeMs, model };
    return model;
  } catch {
    return null;
  }
}

/**
 * E4 — the META GATE. Side kabhi flip nahi hota; enforce me sirf
 * take/skip. Tier-wise threshold (ledger recommendedThreshold ya
 * artifact thresholds ya fallback default).
 */
export function evaluateMetaGate({
  row = {}, fv = null, model = null, mode = null, tierThreshold = 0.55,
  sizeModulation = false,
} = {}) {
  const m = normalizeMetaMode(mode);
  const base = {
    filter: 'metaModel', mode: m, active: m !== 'off',
    side: String(row.side || '').toUpperCase(), // SIDE LOCKED — sirf read
    tier: row.tier || null,
  };
  if (m === 'off') return { ...base, available: false, wouldBlock: false, blocked: false, shadow: false, reason: 'mode_off', pWin: null, wouldTake: null };
  const artifact = model || loadMetaModel();
  if (!artifact) {
    return { ...base, available: false, wouldBlock: false, blocked: false, shadow: m === 'shadow', reason: 'no_model_artifact (n<300 ya OOS-beat fail — trainer ne refuse kiya)', pWin: null, wouldTake: null };
  }
  const snapshot = fv || row.featureSnapshot || null;
  // v21.35.0 [A10c]: tier key UPPERCASE karke lookup karo — lowercase
  // 'elite' artifact thresholds kabhi match nahi karta tha (hamesha
  // default 0.55 fall — tier-wise threshold silently dead).
  const tierKey = String(row.tier || '').toUpperCase();
  const thr = Number(
    artifact.thresholds?.[tierKey]
    ?? artifact.thresholds?.default
    ?? tierThreshold,
  ) || 0.55;
  const dec = metaDecision({ fv: snapshot || {}, model: artifact, tierThreshold: thr });
  if (!dec.available) {
    return { ...base, available: false, wouldBlock: false, blocked: false, shadow: m === 'shadow', reason: dec.reason, pWin: null, wouldTake: null };
  }
  // E4 size modulation (capped [0.5, 1.0]) — enforce-only, optional
  let sizeMultiplier = null;
  if (sizeModulation && m === 'enforce' && dec.pWin != null) {
    sizeMultiplier = dec.pWin >= 0.65 ? 1.0 : dec.pWin >= 0.55 ? 0.85 : dec.pWin >= 0.45 ? 0.70 : 0.5;
  }
  const wouldTake = dec.take === true;
  const wouldSkip = dec.take === false;
  return {
    ...base,
    available: true,
    shadow: m === 'shadow',
    pWin: dec.pWin,
    pWinRaw: dec.pWinRaw,
    threshold: thr,
    modelVersion: dec.modelVersion,
    imputedFeatures: dec.imputed,
    wouldTake,
    wouldSkip,
    // guard convention (tradeGuards.js jaisa): wouldBlock = OBSERVATION
    // (counterfactual), blocked = enforce action. Shadow me observation
    // record hota hai, block kabhi nahi.
    wouldBlock: wouldSkip,
    blocked: m === 'enforce' && wouldSkip,
    sizeMultiplier,
    reason: wouldSkip ? `pWin ${dec.pWin} < tier threshold ${thr} (meta-model skip)` : null,
  };
}

/** Tier rank helper (dashboard/decision-grade gating). */
export function tierRank(tier) {
  return TIER_ORDER[String(tier || '').toUpperCase()] ?? -1;
}
