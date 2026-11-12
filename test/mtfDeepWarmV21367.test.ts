// ============================================================
// test/mtfDeepWarmV21367.test.ts — v21.36.7 MTF BOARD + DEEP
// ENSEMBLE: the deep lane must NEVER block the 2s board cycle
// ------------------------------------------------------------
// USER REPORT: "MTF Dual-Timeframe Signal Board fail ho raha hai"
// after v21.36.6. Root cause: v21.36.6 AWAITed the per-symbol
// deep ensemble (cold 29-model run = 7–12s) inside getDualMtfBoard,
// whose own contract is the 2s ultra-fast 24x7 cycle the UI polls
// every 2s. The first cold call stalled the board for up to 12s,
// the UI's 2s polls piled up / read as failed — while every market
// still returned 200 + ok=true (hence "board fail" on screen).
//
// v21.36.7 contract (locked here):
//   1. A deepFor that NEVER resolves must not hold the board —
//      the board completes and marks the lane warming (honest).
//   2. Warm-store SYNC stamp: a resolved deep result is stamped on
//      the NEXT board build (no await), so the 2s cycle restores
//      the full combined verdict within one tick of the warm run.
//   3. The board-level meta reports stamped + warming honestly.
// ============================================================
import { describe, it, expect, beforeEach } from 'vitest';
import {
  getDualMtfBoard,
  __clearDualBoardCaches,
  __resetDeepWarmForTests,
} from '../server/ai/mtfDualBoard.js';

// Deterministic offline candles (no network) — the v21.22 fixture shape.
function makeCandles(count = 120, startPrice = 150, stepPct = 0.0035, intervalMs = 300_000) {
  const out = [];
  let px = startPrice;
  const now = Date.now() - count * intervalMs;
  for (let i = 0; i < count; i++) {
    const open = px;
    const isBase = i === count - 26 || i === count - 25;
    const isImpulse = i === count - 24;
    const delta = isBase ? 0.0001 : isImpulse ? stepPct * 3.5 : (stepPct + (i % 5 === 0 ? -0.0008 : 0.0012));
    const close = +(px * (1 + delta)).toFixed(4);
    out.push({
      time: now + i * intervalMs,
      open,
      close,
      high: +(Math.max(open, close) * 1.001).toFixed(4),
      low: +(Math.min(open, close) * 0.999).toFixed(4),
      volume: 1000 + i * 10,
    });
    px = close;
  }
  return out;
}

const candlesFor = async (_s: string, _m: string, tf: string) =>
  makeCandles(120, 150, 0.0035, tf === '15m' ? 900_000 : 300_000);

describe('v21.36.7 MTF board + deep-ensemble non-blocking contract', () => {
  beforeEach(() => {
    __clearDualBoardCaches();
    __resetDeepWarmForTests();
  });

  it('a NEVER-resolving deep lane must not hold the 2s board build', async () => {
    const never = () => new Promise(() => { /* never settles */ });
    const t0 = Date.now();
    const board = await getDualMtfBoard({
      market: 'CRYPTO',
      mode: 'INTRADAY',
      limit: 6,
      force: true,
      candlesFor,
      deepFor: never as any,
    });
    const tookMs = Date.now() - t0;
    expect(board.ok).toBe(true);
    // The deep lane is warming, not blocking: the build must finish
    // promptly (offline candle fixture → well under a second; the
    // pre-fix code awaited a 12s cap and would hang on `never`).
    expect(tookMs).toBeLessThan(10_000);
    expect(board.deepEnsemble?.enabled).toBe(true);
    expect(board.deepEnsemble?.stamped ?? 0).toBe(0);
    // every sideable row is marked warming — honest PARTIAL verdicts
    const sideable = (board.rows || []).filter((r: any) => r.ok && r.side);
    expect(sideable.length).toBeGreaterThan(0);
    expect(sideable.every((r: any) => r.deepEnsemble?.ok === false && r.finalVerdict?.decision === 'WATCH')).toBe(true);
    expect((board.deepEnsemble?.warming ?? 0)).toBe(sideable.length);
  });

  it('warm-store SYNC stamp: a resolved deep result stamps the NEXT build (no await)', async () => {
    let calls = 0;
    let resolveAll: ((v: any) => void)[] = [];
    // deepFor resolves 60ms after being fired — AFTER the board build
    // has already returned (fire-and-forget).
    const slowDeepFor = (_sym: string, _mkt: string) => {
      calls += 1;
      return new Promise((res) => resolveAll.push(() => res({
        ok: true,
        signal: { side: 'LONG', grade: 'A', confidence: 88 },
        edge: { winRate: 61, avgR: 0.22, trades: 30 },
        recheckedAt: Date.now(),
      })));
    };

    // build 1: deep lane not warm yet → stamped 0, warming N
    const b1 = await getDualMtfBoard({
      market: 'CRYPTO', mode: 'INTRADAY', limit: 6, force: true, candlesFor,
      deepFor: slowDeepFor as any,
    });
    const sideable1 = (b1.rows || []).filter((r: any) => r.ok && r.side);
    expect(b1.deepEnsemble?.stamped).toBe(0);
    expect(b1.deepEnsemble?.warming).toBe(sideable1.length);

    // let the fired deep runs settle into the warm store
    await new Promise((r) => setTimeout(r, 80));
    resolveAll.forEach((f) => f());
    await new Promise((r) => setTimeout(r, 10));

    // build 2 (next 2s cycle): SYNC stamp from the warm store — the
    // board no longer awaits any deep lane, and the rows now carry
    // the full combined verdicts.
    const b2 = await getDualMtfBoard({
      market: 'CRYPTO', mode: 'INTRADAY', limit: 6, force: true, candlesFor,
      deepFor: slowDeepFor as any,
    });
    const sideable2 = (b2.rows || []).filter((r: any) => r.ok && r.side);
    expect(sideable2.length).toBeGreaterThan(0);
    expect(sideable2.every((r: any) => r.deepEnsemble?.ok === true && r.deepEnsemble?.side === 'LONG')).toBe(true);
    expect(b2.deepEnsemble?.stamped).toBe(sideable2.length);
    expect(b2.deepEnsemble?.warming).toBe(0);
    // aligned MTF-LONG + deep-LONG → ENTER or ARMED, never WATCH/STAND_ASIDE
    expect(sideable2.every((r: any) => ['ENTER', 'ARMED'].includes(r.finalVerdict.decision))).toBe(true);
    // deepFor was fired once per missing symbol, NOT re-fired for warm ones
    expect(calls).toBe(sideable1.length);
  });
});
