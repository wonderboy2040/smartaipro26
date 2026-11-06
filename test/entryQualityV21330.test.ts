// ============================================================
// test/entryQualityV21330.test.ts — v21.33.0 PHASE F TESTS
// ------------------------------------------------------------
//   • F-c spread gate: cap = max(hard, 2×median), fail-open coverage
//   • F-b slippage model: a + b·(notional/depth) + c·spread; R-budget
//   • F-a retest entry: LONG limit BELOW level, SHORT ABOVE (direction
//     correctness), expiry, miss=skip
//   • F-f funding window proximity
// ============================================================
import { describe, it, expect } from 'vitest';
import {
  evaluateSpreadGate, evaluateSlippageGate, estimateSlippageBps,
  retestEntryPlan, retestTouched, fundingWindowProximity, evaluateEntryQuality,
  rollingMedianSpread,
} from '../server/ai/entryQuality.js';

const NOW = 1_700_000_000_000;

describe('v21.33.0 F-c — spread gate', () => {
  it('tight spread → allow', () => {
    const g = evaluateSpreadGate({ spreadBps: 3, spreadHistory: [2, 3, 2.5], mode: 'shadow' });
    expect(g.wouldBlock).toBe(false);
    expect(g.coverage).toBe(true);
  });
  it('wide spread > 2×median → wouldBlock (shadow me blocked=false)', () => {
    const g = evaluateSpreadGate({ spreadBps: 30, spreadHistory: [2, 3, 2.5], mode: 'shadow' });
    expect(g.wouldBlock).toBe(true);
    expect(g.blocked).toBe(false);
    expect(g.reason).toContain('spread');
  });
  it('hard cap floor: median low ho to bhi hard cap se block', () => {
    const g = evaluateSpreadGate({ spreadBps: 15, spreadHistory: [1, 1, 1], mode: 'shadow' });
    expect(g.wouldBlock).toBe(true); // 15 > hardCap 12
  });
  it('missing spreadBps → fail-open, coverage false', () => {
    const g = evaluateSpreadGate({ spreadBps: null, mode: 'shadow' });
    expect(g.wouldBlock).toBe(false);
    expect(g.coverage).toBe(false);
  });
  it('liquidity floor veto', () => {
    const g = evaluateSpreadGate({ spreadBps: 3, liquidityUSD: 500_000, minLiquidityUSD: 2_000_000 });
    expect(g.wouldBlock).toBe(true);
    expect(g.reason).toContain('liquidity');
  });
  it('rollingMedianSpread math', () => {
    expect(rollingMedianSpread([3, 1, 2])).toBe(2);
    expect(rollingMedianSpread([4, 1, 2, 3])).toBe(2.5);
    expect(rollingMedianSpread([])).toBeNull();
  });
  // v21.35.0 [A12]: spreadMedianWindow (50) ab PLUMBED hai — pehle config
  // dead thi (full history ka median lagta tha) → spread-regime shift ke
  // baad stale full-history median entry ko hamesha over-block karta tha.
  it('v21.35.0 [A12]: median window-bounded — regime shift stale full-history median se over-block nahi', () => {
    // 60 purani tight entries (2bps) + 40 naye wide (20bps) — regime shift
    const hist = [...Array(60).fill(2), ...Array(40).fill(20)];
    const g = evaluateSpreadGate({ spreadBps: 25, spreadHistory: hist, mode: 'shadow' });
    expect(g.rollingMedianBps).toBe(20); // last-50 window me majority 20
    expect(g.capBps).toBe(40);           // max(12, 2×20) — cap formula same
    expect(g.wouldBlock).toBe(false);    // 25 < 40 → allow
    // contrast: full-history median (window > length) → stale 2 → over-block
    const full = evaluateSpreadGate({ spreadBps: 25, spreadHistory: hist, medianWindow: 200 });
    expect(full.rollingMedianBps).toBe(2);
    expect(full.wouldBlock).toBe(true); // purana behaviour — regression contrast
    // custom chhota window bhi plumb hota hai
    const w10 = evaluateSpreadGate({ spreadBps: 25, spreadHistory: hist, medianWindow: 10 });
    expect(w10.rollingMedianBps).toBe(20);
  });
});

describe('v21.33.0 F-b — slippage model + gate', () => {
  it('model: base + depth term + spread term monotone', () => {
    const tiny = estimateSlippageBps({ notionalUSD: 100, depthUSD: 1_000_000, spreadBps: 2 });
    const huge = estimateSlippageBps({ notionalUSD: 900_000, depthUSD: 1_000_000, spreadBps: 30 });
    expect(tiny).toBeGreaterThan(0);
    expect(huge).toBeGreaterThan(tiny);
  });
  it('missing notional → null (honest)', () => {
    expect(estimateSlippageBps({})).toBeNull();
  });
  it('expected slippage R conversion + 0.15R budget block', () => {
    // notional 50_000, risk 200: bps = 2 + 0.35·20 + ~0 ≈ 9bps
    // → R = (9/10⁴)·50_000/200 = 0.225R > 0.15R budget → block
    const bad = evaluateSlippageGate({ side: 'LONG', notionalUSD: 50_000, depthUSD: 10_000_000, spreadBps: 20, riskUSD: 200, mode: 'enforce' });
    expect(bad.coverage).toBe(true);
    expect(bad.expectedSlippageR).toBeGreaterThan(0.15);
    expect(bad.blocked).toBe(true);
    expect(bad.reason).toContain('budget');
    // same setup with healthy risk budget → allow
    const ok = evaluateSlippageGate({ side: 'LONG', notionalUSD: 50_000, depthUSD: 10_000_000, spreadBps: 20, riskUSD: 1000, mode: 'shadow' });
    expect(ok.expectedSlippageR).toBeLessThan(0.15);
    expect(ok.wouldBlock).toBe(false);
  });
  it('not computable → fail-open', () => {
    const g = evaluateSlippageGate({ side: 'LONG', mode: 'shadow' });
    expect(g.coverage).toBe(false);
    expect(g.wouldBlock).toBe(false);
    expect(g.reason).toContain('fail-open');
  });
  // v21.35.0 [A13]: depth missing par pehle depthTerm=0 hota tha jabki
  // coverage:true — base+spread-only bps CONFIDENT report hota tha (asl
  // impact ~3× under-report, 0.15R budget ke paas verdict flip).
  it('v21.35.0 [A13]: missing/zero depth → computable FALSE + honest reason (verdict fail-open hi)', () => {
    const g = evaluateSlippageGate({ side: 'LONG', notionalUSD: 50_000, depthUSD: null, spreadBps: 20, riskUSD: 200, mode: 'enforce' });
    expect(g.coverage).toBe(false);
    expect(g.expectedSlippageR).toBeNull(); // confidence fabricate nahi
    expect(g.wouldBlock).toBe(false);      // doctrine fail-open
    expect(g.blocked).toBe(false);
    expect(g.reason).toContain('depth');
    expect(g.reason).toContain('fail-open');
    // depth 0 wahi honest refuse
    const zero = evaluateSlippageGate({ side: 'LONG', notionalUSD: 50_000, depthUSD: 0, spreadBps: 20, riskUSD: 200 });
    expect(zero.coverage).toBe(false);
    expect(zero.reason).toContain('depth');
    // depth present → pehle jaisa computable (regression guard)
    const ok = evaluateSlippageGate({ side: 'LONG', notionalUSD: 50_000, depthUSD: 10_000_000, spreadBps: 20, riskUSD: 200 });
    expect(ok.coverage).toBe(true);
    expect(ok.expectedSlippageR).not.toBeNull();
  });
});

describe('v21.33.0 F-a — retest entry plan (DIRECTION correctness)', () => {
  it('LONG: limit price breakout level se NEECHE (pullback buy)', () => {
    const p = retestEntryPlan({ side: 'LONG', breakoutLevel: 100, atr: 2, triggerBarTime: 1000 });
    expect(p.available).toBe(true);
    expect(p.limitPrice).toBeLessThan(100);
    expect(p.limitPrice).toBeCloseTo(100 - 0.18 * 2, 4);
    expect(p.expiryAt).toBe(1000 + 8 * 5 * 60_000);
  });
  it('SHORT: limit price breakout level se UPAR (pullback sell)', () => {
    const p = retestEntryPlan({ side: 'SHORT', breakoutLevel: 100, atr: 2, triggerBarTime: 1000 });
    expect(p.limitPrice).toBeGreaterThan(100);
  });
  it('atr band clamp [0.10, 0.25]', () => {
    // v21.35.0 [A14]: triggerBarTime ab zaroori — expiry hi miss=skip policy ki jaan hai
    const lo = retestEntryPlan({ side: 'LONG', breakoutLevel: 100, atr: 2, atrBand: 0.01, triggerBarTime: 1000 });
    const hi = retestEntryPlan({ side: 'LONG', breakoutLevel: 100, atr: 2, atrBand: 0.9, triggerBarTime: 1000 });
    expect(lo.limitPrice).toBeCloseTo(100 - 0.10 * 2, 4);
    expect(hi.limitPrice).toBeCloseTo(100 - 0.25 * 2, 4);
  });
  it('invalid inputs → unavailable honest', () => {
    expect(retestEntryPlan({ side: 'FLAT', breakoutLevel: 100, atr: 2 }).available).toBe(false);
    expect(retestEntryPlan({ side: 'LONG', breakoutLevel: null, atr: 2 }).available).toBe(false);
  });
  // v21.35.0 [A14]: triggerBarTime missing → expiryAt null tha par plan
  // available:true — limit indefinitely rest karta tha (policy miss=skip,
  // NO chase). Ab honest refuse.
  it('v21.35.0 [A14]: triggerBarTime missing → plan UNAVAILABLE (limit rest nahi karta)', () => {
    const p = retestEntryPlan({ side: 'LONG', breakoutLevel: 100, atr: 2, triggerBarTime: null });
    expect(p.available).toBe(false);
    expect(p.reason).toBe('missing_trigger_bar_time');
    expect(p.limitPrice).toBeNull();
    expect(p.expiryAt).toBeNull();
  });
  it('retestTouched: LONG price limit tak neeche aaye, SHORT upar', () => {
    const long = retestEntryPlan({ side: 'LONG', breakoutLevel: 100, atr: 2, triggerBarTime: 1000 });
    expect(retestTouched({ side: 'LONG', limitPrice: long.limitPrice, ltp: long.limitPrice - 0.5 })).toBe(true);
    expect(retestTouched({ side: 'LONG', limitPrice: long.limitPrice, ltp: long.limitPrice + 1 })).toBe(false);
    const short = retestEntryPlan({ side: 'SHORT', breakoutLevel: 100, atr: 2, triggerBarTime: 1000 });
    expect(retestTouched({ side: 'SHORT', limitPrice: short.limitPrice, ltp: short.limitPrice + 0.5 })).toBe(true);
    expect(retestTouched({ side: 'SHORT', limitPrice: short.limitPrice, ltp: short.limitPrice - 1 })).toBe(false);
  });
});

describe('v21.33.0 F-f — funding window proximity', () => {
  it('settlement se 2 min pehle → inPreWindow', () => {
    const f = fundingWindowProximity({ nextFundingTs: NOW + 2 * 60_000, now: NOW });
    expect(f.available).toBe(true);
    expect(f.inPreWindow).toBe(true);
  });
  it('settlement ke 30s baad → inPostWindow', () => {
    const f = fundingWindowProximity({ nextFundingTs: NOW - 30_000, now: NOW });
    expect(f.inPostWindow).toBe(true);
    expect(f.inPreWindow).toBe(false);
  });
  it('door settlement → dono false', () => {
    const f = fundingWindowProximity({ nextFundingTs: NOW + 45 * 60_000, now: NOW });
    expect(f.inPreWindow).toBe(false);
    expect(f.inPostWindow).toBe(false);
  });
  it('missing ts → unavailable', () => {
    expect(fundingWindowProximity({}).available).toBe(false);
  });
});

describe('v21.33.0 — composite evaluateEntryQuality', () => {
  it('spread + slippage dono clean → no block; coverage honest', () => {
    const q = evaluateEntryQuality({
      side: 'LONG', spreadBps: 3, spreadHistory: [2, 3, 2.5],
      notionalUSD: 1000, depthUSD: 500_000, riskUSD: 500,
    });
    expect(q.wouldBlock).toBe(false);
    expect(q.filter).toBe('entryQuality');
  });
  it('koi ek gate block kare → composite block + reason', () => {
    const q = evaluateEntryQuality({
      side: 'LONG', spreadBps: 40, spreadHistory: [2, 3],
      notionalUSD: 1000, depthUSD: 500_000, riskUSD: 500, mode: 'enforce',
    });
    expect(q.wouldBlock).toBe(true);
    expect(q.blocked).toBe(true);
    expect(q.reasons.length).toBeGreaterThan(0);
  });
});
