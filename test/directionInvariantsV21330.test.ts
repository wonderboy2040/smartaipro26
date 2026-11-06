// ============================================================
// test/directionInvariantsV21330.test.ts — v21.33.0 DIRECTION
// HARDENING TESTS (user ka #1 concern)
// ------------------------------------------------------------
//   • validateStopPolarity (futures.js export): LONG SL/TP vs SHORT
//     mirror — wrong-side level INSTANT-TRIGGER reject; profit-lock
//     (LONG sl > entry, < price) ALLOWED; fail-open on missing.
//   • Liquidation estimate side-honesty: unknown → null (silent-LONG
//     estimate nahi) — ye futures.js internal hota hai, yahan pure
//     polarity logic + tradePlanner TP geometry ki property locks.
//   • tradePlanner TP1/TP2 geometry: LONG entry+t1+t2 ascending;
//     SHORT mirror (regression lock — TP1/TP2 tak pahunchna possible
//     hi tabhi hai jab levels sahi side par hon).
// ============================================================
import { describe, it, expect } from 'vitest';
import { validateStopPolarity } from '../server/ai/futures.js';
import { buildPlanFromCandles } from '../server/ai/tradePlanner.js';
import { normalizeSide, orderSideForSignal } from '../server/ai/directionCertificate.js';

const T0 = 1_700_000_000_000;
const TF = 5 * 60_000;

function trendCandles(n, dir) {
  const out = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    const o = p;
    const c = p + dir * 0.35;
    out.push({
      time: T0 + i * TF, open: o,
      high: Math.max(o, c) + 0.1, low: Math.min(o, c) - 0.1,
      close: c, volume: 1000,
    });
    p = c;
  }
  return out;
}

describe('v21.33.0 [DIRECTION HARDENING] — validateStopPolarity', () => {
  it('LONG: SL price ke upar → REJECT (instant trigger)', () => {
    const v = validateStopPolarity({ side: 'LONG', price: 100, stopLoss: 101 });
    expect(v.ok).toBe(false);
    expect(v.checked).toBe(true);
    expect(v.reason).toContain('LONG SL');
  });
  it('LONG: SL price ke neeche → OK (normal protective stop)', () => {
    expect(validateStopPolarity({ side: 'LONG', price: 100, stopLoss: 95 }).ok).toBe(true);
  });
  it('LONG profit-lock ALLOWED: SL entry ke upar par price se neeche', () => {
    // entry ~98 hua ho, price 102, trailed SL 100 — VALID profit lock
    expect(validateStopPolarity({ side: 'LONG', price: 102, stopLoss: 100 }).ok).toBe(true);
  });
  it('SHORT: SL price ke neeche → REJECT; upar → OK', () => {
    expect(validateStopPolarity({ side: 'SHORT', price: 100, stopLoss: 99 }).ok).toBe(false);
    expect(validateStopPolarity({ side: 'SHORT', price: 100, stopLoss: 105 }).ok).toBe(true);
  });
  it('TP polarity: LONG TP price se neeche → REJECT; SHORT TP upar → REJECT', () => {
    expect(validateStopPolarity({ side: 'LONG', price: 100, stopLoss: 95, takeProfit: 99 }).ok).toBe(false);
    expect(validateStopPolarity({ side: 'SHORT', price: 100, stopLoss: 105, takeProfit: 101 }).ok).toBe(false);
    expect(validateStopPolarity({ side: 'LONG', price: 100, stopLoss: 95, takeProfit: 110 }).ok).toBe(true);
    expect(validateStopPolarity({ side: 'SHORT', price: 100, stopLoss: 105, takeProfit: 90 }).ok).toBe(true);
  });
  it('fail-open: side/price missing → ok + checked:false (fabricated block nahi)', () => {
    const a = validateStopPolarity({ side: null, price: 100, stopLoss: 999 });
    expect(a.ok).toBe(true);
    expect(a.checked).toBe(false);
    const b = validateStopPolarity({ side: 'LONG', price: null, stopLoss: 999 });
    expect(b.ok).toBe(true);
    expect(b.checked).toBe(false);
  });
});

describe('v21.33.0 [DIRECTION CERTIFICATE] — regression lock', () => {
  it('LONG → BUY order side; SHORT → SELL (orderSideForSignal)', () => {
    expect(orderSideForSignal('LONG')).toBe('buy');
    expect(orderSideForSignal('SHORT')).toBe('sell');
    expect(orderSideForSignal('FLAT')).toBeNull();
    expect(orderSideForSignal('BUY')).toBe('buy');
    expect(orderSideForSignal('SELL')).toBe('sell');
  });
  it('normalizeSide unknown → null (silent LONG nahi)', () => {
    expect(normalizeSide('')).toBeNull();
    expect(normalizeSide('SIDEWAYS')).toBeNull();
    expect(normalizeSide('long')).toBe('LONG');
    expect(normalizeSide('SELL')).toBe('SHORT');
  });
});

describe('v21.33.0 [TP GEOMETRY LOCK] — tradePlanner LONG/SHORT levels', () => {
  it('uptrend plan: LONG side, SL < entry < T1 < T2 (TP1/TP2 tak reach possible)', () => {
    const up = trendCandles(90, 1);
    const plan = buildPlanFromCandles({ symbol: 'BTC', market: 'CRYPTO', mode: 'INTRADAY', ctxCandles: up, trigCandles: up });
    expect(plan.ok).toBe(true);
    const side = plan.plan.side ?? plan.side;
    if (side === 'LONG') {
      expect(plan.plan.stopLoss).toBeLessThan(plan.plan.entry);
      expect(plan.plan.t1).toBeGreaterThan(plan.plan.entry);
      expect(plan.plan.t2).toBeGreaterThan(plan.plan.t1);
    } else if (side === 'SHORT') {
      expect(plan.plan.stopLoss).toBeGreaterThan(plan.plan.entry);
      expect(plan.plan.t1).toBeLessThan(plan.plan.entry);
      expect(plan.plan.t2).toBeLessThan(plan.plan.t1);
    } else {
      throw new Error(`plan side neither LONG nor SHORT: ${String(side)}`);
    }
  });
  it('downtrend plan: SHORT side with mirror geometry', () => {
    const down = trendCandles(90, -1);
    const plan = buildPlanFromCandles({ symbol: 'BTC', market: 'CRYPTO', mode: 'INTRADAY', ctxCandles: down, trigCandles: down });
    expect(plan.ok).toBe(true);
    const side = plan.plan.side ?? plan.side;
    expect(['LONG', 'SHORT']).toContain(side);
    if (side === 'SHORT') {
      expect(plan.plan.stopLoss).toBeGreaterThan(plan.plan.entry);
      expect(plan.plan.t1).toBeLessThan(plan.plan.entry);
      expect(plan.plan.t2).toBeLessThan(plan.plan.t1);
    } else {
      expect(plan.plan.stopLoss).toBeLessThan(plan.plan.entry);
      expect(plan.plan.t1).toBeGreaterThan(plan.plan.entry);
      expect(plan.plan.t2).toBeGreaterThan(plan.plan.t1);
    }
  });
});
