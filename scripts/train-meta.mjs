#!/usr/bin/env node
// ============================================================
// scripts/train-meta.mjs — v21.33.0 [PHASE E TRAINER]
// ------------------------------------------------------------
// MASTER PLAN Phase E: per-trade meta-labeling model trainer.
//   y = 1  agar ledger outcome ∈ {T1_HIT, T2_HIT}   (TP1 tak pahuncha)
//   y = 0  agar SL_HIT                               (stop pehle laga)
//   TIMEOUT configurable (--timeout-as exclude|0|1, default exclude)
//
// PIPELINE (leak-free, E3):
//   1. ledger rows (resolved, featureSnapshot A3) → feature matrix
//   2. L2-regularized logistic regression (gradient descent, standardized)
//   3. FORWARD-ONLY walk-forward (fold k: train = STRICTLY BEFORE test
//      block, embargo dono sides) — OOS only, koi future-regime train nahi
//   4. metrics OOS: Brier, ECE, AUC + net expectancy at thresholds
//   5. baseline = isotonic-calibrated rule score (E2 model #1) se compare
//      — SAME score input par evaluate hota hai jo fit hua (v21.34.0 fix:
//      pehle aggregate loop model ke pRaw ko baseline me daal raha tha →
//      baseline ≈ model khud → gate self-comparison ban gaya tha)
//   6. PASS sirf agar OOS Brier baseline se better YA ECE better,
//      n>=300, aur (usable-1)/(usable) folds stable (Brier <= baseline+0.02)
//   7. PASS → models/meta-<date>.json artifact + isotonic knots
//      FAIL → artifact NAHI likha (honest refusal — cold-start safe)
//
// SAFETY: read-only inputs (ledger). Sirf models/ me ek JSON likhta hai.
// Koi live behaviour change nahi — META_MODEL flag default off hai;
// promotion FLAG-HISTORY ke saath manual (shadow pehle).
//
// USAGE: node scripts/train-meta.mjs [--data-dir server/data]
//          [--timeout-as exclude|0|1] [--folds 4] [--min-n 300]
//          [--l2 0.05] [--iters 400] [--lr 0.35] [--force]
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { purgedWalkForwardSplit } from '../server/ai/signalLedger.js';
import { META_FEATURES, featureRowFromSnapshot, interpolateIsotonic } from '../server/ai/metaModel.js';
import { expectedCalibrationError, brierScore } from './lib/stats.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, '..');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !String(v).startsWith('--') ? v : true;
}

const dataDir = path.resolve(APP_ROOT, String(arg('data-dir', 'server/data')));
const ledgerFile = path.join(dataDir, 'mtf-row-ledger.json');
const modelsDir = path.join(APP_ROOT, 'models');
const timeoutAs = String(arg('timeout-as', 'exclude')).toLowerCase();
const FOLDS = Math.max(2, Number(arg('folds', 4)) || 4);
const MIN_N = Math.max(50, Number(arg('min-n', 300)) || 300);
const L2 = Number(arg('l2', 0.05)) || 0.05;
const ITERS = Number(arg('iters', 400)) || 400;
const LR = Number(arg('lr', 0.35)) || 0.35;
const FORCE = arg('force') === true;

let rows = [];
try {
  const raw = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  rows = Array.isArray(raw?.rows) ? raw.rows : [];
} catch {
  console.error(`[train-meta] ledger nahi mila/invalid: ${ledgerFile}`);
  console.error('[train-meta] Server chalao (rows featureSnapshot ke saath aate hain — A3 schema), phir dobara.');
  process.exit(1);
}

// ---------------- 1. dataset ----------------
// v21.35.0 [A11 SIDE-AWARE DIVERGENCE]: feature extraction yahan bhi
// metaModel.featureRowFromSnapshot se hi aati hai — divergenceAdverse/
// divergenceFavourable ab fv.side ke perspective se encode hote hain
// (BEARISH = LONG ke liye adverse, SHORT ke liye favourable; side
// unknown → null → mean-impute). Trainer aur inference ka encoding
// ek hi shared function me hai, isliye train/serve skew nahi ban sakta.
// Naya artifact hi naya schema seekhega — purana artifact (agar kabhi
// bana ho) feature-schema validation se honest-refuse hota hai.
const samples = [];
for (const r of rows) {
  if (r?.resolved !== true) continue;
  const out = String(r.outcome || '').toUpperCase();
  if (out === 'TIMEOUT') {
    if (timeoutAs === 'exclude') continue;
  }
  if (out !== 'T1_HIT' && out !== 'T2_HIT' && out !== 'SL_HIT' && out !== 'TIMEOUT') continue;
  let y;
  if (out === 'T1_HIT' || out === 'T2_HIT') y = 1;
  else if (out === 'SL_HIT') y = 0;
  else y = timeoutAs === '1' ? 1 : 0;
  const fv = r.featureSnapshot && typeof r.featureSnapshot === 'object' ? r.featureSnapshot : null;
  if (!fv) continue;
  const featureRow = featureRowFromSnapshot(fv);
  const tsIn = Number(r.ts) || 0;
  const holdMin = Number(r.holdMin) || 60;
  samples.push({
    tsIn,
    tsOut: tsIn + holdMin * 60_000,
    y,
    score: Number(fv?.score ?? fv?.ctx?.score ?? r.superScore) || null,
    tier: r.tier || null,
    x: featureRow,
  });
}
samples.sort((a, b) => a.tsIn - b.tsIn);

console.log(`[train-meta] resolved samples: ${samples.length} (timeout-as=${timeoutAs})`);
if (samples.length < MIN_N) {
  console.error(`[train-meta] INSUFFICIENT DATA: n=${samples.length} < min-n=${MIN_N}.`);
  console.error('[train-meta] Model artifact NAHI likha (plan E1: n>=300 chahiye). Baseline (calibrated rule score) hi use hota rahega.');
  process.exit(2);
}

const nFeat = META_FEATURES.length;

// ---------------- 2. standardize + logistic (L2, GD) ----------------
function trainLogistic(train, { l2 = L2, iters = ITERS, lr = LR } = {}) {
  const means = new Array(nFeat).fill(0);
  const stds = new Array(nFeat).fill(1);
  // means from non-null values; missing-count per feature
  for (let j = 0; j < nFeat; j++) {
    const vals = train.map((s) => s.x[j]).filter((v) => v != null);
    if (vals.length >= 10) {
      means[j] = vals.reduce((a, b) => a + b, 0) / vals.length;
      const varr = vals.reduce((a, b) => a + (b - means[j]) ** 2, 0) / vals.length;
      stds[j] = Math.sqrt(varr) > 1e-9 ? Math.sqrt(varr) : 1;
    }
  }
  const zOf = (s) => {
    const z = new Array(nFeat);
    for (let j = 0; j < nFeat; j++) {
      const v = s.x[j] == null ? means[j] : s.x[j];
      z[j] = (v - means[j]) / stds[j];
    }
    return z;
  };
  const Z = train.map(zOf);
  const w = new Array(nFeat).fill(0);
  let b = Math.log((train.filter((s) => s.y === 1).length + 1) / (train.length + 2));
  const N = train.length;
  for (let it = 0; it < iters; it++) {
    const gw = new Array(nFeat).fill(0);
    let gb = 0;
    for (let i = 0; i < N; i++) {
      let z = b;
      for (let j = 0; j < nFeat; j++) z += w[j] * Z[i][j];
      const p = 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
      const d = p - train[i].y;
      for (let j = 0; j < nFeat; j++) gw[j] += d * Z[i][j];
      gb += d;
    }
    for (let j = 0; j < nFeat; j++) w[j] -= (lr / N) * (gw[j] + l2 * w[j]);
    b -= (lr / N) * gb;
  }
  const predict = (s) => {
    const zz = zOf(s);
    let acc = b;
    for (let j = 0; j < nFeat; j++) acc += w[j] * zz[j];
    return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, acc))));
  };
  return { w, b, means, stds, predict };
}

// ---------------- metrics helpers ----------------
function auc(pairs) {
  const pos = pairs.filter((p) => p.y === 1).map((p) => p.p);
  const neg = pairs.filter((p) => p.y === 0).map((p) => p.p);
  if (!pos.length || !neg.length) return null;
  let wins = 0;
  let ties = 0;
  for (const a of pos) {
    for (const c of neg) {
      if (a > c) wins += 1;
      else if (a === c) ties += 1;
    }
  }
  return +((wins + 0.5 * ties) / (pos.length * neg.length)).toFixed(4);
}

// isotonic (PAVA) on (p, y) pairs → knots for inference
function isotonicKnots(pairs, { cap = 0.92 } = {}) {
  const rowsArr = pairs
    .filter((r) => Number.isFinite(r.p) && (r.y === 0 || r.y === 1))
    .sort((a, b) => a.p - b.p);
  if (rowsArr.length < 10) return null;
  const blocks = rowsArr.map((r) => ({ sum: r.y, n: 1, p: r.p }));
  let i = 0;
  while (i < blocks.length - 1) {
    if (blocks[i].sum / blocks[i].n > blocks[i + 1].sum / blocks[i + 1].n + 1e-12) {
      blocks[i] = {
        sum: blocks[i].sum + blocks[i + 1].sum,
        n: blocks[i].n + blocks[i + 1].n,
        p: (blocks[i].p * blocks[i].n + blocks[i + 1].p * blocks[i + 1].n) / (blocks[i].n + blocks[i + 1].n),
      };
      blocks.splice(i + 1, 1);
      if (i > 0) i--;
    } else i++;
  }
  return blocks.map((bl) => ({ p: +bl.p.toFixed(4), v: Math.min(cap, +(bl.sum / bl.n).toFixed(4)) }));
}

// ---------------- 3. FORWARD-ONLY walk-forward (OOS) ----------------
// v21.34.0 [TRUE WALK-FORWARD]: purgedWalkForwardSplit (blocked/purged CV)
// ke train me test-window ke BAAD wala data bhi aata tha — fold model
// future regime dekh kar OOS optimistic ho jata tha. Ab fold k ke train
// me SIRF wo samples jo test block START se pehle (embargo ke saath)
// EXIT kar chuke hain: tsOut < testStart − embargo. Fold 1 ka koi train
// nahi hota (uska test block sabse pehle hai) — honest skip.
const embargoMs = 60 * 60_000; // 1h default horizon-embargo (holdMin median)
const rawSplits = purgedWalkForwardSplit(samples, { folds: FOLDS, embargoMs });
// forward-only train projection per fold (same test blocks, no-future train)
const forwardCut = (fold) => {
  if (!fold?.test?.length) return null;
  const testStart = Math.min(...fold.test.map((s) => Number(s.tsIn) || 0));
  return testStart;
};
const splits = [];
for (const sp of rawSplits) {
  const testStart = forwardCut(sp);
  if (testStart == null) continue;
  const train = (sp.train || []).filter((s) => {
    const tsOut = Number.isFinite(Number(s.tsOut)) ? Number(s.tsOut) : Number(s.tsIn);
    return tsOut < testStart - embargoMs;
  });
  if (train.length >= 20 && sp.test.length > 0) splits.push({ fold: sp.fold, train, test: sp.test });
}
console.log(`[train-meta] forward-only walk-forward: ${splits.length}/${rawSplits.length} usable folds (embargo ${Math.round(embargoMs / 60000)}m · min-train 20/fold)`);
if (splits.length < 2) {
  console.error('[train-meta] splits insufficient — forward-only folds kam data me split nahi kar paye. Artifact nahi likha.');
  process.exit(2);
}

const oosPairsModel = [];
const oosPairsBaseline = [];
const foldReport = [];
for (const sp of splits) {
  if (!sp.train.length || !sp.test.length) continue;
  const model = trainLogistic(sp.train);
  const base = isotonicKnots(sp.train.map((s) => ({ p: Math.min(0.92, Math.max(0.01, (s.score ?? 50) / 100)), y: s.y })));
  for (const s of sp.test) {
    const pRaw = model.predict(s);
    oosPairsModel.push({ p: pRaw, y: s.y });
    // v21.34.0 [BASELINE INPUT FIX]: baseline ko RULE-SCORE input par
    // evaluate karo (jaise per-fold baseBrier karta hai) — model ke pRaw
    // par NAHI. pRaw feed karne se baseline ≈ isotonic(model) ban jata
    // tha aur acceptance gate self-comparison ho jata tha (brierBetter
    // lagbhag hamesha true — ek model jo sach me baseline se kharab hai
    // bhi artifact ban sakta tha).
    const scoreP = Math.min(0.92, Math.max(0.01, (s.score ?? 50) / 100));
    const bp = base ? interpolateIsotonic(base, scoreP) : null;
    oosPairsBaseline.push({ p: bp == null ? scoreP : bp, y: s.y });
  }
  foldReport.push({
    fold: sp.fold,
    trainN: sp.train.length,
    testN: sp.test.length,
    modelBrier: brierScore(sp.test.map((s) => ({ p: model.predict(s), y: s.y }))),
    baseBrier: brierScore(sp.test.map((s) => ({
      p: (() => {
        const scoreP = Math.min(0.92, Math.max(0.01, (s.score ?? 50) / 100));
        const bp = base ? interpolateIsotonic(base, scoreP) : null;
        return bp == null ? scoreP : bp;
      })(),
      y: s.y,
    }))),
  });
}

const oosBrierModel = brierScore(oosPairsModel);
const oosEceModel = expectedCalibrationError(oosPairsModel);
const oosAucModel = auc(oosPairsModel);
const oosBrierBase = brierScore(oosPairsBaseline);
const oosEceBase = expectedCalibrationError(oosPairsBaseline);
const oosAucBase = auc(oosPairsBaseline);

console.log('--- OOS (purged walk-forward) ---');
console.log(`  model   : Brier=${oosBrierModel?.toFixed(4)} ECE=${oosEceModel?.toFixed(4)} AUC=${oosAucModel?.toFixed(4)}`);
console.log(`  baseline: Brier=${oosBrierBase?.toFixed(4)} ECE=${oosEceBase?.toFixed(4)} AUC=${oosAucBase?.toFixed(4)}`);
for (const f of foldReport) {
  console.log(`  fold ${f.fold}: train=${f.trainN} test=${f.testN} brier model=${f.modelBrier?.toFixed(4)} base=${f.baseBrier?.toFixed(4)}`);
}

// ---------------- 4. acceptance gate (E3) ----------------
const brierBetter = oosBrierModel != null && oosBrierBase != null && oosBrierModel <= oosBrierBase;
const eceBetter = oosEceModel != null && oosEceBase != null && oosEceModel <= oosEceBase + 0.01;
const stableFolds = foldReport.filter((f) => f.modelBrier != null && f.baseBrier != null && f.modelBrier <= f.baseBrier + 0.02).length;
const stable = splits.length >= 3 ? stableFolds >= splits.length - 1 : stableFolds >= splits.length;
const passed = (brierBetter || eceBetter) && stable;

console.log('--- ACCEPTANCE (plan E3) ---');
console.log(`  n=${samples.length} (min ${MIN_N}) | brierBetter=${brierBetter} eceBetter=${eceBetter} stableFolds=${stableFolds}/${splits.length} → PASS=${passed}`);

if (!passed && !FORCE) {
  console.error('[train-meta] FAIL: OOS me baseline (calibrated rule score) ko beat nahi kiya.');
  console.error('[train-meta] Artifact NAHI likha — rules + calibrated score hi rahega (honest). --force se override mat karo bina soche.');
  process.exit(3);
}

// ---------------- 5. final model on ALL data + isotonic ----------------
const finalModel = trainLogistic(samples);
const rawPairs = samples.map((s) => ({ p: finalModel.predict(s), y: s.y }));
const isotonic = isotonicKnots(rawPairs);

// tier-wise thresholds: OOS expectancy-maximizing subject to min-trade count
function thresholdSearch(pairs) {
  const cands = [0.45, 0.50, 0.55, 0.60, 0.65, 0.70];
  let best = { thr: 0.55, exp: -Infinity, n: 0 };
  for (const thr of cands) {
    const taken = pairs.filter((p) => p.p >= thr);
    const n = taken.length;
    if (n < Math.max(30, pairs.length * 0.15)) continue; // avoid starving
    const exp = taken.reduce((s, p) => s + (p.y === 1 ? 1 : -1), 0) / n;
    if (exp > best.exp) best = { thr, exp: +exp.toFixed(4), n };
  }
  return best;
}
const thrOverall = thresholdSearch(oosPairsModel);
const thresholds = { default: thrOverall.thr, ELITE: thrOverall.thr, STRONG: thrOverall.thr, ACTION: thrOverall.thr, WATCH: thrOverall.thr };

const dateTag = new Date().toISOString().slice(0, 10);
const artifact = {
  schema: 'smartaipro-meta-model/1',
  version: `meta-${dateTag}`,
  trainedAt: new Date().toISOString(),
  n: samples.length,
  timeoutAs,
  features: META_FEATURES,
  weights: finalModel.w.map((v) => +v.toFixed(6)),
  bias: +finalModel.b.toFixed(6),
  means: finalModel.means.map((v) => +v.toFixed(6)),
  stds: finalModel.stds.map((v) => +v.toFixed(6)),
  isotonic,
  thresholds,
  metrics: {
    oos: {
      folds: splits.length,
      brier: oosBrierModel, ece: oosEceModel, auc: oosAucModel,
      baseline: { brier: oosBrierBase, ece: oosEceBase, auc: oosAucBase },
      stableFolds: `${stableFolds}/${splits.length}`,
      thresholdSearch: thrOverall,
    },
    acceptance: { passed, brierBetter, eceBetter, forced: FORCE === true },
  },
  hyperParams: { l2: L2, iters: ITERS, lr: LR, folds: FOLDS, embargoMs },
};

fs.mkdirSync(modelsDir, { recursive: true });
const outFile = path.join(modelsDir, `meta-${dateTag}.json`);
fs.writeFileSync(outFile, JSON.stringify(artifact, null, 2));
console.log(`[train-meta] PASS → artifact likha: ${outFile}`);
console.log('[train-meta] NEXT: META_MODEL=shadow karke A5 would-take/would-skip data collect karo; enforce FLAG-HISTORY typed-confirm ke baad hi.');
