// ============================================================
// test/adaptiveTargetsV21330.test.ts — v21.33.0 PHASE G TESTS
// ------------------------------------------------------------
//   • G2  mfePercentileTargets — winners-only distribution + fallback
//   • G2  evaluateAdaptiveTargets — GEOMETRY INVARIANT (direction):
//         LONG → sl < entry < t1 < t2 · SHORT mirror; invalid → reject
//   • G6  volTargetMultiplier — clamp [0.5, 1.0] (kabhi > 1 nahi)
//   • G6  kellyResearchFraction — refusal gates (ECE, n, edge)
// ============================================================
import { describe, it, expect } from 'vitest';
import {
  mfePercentileTargets, evaluateAdaptiveTargets,
  volTargetMultiplier, kellyResearchFraction,
} from '../server/ai/adaptiveTargets.js';

function winners(n, { t1 = 1.0, spread = [0.8, 2.6], side = 'LONG' } = {}) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const mfe = spread[0] + (spread[1] - spread[0]) * ((i * 37) % 100) / 100;
    out.push({
      resolved: true, outcome: i % 3 === 0 ? 'T2_HIT' : 'T1_HIT',
      mfeR: +mfe.toFixed(3), regime: 'TREND_UP', side,
    });
  }
  return out;
}

describe('v21.33.0 G2 — mfePercentileTargets', () => {
  it('sufficient winners → TP1 < TP2, dono positive R', () => {
    const t = mfePercentileTargets({ rows: winners(60) });
    expect(t.available).toBe(true);
    expect(t.nWinners).toBe(60);
    expect(t.tp1R).toBeGreaterThan(0);
    expect(t.tp2R).toBeGreaterThan(t.tp1R);
    expect(t.source).toBe('all');
  });
  it('n < 30 winners → honest fallback 1R/2R', () => {
    const t = mfePercentileTargets({ rows: winners(10) });
    expect(t.available).toBe(false);
    expect(t.tp1R).toBe(1);
    expect(t.tp2R).toBe(2);
    expect(t.reason).toContain('insufficient');
  });
  // v21.35.0 [A15 DE-CENSOR]: winners-only filter censored tha — rows
  // static TP touch par resolve hote hain (MFE ≈ t1R/t2R cap), isliye
  // estimator wahi static levels re-derive karta tha. Ab population =
  // ALL resolved rows with mfeR > 0 (losers jo +0.5R run karke stop hue
  // wahi lower TP1 band ka evidence hain).
  it('v21.35.0 [A15]: SL_HIT losers with mfeR>0 ab COUNT hote hain (population all-resolved-mfe>0)', () => {
    const rows = [...winners(40), { resolved: true, outcome: 'SL_HIT', mfeR: 0.2 }];
    const t = mfePercentileTargets({ rows });
    expect(t.nWinners).toBe(41); // v21.35.0: losers bhi — pehle 40 tha
    expect(t.population).toBe('all-resolved-mfe>0');
    // mfeR <= 0 / null rows me koi TP evidence nahi — exclude hi rehte hain
    const noEvidence = mfePercentileTargets({
      rows: [...winners(40), { resolved: true, outcome: 'SL_HIT', mfeR: 0 }, { resolved: true, outcome: 'SL_HIT', mfeR: null }],
    });
    expect(noEvidence.nWinners).toBe(40);
  });
  it('v21.35.0 [A15]: de-censor se lower TP1 band DISCOVER hota hai (winners-only me kabhi nahi hota tha)', () => {
    // winners sab ≈1R par resolve (T1-touch censoring), losers 0.4–0.58R ran
    const capped = winners(40, { spread: [0.95, 1.05] });
    const losers = Array.from({ length: 60 }, (_, i) => ({
      resolved: true, outcome: 'SL_HIT', mfeR: +(0.4 + (i % 10) / 50).toFixed(3),
      regime: 'TREND_UP', side: 'LONG',
    }));
    const oldStyle = mfePercentileTargets({ rows: capped });        // winners-only population
    const decensor = mfePercentileTargets({ rows: [...capped, ...losers] });
    expect(oldStyle.tp1R).toBeGreaterThanOrEqual(0.95);            // censored ≈ static 1R hi
    expect(decensor.tp1R).toBeLessThan(oldStyle.tp1R);             // 0.7R-class band mila
    expect(decensor.tp1R).toBeLessThanOrEqual(0.7);
    expect(decensor.population).toBe('all-resolved-mfe>0');
  });
  // v21.35.0 [A16a]: empty population (ya minWinners<=0 edge) par pehle
  // _percentile([]) → null.toFixed TypeError — ab honest static fallback.
  it('v21.35.0 [A16a]: khali rows + minWinners 0 edge → static fallback, TypeError nahi', () => {
    expect(() => mfePercentileTargets({ rows: [], cfg: { minWinners: 0 } })).not.toThrow();
    const t = mfePercentileTargets({ rows: [], cfg: { minWinners: 0 } });
    expect(t.available).toBe(false);
    expect(t.tp1R).toBe(1);
    expect(t.tp2R).toBe(2);
    expect(t.reason).toContain('insufficient');
    expect(t.population).toBe('all-resolved-mfe>0');
    // sab rows mfeR<=0 → same honest fallback
    const z = mfePercentileTargets({ rows: [{ resolved: true, outcome: 'SL_HIT', mfeR: 0 }], cfg: { minWinners: 0 } });
    expect(z.available).toBe(false);
  });
  it('regime filter: sirf usi regime ke winners', () => {
    const rows = [
      ...winners(40),
      ...winners(40, { spread: [2.0, 3.4] }).map(r => ({ ...r, regime: 'HIGH_VOL' })),
    ];
    const all = mfePercentileTargets({ rows });
    const hv = mfePercentileTargets({ rows, regime: 'HIGH_VOL' });
    expect(all.nWinners).toBe(80);
    expect(hv.nWinners).toBe(40);
    expect(hv.tp2R).toBeGreaterThan(all.tp2R);
  });
  it('side filter', () => {
    const rows = [...winners(40), ...winners(40).map(r => ({ ...r, side: 'SHORT' }))];
    expect(mfePercentileTargets({ rows, side: 'SHORT' }).nWinners).toBe(40);
  });
});

describe('v21.33.0 G2 — evaluateAdaptiveTargets (GEOMETRY INVARIANT)', () => {
  const planLong = { side: 'LONG', entry: 100, stopLoss: 98, t1: 102, t2: 104 };
  const planShort = { side: 'SHORT', entry: 100, stopLoss: 102, t1: 98, t2: 96 };
  const rows = winners(60);

  it('LONG: suggested t1/t2 entry ke UPAR, t2 > t1 (TP ladder ascending)', () => {
    const a = evaluateAdaptiveTargets({ plan: planLong, rows, side: 'LONG', mode: 'shadow' });
    expect(a.available).toBe(true);
    expect(a.suggested.t1).toBeGreaterThan(100);
    expect(a.suggested.t2).toBeGreaterThan(a.suggested.t1);
    expect(a.applied).toBe(false); // shadow kabhi apply nahi karta
    expect(a.wouldApply).toBe(true);
  });
  it('SHORT: suggested t1/t2 entry ke NEECHE, t2 < t1 (mirror)', () => {
    const a = evaluateAdaptiveTargets({ plan: planShort, rows: winners(60, { side: 'SHORT' }), side: 'SHORT', mode: 'shadow' });
    expect(a.suggested.t1).toBeLessThan(100);
    expect(a.suggested.t2).toBeLessThan(a.suggested.t1);
  });
  it('DIRECTION INVARIANT: LONG me SL entry se upar diya to suggestion REJECT', () => {
    // entry 100, "sl" 101 — invalid LONG geometry (SL must be < entry)
    const a = evaluateAdaptiveTargets({ plan: { side: 'LONG', entry: 100, stopLoss: 101, t1: 102, t2: 104 }, rows, mode: 'enforce' });
    expect(a.available).toBe(true);
    expect(a.applied).toBe(false);
    expect(a.reason).toContain('geometry INVALID');
  });
  it('enforce + valid geometry → appliedLevels replace original', () => {
    const a = evaluateAdaptiveTargets({ plan: planLong, rows, side: 'LONG', mode: 'enforce' });
    expect(a.applied).toBe(true);
    expect(a.appliedLevels.t1).toBeCloseTo(a.suggested.t1, 6);
    expect(a.appliedLevels.t2).toBeCloseTo(a.suggested.t2, 6);
  });
  it('insufficient winners → suggestion null, original untouched', () => {
    const a = evaluateAdaptiveTargets({ plan: planLong, rows: winners(5), mode: 'shadow' });
    expect(a.available).toBe(false);
    expect(a.suggested).toBeNull();
    expect(a.reason).toContain('insufficient');
  });
  it('zero risk distance → unavailable', () => {
    const a = evaluateAdaptiveTargets({ plan: { side: 'LONG', entry: 100, stopLoss: 100 }, rows });
    expect(a.available).toBe(false);
    expect(a.reason).toContain('zero risk');
  });
});

describe('v21.33.0 G6 — volTargetMultiplier', () => {
  it('high realized vol → multiplier clamp floor 0.5 (size shrink)', () => {
    const m = volTargetMultiplier({ realizedVolPct: 4, targetVolPct: 1 });
    expect(m.available).toBe(true);
    expect(m.multiplier).toBe(0.5); // raw 0.25 → clamp [0.5, 1.0]
    expect(m.clamped).toBe(true);
  });
  it('low realized vol → CAPPED at 1.0 (size kabhi badhata nahi)', () => {
    const m = volTargetMultiplier({ realizedVolPct: 0.25, targetVolPct: 1 });
    expect(m.multiplier).toBe(1.0);
    expect(m.clamped).toBe(true);
    expect(m.reason).toContain('capped');
  });
  it('missing vols → neutral 1 + honest reason', () => {
    const m = volTargetMultiplier({});
    expect(m.available).toBe(false);
    expect(m.multiplier).toBe(1);
  });
});

describe('v21.33.0 G6 — kellyResearchFraction (research-only refusals)', () => {
  it('healthy inputs → quarter-Kelly within risk cap', () => {
    const k = kellyResearchFraction({ pWin: 0.6, avgWinR: 2, avgLossR: 1, ece: 0.03, n: 200, riskCapPct: 1 });
    expect(k.available).toBe(true);
    // f* = 0.6 - 0.4/2 = 0.4 → 0.25*f* = 0.10 → 10% >> cap 1% → capped at 1
    expect(k.fractionPct).toBe(1);
  });
  it('ECE > 5pt → refuse', () => {
    const k = kellyResearchFraction({ pWin: 0.6, avgWinR: 2, avgLossR: 1, ece: 0.08, n: 200 });
    expect(k.available).toBe(false);
    expect(k.reason).toContain('ECE');
  });
  it('n < 150 → refuse', () => {
    const k = kellyResearchFraction({ pWin: 0.6, avgWinR: 2, avgLossR: 1, ece: 0.02, n: 100 });
    expect(k.available).toBe(false);
    expect(k.reason).toContain('n=');
  });
  it('edge ≤ 0 → fraction 0 (negative-edge refusal)', () => {
    const k = kellyResearchFraction({ pWin: 0.3, avgWinR: 1, avgLossR: 1, ece: 0.02, n: 200 });
    expect(k.available).toBe(true);
    expect(k.fractionPct).toBe(0);
    expect(k.reason).toContain('negative-edge');
  });
  // v21.35.0 [A16b]: ece/n UNKNOWN → refuse. Pehle missing values
  // chhoot jaati thi (ece!=null && ece>0.05 pattern) — uncalibrated Kelly
  // fraction confidently compute ho jaata tha.
  it('v21.35.0 [A16b]: ece ya n unknown → uncalibrated Kelly refuse', () => {
    const noEce = kellyResearchFraction({ pWin: 0.6, avgWinR: 2, avgLossR: 1, ece: null, n: 200 });
    expect(noEce.available).toBe(false);
    expect(noEce.fractionPct).toBe(0);
    expect(noEce.reason).toContain('uncalibrated');
    const noN = kellyResearchFraction({ pWin: 0.6, avgWinR: 2, avgLossR: 1, ece: 0.02, n: null });
    expect(noN.available).toBe(false);
    expect(noN.reason).toContain('ece/n unknown');
    // dono missing → wahi refuse
    const noBoth = kellyResearchFraction({ pWin: 0.6, avgWinR: 2, avgLossR: 1 });
    expect(noBoth.available).toBe(false);
    expect(noBoth.reason).toContain('uncalibrated');
    // healthy inputs ab bhi compute hote hain (regression guard)
    const ok = kellyResearchFraction({ pWin: 0.6, avgWinR: 2, avgLossR: 1, ece: 0.03, n: 200 });
    expect(ok.available).toBe(true);
  });
});
