// ============================================================
// test/ollamaLifecycle.test.ts — P1 Ollama model RAM manager
// ------------------------------------------------------------
// Locks the "cloud → local Ollama models stop occupying RAM"
// contract WITHOUT stopping the Ollama service process:
//   • unloadAllOllamaModels() reads /api/ps, then unloads each
//     loaded model via /api/generate keep_alive:0
//   • warmOllamaModels() preloads models with keep_alive (default
//     OLLAMA_KEEP_ALIVE env, 5m floor)
//   • ollamaLifecycleStatus() reports the last action honestly
//   • NEVER throws — Ollama down/absent degrades to a no-op
//   • Ollama is down (fetch rejects) → unloaded:[] / loaded:0
// ============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  unloadAllOllamaModels, warmOllamaModels, ollamaLifecycleStatus,
  __resetOllamaLifecycleForTests,
} from '../server/ai/ollamaLifecycle.js';

// Track every fetch the module issues so we can assert on keep_alive.
interface Call { url: string; body: any; }
function mockOllama(opts: {
  loaded?: string[];          // models /api/ps reports as resident
  down?: boolean;            // simulate the whole daemon being absent
  failGenerate?: boolean;     // /api/generate returns 500
} = {}) {
  const calls: Call[] = [];
  const stub = vi.fn(async (url: any, init?: any) => {
    const u = String(url);
    if (opts.down) throw new Error('ECONNREFUSED');
    if (u.includes('/api/ps')) {
      const models = (opts.loaded || []).map(name => ({ name }));
      return { ok: true, json: async () => ({ models }) };
    }
    if (u.includes('/api/generate')) {
      calls.push({ url: u, body: JSON.parse(init?.body || '{}') });
      if (opts.failGenerate) return { ok: false, status: 500, body: new ResponseStream() };
      return { ok: true, status: 200, body: new ResponseStream() };
    }
    return { ok: true, json: async () => ({}) };
  });
  vi.stubGlobal('fetch', stub);
  return { calls, stub };
}

// Ollama /api/generate returns a stream even with stream:false keep_alive
// preload; the module cancels the body. Model it minimally.
class ResponseStream {
  cancel() { return Promise.resolve(); }
}

beforeEach(() => { __resetOllamaLifecycleForTests(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('unloadAllOllamaModels', () => {
  it('unloads every resident model with keep_alive:0', async () => {
    const { calls } = mockOllama({ loaded: ['qwen3:8b', 'qwen2.5vl:7b'] });
    const res = await unloadAllOllamaModels();
    expect(res.ok).toBe(true);
    expect(res.unloaded).toEqual(['qwen3:8b', 'qwen2.5vl:7b']);
    // one /api/generate per loaded model, all keep_alive:0
    const gens = calls.filter(c => c.url.includes('/api/generate'));
    expect(gens.length).toBe(2);
    for (const g of gens) expect(g.body.keep_alive).toBe('0');
    expect(gens.map(g => g.body.model)).toEqual(['qwen3:8b', 'qwen2.5vl:7b']);
  });

  it('nothing loaded → nothing to unload, still ok', async () => {
    const { calls } = mockOllama({ loaded: [] });
    const res = await unloadAllOllamaModels();
    expect(res.ok).toBe(true);
    expect(res.unloaded).toEqual([]);
    expect(calls.filter(c => c.url.includes('/api/generate')).length).toBe(0);
  });

  it('Ollama DOWN → honest empty result, never throws', async () => {
    const { stub } = mockOllama({ down: true });
    const res = await unloadAllOllamaModels();
    expect(res.ok).toBe(true);           // a no-op unload is a success
    expect(res.unloaded).toEqual([]);
    expect(stub).toHaveBeenCalled();
  });
});

describe('warmOllamaModels', () => {
  it('preloads the given models with the default keep_alive (5m floor)', async () => {
    vi.stubEnv('OLLAMA_KEEP_ALIVE', '');
    const { calls } = mockOllama({});
    const res = await warmOllamaModels(['qwen3:8b']);
    expect(res.ok).toBe(true);
    expect(res.warmed).toEqual(['qwen3:8b']);
    const g = calls.find(c => c.url.includes('/api/generate'));
    expect(g).toBeDefined();
    expect(g!.body.keep_alive).toBe('5m');   // OLLAMA_KEEP_ALIVE unset → 5m
  });

  it('honours an explicit keep_alive override', async () => {
    const { calls } = mockOllama({});
    const res = await warmOllamaModels(['qwen3:8b', 'qwen2.5vl:7b'], '30m');
    expect(res.warmed).toEqual(['qwen3:8b', 'qwen2.5vl:7b']);
    expect(res.loaded).toBe(2);
    for (const c of calls.filter(c => c.url.includes('/api/generate'))) {
      expect(c.body.keep_alive).toBe('30m');
    }
  });

  it('Ollama DOWN → warmed list kept, loaded:0, never throws', async () => {
    const { stub } = mockOllama({ down: true });
    const res = await warmOllamaModels(['qwen3:8b']);
    expect(res.ok).toBe(true);
    expect(res.warmed).toEqual(['qwen3:8b']);
    expect(res.loaded).toBe(0);
    expect(stub).toHaveBeenCalled();
  });
});

describe('ollamaLifecycleStatus', () => {
  it('starts unmanaged (none) with no models', () => {
    const s = ollamaLifecycleStatus(0);
    expect(s.managed).toBe(true);
    expect(s.lastAction).toBe('none');
    expect(s.lastModels).toEqual([]);
    expect(s.lastActionAgeSec).toBeNull();
  });

  it('reports the last action after an unload', async () => {
    mockOllama({ loaded: ['qwen3:8b'] });
    await unloadAllOllamaModels();
    const s = ollamaLifecycleStatus(Date.now());
    expect(s.lastAction).toBe('unloaded');
    expect(s.lastModels).toEqual(['qwen3:8b']);
    expect(s.lastActionAgeSec).toBe(0);
  });
});
