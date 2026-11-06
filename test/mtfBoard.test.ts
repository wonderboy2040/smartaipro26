// ============================================================
// test/mtfBoard.test.ts — v21.15.0 MTF DUAL-TIMEFRAME SIGNALS BOARD
// Hermetic: no network. Exercises the pure analysis/action reads,
// the confluence gate (ARMED / WAIT / CONFLICT / NO-BIAS), the
// mode configs (15m+5m intraday, 1h+15m swing), the time-boxed
// exit math and the board cache contract via test hooks.
// ============================================================
import { describe, it, expect } from 'vitest';
import {
  MTF_MODES, readAnalysisTf, buildActionPlan, findSwings,
  __clearMtfBoardCaches, getMtfBoard, buildMtfBoardSignal,
} from '../server/ai/mtfBoard.js';
import { __clearMtfCaches } from '../server/ai/mtf.js';

// ---------------- synthetic candle builders ----------------
/** oscillating trend — realistic: fractal pivots bante hain
 *  (perfectly monotonic series me kabhi swing high/low nahi banta). */
const mkTrend = (n: number, start = 100, step = 0.5, minutes = 5, amp = 1.5, phase = 0.6) => {
  const out = [];
  for (let i = 0; i < n; i++) {
    const c = start + step * i + Math.sin(phase * i) * amp;
    out.push({
      time: 1_700_000_000_000 + i * minutes * 60_000,
      open: c - Math.abs(step) / 2, high: c + amp * 0.6, low: c - amp * 0.6, close: c,
      volume: 100 + i,
    });
  }
  return out;
};

/** flat series — dead/zero-range (RSI 50, EMAs equal) */
const mkFlat = (n = 120, minutes = 15, price = 100) => {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ time: 1_700_000_000_000 + i * minutes * 60_000, open: price, high: price + 0.3, low: price - 0.3, close: price, volume: 50 });
  }
  return out;
};

/** pullback shape: climb → flat top (EMA20 catch-up) → dip bar +
 *  bull hold-bar — the classic PULLBACK trigger geometry. */
const mkPullback = (minutes = 5) => {
  const out = mkTrend(80, 100, 0.5, minutes, 1.2, 0.5);
  let t = out[out.length - 1].time;
  const top = out[out.length - 1].close;
  for (let i = 0; i < 50; i++) { // flat top — EMA20 converge
    t += minutes * 60_000;
    out.push({ time: t, open: top, high: top + 0.1, low: top - 0.1, close: top, volume: 120 });
  }
  t += minutes * 60_000; // dip bar
  out.push({ time: t, open: top, high: top + 0.1, low: top - 0.5, close: top - 0.3, volume: 130 });
  t += minutes * 60_000; // bull hold bar
  out.push({ time: t, open: top - 0.3, high: top + 0.4, low: top - 0.35, close: top + 0.05, volume: 150 });
  return out;
};

const INTRADAY = MTF_MODES.intraday;
const SWING = MTF_MODES.swing;

describe('v21.15.0 MTF board — mode configs (user spec)', () => {
  it('intraday = 15m analysis + 5m action + 15–20 min exit window', () => {
    expect(INTRADAY.analysisTf).toBe('15m');
    expect(INTRADAY.actionTf).toBe('5m');
    expect(INTRADAY.holdWindowMin).toEqual([15, 20]);
    expect(INTRADAY.actionTfMin).toBe(5);
  });

  it('swing = 1h analysis + 15m action + 60–90 min exit window', () => {
    expect(SWING.analysisTf).toBe('1h');
    expect(SWING.actionTf).toBe('15m');
    expect(SWING.holdWindowMin).toEqual([60, 90]);
  });
});

describe('v21.15.0 analysis TF read (the bias boss)', () => {
  it('climbing 15m candles → BULLISH bias with strength + HH-HL structure + reasons', () => {
    const a = readAnalysisTf(mkTrend(120, 100, 0.8, 15), 'INDIA');
    expect(a).toBeTruthy();
    expect(a!.bias).toBe('BULLISH');
    expect(a!.strength).toBeGreaterThan(30);
    expect(a!.structure.dir).toBe(1);
    expect(a!.trend.dir).toBe(1);
    expect(a!.reasons.length).toBeGreaterThanOrEqual(3);
    expect(a!.candleReadNote).toBeTruthy();
  });

  it('falling 1h candles → BEARISH bias + LH-LL structure', () => {
    const a = readAnalysisTf(mkTrend(120, 500, -1.0, 60, 2.5, 0.6), 'INDIA');
    expect(a!.bias).toBe('BEARISH');
    expect(a!.structure.dir).toBe(-1);
  });

  it('flat/dead candles → NEUTRAL bias (honest no-bias — equality EMA fix)', () => {
    const a = readAnalysisTf(mkFlat(120), 'INDIA');
    expect(a!.bias).toBe('NEUTRAL');
  });

  it('thin candles (<50) → null (honest degrade)', () => {
    expect(readAnalysisTf(mkTrend(30, 100, 0.5, 15), 'INDIA')).toBeNull();
  });
});

describe('v21.15.0 action TF plan (entry / SL / TP blueprint)', () => {
  it('bull bias + 5m pullback-to-EMA20 → PULLBACK trigger ARMED with entry/SL/TP1/TP2 + 1.5R/2.5R geometry', () => {
    const analysis = readAnalysisTf(mkTrend(120, 100, 0.8, 15), 'INDIA');
    const act = buildActionPlan(mkPullback(5), analysis, 'INDIA', INTRADAY);
    expect(act).toBeTruthy();
    expect(act!.state).toBe('ARMED');
    expect(act!.trigger).toBe('PULLBACK');
    expect(act!.entry).toBeGreaterThan(0);
    expect(act!.stopLoss).toBeLessThan(act!.entry!);
    expect(act!.target1).toBeGreaterThan(act!.entry!);
    expect(act!.target2).toBeGreaterThan(act!.target1!);
    // 1.5R / 2.5R geometry (± px rounding)
    const risk = act!.entry! - act!.stopLoss!;
    expect(act!.target1! - act!.entry!).toBeCloseTo(1.5 * risk, 0);
    expect(act!.target2! - act!.entry!).toBeCloseTo(2.5 * risk, 0);
    expect(act!.rr).toBe(2.5);
    expect(act!.slBasis).toContain('swing-low');
    expect(act!.barsInWindow).toBe(4); // 20 min / 5m
  });

  it('bull bias but 5m falling hard → CONFLICT (LTF kabhi HTF ke against trade nahi karta)', () => {
    const analysis = readAnalysisTf(mkTrend(120, 100, 0.8, 15), 'INDIA');
    const act = buildActionPlan(mkTrend(120, 500, -1.5, 5, 1.5), analysis, 'INDIA', INTRADAY);
    expect(act!.state).toBe('CONFLICT');
    expect(act!.entry).toBeNull(); // conflict par levels NAHI — no-trade zone
  });

  it('bull bias + extended 5m climb (koi trigger nahi) → WAIT with patience note', () => {
    const analysis = readAnalysisTf(mkTrend(120, 100, 0.8, 15), 'INDIA');
    const act = buildActionPlan(mkTrend(120, 100, 0.85, 5, 1.5), analysis, 'INDIA', INTRADAY);
    expect(act!.state).toBe('WAIT');
    expect(act!.triggerNote).toBeTruthy();
    expect(act!.entry).toBeNull();
  });

  it('neutral analysis → NO-BIAS (koi side hi nahi)', () => {
    const analysis = readAnalysisTf(mkFlat(120), 'INDIA');
    const act = buildActionPlan(mkTrend(120, 100, 0.3, 5, 0.8), analysis, 'INDIA', INTRADAY);
    expect(act!.state).toBe('NO-BIAS');
  });

  it('swing mode: 15m action TF → 6 bars expected in the 90-min window', () => {
    const analysis = readAnalysisTf(mkTrend(120, 100, 0.8, 60), 'INDIA');
    const act = buildActionPlan(mkPullback(15), analysis, 'INDIA', SWING);
    expect(act!.state).toBe('ARMED');
    expect(act!.barsInWindow).toBe(6); // 90 min / 15m
  });
});

describe('v21.15.0 confluence gate (alignment se accuracy, count se nahi)', () => {
  it('ARMED vs WAIT vs CONFLICT — states hi score ke drivers hain', () => {
    const analysis = readAnalysisTf(mkTrend(120, 100, 0.8, 15), 'INDIA');
    const armed = buildActionPlan(mkPullback(5), analysis, 'INDIA', INTRADAY)!;
    const wait = buildActionPlan(mkTrend(120, 100, 0.85, 5, 1.5), analysis, 'INDIA', INTRADAY)!;
    const conflict = buildActionPlan(mkTrend(120, 500, -1.5, 5, 1.5), analysis, 'INDIA', INTRADAY)!;
    expect(armed.state).toBe('ARMED');
    expect(wait.state).toBe('WAIT');
    expect(conflict.state).toBe('CONFLICT');
    // ARMED ke paas poora plan hai; WAIT/CONFLICT ke paas NAHI (levels
    // sirf trigger par bante hain — yahi top-down discipline hai)
    expect(armed.entry).toBeTruthy();
    expect(wait.entry).toBeNull();
    expect(conflict.entry).toBeNull();
  });
});

describe('v21.15.0 board signal + board builder (hermetic)', () => {
  it('findSwings: oscillating climb me swing highs & lows detect hote hain, rising series me price bhi rise', () => {
    const sw = findSwings(mkTrend(120, 100, 0.8, 15), 44);
    expect(sw.highs.length).toBeGreaterThan(0);
    expect(sw.lows.length).toBeGreaterThan(0);
    const h = sw.highs;
    expect(h[h.length - 1].price).toBeGreaterThan(h[0].price);
  });

  it('getMtfBoard: degraded (network down) → ok board, khali signals + honest counts (kabhi throw nahi)', async () => {
    __clearMtfCaches();
    __clearMtfBoardCaches();
    // rawTfCandles network karega (sandbox me fail hoga) — allSettled
    // + null-filter ke wajah se board ok:true, signals:[] + mode
    // config poora. KABHI throw nahi.
    const board = await getMtfBoard('INDIA', 'intraday', ['RELIANCE']);
    expect(board).toBeTruthy();
    expect(board.ok).toBe(true);
    expect(Array.isArray(board.signals)).toBe(true);
    expect(board.modeCfg.analysisTf).toBe('15m');
    expect(board.modeCfg.actionTf).toBe('5m');
    expect(board.modeCfg.holdWindowMin).toEqual([15, 20]);
    expect(board.disclaimer).toBeTruthy();
  });

  it('getMtfBoard: 90s cache — dobara call par SAME object (no re-scan)', async () => {
    __clearMtfBoardCaches();
    const b1 = await getMtfBoard('INDIA', 'swing', ['TCS']);
    const b2 = await getMtfBoard('INDIA', 'swing', ['TCS']);
    expect(b2).toBe(b1); // cache hit — same payload identity
  });

  it('buildMtfBoardSignal null-safe: empty symbol → null', async () => {
    __clearMtfCaches();
    expect(await buildMtfBoardSignal('', 'INDIA', 'intraday')).toBeNull();
  });
});
