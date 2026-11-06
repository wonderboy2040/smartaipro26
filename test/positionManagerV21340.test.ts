// ============================================================
// test/positionManagerV21340.test.ts — v21.34.0 exec-stack fixes
// ------------------------------------------------------------
// Locks:
//   1. GIVE-BACK R-BASE: _unrealizedR ab PURE PRICE-R hai — T1/T2 partials
//      ke baad bhi SAME base; runner bina price-retrace ke force-close
//      NAHI hota (pehle peak pre-trim qty base par vs current post-trim
//      → trims hi "retrace" ban jate the).
//   2. T2 %-ANCHOR: T2 reduce ORIGINAL qty ka 30% (capped at current) —
//      runner exactly 30% rehta hai (documented contract), 42% nahi.
//   3. HYDRATE STAGE RESTORE: T1_HIT/RUNNER + qty/sl/peak/candles journal
//      row se restore — restart pe double partial NAHI.
//   4. JOURNAL WRITE-BACK: PM close/reduce journalSync hook ko verbatim
//      actions deta hai (close/reduce/ladder-state) — wiring layer test.
//   5. NO SILENT SIDE: non-canonical port side → flatten + refuse.
// ============================================================
import { describe, it, expect } from 'vitest';
import { PositionManager } from '../server/exec/positionManager.js';
import { PaperPort } from '../server/exec/port.js';

function _signal(over = {}) {
  return {
    pair: 'B-BTC_USDT', symbol: 'BTC', side: 'LONG', ltp: 100,
    superIntel: { tier: 'STRONG', aiScore: 85 }, grade: 'STRONG',
    __riskPct: 1,
    ...over,
  };
}
function _plan(over = {}) {
  return { entry: 100, stopLoss: 98, target1: 102, target2: 104, ...over };
}

describe('v21.34.0 [GIVE-BACK R-BASE] — pure price-R', () => {
  it('T1+T2 partials ke baad flat price pe give-back FIRE nahi hota', async () => {
    const port = new PaperPort({ startingEquityUSDT: 1000 });
    const pm = new PositionManager({ port, cfg: { givebackArmR: 1.5, givebackPct: 35 } });
    const r = await pm.protectionFirstEntry({ signal: _signal(), plan: _plan() });
    expect(r.ok).toBe(true);
    // gap move to 108 (4R) — T1 fires (40% reduce)
    let actions = await pm.tick({ pricesByPair: { 'B-BTC_USDT': 108 } });
    expect(actions.some(a => a.kind === 't1')).toBe(true);
    // same tick-level price again — T2 fires (30% of ORIGINAL)
    actions = await pm.tick({ pricesByPair: { 'B-BTC_USDT': 108 } });
    expect(actions.some(a => a.kind === 't2')).toBe(true);
    // price HOLDS at 108 (koi retrace NAHI) — runner survive kare
    actions = await pm.tick({ pricesByPair: { 'B-BTC_USDT': 108 } });
    expect(actions.some(a => a.kind === 'giveback')).toBe(false);
    // aur genuine 35%+ retrace (108 → 105 = 4R → 2.5R) pe give-back FIRE ho
    actions = await pm.tick({ pricesByPair: { 'B-BTC_USDT': 105 } });
    expect(actions.some(a => a.kind === 'giveback')).toBe(true);
  });

  it('_unrealizedR qty-independent hai — partial ke baad bhi same price = same R', async () => {
    const port = new PaperPort({ startingEquityUSDT: 1000 });
    const pm = new PositionManager({ port });
    await pm.protectionFirstEntry({ signal: _signal(), plan: _plan() });
    const st = pm._stateForTests()[0];
    expect(pm._unrealizedR(st, 102)).toBeCloseTo(1.0, 5); // 1R at T1
    // partials simulate karo (T1 40% + T2 30% of orig) — price-R unchanged
    st.qty = st.qty * 0.3; // runner-only book
    expect(pm._unrealizedR(st, 102)).toBeCloseTo(1.0, 5);
    expect(pm._unrealizedR(st, 104)).toBeCloseTo(2.0, 5);
  });
});

describe('v21.34.0 [T2 %-ANCHOR] — T2 books 30% of ORIGINAL', () => {
  it('T2 reduceQty = origQty × exitT2Pct% (current se zyada nahi)', async () => {
    const port = new PaperPort({ startingEquityUSDT: 1000 });
    const pm = new PositionManager({ port, cfg: { exitT1Pct: 40, exitT2Pct: 30 } });
    await pm.protectionFirstEntry({ signal: _signal(), plan: _plan() });
    const st0 = pm._stateForTests()[0];
    const origQty = st0.qty;
    await pm.tick({ pricesByPair: { 'B-BTC_USDT': 102 } }); // T1: 40% reduce
    let actions = await pm.tick({ pricesByPair: { 'B-BTC_USDT': 104 } }); // T2
    const t2Act = actions.find(a => a.kind === 't2');
    expect(t2Act).toBeTruthy();
    expect(t2Act.reduceQty).toBeGreaterThan(origQty * 0.30 - 0.001);
    expect(t2Act.reduceQty).toBeLessThan(origQty * 0.30 + 0.001);
    // runner = origQty − T1(40%) − T2(30%) = 30% of original
    const st1 = pm._stateForTests().find(s => s.id === st0.id);
    expect(st1).toBeTruthy();
    expect(st1.qty).toBeGreaterThan(origQty * 0.30 - 0.001);
    expect(st1.qty).toBeLessThan(origQty * 0.30 + 0.001);
  });
});

describe('v21.34.0 [HYDRATE STAGE RESTORE] — restart-safe ladder', () => {
  it('T1_HIT row hydrate pe wapas T1_HIT hi hota hai (double partial nahi)', () => {
    const port = new PaperPort({ startingEquityUSDT: 1000 });
    const pm = new PositionManager({ port });
    const n = pm.hydrateFromJournal([
      {
        id: 'pos-1', pair: 'B-BTC_USDT', symbol: 'BTC', market: 'FUTURES', side: 'LONG',
        source: 'exec-enter', execManaged: true, status: 'OPEN',
        entryPrice: 100, qty: 0.6, origQty: 1.0, sl: 100.05, stage: 'T1_HIT',
        peakUnrealizedR: 1.2, candlesSeen: 5, tp: 102, tp2: 104, openedAt: Date.now(),
      },
    ]);
    expect(n).toBe(1);
    const st = pm._stateForTests()[0];
    expect(st.stage).toBe('T1_HIT');           // ENTRY pe revert NAHI
    expect(st.qty).toBeCloseTo(0.6, 6);        // ORIGINAL qty se re-inflate NAHI
    expect(st.sl).toBeCloseTo(100.05, 6);      // BE SL preserve
    expect(st.peakUnrealizedR).toBeCloseTo(1.2, 6);
    expect(st.candlesSeen).toBe(5);
    expect(st.origQty).toBeCloseTo(1.0, 6);
  });

  it('RUNNER row hydrate pe RUNNER rehta hai, qty/SL/trail state ke saath', () => {
    const port = new PaperPort({ startingEquityUSDT: 1000 });
    const pm = new PositionManager({ port });
    pm.hydrateFromJournal([
      {
        id: 'pos-2', pair: 'B-ETH_USDT', symbol: 'ETH', market: 'FUTURES', side: 'SHORT',
        source: 'exec-enter', execManaged: true, status: 'OPEN',
        entryPrice: 200, qty: 0.3, origQty: 1.0, sl: 198.5, stage: 'RUNNER',
        peakUnrealizedR: 2.4, candlesSeen: 9, tp: 198, tp2: 196, openedAt: Date.now(),
      },
    ]);
    const st = pm._stateForTests()[0];
    expect(st.stage).toBe('RUNNER');
    expect(st.side).toBe('SHORT');
    expect(st.qty).toBeCloseTo(0.3, 6);
    expect(st.sl).toBeCloseTo(198.5, 6);
  });

  it('non-canonical side row hydrate refuse (no silent LONG/SHORT)', () => {
    const port = new PaperPort({ startingEquityUSDT: 1000 });
    const pm = new PositionManager({ port });
    const n = pm.hydrateFromJournal([
      {
        id: 'pos-3', pair: 'B-X_USDT', source: 'exec-enter', execManaged: true, status: 'OPEN',
        entryPrice: 100, qty: 1, sl: 98, side: 'sideways', openedAt: Date.now(),
      },
    ]);
    expect(n).toBe(0); // honest skip — direction unknown
    expect(pm._stateForTests().length).toBe(0);
  });

  it('BUY/SELL alias hydrate canonical LONG/SHORT me normalize hota hai', () => {
    const port = new PaperPort({ startingEquityUSDT: 1000 });
    const pm = new PositionManager({ port });
    const n = pm.hydrateFromJournal([
      {
        id: 'pos-4', pair: 'B-Y_USDT', source: 'exec-enter', execManaged: true, status: 'OPEN',
        entryPrice: 100, qty: 1, sl: 102, side: 'BUY', openedAt: Date.now(),
      },
    ]);
    expect(n).toBe(1);
    expect(pm._stateForTests()[0].side).toBe('LONG');
  });
});

describe('v21.34.0 [JOURNAL WRITE-BACK] — journalSync hook', () => {
  it('t1/t2 reduce + close actions journalSync ko sahi payloads dete hain', async () => {
    const port = new PaperPort({ startingEquityUSDT: 1000 });
    const syncs = [];
    const pm = new PositionManager({ port, journalSync: async (id, action) => { syncs.push({ id, ...action }); } });
    const r = await pm.protectionFirstEntry({ signal: _signal(), plan: _plan() });
    expect(r.ok).toBe(true);
    await pm.tick({ pricesByPair: { 'B-BTC_USDT': 102 } }); // T1
    await pm.tick({ pricesByPair: { 'B-BTC_USDT': 104 } }); // T2
    const t1s = syncs.find(s => s.leg === 'T1');
    const t2s = syncs.find(s => s.leg === 'T2');
    expect(t1s).toBeTruthy();
    expect(t1s.kind).toBe('reduce');
    expect(t1s.stage).toBe('T1_HIT');
    expect(t1s.remainingQty).toBeGreaterThan(0);
    expect(t1s.sl).toBeGreaterThan(100); // BE+fees SL
    expect(t2s).toBeTruthy();
    expect(t2s.kind).toBe('reduce');
    expect(t2s.stage).toBe('RUNNER');
    // price crash 90 pe — RUNNER stage me pehle give-back (armed peak se
    // >35% retrace) fire hota hai; SL-hit backstop. Dono close hi hain —
    // journal me close payload aana hi matter hai.
    await pm.tick({ pricesByPair: { 'B-BTC_USDT': 90 } });
    const cl = syncs.find(s => s.kind === 'close');
    expect(cl).toBeTruthy();
    expect(/STOP-LOSS|GIVE-BACK/.test(String(cl.reason))).toBe(true);
  });

  it('ghost row closure sync (syncGhostClose) idempotent payload', async () => {
    const port = new PaperPort({ startingEquityUSDT: 1000 });
    const syncs = [];
    const pm = new PositionManager({ port, journalSync: async (id, action) => { syncs.push({ id, ...action }); } });
    await pm.syncGhostClose('pos-ghost');
    expect(syncs.length).toBe(1);
    expect(syncs[0].kind).toBe('close');
    expect(syncs[0].reason).toContain('GHOST');
    expect(syncs[0].pnl).toBeNull();
  });

  it('journalSync absent → sab kuch pehle jaisa (no-op, kabhi throw nahi)', async () => {
    const port = new PaperPort({ startingEquityUSDT: 1000 });
    const pm = new PositionManager({ port });
    const r = await pm.protectionFirstEntry({ signal: _signal(), plan: _plan() });
    expect(r.ok).toBe(true);
    const actions = await pm.tick({ pricesByPair: { 'B-BTC_USDT': 102 } });
    expect(actions.some(a => a.kind === 't1')).toBe(true);
    await expect(pm.syncGhostClose('x')).resolves.toBeUndefined();
  });
});

describe('v21.34.0 [NO SILENT SIDE] — port side validation', () => {
  it('non-canonical port fill side → flatten + refuse', async () => {
    const port = new PaperPort({ startingEquityUSDT: 1000 });
    // fill side ko corrupt karo — open ke baad positions me side badalte hain
    const origOpen = port.open.bind(port);
    port.open = async (args) => {
      const res = await origOpen(args);
      if (res?.ok) {
        for (const p of port._positions.values()) { if (p.clientId === args.clientId) p.side = 'banana'; }
      }
      return res;
    };
    const pm = new PositionManager({ port, alertSink: () => {} });
    const r = await pm.protectionFirstEntry({ signal: _signal(), plan: _plan() });
    expect(r.ok).toBe(false);
    expect(r.stage).toBe('side-invalid');
    expect((await port.getPositions()).length).toBe(0); // flattened
  });

  it('BUY-alias port side canonical LONG me aata hai (alias-aware, flip nahi)', async () => {
    const port = new PaperPort({ startingEquityUSDT: 1000 });
    const origOpen = port.open.bind(port);
    port.open = async (args) => {
      const res = await origOpen(args);
      if (res?.ok) {
        for (const p of port._positions.values()) { if (p.clientId === args.clientId && p.side === 'LONG') p.side = 'BUY'; }
      }
      return res;
    };
    const pm = new PositionManager({ port });
    const r = await pm.protectionFirstEntry({ signal: _signal(), plan: _plan() });
    expect(r.ok).toBe(true);
    const st = pm._stateForTests()[0];
    expect(st.side).toBe('LONG'); // canonical — ladder === 'LONG' branches safe
  });
});

// ============================================================
// v21.35.0 [B1..B7] exec-stack audit fixes
// ------------------------------------------------------------
//   B1  native-TP ban — har PM setProtection call tp:null
//   B2  entry-window race — _pendingEntryPairs lifecycle + clear
//   B3  stale ladder-state — checkpoint jsync (peak/bePending/candles)
//   B4  underwater BE-tighten — reversal 1-class profit-side guard
//   B5  journalSync durability — retry + alert on double failure
//   B7  qty drift — verified postQty exchange truth
// ============================================================
describe('v21.35.0 [B1 NATIVE-TP BAN] — PM kabhi exchange TP arm nahi karta', () => {
  it('entry / T1 / T2 — har captured setProtection call ka tp null hai (ladder PM-driven)', async () => {
    const port = new PaperPort({ startingEquityUSDT: 1000 });
    const protCalls: Array<Record<string, unknown>> = [];
    const origSetProt = port.setProtection.bind(port);
    port.setProtection = async (args: { positionId: string; sl: number; tp: number | null }) => {
      protCalls.push({ ...args });
      return origSetProt(args);
    };
    const pm = new PositionManager({ port });
    const r = await pm.protectionFirstEntry({ signal: _signal(), plan: _plan() });
    expect(r.ok).toBe(true);
    expect(protCalls.length).toBeGreaterThanOrEqual(1); // entry protection (SL-only)
    await pm.tick({ pricesByPair: { 'B-BTC_USDT': 102 } }); // T1 fires → re-protect
    await pm.tick({ pricesByPair: { 'B-BTC_USDT': 104 } }); // T2 fires → re-protect
    expect(protCalls.length).toBeGreaterThanOrEqual(3);
    // THE contract: native position-TP full-closes at tick-level — PM ladder
    // (T1-40%/T2-30%/runner-30%) sirf tab chalti hai jab exchange pe TP na ho.
    for (const c of protCalls) expect(c.tp).toBeNull();
    // ladder actually progressed (native-TP full-close nahi hua)
    const st = pm._stateForTests()[0];
    expect(['T1_HIT', 'RUNNER']).toContain(st.stage);
    expect(st.qty).toBeGreaterThan(0);
  });
});

describe('v21.35.0 [B2 ENTRY-WINDOW RACE] — pendingEntryPairs lifecycle', () => {
  it('mid-entry pair pending me hai; success par clear', async () => {
    const port = new PaperPort({ startingEquityUSDT: 1000 });
    const pm = new PositionManager({ port });
    const seenDuringOpen: string[][] = [];
    const origOpen = port.open.bind(port);
    port.open = async (args: Record<string, unknown>) => {
      seenDuringOpen.push(pm.pendingEntryPairs());
      return origOpen(args as never);
    };
    expect(pm.pendingEntryPairs()).toEqual([]);
    const r = await pm.protectionFirstEntry({ signal: _signal(), plan: _plan() });
    expect(r.ok).toBe(true);
    expect(seenDuringOpen[0]).toContain('B-BTC_USDT');  // open ke waqt mid-flight
    expect(pm.pendingEntryPairs()).toEqual([]);         // success → clear
  });

  it('abort (protection-fail flatten) par bhi clear', async () => {
    const port = new PaperPort({ startingEquityUSDT: 1000 });
    port.setProtection = async () => ({ ok: false, error: 'simulated network error' });
    const pm = new PositionManager({ port, alertSink: () => {} });
    const r = await pm.protectionFirstEntry({ signal: _signal(), plan: _plan() });
    expect(r.ok).toBe(false);
    expect(r.stage).toBe('protection-fail');
    expect(pm.pendingEntryPairs()).toEqual([]); // abort → clear (reconciler phir se guard kar sakta)
  });

  it('internal throw par bhi clear (finally) + honest abort verdict', async () => {
    const port = new PaperPort({ startingEquityUSDT: 1000 });
    const origOpen = port.open.bind(port);
    port.open = async (args: Record<string, unknown>) => { await origOpen(args as never); throw new Error('boom mid-entry'); };
    const pm = new PositionManager({ port });
    const r = await pm.protectionFirstEntry({ signal: _signal(), plan: _plan() });
    expect(r.ok).toBe(false);
    expect(r.stage).toBe('internal-error');
    expect(pm.pendingEntryPairs()).toEqual([]); // throw → finally clear
  });
});

describe('v21.35.0 [B3 STALE LADDER-STATE] — checkpoint jsync + bePending hydrate', () => {
  it('peak change BINA action ke journalSync ko ladder-state naya peak deta hai (no per-tick churn)', async () => {
    const port = new PaperPort({ startingEquityUSDT: 1000 });
    const syncs: Array<Record<string, unknown>> = [];
    const pm = new PositionManager({ port, journalSync: async (id: string, action: Record<string, unknown>) => { syncs.push({ id, ...action }); } });
    await pm.protectionFirstEntry({ signal: _signal(), plan: _plan() });
    syncs.length = 0;
    // T1 (102) se neeche ka naya peak — koi ladder action fire NAHI hoga,
    // sirf checkpoint: (101-100)/(100-98) = 0.5R
    const actions = await pm.tick({ pricesByPair: { 'B-BTC_USDT': 101 } });
    expect(actions.length).toBe(0);
    const cp = syncs.find(s => s.kind === 'ladder-state');
    expect(cp).toBeTruthy();
    expect(cp.peakUnrealizedR).toBeCloseTo(0.5, 5);
    expect(cp.bePending).toBeNull();
    expect(cp.remainingQty).toBeGreaterThan(0);
    expect(cp.candlesSeen).toBe(1);
    // churn guard: same peak dobara tick pe NO extra checkpoint
    await pm.tick({ pricesByPair: { 'B-BTC_USDT': 101 } });
    expect(syncs.filter(s => s.kind === 'ladder-state').length).toBe(1);
  });

  it('hydrate row.bePending restore karta hai (pending BE retry restart-safe)', () => {
    const port = new PaperPort({ startingEquityUSDT: 1000 });
    const pm = new PositionManager({ port });
    const n = pm.hydrateFromJournal([
      {
        id: 'pos-be', pair: 'B-BTC_USDT', side: 'LONG', source: 'exec-enter', execManaged: true, status: 'OPEN',
        entryPrice: 100, qty: 0.6, origQty: 1.0, sl: 98, stage: 'T1_HIT', bePending: 100.05,
        peakUnrealizedR: 1.1, candlesSeen: 3, openedAt: Date.now(),
      },
    ]);
    expect(n).toBe(1);
    const st = pm._stateForTests()[0];
    expect(st.bePending).toBeCloseTo(100.05, 6);
    expect(st.stage).toBe('T1_HIT');
    // bePending absent → null (koi pending move nahi)
    const pm2 = new PositionManager({ port });
    pm2.hydrateFromJournal([
      { id: 'pos-be2', pair: 'B-BTC_USDT', side: 'LONG', source: 'exec-enter', execManaged: true, status: 'OPEN', entryPrice: 100, qty: 1, sl: 98, stage: 'T1_HIT', openedAt: Date.now() },
    ]);
    expect(pm2._stateForTests()[0].bePending).toBeNull();
  });

  it('t1:protect-fail ka bePending AGLE tick checkpoint se journal me jata hai', async () => {
    const port = new PaperPort({ startingEquityUSDT: 1000 });
    const syncs: Array<Record<string, unknown>> = [];
    const origSetProt = port.setProtection.bind(port);
    let failProtect = false;
    port.setProtection = async (args: { positionId: string; sl: number; tp: number | null }) => (
      failProtect ? { ok: false, error: 'simulated tpsl reject' } : origSetProt(args)
    );
    const pm = new PositionManager({ port, journalSync: async (id: string, action: Record<string, unknown>) => { syncs.push({ id, ...action }); }, alertSink: () => {} });
    const r = await pm.protectionFirstEntry({ signal: _signal(), plan: _plan() });
    expect(r.ok).toBe(true);
    failProtect = true; // ab T1 ka SL→BE move fail hoga → bePending stamp
    syncs.length = 0;
    await pm.tick({ pricesByPair: { 'B-BTC_USDT': 102 } }); // T1 reduce OK, SL→BE move FAIL → bePending stamp
    const st = pm._stateForTests()[0];
    expect(st.bePending).toBeGreaterThan(100); // BE+fees pending
    expect(syncs.find(s => s.kind === 'ladder-state' && s.bePending != null)).toBeUndefined(); // isi tick me nahi
    await pm.tick({ pricesByPair: { 'B-BTC_USDT': 102 } }); // checkpoint bePending drift pakadta hai
    const cps = syncs.filter(s => s.kind === 'ladder-state' && s.bePending != null);
    expect(cps.length).toBeGreaterThanOrEqual(1);
    expect(cps[0].bePending).toBeCloseTo(st.bePending as number, 6);
  });
});

describe('v21.35.0 [B4 UNDERWATER BE-TIGHTEN] — reversal 1-class profit-side guard', () => {
  it('LONG underwater (mark < BE) → SL UNCHANGED (skip + reason, instant stop-out nahi)', async () => {
    const port = new PaperPort({ startingEquityUSDT: 1000 });
    const pm = new PositionManager({ port });
    await pm.protectionFirstEntry({ signal: _signal(), plan: _plan() });
    const slBefore = pm._stateForTests()[0].sl;
    port.setMarkPrice('B-BTC_USDT', 99); // entry 100 ke neeche — underwater LONG
    const actions = await pm.reversalCheck({ evidenceByPair: { 'B-BTC_USDT': ['structure-break'] } });
    expect(actions.some(a => a.kind === 'reversal-tighten')).toBe(false); // koi tighten nahi
    const skip = actions.find(a => a.kind === 'reversal-tighten:skip-underwater');
    expect(skip).toBeTruthy();
    expect(String(skip.reason)).toMatch(/profit-side/i);
    expect(pm._stateForTests()[0].sl).toBe(slBefore); // current SL rakha
    expect((await port.getPositions()).length).toBe(1); // position zinda
  });

  it('profit-side mark (mark > BE) → tightens to BE+fees (existing contract)', async () => {
    const port = new PaperPort({ startingEquityUSDT: 1000 });
    const pm = new PositionManager({ port });
    await pm.protectionFirstEntry({ signal: _signal(), plan: _plan() });
    port.setMarkPrice('B-BTC_USDT', 102);
    const actions = await pm.reversalCheck({ evidenceByPair: { 'B-BTC_USDT': ['structure-break'] } });
    const tighten = actions.find(a => a.kind === 'reversal-tighten');
    expect(tighten).toBeTruthy();
    expect(pm._stateForTests()[0].sl).toBeGreaterThan(100); // BE+fees
  });
});

describe('v21.35.0 [B5 SYNC DURABILITY] — journalSync retry + alert', () => {
  it('double failure → exactly 2 attempts + alert + kabhi throw nahi', async () => {
    const port = new PaperPort({ startingEquityUSDT: 1000 });
    const alerts: string[] = [];
    let calls = 0;
    const pm = new PositionManager({ port, alertSink: (m: string) => { alerts.push(m); }, journalSync: async () => { calls++; throw new Error('disk full'); } });
    const r = await pm.protectionFirstEntry({ signal: _signal(), plan: _plan() });
    expect(r.ok).toBe(true);
    const actions = await pm.tick({ pricesByPair: { 'B-BTC_USDT': 101 } }); // checkpoint fires
    expect(actions.length).toBe(0);
    expect(calls).toBe(2); // 1 + 1 bounded retry
    expect(alerts.length).toBe(1);
    expect(alerts[0]).toMatch(/JOURNAL SYNC FAILED/);
    expect(alerts[0]).toMatch(/101|paper-1/); // position id honest
  });

  it('pehli fail + retry success → koi alert nahi', async () => {
    const port = new PaperPort({ startingEquityUSDT: 1000 });
    const alerts: string[] = [];
    let calls = 0;
    const pm = new PositionManager({ port, alertSink: (m: string) => { alerts.push(m); }, journalSync: async () => { calls++; if (calls === 1) throw new Error('transient lock'); } });
    await pm.protectionFirstEntry({ signal: _signal(), plan: _plan() });
    await pm.tick({ pricesByPair: { 'B-BTC_USDT': 101 } });
    expect(calls).toBe(2);
    expect(alerts.length).toBe(0);
  });
});

describe('v21.35.0 [B7 QTY DRIFT] — verified postQty exchange truth', () => {
  it('exchange-capped reduce (postQty) pe st.qty = postQty, overstated subtraction nahi', async () => {
    const port = new PaperPort({ startingEquityUSDT: 1000 });
    const pm = new PositionManager({ port });
    await pm.protectionFirstEntry({ signal: _signal(), plan: _plan() });
    const st0 = pm._stateForTests()[0];
    const origQty = st0.qty; // 5 USDT-book qty
    // capping reducer: PM 40% (2.0) maangta, exchange sirf 0.01 book karta hai
    // (safeReduceFuturesPosition ka capped/verified shape — postQty = truth).
    const origReduce = port.reduce.bind(port);
    port.reduce = async (args: { positionId: string; qty: number }) => {
      await origReduce({ positionId: args.positionId, qty: Math.min(Number(args.qty), 0.01) });
      const remaining = (await port.getPositions()).find((p: { id: string }) => p.id === args.positionId)?.qty ?? 0;
      return { ok: true, verified: true, orderId: 'red-capped', postQty: remaining, raw: { postQty: remaining } };
    };
    const actions = await pm.tick({ pricesByPair: { 'B-BTC_USDT': 102 } }); // T1
    expect(actions.some(a => a.kind === 't1')).toBe(true);
    const st1 = pm._stateForTests().find(s => s.id === st0.id);
    expect(st1.qty).toBeCloseTo(origQty - 0.01, 6); // exchange truth — NOT origQty − 0.4×origQty
    expect(st1.qty).toBeGreaterThan(origQty * 0.5); // buggy path 3.0 (60% trim claim) hota
  });
});
