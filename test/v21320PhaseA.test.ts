// ============================================================
// test/v21320PhaseA.test.ts — v21.32.0 PHASE A2 UNIT TESTS
// ------------------------------------------------------------
//   • tripleBarrier labeler (conservative: same-bar SL+TP → SL pehle)
//   • stats utils (wilson, bootstrap, ECE, Brier, PF, DD, minNGate)
//   • directionAccuracyAtH
// Locks the master-plan code sketches exactly.
// ============================================================
import { describe, it, expect } from 'vitest';
import { labelSignal, directionAccuracyAtH } from '../scripts/lib/tripleBarrier.js';
import {
  wilson, bootstrapMeanCI, bootstrapCompareMean, expectedCalibrationError,
  brierScore, profitFactor, expectancyR, maxDrawdownR, bootstrapDrawdownP95, minNGate,
} from '../scripts/lib/stats.js';

const T0 = 1_790_000_000_000;
const bar = (t: number, h: number, l: number, c = (h + l) / 2) => ({ t, h, l, c });

describe('v21.32.0 A2 — triple-barrier labeler (conservative)', () => {
  const base = { side: 'LONG', entry: 100, sl: 98, tp1: 104, tp2: 108, horizon: 48 };

  it('TP1 barrier first-touch → label TP1 with MFE/MAE + time-to-touch', () => {
    const out = labelSignal({ ...base, bars: [bar(T0, 101, 99), bar(T0 + 1, 105, 100), bar(T0 + 2, 106, 102)] });
    expect(out?.label).toBe('TP1');
    expect(out?.bar).toBe(1);
    expect(out?.timeToTouch).toBe(1);
    expect(out?.mfe).toBe(5);   // 105 − 100
    expect(out?.mae).toBe(1);   // 100 − 99
  });

  it('TP2 pehle touch ho to TP2 (TP1 se pehle hi bar me)', () => {
    const out = labelSignal({ ...base, bars: [bar(T0, 109, 100)] });
    expect(out?.label).toBe('TP2');
  });

  it('CONSERVATIVE TIE: same bar me SL aur TP dono → SL pehle maana jaata hai', () => {
    // bar ka low 97.9 (SL hit) aur high 104.5 (TP1 hit) — tie → SL
    const out = labelSignal({ ...base, bars: [bar(T0, 104.5, 97.9)] });
    expect(out?.label).toBe('SL');
    expect(out?.mfe).toBeCloseTo(4.5, 6);
    expect(out?.mae).toBeCloseTo(2.1, 6);
  });

  it('SL pehle touch → SL', () => {
    const out = labelSignal({ ...base, bars: [bar(T0, 101, 99.5), bar(T0 + 1, 102, 97.5)] });
    expect(out?.label).toBe('SL');
    expect(out?.bar).toBe(1);
  });

  it('koi barrier nahi within horizon → TIMEOUT', () => {
    const bars = Array.from({ length: 60 }, (_, i) => bar(T0 + i, 101.5, 99.5));
    const out = labelSignal({ ...base, bars, horizon: 48 });
    expect(out?.label).toBe('TIMEOUT');
    expect(out?.bar).toBe(48);
    expect(out?.timeToTouch).toBeNull();
  });

  it('horizon se aage ke bars scan nahi hote', () => {
    const bars = [bar(T0, 101, 99), bar(T0 + 1, 105, 100)]; // TP1 sirf 2nd bar me
    const out = labelSignal({ ...base, bars, horizon: 1 });
    expect(out?.label).toBe('TIMEOUT');
  });

  it('SHORT mirror parity', () => {
    const out = labelSignal({
      side: 'SHORT', entry: 100, sl: 102, tp1: 96, tp2: 92, horizon: 48,
      bars: [bar(T0, 101, 99), bar(T0 + 1, 101.5, 95)], // high 101.5 < SL 102 — SL untouched
    });
    expect(out?.label).toBe('TP1');
    expect(out?.mfe).toBe(5);               // 100 − 95
    expect(out?.mae).toBeCloseTo(1.5, 6);   // max(101−100, 101.5−100)
    // SHORT tie: high 102.5 (SL) + low 95.5 (TP1) same bar → SL
    const tie = labelSignal({
      side: 'SHORT', entry: 100, sl: 102, tp1: 96, horizon: 48,
      bars: [bar(T0, 102.5, 95.5)],
    });
    expect(tie?.label).toBe('SL');
  });

  it('invalid inputs par honest null (fabricated label nahi)', () => {
    expect(labelSignal({ ...base, bars: [] })).toBeNull();
    expect(labelSignal({ ...base, bars: [bar(T0, 1, 1)], entry: 0 })).toBeNull();
    expect(labelSignal({ ...base, side: 'SIDEWAYS', bars: [bar(T0, 1, 1)] })).toBeNull();
    expect(labelSignal({ ...base, horizon: 0, bars: [bar(T0, 1, 1)] })).toBeNull();
    // ulta plan (LONG me SL upar) → null
    expect(labelSignal({ ...base, sl: 102, bars: [bar(T0, 103, 99)] })).toBeNull();
  });

  it('directionAccuracyAtH: 0.5×ATR move test (null on insufficient)', () => {
    expect(directionAccuracyAtH({ side: 'LONG', entry: 100, atr: 2, closeAtH: 101.2 })).toBe(true);
    expect(directionAccuracyAtH({ side: 'LONG', entry: 100, atr: 2, closeAtH: 100.9 })).toBe(false);
    expect(directionAccuracyAtH({ side: 'SHORT', entry: 100, atr: 2, closeAtH: 98.7 })).toBe(true);
    expect(directionAccuracyAtH({ side: 'LONG', entry: 100, atr: 0, closeAtH: 101 })).toBeNull();
  });
});

describe('v21.32.0 A-stats — wilson / bootstrap / calibration', () => {
  it('wilson: n=0 null; symmetric-ish CI; 18.2 formula', () => {
    expect(wilson(0, 0)).toEqual({ lo: null, hi: null, p: null });
    const w = wilson(60, 100);
    expect(w.p).toBeCloseTo(0.6, 12);
    expect(w.lo).toBeGreaterThan(0.5);
    expect(w.hi).toBeLessThan(0.7);
    expect(w.lo).toBeLessThan(w.hi);
    // perfect score par bhi CI ka lower bound < 1 (honest shrinkage)
    const perfect = wilson(100, 100);
    expect(perfect.hi).toBeCloseTo(1, 9);
    expect(perfect.lo).toBeLessThan(1);
  });

  it('bootstrapMeanCI deterministic (same seed = same CI) + mean preserved', () => {
    const xs = [1, -1, 2, -2, 0.5, -0.5, 3, -3];
    const a = bootstrapMeanCI(xs, 2000, 5);
    const b = bootstrapMeanCI(xs, 2000, 5);
    expect(a).toEqual(b);
    expect(a.mean).toBeCloseTo(0, 12);
    expect(a.lo).toBeLessThanOrEqual(a.mean + 1e-9);
    expect(a.hi).toBeGreaterThanOrEqual(a.mean - 1e-9);
    expect(bootstrapMeanCI([], 100, 1).mean).toBeNull();
  });

  it('bootstrapCompareMean: clearly-better set → chhota p; identical → bada p', () => {
    const worse = Array.from({ length: 60 }, (_, i) => -1 + 0.1 * Math.sin(i));
    const better = Array.from({ length: 60 }, (_, i) => 1 + 0.1 * Math.cos(i));
    const cmp = bootstrapCompareMean(worse, better, { iters: 800, seed: 3 });
    expect(cmp.diffMeans).toBeGreaterThan(1.8);
    expect(cmp.p!).toBeLessThan(0.05);
    const same = Array.from({ length: 60 }, (_, i) => Math.sin(i) * 0.1);
    const cmp2 = bootstrapCompareMean(same, [...same], { iters: 800, seed: 3 });
    expect(cmp2.p!).toBeGreaterThan(0.3);
    expect(bootstrapCompareMean([], better)).toEqual({ p: null, diffMeans: null });
  });

  it('ECE + Brier: perfectly calibrated → ~0; overconfident → bada', () => {
    const perfect = Array.from({ length: 200 }, (_, i) => ({ p: 0.7, y: (i % 10 < 7) ? 1 : 0 }));
    expect(expectedCalibrationError(perfect)!).toBeLessThan(0.05);
    expect(brierScore(perfect)!).toBeGreaterThan(0);
    const over = Array.from({ length: 200 }, () => ({ p: 0.9, y: 0 }));
    expect(expectedCalibrationError(over)!).toBeGreaterThan(0.8);
    expect(brierScore(over)!).toBeGreaterThan(0.8);
    expect(expectedCalibrationError([])).toBeNull();
    expect(brierScore([])).toBeNull();
  });

  it('profitFactor / expectancy / drawdown / minNGate', () => {
    expect(profitFactor([2, 2, -1, -1])).toBeCloseTo(2, 9);
    expect(profitFactor([1, 2, 3])).toBeNull();          // no losses → honest null (∞ nahi)
    expect(expectancyR([2, -1, 2, -1])).toBeCloseTo(0.5, 9);
    expect(expectancyR([])).toBeNull();
    const dd = maxDrawdownR([1, 1, -3, 1]);
    expect(dd.ddR).toBe(3); // cum: 1,2,-1,0 → peak 2, trough −1 → DD 3R
    expect(dd.peakR).toBe(2);
    expect(bootstrapDrawdownP95([1, -1, 1, -1])).toBeGreaterThanOrEqual(0);
    expect(minNGate(5).state).toBe('insufficient');
    expect(minNGate(29).decisionGrade).toBe(false);
    expect(minNGate(30).state).toBe('early');
    expect(minNGate(100).state).toBe('reviewable');
    expect(minNGate(150).decisionGrade).toBe(true);
    expect(minNGate(999).state).toBe('decision-grade');
  });
});
