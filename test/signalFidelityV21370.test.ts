// ============================================================
// test/signalFidelityV21370.test.ts — v21.37.0 SIGNAL FIDELITY + LOSS-CHURN
// ------------------------------------------------------------
// Evidence basis: 178 live-ish resolved MTF ledger rows (2.8 days) —
// directionVerified + superScore >= 75 + signalAtOpenBar.triggerFired.
//   • fidelity pass set: 62% win, avgR +0.18 (all: 44%, +0.02)
//   • CHOP/TRANSITION, familyFit=would-block, RSI dead-zone/exhaustion and
//     overextended late waves were the loss buckets.
//   • The book showed repeated same-price XAU/XAG same-side entries minutes
//     after a non-profit close — the loss-churn lock.
//
// This suite pins the PURE rules and the tick wiring (scope live vs all).
// ============================================================
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mtf-fidelity-21370-'));
process.env.MTF_AUTO_DATA_DIR = TMP_DATA;

import { mtfAutoTick, mtfAutoStatus, __resetMtfAutoForTests } from '../server/ai/mtfAutoLink.js';
import { __resetDirectionLocksForTests } from '../server/ai/directionLock.js';
import {
  evaluateSignalFidelity, evaluateLossChurnLock,
  classifyCloseOutcome, isNonProfitClose, rsiZoneOf,
} from '../server/ai/signalFidelity.js';

vi.mock('../server/mcp/durable.js', () => ({ durablePut: vi.fn() }));

const NOW = 1_765_000_000_000;
const MIN = 60_000;

// ------------------------------------------------------------
// Pure fidelity
// ------------------------------------------------------------
const cleanLong = (over = {}) => ({
  symbol: 'BTC', side: 'LONG', superScore: 82, regime: 'TREND_UP',
  context: { regime: 'TREND_UP', adx: 25, rsi: 60, dir: 1 },
  trigger: { rsi: 60, dir: 1, pullbackReclaim: true },
  barConfirmation: { stable: true },
  ...over,
});

describe('v21.37.0 — signal fidelity (pure)', () => {
  it('clean trend + momentum + stable bar passes', () => {
    const r = evaluateSignalFidelity({ row: cleanLong(), side: 'LONG' });
    expect(r.wouldBlock).toBe(false);
    expect(r.blocked).toBe(false);
    expect(r.softPoints).toBeGreaterThanOrEqual(3);
    expect(r.reasons).toEqual([]);
  });

  it('CHOP regime is a hard veto', () => {
    const r = evaluateSignalFidelity({
      row: cleanLong({ regime: 'CHOP', context: { regime: 'CHOP', adx: 12, dir: 1 } }),
      side: 'LONG',
    });
    expect(r.wouldBlock).toBe(true);
    expect(r.hardReasons.join(' ')).toMatch(/CHOP regime/);
  });

  it('TRANSITION regime is a hard veto', () => {
    const r = evaluateSignalFidelity({
      row: cleanLong({ regime: 'TRANSITION', context: { regime: 'TRANSITION', adx: 22, dir: 1 } }),
      side: 'LONG',
    });
    expect(r.wouldBlock).toBe(true);
    expect(r.hardReasons.join(' ')).toMatch(/TRANSITION regime/);
  });

  it('familyFit would-block is a hard veto', () => {
    const r = evaluateSignalFidelity({
      row: cleanLong(), side: 'LONG',
      familyFit: { family: 'MEAN_REVERSION', wouldBlock: true, reason: 'TREND_UP not in MEAN_REVERSION valid regimes' },
    });
    expect(r.wouldBlock).toBe(true);
    expect(r.hardReasons.join(' ')).toMatch(/family MEAN_REVERSION unfit/);
  });

  it('hierarchical HTF veto is a hard veto', () => {
    const r = evaluateSignalFidelity({
      row: cleanLong(), side: 'LONG',
      hierarchicalMtf: { wouldBlock: true, reason: 'HTF BEARISH against LONG', layers: [] },
    });
    expect(r.wouldBlock).toBe(true);
    expect(r.hardReasons.join(' ')).toMatch(/hierarchical HTF veto/);
  });

  it('LONG RSI dead zone (<55) and overbought (>75) are hard vetoes; 55–75 passes', () => {
    expect(evaluateSignalFidelity({ row: cleanLong({ trigger: { rsi: 48, pullbackReclaim: true } }), side: 'LONG' }).hardReasons.join(' ')).toMatch(/dead zone/);
    expect(evaluateSignalFidelity({ row: cleanLong({ trigger: { rsi: 81, pullbackReclaim: true } }), side: 'LONG' }).hardReasons.join(' ')).toMatch(/overbought/);
    expect(evaluateSignalFidelity({ row: cleanLong({ trigger: { rsi: 62, pullbackReclaim: true } }), side: 'LONG' }).wouldBlock).toBe(false);
  });

  it('SHORT RSI oversold (<25) and dead zone (>45) are hard vetoes; 25–45 passes', () => {
    const shortRow = (rsi) => cleanLong({
      side: 'SHORT', regime: 'TREND_DOWN',
      context: { regime: 'TREND_DOWN', adx: 25, rsi, dir: -1 },
      trigger: { rsi, dir: -1, pullbackReclaim: true },
    });
    expect(evaluateSignalFidelity({ row: shortRow(20), side: 'SHORT' }).hardReasons.join(' ')).toMatch(/oversold/);
    expect(evaluateSignalFidelity({ row: shortRow(52), side: 'SHORT' }).hardReasons.join(' ')).toMatch(/dead zone/);
    expect(evaluateSignalFidelity({ row: shortRow(38), side: 'SHORT' }).wouldBlock).toBe(false);
  });

  it('missing RSI/ADX/stability fails OPEN (no fabricated block)', () => {
    const r = evaluateSignalFidelity({
      row: {
        symbol: 'BTC', side: 'LONG', regime: 'TREND_UP', superScore: 80,
        context: { regime: 'TREND_UP', dir: 1 }, trigger: { dir: 1 },
      },
      side: 'LONG',
    });
    expect(r.rsi).toBeNull();
    expect(r.adx).toBeNull();
    expect(r.stable).toBeNull();
    expect(r.availableSoft).toBe(0);
    expect(r.wouldBlock).toBe(false);
  });

  it('soft evidence below minSoft blocks (unstable + weak ADX + no pullback + low HTF agreement)', () => {
    const r = evaluateSignalFidelity({
      row: cleanLong({
        trigger: { rsi: 60, pullbackReclaim: false },
        barConfirmation: { stable: false },
        context: { regime: 'TREND_UP', adx: 15, dir: 1 },
      }),
      side: 'LONG',
      hierarchicalMtf: {
        agreement: 0.2, layers: [{ layer: 'HTF', available: true, sign: 1 }],
      },
    });
    expect(r.softPoints).toBe(0);
    expect(r.availableSoft).toBe(4);
    expect(r.wouldBlock).toBe(true);
    expect(r.reasons.join(' ')).toMatch(/soft confirmations/);
  });

  it('shadow mode reports wouldBlock but never blocks; off is inactive', () => {
    const row = cleanLong({ regime: 'CHOP', context: { regime: 'CHOP', adx: 12, dir: 1 } });
    const shadow = evaluateSignalFidelity({ row, side: 'LONG', mode: 'shadow' });
    expect(shadow.wouldBlock).toBe(true);
    expect(shadow.blocked).toBe(false);
    expect(shadow.shadow).toBe(true);
    const off = evaluateSignalFidelity({ row, side: 'LONG', mode: 'off' });
    expect(off.active).toBe(false);
    expect(off.blocked).toBe(false);
  });

  it('overextended / reversal-risk / trap hints stay hard even for a clean trend row', () => {
    expect(evaluateSignalFidelity({
      row: cleanLong({ trigger: { rsi: 60, pullbackReclaim: true, overextended: true } }), side: 'LONG',
    }).hardReasons.join(' ')).toMatch(/overextended/);
    expect(evaluateSignalFidelity({
      row: cleanLong({ trigger: { rsi: 60, pullbackReclaim: true, reversalRisk: true } }), side: 'LONG',
    }).hardReasons.join(' ')).toMatch(/reversal risk/);
    expect(evaluateSignalFidelity({
      row: cleanLong({ trapVeto: true }), side: 'LONG',
    }).hardReasons.join(' ')).toMatch(/trap veto/);
  });

  it('rsiZoneOf is side-relative', () => {
    expect(rsiZoneOf('LONG', 80).zone).toBe('overbought');
    expect(rsiZoneOf('LONG', 50).zone).toBe('dead-zone');
    expect(rsiZoneOf('LONG', 65).aligned).toBe(true);
    expect(rsiZoneOf('SHORT', 20).zone).toBe('oversold');
    expect(rsiZoneOf('SHORT', 50).zone).toBe('dead-zone');
    expect(rsiZoneOf('SHORT', 35).aligned).toBe(true);
  });
});

// ------------------------------------------------------------
// Pure close-outcome + loss-churn lock
// ------------------------------------------------------------
const closedRow = (over = {}) => ({
  symbol: 'XAU', side: 'SHORT', status: 'CLOSED',
  closedAt: NOW - 5 * MIN, pnl: -1,
  closeReason: 'UC_FLIP_MINIMAL_LOSS_EXIT', openedBy: 'AUTO',
  ...over,
});
const CHURN_CFG = {
  lossChurnCooldownMin: 20, lossChurnWindowMin: 120,
  lossChurnStreak: 2, lossChurnStreakLockMin: 60,
};

describe('v21.37.0 — loss-churn lock (pure)', () => {
  it('classifies profit / loss / neutral / unknown honestly', () => {
    expect(classifyCloseOutcome({ pnl: 1.2 })).toBe('profit');
    expect(classifyCloseOutcome({ pnl: -1.2 })).toBe('loss');
    expect(classifyCloseOutcome({ pnl: 0 })).toBe('neutral');
    expect(classifyCloseOutcome({ closeReason: 'TP1_HIT' })).toBe('profit');
    expect(classifyCloseOutcome({ closeReason: 'UC_FLIP_MINIMAL_LOSS_EXIT' })).toBe('loss');
    expect(classifyCloseOutcome({ closeReason: 'MANUAL' })).toBe('unknown');
    expect(classifyCloseOutcome({ closeReason: 'EXCHANGE_POSITION_CLOSED', peakR: 0.05 })).toBe('loss');
    expect(classifyCloseOutcome({ closeReason: 'EXCHANGE_POSITION_CLOSED', peakR: 0.8, currentR: 0.6 })).toBe('profit');
    expect(classifyCloseOutcome({ closeReason: 'EXCHANGE_POSITION_CLOSED', peakR: 0.3 })).toBe('loss');
    expect(isNonProfitClose({ pnl: 0 })).toBe(true);
    expect(isNonProfitClose({ pnl: 2 })).toBe(false);
  });

  it('a fresh same-side non-profit close locks re-entry for 20m', () => {
    const r = evaluateLossChurnLock({
      symbol: 'XAU', side: 'SHORT', closedRows: [closedRow()], now: NOW, cfg: CHURN_CFG,
    });
    expect(r.singleSideLock).toBe(true);
    expect(r.streakLock).toBe(false);
    expect(r.wouldLock).toBe(true);
    expect(r.locked).toBe(true);
    expect(r.reason).toMatch(/same-side lock/);
  });

  it('opposite side is allowed after a single loss; expired cooldown is allowed', () => {
    expect(evaluateLossChurnLock({
      symbol: 'XAU', side: 'LONG', closedRows: [closedRow()], now: NOW, cfg: CHURN_CFG,
    }).wouldLock).toBe(false);
    expect(evaluateLossChurnLock({
      symbol: 'XAU', side: 'SHORT', closedRows: [closedRow({ closedAt: NOW - 25 * MIN })],
      now: NOW, cfg: CHURN_CFG,
    }).wouldLock).toBe(false);
  });

  it('a confirmed flip bypasses the single-loss same-side lock', () => {
    const r = evaluateLossChurnLock({
      symbol: 'XAU', side: 'SHORT', closedRows: [closedRow()],
      now: NOW, cfg: CHURN_CFG, flipConfirmed: true,
    });
    expect(r.singleSideLock).toBe(true);
    expect(r.wouldLock).toBe(false);
  });

  it('two non-profit closes inside the window lock BOTH sides — a flip cannot bypass', () => {
    const rows = [
      closedRow({ closedAt: NOW - 30 * MIN, side: 'SHORT' }),
      closedRow({ closedAt: NOW - 10 * MIN, side: 'LONG' }),
    ];
    const short = evaluateLossChurnLock({
      symbol: 'XAU', side: 'SHORT', closedRows: rows, now: NOW, cfg: CHURN_CFG, flipConfirmed: true,
    });
    expect(short.lossStreak).toBe(2);
    expect(short.streakLock).toBe(true);
    expect(short.wouldLock).toBe(true);
    expect(short.reason).toMatch(/both sides cooling down/);
    expect(evaluateLossChurnLock({
      symbol: 'XAU', side: 'LONG', closedRows: rows, now: NOW, cfg: CHURN_CFG,
    }).wouldLock).toBe(true);
  });

  it('profitable closes never lock and reset the streak', () => {
    expect(evaluateLossChurnLock({
      symbol: 'XAU', side: 'SHORT',
      closedRows: [closedRow({ pnl: 2, closeReason: 'TP1_HIT' })], now: NOW, cfg: CHURN_CFG,
    }).wouldLock).toBe(false);
    const rows = [
      closedRow({ pnl: 2, closeReason: 'TP1_HIT', closedAt: NOW - 5 * MIN, side: 'SHORT' }),
      closedRow({ closedAt: NOW - 20 * MIN, side: 'SHORT' }),
    ];
    const r = evaluateLossChurnLock({
      symbol: 'XAU', side: 'SHORT', closedRows: rows, now: NOW, cfg: CHURN_CFG,
    });
    expect(r.lossStreak).toBe(0);
    expect(r.wouldLock).toBe(false);
  });

  it('manual rows are ignored; other symbols are ignored', () => {
    expect(evaluateLossChurnLock({
      symbol: 'XAU', side: 'SHORT',
      closedRows: [closedRow({ openedBy: 'MANUAL' })], now: NOW, cfg: CHURN_CFG,
    }).wouldLock).toBe(false);
    expect(evaluateLossChurnLock({
      symbol: 'XAG', side: 'SHORT',
      closedRows: [closedRow()], now: NOW, cfg: CHURN_CFG,
    }).wouldLock).toBe(false);
  });

  it('shadow mode reports wouldLock but never locks', () => {
    const r = evaluateLossChurnLock({
      symbol: 'XAU', side: 'SHORT', closedRows: [closedRow()],
      now: NOW, cfg: CHURN_CFG, mode: 'shadow',
    });
    expect(r.wouldLock).toBe(true);
    expect(r.locked).toBe(false);
  });
});

// ------------------------------------------------------------
// Tick integration
// ------------------------------------------------------------
function fakePaper(openSeed = []) {
  const calls = { opened: [], closed: [] };
  const paper = {
    open: openSeed,
    openPaperTrade: vi.fn((input) => {
      calls.opened.push(input);
      const trade = { id: 900 + calls.opened.length, ...input, status: 'OPEN' };
      paper.open.push({ id: trade.id, symbol: input.symbol, market: input.market, status: 'OPEN', direction: input.direction, openedAt: NOW });
      return { ok: true, trade };
    }),
    closePaperTrade: vi.fn((id) => {
      calls.closed.push(id);
      paper.open = paper.open.filter(t => t.id !== id);
      return { ok: true, trade: { id, realizedPnl: -0.4 } };
    }),
    getPaperSummary: vi.fn(() => ({ open: paper.open })),
    updatePaperTradeT1ClosePct: vi.fn(),
  };
  return { paper, calls };
}

function boardFixture(symbol = 'BTCUSDT', over = {}) {
  return {
    ok: true, market: 'CRYPTO', mode: 'INTRADAY', holdMin: 45, minScore: 75,
    rows: [{
      ok: true, symbol, market: 'CRYPTO', mode: 'INTRADAY', label: '15m → 5m', holdMin: 45,
      superScore: 82, tier: 'STRONG', side: 'LONG', dir: 1, grade: 'A',
      directionVerified: true, directionVerdict: 'VERIFIED',
      triggerFired: true, dualAligned: true, counterTrend: false, tfFit: 'OK',
      autoEligible: true, autoBlockers: [],
      plan: { entry: 100, stopLoss: 99, t1: 101, t2: 102 },
      drivers: ['dual-TF confirm'],
      ...over,
    }],
  };
}

const cleanTrendRow = (over = {}) => boardFixture('BTCUSDT', {
  context: { regime: 'TREND_UP', adx: 25, dir: 1 },
  trigger: { rsi: 62, dir: 1, pullbackReclaim: true },
  barConfirmation: { stable: true },
  ...over,
});

const chopRow = (over = {}) => boardFixture('BTCUSDT', {
  context: { regime: 'CHOP', adx: 12, dir: 1 },
  trigger: { rsi: 50, dir: 1, pullbackReclaim: false },
  barConfirmation: { stable: false },
  ...over,
});

function tickP(paper, board, over = {}) {
  return {
    boards: { CRYPTO: board },
    paper,
    quotes: { BTCUSDT: { price: 100 }, BTC: { price: 100 } },
    walletEquityINR: 10000,
    fx: 94.95,
    now: NOW,
    ...over,
  };
}

function eventText() {
  return (mtfAutoStatus().events || []).map(e => `${e.kind || ''} ${e.text || ''}`).join(' | ');
}

describe('v21.37.0 — tick wiring (fidelity + churn)', () => {
  beforeEach(() => { __resetMtfAutoForTests(); __resetDirectionLocksForTests(); });

  it('default scope `live` leaves the paper lane untouched (CHOP still opens)', async () => {
    __resetMtfAutoForTests({
      config: { enabled: true, executionMode: 'paper', desks: { india: false, crypto: true } },
    });
    const { paper, calls } = fakePaper();
    const out = await mtfAutoTick(tickP(paper, chopRow()));
    expect(out.opened).toHaveLength(1);
    expect(calls.opened).toHaveLength(1);
  });

  it('scope `all` enforces the CHOP fidelity veto in paper', async () => {
    __resetMtfAutoForTests({
      config: {
        enabled: true, executionMode: 'paper', desks: { india: false, crypto: true },
        signalFidelityScope: 'all',
      },
    });
    const { paper, calls } = fakePaper();
    const out = await mtfAutoTick(tickP(paper, chopRow()));
    expect(out.opened).toHaveLength(0);
    expect(calls.opened).toHaveLength(0);
    expect(out.skipped.join(' ')).toMatch(/signal fidelity blocked.*CHOP regime/);
  });

  it('scope `all` does not block a clean trend row', async () => {
    __resetMtfAutoForTests({
      config: {
        enabled: true, executionMode: 'paper', desks: { india: false, crypto: true },
        signalFidelityScope: 'all',
      },
    });
    const { paper } = fakePaper();
    const out = await mtfAutoTick(tickP(paper, cleanTrendRow()));
    expect(out.opened).toHaveLength(1);
    expect(out.skipped.join(' ')).not.toMatch(/signal fidelity/);
  });

  it('scope `all` blocks a same-side repeat minutes after a non-profit close', async () => {
    const closedLoss = {
      symbol: 'BTC', side: 'SHORT', status: 'CLOSED',
      closedAt: NOW - 5 * MIN, pnl: -1.5,
      closeReason: 'UC_FLIP_MINIMAL_LOSS_EXIT', openedBy: 'AUTO',
      executionMode: 'PAPER', traded: true,
    };
    __resetMtfAutoForTests({
      config: {
        enabled: true, executionMode: 'paper', desks: { india: false, crypto: true },
        maxTradesPerDay: 0, lossChurnScope: 'all',
      },
      state: { book: [closedLoss] },
    });
    const { paper, calls } = fakePaper();
    const shortRow = cleanTrendRow({
      side: 'SHORT', dir: -1, tier: 'STRONG',
      plan: { entry: 100, stopLoss: 101, t1: 99, t2: 98 },
      context: { regime: 'TREND_DOWN', adx: 25, dir: -1 },
      trigger: { rsi: 38, dir: -1, pullbackReclaim: true },
    });
    const out = await mtfAutoTick(tickP(paper, boardFixture('BTCUSDT', shortRow.rows[0])));
    expect(out.opened).toHaveLength(0);
    expect(calls.opened).toHaveLength(0);
    expect(out.skipped.join(' ')).toMatch(/loss-churn lock/);
  });

  it('scope `all` lets a profitable close re-enter (no churn lock)', async () => {
    const closedWin = {
      symbol: 'BTC', side: 'SHORT', status: 'CLOSED',
      closedAt: NOW - 5 * MIN, pnl: 2,
      closeReason: 'TP1_HIT', openedBy: 'AUTO',
      executionMode: 'PAPER', traded: true,
    };
    __resetMtfAutoForTests({
      config: {
        enabled: true, executionMode: 'paper', desks: { india: false, crypto: true },
        maxTradesPerDay: 0, lossChurnScope: 'all',
      },
      state: { book: [closedWin] },
    });
    const { paper } = fakePaper();
    const shortRow = cleanTrendRow({
      side: 'SHORT', dir: -1,
      plan: { entry: 100, stopLoss: 101, t1: 99, t2: 98 },
      context: { regime: 'TREND_DOWN', adx: 25, dir: -1 },
      trigger: { rsi: 38, dir: -1, pullbackReclaim: true },
    });
    const out = await mtfAutoTick(tickP(paper, boardFixture('BTCUSDT', shortRow.rows[0])));
    expect(out.opened).toHaveLength(1);
    expect(out.skipped.join(' ')).not.toMatch(/loss-churn/);
  });
});

// ------------------------------------------------------------
// Flip-reverse lane: exit always allowed, reverse must pass fidelity
// ------------------------------------------------------------
function openLongBtc(over = {}) {
  return {
    paperId: 777, liveOrderId: null, livePositionId: null,
    executionMode: 'PAPER', traded: true, fullControl: false, openedInLiveMode: false,
    symbol: 'BTC', market: 'CRYPTO', execMarket: 'FUTURES', ccy: 'USDT', fxUsed: 94.95,
    side: 'LONG', score: 88, tier: 'ELITE', mode: 'INTRADAY', holdMin: 45,
    entry: 100, stopLoss: 99, initialStopLoss: 99, trailedStopLoss: 99, peakPrice: 100,
    t1: 101, t2: 102, qty: 1, leverage: 10, walletINR: 10000, walletDeployPct: 100,
    deployedWalletINR: 10000, deployedWalletUSDT: 105.3, buyingPowerINR: 100000, buyingPowerUSDT: 1053,
    feeBreakevenPrice: 100.12, deepMonitorStage: 'STAGE_0_INITIAL_GUARD',
    atrPct: null, volClass: null, momentumState: null, t1ClosePct: 0.5,
    openedAt: NOW - 5 * MIN, dayKey: new Date(NOW).toLocaleDateString('sv-SE', { timeZone: 'UTC' }),
    status: 'OPEN', closeReason: null, closedAt: null, pnl: null, notional: 9495, drivers: ['x'],
    ...over,
  };
}

const flippedShortRow = (over = {}) => ({
  ok: true, symbol: 'BTC', market: 'CRYPTO', mode: 'INTRADAY', label: '15m → 5m', holdMin: 45,
  superScore: 86, tier: 'ELITE', side: 'SHORT', dir: -1, grade: 'A',
  triggerFired: true, dualAligned: true, counterTrend: false, tfFit: 'OK',
  directionVerified: true, ensembleSignalAvailable: true,
  autoEligible: true, autoBlockers: [],
  plan: { entry: 100.5, stopLoss: 100.6, t1: 98.5, t2: 97.5 },
  context: { dir: -1, regime: 'TREND_DOWN', adx: 25 },
  trigger: { dir: -1, rsi: 38, pullbackReclaim: true },
  barConfirmation: { stable: true },
  ltp: 99.6, drivers: ['x'],
  ...over,
});

describe('v21.37.0 — flip-reverse fidelity', () => {
  beforeEach(() => { __resetMtfAutoForTests(); __resetDirectionLocksForTests(); });

  it('protective exit still happens, but a CHOP reverse row never opens a new position', async () => {
    __resetMtfAutoForTests({
      config: {
        enabled: true, executionMode: 'paper', minScore: 75,
        signalFidelityScope: 'all',
      },
      state: { book: [openLongBtc()] },
    });
    const { paper, calls } = fakePaper([{ id: 777, symbol: 'BTC', market: 'FUTURES', status: 'OPEN', direction: 'LONG', openedAt: NOW - 5 * MIN }]);
    const chopReverse = flippedShortRow({
      context: { dir: -1, regime: 'CHOP', adx: 12 },
      trigger: { dir: -1, rsi: 50, pullbackReclaim: false },
      barConfirmation: { stable: true },
    });
    const out = await mtfAutoTick(tickP(paper, { ok: true, market: 'CRYPTO', mode: 'INTRADAY', holdMin: 45, minScore: 75, rows: [chopReverse] }));
    expect(out.closed).toHaveLength(1);
    expect(out.closed[0].reason).toBe('UC_FLIP_MINIMAL_LOSS_EXIT');
    expect(out.opened).toHaveLength(0);
    expect(calls.opened).toHaveLength(0);
    expect(eventText() + ' ' + out.skipped.join(' ')).toMatch(/reverse fidelity/);
  });
});
