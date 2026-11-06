// ============================================================
// test/v21320Features.test.ts — v21.32.0 PHASE C TESTS
// ------------------------------------------------------------
//   • F1 Kaufman Efficiency Ratio (closed bars, no-lookahead)
//   • C2 G5 CLOSE: squeeze / bbWidthPct / er ab readContext me supply
//     hote hain (closed context bars par — non-repainting rule C1)
//   • classifyRowRegime ko squeeze seedha milta hai (SQUEEZE label)
// ============================================================
import { describe, it, expect } from 'vitest';
import { efficiencyRatio, bollinger, ttmSqueeze } from '../server/ai/lib/indicators.js';
import { readContext } from '../server/ai/tradePlanner.js';
import { classifyRowRegime } from '../server/ai/mtfRegime.js';

const T0 = 1_700_000_000_000;

function candles({ n, start = 1000, driftPct = 0, tfMin = 15, vol = 1000, alternate = false }) {
  const out = [];
  let p = start;
  let seed = 42;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let i = 0; i < n; i++) {
    const drift = p * (driftPct / 100) / n;
    const noise = alternate ? (i % 2 === 0 ? p * 0.002 : -p * 0.002) : p * 0.0003 * (rnd() - 0.5) * 2;
    const o = p;
    const c = p + (alternate ? 0 : drift * 2) + noise;
    const h = Math.max(o, c) + p * 0.0007;
    const l = Math.min(o, c) - p * 0.0007;
    out.push({ time: T0 + i * tfMin * 60_000, open: o, high: h, low: l, close: c, volume: vol });
    p = c;
  }
  return out;
}

describe('v21.32.0 F1 — Kaufman Efficiency Ratio', () => {
  it('straight-line series → ER ~ 1 (pure trend efficiency)', () => {
    const closes = Array.from({ length: 40 }, (_, i) => 100 + i); // har bar +1
    expect(efficiencyRatio(closes, 20)).toBeCloseTo(1, 9);
  });

  it('alternating series → ER ~ 0 (chop/noise)', () => {
    const closes = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 100 : 101));
    expect(efficiencyRatio(closes, 20)).toBeCloseTo(0, 9);
  });

  it('insufficient data → null (fabricated 0 nahi)', () => {
    expect(efficiencyRatio([1, 2, 3], 20)).toBeNull();
    expect(efficiencyRatio([], 20)).toBeNull();
  });

  it('NO-LOOKAHEAD (prefix invariance): past bars prepend karne se ER unchanged', () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 5) * 2 + i * 0.1);
    const window = closes.slice(0, 40);
    const atT = efficiencyRatio(window, 20);
    // purana (prefix) data add karna ER(t) ko change NAHI karta — ER sirf
    // apni 21-bar tail window dekhta hai, future/prefix se independent.
    const withPrefix = efficiencyRatio([...Array(30).fill(50), ...window], 20);
    expect(withPrefix).toBeCloseTo(atT!, 12);
    // aur tail window ke bahar ke purane bars change karne se bhi nahi
    const mutatedPrefix = [...window.slice(0, 10).map((v) => v * 0.5), ...window.slice(10)];
    expect(efficiencyRatio(mutatedPrefix, 20)).toBeCloseTo(atT!, 12);
  });
});

describe('v21.32.0 C2 (G5) — squeeze/BB-width/ER readContext supply', () => {
  it('readContext ab squeeze, squeezeFired, bbWidthPct, er deta hai (closed bars)', () => {
    const ctx = readContext(candles({ n: 120, start: 1000, driftPct: 12, tfMin: 15 }));
    expect(ctx).not.toBeNull();
    expect(ctx!.bbWidthPct).not.toBeNull();
    expect(ctx!.bbWidthPct!).toBeGreaterThan(0);
    expect(ctx!.er).not.toBeNull();
    expect(ctx!.er!).toBeGreaterThan(0.15); // trending fixture → meaningful ER
    expect(['boolean', 'nullish']).toContain(ctx!.squeeze === null ? 'nullish' : typeof ctx!.squeeze);
    expect(ctx!.squeeze).not.toBeNull();
  });

  it('bbWidthPct bollinger() se consistent hai (same closed series)', () => {
    const bars = candles({ n: 120, start: 1000, driftPct: 0, tfMin: 15 });
    const ctx = readContext(bars);
    const closed = bars.slice(0, -1); // readContext closed bars use karta hai
    const bb = bollinger(closed.map((c: any) => c.close), 20, 2);
    expect(ctx!.bbWidthPct).toBeCloseTo(Math.round(bb!.widthPct * 100) / 100, 6);
  });

  it('compressed series me squeeze=true / trending me typically false', () => {
    // tight compression: tiny alternating noise, no drift
    const flat = candles({ n: 120, start: 1000, driftPct: 0, tfMin: 15, alternate: true });
    const ctxFlat = readContext(flat);
    const sq = ttmSqueeze(flat.slice(0, -1), { period: 20 });
    expect(ctxFlat!.squeeze).toBe(sq!.squeezeOn);
    // trending series me squeeze hona uncommon hai — sirf consistency lock
    const trend = candles({ n: 120, start: 1000, driftPct: 20, tfMin: 15 });
    const ctxTrend = readContext(trend);
    const sqT = ttmSqueeze(trend.slice(0, -1), { period: 20 });
    expect(ctxTrend!.squeeze).toBe(sqT!.squeezeOn);
  });

  it('classifyRowRegime squeeze=true ko SQUEEZE label deta hai (explicit flag wins)', () => {
    const regime = classifyRowRegime({
      context: { dir: 1, adx: 22, atrPct: 1.2, squeeze: true },
    });
    expect(regime).toBe('SQUEEZE');
    // squeeze nahi → same inputs TREND_UP
    const regime2 = classifyRowRegime({
      context: { dir: 1, adx: 22, atrPct: 1.2, squeeze: false },
    });
    expect(regime2).toBe('TREND_UP');
  });
});
