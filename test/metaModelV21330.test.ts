// ============================================================
// test/metaModelV21330.test.ts — v21.33.0 PHASE E TESTS
// ------------------------------------------------------------
//   • E2  metaDecision — logistic inference + isotonic calibration
//   • E2  featureRowFromSnapshot — fv:1 nested + fv:2 flat dono shape
//   • E4  evaluateMetaGate — off/shadow/enforce + no-artifact honest
//   • INVARIANT: meta model SIDE KABHI flip nahi karta (take/skip only)
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  META_FEATURES, metaDecision, featureRowFromSnapshot,
  interpolateIsotonic, evaluateMetaGate, loadMetaModel, normalizeMetaMode,
} from '../server/ai/metaModel.js';

// Deterministic test artifact (weights sirf ek feature par — sign check easy)
const testModel = {
  version: 'meta-test',
  trainedAt: '2026-11-01T00:00:00.000Z',
  n: 500,
  features: [...META_FEATURES],
  // score (index 0) positive weight; baaki zero
  weights: META_FEATURES.map((k) => (k === 'score' ? 1.0 : 0)),
  bias: -0.5,
  means: META_FEATURES.map(() => 50),
  stds: META_FEATURES.map(() => 10),
  isotonic: [
    { p: 0.0, v: 0.20 },
    { p: 0.5, v: 0.45 },
    { p: 1.0, v: 0.85 },
  ],
  thresholds: { default: 0.55, ELITE: 0.60 },
  metrics: { oos: { brier: 0.18 } },
};

describe('v21.33.0 E2 — metaDecision', () => {
  it('high score → higher pWin than low score (positive weight)', () => {
    const hi = metaDecision({ fv: { score: 90 }, model: testModel, tierThreshold: 0.55 });
    const lo = metaDecision({ fv: { score: 10 }, model: testModel, tierThreshold: 0.55 });
    expect(hi.available).toBe(true);
    expect(hi.pWin).toBeGreaterThan(lo.pWin);
    expect(hi.take).toBe(true); // calibrated ~0.85·map
    expect(lo.take).toBe(false);
  });
  it('isotonic interpolation monotone + clamped', () => {
    expect(interpolateIsotonic(testModel.isotonic, 0.0)).toBeCloseTo(0.20, 4);
    expect(interpolateIsotonic(testModel.isotonic, 0.25)).toBeCloseTo(0.325, 3);
    expect(interpolateIsotonic(testModel.isotonic, 1.0)).toBeCloseTo(0.85, 4);
    expect(interpolateIsotonic(testModel.isotonic, -1)).toBeCloseTo(0.20, 4);
    expect(interpolateIsotonic([], 0.5)).toBeNull();
  });
  it('pWin capped at 0.92 (audit B5 honesty cap)', () => {
    const bigModel = { ...testModel, isotonic: [{ p: 0, v: 0.99 }] };
    const d = metaDecision({ fv: { score: 90 }, model: bigModel });
    expect(d.pWin).toBeLessThanOrEqual(0.92);
  });
  it('missing feature → mean impute + imputed count', () => {
    const d = metaDecision({ fv: { score: null }, model: testModel });
    expect(d.available).toBe(true);
    expect(d.imputed).toBe(META_FEATURES.length); // sab means se
  });
  it('no model → available:false honest', () => {
    const d = metaDecision({ fv: { score: 80 }, model: null });
    expect(d.available).toBe(false);
    expect(d.reason).toBe('no_model');
  });
  // v21.35.0 [A10a]: pCal/pWin null (empty isotonic knots / NaN z) par
  // pehle available:true + take:null tha — enforce gate silently no-op.
  it('v21.35.0 [A10a]: empty isotonic knots → calibration_failed honest refuse', () => {
    const broken = { ...testModel, isotonic: [] };
    const d = metaDecision({ fv: { score: 80 }, model: broken, tierThreshold: 0.55 });
    expect(d.available).toBe(false);
    expect(d.reason).toBe('calibration_failed');
    expect(d.pWin).toBeNull();
    expect(d.take).toBeNull();
    // gate bhi inactive/fail-open treat karta hai (skip verdict nahi)
    const g = evaluateMetaGate({ row: { side: 'LONG' }, fv: { score: 80 }, model: broken, mode: 'enforce' });
    expect(g.available).toBe(false);
    expect(g.reason).toBe('calibration_failed');
    expect(g.blocked).toBe(false);
    expect(g.wouldTake).toBeNull();
  });
});

describe('v21.33.0 E2 — featureRowFromSnapshot (dono shapes)', () => {
  it('fv:1 nested (ctx/trig) shape parse hota hai', () => {
    const row = featureRowFromSnapshot({
      fv: 1,
      ctx: { score: 78, adx: 24, rsi: 61 },
      trig: { score: 74, volRatio: 1.8 },
    });
    expect(row).toHaveLength(META_FEATURES.length);
    expect(row[META_FEATURES.indexOf('score')]).toBe(78);
    expect(row[META_FEATURES.indexOf('adx')]).toBe(24);
    expect(row[META_FEATURES.indexOf('trigVolRatio')]).toBe(1.8);
  });
  it('fv:2 flat shape parse hota hai', () => {
    const row = featureRowFromSnapshot({
      fv: 2,
      score: 82,
      side: 'LONG', // v21.35.0 [A11]: side-aware divergence encoding (BEARISH = LONG ke liye adverse)
      realizedVolRatio: 1.2,
      rsiDivergence: { kind: 'BEARISH' },
      macdDivergence: { kind: 'NONE' },
      session: { hourOfDay: 13, minutesToFunding: 42 },
      fundingBps8h: 12.5,
    });
    expect(row[META_FEATURES.indexOf('realizedVolRatio')]).toBe(1.2);
    expect(row[META_FEATURES.indexOf('divergenceAdverse')]).toBe(1); // BEARISH vs LONG → adverse
    expect(row[META_FEATURES.indexOf('divergenceFavourable')]).toBe(0);
    expect(row[META_FEATURES.indexOf('hourOfDay')]).toBe(13);
    expect(row[META_FEATURES.indexOf('minutesToFunding')]).toBe(42);
    expect(row[META_FEATURES.indexOf('fundingBps8h')]).toBe(12.5);
  });
  it('missing values → null (kabhi 0 fabricate nahi)', () => {
    const row = featureRowFromSnapshot({});
    expect(row[META_FEATURES.indexOf('adx')]).toBeNull();
    expect(row[META_FEATURES.indexOf('er')]).toBeNull();
  });
  // v21.35.0 [A11]: divergence encoding ab SIDE-AWARE hai — BEARISH
  // LONG ke liye adverse / SHORT ke liye FAVOURABLE (pehle side-blind
  // tha → pooled logistic SHORT pWin systematically miscalibrate).
  it('v21.35.0 [A11]: BEARISH divergence — LONG adverse, SHORT FAVOURABLE', () => {
    const long = featureRowFromSnapshot({ side: 'LONG', rsiDivergence: { kind: 'BEARISH' }, macdDivergence: { kind: 'NONE' } });
    expect(long[META_FEATURES.indexOf('divergenceAdverse')]).toBe(1);
    expect(long[META_FEATURES.indexOf('divergenceFavourable')]).toBe(0);
    const short = featureRowFromSnapshot({ side: 'SHORT', rsiDivergence: { kind: 'BEARISH' }, macdDivergence: { kind: 'NONE' } });
    expect(short[META_FEATURES.indexOf('divergenceAdverse')]).toBe(0);
    expect(short[META_FEATURES.indexOf('divergenceFavourable')]).toBe(1);
  });
  it('v21.35.0 [A11]: BULLISH mirror — LONG favourable, SHORT adverse', () => {
    const long = featureRowFromSnapshot({ side: 'LONG', rsiDivergence: { kind: 'NONE' }, macdDivergence: { kind: 'BULLISH' } });
    expect(long[META_FEATURES.indexOf('divergenceAdverse')]).toBe(0);
    expect(long[META_FEATURES.indexOf('divergenceFavourable')]).toBe(1);
    const short = featureRowFromSnapshot({ side: 'SHORT', rsiDivergence: { kind: 'NONE' }, macdDivergence: { kind: 'BULLISH' } });
    expect(short[META_FEATURES.indexOf('divergenceAdverse')]).toBe(1);
    expect(short[META_FEATURES.indexOf('divergenceFavourable')]).toBe(0);
  });
  it('v21.35.0 [A11]: side UNKNOWN → dono divergence features null (imputed, imputeCount me honest)', () => {
    const row = featureRowFromSnapshot({ rsiDivergence: { kind: 'BEARISH' }, macdDivergence: { kind: 'NONE' } });
    expect(row[META_FEATURES.indexOf('divergenceAdverse')]).toBeNull();
    expect(row[META_FEATURES.indexOf('divergenceFavourable')]).toBeNull();
    // inference me bhi impute count hota hai (score + 25 null = 26 me se)
    const d = metaDecision({ fv: { score: 80, rsiDivergence: { kind: 'BEARISH' } }, model: testModel });
    expect(d.imputed).toBe(META_FEATURES.length - 1);
    // NONE + known side → definite 0/0 (v21.34.0 semantics preserved)
    const none = featureRowFromSnapshot({ side: 'LONG', rsiDivergence: { kind: 'NONE' }, macdDivergence: { kind: 'NONE' } });
    expect(none[META_FEATURES.indexOf('divergenceAdverse')]).toBe(0);
    expect(none[META_FEATURES.indexOf('divergenceFavourable')]).toBe(0);
  });
  it('v21.35.0 [A11]: META_FEATURES naam/count UNCHANGED (schema stable, sirf encoding meaning badla)', () => {
    expect(META_FEATURES).toContain('divergenceAdverse');
    expect(META_FEATURES).toContain('divergenceFavourable');
    expect(META_FEATURES.length).toBe(25);
  });
});

describe('v21.33.0 E4 — evaluateMetaGate modes', () => {
  afterEach(() => { delete process.env.META_MODEL; });
  it('mode off → inactive, koi verdict nahi', () => {
    const g = evaluateMetaGate({ row: { side: 'LONG' }, model: testModel, mode: 'off' });
    expect(g.active).toBe(false);
    expect(g.wouldBlock).toBe(false);
    expect(g.reason).toBe('mode_off');
  });
  it('no artifact → available:false, honest reason (fail-open)', () => {
    const g = evaluateMetaGate({ row: { side: 'LONG' }, model: null, mode: 'shadow' });
    expect(g.available).toBe(false);
    expect(g.wouldBlock).toBe(false);
    expect(g.reason).toContain('no_model_artifact');
  });
  it('shadow → wouldSkip verdict par blocked=false (kabhi block nahi)', () => {
    const g = evaluateMetaGate({ row: { side: 'LONG', tier: 'STRONG' }, fv: { score: 10 }, model: testModel, mode: 'shadow' });
    expect(g.shadow).toBe(true);
    expect(g.wouldSkip).toBe(true);
    expect(g.wouldBlock).toBe(true); // WOULD block (counterfactual)
    expect(g.blocked).toBe(false);   // actually blocks nahi
  });
  it('enforce + wouldSkip → blocked=true (take/skip gate LIVE)', () => {
    const g = evaluateMetaGate({ row: { side: 'LONG' }, fv: { score: 10 }, model: testModel, mode: 'enforce' });
    expect(g.blocked).toBe(true);
    expect(g.reason).toContain('meta-model skip');
  });
  it('enforce + take → blocked=false, sizeMultiplier OPTIONAL [0.5,1.0]', () => {
    const g = evaluateMetaGate({ row: { side: 'SHORT' }, fv: { score: 90 }, model: testModel, mode: 'enforce', sizeModulation: true });
    expect(g.blocked).toBe(false);
    expect(g.sizeMultiplier).toBeLessThanOrEqual(1.0);
    expect(g.sizeMultiplier).toBeGreaterThanOrEqual(0.5);
  });
  it('tier-wise threshold artifact se aata hai (ELITE 0.60)', () => {
    const g = evaluateMetaGate({ row: { side: 'LONG', tier: 'ELITE' }, fv: { score: 80 }, model: testModel, mode: 'shadow' });
    expect(g.threshold).toBe(0.60);
  });
  // v21.35.0 [A10c]: tier key UPPERCASE karke lookup — lowercase 'elite'
  // pehle default 0.55 fall karta tha (tier-wise threshold silently dead).
  it('v21.35.0 [A10c]: lowercase tier bhi artifact threshold match karta hai', () => {
    const g = evaluateMetaGate({ row: { side: 'LONG', tier: 'elite' }, fv: { score: 80 }, model: testModel, mode: 'shadow' });
    expect(g.threshold).toBe(0.60);
    // unknown tier → default fallback (0.55) — pehle jaisa
    const u = evaluateMetaGate({ row: { side: 'LONG', tier: 'nope' }, fv: { score: 80 }, model: testModel, mode: 'shadow' });
    expect(u.threshold).toBe(0.55);
  });
});

describe('v21.33.0 INVARIANT — meta model side kabhi flip nahi karta', () => {
  it('har mode me gate.side input side hi echo hota hai', () => {
    for (const side of ['LONG', 'SHORT']) {
      for (const mode of ['off', 'shadow', 'enforce']) {
        const g = evaluateMetaGate({ row: { side }, fv: { score: 50 }, model: testModel, mode });
        expect(g.side).toBe(side);
      }
    }
  });
});

describe('v21.33.0 — loadMetaModel artifact IO', () => {
  let tmpDir = '';
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-')); });
  afterEach(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ } });

  it('latest dated artifact load hota hai; corrupt/missing → null', () => {
    expect(loadMetaModel(tmpDir)).toBeNull(); // empty dir
    fs.writeFileSync(path.join(tmpDir, 'meta-2026-10-01.json'), JSON.stringify(testModel));
    fs.writeFileSync(path.join(tmpDir, 'meta-2026-11-01.json'), JSON.stringify({ ...testModel, version: 'meta-2026-11-01' }));
    const m = loadMetaModel(tmpDir);
    expect(m.version).toBe('meta-2026-11-01');
    // corrupt: weights length mismatch → honest null
    fs.writeFileSync(path.join(tmpDir, 'meta-2026-12-01.json'), JSON.stringify({ ...testModel, weights: [1, 2] }));
    expect(loadMetaModel(tmpDir)).toBeNull();
  });

  // v21.35.0 [A10b]: DEEP validation — features absent / means-stds
  // wrong ya non-finite / isotonic corrupt → honest null (pehle vacuous
  // model load ho jaata tha: positional weights bina naam, ya NaN
  // standardization silently jhooth bolti thi).
  it('v21.35.0 [A10b]: features absent → null (positional weights vacuous)', () => {
    const { features, ...noFeatures } = testModel;
    fs.writeFileSync(path.join(tmpDir, 'meta-2027-01-01.json'), JSON.stringify(noFeatures));
    expect(loadMetaModel(tmpDir)).toBeNull();
  });
  it('v21.35.0 [A10b]: means/stds missing ya wrong-length ya non-finite → null', () => {
    fs.writeFileSync(path.join(tmpDir, 'meta-2027-02-01.json'), JSON.stringify({ ...testModel, means: undefined }));
    expect(loadMetaModel(tmpDir)).toBeNull(); // means absent (JSON me drop)
    fs.writeFileSync(path.join(tmpDir, 'meta-2027-02-02.json'), JSON.stringify({ ...testModel, stds: [1, 2, 3] }));
    expect(loadMetaModel(tmpDir)).toBeNull(); // wrong length
    fs.writeFileSync(path.join(tmpDir, 'meta-2027-02-03.json'), JSON.stringify({ ...testModel, means: [...testModel.means.slice(0, -1), null] }));
    expect(loadMetaModel(tmpDir)).toBeNull(); // null entry → non-finite
  });
  it('v21.35.0 [A10b]: isotonic corrupt (descending p / decreasing v / empty) → null', () => {
    fs.writeFileSync(path.join(tmpDir, 'meta-2027-03-01.json'), JSON.stringify({ ...testModel, isotonic: [{ p: 0.8, v: 0.2 }, { p: 0.2, v: 0.9 }] }));
    expect(loadMetaModel(tmpDir)).toBeNull(); // p descending
    fs.writeFileSync(path.join(tmpDir, 'meta-2027-03-02.json'), JSON.stringify({ ...testModel, isotonic: [{ p: 0.2, v: 0.8 }, { p: 0.8, v: 0.3 }] }));
    expect(loadMetaModel(tmpDir)).toBeNull(); // v decreasing
    fs.writeFileSync(path.join(tmpDir, 'meta-2027-03-03.json'), JSON.stringify({ ...testModel, isotonic: [] }));
    expect(loadMetaModel(tmpDir)).toBeNull(); // empty
    fs.writeFileSync(path.join(tmpDir, 'meta-2027-03-04.json'), JSON.stringify({ ...testModel, isotonic: 'bogus' }));
    expect(loadMetaModel(tmpDir)).toBeNull(); // not an array
    // isotonic ABSENT (null) → allowed — uncalibrated logistic valid hai
    fs.writeFileSync(path.join(tmpDir, 'meta-2027-03-05.json'), JSON.stringify({ ...testModel, isotonic: null, version: 'meta-2027-03-05' }));
    const m = loadMetaModel(tmpDir);
    expect(m.version).toBe('meta-2027-03-05');
    expect(m.isotonic).toBeNull();
    // equal-p knots (ties) VALID — trainer PAVA tie knots de sakta hai
    fs.writeFileSync(path.join(tmpDir, 'meta-2027-04-01.json'), JSON.stringify({
      ...testModel,
      isotonic: [{ p: 0.2, v: 0.3 }, { p: 0.2, v: 0.3 }, { p: 0.9, v: 0.8 }],
      version: 'meta-2027-04-01',
    }));
    expect(loadMetaModel(tmpDir).version).toBe('meta-2027-04-01');
  });

  it('normalizeMetaMode env aliases + default off', () => {
    expect(normalizeMetaMode('enforce')).toBe('enforce');
    expect(normalizeMetaMode('on')).toBe('enforce');
    expect(normalizeMetaMode('dry-run')).toBe('shadow');
    expect(normalizeMetaMode('0')).toBe('off');
    expect(normalizeMetaMode(null)).toBe('off');
    expect(normalizeMetaMode(undefined, 'shadow')).toBe('shadow');
  });

  // v21.35.0 [A10d]: explicitly-empty raw pehle env fallback ko bypass
  // karta tha ('' nullish nahi) — ab unset maana jaata hai.
  it('v21.35.0 [A10d]: empty/whitespace raw → env fallback applies', () => {
    process.env.META_MODEL = 'shadow';
    expect(normalizeMetaMode('')).toBe('shadow');
    expect(normalizeMetaMode('   ')).toBe('shadow');
    expect(normalizeMetaMode('off')).toBe('off'); // real value env ko override karta hai
    process.env.META_MODEL = 'enforce';
    expect(normalizeMetaMode('')).toBe('enforce');
    delete process.env.META_MODEL;
    expect(normalizeMetaMode('')).toBe('off'); // env bhi nahi → fallback default
  });
});
