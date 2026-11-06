// ============================================================
// test/v21320LedgerEnrichment.test.ts — v21.32.0 PHASE A3/A4
// ------------------------------------------------------------
//   • A3 ledger schema v2 enrichment (featureSnapshot, pWinClaimed,
//     closedBarConfirmed, filtersFired, latencyMs, spreadBps…)
//   • v1 → v2 hydrate migration (backward compatible, null settle)
//   • A4 scorecard v2 slices (tier/regime/side/session) + Wilson CI +
//     bootstrap CI + ECE/Brier + min-n gates
//   • lookahead-free: snapshot me sirf signal-time fields
// ============================================================
import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordMtfBoardScanRow, resolveMtfBoardScanOutcomes, computeMtfDirectionScorecardV2,
  hydrateMtfLedger, getMtfLedgerSnapshot, __resetMtfLedgerForTests, minNGate,
} from '../server/ai/signalLedger.js';

const T0 = 1_790_000_000_000;

const baseRow = (over: Record<string, any> = {}) => ({
  symbol: 'AAA',
  market: 'CRYPTO',
  mode: 'INTRADAY',
  side: 'LONG',
  boardSide: 'LONG',
  boardSideConflict: false,
  directionVerified: true,
  superScore: 88,
  tier: 'ELITE',
  holdMin: 45,
  builtAt: T0 - 250,
  plan: { entry: 100, stopLoss: 98, t1: 104, t2: 108 },
  pWinCalibrated: 62,
  regime: 'TREND_UP',
  context: {
    dir: 1, score: 80, adx: 24.5, atrPct: 0.8, rsi: 58.2, barsInTrend: 5,
    exhausted: false, squeeze: false, squeezeFired: false, bbWidthPct: 2.4, er: 0.41,
  },
  trigger: {
    dir: 1, score: 78, volRatio: 1.9, bodyPct: 62, rsi: 61,
    overextended: false, pullbackReclaim: true, reversalRisk: false,
  },
  barConfirmation: { stable: true, openBar: { side: 'LONG' }, closeBar: { side: 'LONG' } },
  filtersFired: [
    { guard: 'regimeFilter', verdict: 'allow', reason: 'TREND_UP ok' },
    { guard: 'perpVeto', verdict: 'would-block', reason: 'funding p95' },
  ],
  spreadBps: 8.5,
  ...over,
});

beforeEach(() => { __resetMtfLedgerForTests(); });

describe('v21.32.0 A3 — ledger schema v2 enrichment', () => {
  it('featureSnapshot + pWinClaimed + closedBarConfirmed + filtersFired + latencyMs record hote hain', () => {
    const rec = recordMtfBoardScanRow(baseRow(), { now: T0 });
    expect(rec).not.toBeNull();
    expect(rec!.schemaVersion).toBe(2);
    expect(rec!.regime).toBe('TREND_UP');
    expect(rec!.featureSnapshot.fv).toBe(1);
    expect(rec!.featureSnapshot.tier).toBe('ELITE');
    expect(rec!.featureSnapshot.superScore).toBe(88);
    expect(rec!.featureSnapshot.ctx.adx).toBe(24.5);
    expect(rec!.featureSnapshot.ctx.squeeze).toBe(false);
    expect(rec!.featureSnapshot.ctx.bbWidthPct).toBe(2.4);
    expect(rec!.featureSnapshot.ctx.er).toBe(0.41);
    expect(rec!.featureSnapshot.trig.volRatio).toBe(1.9);
    expect(rec!.featureSnapshot.trig.pullbackReclaim).toBe(true);
    // pWinClaimed 0–1 fraction (62% → 0.62)
    expect(rec!.pWinClaimed).toBeCloseTo(0.62, 9);
    expect(rec!.closedBarConfirmed).toBe(true);
    expect(rec!.spreadBps).toBe(8.5);
    expect(rec!.liquidityUSD).toBeNull();      // missing → null (kabhi 0 nahi)
    expect(rec!.fundingBps8h).toBeNull();
    expect(rec!.perpDataStatus).toBeNull();
    expect(rec!.latencyMs).toBe(250);          // builtAt → record time
    expect(rec!.filtersFired).toHaveLength(2);
    expect(rec!.filtersFired[1]).toMatchObject({ guard: 'perpVeto', verdict: 'would-block' });
  });

  it('pWinCalibrated missing → winRatePct fallback; dono missing → null', () => {
    // NOTE: dedup 30-min bucket — alag-alag case ke liye alag bucket use hota hai
    const a = recordMtfBoardScanRow(baseRow({ pWinCalibrated: undefined, winRatePct: 55 }), { now: T0 });
    expect(a!.pWinClaimed).toBeCloseTo(0.55, 9);
    const b = recordMtfBoardScanRow(baseRow({ pWinCalibrated: undefined, winRatePct: undefined }), { now: T0 + 31 * 60_000 });
    expect(b!.pWinClaimed).toBeNull();
  });

  it('lookahead-free: snapshot me sirf row ke signal-time fields (future data ka koi reference nahi)', () => {
    const rec = recordMtfBoardScanRow(baseRow(), { now: T0 });
    const snap = JSON.stringify(rec!.featureSnapshot);
    expect(snap).not.toContain('resolved');
    expect(snap).not.toContain('outcomeR');
    expect(snap).not.toContain('mfe');
  });

  it('filtersFired cap 24 (memory-bloat guard)', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ guard: `g${i}`, verdict: 'allow' }));
    const rec = recordMtfBoardScanRow(baseRow({ filtersFired: many }), { now: T0 });
    expect(rec!.filtersFired.length).toBeLessThanOrEqual(24);
  });

  it('v1 (legacy) rows hydrate par v2 settle hote hain — resolve/outcome untouched', () => {
    const legacyRow = {
      id: 'mtf-AAA-INTRADAY-1', symbol: 'AAA', market: 'CRYPTO', mode: 'INTRADAY',
      side: 'LONG', tier: 'STRONG', superScore: 82, entry: 100, stopLoss: 98,
      t1: 103, t2: 106, risk: 2, holdMin: 60, ts: T0,
      resolved: true, resolvedAt: T0 + 1000, outcome: 'T1_HIT', outcomeR: 1.5,
    };
    const res = hydrateMtfLedger([legacyRow]);
    expect(res.total).toBe(1);
    const row = getMtfLedgerSnapshot().rows[0];
    expect(row.schemaVersion).toBe(2);
    expect(row.regime).toBeNull();
    expect(row.pWinClaimed).toBeNull();
    expect(row.featureSnapshot.tier).toBe('STRONG');
    expect(row.outcome).toBe('T1_HIT');
    expect(row.outcomeR).toBe(1.5);
  });

  it('v2 rows hydrate par enrichment survive karti hai (persistence round-trip)', () => {
    const rec = recordMtfBoardScanRow(baseRow(), { now: T0 });
    const snap = getMtfLedgerSnapshot();
    // CLONE karo — snap.rows live reference hai, hydrate usi ko clear karta hai
    const persisted = JSON.parse(JSON.stringify(snap.rows));
    hydrateMtfLedger(persisted, { lastLogAt: snap.lastLogAt, lastResolveAt: snap.lastResolveAt });
    const again = getMtfLedgerSnapshot().rows.find((r: any) => r.id === rec!.id);
    expect(again).toBeDefined();
    expect(again!.schemaVersion).toBe(2);
    expect(again!.featureSnapshot.ctx.er).toBe(0.41);
    expect(again!.pWinClaimed).toBeCloseTo(0.62, 9);
    expect(again!.filtersFired).toHaveLength(2);
    expect(again!.latencyMs).toBe(250);
  });
});

describe('v21.32.0 A4 — scorecard v2 slices + CI + calibration', () => {
  const now = T0 + 40 * 60_000;
  let seq = 0;

  function seed(outcome: 'T1_HIT' | 'SL_HIT' | 'TIMEOUT', over: Record<string, any> = {}) {
    // unique symbol per seed — 30-min dedup collapse se bachne ke liye
    const rec: any = recordMtfBoardScanRow(baseRow({ symbol: `S${seq++}`, ...over }), { now });
    if (outcome === 'T1_HIT') {
      rec.resolved = true; rec.resolvedAt = now; rec.outcome = 'T1_HIT';
      rec.outcomeR = 2; rec.directionHit = true; rec.t1HitAt = now - 5 * 60_000;
    } else if (outcome === 'SL_HIT') {
      rec.resolved = true; rec.resolvedAt = now; rec.outcome = 'SL_HIT';
      rec.outcomeR = -1; rec.directionHit = false; rec.maeR = 1;
    }
    return rec;
  }

  it('overall slice: Wilson CI + bootstrap CI + ECE/Brier + min-n gate', () => {
    for (let i = 0; i < 6; i++) seed('T1_HIT', { pWinCalibrated: 70 });
    for (let i = 0; i < 4; i++) seed('SL_HIT', { pWinCalibrated: 40 });
    const sc = computeMtfDirectionScorecardV2({ windowDays: 30, now });
    const o = sc.overall;
    expect(o.n).toBe(10);
    expect(o.gate.state).toBe('insufficient'); // n=10 < 30
    expect(o.hitTp1Pct).toBe(60);
    expect(o.hitTp1WilsonCI.lo).toBeLessThan(60);
    expect(o.hitTp1WilsonCI.hi).toBeGreaterThan(60);
    expect(o.expectancyR).toBeCloseTo(0.8, 6); // (6*2 + 4*-1)/10
    expect(o.expectancyBootstrapCI.lo).toBeLessThanOrEqual(o.expectancyR + 0.01);
    expect(o.expectancyBootstrapCI.hi).toBeGreaterThanOrEqual(o.expectancyR - 0.01);
    // claimed 0.7/0.4 mix → realised 0.6 → ECE measurable, Brier > 0
    expect(o.ece).not.toBeNull();
    expect(o.eceN).toBe(10);
    expect(o.brier).toBeGreaterThan(0);
    expect(minNGate(o.n).decisionGrade).toBe(false);
  });

  it('byTier / byRegime / bySide / bySession slices populate hote hain', () => {
    seed('T1_HIT', { tier: 'ELITE', regime: 'TREND_UP' });
    seed('SL_HIT', { tier: 'WATCH', regime: 'CHOP', side: 'SHORT', boardSide: 'SHORT' });
    const sc = computeMtfDirectionScorecardV2({ windowDays: 30, now });
    expect(sc.byTier.ELITE.n).toBe(1);
    expect(sc.byTier.ELITE.hitTp1Pct).toBe(100);
    expect(sc.byTier.WATCH.hitTp1Pct).toBe(0);
    expect(sc.byRegime.TREND_UP.n).toBe(1);
    expect(sc.byRegime.CHOP.n).toBe(1);
    expect(sc.bySide.SHORT.n).toBe(1);
    expect(Object.keys(sc.bySession).length).toBeGreaterThan(0);
    expect(sc.byTierRegime['ELITE|TREND_UP'].n).toBe(1);
    expect(sc.version).toBe(2);
    expect(sc.schemaVersionCoverage.v2).toBe(2);
  });

  it('ECE/Brier absent jab pWinClaimed record nahi hua (honest null, fabricate nahi)', () => {
    seed('T1_HIT', { pWinCalibrated: undefined, winRatePct: undefined });
    seed('SL_HIT', { pWinCalibrated: undefined, winRatePct: undefined });
    const sc = computeMtfDirectionScorecardV2({ windowDays: 30, now });
    expect(sc.overall.ece).toBeNull();
    expect(sc.overall.brier).toBeNull();
    expect(sc.overall.eceN).toBe(0);
    expect(sc.pWinCoveragePct).toBe(0);
  });

  it('min-n gates: 150+ resolved → decision-grade', () => {
    for (let i = 0; i < 155; i++) seed('T1_HIT');
    const sc = computeMtfDirectionScorecardV2({ windowDays: 30, now });
    expect(sc.overall.n).toBeGreaterThanOrEqual(150);
    expect(sc.overall.gate.state).toBe('decision-grade');
    expect(sc.overall.gate.decisionGrade).toBe(true);
  });

  it('pWin overconfidence detectable: claimed 0.9 vs realised 0.5 → bada ECE', () => {
    for (let i = 0; i < 10; i++) seed(i % 2 === 0 ? 'T1_HIT' : 'SL_HIT', { pWinCalibrated: 90 });
    const overconf = computeMtfDirectionScorecardV2({ windowDays: 30, now }).overall.ece;
    __resetMtfLedgerForTests();
    for (let i = 0; i < 10; i++) seed(i % 2 === 0 ? 'T1_HIT' : 'SL_HIT', { pWinCalibrated: 50 });
    const honest = computeMtfDirectionScorecardV2({ windowDays: 30, now }).overall.ece;
    expect(overconf!).toBeGreaterThan(honest!);
  });
});

describe('v21.32.0 A3 — enrichment resolve ke saath compatible (regression)', () => {
  it('enriched row resolve hota hai jaise pehle (SL/TP/timeout logic untouched)', () => {
    recordMtfBoardScanRow(baseRow(), { now: T0 });
    const res = resolveMtfBoardScanOutcomes({
      candlesBySymbol: { AAA: [{ time: T0 + 60_000, high: 99, low: 97.5, close: 98 }] },
      now: T0 + 120_000,
    });
    expect(res.resolvedNow).toBe(1);
    const row = getMtfLedgerSnapshot().rows[0];
    expect(row.outcome).toBe('SL_HIT');
    expect(row.schemaVersion).toBe(2); // enrichment intact after resolve
    expect(row.featureSnapshot.ctx.adx).toBe(24.5);
  });
});
