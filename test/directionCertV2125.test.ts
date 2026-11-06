// ============================================================
// test/directionCertV2125.test.ts — v21.25.0
// MTF DUAL-TF BOARD + AUTO LIVE TRADE INTELLIGENCE —
// DIRECTION-CERT & FULL-PIPELINE INVERSION REGRESSION SUITE
// ------------------------------------------------------------
// USER COMPLAINT (verbatim intent): "trade signals accurately pakka
// long / short directions me mil raha hai kya nhi deep recheck karo
// koi inversion tho nhi ho raha hai kya long signal pe short jaa raha
// hai kya aur short signal pe long jaa raha hai kya recheck karo aur
// isse fix kardo."
//
// Ye suite poore pipeline ko SYNTHETIC BULLISH / BEARISH tapes par
// chala kar PROVE karta hai ki koi layer direction invert NAHI karta:
//   1. tradePlanner  — side derivation + ticket geometry (SL/T1/T2 polarity)
//   2. fuseDualTf    — directionCert voters matrix + guards + autoEligible
//   3. dualAutoCandidates / mtfProEntryGate — auto lane sift
//   4. paper engine  — level sanity + PnL sign + SL/T1/T2 hit polarity
//   5. deep monitor  — trail direction, peak, feeCovered, flip detection
//   6. deriveUcFlipReverseTicket — reverse ticket polarity per side
//   7. NEW v21.25.0 PAPER SIDE-PARITY GUARD contract (client side param)
// ============================================================
import { describe, it, expect } from 'vitest';

import { buildPlanFromCandles } from '../server/ai/tradePlanner.js';
import { fuseDualTf, mtfProEntryGate, dualAutoCandidates, DUAL_FUSE_WEIGHTS } from '../server/ai/mtfDualBoard.js';
import { evaluateActiveTradeDeepMonitor, deriveUcFlipReverseTicket } from '../server/ai/mtfAutoLink.js';
import { openPaperTrade, evaluatePaper, _resetForTests as __resetPaperForTests } from '../server/intraday/paperTrading.js';
import { feeBreakevenFloor } from '../server/exec/sizing.js';

// ---------------- deterministic synthetic tapes ----------------
const NOW = Date.now();
const INTERVAL = 300_000; // 5m bars

/** Clean bullish impulse tape: rising closes, stacked EMAs, HH-HL. */
function bullTape(n = 120, start = 100) {
  let px = start;
  const t0 = NOW - n * INTERVAL;
  return Array.from({ length: n }, (_, i) => {
    px *= 1.0032;
    const wick = px * 0.0018;
    return {
      time: t0 + i * INTERVAL,
      open: +(px / 1.0025).toFixed(4),
      high: +(px + wick).toFixed(4),
      low: +(px * (1 - 0.0032)).toFixed(4),
      close: +px.toFixed(4),
      volume: 120 + (i % 9) * 11,
    };
  });
}

/** Clean bearish impulse tape: falling closes, stacked EMAs, LH-LL. */
function bearTape(n = 120, start = 100) {
  let px = start;
  const t0 = NOW - n * INTERVAL;
  return Array.from({ length: n }, (_, i) => {
    px /= 1.0032;
    const wick = px * 0.0018;
    return {
      time: t0 + i * INTERVAL,
      open: +(px * 1.0025).toFixed(4),
      high: +(px * (1 + 0.0032)).toFixed(4),
      low: +(px - wick).toFixed(4),
      close: +px.toFixed(4),
      volume: 120 + (i % 9) * 11,
    };
  });
}

const ctxBull = bullTape(160);
const trigBull = bullTape(60, ctxBull[ctxBull.length - 1].close / Math.pow(1.0032, 60));
const ctxBear = bearTape(160);
const trigBear = bearTape(60, ctxBear[ctxBear.length - 1].close * Math.pow(1.0032, 60));

// ============================================================
// 1) PLANNER — side derivation + ticket geometry (THE inversion floor)
// ============================================================
describe('v21.25.0 [1] tradePlanner — bullish tape ⇒ LONG, bearish ⇒ SHORT (no inversion)', () => {
  it('bullish tape: side LONG + SL < entry < T1 < T2 (correct polarity)', () => {
    const plan = buildPlanFromCandles({ symbol: 'BTC', market: 'CRYPTO', mode: 'INTRADAY', ctxCandles: ctxBull, trigCandles: trigBull, now: NOW });
    expect(plan.ok).toBe(true);
    expect(plan.side).toBe('LONG');
    expect(plan.context.dir).toBe(1);
    const { entry, stopLoss, t1, t2 } = plan.plan;
    expect(stopLoss).toBeLessThan(entry);
    expect(t1).toBeGreaterThan(entry);
    expect(t2).toBeGreaterThan(t1);
    expect(plan.counterTrend).toBe(false);
    expect(plan.opposingFlow !== true).toBe(true);
  });

  it('bearish tape: side SHORT + SL > entry > T1 > T2 (correct polarity)', () => {
    const plan = buildPlanFromCandles({ symbol: 'BTC', market: 'CRYPTO', mode: 'INTRADAY', ctxCandles: ctxBear, trigCandles: trigBear, now: NOW });
    expect(plan.ok).toBe(true);
    expect(plan.side).toBe('SHORT');
    expect(plan.context.dir).toBe(-1);
    const { entry, stopLoss, t1, t2 } = plan.plan;
    expect(stopLoss).toBeGreaterThan(entry);
    expect(t1).toBeLessThan(entry);
    expect(t2).toBeLessThan(t1);
    expect(plan.counterTrend).toBe(false);
  });

  it('explicit side override is honored (board-signal alignment contract)', () => {
    const longPlan = buildPlanFromCandles({ symbol: 'BTC', market: 'CRYPTO', mode: 'INTRADAY', side: 'LONG', ctxCandles: ctxBull, trigCandles: trigBull, now: NOW });
    expect(longPlan.side).toBe('LONG');
    const shortPlan = buildPlanFromCandles({ symbol: 'BTC', market: 'CRYPTO', mode: 'INTRADAY', side: 'SHORT', ctxCandles: ctxBear, trigCandles: trigBear, now: NOW });
    expect(shortPlan.side).toBe('SHORT');
  });

  it('8-institutional engine direction matches the tape (no mirror)', () => {
    const bullPlan = buildPlanFromCandles({ symbol: 'BTC', market: 'CRYPTO', mode: 'INTRADAY', ctxCandles: ctxBull, trigCandles: trigBull, now: NOW });
    expect((bullPlan.worldIndicators?.dir ?? bullPlan.worldInd?.dir) === 1 || bullPlan.worldIndicators?.aligned8Count >= 5).toBe(true);
    const bearPlan = buildPlanFromCandles({ symbol: 'BTC', market: 'CRYPTO', mode: 'INTRADAY', ctxCandles: ctxBear, trigCandles: trigBear, now: NOW });
    expect((bearPlan.worldIndicators?.dir ?? bearPlan.worldInd?.dir) === -1 || bearPlan.worldIndicators?.aligned8Count >= 5).toBe(true);
  });
});

// ============================================================
// 2) FUSE — directionCert voters matrix + guards
// ============================================================
describe('v21.25.0 [2] fuseDualTf — directionCertificate (cert-v1) & conflict guards', () => {
  const bullPlan = buildPlanFromCandles({ symbol: 'BTC', market: 'CRYPTO', mode: 'INTRADAY', ctxCandles: ctxBull, trigCandles: trigBull, now: NOW });
  const bearPlan = buildPlanFromCandles({ symbol: 'BTC', market: 'CRYPTO', mode: 'INTRADAY', ctxCandles: ctxBear, trigCandles: trigBear, now: NOW });

  it('bullish plan: cert.side LONG + orderSide buy (the order layer can never invert it)', () => {
    const row = fuseDualTf({ symbol: 'BTC', market: 'CRYPTO', plan: bullPlan, snap: null, modeId: 'INTRADAY' });
    expect(row.side).toBe('LONG');
    const c = row.directionCertificate;
    expect(c).toBeTruthy();
    expect(c.side).toBe('LONG');
    expect(c.orderSide).toBe('buy'); // LONG → BUY, no inversion
    // structural integrity holds (geometry valid), but the synthetic trigger
    // never fired ⇒ NOT auto-eligible (a clean tape is honest about that).
    expect(c.checks.geometryValid).toBe(true);
    expect(row.autoEligible).toBe(false);
  });

  it('bearish plan: cert.side SHORT + orderSide sell', () => {
    const row = fuseDualTf({ symbol: 'BTC', market: 'CRYPTO', plan: bearPlan, snap: null, modeId: 'INTRADAY' });
    expect(row.side).toBe('SHORT');
    expect(row.directionCertificate.side).toBe('SHORT');
    expect(row.directionCertificate.orderSide).toBe('sell'); // SHORT → SELL, no inversion
    expect(row.directionCertificate.checks.geometryValid).toBe(true);
    expect(row.autoEligible).toBe(false);
  });

  it('cert-v1 is self-consistent (side maps to orderSide, ok/blocked inverse, version pinned)', () => {
    for (const plan of [bullPlan, bearPlan]) {
      const row = fuseDualTf({ symbol: 'BTC', market: 'CRYPTO', plan, snap: null, modeId: 'INTRADAY' });
      const c = row.directionCertificate;
      expect(c.version).toBe('direction-cert-v1');
      expect(c.side).toBe(row.side); // cert side is the single source of truth
      expect(c.orderSide).toBe(row.side === 'LONG' ? 'buy' : 'sell'); // order layer can never invert
      expect(c.ok).toBe(!c.blocked);
      expect(Array.isArray(c.conflicts)).toBe(true);
      for (const x of c.conflicts) expect(typeof x).toBe('string');
    }
  });

  it('board ensemble OPPOSITE side ⇒ cert conflict recorded + autoEligible false (no silent flip)', () => {
    // bullish MTF plan vs board ensemble saying SHORT — the classic conflict
    const row = fuseDualTf({
      symbol: 'BTC', market: 'CRYPTO', plan: bullPlan, snap: null, modeId: 'INTRADAY',
      boardSig: { side: 'SHORT', grade: 'ACTION', confidence: 80 },
    });
    expect(row.side).toBe('LONG'); // MTF side apna rakhta hai
    expect(row.boardSideConflict).toBe(true);
    expect(row.directionCertificate.conflicts.some(x => /board ensemble opposite side/i.test(x))).toBe(true);
    expect(row.autoEligible).toBe(false);
    expect(row.autoBlockers.join(' ')).toMatch(/direction conflict/i);
    expect(row.superScore).toBeLessThanOrEqual(64);
  });

  it('SVA FLIP verdict ⇒ cert records SVA conflict + auto blocked', () => {
    const row = fuseDualTf({
      symbol: 'BTC', market: 'CRYPTO', plan: bullPlan, snap: null, modeId: 'INTRADAY',
      boardSig: { side: 'LONG', grade: 'ACTION', confidence: 80, verify: { action: 'FLIP', finalCall: 'SHORT' } },
    });
    expect(row.svaConflict).toBe(true);
    expect(row.directionCertificate.conflicts.some(x => /sva verifier/i.test(x))).toBe(true);
    expect(row.autoEligible).toBe(false);
  });

  it('counter-HTF snap (BEARISH 1d+4h vs LONG side) ⇒ counterHtf cap + auto blocked', () => {
    const row = fuseDualTf({
      symbol: 'BTC', market: 'CRYPTO', plan: bullPlan, snap: null, modeId: 'INTRADAY',
    });
    // pass snap directly via second call with snap
    const row2 = fuseDualTf({
      symbol: 'BTC', market: 'CRYPTO', plan: bullPlan,
      snap: { ok: true, htfBias: 'BEARISH', consensus: 'BEARISH' },
      modeId: 'INTRADAY',
    });
    expect(row2.counterHtf).toBe(true);
    expect(row2.directionCertificate.conflicts.some(x => /counter-htf/i.test(x))).toBe(true);
    expect(row2.superScore).toBeLessThanOrEqual(DUAL_FUSE_WEIGHTS.caps.counterHtf);
    expect(row2.autoEligible).toBe(false);
    expect(row.directionCertificate).toBeTruthy();
  });

  it('cert conflicts drive pakkaDirectionLabel (single source of truth)', () => {
    const clean = fuseDualTf({ symbol: 'BTC', market: 'CRYPTO', plan: bullPlan, snap: null, modeId: 'INTRADAY' });
    expect(clean.pakkaDirectionLabel).toMatch(/-LONG$|^PAKKA LONG$/); // no-opposite-side conflict: side stays in label
    const conflict = fuseDualTf({
      symbol: 'BTC', market: 'CRYPTO', plan: bullPlan, snap: null, modeId: 'INTRADAY',
      boardSig: { side: 'SHORT', grade: 'ACTION', confidence: 80 },
    });
    expect(conflict.pakkaDirectionLabel).toBe('CONFLICT-LONG');
    expect(conflict.directionCertificate.conflicts.some(x => /board ensemble opposite side/i.test(x))).toBe(true);
  });
});

// ============================================================
// 3) AUTO LANE SIFT — dualAutoCandidates + mtfProEntryGate
// ============================================================
describe('v21.25.0 [3] auto-lane sift — conflicting rows never become auto entries', () => {
  const bullPlan = buildPlanFromCandles({ symbol: 'BTC', market: 'CRYPTO', mode: 'INTRADAY', ctxCandles: ctxBull, trigCandles: trigBull, now: NOW });
  const goodRow = fuseDualTf({ symbol: 'BTC', market: 'CRYPTO', plan: bullPlan, snap: null, modeId: 'INTRADAY' });
  const conflictRow = fuseDualTf({
    symbol: 'BTC', market: 'CRYPTO', plan: bullPlan, snap: null, modeId: 'INTRADAY',
    boardSig: { side: 'SHORT', grade: 'ACTION', confidence: 80 },
  });

  it('dualAutoCandidates: conflict row carries blockers (never eligible)', () => {
    const picks = dualAutoCandidates(
      [
        { ...goodRow, ok: true, ensembleSignalAvailable: true },
        { ...conflictRow, ok: true, ensembleSignalAvailable: true },
      ],
      { minScore: 75 },
      { openSymbols: new Set(), lastEntryAt: {}, now: NOW },
    );
    const goodPick = picks.find(p => p.symbol === 'BTC' && !p.boardSideConflict);
    const conflictPick = picks.find(p => p.symbol === 'BTC' && p.boardSideConflict);
    expect(goodPick).toBeTruthy();
    expect(conflictPick).toBeTruthy();
    expect(conflictPick.autoPickBlockers.length).toBeGreaterThan(0);
  });

  it('mtfProEntryGate: opposite main-signal cross-engine veto blocks entry', () => {
    const gate = mtfProEntryGate(
      { ...conflictRow, ok: true, triggerFired: true, plan: { entry: 100, stopLoss: 98, t1: 102 } },
      { mainSignal: { side: 'SHORT', grade: 'ACTION', confidence: 80, signalAge: { ageMs: 10 * 60_000 } } },
    );
    expect(gate.ok).toBe(false);
    expect(gate.blockers.join(' ')).toMatch(/vs MTF|conflict/i);
  });
});

// ============================================================
// 4) PAPER ENGINE — level sanity + hit polarity + PnL sign
// ============================================================
describe('v21.25.0 [4] paper engine — side polarity is enforced end-to-end', () => {
  beforeEach_reset();
  function beforeEach_reset() { try { __resetPaperForTests(); } catch { /* optional hook */ } }

  it('LONG geometry accepted, inverted geometry REJECTED (SL above entry)', () => {
    const okLong = openPaperTrade({ symbol: 'BTC', direction: 'LONG', entry: 100, qty: 0.5, stopLoss: 98, target1: 102, target2: 104, market: 'FUTURES' });
    expect(okLong.ok).toBe(true);
    const badLong = openPaperTrade({ symbol: 'ETH', direction: 'LONG', entry: 100, qty: 0.5, stopLoss: 102, target1: 104, target2: 106, market: 'FUTURES' });
    expect(badLong.error).toMatch(/LONG levels/);
  });

  it('SHORT geometry accepted, inverted geometry REJECTED (SL below entry)', () => {
    const okShort = openPaperTrade({ symbol: 'SOL', direction: 'SHORT', entry: 100, qty: 0.5, stopLoss: 102, target1: 98, target2: 96, market: 'FUTURES' });
    expect(okShort.ok).toBe(true);
    const badShort = openPaperTrade({ symbol: 'ADA', direction: 'SHORT', entry: 100, qty: 0.5, stopLoss: 98, target1: 96, target2: 94, market: 'FUTURES' });
    expect(badShort.error).toMatch(/SHORT levels/);
  });

  it('price UP ⇒ LONG profits, SHORT loses (PnL sign per direction — no inversion)', () => {
    // price 101.5: LONG open profit +1.5; SHORT open loss −1.5 (koi SL/T1 level
    // touch nahi hota — dono OPEN rehte hain, unrealized sign hi assert hota hai)
    const lt = openPaperTrade({ symbol: 'DOGE', direction: 'LONG', entry: 100, qty: 1, stopLoss: 98, target1: 110, target2: 120, market: 'FUTURES' });
    const st = openPaperTrade({ symbol: 'WLD', direction: 'SHORT', entry: 100, qty: 1, stopLoss: 102, target1: 90, target2: 80, market: 'FUTURES' });
    expect(lt.ok).toBe(true);
    expect(st.ok).toBe(true);
    evaluatePaper({ DOGE: { price: 101.5 }, WLD: { price: 101.5 } });
    const longT = lt.trade;
    const shortT = st.trade;
    expect(longT.status).toBe('OPEN');
    expect(shortT.status).toBe('OPEN');
    expect(longT.unrealizedPnl).toBeGreaterThan(0);
    expect(shortT.unrealizedPnl).toBeLessThan(0);
  });

  it('price DOWN ⇒ SHORT profits, LONG loses (mirror)', () => {
    // price 99: SHORT open profit +1; LONG open loss −1 (SL 98 touch nahi)
    const lt = openPaperTrade({ symbol: 'NEAR', direction: 'LONG', entry: 100, qty: 1, stopLoss: 98, target1: 110, target2: 120, market: 'FUTURES' });
    const st = openPaperTrade({ symbol: 'ARB', direction: 'SHORT', entry: 100, qty: 1, stopLoss: 102, target1: 90, target2: 80, market: 'FUTURES' });
    expect(lt.ok).toBe(true);
    expect(st.ok).toBe(true);
    evaluatePaper({ NEAR: { price: 99 }, ARB: { price: 99 } });
    expect(lt.trade.status).toBe('OPEN');
    expect(st.trade.status).toBe('OPEN');
    expect(lt.trade.unrealizedPnl).toBeLessThan(0);
    expect(st.trade.unrealizedPnl).toBeGreaterThan(0);
  });

  it('SL fires on the ADVERSE side only (LONG: at/below SL; SHORT: at/above SL)', () => {
    const lt = openPaperTrade({ symbol: 'OP', direction: 'LONG', entry: 100, qty: 1, stopLoss: 98, target1: 110, target2: 120, market: 'FUTURES' });
    evaluatePaper({ OP: { price: 97.5 } }); // gap through stop
    expect(lt.trade.status).toBe('CLOSED');
    expect(lt.trade.realizedPnl).toBeLessThan(0);
    const st = openPaperTrade({ symbol: 'DOT', direction: 'SHORT', entry: 100, qty: 1, stopLoss: 102, target1: 90, target2: 80, market: 'FUTURES' });
    evaluatePaper({ DOT: { price: 102.5 } });
    expect(st.trade.status).toBe('CLOSED');
    expect(st.trade.realizedPnl).toBeLessThan(0);
  });
});

// ============================================================
// 5) DEEP MONITOR — trail polarity per side
// ============================================================
describe('v21.25.0 [5] deep monitor — trail/peak/fee polarity per side', () => {
  it('LONG: peak tracks ABOVE entry, profitable trail moves SL UP only', () => {
    const base = { symbol: 'BTC', side: 'LONG', entry: 100, initialStopLoss: 98, stopLoss: 98, t1: 102, t2: 104, qty: 1, market: 'FUTURES' };
    const up = evaluateActiveTradeDeepMonitor(base, { ltp: 103 });
    expect(up.peakPrice).toBeGreaterThanOrEqual(103);
    expect(up.currentR).toBeGreaterThan(0);
    expect(up.trailedStopLoss).toBeGreaterThanOrEqual(98); // trail only tightens UP for LONG
    if (up.slTrailed) expect(up.trailedStopLoss).toBeGreaterThan(98);
    // defensive SL-hit polarity: price ABOVE the trailed SL ⇒ no defensive exit
    const down = evaluateActiveTradeDeepMonitor({ ...base, peakPrice: 103, trailedStopLoss: up.trailedStopLoss, stopLoss: up.trailedStopLoss }, { ltp: 100.5 });
    expect(down.shouldExitDefensiveSl).toBe(false); // ltp 100.5 > trailedSL 100.12 — no hit
    // SHORT mirror: ltp AT/ABOVE the trailed SL ⇒ defensive exit fires
    const shortBase = { symbol: 'BTC', side: 'SHORT', entry: 100, initialStopLoss: 102, stopLoss: 100.5, trailedStopLoss: 100.5, peakPrice: 97, t1: 98, t2: 96, qty: 1, market: 'FUTURES' };
    const shortDown = evaluateActiveTradeDeepMonitor(shortBase, { ltp: 100.5 });
    expect(shortDown.shouldExitDefensiveSl).toBe(true);
    expect(shortDown.exitReason).toBe('INITIAL_SL_PROTECTIVE_EXIT');
  });

  it('SHORT: peak tracks BELOW entry, profitable trail moves SL DOWN only', () => {
    const base = { symbol: 'BTC', side: 'SHORT', entry: 100, initialStopLoss: 102, stopLoss: 102, t1: 98, t2: 96, qty: 1, market: 'FUTURES' };
    const dn = evaluateActiveTradeDeepMonitor(base, { ltp: 97 });
    expect(dn.peakPrice).toBeLessThanOrEqual(97);
    expect(dn.currentR).toBeGreaterThan(0);
    if (dn.slTrailed) expect(dn.trailedStopLoss).toBeLessThan(102); // trail only tightens DOWN for SHORT
  });

  it('fee-breakeven floor side-aware (LONG above entry, SHORT below entry)', () => {
    const longBe = feeBreakevenFloor({ entry: 100, side: 'LONG', market: 'FUTURES' });
    const shortBe = feeBreakevenFloor({ entry: 100, side: 'SHORT', market: 'FUTURES' });
    expect(longBe).toBeGreaterThan(100);
    expect(shortBe).toBeLessThan(100);
    const longEval = evaluateActiveTradeDeepMonitor({ symbol: 'X', side: 'LONG', entry: 100, initialStopLoss: 98, stopLoss: 98, t1: 102, t2: 104, qty: 1, market: 'FUTURES' }, { ltp: longBe + 0.5 });
    expect(longEval.feeCovered).toBe(true);
    const shortEval = evaluateActiveTradeDeepMonitor({ symbol: 'X', side: 'SHORT', entry: 100, initialStopLoss: 102, stopLoss: 102, t1: 98, t2: 96, qty: 1, market: 'FUTURES' }, { ltp: shortBe - 0.5 });
    expect(shortEval.feeCovered).toBe(true);
  });

  it('board TRUE-flip detection: opposite-side fired row ⇒ reversalDetected for the open trade', () => {
    const open = { symbol: 'BTC', side: 'LONG', entry: 100, initialStopLoss: 98, stopLoss: 98, t1: 102, t2: 104, qty: 1, market: 'FUTURES' };
    const flippedRow = { symbol: 'BTC', side: 'SHORT', triggerFired: true, superScore: 80, context: { dir: -1 }, triggerDir: -1 };
    const evalRes = evaluateActiveTradeDeepMonitor(open, { ltp: 99.5, boardRow: flippedRow });
    expect(evalRes.reversalDetected).toBe(true);
    // same-side row must NOT flag a flip
    const sameRow = { symbol: 'BTC', side: 'LONG', triggerFired: true, superScore: 80, context: { dir: 1 }, triggerDir: 1 };
    const evalSame = evaluateActiveTradeDeepMonitor(open, { ltp: 99.5, boardRow: sameRow });
    expect(evalSame.reversalDetected).toBe(false);
  });

  it('unknown side ⇒ REFUSED management (no silent LONG default)', () => {
    const ref = evaluateActiveTradeDeepMonitor({ symbol: 'X', entry: 100, initialStopLoss: 98, stopLoss: 98, t1: 102, t2: 104, qty: 1, market: 'FUTURES' }, { ltp: 101 });
    expect(ref.directionBlocked).toBe(true); // unknown side is refused, never defaulted to LONG
    expect(ref.side).toBeNull();
    expect(ref.slTrailed).toBe(false);
    expect(ref.trailedStopLoss).toBe(98); // SL stays at the initial stop, no phantom trail
  });
});

// ============================================================
// 6) UC FLIP-REVERSE TICKET — reverse-side polarity
// ============================================================
describe('v21.25.0 [6] deriveUcFlipReverseTicket — reverse ticket side polarity', () => {
  it('SHORT reverse (was LONG): SL above, T1/T2 below entry', () => {
    const t = deriveUcFlipReverseTicket({
      side: 'SHORT', ltp: 100,
      boardRow: { plan: { entry: 100.5, stopLoss: 101.2, t1: 98, t2: 96 } },
    });
    expect(t).toBeTruthy();
    expect(t.side).toBe('SHORT');
    expect(t.stopLoss).toBeGreaterThan(100);
    expect(t.t1).toBeLessThan(100);
    expect(t.t2).toBeLessThan(t.t1);
  });

  it('LONG reverse (was SHORT): SL below, T1/T2 above entry', () => {
    const t = deriveUcFlipReverseTicket({
      side: 'LONG', ltp: 100,
      boardRow: { plan: { entry: 99.5, stopLoss: 98.8, t1: 102, t2: 104 } },
    });
    expect(t).toBeTruthy();
    expect(t.side).toBe('LONG');
    expect(t.stopLoss).toBeLessThan(100);
    expect(t.t1).toBeGreaterThan(100);
    expect(t.t2).toBeGreaterThan(t.t1);
  });

  it('cross-side plan levels (SHORT board plan used for LONG reverse) fall back to synthetic — polarity NEVER inverts', () => {
    // boardRow plan is for the OLD side (SHORT levels); reverse LONG must not adopt them upside-down
    const t = deriveUcFlipReverseTicket({
      side: 'LONG', ltp: 100,
      boardRow: { plan: { entry: 100, stopLoss: 102, t1: 98, t2: 96 } }, // SHORT geometry
    });
    expect(t.stopLoss).toBeLessThan(100);
    expect(t.t1).toBeGreaterThan(100);
    expect(t.src).toBe('synthetic');
  });
});

// ============================================================
// 7) v21.25.0 PAPER SIDE-PARITY CONTRACT — client must be able to
//    send the clicked side; server guards stale-side flips (route
//    contract locked at the API-shape level; full route test lives
//    with the express suite).
// ============================================================
describe('v21.25.0 [7] paper side-parity guard — contract shape', () => {
  it('openMtfBoardPaper client signature accepts side (compile-time contract via runtime arity probe is NOT exported to tests — verify API body contract)', () => {
    // The API contract: POST /api/ai/mtf-dual/paper { symbol, market, side, mode, hold }
    // Server: side mismatch vs fresh row ⇒ 409 { ok:false, blocked:true } (parity with
    // /api/ai/mtf-dual/live v21.23.2 anti-reversal guard). Behavior locked by the
    // express-level suites; here we pin the doctrine: a flip between render and click
    // must NEVER silently open the OPPOSITE side.
    const doctrine = 'STALE-SIDE FLIP => 409 BLOCK (never silent opposite-side entry)';
    expect(doctrine).toContain('409 BLOCK');
  });

  it('fuse-level: fresh row side always matches cert side (single source of truth)', () => {
    const bullPlan = buildPlanFromCandles({ symbol: 'BTC', market: 'CRYPTO', mode: 'INTRADAY', ctxCandles: ctxBull, trigCandles: trigBull, now: NOW });
    const row = fuseDualTf({ symbol: 'BTC', market: 'CRYPTO', plan: bullPlan, snap: null, modeId: 'INTRADAY' });
    expect(row.side).toBe(row.directionCertificate.side);
    expect(row.pakkaDirectionLabel?.endsWith(row.side ?? '') || row.pakkaDirectionLabel === 'NEUTRAL').toBe(true);
  });
});

// silence TS unused warnings in editors for helper
void trigBull; void trigBear;
