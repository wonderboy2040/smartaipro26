// ============================================================
// test/mtfBoardAiLane.test.ts — FreeLLMAPI board AI lane
// ------------------------------------------------------------
// Locks two contracts:
//
// 1. applyCloudAiLane (pure scoring lever in mtfDualBoard.js):
//    • live CONFIRM on an already-strong, clean row (≥75) → +3
//    • live CAUTION on a row ≥80 → honest-cap to 74
//    • a CONFIRM on a WEAK row (<75) → NO boost (no fake 80s)
//    • a CONFIRM blocked by trap/wall/direction conflict → NO boost
//    • rule-based / absent guards → unchanged
//
// 2. evaluateMtfRowWithAiGuard's `engine` field:
//    • router offline → 'rule' (honest rule-based guard)
//    • router online → the fire-and-forget auto:fast seat answers and
//      the cached engine flips to 'freellmapi' with a live label.
//
// freellmapi.js is vi.mock'd so the suite never touches the developer's
// desktop router, provider keys, or the real ai-mode file.
// ============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { applyCloudAiLane } from '../server/ai/mtfDualBoard.js';
import {
  evaluateMtfRowWithAiGuard,
  getAiGuardModels,
  __resetSentinelForTests,
} from '../server/ai/llmSentinel.js';

// Controllable stand-in for the FreeLLMAPI bridge.
const _fl = vi.hoisted(() => ({
  up: false,
  json: { action: 'CONFIRM', confidence: 80, note: 'clean breakout' } as Record<string, unknown>,
  calls: 0,
}));

vi.mock('../server/ai/freellmapi.js', () => ({
  FREELLMAPI_MODELS: {
    smart: 'auto:smart', balanced: 'auto:balanced', fast: 'auto:fast',
    reliable: 'auto:reliable', fusion: 'fusion', vision: 'qwen2.5-vl-72b',
  },
  freeLlmProbe: async () => _fl.up,
  freeLlmStatus: () => ({
    available: _fl.up,
    reachable: _fl.up,
    baseUrl: _fl.up ? 'http://127.0.0.1:31415' : null,
    modelsCount: _fl.up ? 115 : 0,
  }),
  freeLlmReachableCached: () => _fl.up,
  freeLlmJson: vi.fn(async () => {
    _fl.calls++;
    if (!_fl.up) throw new Error('freellmapi offline');
    return {
      json: { ..._fl.json },
      text: JSON.stringify(_fl.json),
      model: 'auto:fast',
      routedVia: 'kilo/glm-5.2:free',
      latencyMs: 9,
      usage: null,
    };
  }),
}));

vi.mock('../server/ai/aiMode.js', () => ({
  getAiMode: () => 'smart',
  setAiMode: () => ({ ok: false }),
  getAiModeStatus: () => ({ mode: 'smart' }),
}));

beforeEach(() => {
  __resetSentinelForTests();
  _fl.up = false;
  _fl.json = { action: 'CONFIRM', confidence: 80, note: 'clean breakout' };
  _fl.calls = 0;
});

afterEach(() => {
  __resetSentinelForTests();
  vi.unstubAllGlobals();
});

describe('applyCloudAiLane — the 80+ scoring lever', () => {
  const clean = { trapVeto: false, zoneWallVeto: false, boardSideConflict: false, svaConflict: false };

  it('live CONFIRM on a strong clean row (≥75) earns +3 and a driver', () => {
    const drivers: string[] = [];
    const out = applyCloudAiLane({
      score: 78, cap: null, tier: 'ACTION',
      trio: { engine: 'freellmapi', liveVerdict: 'CONFIRM' },
      drivers, ...clean,
    });
    expect(out.score).toBe(81);                 // 78 + 3 → crosses into STRONG
    expect(out.tier).toBe('STRONG');
    expect(drivers).toContain('🏁 FreeLLMAPI CONFIRM (+3)');
  });

  it('live CAUTION on a row ≥80 is honest-capped to 74', () => {
    const drivers: string[] = [];
    const out = applyCloudAiLane({
      score: 82, cap: null, tier: 'STRONG',
      trio: { engine: 'freellmapi', liveVerdict: 'CAUTION' },
      drivers, ...clean,
    });
    expect(out.score).toBe(74);
    expect(out.tier).toBe('ACTION');
    expect(drivers).toContain('⚠ FreeLLMAPI CAUTION (capped ≤74)');
  });

  it('live CONFIRM on a WEAK row (<75) never boosts (no fabricated 80s)', () => {
    const drivers: string[] = [];
    const out = applyCloudAiLane({
      score: 68, cap: null, tier: 'ACTION',
      trio: { engine: 'freellmapi', liveVerdict: 'CONFIRM' },
      drivers, ...clean,
    });
    expect(out.score).toBe(68);
    expect(drivers).toHaveLength(0);
  });

  it('a CONFIRM vetoed by a trap / wall / direction conflict is NOT rewarded', () => {
    const drivers: string[] = [];
    for (const veto of [{ trapVeto: true }, { zoneWallVeto: true }, { boardSideConflict: true }, { svaConflict: true }] as const) {
      const out = applyCloudAiLane({
        score: 79, cap: null, tier: 'ACTION',
        trio: { engine: 'freellmapi', liveVerdict: 'CONFIRM' },
        drivers, ...clean, ...veto,
      });
      expect(out.score).toBe(79);
    }
    expect(drivers).toHaveLength(0);
  });

  it('rule-based guards are left untouched', () => {
    const drivers: string[] = [];
    const out = applyCloudAiLane({
      score: 78, cap: null, tier: 'ACTION',
      trio: { engine: 'rule', liveVerdict: 'CONFIRM' },
      drivers, ...clean,
    });
    expect(out.score).toBe(78);
    expect(drivers).toHaveLength(0);
  });

  it('a null/absent trio is a no-op', () => {
    const out = applyCloudAiLane({ score: 82, cap: null, tier: 'STRONG', trio: null, ...clean });
    expect(out.score).toBe(82);
  });
});

describe('evaluateMtfRowWithAiGuard — the engine field', () => {
  const ROW = {
    symbol: 'BTC', side: 'LONG', superScore: 70, mode: 'INTRADAY',
    worldAligned8Count: 7, aligned: true, triggerFired: true, netRR_T2: 1.8,
  };

  it('offline router → engine "rule" and the honest rule-based label', () => {
    const r = evaluateMtfRowWithAiGuard(ROW);
    expect(r.engine).toBe('rule');
    expect(r.reachable).toBe(false);
    expect(r.ruleBasedGuard).toBe(true);
    expect(r.honestLabel).toContain('Rule-Based Guard');
    expect(r.verdict).toContain('FREELMAPI');
  });

  it('reports the three FreeLLMAPI virtual seats when the router is online', () => {
    _fl.up = true;
    const g = getAiGuardModels();
    expect(g.engine).toBe('freellmapi');
    expect(g.reachable).toBe(true);
    expect(g.models).toEqual(['auto:fast', 'auto:smart', 'auto:balanced']);
    expect(g.count).toBe(3);
    expect(g.profile).toBe('smart');
  });

  it('online router → the fire-and-forget seat upgrades the engine to freellmapi', async () => {
    _fl.up = true;
    const first = evaluateMtfRowWithAiGuard(ROW);
    expect(first.engine).toBe('rule'); // first ask returns instantly

    let live = first;
    for (let i = 0; i < 60 && live.engine !== 'freellmapi'; i++) {
      await new Promise<void>(resolve => setTimeout(resolve, 5));
      live = evaluateMtfRowWithAiGuard(ROW);
    }
    expect(_fl.calls).toBeGreaterThan(0);
    expect(live.engine).toBe('freellmapi');
    expect(live.ruleBasedGuard).toBe(false);
    expect(live.honestLabel).toContain('Live FreeLLMAPI');
    expect(live.liveVerdict).toBe('CONFIRM');
  });

  it('a CAUTION answer caps sentinel approval (no false lock)', async () => {
    _fl.up = true;
    _fl.json = { action: 'WAIT', confidence: 40, note: 'chop — wait' };
    const ctx = { ...ROW, mode: 'CAUTION_TEST' };
    evaluateMtfRowWithAiGuard(ctx);
    let live = evaluateMtfRowWithAiGuard(ctx);
    for (let i = 0; i < 60 && live.engine !== 'freellmapi'; i++) {
      await new Promise<void>(resolve => setTimeout(resolve, 5));
      live = evaluateMtfRowWithAiGuard(ctx);
    }
    expect(live.engine).toBe('freellmapi');
    expect(live.liveVerdict).toBe('CAUTION');
    expect(live.approvedCount).toBeLessThan(3);
  });
});
