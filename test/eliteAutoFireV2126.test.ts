// ============================================================
// test/eliteAutoFireV2126.test.ts — v21.26.0 → v21.35 SHIPPED CONTRACT
// ------------------------------------------------------------
// ORIGINAL v21.26.0 INTENT ("elite score par bhi live auto-trade nahi
// lag raha"): the MTF dual board's own PAKKA-verified ELITE rows were
// being starved by (1) a "main AI-BOARD ensemble signal unavailable"
// hard blocker and (2) a flat 5-minute stability age gate.
//
// SHIPPED REALITY (v21.26.4 [AUTO-ELIGIBILITY HONESTY] + v21.33 DIRECTION
// HARDENING — "no gate relaxed"): instead of adding an `ensembleWaiver`
// that would BYPASS the ensemble gate, the fix went the OTHER way — the
// main-AI ensemble gate was folded INTO the row's own autoEligible so the
// UI/API counts match execution, and the direction chain was hardened.
// Consequences pinned here:
//   • There is NO `ensembleWaiver` field anywhere in server/ or src/ —
//     an ensemble-unavailable row (even ELITE/PAKKA/trigger-fired) is
//     still BLOCKED, honestly ("main AI-BOARD ensemble signal
//     unavailable"). A waiver would have relaxed a live-trade gate; the
//     shipped decision was to keep it strict.
//   • Stability gate stays FLAT: minMainSignalAgeMs = 5m default. No
//     tier-aware ladder (ELITE 60s / STRONG 120s) was shipped.
//   • SAFETY (never relaxed): opposed main signal (cross-engine veto),
//     SVA FLIP verdict, council hard-no, and unverified direction ALL
//     block entry.
//
// Hermetic: paper engine injected, tmp MTF_AUTO_DATA_DIR, no network or
// broker IO — exactly the contract the production 60s/15s loops run.
// ============================================================
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'elite-autofire-test-'));
process.env.MTF_AUTO_DATA_DIR = TMP_DATA;

vi.mock('../server/mcp/durable.js', () => ({ durablePut: vi.fn() }));

import {
  mtfAutoTick, __resetMtfAutoForTests,
} from '../server/ai/mtfAutoLink.js';
import {
  dualAutoCandidates, mtfProEntryGate,
} from '../server/ai/mtfDualBoard.js';

// ---------------- fixtures ----------------

/** ELITE PAKKA row in its "field-bug" shape (the live XRP SHORT 98 case):
 *  fired + verified + strong, but the main-AI board ensemble signal is
 *  UNAVAILABLE. Under the shipped strict contract this row is BLOCKED. */
function eliteRow(over = {}) {
  return {
    ok: true, symbol: 'XRP', market: 'CRYPTO', mode: 'INTRADAY', label: '15m → 5m', holdMin: 45,
    superScore: 98, tier: 'ELITE', side: 'SHORT', dir: -1, grade: 'A',
    triggerFired: true, dualAligned: true, counterTrend: false, tfFit: 'OK',
    directionVerified: true, trigger: {}, context: {},
    autoEligible: true, autoBlockers: [],
    ensembleSignalAvailable: false,
    plan: { entry: 100, stopLoss: 101, t1: 98, t2: 96 },
    drivers: ['dual-TF confirm (+4)'],
    ...over,
  };
}

/** Same ELITE PAKKA row but with the main-AI ensemble available — the
 *  positive case that DOES open a trade under the shipped contract. */
function eliteRowAvailable(over = {}) {
  return { ...eliteRow(over), ensembleSignalAvailable: true };
}

/** Injected paper engine fake — records every open call. */
function fakePaper() {
  const calls = { opened: [], closed: [] };
  const paper = {
    open: [],
    openPaperTrade: vi.fn((input) => {
      calls.opened.push(input);
      const trade = { id: 700 + calls.opened.length, ...input };
      paper.open.push({ id: trade.id, symbol: input.symbol, market: input.market, status: 'OPEN', direction: input.direction, openedAt: Date.now() });
      return { ok: true, trade };
    }),
    closePaperTrade: vi.fn((id) => {
      calls.closed.push(id);
      paper.open = paper.open.filter(t => t.id !== id);
      return { ok: true, trade: { id, realizedPnl: 42 } };
    }),
    getPaperSummary: vi.fn(() => ({ open: paper.open })),
  };
  return { paper, calls };
}

// ---------------- 1) AUTO-LANE ----------------
// Shipped: ensemble-unavailable ELITE PAKKA rows are BLOCKED (no waiver);
// ensemble-available ELITE PAKKA rows FIRE.

describe('v21.26.0 (shipped v21.33-hardened) — ELITE auto-fire & ensemble gate', () => {
  beforeEach(() => { __resetMtfAutoForTests({ config: { enabled: true } }); });

  it('THE FIELD BUG, SHIPPED STANCE: ensemble-UNAVAILABLE ELITE row stays blocked (honest skip)', async () => {
    const { paper, calls } = fakePaper();
    const out = await mtfAutoTick({
      boards: { CRYPTO: { ok: true, market: 'CRYPTO', rows: [eliteRow()] } },
      paper,
    });
    expect(calls.opened.length).toBe(0);
    expect(out.opened.length).toBe(0);
    expect(out.skipped.some(s => String(s).includes('ensemble signal unavailable'))).toBe(true);
  });

  it('ensemble-AVAILABLE ELITE PAKKA row (fired + verified + cert ok) OPENS a trade', async () => {
    const { paper, calls } = fakePaper();
    const out = await mtfAutoTick({
      boards: { CRYPTO: { ok: true, market: 'CRYPTO', rows: [eliteRowAvailable()] } },
      paper,
    });
    expect(calls.opened.length).toBe(1);
    expect(calls.opened[0].symbol).toBe('XRP');
    expect(calls.opened[0].direction).toBe('SHORT');
    expect(out.opened.length).toBe(1);
    expect(out.opened[0].executionMode).toBe('PAPER');
    expect(out.opened[0].side).toBe('SHORT');
  });

  it('non-ELITE / weak-score row with the same missing ensemble stays blocked', async () => {
    const { paper, calls } = fakePaper();
    const out = await mtfAutoTick({
      boards: { CRYPTO: { ok: true, market: 'CRYPTO', rows: [eliteRow({ tier: 'ACTION', superScore: 72 })] } },
      paper,
    });
    expect(calls.opened.length).toBe(0);
    expect(out.opened.length).toBe(0);
    expect(out.skipped.some(s => String(s).includes('ensemble signal unavailable'))).toBe(true);
  });

  it('direction verification is NOT bypassed — unverified row never trades', async () => {
    const { paper, calls } = fakePaper();
    const out = await mtfAutoTick({
      boards: { CRYPTO: { ok: true, market: 'CRYPTO', rows: [eliteRowAvailable({ directionVerified: false, autoEligible: false, autoBlockers: ['direction not pakka verified'] })] } },
      paper,
    });
    expect(calls.opened.length).toBe(0);
    expect(out.opened.length).toBe(0);
  });

  it('ensemble gate is still enforced at the SOURCE (no waiver clause slipped in)', () => {
    // Shipped source contract: dual board keeps the ensemble-unavailable
    // blocker + the direction/trigger gates. There is NO `ensembleWaiver`
    // token anywhere — the gate was tightened, not waived.
    const src = fs.readFileSync(path.resolve('server/ai/mtfDualBoard.js'), 'utf8');
    expect(src).toContain('row.ensembleSignalAvailable === false');
    expect(src).toContain('direction not pakka verified');
    expect(src).toContain('trigger fire pending');
    expect(src).not.toContain('ensembleWaiver');
  });

  it('cooldown / day-quota caps still apply (available-ensemble ELITE rows)', async () => {
    __resetMtfAutoForTests({ config: { enabled: true, maxTradesPerDay: 1 } });
    const { paper, calls } = fakePaper();
    await mtfAutoTick({ boards: { CRYPTO: { ok: true, market: 'CRYPTO', rows: [eliteRowAvailable()] } }, paper });
    expect(calls.opened.length).toBe(1);
    const out2 = await mtfAutoTick({ boards: { CRYPTO: { ok: true, market: 'CRYPTO', rows: [eliteRowAvailable()] } }, paper });
    expect(out2.opened.length).toBe(0); // paper session: max-open lock + day quota
    expect(out2.skipped.some(s =>
      String(s).includes('max open positions')
      || String(s).includes('1 session = 1 trade lock')
      || String(s).includes('daily quota'),
    )).toBe(true);
  });
});

// ---------------- 2) SIFT + MANUAL GATE ----------------

describe('shipped — dualAutoCandidates / mtfProEntryGate ensemble-gate parity', () => {
  beforeEach(() => { __resetMtfAutoForTests(); });

  it('dualAutoCandidates: ensemble-unavailable row carries the ensemble blocker (no waiver bypass)', () => {
    const ctx = { openSymbols: new Set(), lastEntryAt: {}, now: Date.now() };
    const blocked = dualAutoCandidates([eliteRow()], { minScore: 75 }, ctx);
    expect(blocked[0].autoPickBlockers.some(b => b.includes('ensemble signal unavailable'))).toBe(true);
    // control: the same row with the ensemble available loses that blocker
    const open = dualAutoCandidates([eliteRowAvailable()], { minScore: 75 }, ctx);
    expect(open[0].autoPickBlockers.some(b => b.includes('ensemble signal unavailable'))).toBe(false);
  });

  it('mtfProEntryGate: ensemble-unavailable ELITE row is BLOCKED even with NO main signal', () => {
    const g = mtfProEntryGate(eliteRow(), { mainSignal: null });
    expect(g.ok).toBe(false);
    expect(g.blockers.some(b => b.includes('ensemble signal unavailable') || b.includes('ensemble signal missing'))).toBe(true);
  });

  it('mtfProEntryGate: OPPOSED main signal vetoes (cross-engine veto — never bypassed)', () => {
    const g = mtfProEntryGate(eliteRowAvailable(), {
      mainSignal: { side: 'LONG', grade: 'STRONG', confidence: 84, mtf: { htfBias: 'BULLISH' }, signalAge: { ageMs: 60 * 60_000 }, verify: { veto: false, action: 'BUY' } },
    });
    expect(g.ok).toBe(false);
    expect(g.blockers.some(b => b.includes('cross-engine veto'))).toBe(true);
  });

  it('mtfProEntryGate: SVA FLIP verdict still vetoes', () => {
    const g = mtfProEntryGate(eliteRowAvailable(), {
      mainSignal: { side: 'SHORT', grade: 'STRONG', confidence: 84, signalAge: { ageMs: 60 * 60_000 }, verify: { veto: true, action: 'FLIP' } },
    });
    expect(g.ok).toBe(false);
    expect(g.blockers.some(b => b.includes('verifier veto'))).toBe(true);
  });

  it('mtfProEntryGate: a YOUNG main signal (15s) is blocked at the stability gate', () => {
    const g = mtfProEntryGate(eliteRowAvailable(), {
      mainSignal: { side: 'SHORT', grade: 'STRONG', confidence: 84, signalAge: { ageMs: 15_000 } },
    });
    expect(g.blockers.some(b => b.includes('stability confirm pending'))).toBe(true);
  });
});

// ---------------- 3) FLAT STABILITY AGE GATE (shipped: 5m, no tier ladder) ----------------

describe('shipped — flat main-signal stability gate (minMainSignalAgeMs = 5m default)', () => {
  beforeEach(() => { __resetMtfAutoForTests(); });

  const row = (tier, score) => ({
    ok: true, side: 'LONG', superScore: score, tier,
    directionVerified: true, triggerFired: true, counterHtf: false, counterTrend: false,
    autoEligible: true, autoBlockers: [], ensembleSignalAvailable: true,
    plan: { entry: 100, stopLoss: 99, t1: 101, t2: 102 },
  });
  const main = (ageMs) => ({
    side: 'LONG', grade: 'STRONG', confidence: 84,
    mtf: { htfBias: 'BULLISH' }, signalAge: { ageMs }, verify: { veto: false, action: 'BUY' },
  });

  it('young main signals (30s / 90s / 150s / 200s) are all blocked — flat 5m bar, no tier ladder', () => {
    for (const ageMs of [30_000, 90_000, 150_000, 200_000]) {
      const g = mtfProEntryGate(row('STRONG', 82), { mainSignal: main(ageMs) });
      expect(g.blockers.some(b => b.includes('stability confirm pending')), `${ageMs / 1000}s`).toBe(true);
    }
  });

  it('an older main signal (≥ 5m) passes the stability gate', () => {
    const g = mtfProEntryGate(row('ELITE', 88), { mainSignal: main(6 * 60_000) });
    expect(g.blockers.some(b => b.includes('stability confirm pending'))).toBe(false);
    expect(g.ok).toBe(true);
  });

  it('explicit minMainSignalAgeMs override still wins over the 5m default', () => {
    const g = mtfProEntryGate(row('ELITE', 88), { mainSignal: main(6 * 60_000), minMainSignalAgeMs: 30 * 60_000 });
    expect(g.blockers.some(b => b.includes('stability confirm pending'))).toBe(true);
  });

  it('buildDualRow stamps the flat-ladder fields at source (no waiver field)', () => {
    const src = fs.readFileSync(path.resolve('server/ai/mtfDualBoard.js'), 'utf8');
    expect(src).toContain('row.mainSignalAgeMs');
    expect(src).toContain('stability confirm pending');
    expect(src).toContain('row.ensembleSignalAvailable');
    expect(src).not.toContain('ensembleWaiver');
  });
});

// ---------------- 4) ENGINE SOURCE CONTRACTS (shipped: tightened gate, no waiver) ----------------

describe('shipped — engine source contracts (auto + manual + UI parity)', () => {
  it('mtfAutoLink primary + fallback eligible filters enforce the ensemble gate (no waiver clause)', () => {
    const src = fs.readFileSync(path.resolve('server/ai/mtfAutoLink.js'), 'utf8');
    // both the primary and the fallback lane gate on the ensemble signal
    const gateClauses = src.match(/r\.ensembleSignalAvailable !== false/g) || [];
    expect(gateClauses.length).toBeGreaterThanOrEqual(2);
    // and NO waiver token survived into the engine
    expect(src).not.toContain('ensembleWaiver');
  });

  it('UI parity: canPaper gate + blocked chip both key off ensembleSignalAvailable', () => {
    const src = fs.readFileSync(path.resolve('src/components/aitrading/MTFDualBoardPanel.tsx'), 'utf8');
    expect(src).toContain('r.ensembleSignalAvailable === true');
    expect(src).toContain('r.ensembleSignalAvailable === false');
    expect(src).toContain('main AI-BOARD ensemble signal unavailable');
    expect(src).not.toContain('ensembleWaiver');
  });

  it('MtfDualRow type exposes ensembleSignalAvailable (not a waiver field)', () => {
    const src = fs.readFileSync(path.resolve('src/components/aitrading/useAITrading.ts'), 'utf8');
    expect(src).toContain('ensembleSignalAvailable?: boolean');
    expect(src).not.toContain('ensembleWaiver');
  });
});
