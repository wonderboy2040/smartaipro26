// ============================================================
// server/ai/signalLedger.js — v20.9.0 SIGNAL LEDGER + CALIBRATION
// ------------------------------------------------------------
// AUDIT (B2): "Har SAPTA/ensemble signal ka ledger rakho: {ts, desk,
// symbol, side, aiScore, confidence, verifiedScore, mtfAgree, regime,
// outcomeR, fees}. Weekly job: verified-score aur confidence ke
// BUCKETS ke hisaab se win-rate, avg R, n, Wilson lower bound.
// Threshold wahi jahan bucket ka net avg R > 0 aur n >= 30."
//
// Ye module:
//   1. harvestTrade() — SAPTA journal rows + Bot Lab settle events ko
//      EK normalized ledger-row shape me convert karta hai (pure)
//   2. bucketCalibration() — verified-score / confidence buckets →
//      {n, winRate, wilsonLB, avgR} (pure) — H2 threshold change ab
//      DATA se justify hoga, gut-feel se nahi
//   3. recommendedThreshold() — wilsonLB>0.5 && netAvgR>0 && n>=minN
//      wala sabse UCHA bucket-score (walk-forward apply CALLER ki
//      zimmedari — ye module sirf REPORT deta hai, config kabhi
//      overwrite NAHI karta: audit "user-saved values silently
//      overwrite mat karo" rule)
//   4. plattScale() / isotonicFit() — B5 recalibration utilities
//   5. purgedWalkForwardSplit() — C2: overlapping trades ke beech
//      leakage rokne wala train/test split + embargo gap
// PURE functions only — in-memory arrays pe chalte hain, koi fs nahi.
// ============================================================
import { wilsonLowerBound } from '../risk/hardGate.js';

/** Normalize ek settled trade ko ledger-row me (SAPTA journal row ya
 *  Bot Lab settle event — dono shapes handle). PURE. */
export function harvestTrade(t) {
  if (!t || typeof t !== 'object') return null;
  // SAPTA shape: {ts, day, market, symbol, side, signal:{aiScore, conf,
  // verified, verifyAction, finalCall, mtfAgreePct}, closed:{pnlINR,
  // ts, exitPrice}, entryPrice, sl, ...}
  // Bot Lab shape: settle events {ts?, symbol, exitWhy, grossPnl, netPnl,
  // rNet, fees, candidate?...} — runner events me `at` ISO string hota hai.
  const ts = Number(t.closed?.ts ?? t.ts ?? t.closedTs ?? Date.parse(t.at ?? '') ?? 0) || 0;
  const symbol = String(t.symbol || '?');
  const side = String(t.side || t.candidate?.side || '?');
  const pnl = Number(t.closed?.pnlINR ?? t.pnlINR ?? t.netPnl ?? t.pnl);
  const rNet = Number(t.rNet ?? t.outcomeR);
  const fees = Number(t.fees ?? 0) || 0;
  const sig = t.signal || {};
  const aiScore = Number(sig.aiScore ?? t.aiScore);
  const confidence = Number(sig.conf ?? sig.confidence ?? t.confidence);
  const verifiedScore = Number(sig.verified ?? t.verifiedScore);
  const mtfAgreePct = Number(sig.mtfAgreePct ?? t.mtfAgreePct);
  if (!ts || !Number.isFinite(pnl)) return null;
  return {
    // v20.9.1 [L]: t.mode ('paper'/'live') desk fallback me tha — bucket
    // filtering by desk silently paper/live mix kar sakti thi; ab '?'.
    ts, desk: String(t.market || t.desk || '?'), symbol, side,
    aiScore: Number.isFinite(aiScore) ? aiScore : null,
    confidence: Number.isFinite(confidence) ? confidence : null,
    verifiedScore: Number.isFinite(verifiedScore) ? verifiedScore : null,
    mtfAgreePct: Number.isFinite(mtfAgreePct) ? mtfAgreePct : null,
    regime: t.regime ?? null,
    pnl, rNet: Number.isFinite(rNet) ? rNet : null, fees,
    win: pnl > 0,
  };
}

export const SCORE_BUCKETS = [
  { label: '<60', min: -Infinity, max: 60 },
  { label: '60-70', min: 60, max: 70 },
  { label: '70-80', min: 70, max: 80 },
  { label: '80+', min: 80, max: Infinity },
];

/** Bucket calibration table (audit B2). PURE.
 *  `field` = 'verifiedScore' | 'confidence' | 'aiScore'. */
export function bucketCalibration(ledger, { field = 'verifiedScore', buckets = SCORE_BUCKETS } = {}) {
  const rows = (Array.isArray(ledger) ? ledger : []).filter((r) => r && Number.isFinite(Number(r[field])));
  return buckets.map((b) => {
    const inB = rows.filter((r) => Number(r[field]) >= b.min && Number(r[field]) < b.max);
    const n = inB.length;
    const wins = inB.filter((r) => r.win).length;
    const rs = inB.map((r) => Number(r.rNet)).filter((x) => Number.isFinite(x));
    return {
      bucket: b.label, field, n,
      winRate: n ? wins / n : null,
      wilsonLB: n ? wilsonLowerBound(wins, n) : null,
      avgR: rs.length ? rs.reduce((a, b2) => a + b2, 0) / rs.length : null,
      netPnl: inB.reduce((a, r) => a + (Number(r.pnl) || 0), 0),
    };
  });
}

/** Data-driven threshold recommendation (audit B2: "Threshold wahi jahan
 *  bucket ka net avg R > 0 aur n >= 30"). REPORT ONLY — apply karne se
 *  pehle walk-forward OOS validation caller pe; saved user config kabhi
 *  overwrite nahi hota. Returns null jab koi bucket qualify na kare. */
export function recommendedThreshold(ledger, { field = 'verifiedScore', minN = 30 } = {}) {
  const cal = bucketCalibration(ledger, { field });
  let best = null;
  for (const b of cal) {
    if (b.n < minN) continue;
    if (b.wilsonLB == null || b.wilsonLB <= 0.5) continue;   // edge not established
    if (b.avgR == null || b.avgR <= 0) continue;              // net R must be positive
    const floor = b.bucket === '<60' ? 0 : b.bucket === '80+' ? 80 : Number(String(b.bucket).split('-')[0]);
    if (best == null || floor > best.threshold) best = { threshold: floor, bucket: b.bucket, n: b.n, wilsonLB: b.wilsonLB, avgR: b.avgR };
  }
  return best;
}

// ------------------------------------------------------------
// B5 — probability recalibration (out-of-sample)
// ------------------------------------------------------------

/** Platt scaling: 1D logistic fit claimed-prob → actual outcome.
 *  inputs: [{p: claimedWinProb, y: 0|1}]. Returns {a, b} with
 *  calibrated = σ(A·p+B) = 1/(1+exp(-(A·p+B))) — v20.9.1: doc-comment
 *  pehle ulta sign likh raha tha (fit+apply dono σ(A·p+B) use karte hain,
 *  self-consistent tha, sirf comment galat tha).
 *  Newton me nahi — gradient descent (100 iter), deterministic init. */
export function plattScale(inputs, { iters = 200, lr = 0.5 } = {}) {
  const rows = (Array.isArray(inputs) ? inputs : [])
    .filter((r) => Number.isFinite(Number(r?.p)) && (r?.y === 0 || r?.y === 1));
  if (rows.length < 10) return null; // too little data — honest refusal
  // target smoothing (Platt's own recommendation avoids 0/1 extremes)
  const yPlus = 1, yMinus = 0;
  let A = 0, B = Math.log((rows.filter((r) => r.y === 1).length + 1) / (rows.length + 2));
  for (let it = 0; it < iters; it++) {
    let gA = 0, gB = 0;
    for (const r of rows) {
      const p = Math.min(0.999, Math.max(0.001, Number(r.p)));
      const z = A * p + B;
      const phat = 1 / (1 + Math.exp(-z));
      const y = r.y === 1 ? yPlus : yMinus;
      gA += (phat - y) * p;
      gB += (phat - y);
    }
    A -= (lr / rows.length) * gA;
    B -= (lr / rows.length) * gB;
  }
  return {
    a: Math.round(A * 1e4) / 1e4, b: Math.round(B * 1e4) / 1e4, n: rows.length,
    apply: (p) => {
      const v = 1 / (1 + Math.exp(-(A * Number(p) + B)));
      return Math.min(0.92, Math.max(0.01, Math.round(v * 1e4) / 1e4)); // cap 92% (audit B5)
    },
  };
}

/** Isotonic regression (PAVA) — monotone non-decreasing calibration map.
 *  inputs: [{p, y}]. Returns {knots: [{p, v}], apply} — piecewise-linear
 *  lookup, clamped, capped 92%. */
export function isotonicFit(inputs, { cap = 0.92 } = {}) {
  const rows = (Array.isArray(inputs) ? inputs : [])
    .filter((r) => Number.isFinite(Number(r?.p)) && (r?.y === 0 || r?.y === 1))
    .sort((x, y2) => Number(x.p) - Number(y2.p));
  if (rows.length < 10) return null;
  // PAVA: pool adjacent violators
  const blocks = rows.map((r) => ({ sum: r.y === 1 ? 1 : 0, n: 1, p: Number(r.p) }));
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
  const knots = blocks.map((b) => ({ p: b.p, v: Math.min(cap, b.sum / b.n) }));
  const apply = (p) => {
    const x = Number(p);
    if (!Number.isFinite(x)) return null;
    if (x <= knots[0].p) return knots[0].v;
    if (x >= knots[knots.length - 1].p) return knots[knots.length - 1].v;
    for (let k = 0; k < knots.length - 1; k++) {
      if (x >= knots[k].p && x <= knots[k + 1].p) {
        const t = (x - knots[k].p) / Math.max(1e-12, knots[k + 1].p - knots[k].p);
        return Math.round((knots[k].v + t * (knots[k + 1].v - knots[k].v)) * 1e4) / 1e4;
      }
    }
    return knots[knots.length - 1].v;
  };
  return { knots, apply, n: rows.length };
}

// ------------------------------------------------------------
// C2 — purged walk-forward split with embargo
// ------------------------------------------------------------

/** Purged K-fold split (audit C2: overlapping trades ki wajah se leakage
 *  rokne ke liye train/test ke beech gap). `tsIn`/`tsOut` per trade,
 *  embargoMs test-window ki DONO sides pe gap (default = ek 5m bar) —
 *  v20.9.1 [H3]: pehle sirf LEFT side embargo tha; test fold ke LAST
 *  trade ke baad train ka trade turant aa sakta tha jabki overlap window
 *  (tsOut > tsIn) abhi khuli thi — right-edge leakage OOS calibration
 *  ko optimistic banati thi (de Prado purge+embargo dono sides). */
export function purgedWalkForwardSplit(trades, { folds = 4, embargoMs = 5 * 60000 } = {}) {
  const list = (Array.isArray(trades) ? trades : [])
    .filter((t) => Number.isFinite(Number(t.tsIn)))
    .sort((a, b) => Number(a.tsIn) - Number(b.tsIn));
  if (list.length < folds * 10) return []; // not enough data — honest empty
  const out = [];
  for (let k = 1; k <= folds; k++) {
    const cutStart = list[Math.floor((list.length * (k - 1)) / folds)].tsIn;
    const cutEnd = list[Math.min(list.length - 1, Math.floor((list.length * k) / folds))].tsIn;
    const test = list.filter((t) => t.tsIn >= cutStart && t.tsIn < cutEnd);
    // PURGE: train me wo trades jo test window ke andar ya uske EMBARGO
    // me OVERLAP karte hain (tsOut > testStart - embargo) nahi aa sakte;
    // RIGHT side: test ke baad wale train trades ko bhi embargo milega
    // (tsIn >= testEnd + embargoMs) taki still-open test trades ke
    // overlap window me train na ghus sake.
    const testStart = cutStart, testEnd = cutEnd;
    const train = list.filter((t) => {
      const tsOut = Number.isFinite(Number(t.tsOut)) ? Number(t.tsOut) : Number(t.tsIn);
      return tsOut < testStart - embargoMs || t.tsIn >= testEnd + embargoMs;
    });
    out.push({ fold: k, train, test });
  }
  return out;
}

// ------------------------------------------------------------
// Phase 3 — Ledger-Based MTF Direction Scorecard (30d rolling)
// ------------------------------------------------------------
const _mtfScanLedger = [];
const _mtfScanDedup = new Map(); // `${market}:${sym}:${mode}:${bucket30m}` -> id
const MTF_SCAN_MAX = 1500;
const DEDUP_BUCKET_MS = 30 * 60_000; // 30 minutes
// Persistence metadata — mtfRowLedgerStore inhe file me likhta hai.
let _lastLogAt = null;
let _lastResolveAt = null;

const _r2 = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 100) / 100 : null);
// v21.32.0 [PHASE A3]: nullable number — missing data KABHI 0 nahi banata
// ("unknown" ≠ "zero", C4 hygiene rule).
const _nn = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const _nn2 = (v) => { const n = _nn(v); return n == null ? null : Math.round(n * 100) / 100; };

// v21.32.0 [PHASE A4]: Wilson 95% CI + deterministic bootstrap CI —
// scorecard v2 ke liye (scripts/lib/stats.js ke saath same math; server
// ka apna copy taaki server → scripts dependency na ho).
function _wilsonCI(k, n, z = 1.96) {
  if (!n) return { lo: null, hi: null };
  const p = k / n, d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return { lo: Math.max(0, c - h), hi: Math.min(1, c + h) };
}
function _bootstrapCI(xs, iters = 2000, seed = 1) {
  if (!Array.isArray(xs) || xs.length === 0) return { lo: null, hi: null };
  let s = Math.abs(Math.floor(seed)) % 4294967296 || 1;
  const rnd = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
  const means = [];
  for (let i = 0; i < iters; i++) {
    let sum = 0;
    for (let j = 0; j < xs.length; j++) sum += xs[(rnd() * xs.length) | 0];
    means.push(sum / xs.length);
  }
  means.sort((a, b) => a - b);
  return { lo: means[(iters * 0.025) | 0], hi: means[(iters * 0.975) | 0] };
}
/** A1 min-n gate (ACCURACY-DEFINITIONS.md §3). */
export function minNGate(n) {
  const k = Math.max(0, Math.floor(Number(n) || 0));
  if (k < 30) return { state: 'insufficient', decisionGrade: false, reviewable: false };
  if (k < 100) return { state: 'early', decisionGrade: false, reviewable: false };
  if (k < 150) return { state: 'reviewable', decisionGrade: false, reviewable: true };
  return { state: 'decision-grade', decisionGrade: true, reviewable: true };
}
// v21.25.2: market bhi key me — CRYPTO BTC aur FUTURES BTC same 30m
// bucket me ek doosre ko dedup NAHI kar sakte (pehle sirf symbol+mode tha).
const _mtfDedupKey = (market, symbol, mode, ts) => (
  `${String(market || 'CRYPTO').toUpperCase()}:${String(symbol || '').toUpperCase()}:`
  + `${String(mode || 'INTRADAY').toUpperCase()}:${Math.floor((Number(ts) || 0) / DEDUP_BUCKET_MS)}`
);

/**
 * 3.1 Log every MTF Dual Board top-6 row into the MTF scan ledger
 * (deduped per symbol + mode + 30-minute bucket).
 */
export function recordMtfBoardScanRow(row, { now = Date.now() } = {}) {
  if (!row || typeof row !== 'object') return null;
  const symbol = String(row.symbol || '').toUpperCase().trim();
  const side = String(row.side || '').toUpperCase();
  if (!symbol || (side !== 'LONG' && side !== 'SHORT')) return null;
  const entry = Number(row.plan?.entry ?? row.ltp ?? 0);
  const stopLoss = Number(row.plan?.stopLoss ?? 0);
  const t1 = Number(row.plan?.t1 ?? 0);
  const t2 = Number(row.plan?.t2 ?? 0);
  if (!(entry > 0) || !(stopLoss > 0) || !(t1 > 0)) return null;

  const mode = String(row.mode || 'INTRADAY').toUpperCase();
  const market = String(row.market || 'CRYPTO').toUpperCase();
  const ts = Number(now) || Date.now();
  const dedupKey = _mtfDedupKey(market, symbol, mode, ts);
  if (_mtfScanDedup.has(dedupKey)) {
    const existingId = _mtfScanDedup.get(dedupKey);
    const existing = _mtfScanLedger.find((e) => e.id === existingId);
    if (existing) return existing;
    // v21.25.2: row cap ne purani entry trim kar di — stale dedup id
    // ko clear karke naya record banao (pehle null return hota tha aur
    // bucket permanently "recorded" dikhta tha).
    _mtfScanDedup.delete(dedupKey);
  }

  const risk = Math.max(entry * 0.001, Math.abs(entry - stopLoss));
  // v21.32.0 [PHASE A3]: lookahead-free feature snapshot — SIRF signal
  // time tak ka data (jo row ne decision ke liye use kiya wahi record).
  const ctx = row.context && typeof row.context === 'object' ? row.context : {};
  const trig = row.trigger && typeof row.trigger === 'object' ? row.trigger : {};
  // v21.33.0 [PHASE C fv:2]: board ne decision-grade featureVector diya
  // (closed bars, non-repainting) to uske naye fields snapshot me merge —
  // legacy v1 rows hydrate se migrate hote aaye hain, v2 rows fv:2.
  const fv2 = row.featureVector && typeof row.featureVector === 'object' && Number(row.featureVector.fv) === 2
    ? row.featureVector
    : null;
  const featureSnapshot = {
    fv: fv2 ? 2 : 1,
    tier: row.tier || null,
    superScore: _nn(row.superScore),
    regime: row.regime ?? null,
    family: row.family ?? null,
    ctx: {
      dir: _nn(ctx.dir), score: _nn(ctx.score), adx: _nn2(ctx.adx),
      atrPct: _nn2(ctx.atrPct), rsi: _nn2(ctx.rsi), barsInTrend: _nn(ctx.barsInTrend),
      exhausted: typeof ctx.exhausted === 'boolean' ? ctx.exhausted : null,
      squeeze: typeof ctx.squeeze === 'boolean' ? ctx.squeeze : null,
      squeezeFired: typeof ctx.squeezeFired === 'boolean' ? ctx.squeezeFired : null,
      bbWidthPct: _nn2(ctx.bbWidthPct), er: _nn2(ctx.er),
    },
    trig: {
      dir: _nn(trig.dir), score: _nn(trig.score), volRatio: _nn2(trig.volRatio),
      bodyPct: _nn2(trig.bodyPct), rsi: _nn2(trig.rsi),
      overextended: typeof trig.overextended === 'boolean' ? trig.overextended : null,
      pullbackReclaim: typeof trig.pullbackReclaim === 'boolean' ? trig.pullbackReclaim : null,
      reversalRisk: typeof trig.reversalRisk === 'boolean' ? trig.reversalRisk : null,
    },
    // fv:2 direct fields (featureRowFromSnapshot metaModel in dono shapes
    // samajhta hai — nested ctx/trig + ye flat fields).
    ...(fv2 ? {
      realizedVolRatio: _nn2(fv2.realizedVolRatio),
      rsiDivergence: fv2.rsiDivergence && typeof fv2.rsiDivergence === 'object'
        ? { kind: fv2.rsiDivergence.kind ?? 'NONE' } : null,
      macdDivergence: fv2.macdDivergence && typeof fv2.macdDivergence === 'object'
        ? { kind: fv2.macdDivergence.kind ?? 'NONE' } : null,
      relativeStrength: fv2.relativeStrength && typeof fv2.relativeStrength === 'object'
        ? {
          rsSpread: _nn2(fv2.relativeStrength.rsSpread), beta: _nn2(fv2.relativeStrength.beta),
          corr: _nn2(fv2.relativeStrength.corr),
        } : null,
      session: fv2.session && typeof fv2.session === 'object'
        ? {
          hourOfDay: _nn(fv2.session.hourOfDay), hourBucket: fv2.session.hourBucket ?? null,
          dayOfWeek: _nn(fv2.session.dayOfWeek), minutesToFunding: _nn(fv2.session.minutesToFunding),
        } : null,
      barShape: fv2.barShape && typeof fv2.barShape === 'object'
        ? { bodyPct: _nn2(fv2.barShape.bodyPct), clv: _nn2(fv2.barShape.clv) } : null,
      fundingBps8h: _nn2(fv2.fundingBps8h),
      longShortRatio: _nn2(fv2.longShortRatio),
      basisPct: _nn2(fv2.basisPct),
      spreadBps: _nn2(fv2.spreadBps),
    } : {}),
  };
  // pWinClaimed 0–1 fraction (ECE/Brier in ke saath chalte hain).
  const pWinPct = _nn(row.pWinCalibrated) ?? _nn(row.winRatePct);
  const pWinClaimed = pWinPct != null ? Math.min(1, Math.max(0, pWinPct / 100)) : null;
  const rec = {
    id: `mtf-${symbol}-${mode}-${ts}-${Math.random().toString(36).slice(2, 7)}`,
    symbol,
    market,
    mode,
    side,
    boardSide: row.boardSide ?? row.signals?.board?.side ?? null,
    boardSideConflict: Boolean(row.boardSideConflict),
    svaConflict: Boolean(row.svaConflict),
    councilConflict: Boolean(row.councilConflict),
    directionVerified: Boolean(row.directionVerified),
    superScore: Number(row.superScore) || 0,
    tier: row.tier || null,
    family: row.family ?? null,
    entry,
    stopLoss,
    t1,
    t2: t2 > 0 ? t2 : t1,
    risk,
    holdMin: Number(row.holdMin) || (mode === 'SWING' ? 240 : 60),
    ts,
    peakFavPrice: entry,
    peakAdvPrice: entry,
    mfeR: 0,
    maeR: 0,
    resolved: false,
    resolvedAt: null,
    outcome: 'PENDING', // 'T1_HIT' | 'T2_HIT' | 'SL_HIT' | 'TIMEOUT' | 'PENDING'
    outcomeR: null,
    directionHit: null,
    // v21.28.0 [F1/F4 TELEMETRY]: forming vs last-closed bar snapshot +
    // exact-ish TP1/TP2 touch times (resolve sweep time se alag).
    signalAtOpenBar: row.barConfirmation?.openBar ?? null,
    signalAtCloseBar: row.barConfirmation?.closeBar ?? null,
    signalStable: typeof row.barConfirmation?.stable === 'boolean' ? row.barConfirmation.stable : null,
    t1HitAt: null,
    t2HitAt: null,
    // v21.32.0 [PHASE A3 — LEDGER SCHEMA v2 ENRICHMENT]
    // (ACCURACY-DEFINITIONS.md §7; hydrateMtfLedger v1 rows ko migrate karta hai)
    schemaVersion: 2,
    regime: row.regime ?? null,
    featureSnapshot,
    pWinClaimed,
    closedBarConfirmed: typeof row.barConfirmation?.stable === 'boolean' ? row.barConfirmation.stable : null,
    spreadBps: _nn2(row.spreadBps ?? row.execution?.spreadBps ?? row.telemetry?.spreadBps),
    liquidityUSD: _nn(row.liquidityUSD ?? row.execution?.liquidityUSD ?? row.telemetry?.liquidityUSD),
    fundingBps8h: _nn2(row.fundingBps8h ?? row.perpIntel?.fundingBps8h ?? row.telemetry?.fundingBps8h),
    perpDataStatus: row.perpDataStatus ?? row.perpIntel?.status ?? row.telemetry?.perpDataStatus ?? null,
    eventWindow: row.eventWindow ?? row.telemetry?.eventWindow ?? null,
    filtersFired: Array.isArray(row.filtersFired)
      ? row.filtersFired.slice(0, 24).map((f) => ({
        guard: String(f?.guard ?? f?.name ?? '?').slice(0, 40),
        verdict: String(f?.verdict ?? f?.mode ?? 'unknown').slice(0, 16),
        reason: f?.reason ? String(f.reason).slice(0, 120) : null,
      }))
      : [],
    latencyMs: Number(row.builtAt) > 0 ? Math.max(0, Math.round(ts - Number(row.builtAt))) : null,
  };
  _mtfScanLedger.push(rec);
  _mtfScanDedup.set(dedupKey, rec.id);
  _lastLogAt = ts;
  while (_mtfScanLedger.length > MTF_SCAN_MAX) {
    const dropped = _mtfScanLedger.shift();
    if (dropped) {
      _mtfScanDedup.delete(_mtfDedupKey(dropped.market, dropped.symbol, dropped.mode, dropped.ts));
    }
  }
  return rec;
}

/**
 * 3.2 Update MFE/MAE and resolve MTF scan ledger rows against live quotes or OHLC candles.
 */
export function resolveMtfBoardScanOutcomes({ quotes = {}, candlesBySymbol = {}, now = Date.now() } = {}) {
  let updated = 0;
  let resolvedNow = 0;
  for (const e of _mtfScanLedger) {
    if (e.resolved) continue;
    const isLong = e.side === 'LONG';
    const qRaw = quotes[e.symbol] ?? quotes[`${e.market}|${e.symbol}`];
    const ltp = typeof qRaw === 'object' ? Number(qRaw?.price ?? qRaw?.ltp) : Number(qRaw);
    const candles = Array.isArray(candlesBySymbol[e.symbol]) ? candlesBySymbol[e.symbol] : [];

    const checkPriceRange = (highPx, lowPx, barTime = null) => {
      if (!(highPx > 0) || !(lowPx > 0)) return;
      const rawTime = Number(barTime);
      const hitAt = rawTime > 0
        ? Math.max(Number(e.ts) || 0, rawTime < 1e11 ? rawTime * 1000 : rawTime)
        : now;
      if (isLong) {
        if (highPx > e.peakFavPrice) e.peakFavPrice = highPx;
        if (lowPx < e.peakAdvPrice) e.peakAdvPrice = lowPx;
      } else {
        if (lowPx < e.peakFavPrice) e.peakFavPrice = lowPx;
        if (highPx > e.peakAdvPrice) e.peakAdvPrice = highPx;
      }
      const favMove = isLong ? Math.max(0, e.peakFavPrice - e.entry) : Math.max(0, e.entry - e.peakFavPrice);
      const advMove = isLong ? Math.max(0, e.entry - e.peakAdvPrice) : Math.max(0, e.peakAdvPrice - e.entry);
      e.mfeR = _r2(favMove / e.risk) ?? 0;
      e.maeR = _r2(advMove / e.risk) ?? 0;

      const hitSl = isLong ? lowPx <= e.stopLoss : highPx >= e.stopLoss;
      const hitT2 = e.t2 > 0 && (isLong ? highPx >= e.t2 : lowPx <= e.t2);
      const hitT1 = isLong ? highPx >= e.t1 : lowPx <= e.t1;

      if (hitSl && !hitT1) {
        e.resolved = true;
        e.resolvedAt = now;
        e.outcome = 'SL_HIT';
        e.outcomeR = -1;
        e.directionHit = false;
        resolvedNow++;
      } else if (hitT2) {
        e.resolved = true;
        e.resolvedAt = now;
        e.outcome = 'T2_HIT';
        e.outcomeR = _r2(Math.abs(e.t2 - e.entry) / e.risk) ?? 2;
        e.directionHit = true;
        if (!(Number(e.t1HitAt) > 0)) e.t1HitAt = hitAt;
        e.t2HitAt = hitAt;
        resolvedNow++;
      } else if (hitT1) {
        e.resolved = true;
        e.resolvedAt = now;
        e.outcome = 'T1_HIT';
        e.outcomeR = _r2(Math.abs(e.t1 - e.entry) / e.risk) ?? 1;
        e.directionHit = true;
        e.t1HitAt = hitAt;
        resolvedNow++;
      }
    };

    for (const c of candles) {
      if (e.resolved) break;
      const cTs = Number(c?.ts ?? c?.time ?? c?.t ?? c?.timestamp);
      const cTsMs = cTs > 0 ? (cTs < 1e11 ? cTs * 1000 : cTs) : null;
      if (cTsMs != null && cTsMs < e.ts) continue;
      checkPriceRange(Number(c.high ?? c.close), Number(c.low ?? c.close), cTsMs);
      updated++;
    }
    if (!e.resolved && Number(ltp) > 0) {
      checkPriceRange(ltp, ltp, now);
      updated++;
    }

    const elapsedMin = Math.max(0, (now - e.ts) / 60_000);
    if (!e.resolved && elapsedMin >= e.holdMin) {
      e.resolved = true;
      e.resolvedAt = now;
      e.outcome = 'TIMEOUT';
      const endPx = Number(ltp) > 0 ? Number(ltp) : e.peakFavPrice;
      const signedMove = isLong ? (endPx - e.entry) : (e.entry - endPx);
      e.outcomeR = _r2(signedMove / e.risk) ?? 0;
      e.directionHit = (e.mfeR >= 0.5 && e.maeR < 1.0) || e.outcomeR > 0;
      resolvedNow++;
    }
  }
  if (resolvedNow > 0) _lastResolveAt = Number(now) || Date.now();
  return { updated, resolvedNow, total: _mtfScanLedger.length };
}

/**
 * 3.3 Compute 30-day rolling MTF Direction Scorecard for UI & API.
 */
export function computeMtfDirectionScorecard({ windowDays = 30, now = Date.now() } = {}) {
  const cutoff = now - Math.max(1, Number(windowDays) || 30) * 86_400_000;
  const rows = _mtfScanLedger.filter((r) => r.ts >= cutoff);
  const resolved = rows.filter((r) => r.resolved);
  const alignedResolved = resolved.filter((r) => !r.boardSideConflict && !r.svaConflict && !r.councilConflict);
  const conflictResolved = resolved.filter((r) => r.boardSideConflict || r.svaConflict || r.councilConflict);

  const summarize = (list) => {
    const n = list.length;
    if (n === 0) {
      return {
        n: 0,
        directionHitRate: null,
        t1HitPct: null,
        slFirstPct: null,
        wrongWayRate: null,
        avgR: null,
        wilsonLB: null,
        // v21.28.0 per-tier comparison fields (Phase 0 baseline parity)
        tp1Hits: 0,
        tp2Hits: 0,
        stopOuts: 0,
        tp1HitPct: null,
        tp2HitPct: null,
        stopOutPct: null,
        expectancyR: null,
        avgMfeR: null,
        avgMaeR: null,
        avgTimeToTp1Min: null,
        directionHitPct: null,
      };
    }
    const dirHits = list.filter((r) => r.directionHit || r.outcome === 'T1_HIT' || r.outcome === 'T2_HIT' || (r.mfeR >= 0.5 && r.outcome !== 'SL_HIT')).length;
    const tp1List = list.filter((r) => r.outcome === 'T1_HIT' || r.outcome === 'T2_HIT');
    const tp2List = list.filter((r) => r.outcome === 'T2_HIT');
    const slList = list.filter((r) => r.outcome === 'SL_HIT');
    const t1Hits = tp1List.length;
    const slHits = slList.length;
    const wrongWay = list.filter((r) => r.outcome === 'SL_HIT' && Number(r.mfeR) < 0.25).length;
    const rs = list.map((r) => Number(r.outcomeR)).filter((x) => Number.isFinite(x));
    const mfes = list.map((r) => Number(r.mfeR)).filter((x) => Number.isFinite(x));
    const maes = list.map((r) => Number(r.maeR)).filter((x) => Number.isFinite(x));
    // t1HitAt exact-ish touch hai; purane rows ke liye resolvedAt fallback.
    const tt1 = tp1List
      .map((r) => {
        const at = Number(r.t1HitAt) > 0 ? Number(r.t1HitAt) : Number(r.resolvedAt);
        return at > 0 && Number(r.ts) > 0 ? Math.max(0, at - Number(r.ts)) / 60_000 : null;
      })
      .filter((v) => v != null);
    const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
    return {
      n,
      directionHitRate: _r2((dirHits / n) * 100),
      t1HitPct: _r2((t1Hits / n) * 100),
      slFirstPct: _r2((slHits / n) * 100),
      wrongWayRate: _r2((wrongWay / n) * 100),
      avgR: rs.length ? _r2(rs.reduce((a, b) => a + b, 0) / rs.length) : null,
      wilsonLB: _r2(wilsonLowerBound(t1Hits, n) * 100),
      tp1Hits: t1Hits,
      tp2Hits: tp2List.length,
      stopOuts: slHits,
      tp1HitPct: _r2((t1Hits / n) * 100),
      tp2HitPct: _r2((tp2List.length / n) * 100),
      stopOutPct: _r2((slHits / n) * 100),
      // Expectancy aur avgR same universe par hain (1R = planned risk) —
      // alag-alag label isliye ki UI me "expectancy" ka matlab clear rahe.
      expectancyR: rs.length ? _r2(rs.reduce((a, b) => a + b, 0) / rs.length) : null,
      avgMfeR: mfes.length ? _r2(avg(mfes)) : null,
      avgMaeR: maes.length ? _r2(avg(maes)) : null,
      avgTimeToTp1Min: tt1.length ? _r2(avg(tt1)) : null,
      directionHitPct: _r2((list.filter((r) => r.directionHit === true).length / n) * 100),
    };
  };

  const overall = summarize(resolved);
  const alignedBucket = summarize(alignedResolved);
  const conflictBucket = summarize(conflictResolved);
  // v21.28.0: per-tier split — WATCH vs ACTION/STRONG/ELITE ka expectancy
  // alag dikhna chahiye. Ek blended number tier-mix se distort hota tha.
  const byTier = {};
  const tierNames = [...new Set(rows.map((r) => String(r.tier || 'UNKNOWN').toUpperCase()))].sort();
  for (const t of tierNames) {
    byTier[t] = summarize(rows.filter((r) => String(r.tier || 'UNKNOWN').toUpperCase() === t));
  }

  return {
    windowDays,
    totalScans: rows.length,
    resolvedCount: resolved.length,
    pendingCount: rows.length - resolved.length,
    calibrated: resolved.length >= 20,
    ...overall,
    alignedBucket,
    conflictBucket,
    byTier,
    recentScans: rows.slice(-12).reverse(),
  };
}

/**
 * 3.3b v21.32.0 [PHASE A4] — SCORECARD V2 (tier × desk × regime × side × session).
 * ACCURACY-DEFINITIONS.md §5 ke exactly hisaab se: per-slice n, Hit-TP1
 * (Wilson 95% CI), Hit-TP2, Stop-rate, TIMEOUT-rate, expectancy R
 * (bootstrap 95% CI), PF, MFE/MAE medians, ECE/Brier (jab pWinClaimed
 * available ho), avg time-to-TP1, stability %, min-n gate state.
 * PURE — in-memory ledger par, koi IO nahi.
 */
function _istSession(ts) {
  const t = Number(ts) > 0 ? Number(ts) : 0;
  if (!t) return 'unknown';
  const istMs = t + (5 * 60 + 30) * 60_000; // IST = UTC+5:30
  const d = new Date(istMs);
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (d.getUTCDay() === 6 || d.getUTCDay() === 0) return 'weekend';
  if (mins <= 9 * 60 + 15) return 'pre-open';
  if (mins <= 11 * 60) return 'morning';
  if (mins <= 14 * 60) return 'midday';
  if (mins <= 15 * 60 + 30) return 'close';
  if (mins <= 18 * 60) return 'after';
  return 'night';
}

const _median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return _r2(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2);
};

export function computeMtfDirectionScorecardV2({ windowDays = 30, now = Date.now() } = {}) {
  const cutoff = now - Math.max(1, Number(windowDays) || 30) * 86_400_000;
  const rows = _mtfScanLedger.filter((r) => r.ts >= cutoff);

  const summarizeV2 = (list) => {
    const n = list.length;
    const gate = minNGate(n);
    if (n === 0) {
      return { n: 0, gate, hitTp1Pct: null, hitTp1WilsonCI: null, hitTp2Pct: null, stopRatePct: null, timeoutRatePct: null, expectancyR: null, expectancyBootstrapCI: null, profitFactor: null, medianMfeR: null, medianMaeR: null, ece: null, brier: null, avgTimeToTp1Min: null, stabilityPct: null };
    }
    const tp1List = list.filter((r) => r.outcome === 'T1_HIT' || r.outcome === 'T2_HIT');
    const tp2List = list.filter((r) => r.outcome === 'T2_HIT');
    const slList = list.filter((r) => r.outcome === 'SL_HIT');
    const toList = list.filter((r) => r.outcome === 'TIMEOUT');
    const tp1Hits = tp1List.length;
    const rs = list.map((r) => Number(r.outcomeR)).filter((x) => Number.isFinite(x));
    const wilsonCI = _wilsonCI(tp1Hits, n);
    const bci = rs.length ? _bootstrapCI(rs, 2000, 7) : { lo: null, hi: null };
    // ECE / Brier — sirf us subset par jisme claimed pWin tha (honest:
    // missing pWin ko 0/0.5 assume nahi karte).
    const probPairs = list
      // v21.32.0 fix: Number(null)===0 hota hai — null ko explicitly exclude
      // karo warna missing pWin claimed-0 ban jaata tha (eceN inflation).
      .filter((r) => r.pWinClaimed != null && Number.isFinite(Number(r.pWinClaimed)))
      .map((r) => ({ p: Number(r.pWinClaimed), y: (r.outcome === 'T1_HIT' || r.outcome === 'T2_HIT') ? 1 : 0 }));
    let ece = null, brier = null;
    if (probPairs.length >= 10) {
      const nb = 10, sums = new Array(nb).fill(0).map(() => ({ p: 0, y: 0, n: 0 }));
      for (const pr of probPairs) {
        const idx = Math.min(nb - 1, Math.max(0, Math.floor(pr.p * nb)));
        sums[idx].p += pr.p; sums[idx].y += pr.y; sums[idx].n += 1;
      }
      ece = 0;
      for (const b of sums) { if (!b.n) continue; ece += (b.n / probPairs.length) * Math.abs(b.p / b.n - b.y / b.n); }
      brier = _r2(probPairs.reduce((s, pr) => s + (pr.p - pr.y) ** 2, 0) / probPairs.length);
      ece = _r2(ece);
    }
    const tt1 = tp1List
      .map((r) => {
        const at = Number(r.t1HitAt) > 0 ? Number(r.t1HitAt) : Number(r.resolvedAt);
        return at > 0 && Number(r.ts) > 0 ? Math.max(0, at - Number(r.ts)) / 60_000 : null;
      })
      .filter((v) => v != null);
    const stab = list.filter((r) => r.signalStable === true).length;
    return {
      n,
      gate,
      hitTp1Pct: _r2((tp1Hits / n) * 100),
      hitTp1WilsonCI: { lo: _r2(wilsonCI.lo * 100), hi: _r2(wilsonCI.hi * 100) },
      hitTp2Pct: _r2((tp2List.length / n) * 100),
      stopRatePct: _r2((slList.length / n) * 100),
      timeoutRatePct: _r2((toList.length / n) * 100),
      expectancyR: rs.length ? _r2(rs.reduce((a, b) => a + b, 0) / rs.length) : null,
      expectancyBootstrapCI: { lo: _r2(bci.lo), hi: _r2(bci.hi) },
      profitFactor: (() => {
        const wins = rs.filter((x) => x > 0).reduce((a, b) => a + b, 0);
        const losses = rs.filter((x) => x < 0).reduce((a, b) => a + b, 0);
        return losses === 0 ? null : _r2(wins / Math.abs(losses));
      })(),
      medianMfeR: _median(list.map((r) => Number(r.mfeR)).filter(Number.isFinite)),
      medianMaeR: _median(list.map((r) => Number(r.maeR)).filter(Number.isFinite)),
      ece,
      brier,
      eceN: probPairs.length,
      avgTimeToTp1Min: tt1.length ? _r2(tt1.reduce((a, b) => a + b, 0) / tt1.length) : null,
      stabilityPct: _r2((stab / n) * 100),
    };
  };

  const groupBy = (fn) => {
    const out = {};
    for (const r of rows) {
      const k = fn(r);
      if (k == null) continue;
      (out[k] = out[k] || []).push(r);
    }
    for (const k of Object.keys(out)) out[k] = summarizeV2(out[k]);
    return out;
  };

  const resolved = rows.filter((r) => r.resolved);
  return {
    version: 2,
    windowDays,
    generatedAt: Number(now),
    overall: summarizeV2(resolved),
    byTier: groupBy((r) => String(r.tier || 'UNKNOWN').toUpperCase()),
    byDesk: groupBy((r) => String(r.market || '?').toUpperCase()),
    byRegime: groupBy((r) => String(r.regime || 'UNKNOWN').toUpperCase()),
    bySide: groupBy((r) => String(r.side || '?').toUpperCase()),
    bySession: groupBy((r) => _istSession(r.ts)),
    // tier × regime cross (sabse zyada actionable slice — flag promotion
    // isi par hota hai)
    byTierRegime: (() => {
      const out = {};
      for (const r of rows) {
        const k = `${String(r.tier || 'UNKNOWN').toUpperCase()}|${String(r.regime || 'UNKNOWN').toUpperCase()}`;
        (out[k] = out[k] || []).push(r);
      }
      for (const k of Object.keys(out)) out[k] = summarizeV2(out[k]);
      return out;
    })(),
    totalScans: rows.length,
    resolvedCount: resolved.length,
    pendingCount: rows.length - resolved.length,
    schemaVersionCoverage: {
      v2: rows.filter((r) => Number(r.schemaVersion) >= 2).length,
      legacy: rows.filter((r) => !Number(r.schemaVersion)).length,
    },
    pWinCoveragePct: rows.length ? _r2((rows.filter((r) => r.pWinClaimed != null && Number.isFinite(Number(r.pWinClaimed))).length / rows.length) * 100) : null,
    note: 'Scorecard v2 — definitions frozen in docs/ACCURACY-DEFINITIONS.md. min-n gates: <30 insufficient, >=100 reviewable, >=150 decision-grade.',
  };
}

/**
 * 3.4 Hydrate the in-memory ledger from persisted rows (server boot).
 * Current-format rows only — legacy-shape rows are archived by
 * mtfRowLedgerStore. Dedup map is rebuilt so a 30m bucket cannot be
 * double-counted after restart.
 */
export function hydrateMtfLedger(rows = [], { lastLogAt = null, lastResolveAt = null } = {}) {
  _mtfScanLedger.length = 0;
  _mtfScanDedup.clear();
  const byKey = new Map();
  for (const raw of (Array.isArray(rows) ? rows : [])) {
    if (!raw || typeof raw !== 'object') continue;
    const symbol = String(raw.symbol || '').toUpperCase().trim();
    const side = String(raw.side || '').toUpperCase();
    const entry = Number(raw.entry);
    const stopLoss = Number(raw.stopLoss);
    const t1 = Number(raw.t1);
    const ts = Number(raw.ts);
    if (!symbol || (side !== 'LONG' && side !== 'SHORT')) continue;
    if (!(entry > 0) || !(stopLoss > 0) || !(t1 > 0) || !(ts > 0)) continue;
    const mode = String(raw.mode || 'INTRADAY').toUpperCase();
    const market = String(raw.market || 'CRYPTO').toUpperCase();
    const rec = {
      id: String(raw.id || `mtf-${symbol}-${mode}-${ts}`),
      symbol,
      market,
      mode,
      side,
      boardSide: raw.boardSide ?? null,
      boardSideConflict: raw.boardSideConflict === true,
      svaConflict: raw.svaConflict === true,
      councilConflict: raw.councilConflict === true,
      directionVerified: raw.directionVerified === true,
      superScore: Number(raw.superScore) || 0,
      tier: raw.tier || null,
      entry,
      stopLoss,
      t1,
      t2: Number(raw.t2) > 0 ? Number(raw.t2) : t1,
      risk: Number(raw.risk) > 0 ? Number(raw.risk) : Math.max(entry * 0.001, Math.abs(entry - stopLoss)),
      holdMin: Number(raw.holdMin) || (mode === 'SWING' ? 240 : 60),
      ts,
      peakFavPrice: Number(raw.peakFavPrice) > 0 ? Number(raw.peakFavPrice) : entry,
      peakAdvPrice: Number(raw.peakAdvPrice) > 0 ? Number(raw.peakAdvPrice) : entry,
      mfeR: Number(raw.mfeR) || 0,
      maeR: Number(raw.maeR) || 0,
      resolved: raw.resolved === true,
      resolvedAt: Number(raw.resolvedAt) > 0 ? Number(raw.resolvedAt) : null,
      outcome: raw.outcome ?? 'PENDING',
      outcomeR: Number.isFinite(Number(raw.outcomeR)) ? Number(raw.outcomeR) : null,
      directionHit: typeof raw.directionHit === 'boolean' ? raw.directionHit : null,
      signalAtOpenBar: raw.signalAtOpenBar && typeof raw.signalAtOpenBar === 'object' ? raw.signalAtOpenBar : null,
      signalAtCloseBar: raw.signalAtCloseBar && typeof raw.signalAtCloseBar === 'object' ? raw.signalAtCloseBar : null,
      signalStable: typeof raw.signalStable === 'boolean' ? raw.signalStable : null,
      t1HitAt: Number(raw.t1HitAt) > 0 ? Number(raw.t1HitAt) : null,
      t2HitAt: Number(raw.t2HitAt) > 0 ? Number(raw.t2HitAt) : null,
      // v21.32.0 [PHASE A3 — v1 → v2 MIGRATION] (backward compatible):
      // purane rows me ye fields nahi the — null/default settle ho jaate
      // hain (kabhi 0 nahi), resolve/outcome logic untouched.
      schemaVersion: 2,
      regime: raw.regime ?? null,
      featureSnapshot: raw.featureSnapshot && typeof raw.featureSnapshot === 'object'
        ? raw.featureSnapshot
        : { fv: 1, tier: raw.tier || null, superScore: _nn(raw.superScore), regime: raw.regime ?? null, ctx: {}, trig: {} },
      pWinClaimed: _nn(raw.pWinClaimed),
      closedBarConfirmed: typeof raw.closedBarConfirmed === 'boolean' ? raw.closedBarConfirmed : (typeof raw.signalStable === 'boolean' ? raw.signalStable : null),
      spreadBps: _nn2(raw.spreadBps),
      liquidityUSD: _nn(raw.liquidityUSD),
      fundingBps8h: _nn2(raw.fundingBps8h),
      perpDataStatus: raw.perpDataStatus ?? null,
      eventWindow: raw.eventWindow ?? null,
      filtersFired: Array.isArray(raw.filtersFired) ? raw.filtersFired.slice(0, 24) : [],
      latencyMs: _nn(raw.latencyMs),
    };
    const key = _mtfDedupKey(rec.market, rec.symbol, rec.mode, rec.ts);
    const prev = byKey.get(key);
    if (!prev || rec.ts >= prev.ts) byKey.set(key, rec);
  }
  _mtfScanLedger.push(...[...byKey.values()].sort((a, b) => a.ts - b.ts));
  while (_mtfScanLedger.length > MTF_SCAN_MAX) _mtfScanLedger.shift();
  for (const rec of _mtfScanLedger) {
    _mtfScanDedup.set(_mtfDedupKey(rec.market, rec.symbol, rec.mode, rec.ts), rec.id);
  }
  const maxTs = _mtfScanLedger.reduce((a, r) => Math.max(a, Number(r.ts) || 0), 0) || null;
  const maxResolvedAt = _mtfScanLedger.reduce((a, r) => Math.max(a, Number(r.resolvedAt) || 0), 0) || null;
  _lastLogAt = Number(lastLogAt) > 0 ? Number(lastLogAt) : maxTs;
  _lastResolveAt = Number(lastResolveAt) > 0 ? Number(lastResolveAt) : maxResolvedAt;
  return { total: _mtfScanLedger.length, lastLogAt: _lastLogAt, lastResolveAt: _lastResolveAt };
}

/** Read-only snapshot for the persistence layer. */
export function getMtfLedgerSnapshot() {
  return { rows: _mtfScanLedger, lastLogAt: _lastLogAt, lastResolveAt: _lastResolveAt };
}

export function __resetMtfLedgerForTests() {
  _mtfScanLedger.length = 0;
  _mtfScanDedup.clear();
  _lastLogAt = null;
  _lastResolveAt = null;
}
