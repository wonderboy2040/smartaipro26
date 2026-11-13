// ============================================================
// test/mtfAutoLink.test.ts — v21.16.0 MTF AUTO-LINK (paper/auto)
// ------------------------------------------------------------
// Hermetic suite: paper engine INJECT ki jati hai (koi real file/broker
// IO nahi) — ye exactly wahi `mtfAutoTick` contract verify karta hai
// jo production loop (server/ai/routes.js, 60s) chalata hai.
//
// Guards the USER SPEC + safety rails:
//   • 75+ full-confirm rows → openPaperTrade call (risk-based qty)
//   • budget / quota / cooldown / max-open / kill-switch / market-gate
//     sab hard caps enforce hote hain
//   • TIME-STOP: plan window ke baad closePaperTrade call
//   • PAPER ONLY — module me koi live-exec import nahi hai
// ============================================================
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// v21.16.0: suite kabhi REAL server/data/ na chhue — apna tmp dir.
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mtf-auto-test-'));
process.env.MTF_AUTO_DATA_DIR = TMP_DATA;
import { durablePut } from '../server/mcp/durable.js';
import {
  mtfAutoTick, mtfAutoStatus, loadMtfAutoConfig, updateMtfAutoConfig,
  setMtfAutoEnabled, normalizeLinkSymbol, recordPaperMtfBoardTrade,
  isLiveSessionEntry, __resetMtfAutoForTests, __reloadMtfAutoForBoot, MTF_AUTO_DEFAULTS,
  metalsSymbolOf, metalsLeverageFor, metalsEntryGate, metalsAutoCandidates,
  syncCoinDcxActivePositionsToDeepMonitor,
} from '../server/ai/mtfAutoLink.js';
import { dayKeyFor } from '../server/intraday/time.js';

// Phase-3 persistence is asserted without any GitHub/network calls.
vi.mock('../server/mcp/durable.js', () => ({ durablePut: vi.fn() }));

/** Injected paper engine fake — records every call. */
function fakePaper(over = {}) {
  const calls = { opened: [], closed: [] };
  const paper = {
    open: [],
    openPaperTrade: vi.fn((input) => {
      calls.opened.push(input);
      const trade = { id: 900 + calls.opened.length, ...input };
      paper.open.push({ id: trade.id, symbol: input.symbol, market: input.market, status: 'OPEN', direction: input.direction, openedAt: Date.now() });
      return { ok: true, trade };
    }),
    closePaperTrade: vi.fn((id) => {
      calls.closed.push(id);
      paper.open = paper.open.filter(t => t.id !== id);
      return { ok: true, trade: { id, realizedPnl: 123.45 } };
    }),
    getPaperSummary: vi.fn(() => ({ open: paper.open })),
  };
  Object.assign(paper, over);
  return { paper, calls };
}

/** A dual-board with one eligible CRYPTO row (fresh, aligned, fired). */
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
      drivers: ['dual-TF confirm: context+trigger aligned (+4)'],
      ...over,
    }],
  };
}

describe('mtfAutoLink — config + status', () => {
  beforeEach(() => { __resetMtfAutoForTests(); });

  it('defaults: OFF, paper-only, minScore 75, sensible caps', () => {
    const cfg = loadMtfAutoConfig();
    expect(cfg.enabled).toBe(false);
    expect(cfg.minScore).toBe(75);
    expect(cfg.riskPerTradeINR).toBe(MTF_AUTO_DEFAULTS.riskPerTradeINR);
    const st = mtfAutoStatus();
    expect(st.paperOnly).toBe(true);
    expect(st.note).toMatch(/PAPER/i);
  });

  it('v21.23.14: GLOBALFUTURES sim book row stays GLOBALFUTURES/USDC', () => {
    const rec = recordPaperMtfBoardTrade({
      symbol: 'NVDA', market: 'GLOBALFUTURES', side: 'LONG',
      entry: 100, stopLoss: 98, t1: 103, t2: 106, qty: 2,
    });
    expect(rec?.market).toBe('GLOBALFUTURES');
    expect(rec?.execMarket).toBe('GLOBALFUTURES');
    expect(rec?.ccy).toBe('USDC');
    expect(rec?.fxUsed).toBeNull();
  });

  it('clamps a hostile config (score floor 65, risk 100..25000)', () => {
    const cfg = updateMtfAutoConfig({ minScore: 5, riskPerTradeINR: 10_000_000, maxTradesPerDay: 999, mode: 'HACK' });
    expect(cfg.minScore).toBeGreaterThanOrEqual(65);
    expect(cfg.riskPerTradeINR).toBeLessThanOrEqual(25000);
    expect(cfg.maxTradesPerDay).toBeLessThanOrEqual(25);
    expect(cfg.mode).toBe('INTRADAY');
  });

  it('v21.23.18: isLiveSessionEntry separates PAPER test rows from LIVE exchange rows', () => {
    expect(isLiveSessionEntry({ executionMode: 'LIVE' })).toBe(true);
    expect(isLiveSessionEntry({ liveOrderId: 'ord' })).toBe(true);
    expect(isLiveSessionEntry({ livePositionId: 'pos' })).toBe(true);
    expect(isLiveSessionEntry({ paperId: 7, executionMode: 'PAPER', traded: true })).toBe(false);
    expect(isLiveSessionEntry(null)).toBe(false);
  });

  it('v21.25.1: manual PAPER test rows do not consume the AUTO paper daily quota', async () => {
    const now = Date.now();
    const dayKey = dayKeyFor('CRYPTO', new Date(now));
    const manualPaper = (symbol, id) => ({
      paperId: id, symbol, market: 'CRYPTO', execMarket: 'FUTURES', side: 'LONG',
      entry: 50, stopLoss: 49, t1: 51, t2: 52, qty: 1, notional: 50,
      openedAt: now, dayKey, status: 'CLOSED', closeReason: 'T2_HIT', closedAt: now, pnl: 1,
      executionMode: 'PAPER', traded: true, openedBy: 'MANUAL',
    });
    __resetMtfAutoForTests({
      config: { enabled: true, executionMode: 'paper', maxTradesPerDay: 1, desks: { india: false, crypto: true } },
      state: { book: [manualPaper('ADA', 101), manualPaper('ETH', 102), manualPaper('SOL', 103)] },
    });
    expect(mtfAutoStatus().dayQuotaCount).toBe(0);
    const { paper, calls } = fakePaper();
    const out = await mtfAutoTick({ boards: { CRYPTO: boardFixture('BTCUSDT') }, paper });
    expect(out.skipped.join(' ')).not.toMatch(/daily quota|desk quota/);
    expect(calls.opened).toHaveLength(1);
    // Auto engine's own paper entry is the only row that consumes the quota.
    expect(mtfAutoStatus().dayQuotaCount).toBe(1);
  });

  it('normalizeLinkSymbol strips venue namespaces + quote suffixes', () => {
    expect(normalizeLinkSymbol('FUT_BTC', 'CRYPTO')).toBe('BTC');
    expect(normalizeLinkSymbol('BTCUSDT', 'CRYPTO')).toBe('BTC');
    expect(normalizeLinkSymbol('SOL-USDT', 'CRYPTO')).toBe('SOL');
    expect(normalizeLinkSymbol('RELIANCE', 'INDIA')).toBe('RELIANCE');
    expect(normalizeLinkSymbol('tcs', 'INDIA')).toBe('TCS');
  });
});

describe('mtfAutoLink — tick gates', () => {
  beforeEach(() => { __resetMtfAutoForTests(); });

  it('OFF by default: tick is a no-op', async () => {
    const { paper, calls } = fakePaper();
    const out = await mtfAutoTick({ boards: { CRYPTO: boardFixture() }, paper });
    expect(out.opened).toEqual([]);
    expect(out.skipped).toContain('auto-link OFF');
    expect(calls.opened).toEqual([]);
  });

  it('kill-switch blocks everything', async () => {
    __resetMtfAutoForTests({ config: { enabled: true } });
    const { paper, calls } = fakePaper();
    const out = await mtfAutoTick({ boards: { CRYPTO: boardFixture() }, paper, killSwitch: true });
    expect(out.skipped.join(' ')).toMatch(/kill-switch/i);
    expect(calls.opened).toEqual([]);
  });

  it('opening is PAPER openPaperTrade with risk-based qty', async () => {
    __resetMtfAutoForTests({ config: { enabled: true, riskPerTradeINR: 2000, desks: { india: false, crypto: true } } });
    const { paper, calls } = fakePaper();
    const out = await mtfAutoTick({ boards: { CRYPTO: boardFixture() }, paper, now: Date.now() });
    expect(out.opened).toHaveLength(1);
    expect(calls.opened).toHaveLength(1);
    const o = calls.opened[0];
    expect(o.symbol).toBe('BTC');           // FUT_/quote-suffix normalized
    expect(o.direction).toBe('LONG');
    expect(o.market).toBe('FUTURES');   // v21.17.0: USDT-perp paper domain
    expect(o.stopLoss).toBe(99);
    expect(o.target1).toBe(101);
    expect(o.target2).toBe(102);
    // v21.17.0: crypto rows USDT domain me execute hote hain (FUTURES desk)
    // — risk ₹2000 / fx84 = 23.81 USDT ÷ SL-distance 1 = 23.81 raw qty, phir
    // ₹50k per-trade notional cap (USDT me) se clamp. Dono caps INR terms
    // me verify hote hain (fx 84 = cfg default jab caller fx na de).
    const FX = 84;
    expect(o.market).toBe('FUTURES');
    expect(o.qty * Math.abs(o.entry - o.stopLoss) * FX).toBeLessThanOrEqual(2000 + 1e-6);
    expect(o.qty * o.entry * FX).toBeLessThanOrEqual(50000 + 1e-6);
    expect(o.qty).toBeGreaterThan(0);
    const st = mtfAutoStatus();
    expect(st.openCount).toBe(1);
    expect(st.dayCount).toBe(1);
    expect(st.events.some(e => e.kind === 'entry')).toBe(true);
  });

  it('daily quota blocks further entries', async () => {
    __resetMtfAutoForTests({ config: { enabled: true, maxTradesPerDay: 1, desks: { india: false, crypto: true } } });
    const { paper, calls } = fakePaper();
    await mtfAutoTick({ boards: { CRYPTO: boardFixture() }, paper });
    expect(calls.opened).toHaveLength(1);
    // second tick — quota exhausted (maxOpenPositions default 6 > 1, so quota is the gate)
    await mtfAutoTick({ boards: { CRYPTO: boardFixture('ETH') }, paper });
    expect(calls.opened).toHaveLength(1);
    const st = mtfAutoStatus();
    expect(st.dayCount).toBe(1);
  });

  it('notional budget caps qty (never oversize)', async () => {
    __resetMtfAutoForTests({ config: { enabled: true, riskPerTradeINR: 2000, maxNotionalPerTradeINR: 500, maxPositionsINR: 100000, desks: { india: false, crypto: true } } });
    const { paper, calls } = fakePaper();
    await mtfAutoTick({ boards: { CRYPTO: boardFixture() }, paper });
    expect(calls.opened).toHaveLength(1);
    const o = calls.opened[0];
    // clamp floor 1000₹ hai (CLAMPS) — USDT desk par cap = 1000/84 ≈ 11.9 USDT
    expect(o.qty * o.entry).toBeLessThanOrEqual(1000 / 84 + 1e-6);
    expect(o.qty).toBeGreaterThan(0);
  });

  it('cooldown + already-open symbols block re-entry', async () => {
    __resetMtfAutoForTests({ config: { enabled: true, cooldownMin: 30, desks: { india: false, crypto: true } } });
    const { paper, calls } = fakePaper();
    await mtfAutoTick({ boards: { CRYPTO: boardFixture() }, paper });
    expect(calls.opened).toHaveLength(1);
    const out2 = await mtfAutoTick({ boards: { CRYPTO: boardFixture() }, paper });
    expect(out2.opened).toHaveLength(0);
    expect(out2.skipped.concat(out2.candidates === 0 ? ['no-candidates'] : []).join(' ').length).toBeGreaterThan(0);
  });

  it('max open positions gate', async () => {
    __resetMtfAutoForTests({ config: { enabled: true, maxOpenPositions: 1, desks: { india: false, crypto: true } } });
    const { paper, calls } = fakePaper();
    await mtfAutoTick({ boards: { CRYPTO: boardFixture() }, paper });
    await mtfAutoTick({ boards: { CRYPTO: boardFixture('ETH') }, paper });
    expect(calls.opened).toHaveLength(1);
    const st = mtfAutoStatus();
    expect(st.openCount).toBe(1);
  });

  it('INDIA desk honours the NSE clock (no entries when closed)', async () => {
    __resetMtfAutoForTests({ config: { enabled: true, desks: { india: true, crypto: false } } });
    const { paper, calls } = fakePaper();
    const indiaBoard = { ...boardFixture('RELIANCE'), market: 'INDIA' };
    indiaBoard.rows[0].market = 'INDIA';
    const out = await mtfAutoTick({ boards: { INDIA: indiaBoard }, paper });
    if (calls.opened.length === 0) {
      expect(out.skipped.join(' ')).toMatch(/NSE closed|cutoff/);
    } else {
      // test ran inside NSE hours — entry must be a real paper open
      expect(calls.opened[0].market).toBe('INDIA');
    }
  });
});

describe('mtfAutoLink — PAPER test rows never block the LIVE session', () => {
  beforeEach(() => { __resetMtfAutoForTests(); });

  function livePaper() {
    const { paper } = fakePaper();
    return paper;
  }
  function liveExec() {
    return vi.fn(async () => ({
      ok: true, orderId: 'ord-1',
      filled: { qty: 1, price: 100, stopLoss: 99, t1: 101, t2: 102 },
      position: { id: 'pos-1' },
    }));
  }
  const liveCtx = () => ({ siteLiveByDesk: { crypto: true, india: false } });

  it('v21.23.18: an open PAPER test trade does NOT trigger the 1-session live lock', async () => {
    const now = Date.now();
    __resetMtfAutoForTests({
      config: { enabled: true, executionMode: 'live', desks: { india: false, crypto: true } },
      state: {
        book: [{
          paperId: 77, symbol: 'ETH', market: 'CRYPTO', execMarket: 'FUTURES', side: 'LONG',
          entry: 50, stopLoss: 49, t1: 51, t2: 52, qty: 1, notional: 5000,
          openedAt: now, status: 'OPEN', executionMode: 'PAPER', traded: true,
        }],
      },
    });
    const paper = livePaper();
    paper.open.push({ id: 77, symbol: 'ETH', market: 'FUTURES', status: 'OPEN' });
    const liveExecute = liveExec();
    const out = await mtfAutoTick({
      boards: { CRYPTO: boardFixture('BTCUSDT') }, paper, liveExecute, ...liveCtx(),
    });
    expect(out.skipped.join(' ')).not.toMatch(/1 session = 1 trade lock/);
    expect(liveExecute).toHaveBeenCalledTimes(1);
    expect(out.opened).toHaveLength(1);
    expect(out.opened[0].executionMode).toBe('LIVE');
  });

  it('v21.23.18: a PAPER row on the SAME symbol does not poison the live symbol lock', async () => {
    const now = Date.now();
    __resetMtfAutoForTests({
      config: { enabled: true, executionMode: 'live', desks: { india: false, crypto: true } },
      state: {
        book: [{
          paperId: 88, symbol: 'BTC', market: 'CRYPTO', execMarket: 'FUTURES', side: 'LONG',
          entry: 100, stopLoss: 99, t1: 101, t2: 102, qty: 1, notional: 5000,
          openedAt: now, status: 'OPEN', executionMode: 'PAPER', traded: true,
        }],
      },
    });
    const paper = livePaper();
    paper.open.push({ id: 88, symbol: 'BTC', market: 'FUTURES', status: 'OPEN' });
    const liveExecute = liveExec();
    const out = await mtfAutoTick({
      boards: { CRYPTO: boardFixture('BTCUSDT') }, paper, liveExecute, ...liveCtx(),
    });
    expect(out.skipped.join(' ')).not.toMatch(/already open/);
    expect(liveExecute).toHaveBeenCalledTimes(1);
    expect(out.opened).toHaveLength(1);
  });

  it('v21.23.18: PAPER rows do not consume the LIVE daily quota / post-success cooldown', async () => {
    const now = Date.now();
    __resetMtfAutoForTests({
      config: {
        enabled: true, executionMode: 'live', maxTradesPerDay: 1,
        postSuccessCooldownMin: 0, desks: { india: false, crypto: true },
      },
      state: {
        book: [{
          paperId: 99, symbol: 'ETH', market: 'CRYPTO', execMarket: 'FUTURES', side: 'LONG',
          entry: 50, stopLoss: 49, t1: 51, t2: 52, qty: 1, notional: 5000,
          openedAt: now, dayKey: dayKeyFor('CRYPTO', new Date(now)),
          status: 'CLOSED', closeReason: 'T2_HIT', closedAt: now, pnl: 100,
          executionMode: 'PAPER', traded: true,
        }],
      },
    });
    const paper = livePaper();
    const liveExecute = liveExec();
    const out = await mtfAutoTick({
      boards: { CRYPTO: boardFixture('BTCUSDT') }, paper, liveExecute, ...liveCtx(),
    });
    expect(out.skipped.join(' ')).not.toMatch(/daily quota|desk quota|post-success cooldown/);
    expect(liveExecute).toHaveBeenCalledTimes(1);
    expect(out.opened).toHaveLength(1);
  });

  it('v21.23.18: explicit LIVE re-arm clears stale failed-attempt backoff', async () => {
    const now = Date.now();
    __resetMtfAutoForTests({
      config: { enabled: false, executionMode: 'live', desks: { india: false, crypto: true } },
      state: {
        failedLiveAttempts: { BTC: { at: now, count: 5, reason: 'old creds error' } },
      },
    });
    // User explicitly re-arms LIVE after fixing creds/arming.
    setMtfAutoEnabled(true);
    const paper = livePaper();
    const liveExecute = liveExec();
    const out = await mtfAutoTick({
      boards: { CRYPTO: boardFixture('BTCUSDT') }, paper, liveExecute, ...liveCtx(),
    });
    expect(out.skipped.join(' ')).not.toMatch(/live-attempt backoff/);
    expect(liveExecute).toHaveBeenCalledTimes(1);
    expect(out.opened).toHaveLength(1);
  });

  it('v21.23.18: strict LIVE mode does NOT open a silent PAPER fallback when the desk is not site-live', async () => {
    __resetMtfAutoForTests({
      config: { enabled: true, executionMode: 'live', desks: { india: false, crypto: true } },
    });
    const { paper, calls } = fakePaper();
    const liveExecute = liveExec();
    const out = await mtfAutoTick({
      boards: { CRYPTO: boardFixture('BTCUSDT') }, paper, liveExecute,
      siteLiveByDesk: { crypto: false, india: false },
    });
    expect(out.skipped.join(' ')).toMatch(/paper fallback skipped/);
    expect(calls.opened).toEqual([]);
    expect(liveExecute).not.toHaveBeenCalled();
    expect(out.opened).toHaveLength(0);
  });

  it('v21.23.18: EQUITY SIM rows still open paper/SIM entries in strict LIVE mode', async () => {
    __resetMtfAutoForTests({
      config: { enabled: true, executionMode: 'live', desks: { india: false, crypto: true } },
    });
    const { paper, calls } = fakePaper();
    const baseRow = boardFixture('NVDA').rows[0];
    const board = {
      ...boardFixture('NVDA'),
      rows: [],
      equitySimRows: [{ ...baseRow, market: 'GLOBALFUTURES', ltp: 100 }],
    };
    const out = await mtfAutoTick({
      boards: { CRYPTO: board }, paper, liveExecute: liveExec(),
      siteLiveByDesk: { crypto: false, india: false },
    });
    expect(out.skipped.join(' ')).not.toMatch(/paper fallback skipped/);
    expect(calls.opened).toHaveLength(1);
    expect(calls.opened[0].market).toBe('GLOBALFUTURES');
    expect(out.opened).toHaveLength(1);
    expect(out.opened[0].executionMode).toBe('PAPER');
  });

  it('v21.35.6: a real LIVE open position still enforces 1 session = 1 trade when multiTradeMode is OFF (default)', async () => {
    const now = Date.now();
    __resetMtfAutoForTests({
      config: { enabled: true, executionMode: 'live', desks: { india: false, crypto: true } },
      state: {
        book: [{
          paperId: 55, liveOrderId: 'ord-live', livePositionId: 'pos-live',
          symbol: 'ETH', market: 'CRYPTO', execMarket: 'FUTURES', side: 'LONG',
          entry: 50, stopLoss: 49, t1: 51, t2: 52, qty: 1, notional: 5000,
          openedAt: now, status: 'OPEN', executionMode: 'LIVE', traded: true,
        }],
      },
    });
    const paper = livePaper();
    const liveExecute = liveExec();
    const out = await mtfAutoTick({
      boards: { CRYPTO: boardFixture('BTCUSDT') }, paper, liveExecute, ...liveCtx(),
    });
    expect(out.skipped.join(' ')).toMatch(/1 session = 1 trade lock/);
    expect(liveExecute).not.toHaveBeenCalled();
    expect(out.opened).toHaveLength(0);
  });
});

describe('mtfAutoLink — v21.35.6 universal multi-trade', () => {
  beforeEach(() => { __resetMtfAutoForTests(); });

  function livePaper() { return fakePaper().paper; }
  function liveExec() {
    return vi.fn(async () => ({
      ok: true, orderId: 'ord-1',
      filled: { qty: 1, price: 100, stopLoss: 99, t1: 101, t2: 102 },
      position: { id: 'pos-1' },
    }));
  }
  const liveCtx = () => ({ siteLiveByDesk: { crypto: true, india: false } });

  it('default: multiTradeMode OFF, maxConcurrentTrades 3 — legacy 1-trade behaviour intact', () => {
    const cfg = loadMtfAutoConfig();
    expect(cfg.multiTradeMode).toBe(false);
    expect(cfg.maxConcurrentTrades).toBe(3);
    const st = mtfAutoStatus();
    expect(st.multiTradeMode).toBe(false);
    expect(st.maxConcurrentTrades).toBe(3);
  });

  it('sanitize: multiTradeMode coerced to boolean, maxConcurrentTrades clamped to [1,8]', () => {
    const cfg = updateMtfAutoConfig({ multiTradeMode: true, maxConcurrentTrades: 99 });
    expect(cfg.multiTradeMode).toBe(true);
    expect(cfg.maxConcurrentTrades).toBe(8);
    const cfg2 = updateMtfAutoConfig({ multiTradeMode: 'nope', maxConcurrentTrades: 0 });
    expect(cfg2.multiTradeMode).toBe(false);
    expect(cfg2.maxConcurrentTrades).toBe(1);
  });

  it('multi-trade ON: two eligible symbols open TWO individual trades in one tick (paper engine)', async () => {
    __resetMtfAutoForTests({
      config: {
        enabled: true, executionMode: 'paper', multiTradeMode: true, maxConcurrentTrades: 3,
        desks: { india: false, crypto: true },
      },
    });
    const { paper, calls } = fakePaper();
    const board = {
      ok: true, market: 'CRYPTO', mode: 'INTRADAY', holdMin: 45, minScore: 75,
      rows: [
        {
          ok: true, symbol: 'BTCUSDT', market: 'CRYPTO', mode: 'INTRADAY', label: '15m → 5m', holdMin: 45,
          superScore: 88, tier: 'STRONG', side: 'LONG', dir: 1, grade: 'A',
          triggerFired: true, dualAligned: true, counterTrend: false, tfFit: 'OK',
          autoEligible: true, autoBlockers: [],
          plan: { entry: 100, stopLoss: 99, t1: 101, t2: 102 },
        },
        {
          ok: true, symbol: 'ETHUSDT', market: 'CRYPTO', mode: 'INTRADAY', label: '15m → 5m', holdMin: 45,
          superScore: 84, tier: 'STRONG', side: 'SHORT', dir: -1, grade: 'A',
          triggerFired: true, dualAligned: true, counterTrend: false, tfFit: 'OK',
          autoEligible: true, autoBlockers: [],
          plan: { entry: 50, stopLoss: 51, t1: 49, t2: 48 },
        },
      ],
    };
    const out = await mtfAutoTick({ boards: { CRYPTO: board }, paper });
    expect(out.opened).toHaveLength(2);
    expect(calls.opened).toHaveLength(2);
    const syms = out.opened.map(r => r.symbol).sort();
    expect(syms).toEqual(['BTC', 'ETH']);
  });

  it('multi-trade ON: session cap (maxConcurrentTrades) limits how many open at once', async () => {
    __resetMtfAutoForTests({
      config: {
        enabled: true, executionMode: 'paper', multiTradeMode: true, maxConcurrentTrades: 2,
        desks: { india: false, crypto: true },
      },
    });
    const { paper, calls } = fakePaper();
    const mk = (sym, px) => ({
      ok: true, symbol: sym, market: 'CRYPTO', mode: 'INTRADAY', label: '15m → 5m', holdMin: 45,
      superScore: 86, tier: 'STRONG', side: 'LONG', dir: 1, grade: 'A',
      triggerFired: true, dualAligned: true, counterTrend: false, tfFit: 'OK',
      autoEligible: true, autoBlockers: [],
      plan: { entry: px, stopLoss: px - 1, t1: px + 1, t2: px + 2 },
    });
    const board = {
      ok: true, market: 'CRYPTO', mode: 'INTRADAY', holdMin: 45, minScore: 75,
      rows: [mk('SOLUSDT', 100), mk('XRPUSDT', 2), mk('DOGEUSDT', 0.1)],
    };
    const out = await mtfAutoTick({ boards: { CRYPTO: board }, paper });
    expect(out.opened).toHaveLength(2);
    expect(calls.opened).toHaveLength(2);
  });

  it('universalLiveFloor: live mode with floor 65 opens a score-65 row that floor-80 would skip', async () => {
    __resetMtfAutoForTests({
      config: {
        enabled: true, executionMode: 'live', multiTradeMode: true, maxConcurrentTrades: 3,
        universalLiveFloor: 65, desks: { india: false, crypto: true },
      },
    });
    const { paper, calls } = fakePaper();
    const liveExecute = liveExec();
    const mk = (sym, score) => ({
      ok: true, symbol: sym, market: 'CRYPTO', mode: 'INTRADAY', label: '15m → 5m', holdMin: 45,
      superScore: score, tier: 'ACTION', side: 'LONG', dir: 1, grade: 'A',
      directionVerified: true, directionVerdict: 'VERIFIED',
      triggerFired: true, dualAligned: true, counterTrend: false, tfFit: 'OK',
      autoEligible: true, autoBlockers: [],
      plan: { entry: 100, stopLoss: 99, t1: 101, t2: 102 },
    });
    const board = {
      ok: true, market: 'CRYPTO', mode: 'INTRADAY', holdMin: 45, minScore: 65,
      rows: [mk('INJUSDT', 65)],
    };
    const out = await mtfAutoTick({
      boards: { CRYPTO: board }, paper, liveExecute,
      siteLiveByDesk: { crypto: true, india: false },
    });
    expect(out.opened).toHaveLength(1);
    expect(out.opened[0].executionMode).toBe('LIVE');
    expect(liveExecute).toHaveBeenCalledTimes(1);
  });

  it('universalLiveFloor legacy default 80: a score-65 row does NOT open in live mode', async () => {
    __resetMtfAutoForTests({
      config: {
        enabled: true, executionMode: 'live', multiTradeMode: true, maxConcurrentTrades: 3,
        desks: { india: false, crypto: true }, // universalLiveFloor omitted → default 80
      },
    });
    const { paper } = fakePaper();
    const liveExecute = liveExec();
    const mk = (sym, score) => ({
      ok: true, symbol: sym, market: 'CRYPTO', mode: 'INTRADAY', label: '15m → 5m', holdMin: 45,
      superScore: score, tier: 'ACTION', side: 'LONG', dir: 1, grade: 'A',
      triggerFired: true, dualAligned: true, counterTrend: false, tfFit: 'OK',
      autoEligible: true, autoBlockers: [],
      plan: { entry: 100, stopLoss: 99, t1: 101, t2: 102 },
    });
    const board = {
      ok: true, market: 'CRYPTO', mode: 'INTRADAY', holdMin: 45, minScore: 65,
      rows: [mk('INJUSDT', 65)],
    };
    const out = await mtfAutoTick({
      boards: { CRYPTO: board }, paper, liveExecute,
      siteLiveByDesk: { crypto: true, india: false },
    });
    expect(out.opened).toHaveLength(0);
    expect(liveExecute).not.toHaveBeenCalled();
  });

  it('P2.1 live-min-action-floor: a WATCH-tier live signal is blocked even with universalLiveFloor:50 + universalTradeAll', async () => {
    __resetMtfAutoForTests({
      config: {
        enabled: true, executionMode: 'live', multiTradeMode: true, maxConcurrentTrades: 3,
        universalTradeAll: true, universalLiveFloor: 50,
        desks: { india: false, crypto: true },
      },
    });
    const { paper } = fakePaper();
    const liveExecute = liveExec();
    // Exactly the real-board shape: WATCH-tier signal between ensemble scans —
    // main AI-BOARD signal unavailable + trigger fire pending + direction unverified.
    // P2.1: live commit floor is clamped to ACTION (65), so a score-60 WATCH row
    // must NOT open a live order even though the STORED floor is 50 + tradeAll.
    const mk = (sym, px) => ({
      ok: true, symbol: sym, market: 'CRYPTO', mode: 'INTRADAY', label: '15m → 5m', holdMin: 45,
      superScore: 60, tier: 'WATCH', side: 'LONG', dir: 1, grade: 'A',
      triggerFired: false, ensembleSignalAvailable: false, dualAligned: true,
      counterTrend: false, tfFit: 'OK',
      autoEligible: true,
      autoBlockers: ['trigger fire pending'],
      plan: { entry: px, stopLoss: px - 1, t1: px + 1, t2: px + 2 },
    });
    const board = {
      ok: true, market: 'CRYPTO', mode: 'INTRADAY', holdMin: 45, minScore: 50,
      rows: [mk('SUIUSDT', 10), mk('INJUSDT', 3)],
    };
    const out = await mtfAutoTick({
      boards: { CRYPTO: board }, paper, liveExecute,
      siteLiveByDesk: { crypto: true, india: false },
    });
    expect(out.opened).toHaveLength(0);
    expect(liveExecute).not.toHaveBeenCalled();
  });

  it('P2.1 live-min-action-floor: an ACTION-tier (score ≥ 65) live signal STILL opens even with stored floor:50', async () => {
    __resetMtfAutoForTests({
      config: {
        enabled: true, executionMode: 'live', multiTradeMode: true, maxConcurrentTrades: 3,
        universalTradeAll: true, universalLiveFloor: 50,
        desks: { india: false, crypto: true },
      },
    });
    const { paper } = fakePaper();
    const liveExecute = liveExec();
    const mk = (sym, px) => ({
      ok: true, symbol: sym, market: 'CRYPTO', mode: 'INTRADAY', label: '15m → 5m', holdMin: 45,
      superScore: 68, tier: 'ACTION', side: 'LONG', dir: 1, grade: 'A',
      directionVerified: true, directionVerdict: 'VERIFIED',
      triggerFired: true, ensembleSignalAvailable: true, dualAligned: true,
      counterTrend: false, tfFit: 'OK',
      autoEligible: true,
      autoBlockers: [],
      plan: { entry: px, stopLoss: px - 1, t1: px + 1, t2: px + 2 },
    });
    const board = {
      ok: true, market: 'CRYPTO', mode: 'INTRADAY', holdMin: 45, minScore: 50,
      rows: [mk('SUIUSDT', 10)],
    };
    const out = await mtfAutoTick({
      boards: { CRYPTO: board }, paper, liveExecute,
      siteLiveByDesk: { crypto: true, india: false },
    });
    expect(out.opened).toHaveLength(1);
    expect(out.opened[0].executionMode).toBe('LIVE');
    expect(liveExecute).toHaveBeenCalledTimes(1);
  });

  it('P2.1 live-min-action-floor: paper mode honours the stored floor (a score-60 paper row still opens)', async () => {
    __resetMtfAutoForTests({
      config: {
        enabled: true, executionMode: 'paper', multiTradeMode: true, maxConcurrentTrades: 3,
        universalTradeAll: true, universalLiveFloor: 50,
        desks: { india: false, crypto: true },
      },
    });
    const { paper } = fakePaper();
    const liveExecute = liveExec();
    // PAPER mode honours the stored floor (50) — a cleanly-eligible WATCH
    // row (score 60) opens as paper. This proves P2.1 clamps ONLY the live
    // commit floor, not paper. (universalTradeAll strips availability
    // blockers live-only, so a paper row must be cleanly eligible itself.)
    const mk = (sym, px) => ({
      ok: true, symbol: sym, market: 'CRYPTO', mode: 'INTRADAY', label: '15m → 5m', holdMin: 45,
      superScore: 60, tier: 'WATCH', side: 'LONG', dir: 1, grade: 'A',
      triggerFired: true, ensembleSignalAvailable: true, dualAligned: true,
      counterTrend: false, tfFit: 'OK',
      autoEligible: true,
      autoBlockers: [],
      plan: { entry: px, stopLoss: px - 1, t1: px + 1, t2: px + 2 },
    });
    const board = {
      ok: true, market: 'CRYPTO', mode: 'INTRADAY', holdMin: 45, minScore: 50,
      rows: [mk('SUIUSDT', 10)],
    };
    const out = await mtfAutoTick({
      boards: { CRYPTO: board }, paper, liveExecute,
      siteLiveByDesk: { crypto: false, india: false },
    });
    expect(out.opened).toHaveLength(1);
    expect(out.opened[0].executionMode).toBe('PAPER');
    expect(liveExecute).not.toHaveBeenCalled();
  });

  it('v21.35.7 universalTradeAll OFF (default): availability-blocked signals do NOT fire live', async () => {
    __resetMtfAutoForTests({
      config: {
        enabled: true, executionMode: 'live', multiTradeMode: true, maxConcurrentTrades: 3,
        universalLiveFloor: 50,
        desks: { india: false, crypto: true },
      },
    });
    const { paper } = fakePaper();
    const liveExecute = liveExec();
    const mk = (sym, px, over = {}) => ({
      ok: true, symbol: sym, market: 'CRYPTO', mode: 'INTRADAY', label: '15m → 5m', holdMin: 45,
      superScore: 60, tier: 'WATCH', side: 'LONG', dir: 1, grade: 'A',
      triggerFired: false, ensembleSignalAvailable: false, dualAligned: true,
      counterTrend: false, tfFit: 'OK',
      autoEligible: true, autoBlockers: ['trigger fire pending'],
      plan: { entry: px, stopLoss: px - 1, t1: px + 1, t2: px + 2 },
      ...over,
    });
    // Row 1: availability-blocked (must NOT fire without tradeAll).
    // Row 2: QUALITY-blocked — a quality autoBlocker must still block even with tradeAll.
    const board = {
      ok: true, market: 'CRYPTO', mode: 'INTRADAY', holdMin: 45, minScore: 50,
      rows: [
        mk('SUIUSDT', 10),
        { ...mk('INJUSDT', 3), autoBlockers: ['cost 0.7R ≥ 0.5R — fee-eaten setup'] },
      ],
    };
    const out = await mtfAutoTick({
      boards: { CRYPTO: board }, paper, liveExecute,
      siteLiveByDesk: { crypto: true, india: false },
    });
    expect(out.opened).toHaveLength(0);
    expect(liveExecute).not.toHaveBeenCalled();
  });

  it('legacy (multiTradeMode OFF): multi-symbol board still opens only ONE trade (regression guard)', async () => {
    __resetMtfAutoForTests({
      config: { enabled: true, executionMode: 'paper', desks: { india: false, crypto: true } },
    });
    const { paper, calls } = fakePaper();
    const mk = (sym, px, score) => ({
      ok: true, symbol: sym, market: 'CRYPTO', mode: 'INTRADAY', label: '15m → 5m', holdMin: 45,
      superScore: score, tier: 'STRONG', side: 'LONG', dir: 1, grade: 'A',
      triggerFired: true, dualAligned: true, counterTrend: false, tfFit: 'OK',
      autoEligible: true, autoBlockers: [],
      plan: { entry: px, stopLoss: px - 1, t1: px + 1, t2: px + 2 },
    });
    const board = {
      ok: true, market: 'CRYPTO', mode: 'INTRADAY', holdMin: 45, minScore: 75,
      rows: [mk('BTCUSDT', 100, 90), mk('ETHUSDT', 50, 84)],
    };
    const out = await mtfAutoTick({ boards: { CRYPTO: board }, paper });
    // legacy 1-trade-per-session: only the top-ranked row opens
    expect(out.opened).toHaveLength(1);
    expect(calls.opened).toHaveLength(1);
    expect(out.opened[0].symbol).toBe('BTC');
  });
});

describe('mtfAutoLink — time-stop', () => {
  beforeEach(() => { __resetMtfAutoForTests(); });

  it('closes a linked trade after its plan window (with grace)', async () => {
    const now = Date.now();
    __resetMtfAutoForTests({
      config: { enabled: true, desks: { india: false, crypto: true } },
      state: {
        dayCount: 1,
        book: [{
          paperId: 55, symbol: 'BTC', market: 'CRYPTO', side: 'LONG', score: 82, tier: 'STRONG',
          mode: 'INTRADAY', holdMin: 45, entry: 100, stopLoss: 99, t1: 101, t2: 102, qty: 1,
          riskINR: 1, notional: 100, openedAt: now - 50 * 60_000, dayKey: 'x',
          status: 'OPEN', closeReason: null, closedAt: null, pnl: null,
        }],
      },
    });
    const { paper, calls } = fakePaper();
    paper.open.push({ id: 55, symbol: 'BTC', market: 'CRYPTO', status: 'OPEN' });
    const out = await mtfAutoTick({ boards: {}, paper, quotes: { BTC: { price: 101 } } });
    expect(out.closed.map(c => c.symbol)).toContain('BTC');
    expect(calls.closed).toContain(55);
    const st = mtfAutoStatus();
    const rec = (st.book || []).find(b => b.paperId === 55);
    expect(rec?.status).toBe('CLOSED');
    expect(rec?.closeReason).toMatch(/TIME_STOP/);
    expect(st.events.some(e => e.kind === 'time-exit')).toBe(true);
  });

  it('young trades are NOT time-stopped', async () => {
    const now = Date.now();
    __resetMtfAutoForTests({
      config: { enabled: true },
      state: { book: [{ paperId: 61, symbol: 'BTC', market: 'CRYPTO', side: 'LONG', score: 80, tier: 'STRONG', holdMin: 45, entry: 100, stopLoss: 99, t1: 101, t2: 102, qty: 1, openedAt: now - 5 * 60_000, status: 'OPEN' }] },
    });
    const { paper, calls } = fakePaper();
    paper.open.push({ id: 61, symbol: 'BTC', market: 'CRYPTO', status: 'OPEN' });
    await mtfAutoTick({ boards: {}, paper });
    expect(calls.closed).toEqual([]);
  });

  it('setMtfAutoEnabled toggles persisted state', () => {
    expect(setMtfAutoEnabled(true).enabled).toBe(true);
    expect(mtfAutoStatus().enabled).toBe(true);
    expect(setMtfAutoEnabled(false).enabled).toBe(false);
  });
});

describe('mtfAutoLink — durable persistence + boot reload', () => {
  beforeEach(() => {
    __resetMtfAutoForTests();
    vi.mocked(durablePut).mockClear();
  });

  it('mirrors config + state to durable under their boot-restore basenames', () => {
    updateMtfAutoConfig({ enabled: true, minScore: 80 });
    const cfgCall = vi.mocked(durablePut).mock.calls.find(([f]) => f === 'mtf-auto-config.json');
    expect(cfgCall).toBeTruthy();
    expect((cfgCall![1] as { enabled?: boolean }).enabled).toBe(true);
    expect(typeof (cfgCall![1] as { updatedAt?: number }).updatedAt).toBe('number');

    recordPaperMtfBoardTrade({
      symbol: 'BTC', market: 'CRYPTO', side: 'LONG',
      entry: 100, stopLoss: 98, t1: 103, t2: 106, qty: 1,
    });
    const stateCall = vi.mocked(durablePut).mock.calls.find(([f]) => f === 'mtf-auto-state.json');
    expect(stateCall).toBeTruthy();
    expect(typeof (stateCall![1] as { updatedAt?: number }).updatedAt).toBe('number');

    const st = mtfAutoStatus();
    expect(st.bootedAt).toBeGreaterThan(0);
    expect(st.configSavedAt).toBeGreaterThan(0);
    expect(st.stateSavedAt).toBeGreaterThan(0);
  });

  it('reload hook rehydrates config + book after module-eval capture', () => {
    updateMtfAutoConfig({ enabled: true, minScore: 82, executionMode: 'live', riskCapsAcknowledged: true, riskCapsAckPhrase: 'I ACCEPT THE RISK CAPS' });
    recordPaperMtfBoardTrade({
      symbol: 'ETH', market: 'CRYPTO', side: 'SHORT',
      entry: 200, stopLoss: 205, t1: 190, t2: 180, qty: 1,
    });
    const before = mtfAutoStatus();
    expect(before.book.length).toBe(1);

    const out = __reloadMtfAutoForBoot({ restored: true });
    expect(out.restoredFromDurable).toBe(true);
    const after = mtfAutoStatus();
    expect(after.enabled).toBe(true);
    expect(after.minScore).toBe(82);
    expect(after.executionMode).toBe('live');
    expect(after.book.length).toBe(1);
    expect(after.restoredFromDurable).toBe(true);
    expect(after.bootedAt).toBeGreaterThanOrEqual(before.bootedAt);
  });

  it('missing disk files reload as honest defaults (not silent stale state)', () => {
    updateMtfAutoConfig({ enabled: true, minScore: 88 });
    try { fs.unlinkSync(path.join(TMP_DATA, 'mtf-auto-config.json')); } catch { /* absent */ }
    try { fs.unlinkSync(path.join(TMP_DATA, 'mtf-auto-state.json')); } catch { /* absent */ }
    const out = __reloadMtfAutoForBoot({ restored: false });
    expect(out.restoredFromDurable).toBe(false);
    const st = mtfAutoStatus();
    expect(st.enabled).toBe(false);
    expect(st.minScore).toBe(MTF_AUTO_DEFAULTS.minScore);
    expect(st.restoredFromDurable).toBe(false);
  });
});

// ============================================================
// v21.36.9 [METALS-ONLY XAU/XAG]
// ------------------------------------------------------------
// Operator contract: ONLY XAU (50x) + XAG (25x), live entry only when
// PAKKA direction + triggerFired + superScore ≥ 75. Two metals positions may
// coexist; no other symbol can ever be traded in this mode.
// ============================================================
describe('mtfAutoLink — v21.36.9 metals-only XAU/XAG lane', () => {
  beforeEach(() => { __resetMtfAutoForTests(); });

  function metalsRow(symbol, over = {}) {
    return {
      ok: true, symbol, market: 'METALS', mode: 'INTRADAY', label: '15m → 5m', holdMin: 45,
      superScore: 82, tier: 'STRONG', side: 'LONG', dir: 1, grade: 'A',
      directionVerified: true, directionVerdict: 'VERIFIED',
      triggerFired: true, dualAligned: true, counterTrend: false, tfFit: 'OK',
      // deliberately outside the generic candidate lane: the metals gate must
      // ignore autoEligible/autoBlockers and use its exact PAKKA+trigger+score.
      autoEligible: false, autoBlockers: ['generic availability noise'],
      plan: { entry: 3900, stopLoss: 3861, t1: 3978, t2: 4056 },
      ...over,
    };
  }
  function metalsBoard(rows) {
    return {
      ok: true, market: 'CRYPTO', mode: 'INTRADAY', holdMin: 45, minScore: 75,
      rows: [], metalsRows: [], metalsRowsAll: rows,
    };
  }
  const liveCtx = () => ({ siteLiveByDesk: { crypto: true, india: false } });
  const liveExec = () => vi.fn(async (order) => ({
    ok: true, orderId: `ord-${order.symbol}`,
    filled: {
      qty: 0.1, price: order.entry,
      stopLoss: order.stopLoss, t1: order.target1, t2: order.target2,
    },
    position: { id: `pos-${order.symbol}` },
  }));

  it('gate fires only on PAKKA + triggerFired + score ≥ 75', () => {
    expect(metalsSymbolOf('B-XAU_USDT')).toBe('XAU');
    expect(metalsSymbolOf('XAGUSDT')).toBe('XAG');
    expect(metalsSymbolOf('BTC')).toBeNull();
    expect(metalsLeverageFor(MTF_AUTO_DEFAULTS, 'XAU')).toBe(50);
    expect(metalsLeverageFor(MTF_AUTO_DEFAULTS, 'XAG')).toBe(25);

    expect(metalsEntryGate(metalsRow('XAU')).ok).toBe(true);
    expect(metalsEntryGate(metalsRow('XAU', { triggerFired: false })).ok).toBe(false);
    expect(metalsEntryGate(metalsRow('XAU', { directionVerified: false })).ok).toBe(false);
    expect(metalsEntryGate(metalsRow('XAU', { trapVeto: true })).ok).toBe(false);
    expect(metalsEntryGate(metalsRow('XAU', { superScore: 74 })).ok).toBe(false);
    // v21.36.11: opposing-wave hints on the trigger stay hard even if a
    // cached/reconstructed row skipped the board's direction certificate.
    expect(metalsEntryGate(metalsRow('XAU', { trigger: { reversalRisk: true } })).ok).toBe(false);
    expect(metalsEntryGate(metalsRow('XAU', { trigger: { opposingFlow: true } })).ok).toBe(false);
    expect(metalsEntryGate(metalsRow('XAG', { superScore: 75 })).ok).toBe(true);
  });

  it('metalsAutoCandidates never lets a non-metals row through', () => {
    const picks = metalsAutoCandidates(
      [metalsRow('BTC'), metalsRow('XAU'), metalsRow('XAG', { triggerFired: false })],
      MTF_AUTO_DEFAULTS,
      { now: Date.now() },
    );
    // BTC is dropped entirely; blocked XAG stays visible for the near-miss line.
    expect(picks.map(p => p.symbol)).toEqual(['XAU', 'XAG']);
    expect(picks[0].autoPickBlockers).toEqual([]);
    expect(picks[1].autoPickBlockers.join(' ')).toMatch(/trigger fire pending/);
  });

  it('LIVE: opens XAU 50x + XAG 25x together, ignores BTC, forces crypto desk', async () => {
    __resetMtfAutoForTests({
      config: {
        enabled: true, executionMode: 'live', metalsOnly: true, minScore: 75,
        walletAmountINR: 2584, desks: { india: true, crypto: true },
      },
    });
    expect(loadMtfAutoConfig().desks).toEqual({ india: false, crypto: true });
    const { paper, calls } = fakePaper();
    const live = liveExec();
    const out = await mtfAutoTick({
      boards: { CRYPTO: metalsBoard([metalsRow('XAU'), metalsRow('XAG'), metalsRow('BTC')]) },
      paper, liveExecute: live, ...liveCtx(), walletEquityINR: 2584, now: Date.now(),
    });
    expect(out.opened).toHaveLength(2);
    expect(calls.opened.map(o => o.symbol)).toEqual(['XAU', 'XAG']);
    expect(live).toHaveBeenCalledTimes(2);
    const bySym = Object.fromEntries(live.mock.calls.map(([order]) => [order.symbol, order]));
    expect(bySym.XAU.leverage).toBe(50);
    expect(bySym.XAG.leverage).toBe(25);
    // Wallet split: each metals row deploys at most 45% of the wallet.
    expect(bySym.XAU.walletDeployPct).toBeLessThanOrEqual(45);
    expect(bySym.XAG.walletDeployPct).toBeLessThanOrEqual(45);
    const st = mtfAutoStatus();
    expect(st.metalsOnly).toBe(true);
    expect(st.metals.leverage).toEqual({ XAU: 50, XAG: 25 });
    expect(st.note).toMatch(/METALS-ONLY/);
  });

  it('LIVE: a non-PAKKA XAU row is reported as a near-miss, never ordered', async () => {
    __resetMtfAutoForTests({
      config: { enabled: true, executionMode: 'live', metalsOnly: true, minScore: 75, walletAmountINR: 2584 },
    });
    const { paper, calls } = fakePaper();
    const live = liveExec();
    const out = await mtfAutoTick({
      boards: { CRYPTO: metalsBoard([
        metalsRow('XAU', { directionVerified: false, directionVerdict: 'WAIT-LONG', superScore: 60 }),
      ]) },
      paper, liveExecute: live, ...liveCtx(), walletEquityINR: 2584, now: Date.now(),
    });
    expect(out.opened).toHaveLength(0);
    expect(calls.opened).toHaveLength(0);
    expect(live).not.toHaveBeenCalled();
    expect(out.skipped.join(' ')).toMatch(/METALS-ONLY/);
    expect(out.skipped.join(' ')).toMatch(/direction not PAKKA|trigger fire pending|score/);
  });

  it('LIVE: second metals entry cannot exceed the metals concurrency cap', async () => {
    const now = Date.now();
    __resetMtfAutoForTests({
      config: { enabled: true, executionMode: 'live', metalsOnly: true, minScore: 75, metalsMaxConcurrent: 1 },
      state: {
        book: [{
          paperId: 201, liveOrderId: 'ord-xau', livePositionId: 'pos-xau',
          symbol: 'XAU', market: 'CRYPTO', execMarket: 'FUTURES', side: 'LONG',
          entry: 3900, stopLoss: 3861, t1: 3978, t2: 4056, qty: 0.1, notional: 390,
          openedAt: now, status: 'OPEN', executionMode: 'LIVE', traded: true,
        }],
      },
    });
    const { paper, calls } = fakePaper();
    const live = liveExec();
    const out = await mtfAutoTick({
      boards: { CRYPTO: metalsBoard([metalsRow('XAG')]) },
      paper, liveExecute: live, ...liveCtx(), walletEquityINR: 2584, now,
    });
    expect(out.opened).toHaveLength(0);
    expect(live).not.toHaveBeenCalled();
    // cap=1 degenerates to the legacy 1-trade lock (multi-trade is OFF)
    expect(out.skipped.join(' ')).toMatch(/1 session = 1 trade lock|multi-trade cap/);
  });
});

// ============================================================
// v21.36.10 [FALSE-CLOSE FIREWALL]
// ------------------------------------------------------------
// Live incident: XAG was still OPEN on CoinDCX (activePos -6.236, native
// SL/TP armed) while a partial `/positions` snapshot made the deep-monitor
// sync stamp its book row EXCHANGE_POSITION_CLOSED. Absence from a snapshot
// is NOT flat evidence — only an explicit exchange row with activePos 0 is.
// ============================================================
describe('mtfAutoLink — v21.36.10 exchange reconciliation false-close firewall', () => {
  const NOW = 1794579400000;

  function seedOpenXag() {
    __resetMtfAutoForTests({
      config: { enabled: true, executionMode: 'live', metalsOnly: true, desks: { india: false, crypto: true } },
      state: {
        book: [{
          paperId: 54, liveOrderId: 'ord-xag', livePositionId: 'pos-xag',
          symbol: 'XAG', pair: 'B-XAG_USDT', market: 'CRYPTO', execMarket: 'FUTURES',
          side: 'SHORT', entry: 49.77, stopLoss: 50.17, t1: 49.29, t2: 48.97,
          qty: 6.236, notional: 31657.74, leverage: 25,
          openedAt: NOW - 10 * 60_000, status: 'OPEN', executionMode: 'LIVE', traded: true,
        }],
      },
    });
  }
  const xagRow = () => mtfAutoStatus().book.find(b => b.paperId === 54);

  it('an EMPTY authoritative snapshot cannot close a still-open LIVE row', () => {
    seedOpenXag();
    syncCoinDcxActivePositionsToDeepMonitor([], {
      authoritativeExchangeList: true, now: NOW,
    });
    expect(xagRow()?.status).toBe('OPEN');
  });

  it('a PARTIAL snapshot (other symbol present, XAG missing) cannot close XAG', () => {
    seedOpenXag();
    syncCoinDcxActivePositionsToDeepMonitor([
      { id: 'pos-xau', pair: 'B-XAU_USDT', symbol: 'XAU', side: 'SHORT', qty: 0.1, entry: 3900, ltp: 3900, leverage: 50 },
    ], {
      authoritativeExchangeList: true,
      // XAU's raw row is absent too, so no symbol has positive flat proof.
      flatConfirmedSyms: [],
      observedActiveSymbols: ['XAU'],
      now: NOW,
    });
    expect(xagRow()?.status).toBe('OPEN');
  });

  it('an exchange-reported OPEN symbol (incomplete normalised row) protects its book row', () => {
    seedOpenXag();
    syncCoinDcxActivePositionsToDeepMonitor([], {
      authoritativeExchangeList: true,
      // raw /positions row had activePos != 0 but avgPrice/markPrice missing
      flatConfirmedSyms: [],
      observedActiveSymbols: ['XAG'],
      now: NOW,
    });
    expect(xagRow()?.status).toBe('OPEN');
  });

  it('only an explicit exchange row with activePos 0 (flat proof) closes the row', () => {
    seedOpenXag();
    syncCoinDcxActivePositionsToDeepMonitor([], {
      authoritativeExchangeList: true,
      flatConfirmedSyms: ['XAG'],
      observedActiveSymbols: [],
      now: NOW,
    });
    const row = xagRow();
    expect(row?.status).toBe('CLOSED');
    expect(row?.closeReason).toBe('EXCHANGE_POSITION_CLOSED');
    expect(row?.superAgentState).toBe('IDLE');
  });

  // v21.36.11 [SYMBOL-FORM CANONICALISATION]: a live exchange row spelled as
  // `B-XAG_USDT` must protect the base-symbol book row even if a contradictory
  // flat proof for `XAG` is present in the same snapshot (active wins).
  it('pair-form observed symbols protect the base book row from a contradictory flat proof', () => {
    seedOpenXag();
    syncCoinDcxActivePositionsToDeepMonitor([], {
      authoritativeExchangeList: true,
      flatConfirmedSyms: ['XAG'],
      observedActiveSymbols: ['B-XAG_USDT'],
      now: NOW,
    });
    expect(xagRow()?.status).toBe('OPEN');
  });

  it('pair-form flat proof still closes the base-symbol book row', () => {
    seedOpenXag();
    syncCoinDcxActivePositionsToDeepMonitor([], {
      authoritativeExchangeList: true,
      flatConfirmedSyms: ['B-XAG_USDT'],
      observedActiveSymbols: [],
      now: NOW,
    });
    expect(xagRow()?.status).toBe('CLOSED');
    expect(xagRow()?.closeReason).toBe('EXCHANGE_POSITION_CLOSED');
  });

  it('a legacy concatenated book symbol (XAGUSDT) matches base-symbol flat proof', () => {
    __resetMtfAutoForTests({
      config: { enabled: true, executionMode: 'live', metalsOnly: true, desks: { india: false, crypto: true } },
      state: {
        book: [{
          paperId: 55, liveOrderId: 'ord-xag2', livePositionId: 'pos-xag2',
          symbol: 'XAGUSDT', pair: 'B-XAG_USDT', market: 'CRYPTO', execMarket: 'FUTURES',
          side: 'SHORT', entry: 49.77, stopLoss: 50.17, t1: 49.29, t2: 48.97,
          qty: 6.236, notional: 31657.74, leverage: 25,
          openedAt: NOW - 10 * 60_000, status: 'OPEN', executionMode: 'LIVE', traded: true,
        }],
      },
    });
    syncCoinDcxActivePositionsToDeepMonitor([], {
      authoritativeExchangeList: true,
      flatConfirmedSyms: ['XAG'],
      observedActiveSymbols: [],
      now: NOW,
    });
    expect(mtfAutoStatus().book.find(b => b.paperId === 55)?.status).toBe('CLOSED');
  });

  it('adoption re-anchors a legacy concatenated row instead of duplicating it', () => {
    __resetMtfAutoForTests({
      config: { enabled: true, executionMode: 'live', metalsOnly: true, desks: { india: false, crypto: true } },
      state: {
        book: [{
          paperId: 56, liveOrderId: 'ord-xag3', livePositionId: 'pos-xag3',
          symbol: 'XAGUSDT', pair: 'B-XAG_USDT', market: 'CRYPTO', execMarket: 'FUTURES',
          side: 'SHORT', entry: 49.77, stopLoss: 50.17, t1: 49.29, t2: 48.97,
          qty: 6.236, notional: 31657.74, leverage: 25,
          openedAt: NOW - 10 * 60_000, status: 'OPEN', executionMode: 'LIVE', traded: true,
        }],
      },
    });
    syncCoinDcxActivePositionsToDeepMonitor([
      { id: 'pos-xag-live', pair: 'B-XAG_USDT', symbol: 'XAG', side: 'SHORT', qty: 6.236, entry: 49.77, ltp: 49.77, leverage: 25 },
    ], {
      authoritativeExchangeList: true,
      flatConfirmedSyms: [],
      observedActiveSymbols: ['XAG'],
      now: NOW,
    });
    const rows = mtfAutoStatus().book.filter(b => b.paperId === 56);
    expect(rows).toHaveLength(1);
    expect(rows[0].symbol).toBe('XAG');
    expect(rows[0].livePositionId).toBe('pos-xag-live');
    expect(rows[0].status).toBe('OPEN');
  });
});
