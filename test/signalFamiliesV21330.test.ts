// ============================================================
// test/signalFamiliesV21330.test.ts — v21.33.0 PHASE D TESTS
// ------------------------------------------------------------
//   • D1  classifySignalFamily — regime→family routing
//   • D1  evaluateFamilyFit — valid/forbidden regimes + minScore
//   • D2  evaluateHierarchicalMtf — HTF veto layer + counter-trend
//   • D3  groupedConfluenceScore — per-group caps + renormalization
//   • D4  composeVetoStack — fail-closed (certificate) + fail-open
//         (missing data) + ordered stack
//   • INVARIANT: koi bhi family function SIDE flip nahi karta
// ============================================================
import { describe, it, expect } from 'vitest';
import {
  FAMILIES, classifySignalFamily, evaluateFamilyFit,
  evaluateHierarchicalMtf, groupedConfluenceScore, composeVetoStack,
  CONFLUENCE_GROUPS,
} from '../server/ai/signalFamilies.js';

const trendRow = {
  regime: 'TREND_UP',
  context: { adx: 24, er: 0.42, dir: 1, squeezeFired: false },
  trigger: { dir: 1, volRatio: 1.2 },
};
const chopRow = {
  regime: 'CHOP',
  context: { adx: 11, er: 0.12, dir: 0 },
  trigger: { dir: 0, volRatio: 0.8 },
};
const squeezeRow = {
  regime: 'SQUEEZE',
  context: { adx: 10, er: 0.15, dir: 0, squeezeFired: true },
  trigger: { dir: 1, volRatio: 1.9 },
};

describe('v21.33.0 D1 — classifySignalFamily', () => {
  it('TREND regime → TREND_PULLBACK primary', () => {
    const c = classifySignalFamily({ row: trendRow });
    expect(c.regime).toBe('TREND_UP');
    expect(c.primary).toBe('TREND_PULLBACK');
  });
  it('squeezeFired → BREAKOUT_SQUEEZE primary', () => {
    const c = classifySignalFamily({ row: squeezeRow });
    expect(c.primary).toBe('BREAKOUT_SQUEEZE');
  });
  it('CHOP me mean-reversion sirf flag ON par', () => {
    expect(classifySignalFamily({ row: chopRow, meanRevEnabled: false }).primary).not.toBe('MEAN_REVERSION');
    expect(classifySignalFamily({ row: chopRow, meanRevEnabled: true }).primary).toBe('MEAN_REVERSION');
  });
  it('CHOP me trend-follow would-block evidence', () => {
    const c = classifySignalFamily({ row: chopRow });
    expect(c.fits.TREND_PULLBACK.wouldBlock).toBe(true);
    expect(c.fits.MOMENTUM_CONTINUE.wouldBlock).toBe(true);
  });
  it('family specs frozen: 4 families with regime tables', () => {
    expect(Object.keys(FAMILIES).sort()).toEqual(['BREAKOUT_SQUEEZE', 'MEAN_REVERSION', 'MOMENTUM_CONTINUE', 'TREND_PULLBACK']);
    expect(FAMILIES.MEAN_REVERSION.counterTrend).toBe(true);
    expect(FAMILIES.TREND_PULLBACK.counterTrend).toBe(false);
    expect(FAMILIES.TREND_PULLBACK.forbiddenRegimes).toContain('CHOP');
  });
});

describe('v21.33.0 D1 — evaluateFamilyFit', () => {
  it('TREND_PULLBACK in TREND_UP → no block', () => {
    const f = evaluateFamilyFit({ row: trendRow, side: 'LONG', family: 'TREND_PULLBACK', score: 80, mode: 'shadow' });
    expect(f.wouldBlock).toBe(false);
    expect(f.blocked).toBe(false); // shadow kabhi block nahi karta
    expect(f.shadow).toBe(true);
  });
  it('TREND_PULLBACK in CHOP → wouldBlock (shadow me bhi blocked=false)', () => {
    const f = evaluateFamilyFit({ row: chopRow, side: 'LONG', family: 'TREND_PULLBACK', score: 80, mode: 'shadow' });
    expect(f.wouldBlock).toBe(true);
    expect(f.blocked).toBe(false);
  });
  it('enforce me wouldBlock → blocked=true', () => {
    const f = evaluateFamilyFit({ row: chopRow, side: 'LONG', family: 'TREND_PULLBACK', score: 80, mode: 'enforce' });
    expect(f.blocked).toBe(true);
  });
  it('score below family minScore → reason me dikhta hai', () => {
    const f = evaluateFamilyFit({ row: trendRow, side: 'LONG', family: 'TREND_PULLBACK', score: 60 });
    expect(f.wouldBlock).toBe(true);
    expect(f.reasons.some(r => r.includes('minScore'))).toBe(true);
  });
  it('no family classifiable → NEUTRAL verdict, no block', () => {
    const f = evaluateFamilyFit({ row: { regime: 'UNKNOWN' }, side: 'LONG' });
    expect(f.verdict).toBe('NEUTRAL');
    expect(f.wouldBlock).toBe(false);
  });
  // v21.35.0 [A4]: regime object bina string label ke pehle String() se
  // '[OBJECT OBJECT]' ban jaata tha — always-truthy fake regime label.
  it('v21.35.0 [A4]: regime OBJECT without label → classifyRowRegime fallback (no [OBJECT OBJECT])', () => {
    const row = { regime: { score: 12 }, context: { dir: 1, adx: 24, er: 0.42 }, trigger: { dir: 1, volRatio: 1.2 } };
    const c = classifySignalFamily({ row });
    expect(c.regime).not.toContain('OBJECT');
    expect(c.regime).toBe('TREND_UP'); // evidence-based fallback chala
    expect(c.primary).toBe('TREND_PULLBACK');
    // array regime bhi object hai — wahi fallback
    const arr = classifySignalFamily({ row: { regime: ['CHOP'] } });
    expect(arr.regime).not.toContain('OBJECT');
  });
  it('v21.35.0 [A4]: regime object WITH string label → label hi use hota hai', () => {
    const c = classifySignalFamily({ row: { regime: { label: 'CHOP' }, context: { adx: 11, er: 0.12 } } });
    expect(c.regime).toBe('CHOP');
  });
  it('v21.35.0 [A4]: score fallback chain me row.score bhi (fv:2 rows superScore nahi rakhte)', () => {
    // superScore absent, sirf row.score — pehle sc null tha → minScore check skip
    const f = evaluateFamilyFit({ row: { regime: 'TREND_UP', score: 60 }, side: 'LONG', family: 'TREND_PULLBACK' });
    expect(f.reasons.some(r => r.includes('minScore'))).toBe(true);
    const ok = evaluateFamilyFit({ row: { regime: 'TREND_UP', score: 80 }, side: 'LONG', family: 'TREND_PULLBACK' });
    expect(ok.wouldBlock).toBe(false);
  });
});

describe('v21.33.0 D2 — evaluateHierarchicalMtf', () => {
  it('HTF BEARISH against LONG → veto (non-counter-trend family)', () => {
    const h = evaluateHierarchicalMtf({ side: 'LONG', htfBias: 'BEARISH', contextDir: 1, triggerDir: 1, family: 'TREND_PULLBACK' });
    expect(h.htfVeto).toBe(true);
    expect(h.wouldBlock).toBe(true);
    expect(h.reasons[0]).toContain('HTF BEARISH against LONG');
  });
  it('HTF against LONG par MEAN_REVERSION (counter-trend allowed) → NO veto, stricter score note', () => {
    const h = evaluateHierarchicalMtf({ side: 'LONG', htfBias: 'BEARISH', contextDir: 0, triggerDir: 0, family: 'MEAN_REVERSION' });
    expect(h.htfVeto).toBe(false);
    expect(h.wouldBlock).toBe(false);
    expect(h.reasons[0]).toContain('counter-trend allowed');
  });
  it('v21.34.0: counter-trend score < strictScore → VETO (stricter-score rule ab enforce hota hai)', () => {
    const h = evaluateHierarchicalMtf({ side: 'LONG', htfBias: 'BEARISH', contextDir: 0, triggerDir: 0, family: 'MEAN_REVERSION', score: 61 });
    expect(h.htfVeto).toBe(true);
    expect(h.wouldBlock).toBe(true);
    expect(h.reasons[0]).toContain('score 61 < strict 82');
  });
  it('v21.34.0: counter-trend score ≥ strictScore → waiver (honest pass)', () => {
    const h = evaluateHierarchicalMtf({ side: 'SHORT', htfBias: 'BULLISH', contextDir: 0, triggerDir: 0, family: 'MEAN_REVERSION', score: 88 });
    expect(h.htfVeto).toBe(false);
    expect(h.reasons[0]).toContain('score 88');
  });
  it('HTF BULLISH with LONG → agreement high, no veto', () => {
    const h = evaluateHierarchicalMtf({ side: 'LONG', htfBias: 'BULLISH', contextDir: 1, triggerDir: 1 });
    expect(h.wouldBlock).toBe(false);
    expect(h.agreement).toBeCloseTo(1, 3);
    expect(h.weightSum).toBeCloseTo(1, 3);
  });
  it('missing layers → weightSum partial (renormalized confidence)', () => {
    const h = evaluateHierarchicalMtf({ side: 'LONG', htfBias: 'BULLISH', contextDir: null, triggerDir: null });
    expect(h.weightSum).toBeCloseTo(0.40, 3);
    expect(h.agreement).toBeCloseTo(1, 3);
  });
});

describe('v21.33.0 D3 — groupedConfluenceScore', () => {
  const TOTAL_CAP = Object.values(CONFLUENCE_GROUPS).reduce((a, g) => a + g.cap, 0); // 1.40
  it('per-group cap enforced: ek group ko 100% aligned dalne par contribution ≤ cap', () => {
    const comps = [
      { group: 'trend', k: 'emaStack', dir: 1 },
      { group: 'trend', k: 'supertrend', dir: 1 },
      { group: 'trend', k: 'adx', dir: 1 },
    ];
    const g = groupedConfluenceScore(comps, { side: 'LONG' });
    const trend = g.groups.find(x => x.group === 'trend');
    expect(trend.contribution).toBeCloseTo(CONFLUENCE_GROUPS.trend.cap, 4);
    expect(trend.capped).toBe(true); // v21.34.0: honest capped flag
    // v21.34.0 [SCALE HONESTY]: score ab TRUE [0..1] normalized
    expect(g.rawScore).toBeCloseTo(CONFLUENCE_GROUPS.trend.cap, 4);
    expect(g.score).toBeCloseTo(CONFLUENCE_GROUPS.trend.cap / TOTAL_CAP, 4);
    expect(g.score).toBeLessThanOrEqual(1);
    expect(g.weightSum).toBeCloseTo(CONFLUENCE_GROUPS.trend.cap / TOTAL_CAP, 4); // availability
  });
  it('double-counting rok: teen momentum indicators bhi ek hi group cap ke andar', () => {
    const one = groupedConfluenceScore([{ group: 'momentum', k: 'rsi', dir: 1 }], { side: 'LONG' });
    const three = groupedConfluenceScore([
      { group: 'momentum', k: 'rsi', dir: 1 },
      { group: 'momentum', k: 'macd', dir: 1 },
      { group: 'momentum', k: 'roc', dir: 1 },
    ], { side: 'LONG' });
    expect(three.groups.find(x => x.group === 'momentum').contribution)
      .toBeCloseTo(one.groups.find(x => x.group === 'momentum').contribution, 4);
  });
  it('against-votes aligned ko dilute karte hain', () => {
    const aligned = groupedConfluenceScore([
      { group: 'trend', k: 'a', dir: 1 }, { group: 'trend', k: 'b', dir: 1 },
    ], { side: 'LONG' });
    const mixed = groupedConfluenceScore([
      { group: 'trend', k: 'a', dir: 1 }, { group: 'trend', k: 'b', dir: -1 },
    ], { side: 'LONG' });
    expect(mixed.score).toBeLessThan(aligned.score);
    expect(mixed.score).toBe(0); // frac = (1-1)/2 = 0
  });
  it('unknown group ignore; empty → score 0, weightSum 0', () => {
    const g = groupedConfluenceScore([{ group: 'nope', k: 'x', dir: 1 }], { side: 'LONG' });
    expect(g.score).toBe(0);
    expect(g.weightSum).toBe(0);
  });
  it('v21.34.0: saare groups fully aligned → score exactly 1.0 (0..1 scale)', () => {
    const comps = Object.entries(CONFLUENCE_GROUPS).flatMap(([g, def]) =>
      def.components.map(k => ({ group: g, k, dir: 1 })));
    const g = groupedConfluenceScore(comps, { side: 'LONG' });
    expect(g.score).toBeCloseTo(1, 4);
    expect(g.weightSum).toBeCloseTo(1, 4);
    expect(g.rawScore).toBeCloseTo(TOTAL_CAP, 4);
  });
});

describe('v21.33.0 D4 — composeVetoStack', () => {
  it('fail-open: missing guards skip hote hain, coverage honest', () => {
    const v = composeVetoStack({
      liquiditySpread: { available: true, wouldBlock: true },
    });
    expect(v.stack.length).toBe(10);
    expect(v.coverage).toBeCloseTo(0.1, 3);
    expect(v.wouldBlock).toBe(true);
    expect(v.firstBlock).toBe('liquiditySpread');
  });
  it('fail-closed: direction certificate invalid → hard block chahe koi aur na ho', () => {
    const v = composeVetoStack({
      directionCertificate: { available: true, wouldBlock: true, reason: 'ORDER_SIDE_MISMATCH' },
    });
    expect(v.failClosedOn).toBe('directionCertificate');
    expect(v.wouldBlock).toBe(true);
  });
  it('sab allow → wouldBlock false', () => {
    const v = composeVetoStack({
      priceCrosscheck: { available: true, wouldBlock: false },
      directionCertificate: { available: true, wouldBlock: false },
      riskCaps: { available: true, wouldBlock: false },
    });
    expect(v.wouldBlock).toBe(false);
    expect(v.blockingCount).toBe(0);
  });
  it('stack order frozen (plan D4 ordering)', () => {
    const v = composeVetoStack({});
    expect(v.stack.map(s => s.name)).toEqual([
      'priceCrosscheck', 'liquiditySpread', 'entryTiming', 'eventSession',
      'regimeFamilyFit', 'perpCrowding', 'cluster', 'reversalRisk',
      'directionCertificate', 'riskCaps',
    ]);
  });
});

describe('v21.33.0 INVARIANT — family functions side kabhi flip nahi karte', () => {
  it('har family/fit/hmtf output me side sirf echo hota hai', () => {
    for (const side of ['LONG', 'SHORT']) {
      const f = evaluateFamilyFit({ row: trendRow, side, family: 'TREND_PULLBACK', score: 80 });
      expect(f.side).toBe(side);
      const h = evaluateHierarchicalMtf({ side, htfBias: 'BULLISH', contextDir: 1, triggerDir: 1 });
      expect(h.side).toBe(side);
      const g = groupedConfluenceScore([{ group: 'trend', k: 'a', dir: 1 }], { side });
      expect(g.side).toBe(side);
    }
  });
});
