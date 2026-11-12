// ============================================================
// test/mtfDeepFuseV21366.test.ts — v21.36.6 MTF BOARD + DEEP
// ENSEMBLE COMBINED FINAL VERDICT
// ------------------------------------------------------------
// USER ASK: "DEEP ENSEMBLE ANALYSIS ko MTF board se dono combine
// karke final verdict do aur improve karo."
//
// Two independent lanes are now fused per row (fuseMtfDeepVerdict,
// server/ai/mtfDualBoard.js):
//   MTF LANE — the board row's side / superScore / PAKKA certificate
//   DEEP LANE — getDeepSignal's 29-model ensemble (side/grade/conf/
//   SVA verify / council gate / walk-forward edge)
//
// COMBINED DECISIONS (locked here — the "improve" that replaces the
// old "silently cap the score on conflict" behaviour):
//   ALIGNED + PAKKA (dirV+trigger)      → ENTER
//   ALIGNED, verify pending             → ARMED (armed, not fired)
//   CONFLICT (opposite sides)          → STAND_ASIDE + auto-blocker
//   deep SVA veto / council SUPPRESSED  → HOLD (honest downgrade)
//   one lane absent                      → WATCH (never fabricated)
//   finalConfidence = 50/50 MTF-super + deep-confidence blend,
//   +5 only when ENTER + council PASSED (capped at 99).
// ============================================================
import { describe, it, expect } from 'vitest';
import { fuseMtfDeepVerdict } from '../server/ai/mtfDualBoard.js';

const row = (over: Record<string, unknown> = {}) => ({
  ok: true,
  symbol: 'BTC',
  side: 'LONG',
  superScore: 92,
  directionVerified: true,
  triggerFired: true,
  ...over,
});

const deep = (over: { side?: string; conf?: number; grade?: string; veto?: string; gate?: string; edge?: unknown } = {}) => ({
  ok: true,
  signal: {
    side: over.side ?? 'LONG',
    grade: over.grade ?? 'A',
    confidence: over.conf ?? 90,
    ...(over.veto ? { verify: { action: over.veto } } : {}),
    ...(over.gate ? { council: { gate: over.gate } } : {}),
  },
  edge: over.edge ?? null,
});

describe('v21.36.6 combined MTF+DEEP-ENSEMBLE verdict (pure fuse)', () => {
  it('ALIGNED + PAKKA (dirV + trigger) → ENTER, 50/50 confidence blend', () => {
    const f = fuseMtfDeepVerdict({ row: row(), deep: deep({ conf: 88 }) });
    expect(f.alignment).toBe('ALIGNED');
    expect(f.decision).toBe('ENTER');
    expect(f.finalConfidence).toBe(90); // (92+88)/2
    expect(f.mtf.pukka).toBe(true);
  });

  it('ALIGNED but dirV or trigger pending → ARMED (armed, not fired)', () => {
    expect(fuseMtfDeepVerdict({ row: row({ directionVerified: false }), deep: deep() }).decision).toBe('ARMED');
    expect(fuseMtfDeepVerdict({ row: row({ triggerFired: false }), deep: deep() }).decision).toBe('ARMED');
  });

  it('CONFLICT (opposite sides) → STAND_ASIDE, no confidence (the improve)', () => {
    const f = fuseMtfDeepVerdict({ row: row({ side: 'LONG' }), deep: deep({ side: 'SHORT' }) });
    expect(f.alignment).toBe('CONFLICT');
    expect(f.decision).toBe('STAND_ASIDE');
    expect(f.finalConfidence).toBeNull();
    expect(f.decisionLabel).toContain('STAND ASIDE');
  });

  it('deep SVA veto (aligned but engine disagree) → HOLD, no confidence', () => {
    const f = fuseMtfDeepVerdict({ row: row(), deep: deep({ veto: 'AVOID' }) });
    expect(f.decision).toBe('HOLD');
    expect(f.finalConfidence).toBeNull();
    expect(f.deep.veto).toBe(true);
  });

  it('deep council gate SUPPRESSED → HOLD', () => {
    expect(fuseMtfDeepVerdict({ row: row(), deep: deep({ gate: 'SUPPRESSED' }) }).decision).toBe('HOLD');
  });

  it('ENTER + council PASSED earns the bounded +5 (both engines + gate agree)', () => {
    const plain = fuseMtfDeepVerdict({ row: row(), deep: deep() });
    const passed = fuseMtfDeepVerdict({ row: row(), deep: deep({ gate: 'PASSED' }) });
    expect(passed.finalConfidence).toBe(Math.min(99, plain.finalConfidence! + 5));
  });

  it('one lane absent → PARTIAL / WATCH (honest, never fabricated)', () => {
    expect(fuseMtfDeepVerdict({ row: row(), deep: null }).alignment).toBe('PARTIAL');
    expect(fuseMtfDeepVerdict({ row: row(), deep: null }).decision).toBe('WATCH');
    const noMtf = fuseMtfDeepVerdict({ row: row({ side: null, superScore: 80 }), deep: deep() });
    expect(noMtf.alignment).toBe('PARTIAL');
    expect(noMtf.decision).toBe('WATCH');
  });

  it('both lanes missing → WATCH / WATCH, no sides claimed', () => {
    const f = fuseMtfDeepVerdict({ row: null, deep: null });
    expect(f.alignment).toBe('WATCH');
    expect(f.decision).toBe('WATCH');
    expect(f.mtf.side).toBeNull();
    expect(f.deep.side).toBeNull();
  });

  it('confidence blend uses only finite inputs; missing deep confidence → null (honest, never fabricate)', () => {
    const f = fuseMtfDeepVerdict({
      row: row({ superScore: 80 }),
      // deep lane answered but carries NO confidence → a combined number
      // would be fabricated. Honest null instead of a one-lane number.
      deep: { ok: true, signal: { side: 'LONG' } },
    });
    // still ALIGNED (both sides match) but no confidence to blend → null
    expect(f.alignment).toBe('ALIGNED');
    expect(f.finalConfidence).toBeNull();
  });

  it('exposes the deep edge block honestly (null when absent)', () => {
    const withEdge = fuseMtfDeepVerdict({ row: row(), deep: deep({ edge: { winRate: 62, avgR: 0.3, trades: 40 } }) });
    expect(withEdge.deep.edge).toMatchObject({ winRate: 62, avgR: 0.3, trades: 40, good: true });
    const noEdge = fuseMtfDeepVerdict({ row: row(), deep: deep() });
    expect(noEdge.deep.edge).toBeNull();
  });
});
