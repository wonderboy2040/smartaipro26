// ============================================================
// test/mtfAutoEntry.test.ts — v21.16.0 MTF AUTO-LINK ENGINE
// Contract test (optionsAutoEntry pattern — hoisted mocks):
//   1. disabled default → tick no-op
//   2. toggle ON persists + status shape
//   3. 75+ ARMED eligible signal → openPaperTrade EXACT MTF levels
//      (entry/SL/TP1/TP2 + label marker + market)
//   4. WAIT / CONFLICT / stale / score<75 signals → NO entry
//   5. quota / cooldown / per-symbol caps + already-open dedupe
//   6. TIME-STOP: hold-window expire → closePaperTrade w/ reason
//      'MTF-TIME-EXIT'
// ============================================================
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, '..');

// ---- shared mocks (hoisted) ----
vi.mock('../server/intraday/time.js', () => ({
  isNseMarketOpen: vi.fn(() => true),
  freshEntriesAllowedFor: vi.fn(() => true),
  istMinutes: vi.fn(() => 10 * 60),
}));

const openPaperTradeMock = vi.fn(() => ({ ok: true, trade: { id: 42 } }));
const closePaperTradeMock = vi.fn(() => ({ ok: true, trade: { id: 7 } }));
let _paperOpen: Array<Record<string, unknown>> = [];
vi.mock('../server/intraday/paperTrading.js', () => ({
  openPaperTrade: (...a: unknown[]) => openPaperTradeMock(...a),
  closePaperTrade: (...a: unknown[]) => closePaperTradeMock(...a),
  getPaperSummary: vi.fn(() => ({ open: _paperOpen })),
}));

// v21.16.0 [LIVE-FIX] mocks: CoinDCX INR tickers (crypto watcher-parity
// scale) + usdInr + Groww quote
let _tickers: Array<{ market: string; last_price: string | number }> = [];
vi.mock('../server/cryptoStream.js', () => ({
  fetchCoinDcxTickers: vi.fn(async () => _tickers),
}));
vi.mock('../server/ai/lib/usdinr.js', () => ({
  usdInrFallback: vi.fn(() => 84),
  usdInrLastKnown: vi.fn(() => null),
  usdInrRecord: vi.fn(),
}));
let _growwQuote: { price: number } | null = null;
vi.mock('../server/ai/growwQuote.js', () => ({
  fetchGrowwNseQuote: vi.fn(async () => _growwQuote),
}));

// board mock — per-test settable
let _board: Record<string, unknown> | null = null;
vi.mock('../server/ai/mtfBoard.js', () => ({
  getMtfBoard: vi.fn(async () => _board),
  MTF_MODES: {
    intraday: { key: 'intraday', label: 'Intraday', analysisTf: '15m', actionTf: '5m', analysisTfMin: 15, actionTfMin: 5, holdWindowMin: [15, 20] },
    swing: { key: 'swing', label: 'Swing (1–1.5hr)', analysisTf: '1h', actionTf: '15m', analysisTfMin: 60, actionTfMin: 15, holdWindowMin: [60, 90] },
  },
  MTF_AUTO_BAR: 75,
}));

vi.mock('../server/ai/coindcxOrders.js', () => ({
  loadConfig: vi.fn(() => ({ killSwitch: false })),
  loadJournal: vi.fn(() => ({ entries: [] })),
  withJournalLock: vi.fn(),
  pushEntry: vi.fn(),
  todayIST: vi.fn(() => '2026-10-15'),
  dailyStats: vi.fn(() => ({})),
  loadProTraderConfig: vi.fn(() => ({})),
}));

import {
  mtfAutoTick, mtfAutoStatus, setMtfAutoEnabled, __resetMtfAutoForTests,
} from '../server/ai/mtfAutoEntry.js';

const cfgFile = path.join(APP_ROOT, 'server', 'data', 'mtf-auto-config.json');
const stateFile = path.join(APP_ROOT, 'server', 'data', 'mtf-auto-state.json');
let cfgBak: string | null = null;
let stateBak: string | null = null;

const DEPS = {}; // minimal deps — mocks decide behavior

/** ek qualifying ARMED 78-score LONG signal ka board */
const ARMED_BOARD = (score = 78, state = 'ARMED', stale = false) => ({
  ok: true, market: 'INDIA', mode: 'intraday',
  modeCfg: { label: 'Intraday', analysisTf: '15m', actionTf: '5m', holdWindowMin: [15, 20] },
  signals: [{
    symbol: 'TCS', market: 'INDIA', mode: 'intraday', side: 'LONG', state,
    confluenceScore: 72, ltp: 3900, stale,
    super: { aiScore: score, tier: 'STRONG' },
    autoTrade: { eligible: state === 'ARMED' && !stale && score >= 75, bar: 75, reason: null },
    action: {
      tf: '5m', trigger: 'PULLBACK', state, entry: 3900, entryZone: [3895, 3905],
      stopLoss: 3870, target1: 3945, target2: 3975, rr: 2.5, riskPct: 0.77,
      timing: { quality: 'GOOD', note: 'ok' },
    },
  }],
});

beforeEach(() => {
  vi.clearAllMocks();
  _board = null;
  _paperOpen = [];
  _tickers = [];
  _growwQuote = null;
  cfgBak = fs.existsSync(cfgFile) ? fs.readFileSync(cfgFile, 'utf8') : null;
  stateBak = fs.existsSync(stateFile) ? fs.readFileSync(stateFile, 'utf8') : null;
});
afterEach(() => {
  if (cfgBak != null) fs.writeFileSync(cfgFile, cfgBak); else { try { fs.unlinkSync(cfgFile); } catch { /* */ } }
  if (stateBak != null) fs.writeFileSync(stateFile, stateBak); else { try { fs.unlinkSync(stateFile); } catch { /* */ } }
  __resetMtfAutoForTests();
});

describe('v21.16.0 MTF AUTO-LINK — toggle & guards', () => {
  it('disabled by default — tick is a no-op', async () => {
    setMtfAutoEnabled(false);
    const r = await mtfAutoTick(DEPS, undefined);
    expect(r).toEqual({ ok: true, idle: 'disabled' });
    expect(openPaperTradeMock).not.toHaveBeenCalled();
  });

  it('status shape: enabled + cfg + autoBar 75 + quota fields', () => {
    setMtfAutoEnabled(true);
    const st = mtfAutoStatus();
    expect(st.ok).toBe(true);
    expect(st.enabled).toBe(true);
    expect(st.autoBar).toBe(75);
    expect(st.cfg.minScore).toBe(75);
    expect(st.cfg.quotaPerDay).toBeGreaterThanOrEqual(1);
    expect(st.cfg.cooldownMin).toBeGreaterThanOrEqual(1);
    expect(st.entriesToday).toBe(0);
    expect(typeof st.quotaLeft).toBe('number');
  });

  it('kill-switch ON → idle (koi entry nahi)', async () => {
    setMtfAutoEnabled(true);
    const { loadConfig } = await import('../server/ai/coindcxOrders.js');
    (loadConfig as ReturnType<typeof vi.fn>).mockReturnValueOnce({ killSwitch: true });
    _board = ARMED_BOARD();
    const r = await mtfAutoTick(DEPS, undefined);
    expect(r).toEqual({ ok: true, idle: 'kill-switch' });
    expect(openPaperTradeMock).not.toHaveBeenCalled();
  });

  it('quota done → idle quota-done', async () => {
    setMtfAutoEnabled(true);
    // quota bhar do — HAR tick me alag symbol (cooldown + per-symbol
    // caps otherwise entry rok dete hain — engine discipline sahi hai)
    const syms = ['TCS', 'INFY', 'SBIN', 'RELIANCE', 'HDFCBANK', 'ICICIBANK'];
    for (const s of syms) {
      const b: any = ARMED_BOARD(80);
      b.signals[0].symbol = s;
      _board = b;
      _paperOpen = []; // har entry ke baad summary clean (mock)
      await mtfAutoTick(DEPS, undefined);
    }
    expect(mtfAutoStatus().entriesToday).toBeGreaterThanOrEqual(6);
    const r = await mtfAutoTick(DEPS, undefined);
    expect((r as { idle?: string }).idle).toBe('quota-done');
  });
});

describe('v21.16.0 MTF AUTO-LINK — the qualifying path', () => {
  it('75+ ARMED eligible signal → openPaperTrade EXACT MTF levels + label marker + notional sizing', async () => {
    setMtfAutoEnabled(true);
    _board = ARMED_BOARD(78);
    const r = await mtfAutoTick(DEPS, undefined);
    expect((r as { ok?: boolean }).ok).toBe(true);
    expect((r as { opened?: unknown }).opened).toBeTruthy();
    expect(openPaperTradeMock).toHaveBeenCalledTimes(1);
    const call = openPaperTradeMock.mock.calls[0][0];
    expect(call.symbol).toBe('TCS');
    expect(call.direction).toBe('LONG');
    expect(call.entry).toBe(3900);          // EXACT action-plan entry
    expect(call.stopLoss).toBe(3870);       // EXACT action-plan SL
    expect(call.target1).toBe(3945);        // TP1 (1.5R)
    expect(call.target2).toBe(3975);        // TP2 (2.5R)
    expect(call.market).toBe('INDIA');
    expect(call.qty).toBeGreaterThanOrEqual(1);   // notional 20000/3900 = 5
    expect(String(call.label)).toContain('MTF');
    expect(String(call.label)).toContain('AUTO');
    expect(String(call.label)).toContain('78');
    // state accounting
    const st = mtfAutoStatus();
    expect(st.entriesToday).toBe(1);
    expect(st.quotaLeft).toBe(st.cfg.quotaPerDay - 1);
    expect(st.lastEntry?.symbol).toBe('TCS');
    expect(st.lastEntry?.aiScore).toBe(78);
    expect(st.lastEntry?.holdWindowMin).toEqual([15, 20]);
  });

  it('cooldown — same symbol dobara turant entry nahi', async () => {
    setMtfAutoEnabled(true);
    _board = ARMED_BOARD(80);
    await mtfAutoTick(DEPS, undefined); // entry ho gayi
    _board = ARMED_BOARD(80);
    const r2 = await mtfAutoTick(DEPS, undefined);
    expect(openPaperTradeMock).toHaveBeenCalledTimes(1); // dobara nahi
    expect((r2 as { idle?: string }).idle).toBe('no-qualifying-signal');
  });

  it('already-open same symbol+side → skip (dedupe)', async () => {
    setMtfAutoEnabled(true);
    _paperOpen = [{ symbol: 'TCS', direction: 'LONG' }];
    _board = ARMED_BOARD(80);
    const r = await mtfAutoTick(DEPS, undefined);
    expect(openPaperTradeMock).not.toHaveBeenCalled();
    expect((r as { idle?: string }).idle).toBe('no-qualifying-signal');
  });

  it('WAIT signal (score irrelevant) → koi entry nahi', async () => {
    setMtfAutoEnabled(true);
    _board = ARMED_BOARD(90, 'WAIT');
    const r = await mtfAutoTick(DEPS, undefined);
    expect(openPaperTradeMock).not.toHaveBeenCalled();
    expect((r as { idle?: string }).idle).toBe('no-qualifying-signal');
  });

  it('stale ARMED signal → skip (session gate)', async () => {
    setMtfAutoEnabled(true);
    _board = ARMED_BOARD(90, 'ARMED', true);
    const r = await mtfAutoTick(DEPS, undefined);
    expect(openPaperTradeMock).not.toHaveBeenCalled();
    expect((r as { idle?: string }).idle).toBe('no-qualifying-signal');
  });

  it('score < 75 (74) → skip — bar honor hota hai', async () => {
    setMtfAutoEnabled(true);
    _board = ARMED_BOARD(74);
    const r = await mtfAutoTick(DEPS, undefined);
    expect(openPaperTradeMock).not.toHaveBeenCalled();
    expect((r as { idle?: string }).idle).toBe('no-qualifying-signal');
  });

  it('autoTrade.eligible=false (levels incomplete) → skip', async () => {
    setMtfAutoEnabled(true);
    const b: any = ARMED_BOARD(80);
    b.signals[0].autoTrade = { eligible: false, bar: 75, reason: 'entry/SL/TP1 blueprint incomplete' };
    _board = b;
    const r = await mtfAutoTick(DEPS, undefined);
    expect(openPaperTradeMock).not.toHaveBeenCalled();
    expect((r as { idle?: string }).idle).toBe('no-qualifying-signal');
  });

  it('SHORT CRYPTO signal → INR-CONVERTED levels (watcher parity) + label ₹ marker', async () => {
    setMtfAutoEnabled(true);
    const b: any = ARMED_BOARD(76);
    b.signals[0] = {
      ...b.signals[0], symbol: 'INFY', side: 'SHORT',
      market: 'CRYPTO',
      action: { ...b.signals[0].action, entry: 1500, stopLoss: 1520, target1: 1470, target2: 1450 },
    };
    b.market = 'CRYPTO';
    // CoinDCX INR ticker: INFYINR @ 126000 → ratio 84 (=usdInr, parity OK)
    _tickers = [{ market: 'INFYINR', last_price: 126000 }];
    _growwQuote = null;
    _board = b;
    const r = await mtfAutoTick(DEPS, undefined);
    expect((r as { opened?: unknown }).opened).toBeTruthy();
    const call = openPaperTradeMock.mock.calls[0][0];
    expect(call.direction).toBe('SHORT');
    expect(call.market).toBe('CRYPTO');
    // EXACT INR-converted levels (R:R geometry preserved)
    expect(call.entry).toBe(126000);      // 1500 × 84
    expect(call.stopLoss).toBe(127680);   // 1520 × 84
    expect(call.target1).toBe(123480);    // 1470 × 84
    expect(call.target2).toBe(121800);    // 1450 × 84
    expect(call.qty).toBeGreaterThanOrEqual(0.0001); // 20000/126000 ≈ 0.1587
    expect(String(call.label)).toContain('₹');
    expect(String(call.label)).toContain('MTF');
  });

  it('CRYPTO bina CoinDCX ticker (POL case) → honest skip — watcher price nahi kar sakta', async () => {
    setMtfAutoEnabled(true);
    const b: any = ARMED_BOARD(90);
    b.signals[0] = { ...b.signals[0], symbol: 'POL', market: 'CRYPTO' };
    b.market = 'CRYPTO';
    _tickers = []; // POLINR listed nahi hai
    _board = b;
    const r = await mtfAutoTick(DEPS, undefined);
    expect(openPaperTradeMock).not.toHaveBeenCalled();
    expect((r as { idle?: string }).idle).toBe('no-qualifying-signal');
  });

  it('CRYPTO parity anomaly (INR/USDT ratio ~150 vs USDINR 84) → skip', async () => {
    setMtfAutoEnabled(true);
    const b: any = ARMED_BOARD(90);
    b.signals[0] = { ...b.signals[0], symbol: 'ETH', market: 'CRYPTO' };
    b.market = 'CRYPTO';
    _tickers = [{ market: 'ETHINR', last_price: 585000 }]; // 585000/3900 = 150 — anomalous
    _board = b;
    const r = await mtfAutoTick(DEPS, undefined);
    expect(openPaperTradeMock).not.toHaveBeenCalled();
    expect((r as { idle?: string }).idle).toBe('no-qualifying-signal');
  });

  it('INDIA stale-board parity (live quote >5% door) → stale-board-skip', async () => {
    setMtfAutoEnabled(true);
    _board = ARMED_BOARD(80);
    _growwQuote = { price: 4200 }; // board entry 3900 vs live 4200 = 7.7% door
    const r = await mtfAutoTick(DEPS, undefined);
    expect(openPaperTradeMock).not.toHaveBeenCalled();
    expect(String((r as { idle?: string }).idle)).toContain('stale-board-skip');
    expect(String((r as { idle?: string }).idle)).toContain('TCS');
  });
});

describe('v21.16.0 MTF TIME-STOP (hold-window discipline)', () => {
  it('window-expired MTF AUTO trade → closePaperTrade w/ reason MTF-TIME-EXIT', async () => {
    setMtfAutoEnabled(true);
    // 30 min purana intraday trade (window 15-20m + 2m grace = 22m)
    _paperOpen = [{
      id: 7, symbol: 'TCS', direction: 'LONG', label: 'MTF INTRADAY · SUPER 78 · AUTO',
      openedAt: Date.now() - 30 * 60_000, lastPrice: 3910,
    }];
    _board = ARMED_BOARD(74); // koi nayi entry nahi — sirf time-exit
    const r = await mtfAutoTick(DEPS, undefined);
    expect(closePaperTradeMock).toHaveBeenCalledTimes(1);
    expect(closePaperTradeMock.mock.calls[0][0]).toBe(7);
    expect(closePaperTradeMock.mock.calls[0][2]).toBe('MTF-TIME-EXIT');
    expect(openPaperTradeMock).not.toHaveBeenCalled();
    expect((r as { idle?: string }).idle).toBe('time-exit-only');
    expect(mtfAutoStatus().timeExits).toBe(1);
  });

  it('window ke ANDAR wala trade → close NAHI hota', async () => {
    setMtfAutoEnabled(true);
    _paperOpen = [{
      id: 8, symbol: 'TCS', direction: 'LONG', label: 'MTF INTRADAY · SUPER 78 · AUTO',
      openedAt: Date.now() - 10 * 60_000, lastPrice: 3910, // 10m < 22m
    }];
    _board = ARMED_BOARD(74);
    await mtfAutoTick(DEPS, undefined);
    expect(closePaperTradeMock).not.toHaveBeenCalled();
  });

  it('non-MTF manual trade → time-stop touch NAHI hota', async () => {
    setMtfAutoEnabled(true);
    _paperOpen = [{
      id: 9, symbol: 'SBIN', direction: 'LONG', label: null,
      openedAt: Date.now() - 3 * 3600_000, lastPrice: 800,
    }];
    _board = ARMED_BOARD(74);
    await mtfAutoTick(DEPS, undefined);
    expect(closePaperTradeMock).not.toHaveBeenCalled();
  });
});
