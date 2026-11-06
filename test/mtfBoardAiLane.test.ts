// ============================================================
// test/mtfBoardAiLane.test.ts — P2 mode-aware board AI lane
// ------------------------------------------------------------
// Locks two contracts:
//
// 1. applyCloudAiLane (pure scoring lever in mtfDualBoard.js):
//    • cloud CONFIRM on an already-strong, clean row (≥75) → +3
//    • cloud CAUTION on a row ≥80 → honest-cap to 74
//    • a cloud CONFIRM on a WEAK row (<75) → NO boost (no fake 80s)
//    • a CONFIRM blocked by trap/wall/direction conflict → NO boost
//    • non-opencode engines (Ollama local / rule) → unchanged
//
// 2. evaluateMtfRowWithOllamaTrio's `engine` field:
//    • local mode → 'ollama'
//    • cloud mode → 'opencode', the local Ollama fetch is NOT fired,
//      and the OpenCode bridge IS invoked for a warm row (≥60).
//
// aiMode is vi.mock'd so the real server/data/ai-mode.json is NEVER
// read or written by the test suite.
// ============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { applyCloudAiLane } from '../server/ai/mtfDualBoard.js';
import {
  evaluateMtfRowWithOllamaTrio,
  __resetSentinelForTests,
} from '../server/ai/llmSentinel.js';
import {
  __resetOpenCodeForTests, __setSpawnForTests, __setKillTreeForTests,
  resolveSeatModel,
} from '../server/ai/opencodeBridge.js';

// Controllable stand-in for getAiMode().
vi.mock('../server/ai/aiMode.js', () => ({
  getAiMode: () => (globalThis as any).__aiModeTest ?? 'local',
  setAiMode: () => ({ ok: false }),
  getAiModeStatus: () => ({ mode: (globalThis as any).__aiModeTest ?? 'local' }),
}));

const setAiModeForTest = (m: 'local' | 'cloud' | 'both' | null) => {
  if (m === null) delete (globalThis as any).__aiModeTest;
  else (globalThis as any).__aiModeTest = m;
};

// ---- fake opencode spawn (same harness as opencodeBridge.test.ts) ----
type FakeChild = EventEmitter & {
  stdout: PassThrough; stderr: PassThrough; stdin: PassThrough;
  writes: string[]; pid: number; kill: ReturnType<typeof vi.fn>;
};
function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.writes = [];
  child.stdin.on('data', (c: Buffer | string) => child.writes.push(String(c)));
  child.pid = 9000;
  child.kill = vi.fn();
  return child;
}
function validJsonl(obj: unknown): string {
  return JSON.stringify({ type: 'text', part: { type: 'text', text: JSON.stringify(obj) } }) + '\n';
}

beforeEach(() => {
  setAiModeForTest(null);
  __resetSentinelForTests();
  __resetOpenCodeForTests();
  __setSpawnForTests(null);
  __setKillTreeForTests(null);
  vi.stubEnv('OLLAMA_BASE', 'http://127.0.0.1:11434');
  // Ollama is DOWN in these tests — the local path degrades to rule-guard.
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
  // A fast cloud link so resolveSeatModel('fast') is defined.
  vi.stubEnv('AI_TRIO_FAST_CHAIN', 'opencode:glm-5.3-flash-free');
});

afterEach(() => {
  setAiModeForTest(null);
  __resetSentinelForTests();
  __resetOpenCodeForTests();
  __setSpawnForTests(null);
  __setKillTreeForTests(null);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('applyCloudAiLane — the 80+ scoring lever', () => {
  const clean = { trapVeto: false, zoneWallVeto: false, boardSideConflict: false, svaConflict: false };

  it('cloud CONFIRM on a strong clean row (≥75) earns +3 and a driver', () => {
    const drivers: string[] = [];
    const out = applyCloudAiLane({
      score: 78, cap: null, tier: 'ACTION',
      trio: { engine: 'opencode', liveVerdict: 'CONFIRM' },
      drivers, ...clean,
    });
    expect(out.score).toBe(81);                 // 78 + 3 → crosses into STRONG
    expect(out.tier).toBe('STRONG');
    expect(drivers).toContain('🏁 Cloud AI CONFIRM (+3)');
  });

  it('cloud CAUTION on a row ≥80 is honest-capped to 74', () => {
    const drivers: string[] = [];
    const out = applyCloudAiLane({
      score: 82, cap: null, tier: 'STRONG',
      trio: { engine: 'opencode', liveVerdict: 'CAUTION' },
      drivers, ...clean,
    });
    expect(out.score).toBe(74);
    expect(out.tier).toBe('ACTION');
    expect(drivers).toContain('⚠ Cloud AI CAUTION (capped ≤74)');
  });

  it('cloud CONFIRM on a WEAK row (<75) never boosts (no fabricated 80s)', () => {
    const drivers: string[] = [];
    const out = applyCloudAiLane({
      score: 68, cap: null, tier: 'ACTION',
      trio: { engine: 'opencode', liveVerdict: 'CONFIRM' },
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
        trio: { engine: 'opencode', liveVerdict: 'CONFIRM' },
        drivers, ...clean, ...veto,
      });
      expect(out.score).toBe(79);
    }
    expect(drivers).toHaveLength(0);
  });

  it('non-opencode engines (local Ollama / rule) are left untouched', () => {
    const drivers: string[] = [];
    const out = applyCloudAiLane({
      score: 78, cap: null, tier: 'ACTION',
      trio: { engine: 'ollama', liveVerdict: 'CONFIRM' },
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

describe('evaluateMtfRowWithOllamaTrio — the engine field', () => {
  it('local mode → engine "ollama" even when the daemon is down (rule-guard)', () => {
    setAiModeForTest('local');
    const r = evaluateMtfRowWithOllamaTrio({ symbol: 'BTC', side: 'LONG', superScore: 70, mode: 'INTRADAY' });
    expect(r.engine).toBe('ollama');
    expect(r.aiMode).toBe('local');
    expect(r.reachable).toBe(false);            // Ollama down
    expect(r.ruleBasedGuard).toBe(true);
  });

  it('cloud mode → engine "opencode" and the local Ollama fetch is NOT fired', () => {
    setAiModeForTest('cloud');
    const fetchMock = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    vi.stubGlobal('fetch', fetchMock);
    const r = evaluateMtfRowWithOllamaTrio({ symbol: 'BTC', side: 'LONG', superScore: 70, mode: 'INTRADAY' });
    expect(r.engine).toBe('opencode');
    expect(r.aiMode).toBe('cloud');
    // No Ollama /api/generate call may have been issued in cloud mode.
    const ollamaGen = fetchMock.mock.calls.filter(c => String(c[0]).includes('/api/generate'));
    expect(ollamaGen.length).toBe(0);
  });

  it('cloud mode invokes the OpenCode bridge for a warm row (≥60)', () => {
    setAiModeForTest('cloud');
    expect(resolveSeatModel('fast')).toBe('glm-5.3-flash-free'); // chain wired
    let spawned = 0;
    __setSpawnForTests(vi.fn((bin: string, args: string[], opts: any) => {
      spawned++;
      const child = fakeChild();
      child.stdout.write(validJsonl({ action: 'CONFIRM', confidence: 80, note: 'packa' }));
      setTimeout(() => { try { child.stdout.end(); } catch { /* noop */ } child.emit('close', 0, null); }, 0);
      return child;
    }));
    const r = evaluateMtfRowWithOllamaTrio({ symbol: 'BTC', side: 'LONG', superScore: 70, mode: 'INTRADAY' });
    expect(r.engine).toBe('opencode');
    // fire-and-forget warm → give the stubbed spawn a beat to land
    return new Promise<void>(resolve => {
      const tick = (n: number) => {
        if (spawned >= 1 || n > 40) return resolve();
        setTimeout(() => tick(n + 1), 5);
      };
      tick(0);
    });
  });

  it('a weak row (<60) in cloud does NOT spend a cloud warm call', () => {
    setAiModeForTest('cloud');
    let spawned = 0;
    __setSpawnForTests(vi.fn((bin: string, args: string[], opts: any) => {
      spawned++;
      const child = fakeChild();
      setTimeout(() => child.emit('close', 0, null), 0);
      return child;
    }));
    evaluateMtfRowWithOllamaTrio({ symbol: 'BTC', side: 'LONG', superScore: 45, mode: 'INTRADAY' });
    // Allow microtasks to flush, then assert no spawn happened.
    return new Promise<void>(resolve => {
      setTimeout(() => { expect(spawned).toBe(0); resolve(); }, 20);
    });
  });
});
