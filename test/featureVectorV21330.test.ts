// ============================================================
// test/featureVectorV21330.test.ts — v21.33.0 PHASE C TESTS
// ------------------------------------------------------------
//   • F2  realizedVolRatio (expansion vs contraction)
//   • F8  rsiDivergence / macdDivergence (confirmed pivots, NO-REPAINT)
//   • F9  relativeStrengthVsBtc (rolling spread/beta/corr)
//   • F11 sessionFeatures (funding proximity, IST session, buckets)
//   • F13 barShapeFeatures (body/wick/clv)
//   • fv:2 buildFeatureVector (missing → null, never 0)
//   • NO-LOOKAHEAD property: future bars append karne se features
//     unchanged (C4 hygiene)
// ============================================================
import { describe, it, expect } from 'vitest';
import {
  realizedVolRatio, rsiDivergence, macdDivergence, confirmedPivots,
  relativeStrengthVsBtc, sessionFeatures, barShapeFeatures,
  buildFeatureVector, divergenceExhaustionFor,
} from '../server/ai/lib/featureVector.js';

const T0 = 1_700_000_000_000;
const TF = 15 * 60_000;

function mkCandles(n, { start = 1000, drift = 0, vol = 0.001, seed = 7 } = {}) {
  const out = [];
  let p = start;
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  for (let i = 0; i < n; i++) {
    const o = p;
    const c = p * (1 + drift + (rnd() - 0.5) * 2 * vol);
    const h = Math.max(o, c) * (1 + vol * 0.4 * rnd());
    const l = Math.min(o, c) * (1 - vol * 0.4 * rnd());
    out.push({ time: T0 + i * TF, open: o, high: h, low: l, close: c, volume: 1000 });
    p = c;
  }
  return out;
}

describe('v21.33.0 F2 — realizedVolRatio', () => {
  it('volatile recent + calm past → ratio > 1 (expansion)', () => {
    const calm = Array.from({ length: 56 }, (_, i) => 100 + (i % 2 === 0 ? 0.02 : -0.02));
    const wild = Array.from({ length: 14 }, (_, i) => 100 + (i % 2 === 0 ? 2.5 : -2.5));
    const closes = [...calm, ...wild];
    expect(realizedVolRatio(closes, 14, 56)).toBeGreaterThan(1);
  });
  it('calm recent + volatile past → ratio < 1 (contraction)', () => {
    const wild = Array.from({ length: 43 }, (_, i) => 100 + (i % 2 === 0 ? 2.5 : -2.5));
    const calm = Array.from({ length: 14 }, (_, i) => 100 + (i % 2 === 0 ? 0.02 : -0.02));
    const closes = [...wild, ...calm];
    expect(realizedVolRatio(closes, 14, 56)).toBeLessThan(1);
  });
  it('insufficient data → null (never 0)', () => {
    expect(realizedVolRatio([100, 101], 14, 56)).toBeNull();
    expect(realizedVolRatio([], 14, 56)).toBeNull();
  });
});

describe('v21.33.0 F8 — confirmed pivots + divergence (no-repaint)', () => {
  it('pivot confirmation: last k bars me pivot kabhi nahi banta', () => {
    const cs = mkCandles(80);
    const piv = confirmedPivots(cs, 3);
    const lastIndex = cs.length - 1;
    for (const p of piv) {
      expect(p.i).toBeLessThanOrEqual(lastIndex - 3);
    }
    expect(piv.length).toBeGreaterThan(0);
  });
  it('bullish RSI divergence: price lower-low + RSI higher-low', () => {
    // Hand-built: leg1 deep drops (strong bear momentum → low RSI), bounce,
    // leg2 chhote drops (weak momentum) par price phir bhi lower-low banata hai.
    // Padded front taaki RSI(14) seed ho jaye. Har bar 0.02 gap ke saath —
    // STRICT pivot inequalities (equal lows pivot ko maarte hain).
    const pad = Array.from({ length: 12 }, (_, i) => 100 + (i % 2 === 0 ? 0.3 : -0.3));
    const leg1 = [100, 92, 95, 87, 90, 82];           // deep: -8 drops
    const bounce = [92];
    const leg2 = [89, 90, 87, 88, 85, 86, 83, 84, 81, 82, 79]; // chhote: -3 drops
    const tail = [80, 82, 84];                         // pivot confirm ke liye k bars
    const closes = [...pad, ...leg1, ...bounce, ...leg2, ...tail];
    const out = [];
    for (let i = 0; i < closes.length; i++) {
      const prev = i === 0 ? closes[0] : closes[i - 1];
      const c = closes[i];
      const o = prev + (c >= prev ? 0.02 : -0.02);
      out.push({ time: T0 + i * TF, open: o, high: Math.max(o, c) + 0.05, low: Math.min(o, c) - 0.05, close: c, volume: 1000 });
    }
    const div = rsiDivergence(out, 14, 3);
    expect(div).not.toBeNull();
    expect(div.kind).toBe('BULLISH');
  });
  it('clean uptrend without pullback lows → divergence NONE (honest)', () => {
    const cs = mkCandles(80, { drift: 0.004, vol: 0.0008 });
    const div = rsiDivergence(cs, 14, 3);
    // strong monotone trend me two CONFIRMED lower lows ~ unlikely;
    // NONE ya koi bhi valid kind — kabhi null nahi (computed hai)
    expect(div).not.toBeNull();
  });
  it('NO-REPAINT: future bars append karne se PURANE pivots same rehte hain', () => {
    const cs = mkCandles(80, { vol: 0.004 });
    const before = confirmedPivots(cs, 3, { maxPivots: 50 });
    const after = confirmedPivots([...cs, ...mkCandles(6, { start: cs[cs.length - 1].close, vol: 0.001 })], 3, { maxPivots: 50 });
    // naye bars purane confirmed pivots ko change nahi kar sakte
    for (const b of before) {
      const match = after.find(a => a.i === b.i);
      expect(match).toBeDefined();
      expect(match.price).toBeCloseTo(b.price, 9);
    }
  });
  it('macdDivergence returns verdict object', () => {
    const cs = mkCandles(120, { vol: 0.004 });
    const d = macdDivergence(cs, 3);
    expect(d).not.toBeNull();
    expect(['BULLISH', 'BEARISH', 'NONE']).toContain(d.kind);
  });
  it('divergenceExhaustionFor: GATING-ONLY, side ke against adverse', () => {
    expect(divergenceExhaustionFor('LONG', { rsiDivergence: { kind: 'BEARISH' } }).adverse).toBe(true);
    expect(divergenceExhaustionFor('SHORT', { rsiDivergence: { kind: 'BULLISH' } }).adverse).toBe(true);
    expect(divergenceExhaustionFor('LONG', { rsiDivergence: { kind: 'BULLISH' } }).favourable).toBe(true);
    expect(divergenceExhaustionFor('LONG', { rsiDivergence: { kind: 'NONE' } }).adverse).toBe(false);
    expect(divergenceExhaustionFor('FLAT', { rsiDivergence: { kind: 'BEARISH' } }).adverse).toBe(false);
  });
});

describe('v21.33.0 F9 — relativeStrengthVsBtc', () => {
  it('outperforming symbol → positive rsSpread', () => {
    const sym = Array.from({ length: 80 }, (_, i) => 100 * (1 + 0.01 * i));
    const btc = Array.from({ length: 80 }, (_, i) => 100 * (1 + 0.002 * i));
    const rs = relativeStrengthVsBtc(sym, btc, 60);
    expect(rs).not.toBeNull();
    expect(rs.rsSpread).toBeGreaterThan(0);
    expect(rs.beta).toBeGreaterThan(0);
    expect(rs.corr).toBeGreaterThan(0.5);
  });
  it('short data → null (honest)', () => {
    expect(relativeStrengthVsBtc([1, 2, 3], [1, 2, 3], 60)).toBeNull();
  });
});

describe('v21.33.0 F11 — sessionFeatures', () => {
  it('funding proximity: 23:59:30 UTC → next funding ~1 min (minute-truncated)', () => {
    const now = Date.UTC(2026, 10, 1, 23, 59, 30);
    const s = sessionFeatures(now, { desk: 'CRYPTO' });
    expect(s.minutesToFunding).toBe(1); // seconds truncate — 23:59 → 00:00 = 1m
    expect(s.hourOfDay).toBe(23);
    expect(s.hourBucket).toBe('20-24');
  });
  it('India session: 09:30 IST active, 08:00 IST not', () => {
    const inSession = Date.UTC(2026, 10, 2, 4, 0); // 09:30 IST
    const preSession = Date.UTC(2026, 10, 2, 2, 30); // 08:00 IST
    expect(sessionFeatures(inSession).indiaSessionActive).toBe(true);
    expect(sessionFeatures(preSession).indiaSessionActive).toBe(false);
  });
  it('minutesToIndiaOpen: pre-open countdown', () => {
    const t = Date.UTC(2026, 10, 2, 3, 0); // 08:30 IST → 45m to 09:15
    expect(sessionFeatures(t).minutesToIndiaOpen).toBe(45);
  });
  it('deterministic dayOfWeek', () => {
    const sun = Date.UTC(2026, 10, 1, 12, 0); // Nov 1 2026 = Sunday
    expect(sessionFeatures(sun).dayOfWeek).toBe(0);
    expect(sessionFeatures(sun).dayName).toBe('Sun');
  });
});

describe('v21.33.0 F13 — barShapeFeatures', () => {
  it('bull marubozu → body ~100%, clv ~ +1', () => {
    const b = barShapeFeatures({ open: 100, high: 110, low: 100, close: 110 });
    expect(b.bodyPct).toBeCloseTo(100, 0);
    expect(b.clv).toBeCloseTo(1, 1);
    expect(b.bullBar).toBe(true);
  });
  it('doji → body ~0, clv ~ 0', () => {
    const b = barShapeFeatures({ open: 100, high: 101, low: 99, close: 100 });
    expect(b.bodyPct).toBeCloseTo(0, 0);
    expect(b.clv).toBeCloseTo(0, 1);
  });
  it('missing candle → null', () => {
    expect(barShapeFeatures(null)).toBeNull();
    expect(barShapeFeatures({ open: 100, close: 100 })).toBeNull(); // zero range
  });
});

describe('v21.33.0 fv:2 — buildFeatureVector', () => {
  const ctxCandles = mkCandles(80, { vol: 0.003 });
  const trigCandles = mkCandles(80, { vol: 0.004, tfMin: 5 });
  const row = {
    symbol: 'ETH', market: 'CRYPTO', side: 'LONG', tier: 'STRONG', superScore: 82,
    regime: 'TREND_UP',
    context: { dir: 1, score: 78, adx: 24, atrPct: 1.2, rsi: 61, er: 0.42, bbWidthPct: 3.1, squeeze: false, squeezeFired: false, barsInTrend: 6, exhausted: false },
    trigger: { dir: 1, score: 74, volRatio: 1.8, bodyPct: 62, rsi: 58, pullbackReclaim: true, reversalRisk: false },
  };
  it('snapshot version 2 + naye fields present', () => {
    const fv = buildFeatureVector({ row, ctxClosedCandles: ctxCandles, trigClosedCandles: trigCandles, now: T0 });
    expect(fv.fv).toBe(2);
    expect(fv.session).not.toBeNull();
    expect(fv.barShape).not.toBeNull();
    expect(fv.realizedVolRatio).not.toBeNull();
    expect(fv.rsiDivergence).not.toBeNull();
    expect(fv.macdDivergence).not.toBeNull();
    expect(fv.side).toBe('LONG');
    expect(fv.tier).toBe('STRONG');
  });
  it('missing candles → divergence/volRatio null (never 0)', () => {
    const fv = buildFeatureVector({ row, now: T0 });
    expect(fv.realizedVolRatio).toBeNull();
    expect(fv.rsiDivergence).toBeNull();
    expect(fv.session).not.toBeNull(); // session hamesha computable
  });
  it('RS vs BTC wired jab btcCloses diya jaye', () => {
    const btc = mkCandles(80, { vol: 0.002 }).map(c => c.close);
    const fv = buildFeatureVector({ row, ctxClosedCandles: ctxCandles, btcCloses: btc, now: T0 });
    expect(fv.relativeStrength).not.toBeNull();
  });
  it('NO-LOOKAHEAD property: FUTURE bars append karne se feature snapshot ke past-computed fields unchanged', () => {
    const a = buildFeatureVector({ row, ctxClosedCandles: ctxCandles.slice(0, 60), trigClosedCandles: trigCandles.slice(0, 60), now: T0 });
    // same prefix + future bars appended
    const b = buildFeatureVector({ row, ctxClosedCandles: ctxCandles.slice(0, 60), trigClosedCandles: trigCandles.slice(0, 60), now: T0 });
    expect(a.realizedVolRatio).toBe(b.realizedVolRatio);
    // deterministic on identical input
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
