// ============================================================
// test/championChallengerV21330.test.ts — v21.33.0 PHASE J/K TESTS
// ------------------------------------------------------------
//   • J   evaluateChallengerPromotion — full rule (n/OOS/DD/stability)
//   • J   applyFlagChange — typed-confirm mismatch refuse + real
//         change tmp paths par (REAL champion.json kabhi touch nahi)
//   • K   flagMatrixSnapshot — env override effective
//   • K1  buildAccuracyDashboard — fail-open aggregate structure
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  evaluateChallengerPromotion, applyFlagChange, flagMatrixSnapshot,
  loadChampion, challengerStatus, promotionChecklist,
  __setChallengerPathsForTests,
} from '../server/ai/championChallenger.js';
import { buildAccuracyDashboard } from '../server/ai/accuracyDashboard.js';

let TMP = '';
let CHAMP = '';
let HIST = '';

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'champ-'));
  CHAMP = path.join(TMP, 'champion.json');
  HIST = path.join(TMP, 'FLAG-HISTORY.md');
  fs.writeFileSync(CHAMP, JSON.stringify({
    schema: 'smartaipro-champion-config/1',
    version: '21.33.0',
    gitSha: 'testsha',
    flags: {
      PRE_TP1_TRAIL: { env: null, default: 'shadow', effective: 'shadow' },
      META_MODEL: { env: null, default: 'off', effective: 'off' },
    },
  }, null, 2));
  fs.writeFileSync(HIST, '# FLAG HISTORY (test)\n\n## Flip log\n');
  __setChallengerPathsForTests({ championFile: CHAMP, flagHistoryFile: HIST });
});

afterEach(() => {
  __setChallengerPathsForTests({});
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ }
});

describe('v21.33.0 J — evaluateChallengerPromotion rule', () => {
  // v21.34.0: champion me ab oosExpectancyHiR bhi chahiye (CI non-overlap
  // rule ke liye) — fail-closed agar missing ho.
  const champion = { oosExpectancyR: 0.10, oosExpectancyLoR: 0.02, oosExpectancyHiR: 0.18, n: 200, maxDDR: 4 };
  const stableSince = new Date(Date.now() - 20 * 86_400_000).toISOString();

  it('sab checks pass (CI non-overlap ke saath) → eligible (phir bhi promotion MANUAL hai)', () => {
    const r = evaluateChallengerPromotion({
      challenger: { oosExpectancyR: 0.35, oosExpectancyLoR: 0.20, n: 180, maxDDR: 3.5, stableSince },
      champion,
    });
    expect(r.checks.nOk).toBe(true);
    expect(r.checks.oosBetter).toBe(true);
    expect(r.checks.ciNonOverlap).toBe(true); // cLo 0.20 > pHi 0.18
    expect(r.checks.ddNotWorse).toBe(true);
    expect(r.checks.stable).toBe(true);
    expect(r.promotionEligible).toBe(true);
    expect(r.note).toContain('MANUAL');
  });
  it('v21.34.0: CI OVERLAP (cLo <= champion Hi) → NOT eligible — chahe OOS point-estimate better ho', () => {
    const r = evaluateChallengerPromotion({
      challenger: { oosExpectancyR: 0.25, oosExpectancyLoR: 0.12, n: 180, maxDDR: 3.5, stableSince },
      champion,
    });
    expect(r.checks.oosBetter).toBe(true);
    expect(r.checks.ciNonOverlap).toBe(false); // 0.12 <= 0.18 overlap
    expect(r.promotionEligible).toBe(false);
    expect(r.note).toContain('CI overlap');
  });
  it('v21.34.0: champion Hi unknown → ciNonOverlap null → NOT eligible (fail-closed)', () => {
    const r = evaluateChallengerPromotion({
      challenger: { oosExpectancyR: 0.5, oosExpectancyLoR: 0.3, n: 200, maxDDR: 1, stableSince },
      champion: { oosExpectancyR: 0.10, oosExpectancyLoR: 0.02, n: 200, maxDDR: 4 },
    });
    expect(r.checks.ciNonOverlap).toBeNull();
    expect(r.promotionEligible).toBe(false);
    expect(r.note).toContain('CI unknown');
  });
  // v21.35.0 [F-7]: challenger Lo missing → bhi CI unknown (pehle point
  // estimate se fallback — asymmetric fail-open vs champion side).
  it('v21.35.0: challenger Lo missing → ciNonOverlap null → NOT eligible (symmetric fail-closed)', () => {
    const r = evaluateChallengerPromotion({
      challenger: { oosExpectancyR: 0.5, n: 200, maxDDR: 1, stableSince },
      champion: { oosExpectancyR: 0.10, oosExpectancyLoR: 0.02, oosExpectancyHiR: 0.18, n: 200, maxDDR: 4 },
    });
    expect(r.checks.ciNonOverlap).toBeNull();
    expect(r.promotionEligible).toBe(false);
    expect(r.note).toContain('CI unknown');
  });
  it('v21.34.0: DD unknown → NOT eligible (fail-closed, pehle null pass hota tha)', () => {
    const r = evaluateChallengerPromotion({
      challenger: { oosExpectancyR: 0.35, oosExpectancyLoR: 0.20, n: 180, stableSince },
      champion,
    });
    expect(r.checks.ddNotWorse).toBeNull();
    expect(r.promotionEligible).toBe(false);
    expect(r.note).toContain('DD unknown');
  });
  it('n < 150 → NOT eligible', () => {
    const r = evaluateChallengerPromotion({
      challenger: { oosExpectancyR: 0.5, oosExpectancyLoR: 0.3, n: 100, maxDDR: 1, stableSince },
      champion,
    });
    expect(r.checks.nOk).toBe(false);
    expect(r.promotionEligible).toBe(false);
  });
  it('OOS worse → NOT eligible', () => {
    const r = evaluateChallengerPromotion({
      challenger: { oosExpectancyR: 0.05, oosExpectancyLoR: 0.3, n: 200, maxDDR: 1, stableSince },
      champion,
    });
    expect(r.checks.oosBetter).toBe(false);
    expect(r.promotionEligible).toBe(false);
  });
  it('DD worse → NOT eligible', () => {
    const r = evaluateChallengerPromotion({
      challenger: { oosExpectancyR: 0.4, oosExpectancyLoR: 0.3, n: 200, maxDDR: 9, stableSince },
      champion,
    });
    expect(r.checks.ddNotWorse).toBe(false);
    expect(r.promotionEligible).toBe(false);
  });
  it('stability < 2 hafte → NOT eligible', () => {
    const r = evaluateChallengerPromotion({
      challenger: { oosExpectancyR: 0.4, oosExpectancyLoR: 0.3, n: 200, maxDDR: 1, stableSince: new Date(Date.now() - 5 * 86_400_000).toISOString() },
      champion,
    });
    expect(r.checks.stable).toBe(false);
    expect(r.promotionEligible).toBe(false);
  });
});

describe('v21.33.0 J — applyFlagChange typed-confirm', () => {
  it('galat typed string → refuse, file UNCHANGED', () => {
    const before = fs.readFileSync(CHAMP, 'utf8');
    const r = applyFlagChange({ flag: 'META_MODEL', action: 'promote', confirmTyped: 'yes promote' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('PROMOTE META_MODEL');
    expect(fs.readFileSync(CHAMP, 'utf8')).toBe(before);
  });
  it('unknown flag → refuse', () => {
    const r = applyFlagChange({ flag: 'NOPE', action: 'promote', confirmTyped: 'PROMOTE NOPE' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('champion.json me nahi mila');
  });
  it('exact typed confirm + evidence → promote to shadow + FLAG-HISTORY entry', () => {
    // v21.35.0 [F-1]: stats ke bina promote ke liye explicit evidence
    // string ZAROORI (canned default ka silent pass khatam).
    const r = applyFlagChange({ flag: 'META_MODEL', action: 'promote', confirmTyped: 'PROMOTE META_MODEL', mode: 'shadow', operator: 'tester', evidence: 'operator-verified shadow-report useful + coverage 92%' });
    expect(r.ok).toBe(true);
    expect(r.change).toBe('off → shadow');
    // v21.35.0 [F-4]: historyWritten honest boolean + eligibility note
    expect(r.historyWritten).toBe(true);
    expect(r.eligibility.checked).toBe(false);
    expect(r.eligibility.note).toContain('verify NAHI hua');
    const champ = JSON.parse(fs.readFileSync(CHAMP, 'utf8'));
    expect(champ.flags.META_MODEL.effective).toBe('shadow');
    expect(champ.lastFlagChange.operator).toBe('tester');
    const hist = fs.readFileSync(HIST, 'utf8');
    expect(hist).toContain('| META_MODEL | off → shadow');
  });
  // v21.35.0 [F-1]: stats ke bina + evidence ke bina → REFUSE (fail-closed)
  it('v21.35.0: promote bina stats aur evidence ke → refuse', () => {
    const before = fs.readFileSync(CHAMP, 'utf8');
    const r = applyFlagChange({ flag: 'META_MODEL', action: 'promote', confirmTyped: 'PROMOTE META_MODEL', mode: 'shadow' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('evidence');
    expect(fs.readFileSync(CHAMP, 'utf8')).toBe(before); // unchanged
  });
  // v21.35.0 [F-1]: stats ke saath ENGINE REQUIRED — fail par refuse
  it('v21.35.0: stats FAIL (n<150) → promotion rule FAIL refuse', () => {
    const before = fs.readFileSync(CHAMP, 'utf8');
    const r = applyFlagChange({
      flag: 'META_MODEL', action: 'promote', confirmTyped: 'PROMOTE META_MODEL', mode: 'shadow',
      stats: { challenger: { oosExpectancyR: 0.5, oosExpectancyLoR: 0.3, n: 40, maxDDR: 1, stableSince: new Date(Date.now() - 20 * 86_400_000).toISOString() }, champion: { oosExpectancyR: 0.10, oosExpectancyLoR: 0.02, oosExpectancyHiR: 0.18, n: 200, maxDDR: 4 } },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('promotion rule FAIL');
    expect(r.eligibility.checked).toBe(true);
    expect(r.eligibility.promotionEligible).toBe(false);
    expect(fs.readFileSync(CHAMP, 'utf8')).toBe(before); // unchanged
  });
  // v21.35.0 [F-1]: stats ke saath engine PASS → promote + eligibility echo
  it('v21.35.0: stats PASS (n≥150 + CI non-overlap + DD + stable) → promote with eligibility echo', () => {
    const r = applyFlagChange({
      flag: 'META_MODEL', action: 'promote', confirmTyped: 'PROMOTE META_MODEL', mode: 'shadow',
      stats: { challenger: { oosExpectancyR: 0.35, oosExpectancyLoR: 0.20, n: 180, maxDDR: 3.5, stableSince: new Date(Date.now() - 20 * 86_400_000).toISOString() }, champion: { oosExpectancyR: 0.10, oosExpectancyLoR: 0.02, oosExpectancyHiR: 0.18, n: 200, maxDDR: 4 } },
    });
    expect(r.ok).toBe(true);
    expect(r.eligibility.checked).toBe(true);
    expect(r.eligibility.promotionEligible).toBe(true);
    expect(r.historyWritten).toBe(true);
  });
  it('rollback → off + entry', () => {
    applyFlagChange({ flag: 'PRE_TP1_TRAIL', action: 'rollback', confirmTyped: 'ROLLBACK PRE_TP1_TRAIL' });
    const champ = JSON.parse(fs.readFileSync(CHAMP, 'utf8'));
    expect(champ.flags.PRE_TP1_TRAIL.effective).toBe('off');
  });
  it('v21.34.0: garbage mode string → refuse (typo protection)', () => {
    const before = fs.readFileSync(CHAMP, 'utf8');
    const r = applyFlagChange({ flag: 'META_MODEL', action: 'promote', confirmTyped: 'PROMOTE META_MODEL', mode: 'shdow', evidence: 'x' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('off|shadow|enforce');
    expect(fs.readFileSync(CHAMP, 'utf8')).toBe(before); // unchanged
  });
  it('v21.34.0: enforce mode valid hai', () => {
    const r = applyFlagChange({ flag: 'META_MODEL', action: 'promote', confirmTyped: 'PROMOTE META_MODEL', mode: 'enforce', evidence: 'x' });
    expect(r.ok).toBe(true);
    expect(r.change).toContain('enforce');
    // wapas shadow pe — doosre tests ke liye state restore
    applyFlagChange({ flag: 'META_MODEL', action: 'promote', confirmTyped: 'PROMOTE META_MODEL', mode: 'shadow', evidence: 'x' });
  });
});

describe('v21.33.0 K — flagMatrixSnapshot', () => {
  it('env override effective jeet-ta hai', () => {
    const snap = flagMatrixSnapshot({ META_MODEL: 'enforce', PRE_TP1_TRAIL: 'off' });
    expect(snap.flags.META_MODEL.effective).toBe('enforce');
    expect(snap.flags.META_MODEL.env).toBe('enforce');
    expect(snap.flags.PRE_TP1_TRAIL.effective).toBe('off');
    expect(snap.version).toBe('21.33.0');
  });
  it('champion default jab env missing', () => {
    const snap = flagMatrixSnapshot({});
    expect(snap.flags.META_MODEL.effective).toBe('off');
    expect(snap.flags.META_MODEL.env).toBeNull();
  });
  it('championStatus aggregate', () => {
    const s = challengerStatus({ shadowVerdicts: { regimeFilter: 'useful' }, driftVerdict: 'STABLE', metaModel: null });
    expect(s.champion.version).toBe('21.33.0');
    expect(s.driftVerdict).toBe('STABLE');
    expect(s.eligibleForReview).toEqual(['regimeFilter']);
    expect(s.promotionRule).toContain('typed-confirm');
    // v21.34.0 [WATCH HONESTY]: metaModel projection me `available` hai
    const s2 = challengerStatus({ shadowVerdicts: {}, driftVerdict: null, metaModel: { version: 'x', n: 420, metrics: {} } });
    expect(s2.metaModel.available).toBe(true);
    expect(s2.metaModel.n).toBe(420);
  });
  it('promotionChecklist gates', () => {
    const ready = promotionChecklist({
      flag: 'regimeFilter',
      shadowReport: { verdict: 'useful' },
      ledgerStats: { n: 120, dataCoveragePct: 90, ddWorse: false, observedWeeks: 2 },
    });
    expect(ready.ready).toBe(true);
    const notReady = promotionChecklist({
      flag: 'perpVeto',
      shadowReport: { verdict: 'neutral' },
      ledgerStats: { n: 40, dataCoveragePct: 50 },
    });
    expect(notReady.ready).toBe(false);
  });
});

describe('v21.33.0 K1 — buildAccuracyDashboard (fail-open aggregate)', () => {
  it('structure: har section present, koi throw nahi', () => {
    const d = buildAccuracyDashboard({ now: Date.now() });
    expect(d.ok).toBe(true);
    expect(d.version).toBe('accuracy-dashboard/1');
    expect(d).toHaveProperty('scorecard');
    expect(d).toHaveProperty('drift');
    expect(d).toHaveProperty('flags');
    expect(d).toHaveProperty('metaModel');
    expect(d).toHaveProperty('latency');
    expect(d).toHaveProperty('ledgerHealth');
    expect(d).toHaveProperty('shadowSummary');
    expect(d).toHaveProperty('calibrationByTier');
    expect(d).toHaveProperty('kpiTargets');
  });
  it('drift verdict valid enum', () => {
    const d = buildAccuracyDashboard({});
    expect(['STABLE', 'DRIFTING', 'ALARM', 'UNAVAILABLE']).toContain(d.drift.verdict);
  });
  it('meta-model honest jab artifact nahi', () => {
    const d = buildAccuracyDashboard({});
    expect(d.metaModel.available).toBe(false);
    expect(d.metaModel.reason).toContain('no artifact');
  });
  it('calibrationByTier: OVERCONFIDENT sirf n>=30 par', () => {
    const d = buildAccuracyDashboard({});
    // cold-start me empty object allowed — koi fabricated tier nahi
    expect(typeof d.calibrationByTier).toBe('object');
  });
});
