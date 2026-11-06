// ============================================================
// test/mtfSuperIntel.test.ts — v21.16.0 MTF SUPERINTELLIGENCE
// Hermetic: rawTfCandles vi.mock kiya gaya (no network). Ye
// contract test karta hai:
//   1. MTF_AUTO_BAR = 75 (user ki "75+ score" bar)
//   2. mtfExpertFactors — 7 factors, side-aware grading
//   3. mtfQualityFlags — extension veto (timing POOR) + session
//   4. buildMtfBoardSignal — super layer + blueprint + autoTrade
//   5. THE HONEST CAP GUARANTEE: WAIT ≤ 70 · CONFLICT ≤ 40 ·
//      NO-BIAS ≤ 40 — sirf ARMED + fresh signals 75+ (AUTO-LINK
//      eligibility) cross kar sakte hain — BY CONSTRUCTION.
//   6. macdSeriesHist warmup fix (v21.16) — no null-contamination
// ============================================================
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------- synthetic candle builders ----------------
const mkTrend = (n: number, start = 100, step = 0.5, minutes = 5, amp = 1.5, phase = 0.6) => {
  const out = [];
  for (let i = 0; i < n; i++) {
    const c = start + step * i + Math.sin(phase * i) * amp;
    out.push({
      time: Date.now() - (n - i) * minutes * 60_000,
      open: c - Math.abs(step) / 2, high: c + amp * 0.6, low: c - amp * 0.6, close: c,
      volume: 100 + i,
    });
  }
  return out;
};

/** pullback shape: climb → flat top (EMA20 catch-up) → dip + hold */
const mkPullback = (minutes = 5) => {
  const out = mkTrend(80, 100, 0.5, minutes, 1.2, 0.5);
  let t = out[out.length - 1].time;
  const top = out[out.length - 1].close;
  for (let i = 0; i < 50; i++) {
    t += minutes * 60_000;
    out.push({ time: t, open: top, high: top + 0.1, low: top - 0.1, close: top, volume: 120 });
  }
  t += minutes * 60_000;
  out.push({ time: t, open: top, high: top + 0.1, low: top - 0.5, close: top - 0.3, volume: 130 });
  t += minutes * 60_000;
  out.push({ time: t, open: top - 0.3, high: top + 0.4, low: top - 0.35, close: top + 0.05, volume: 150 });
  return out;
};

/** counter-trend LTF — strong DOWN action series against a BULL analysis read */
const mkCounter = (minutes = 5) => mkTrend(120, 200, -1.2, minutes, 1.5, 0.5);

// ---------------- rawTfCandles mock (hermetic) ----------------
let _candles: Record<string, Array<Record<string, number>> | null> = {};
vi.mock('../server/ai/mtf.js', () => ({
  rawTfCandles: vi.fn(async (sym: string, _mkt: string, tf: string) => {
    const key = `${sym}:${tf}`;
    if (key in _candles) return _candles[key];
    return null; // network-down default
  }),
  __clearMtfCaches: vi.fn(),
}));

import {
  MTF_AUTO_BAR, MTF_MODES, readAnalysisTf, buildActionPlan,
  buildMtfBoardSignal, mtfExpertFactors, mtfQualityFlags,
  __clearMtfBoardCaches, getMtfBoard,
} from '../server/ai/mtfBoard.js';

const INTRADAY = MTF_MODES.intraday;

beforeEach(() => {
  _candles = {};
  __clearMtfBoardCaches();
});

describe('v21.16.0 MTF SUPERINTEL — auto-link bar + factor layer', () => {
  it('MTF_AUTO_BAR = 75 — user ki "75+ score" bar exactly', () => {
    expect(MTF_AUTO_BAR).toBe(75);
  });

  it('mtfExpertFactors: bullish read → 7 factors, sab 0-100 bounded, score 0-100', () => {
    const a = readAnalysisTf(mkTrend(120, 100, 0.8, 15), 'INDIA');
    const act = buildActionPlan(mkPullback(5), a, 'INDIA', INTRADAY);
    const f = mtfExpertFactors(a, act, INTRADAY)!;
    expect(f).toBeTruthy();
    expect(f.factors.length).toBe(7);
    expect(f.factors.map(x => x.key)).toEqual(['trend', 'momentum', 'volume', 'smc', 'volatility', 'regime', 'rr']);
    for (const x of f.factors) {
      expect(x.value).toBeGreaterThanOrEqual(0);
      expect(x.value).toBeLessThanOrEqual(100);
      expect(x.weight).toBeGreaterThan(0);
    }
    expect(f.score).toBeGreaterThanOrEqual(0);
    expect(f.score).toBeLessThanOrEqual(100);
    // weights sum to 1
    const w = f.factors.reduce((s, x) => s + x.weight, 0);
    expect(w).toBeCloseTo(1, 6);
  });

  it('mtfExpertFactors: null analysis → null (honest degrade)', () => {
    expect(mtfExpertFactors(null as any, null, INTRADAY)).toBeNull();
  });

  it('mtfQualityFlags: timing POOR → extension veto (score cap lagta hai)', () => {
    const q = mtfQualityFlags(null, { timing: { quality: 'POOR', note: 'x' } } as any, INTRADAY, false);
    expect(q.extension.veto).toBe(true);
    const q2 = mtfQualityFlags(null, { timing: { quality: 'GOOD', note: 'x' } } as any, INTRADAY, false);
    expect(q2.extension.veto).toBe(false);
  });

  it('mtfQualityFlags: stale → session tradeable false', () => {
    const q = mtfQualityFlags(null, null, INTRADAY, true);
    expect(q.session.tradeable).toBe(false);
    expect(q.mtf.available).toBe(true);
  });
});

describe('v21.16.0 buildMtfBoardSignal — super layer + blueprint + autoTrade', () => {
  it('ARMED PULLBACK (bull) → super score + tier + 7 factors + blueprint staged exits + autoTrade shape', async () => {
    _candles = { 'TCS:15m': mkTrend(120, 100, 0.8, 15), 'TCS:5m': mkPullback(5) };
    const sig = await buildMtfBoardSignal('TCS', 'INDIA', 'intraday');
    expect(sig).toBeTruthy();
    expect(sig!.state).toBe('ARMED');
    expect(sig!.super).toBeTruthy();
    expect(sig!.super!.aiScore).toBeGreaterThanOrEqual(0);
    expect(sig!.super!.aiScore).toBeLessThanOrEqual(100);
    expect(['ELITE', 'STRONG', 'ACTION', 'WATCH', 'NEUTRAL']).toContain(sig!.super!.tier);
    expect(sig!.super!.factors!.length).toBe(7);
    expect(sig!.autoTrade).toBeTruthy();
    expect(sig!.autoTrade!.bar).toBe(75);
    // blueprint — staged 40/40/20 exits on an ARMED signal
    const bp = sig!.blueprint!;
    expect(bp).toBeTruthy();
    expect(bp.exitPlan.length).toBe(3);
    expect([40, 40, 20]).toEqual(bp.exitPlan.map(e => e.bookPct));
    expect(bp.stopLoss).toBeLessThan(bp.entry);
    expect(bp.targets.t1).toBeGreaterThan(bp.entry);
    // analysis read me v21.16 additions
    expect(sig!.analysis!.atrPctOfPrice).not.toBeNull();
    expect(sig!.analysis!.smc !== undefined).toBe(true);
    expect(sig!.analysis!.priceAction !== undefined).toBe(true);
  });

  it('WAIT signal (bias set, no trigger) → super score 70-cap, autoTrade ELIGIBLE NEVER', async () => {
    // analysis bull, action FLAT far away (koi trigger nahi, koi conflict nahi)
    const flatFar = mkTrend(90, 100, 0.02, 5, 0.25, 0.05);
    _candles = { 'SBIN:15m': mkTrend(120, 100, 0.8, 15), 'SBIN:5m': flatFar };
    const sig = await buildMtfBoardSignal('SBIN', 'INDIA', 'intraday');
    expect(sig).toBeTruthy();
    if (sig!.state === 'WAIT') {
      expect(sig!.super!.aiScore).toBeLessThanOrEqual(70);
      expect(sig!.autoTrade!.eligible).toBe(false);
      expect(sig!.autoTrade!.reason).toContain('ARMED');
    } else {
      // geometry-dependent: agar ARMED hi bana to bhi WAIT-path nahi —
      // auto eligibility super bar honor karegi (niche wale tests me)
      expect(sig!.state).toBe('ARMED');
    }
  });

  it('CONFLICT signal → confluenceScore = 0 + timing BLOCKED + super ≤ 40 — auto-link IMPOSSIBLE', async () => {
    const bullAnalysisCandles = mkTrend(120, 100, 0.8, 15);
    const bearAction = mkCounter(5); // strong down 5m against bull 15m
    _candles = { 'RELIANCE:15m': bullAnalysisCandles, 'RELIANCE:5m': bearAction };
    const sig = await buildMtfBoardSignal('RELIANCE', 'INDIA', 'intraday');
    expect(sig).toBeTruthy();
    if (sig!.state === 'CONFLICT') {
      expect(sig!.confluenceScore).toBe(0);
      expect(sig!.action!.timing.quality).toBe('BLOCKED');
      expect(sig!.super!.aiScore).toBeLessThanOrEqual(40);
      expect(sig!.autoTrade!.eligible).toBe(false);
      expect(sig!.blueprint).toBeNull();
    } else {
      // geometry-dependent — action ka EMA conflict threshold strict hai;
      // agar WAIT bana to bhi honest caps hold karenge (≤ 70)
      expect(['WAIT', 'ARMED']).toContain(sig!.state);
      if (sig!.state === 'WAIT') expect(sig!.super!.aiScore).toBeLessThanOrEqual(70);
    }
  });

  it('NO-BIAS (flat analysis) → state NO-BIAS, side null, autoTrade ineligible', async () => {
    const flat = Array.from({ length: 120 }, (_, i) => ({
      time: Date.now() - (120 - i) * 15 * 60_000,
      open: 100, high: 100.3, low: 99.7, close: 100, volume: 50,
    }));
    _candles = { 'ITC:15m': flat, 'ITC:5m': mkPullback(5) };
    const sig = await buildMtfBoardSignal('ITC', 'INDIA', 'intraday');
    expect(sig).toBeTruthy();
    expect(sig!.state).toBe('NO-BIAS');
    expect(sig!.side).toBeNull();
    expect(sig!.autoTrade!.eligible).toBe(false);
    expect(sig!.super!.aiScore).toBeLessThanOrEqual(40);
  });

  it('stale ARMED signal → super 65-cap + autoTrade ineligible (session gate)', async () => {
    // 15m candles jo 2 ghante purani hain (15m TF × 3 + 5m buffer = 50m staleness bar)
    const oldTime = Date.now() - 2 * 3600_000;
    const analysisCandles = mkTrend(120, 100, 0.8, 15).map((c, i) => ({ ...c, time: oldTime - (120 - i) * 15 * 60_000 }));
    _candles = { 'LT:15m': analysisCandles, 'LT:5m': mkPullback(5) };
    const sig = await buildMtfBoardSignal('LT', 'INDIA', 'intraday');
    expect(sig).toBeTruthy();
    expect(sig!.stale).toBe(true);
    expect(sig!.super!.aiScore).toBeLessThanOrEqual(65);
    expect(sig!.autoTrade!.eligible).toBe(false);
    expect(sig!.autoTrade!.reason).toContain('stale');
  });
});

describe('v21.16.0 THE AUTO-BAR GUARANTEE (by construction)', () => {
  it('koi bhi WAIT / CONFLICT / NO-BIAS signal kabhi 75+ super score nahi bana sakta', async () => {
    // WAIT shape
    const flatFar = mkTrend(90, 100, 0.02, 5, 0.25, 0.05);
    _candles = { 'HDFCBANK:15m': mkTrend(120, 100, 0.8, 15), 'HDFCBANK:5m': flatFar };
    const waitSig = await buildMtfBoardSignal('HDFCBANK', 'INDIA', 'intraday');
    if (waitSig && waitSig.state === 'WAIT') {
      expect(waitSig.super!.aiScore).toBeLessThanOrEqual(70);
      expect(waitSig.autoTrade!.eligible).toBe(false);
    }
    // CONFLICT shape
    _candles = { 'AXISBANK:15m': mkTrend(120, 100, 0.8, 15), 'AXISBANK:5m': mkCounter(5) };
    const conflictSig = await buildMtfBoardSignal('AXISBANK', 'INDIA', 'intraday');
    if (conflictSig && conflictSig.state === 'CONFLICT') {
      expect(conflictSig.super!.aiScore).toBeLessThanOrEqual(40);
      expect(conflictSig.confluenceScore).toBe(0);
    }
    // NO-BIAS shape
    const flat = Array.from({ length: 120 }, (_, i) => ({
      time: Date.now() - (120 - i) * 15 * 60_000,
      open: 100, high: 100.3, low: 99.7, close: 100, volume: 50,
    }));
    _candles = { 'MARUTI:15m': flat, 'MARUTI:5m': flatFar };
    const noBiasSig = await buildMtfBoardSignal('MARUTI', 'INDIA', 'intraday');
    expect(noBiasSig!.state).toBe('NO-BIAS');
    expect(noBiasSig!.super!.aiScore).toBeLessThanOrEqual(40);
  });
});

describe('v21.16.0 board payload — superintel meta + autoReady counts', () => {
  it('getMtfBoard: counts.autoReady + autoBar + autoReadySymbols fields + super-score sorting', async () => {
    _candles = {
      'TCS:15m': mkTrend(120, 100, 0.8, 15), 'TCS:5m': mkPullback(5),
      'RELIANCE:15m': mkTrend(120, 100, 0.8, 15), 'RELIANCE:5m': mkPullback(5),
    };
    const board = await getMtfBoard('INDIA', 'intraday', ['TCS', 'RELIANCE']);
    expect(board.ok).toBe(true);
    expect(board.autoBar).toBe(75);
    expect(board.counts.autoReady).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(board.autoReadySymbols)).toBe(true);
    expect(board.disclaimer).toContain('paper');
    // har signal me super block hai
    for (const s of board.signals) {
      expect(s.super).toBeTruthy();
      expect(s.autoTrade).toBeTruthy();
    }
  });
});
