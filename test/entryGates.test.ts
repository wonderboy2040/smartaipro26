// ============================================================
// test/entryGates.test.ts — v21.35.4/21.35.5 PRE-TRADE ENTRY GATES
// ------------------------------------------------------------
// Deterministic regression for server/ai/entryGates.js:
//   • Monte-Carlo odds gate: seed determinism, SHORT mirror math,
//     <40-bars fail-open, enforce-block semantics, fee-aware EV sign
//   • Breakout-confirm gate: wick-immune last-closed-bar check,
//     adverse bar block, stale-bar block, fail-open, off mode
//   • Late-wave gate (v21.35.5): trend-end exhaustion block —
//     late wave-progress, reward-consumed, SHORT mirror, fail-open
// ============================================================
import { describe, it, expect } from 'vitest';
import {
  evaluateMonteCarloOddsGate,
  evaluateBreakoutConfirmGate,
  evaluateLateWaveGate,
} from '../server/ai/entryGates.js';

/** n closed 1m bars, close_i = start * (1 + perPct)^i, timestamps ending at `endMs`. */
function series(n: number, start: number, perPct: number, endMs = Date.parse('2026-02-01T00:00:00Z')) {
  const out: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }> = [];
  for (let i = 0; i < n; i++) {
    const close = start * Math.pow(1 + perPct, i);
    out.push({ time: endMs - (n - i) * 60_000, open: close, high: close * 1.001, low: close * 0.999, close, volume: 10 });
  }
  return out;
}

const NOW = Date.parse('2026-02-01T00:00:00Z');

describe('Monte-Carlo odds gate', () => {
  const longRow = {
    side: 'LONG',
    execMarket: 'FUTURES',
    plan: { entry: 100, stopLoss: 97, t1: 103, t2: 106 },
  };
  const shortRow = {
    side: 'SHORT',
    execMarket: 'FUTURES',
    plan: { entry: 100, stopLoss: 103, t1: 97, t2: 94 },
  };
  const falling = series(80, 100, -0.0015, NOW); // downtrend market

  it('seed determinism: identical inputs + seed → identical verdicts', () => {
    const a = evaluateMonteCarloOddsGate({ row: longRow, candles: falling, mode: 'shadow', seed: 7 });
    const b = evaluateMonteCarloOddsGate({ row: longRow, candles: falling, mode: 'shadow', seed: 7 });
    expect(a).toEqual(b);
    expect(a.available).toBe(true);
  });

  it('different seeds can give different pStop (stochastic)', () => {
    const a = evaluateMonteCarloOddsGate({ row: longRow, candles: falling, mode: 'shadow', seed: 7 });
    const b = evaluateMonteCarloOddsGate({ row: longRow, candles: falling, mode: 'shadow', seed: 99 });
    expect([a, b].every(r => r.available)).toBe(true);
    // Same geometry, different resampling path — allow identical but expect sane ranges.
    expect(a.pStop).toBeGreaterThan(0);
    expect(b.pStop).toBeGreaterThan(0);
  });

  it('LONG into a falling tape: fee-aware EV negative → wouldBlock', () => {
    const r = evaluateMonteCarloOddsGate({ row: longRow, candles: falling, mode: 'shadow' });
    expect(r.available).toBe(true);
    expect(r.evRealisticR).toBeLessThan(0);
    expect(r.pStop).toBeGreaterThan(r.pTarget);
    expect(r.wouldBlock).toBe(true);
    expect(r.blocked).toBe(false); // shadow observes, never blocks
  });

  it('SHORT mirror: same falling tape is favourable → odds pass', () => {
    const r = evaluateMonteCarloOddsGate({ row: shortRow, candles: falling, mode: 'shadow' });
    expect(r.available).toBe(true);
    expect(r.evRealisticR).toBeGreaterThan(0);
    expect(r.pTarget).toBeGreaterThan(0);
    expect(r.wouldBlock).toBe(false);
  });

  it('rising tape flips the mirror (LONG passes, SHORT blocks)', () => {
    const rising = series(80, 100, 0.0015, NOW);
    const long = evaluateMonteCarloOddsGate({ row: longRow, candles: rising, mode: 'shadow' });
    const short = evaluateMonteCarloOddsGate({ row: shortRow, candles: rising, mode: 'shadow' });
    expect(long.wouldBlock).toBe(false);
    expect(short.wouldBlock).toBe(true);
  });

  it('<40 usable bars → fail-open (available=false, never blocks)', () => {
    const r = evaluateMonteCarloOddsGate({ row: longRow, candles: series(20, 100, -0.001, NOW), mode: 'enforce' });
    expect(r.available).toBe(false);
    expect(r.wouldBlock).toBe(false);
    expect(r.blocked).toBe(false);
    expect(String(r.reason || '').startsWith('insufficient_candles')).toBe(true);
  });

  it('enforce mode actually blocks; shadow does not', () => {
    const shadow = evaluateMonteCarloOddsGate({ row: longRow, candles: falling, mode: 'shadow' });
    const enforce = evaluateMonteCarloOddsGate({ row: longRow, candles: falling, mode: 'enforce' });
    expect(shadow.wouldBlock).toBe(true);
    expect(shadow.blocked).toBe(false);
    expect(enforce.wouldBlock).toBe(true);
    expect(enforce.blocked).toBe(true);
  });

  it('off mode: instant gate_off, no computation', () => {
    const r = evaluateMonteCarloOddsGate({ row: longRow, candles: falling, mode: 'off' });
    expect(r.reason).toBe('gate_off');
    expect(r.scenarios).toBe(0);
    expect(r.available).toBe(false);
  });

  it('incomplete ticket fails open', () => {
    const r = evaluateMonteCarloOddsGate({ row: { side: 'LONG', plan: { entry: 0, stopLoss: 97, t1: 103, t2: 106 } }, candles: falling, mode: 'enforce' });
    expect(r.available).toBe(false);
    expect(r.blocked).toBe(false);
    expect(r.reason).toBe('incomplete_ticket');
  });
});

describe('Breakout-confirm gate (last-closed-bar, wick-immune)', () => {
  const longRow = { side: 'LONG', execMarket: 'FUTURES', plan: { entry: 100 } };

  it('last closed bar closes above entry (LONG) → confirmed, fresh → pass', () => {
    // closes: ... , 98, 101 (last CLOSED bar on the trade side of entry)
    const candles = [
      { time: NOW - 120_000, close: 98 },
      { time: NOW - 60_000, close: 101 },
    ];
    const r = evaluateBreakoutConfirmGate({ row: longRow, candles, mode: 'shadow', freshMin: 60, now: NOW });
    expect(r.available).toBe(true);
    expect(r.lastCloseConfirmed).toBe(true);
    expect(r.wouldBlock).toBe(false);
    expect(r.reason).toBe('confirmed');
  });

  it('last closed bar closes ADVERSE to the trade → wouldBlock (fake-out signature)', () => {
    const candles = [
      { time: NOW - 120_000, close: 101 },
      { time: NOW - 60_000, close: 99 }, // LONG but bar closed below entry
    ];
    const r = evaluateBreakoutConfirmGate({ row: longRow, candles, mode: 'shadow', freshMin: 60, now: NOW });
    expect(r.lastCloseConfirmed).toBe(false);
    expect(r.wouldBlock).toBe(true);
    expect(r.blocked).toBe(false);
    expect(r.reason).toBe('last-closed-bar-against-trade');
  });

  it('stale confirming bar (ts > freshMin old) → wouldBlock confirm-bar-stale', () => {
    const candles = [
      { time: NOW - 2 * 60 * 60_000, close: 98 },
      { time: NOW - 65 * 60_000, close: 101 }, // favourable but 65m old (gate: strictly > 60)
    ];
    const r = evaluateBreakoutConfirmGate({ row: longRow, candles, mode: 'shadow', freshMin: 60, now: NOW });
    expect(r.lastCloseConfirmed).toBe(true);
    expect(r.wouldBlock).toBe(true);
    expect(r.reason).toBe('confirm-bar-stale');
    expect(r.barAgeMin).toBe(65);
  });

  it('wick above entry but close below → still blocks (wick-immune)', () => {
    const candles = [
      { time: NOW - 120_000, close: 98 },
      { time: NOW - 60_000, open: 99.5, high: 105, low: 99, close: 99 }, // spike wick, close adverse
    ];
    const r = evaluateBreakoutConfirmGate({ row: longRow, candles, mode: 'shadow', now: NOW });
    expect(r.lastClose).toBe(99);
    expect(r.wouldBlock).toBe(true);
  });

  it('SHORT mirror: last close below entry confirms', () => {
    const candles = [
      { time: NOW - 120_000, close: 102 },
      { time: NOW - 60_000, close: 99 },
    ];
    const r = evaluateBreakoutConfirmGate({ row: { ...longRow, side: 'SHORT' }, candles, mode: 'shadow', now: NOW });
    expect(r.lastCloseConfirmed).toBe(true);
    expect(r.wouldBlock).toBe(false);
  });

  it('<2 usable bars → fail-open (available=false, never blocks)', () => {
    const r = evaluateBreakoutConfirmGate({ row: longRow, candles: [{ time: NOW, close: 101 }], mode: 'enforce' });
    expect(r.available).toBe(false);
    expect(r.blocked).toBe(false);
    expect(r.reason).toBe('insufficient_candles');
  });

  it('off mode → instant gate_off', () => {
    const r = evaluateBreakoutConfirmGate({ row: longRow, candles: [], mode: 'off' });
    expect(r.reason).toBe('gate_off');
  });
});

describe('Late-wave / exhaustion gate (v21.35.5)', () => {
  /** 20 rising closed bars: close 100 → 107.6, LAST bar marks the wave high 108.2. */
  function upWave(n = 20, start = 100, step = 0.4, endMs = NOW) {
    const out: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }> = [];
    for (let i = 0; i < n; i++) {
      const close = +(start + i * step).toFixed(2);
      out.push({ time: endMs - (n - i) * 60_000, open: close - step, high: close + 0.2, low: close - 0.2, close, volume: 10 });
    }
    out[out.length - 1].high = 108.2; // wave top on the most recent closed bar
    return out;
  }
  const upBars = upWave();
  // LONG entry 108 (near the top), SL 105 (risk 3), T1 111, T2 114.
  const longLateRow = {
    side: 'LONG',
    execMarket: 'FUTURES',
    plan: { entry: 108, stopLoss: 105, t1: 111, t2: 114 },
  };
  const shortLateRow = {
    side: 'SHORT',
    execMarket: 'FUTURES',
    plan: { entry: 108, stopLoss: 111, t1: 103, t2: 100 },
  };

  it('LONG at a consumed wave top (live near wave high) → wouldBlock', () => {
    const r = evaluateLateWaveGate({ row: longLateRow, candles: upBars, livePrice: 108.0, mode: 'shadow' });
    expect(r.available).toBe(true);
    // waveLow 99.8 → waveHigh 108.2 (span 8.4); live 108 = 97.6% consumed.
    expect(r.waveProgressPct).toBeGreaterThan(85);
    expect(r.wouldBlock).toBe(true);
    expect(r.blocked).toBe(false); // shadow observes, never blocks
  });

  it('same setup in enforce mode → actually blocks', () => {
    const r = evaluateLateWaveGate({ row: longLateRow, candles: upBars, livePrice: 108.0, mode: 'enforce' });
    expect(r.wouldBlock).toBe(true);
    expect(r.blocked).toBe(true);
    expect(String(r.reason)).toMatch(/late-entry|consumed/);
  });

  it('SHORT right at the top has near-zero downward progress; big reward to T1 → does not block', () => {
    const r = evaluateLateWaveGate({ row: shortLateRow, candles: upBars, livePrice: 108.0, mode: 'shadow' });
    expect(r.available).toBe(true);
    expect(r.waveProgressPct).toBeLessThan(5); // 108 is just 0.2 below the 108.2 top
    // Reward to T1 (103) from live 108 vs live risk 3 = 1.67R ≥ 0.5 → open reward.
    expect(r.wouldBlock).toBe(false);
  });

  it('reward-consumed: live price already left < minT1RemainR to T1, wave past midpoint → block', () => {
    const row = {
      side: 'LONG',
      execMarket: 'FUTURES',
      plan: { entry: 108, stopLoss: 107, t1: 108.15, t2: 108.4 }, // T1 only 0.15 above live
    };
    const r = evaluateLateWaveGate({ row, candles: upBars, livePrice: 108, mode: 'shadow' });
    expect(r.t1RemainR).toBeCloseTo(0.15, 2);
    expect(r.wouldBlock).toBe(true);
    expect(String(r.reason)).toMatch(/reward-consumed/);
  });

  it('open wave (live well below the top) → does not block', () => {
    const r = evaluateLateWaveGate({ row: longLateRow, candles: upBars, livePrice: 106.5, mode: 'shadow' });
    expect(r.available).toBe(true);
    expect(r.waveProgressPct).toBeCloseTo(79.8, 0); // (106.5 − 99.8) / 8.4
    expect(r.wouldBlock).toBe(false);
  });

  it('flat/chop tape → never blocks (fail-open), enforce included', () => {
    const flat = Array.from({ length: 20 }, (_, i) => ({
      time: NOW - i * 60_000, open: 100, high: 100.3, low: 99.7, close: 100, volume: 10,
    }));
    // No late-wave signature: 50% progress, 2.2R reward to T1 → enforce must
    // NOT block a genuine two-sided tape.
    const r = evaluateLateWaveGate({ row: longLateRow, candles: flat, livePrice: 100, mode: 'enforce' });
    expect(r.wouldBlock).toBe(false);
    expect(r.blocked).toBe(false);
    // And a truly flat (no-range) tape is an explicit fail-open, never a block.
    const dead = Array.from({ length: 20 }, (_, i) => ({
      time: NOW - i * 60_000, open: 100, high: 100, low: 100, close: 100, volume: 0,
    }));
    const r2 = evaluateLateWaveGate({ row: longLateRow, candles: dead, livePrice: 100, mode: 'enforce' });
    expect(r2.wouldBlock).toBe(false);
    expect(r2.blocked).toBe(false);
  });

  it('missing candles → fail-open', () => {
    const r = evaluateLateWaveGate({ row: longLateRow, candles: [], livePrice: 108, mode: 'enforce' });
    expect(r.available).toBe(false);
    expect(r.blocked).toBe(false);
    expect(r.reason).toBe('insufficient_candles');
  });

  it('off mode → instant gate_off', () => {
    const r = evaluateLateWaveGate({ row: longLateRow, candles: upBars, livePrice: 108, mode: 'off' });
    expect(r.reason).toBe('gate_off');
  });
});
