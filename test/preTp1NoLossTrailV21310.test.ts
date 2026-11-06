// ============================================================
// test/preTp1NoLossTrailV21310.test.ts — v21.31.0 PRE-TP1 NO-LOSS SMART TRAIL
// ------------------------------------------------------------
// USER SPEC: Auto Trade lagne ke baad AI agent ko TP1 ka wait nahi karna —
// highest volatility me smart SL trail, no-loss-only-profit floor, live
// direction/trend ke hisaab se tighten. Ratchet-only: SL kabhi loose nahi.
//
// LOCKS:
//   T1  LONG arm → fee-breakeven + vol buffer (not raw entry)
//   T2  below arm threshold = initial SL untouched
//   T3  fee not covered = never arm
//   T4  HIGH/EXTREME arm later + wider giveback (volatility-aware)
//   T5  adverse live trend tightens only (never loosens)
//   T6  SHORT mirror parity
//   T7  shadow/off never move the stop
//   T8  no proposal at/through LTP + strict ratchet
//   T9  stale quote (`allowMove:false`) cannot ratchet
//   T10 deep-monitor integration + stage code
//   T11 trail hit books fee-safe profit; gap-through is labelled honestly
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-tp1-trail-21310-'));
process.env.MTF_AUTO_DATA_DIR = TMP_DATA;

import {
  evaluatePreTp1NoLossTrail, PRE_TP1_VOL_PROFILE, progressiveProfitLockR,
} from '../server/ai/preTp1Trail.js';
import {
  evaluateActiveTradeDeepMonitor, preTp1TrailMode,
} from '../server/ai/mtfAutoLink.js';

const NOW = 1_765_000_000_000;

const base = {
  mode: 'enforce',
  side: 'LONG',
  entry: 100,
  initialStopLoss: 99,
  currentStopLoss: 99,
  peakPrice: 100,
  ltp: 100,
  risk: 1,
  feeFloor: 100.12, // FUTURES 0.12% round trip
  volClass: 'NORMAL',
  momentumState: 'STEADY',
};

function dmTrade(over: Record<string, any> = {}) {
  return {
    symbol: 'BTCUSDT', market: 'FUTURES', execMarket: 'FUTURES', ccy: 'USDT',
    side: 'LONG', entry: 100, entryPrice: 100, stopLoss: 99, initialStopLoss: 99,
    t1: 101, t2: 102, qty: 1, peakPrice: 100, openedAt: NOW - 10 * 60_000,
    proExitPolicy: true,
    ...over,
  };
}

describe('v21.31.0 pre-TP1 no-loss trail — pure engine', () => {
  it('T1 LONG arms at +0.38R and locks fee-breakeven + 0.10R buffer (v21.35.5 progressive floor at 0.6R peak = 0.24R)', () => {
    const out = evaluatePreTp1NoLossTrail({ ...base, peakPrice: 100.6, ltp: 100.6 });
    expect(out.mode).toBe('enforce');
    expect(out.armed).toBe(true);
    expect(out.applied).toBe(true);
    expect(out.armR).toBe(0.38);
    expect(out.noLossSl).toBeCloseTo(100.22, 6);
    // v21.35.5: at 0.6R peak the 0.40-step progressive lock (40% of 0.6R = 0.24R)
    // sits ABOVE the fee-floor+buffer — the profit-lock floor is the binding one.
    expect(out.proposedSl).toBeCloseTo(100.24, 6);
    expect(out.lockedProfitR).toBe(0.24);
    expect(out.ratchetOnly).toBe(true);
    // Never a raw break-even: the buffer is strictly above fee floor.
    expect(out.proposedSl).toBeGreaterThan(100.12);
  });

  it('T2 a +0.22R pop is below the arm threshold — initial SL untouched', () => {
    const out = evaluatePreTp1NoLossTrail({ ...base, peakPrice: 100.22, ltp: 100.05 });
    expect(out.armed).toBe(false);
    expect(out.applied).toBe(false);
    expect(out.proposedSl).toBeNull();
    expect(out.reason).toBe('below_arm_threshold');
  });

  it('T3 fee not covered never arms, even at a large favourable excursion', () => {
    const out = evaluatePreTp1NoLossTrail({
      ...base, peakPrice: 100.08, ltp: 100.08, feeFloor: 100.5,
    });
    expect(out.armed).toBe(false);
    expect(out.reason).toBe('fee_not_covered');
  });

  it('T4 higher volatility arms later and keeps a wider giveback', () => {
    const normal = evaluatePreTp1NoLossTrail({ ...base, peakPrice: 101, ltp: 101 });
    const high = evaluatePreTp1NoLossTrail({ ...base, volClass: 'HIGH', peakPrice: 101, ltp: 101 });
    const extreme = evaluatePreTp1NoLossTrail({ ...base, volClass: 'EXTREME', peakPrice: 101, ltp: 101 });
    expect(PRE_TP1_VOL_PROFILE.EXTREME.armR).toBeGreaterThan(PRE_TP1_VOL_PROFILE.HIGH.armR);
    expect(PRE_TP1_VOL_PROFILE.HIGH.armR).toBeGreaterThan(PRE_TP1_VOL_PROFILE.NORMAL.armR);
    expect(high.givebackR).toBeGreaterThan(normal.givebackR);
    expect(extreme.givebackR).toBeGreaterThan(high.givebackR);
    expect(extreme.proposedSl).toBeLessThan(high.proposedSl); // wider room, same peak
    expect(extreme.proposedSl).toBeGreaterThan(100.12);         // still fee-safe
  });

  it('T5 adverse live trend tightens the giveback, favourable never loosens it', () => {
    const steady = evaluatePreTp1NoLossTrail({ ...base, peakPrice: 100.6, ltp: 100.6 });
    const adverse = evaluatePreTp1NoLossTrail({
      ...base, peakPrice: 100.6, ltp: 100.6, tickTrendPct: -0.12, tickTrendAdverse: true,
    });
    const favourable = evaluatePreTp1NoLossTrail({
      ...base, peakPrice: 100.6, ltp: 100.6, tickTrendPct: 0.30,
    });
    expect(adverse.trendAdverse).toBe(true);
    expect(adverse.givebackR).toBeLessThan(steady.givebackR);
    expect(adverse.proposedSl).toBeGreaterThan(steady.proposedSl); // LONG tightens upward
    expect(adverse.proposedSl).toBeGreaterThanOrEqual(adverse.noLossSl);
    expect(favourable.proposedSl).toBe(steady.proposedSl);          // no loosening/widening
  });

  it('T6 SHORT mirror: fee floor − buffer, wider adverse lock, strict ratchet', () => {
    const shortBase = {
      ...base, side: 'SHORT', initialStopLoss: 101, currentStopLoss: 101,
      feeFloor: 99.88,
    };
    const out = evaluatePreTp1NoLossTrail({ ...shortBase, peakPrice: 99.2, ltp: 99.2 });
    expect(out.side).toBe('SHORT');
    expect(out.armed).toBe(true);
    expect(out.noLossSl).toBeCloseTo(99.78, 6);
    // v21.35.5: at +0.8R the progressive lock (55% of the 0.8R peak = 0.44R)
    // is the tightest SHORT floor: 100 − 0.44 = 99.56 (lower = more profit
    // locked). Giveback trail (99.62) and fee floor (99.78) sit above it.
    expect(out.progressiveLockR).toBeCloseTo(0.44, 2);
    expect(out.proposedSl).toBeCloseTo(99.56, 6);
    expect(out.proposedSl).toBeLessThanOrEqual(out.noLossSl);
    expect(out.proposedSl).toBeLessThan(99.88);

    const adverse = evaluatePreTp1NoLossTrail({
      ...shortBase, peakPrice: 99.2, ltp: 99.2, tickTrendAdverse: true,
    });
    expect(adverse.proposedSl).toBeLessThan(out.proposedSl); // SHORT tightens downward

    const alreadyTighter = evaluatePreTp1NoLossTrail({
      ...shortBase, currentStopLoss: 99.5, peakPrice: 99.2, ltp: 99.2,
    });
    expect(alreadyTighter.applied).toBe(false);
    expect(alreadyTighter.reason).toBe('no_improvement');
  });

  it('T7 shadow reports the proposal without applying; off is inactive', () => {
    const shadow = evaluatePreTp1NoLossTrail({
      ...base, mode: 'shadow', peakPrice: 100.6, ltp: 100.6,
    });
    expect(shadow.armed).toBe(true);
    expect(shadow.applied).toBe(false);
    expect(shadow.proposedSl).toBeNull();
    expect(shadow.wouldApplySl).toBeCloseTo(100.24, 6); // v21.35.5 progressive floor

    const off = evaluatePreTp1NoLossTrail({
      ...base, mode: 'off', peakPrice: 100.6, ltp: 100.6,
    });
    expect(off.available).toBe(false);
    expect(off.armed).toBe(false);
    expect(off.applied).toBe(false);
    expect(off.reason).toBe('mode_off');
  });

  it('T8 never proposes at/through LTP and never loosens an existing stop', () => {
    const cross = evaluatePreTp1NoLossTrail({
      ...base, peakPrice: 100.6, ltp: 100.205,
    });
    expect(cross.armed).toBe(true);
    expect(cross.applied).toBe(false);
    expect(cross.reason).toBe('would_cross_ltp');
    expect(cross.proposedSl).toBeNull();

    const alreadyBetter = evaluatePreTp1NoLossTrail({
      ...base, currentStopLoss: 100.5, peakPrice: 100.6, ltp: 100.6,
    });
    expect(alreadyBetter.applied).toBe(false);
    expect(alreadyBetter.reason).toBe('no_improvement');
  });

  it('T9 stale quote (allowMove:false) computes telemetry but cannot ratchet', () => {
    const stale = evaluatePreTp1NoLossTrail({
      ...base, peakPrice: 100.6, ltp: 100.6, allowMove: false,
    });
    expect(stale.armed).toBe(true);
    expect(stale.applied).toBe(false);
    expect(stale.reason).toBe('move_not_allowed');
    expect(stale.wouldApplySl).toBeCloseTo(100.24, 6); // v21.35.5 progressive floor
  });

  it('invalid side / missing fee floor fail closed', () => {
    expect(evaluatePreTp1NoLossTrail({ ...base, side: 'SIDEWAYS' }).reason).toBe('invalid_side');
    expect(evaluatePreTp1NoLossTrail({ ...base, feeFloor: 0 }).reason).toBe('missing_fee_floor');
  });
});

describe('v21.31.0 pre-TP1 no-loss trail — deep-monitor integration', () => {
  const prev = process.env.PRE_TP1_TRAIL;
  beforeEach(() => { delete process.env.PRE_TP1_TRAIL; });
  afterEach(() => {
    if (prev === undefined) delete process.env.PRE_TP1_TRAIL;
    else process.env.PRE_TP1_TRAIL = prev;
  });

  it('T10a v21.32.0 default is SHADOW (G10 — LIVE-SMALL #1–#2 pending); explicit enforce ratchets the PRO pre-TP1 stop', () => {
    expect(preTp1TrailMode()).toBe('shadow');
    // v21.32.0 [G10]: PRE_TP1_TRAIL default enforce→shadow — SL replace/stack
    // exchange semantics bina live proof ke act nahi karni chahiye
    // (FLAG-HISTORY.md 2026-10-31). Enforce path ab explicit opt-in hai.
    process.env.PRE_TP1_TRAIL = 'enforce';
    try {
      expect(preTp1TrailMode()).toBe('enforce');
    } finally {
      delete process.env.PRE_TP1_TRAIL;
    }
    const ev = evaluateActiveTradeDeepMonitor(
      dmTrade({ peakPrice: 100.6 }),
      { ltp: 100.6, preTp1Trail: 'enforce' },
    );
    expect(ev.stageCode).toBe('STAGE_0B_PRE_TP1_TRAIL');
    expect(ev.slTrailed).toBe(true);
    expect(ev.trailedStopLoss).toBeCloseTo(100.24, 6); // v21.35.5 progressive floor
    expect(ev.preTp1Trail).toMatchObject({
      mode: 'enforce', armed: true, applied: true, volClass: 'NORMAL',
    });
    expect(ev.exitReason).toBeNull();
    expect(ev.shouldClose).toBe(false);
    // Default (shadow) me wahi trade initial SL pe hi rehta hai — telemetry only.
    const def = evaluateActiveTradeDeepMonitor(
      dmTrade({ peakPrice: 100.6 }),
      { ltp: 100.6 },
    );
    expect(def.stageCode).toBe('STAGE_0_INITIAL_GUARD');
    expect(def.slTrailed).toBe(false);
    expect(def.preTp1Trail?.mode).toBe('shadow');
  });

  it('T10b shadow/off are telemetry-only and preserve the initial SL', () => {
    const shadow = evaluateActiveTradeDeepMonitor(
      dmTrade({ peakPrice: 100.6 }),
      { ltp: 100.6, preTp1Trail: 'shadow' },
    );
    expect(shadow.stageCode).toBe('STAGE_0_INITIAL_GUARD');
    expect(shadow.trailedStopLoss).toBe(99);
    expect(shadow.slTrailed).toBe(false);
    expect(shadow.preTp1Trail?.wouldApplySl).toBeCloseTo(100.24, 6); // v21.35.5 progressive floor

    const off = evaluateActiveTradeDeepMonitor(
      dmTrade({ peakPrice: 100.6 }),
      { ltp: 100.6, preTp1Trail: 'off' },
    );
    expect(off.stageCode).toBe('STAGE_0_INITIAL_GUARD');
    expect(off.trailedStopLoss).toBe(99);
    expect(off.preTp1Trail?.available).toBe(false);
  });

  it('T10c adverse live tick trend tightens the proposal', () => {
    const steady = evaluateActiveTradeDeepMonitor(
      dmTrade({ peakPrice: 100.6 }),
      { ltp: 100.6, preTp1Trail: 'enforce' },
    );
    const adverse = evaluateActiveTradeDeepMonitor(
      dmTrade({ peakPrice: 100.6 }),
      { ltp: 100.6, preTp1Trail: 'enforce', tickTrendPct: -0.10, tickTrendAdverse: true },
    );
    expect(adverse.trailedStopLoss).toBeGreaterThan(steady.trailedStopLoss);
    expect(adverse.preTp1Trail?.trendAdverse).toBe(true);
    expect(adverse.trailedStopLoss).toBeLessThan(100.6); // never cross LTP
  });

  it('T10c2 EXTREME volatility keeps a wider giveback than HIGH', () => {
    const high = evaluateActiveTradeDeepMonitor(
      dmTrade({ peakPrice: 100.8, atrPct: 2.0 }),
      { ltp: 100.8, preTp1Trail: 'enforce' },
    );
    const extreme = evaluateActiveTradeDeepMonitor(
      dmTrade({ peakPrice: 100.8, atrPct: 4.0 }),
      { ltp: 100.8, preTp1Trail: 'enforce' },
    );
    expect(high.preTp1Trail?.volClass).toBe('HIGH');
    expect(extreme.preTp1Trail?.volClass).toBe('EXTREME');
    expect(extreme.preTp1Trail!.givebackR!).toBeGreaterThan(high.preTp1Trail!.givebackR!);
    expect(extreme.preTp1Trail!.armR).toBeGreaterThan(high.preTp1Trail!.armR);
    // EXTREME keeps a bigger fee-buffer; both proposals stay above the exact
    // fee floor (the wider giveback must never buy back fee risk).
    expect(extreme.preTp1Trail!.noLossSl!).toBeGreaterThan(high.preTp1Trail!.noLossSl!);
    expect(extreme.trailedStopLoss).toBeGreaterThan(100.12);
    expect(high.trailedStopLoss).toBeGreaterThan(100.12);
  });

  it('T10c3 SHORT mirror trails below entry and never crosses LTP', () => {
    const ev = evaluateActiveTradeDeepMonitor(
      dmTrade({
        side: 'SHORT', stopLoss: 101, initialStopLoss: 101,
        t1: 99, t2: 98, peakPrice: 99.2,
      }),
      { ltp: 99.2, preTp1Trail: 'enforce' },
    );
    expect(ev.stageCode).toBe('STAGE_0B_PRE_TP1_TRAIL');
    // v21.35.5: SHORT mirror — at 0.8R peak the 0.55-step progressive lock
    // (55% of 0.8R = 0.44R) is the binding floor: 100 − 0.44 = 99.56.
    expect(ev.trailedStopLoss).toBeCloseTo(99.56, 6);
    expect(ev.trailedStopLoss).toBeLessThan(99.88); // below fee-breakeven for SHORT
    expect(ev.trailedStopLoss).toBeGreaterThan(99.2); // above LTP (SHORT stop is above price)
    expect(ev.preTp1Trail?.applied).toBe(true);
  });

  it('T10d before the arm threshold the initial SL remains the protection', () => {
    const ev = evaluateActiveTradeDeepMonitor(
      dmTrade({ peakPrice: 100.2 }),
      { ltp: 100.05 },
    );
    expect(ev.stageCode).toBe('STAGE_0_INITIAL_GUARD');
    expect(ev.trailedStopLoss).toBe(99);
    expect(ev.preTp1Trail?.armed).toBe(false);

    const hit = evaluateActiveTradeDeepMonitor(dmTrade(), { ltp: 98.9 });
    expect(hit.shouldClose).toBe(true);
    expect(hit.exitReason).toBe('INITIAL_SL_PROTECTIVE_EXIT');
  });

  it('T11 a trail hit books fee-safe profit; a gap-through is labelled honestly', () => {
    // Arm first (persisted stop 100.24 — v21.35.5 progressive floor at 0.6R
    // peak), then price trades through it above fees.
    const hit = evaluateActiveTradeDeepMonitor(
      dmTrade({ peakPrice: 100.6, trailedStopLoss: 100.24, stopLoss: 100.24 }),
      { ltp: 100.18 },
    );
    expect(hit.shouldBookProfitNow).toBe(true);
    expect(hit.exitReason).toBe('TRAILED_SL_PROFIT_BOOKED');

    // Gap below the fee floor: stop did its job but the fill is not fee-safe.
    const gap = evaluateActiveTradeDeepMonitor(
      dmTrade({ peakPrice: 100.6, trailedStopLoss: 100.24, stopLoss: 100.24 }),
      { ltp: 100.05 },
    );
    expect(gap.shouldClose).toBe(true);
    expect(gap.exitReason).toBe('PRE_TP1_TRAIL_FEE_GAP_EXIT');
  });
});

describe('v21.35.5 SUPER TRAIL — progressive profit-lock + ultra-fast adverse gear', () => {
  const b = { ...base };

  it('progressive lock: LOW/NORMAL book early, HIGH/EXTREME ride longer but still book', () => {
    // Below the first shifted threshold → nothing locked yet (0.40-step starts
    // at 0.45R NORMAL / 0.55R HIGH / 0.75R EXTREME).
    expect(progressiveProfitLockR(0.4, 'NORMAL', 'STEADY')).toBe(0);
    // Deterministic steps (NORMAL): 0.45R → 40% of peak, 0.70R → 55%, 1.00R → 70%.
    expect(progressiveProfitLockR(0.6, 'NORMAL', 'STEADY')).toBeCloseTo(0.24, 2);
    expect(progressiveProfitLockR(0.8, 'NORMAL', 'STEADY')).toBeCloseTo(0.44, 2);
    expect(progressiveProfitLockR(1.2, 'NORMAL', 'STEADY')).toBeCloseTo(0.84, 2);
    // HIGH: threshold +0.15, scale 0.75 — 0.8R peak is still below the shifted
    // 0.45-step kick-in (0.60R+... wait 0.45+0.15=0.60 → 40%×0.75 of 0.8R).
    expect(progressiveProfitLockR(0.8, 'HIGH', 'STEADY')).toBeCloseTo(0.24, 2);
    // Same 0.8R peak: HIGH locks strictly less than NORMAL (smooth wide trail
    // still dominant in high vol; floor compounds but doesn't kill the runner).
    expect(progressiveProfitLockR(0.8, 'HIGH', 'STEADY'))
      .toBeLessThan(progressiveProfitLockR(0.8, 'NORMAL', 'STEADY'));
    expect(progressiveProfitLockR(0.8, 'EXTREME', 'STEADY'))
      .toBeLessThan(progressiveProfitLockR(0.8, 'HIGH', 'STEADY'));
    // Monotone in peak: bigger peak → bigger lock, for every class.
    for (const cls of ['LOW', 'NORMAL', 'HIGH', 'EXTREME']) {
      expect(progressiveProfitLockR(1.0, cls, 'STEADY'))
        .toBeLessThanOrEqual(progressiveProfitLockR(1.4, cls, 'STEADY'));
    }
  });

  it('progressive lock: SURGING gives runner space (later), FADING books early', () => {
    expect(progressiveProfitLockR(0.55, 'NORMAL', 'SURGING')).toBe(0); // 0.45+0.15=0.60 kick-in not tripped at 0.55
    // FADING shifts thresholds EARLY: at 0.6R the 0.70-step (kick-in 0.70−0.15=0.55)
    // has already tripped → 0.55×0.6 = 0.33R locked.
    expect(progressiveProfitLockR(0.6, 'NORMAL', 'FADING')).toBeCloseTo(0.33, 2);
    // Same 0.95R peak: FADING books more than STEADY (early-step already
    // tripped the 0.70-step at 0.85R vs STEADY's 1.00R kick-in).
    expect(progressiveProfitLockR(0.95, 'NORMAL', 'FADING'))
      .toBeGreaterThan(progressiveProfitLockR(0.95, 'NORMAL', 'STEADY'));
  });

  it('T12 progressive floor lifts the trail: HIGH-vol 0.9R peak books +0.37R (was +0.30R trail-only pre-upgrade)', () => {
    const out = evaluatePreTp1NoLossTrail({ ...b, volClass: 'HIGH', peakPrice: 100.9, ltp: 100.9 });
    expect(out.armed).toBe(true);
    expect(out.applied).toBe(true);
    // Pre-upgrade: HIGH trail = 0.9−0.60 → +0.30R locked. v21.35.5: at 0.9R
    // HIGH the 0.55-step (kick-in 0.70+0.15=0.85R) locks 0.55×0.75×0.9 = 0.37R —
    // the profit-lock floor is the binding candidate now.
    expect(out.progressiveLockR).toBeCloseTo(0.37, 2);
    expect(out.proposedSl).toBeCloseTo(100.37125, 6);
    expect(out.lockedProfitR).toBe(0.37);
    expect(out.proposedSl).toBeGreaterThan(out.trailSl); // lock floor is binding
    expect(out.proposedSl).toBeGreaterThan(out.noLossSl);
  });

  it('T13 adverse gears tighten the trail; LOW+FADING gear-2 hits the 0.10R floor', () => {
    // LOW class (base giveback 0.30R), STEADY, 1.0R peak: gear-1 =
    // max(0.15, 0.30×0.65) = 0.20R; gear-2 = max(0.10, 0.30×0.40) = 0.12R.
    const steady = evaluatePreTp1NoLossTrail({ ...b, volClass: 'LOW', peakPrice: 101, ltp: 100.95 });
    const g1 = evaluatePreTp1NoLossTrail({
      ...b, volClass: 'LOW', peakPrice: 101, ltp: 100.95, tickTrendPct: -0.02, tickTrendAdverse: true,
    });
    const g2 = evaluatePreTp1NoLossTrail({
      ...b, volClass: 'LOW', peakPrice: 101, ltp: 100.95, tickTrendPct: -0.05, tickTrendAdverse: true,
    });
    expect(steady.adverseGear).toBe(0);
    expect(g1.adverseGear).toBe(1);
    expect(g2.adverseGear).toBe(2);
    expect(steady.givebackR).toBe(0.30);
    expect(g1.givebackR).toBe(0.20);                // max(0.15, 0.30×0.65)
    expect(g2.givebackR).toBe(0.12);                 // max(0.10, 0.30×0.40)
    // Each gear tightens the trail → books MORE (candidate = max of floors,
    // ratchet: gear can never loosen).
    expect(g1.proposedSl).toBeGreaterThanOrEqual(steady.proposedSl);
    expect(g2.proposedSl).toBeGreaterThanOrEqual(g1.proposedSl);
    expect(g2.proposedSl).toBeCloseTo(100.88, 6);    // 101 − 0.12
    // ...and the trail must never sit at/through the live price.
    expect(g2.proposedSl).toBeLessThan(100.95);

    // LOW + FADING: momentum gives back 0.24R base → gear-2 = max(0.10,
    // 0.24×0.40 = 0.096) = 0.10 — the ultra-fast floor is what binds here.
    const g2lowFade = evaluatePreTp1NoLossTrail({
      ...b, volClass: 'LOW', momentumState: 'FADING', peakPrice: 101, ltp: 100.95,
      tickTrendPct: -0.05, tickTrendAdverse: true,
    });
    expect(g2lowFade.adverseGear).toBe(2);
    expect(g2lowFade.givebackR).toBe(0.10);

    // HIGH class: wide base giveback (0.60R) keeps the gear-2 floor
    // non-binding — 0.60×0.40 = 0.24 dominates; the progressive lock (0.41R
    // at a 1.0R peak) is the binding candidate in steady, gears never loosen.
    const highSteady = evaluatePreTp1NoLossTrail({ ...b, volClass: 'HIGH', peakPrice: 101, ltp: 100.95 });
    const highG2 = evaluatePreTp1NoLossTrail({
      ...b, volClass: 'HIGH', peakPrice: 101, ltp: 100.95, tickTrendPct: -0.05, tickTrendAdverse: true,
    });
    expect(highSteady.givebackR).toBe(0.60);
    expect(highG2.adverseGear).toBe(2);
    expect(highG2.givebackR).toBe(0.24); // 0.60×0.40 — base stays above the 0.10 floor
    expect(highG2.progressiveLockR).toBeCloseTo(0.41, 2); // 0.55×0.75×1.0
    expect(highSteady.proposedSl).toBeCloseTo(100.4125, 6); // lock floor binds in steady
    expect(highG2.proposedSl).toBeGreaterThanOrEqual(highSteady.proposedSl); // gear tightens
    expect(highG2.proposedSl).toBeLessThan(100.95);
  });

  it('T14 SHORT mirror: progressive lock + gear-2 tighten downward, never above LTP', () => {
    const shortBase = { ...b, side: 'SHORT', initialStopLoss: 101, currentStopLoss: 101, feeFloor: 99.88 };
    const out = evaluatePreTp1NoLossTrail({ ...shortBase, volClass: 'HIGH', peakPrice: 99.1, ltp: 99.1 });
    // 0.9R SHORT peak at HIGH: progressive lock 0.55×0.75×0.9 = 0.37R → floor
    // 100 − 0.37125 = 99.62875, tighter than the trail (0.36R) and fee floor.
    expect(out.progressiveLockR).toBeCloseTo(0.37, 2);
    expect(out.proposedSl).toBeCloseTo(99.62875, 6);
    expect(out.proposedSl).toBeLessThan(out.trailSl); // floor is the tightest SHORT bound
    expect(out.proposedSl).toBeGreaterThan(99.1);      // never at/through LTP

    const g2 = evaluatePreTp1NoLossTrail({
      ...shortBase, volClass: 'HIGH', peakPrice: 99.1, ltp: 99.2,
      tickTrendPct: -0.05, tickTrendAdverse: true,
    });
    // Adverse tick on a SHORT = price running up fast; gear-2 tightens the
    // giveback (0.24R): trail = 99.1 + 0.24 = 99.34, book more before it turns.
    expect(g2.adverseGear).toBe(2);
    expect(g2.givebackR).toBe(0.24);
    expect(g2.proposedSl).toBeLessThan(out.proposedSl);
    expect(g2.proposedSl).toBeCloseTo(99.34, 6);
    expect(g2.proposedSl).toBeGreaterThan(99.2); // still above LTP (never crosses)

    // Safety: if price has run up past the proposed stop (ltp 99.5 > 99.34),
    // the engine refuses to place an at/through-LTP stop instead of applying it.
    const crossed = evaluatePreTp1NoLossTrail({
      ...shortBase, volClass: 'HIGH', peakPrice: 99.1, ltp: 99.5,
      tickTrendPct: -0.05, tickTrendAdverse: true,
    });
    expect(crossed.adverseGear).toBe(2);
    expect(crossed.reason).toBe('would_cross_ltp');
    expect(crossed.proposedSl).toBeNull();
  });

  it('T16 RUNNER-LOCK: 1.5R/2.0R/3.0R peaks book 80/85/90% of the move (into TP1/TP2)', () => {
    // NORMAL/STEADY — full-scale runner lock:
    expect(progressiveProfitLockR(1.4, 'NORMAL', 'STEADY')).toBeCloseTo(0.98, 2); // 1.0R-step (0.70×1.4) still binding
    expect(progressiveProfitLockR(1.5, 'NORMAL', 'STEADY')).toBeCloseTo(1.2, 2); // 1.5R-step kicks: 0.80×1.5
    expect(progressiveProfitLockR(2.0, 'NORMAL', 'STEADY')).toBeCloseTo(1.7, 2); // 2.0R-step: 0.85×2.0
    expect(progressiveProfitLockR(3.0, 'NORMAL', 'STEADY')).toBeCloseTo(2.7, 2); // 3.0R-step: 0.90×3.0
    // HIGH keeps the lock smooth (×0.75 scale, +0.15R threshold shift):
    // at 3.0R the 2.0R-step (kick-in 2.15R) binds → 0.85×0.75×3 = 1.9125R.
    // The 3.0R-step (kick-in 3.15R) has NOT tripped yet — runner still has
    // room, but the floor compounds instead of stalling.
    expect(progressiveProfitLockR(3.0, 'HIGH', 'STEADY')).toBeCloseTo(1.9125, 3);
    // EXTREME: ×0.50 scale, +0.30R shift → 2.0R-step kick-in 2.30R tripped,
    // 3.0R-step kick-in 3.30R not: 0.85×0.50×3 = 1.275R.
    expect(progressiveProfitLockR(3.0, 'EXTREME', 'STEADY')).toBeCloseTo(1.275, 3);
    // Full evaluate(): LONG runner at 1.5R peak books +1.2R floor (not the
    // 1.5−0.42 = 1.08R giveback trail alone).
    const runner = evaluatePreTp1NoLossTrail({ ...b, volClass: 'NORMAL', peakPrice: 101.5, ltp: 101.5 });
    expect(runner.armed).toBe(true);
    expect(runner.progressiveLockR).toBeCloseTo(1.2, 2);
    expect(runner.proposedSl).toBeCloseTo(101.2, 4);
    expect(runner.proposedSl).toBeGreaterThan(runner.trailSl); // lock floor beats giveback trail
    // SHORT mirror books the same fraction below entry.
    const sRunner = evaluatePreTp1NoLossTrail({
      ...b, side: 'SHORT', initialStopLoss: 101, currentStopLoss: 101,
      feeFloor: 99.88, peakPrice: 98.5, ltp: 98.5,
    });
    expect(sRunner.progressiveLockR).toBeCloseTo(1.2, 2);
    expect(sRunner.proposedSl).toBeCloseTo(100 - 1.2, 4);
    // FADING at 2.0R peaks: early kick-in → even the 2.0R-step books 85%.
    expect(progressiveProfitLockR(2.0, 'NORMAL', 'FADING')).toBeCloseTo(1.7, 2);
  });

  it('T15 compound ratchet: repeated evaluate() calls never loosen the carried stop', () => {
    let carried = b.initialStopLoss;
    const peaks = [100.4, 100.6, 100.9, 101.1, 100.95, 101.2]; // peak can dip, must never back off
    const lows = [100.2, 100.4, 100.7, 100.9, 100.8, 101.0];
    for (let i = 0; i < peaks.length; i++) {
      const out = evaluatePreTp1NoLossTrail({
        ...b, currentStopLoss: carried, peakPrice: peaks[i], ltp: lows[i],
      });
      const next = out.applied ? out.proposedSl : carried;
      expect(next).toBeGreaterThanOrEqual(carried - 1e-12); // strict ratchet (LONG)
      carried = next;
    }
    expect(carried).toBeGreaterThan(100.3); // compounded floor well above entry
    expect(carried).toBeGreaterThan(100.12); // always above the exact fee floor
  });
});

describe('v21.31.0 wiring locks', () => {
  const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

  it('deep monitor + tick agent are wired to the pre-TP1 engine', () => {
    const link = read('server/ai/mtfAutoLink.js');
    expect(link).toContain("from './preTp1Trail.js'");
    expect(link).toContain('STAGE_0B_PRE_TP1_TRAIL');
    expect(link).toContain('tickTrendPct');
    expect(link).toContain('allowSlMove');
    expect(link).toContain('preTp1TrailArmedCount');
    // The 15s sweep may read a ≤120s snapshot: telemetry only, never a move.
    expect(link).toContain('allowSlMove: false');
    expect(link).toContain('allowSlMove: hasFreshQuote');
    const agent = read('server/ai/autoTradeSuperAgent.js');
    expect(agent).toContain('trendPct: vel.trendPct');
    expect(agent).toContain('trendAdverse: vel.trendAdverse');
  });
});
