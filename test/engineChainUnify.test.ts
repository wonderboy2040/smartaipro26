// ============================================================
// test/engineChainUnify.test.ts — ONE FreeLLMAPI CHAIN
// ------------------------------------------------------------
// The board/council/validator share ONE chain. Pins:
//   1. councilAsk answers via the local router with zero provider keys.
//   2. The success is sentinel-tracked (state ready).
//   3. Direct keys alone do NOT make the lane online.
//   4. signals.js aiCouncilVerify goes ONLINE with zero keys when the
//      router is reachable (the "engines offline" killer).
//   5. signals.js has NO private chain left — it rides llmChain.
//   6. council.js runs its persona batch via the router.
// ============================================================
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// hermetic data dir (same contract as engineChain.test.ts)
process.env.SMARTAI_DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../.test-data-engine-unify');

vi.mock('../server/mcp/coindcx.js', () => ({
  coindcxConnected: () => false,
  coindcxPrivate: vi.fn(),
  coindcxStatus: () => ({ connected: false }),
}));

const _fl = vi.hoisted(() => ({
  up: false,
  routedVia: 'kilo/glm-5.2:free',
  json: { verdict: 'CONFIRM', confidence: 80 } as Record<string, unknown>,
  calls: [] as Array<{ prompt: string; opts: any }>,
}));

vi.mock('../server/ai/freellmapi.js', () => ({
  FREELLMAPI_MODELS: {
    smart: 'auto:smart', balanced: 'auto:balanced', fast: 'auto:fast',
    reliable: 'auto:reliable', fusion: 'fusion', vision: 'qwen2.5-vl-72b',
  },
  freeLlmProbe: async () => _fl.up,
  freeLlmKeyPresentCached: () => _fl.up,
  freeLlmReachableCached: () => _fl.up,
  freeLlmAgentCfg: async () => _fl.up ? {
    provider: 'freellmapi', url: 'http://127.0.0.1:31415/v1/chat/completions',
    baseUrl: 'http://127.0.0.1:31415', apiKey: 'unified-test-key',
    defModel: 'auto:balanced', deepModel: 'auto:smart', fastModel: 'auto:fast',
  } : null,
  freeLlmJson: async (prompt: string, opts: any = {}) => {
    _fl.calls.push({ prompt, opts });
    return {
      json: { ..._fl.json },
      text: JSON.stringify(_fl.json),
      model: opts.model || 'auto:smart',
      routedVia: _fl.routedVia,
      latencyMs: 5,
      usage: null,
    };
  },
  freeLlmVision: async () => { throw new Error('vision not used in this suite'); },
  freeLlmStatus: () => ({ available: _fl.up, baseUrl: _fl.up ? 'http://127.0.0.1:31415' : null }),
}));

import { councilAsk, aiEngineOnline } from '../server/ai/llmChain.js';
import { __resetAiModeForTests } from '../server/ai/aiMode.js';
import { engineSnapshot, __resetSentinelForTests } from '../server/ai/llmSentinel.js';
import { aiCouncilVerify } from '../server/ai/signals.js';
import { runCouncilBoard } from '../server/ai/council.js';

// ---------------- fetch router mock ----------------
const fetchCalls: string[] = [];
let routes: Record<string, () => Promise<{ ok: boolean; status: number; json: any }>> = {};

vi.stubGlobal('fetch', vi.fn(async (url: any) => {
  const u = String(url);
  fetchCalls.push(u);
  for (const [frag, fn] of Object.entries(routes)) {
    if (u.includes(frag)) return fn();
  }
  return { ok: false, status: 500, json: async () => ({}) }; // default: refuse
}));

const COMPAT = {
  groq: { url: 'https://api.groq.com/openai/v1/chat/completions', defModel: 'openai/gpt-oss-120b' },
  cerebras: { url: 'https://api.cerebras.ai/v1/chat/completions', defModel: 'gpt-oss-120b' },
  openrouter: { url: 'https://openrouter.ai/api/v1/chat/completions', defModel: 'z-ai/glm-5.2:free' },
  huggingface: { url: 'https://router.huggingface.co/v1/chat/completions', defModel: 'Qwen/Qwen3-235B-A22B-Instruct-2507' },
  nvidia: { url: 'https://integrate.api.nvidia.com/v1/chat/completions', defModel: 'openai/gpt-oss-120b' },
};

const PROVIDER_FRAGS = ['generativelanguage', 'api.groq.com', 'api.cerebras.ai', 'openrouter.ai', 'router.huggingface.co', 'integrate.api.nvidia.com'];

beforeEach(() => {
  __resetSentinelForTests();
  __resetAiModeForTests();
  _fl.up = false;
  _fl.routedVia = 'kilo/glm-5.2:free';
  _fl.json = { verdict: 'CONFIRM', confidence: 80 };
  _fl.calls.length = 0;
  fetchCalls.length = 0;
  routes = {};
});

describe('councilAsk rides the local FreeLLMAPI router', () => {
  it('CONTRACT 1 — zero provider keys + router up → the chain ANSWERS via the router', async () => {
    _fl.up = true;
    _fl.json = { verdict: 'CONFIRM', confidence: 81, reason: 'router brain' };
    const { json, model } = await councilAsk('prompt', { KEYS: {}, OPENAI_COMPAT: COMPAT });
    expect(model).toBe('freellmapi:kilo/glm-5.2:free');
    expect(json?.verdict).toBe('CONFIRM');
    expect(_fl.calls.length).toBe(1);
    expect(fetchCalls.some(u => PROVIDER_FRAGS.some(f => u.includes(f)))).toBe(false);
  });

  it('CONTRACT 2 — the router success is sentinel-tracked (state ready)', async () => {
    _fl.up = true;
    await councilAsk('prompt', { KEYS: {}, OPENAI_COMPAT: COMPAT });
    const snap = engineSnapshot({});
    const fl = snap.find(e => e.provider === 'freellmapi');
    expect(fl?.state).toBe('ready');
  });

  it('CONTRACT 2b — router unreachable → honest null, no provider call', async () => {
    const { json, model } = await councilAsk('prompt', { KEYS: {}, OPENAI_COMPAT: COMPAT });
    expect(json).toBeNull();
    expect(model).toBeNull();
    expect(fetchCalls.some(u => PROVIDER_FRAGS.some(f => u.includes(f)))).toBe(false);
  });

  it('CONTRACT 3 — paid keys alone do NOT make the lane online', async () => {
    const online = await aiEngineOnline({ KEYS: { gemini: 'gm', groq: 'g', nvidia: 'nv' } });
    expect(online).toBe(false);
    expect(fetchCalls.some(u => PROVIDER_FRAGS.some(f => u.includes(f)))).toBe(false);
  });

  it('CONTRACT 3b — router reachable → aiEngineOnline true', async () => {
    _fl.up = true;
    expect(await aiEngineOnline({ KEYS: {} })).toBe(true);
  });
});

describe('the BOARD seat (signals.js aiCouncilVerify) is unified', () => {
  const CAND = [{
    symbol: 'SOL', side: 'LONG', confidence: 78, ltp: 9000, changePct: 2.1,
    ind: { rsi: 55, adx: { adx: 24 }, relVolume: 1.8, vwap: 8950, atr: 90 },
    plan: { entry: 9000, stopLoss: 8600, target1: 9400, target2: 9800 },
    votes: [{ name: 'TrendMatrix', dir: 1, conf: 80 }],
  }];

  it('CONTRACT 4 — zero provider keys + router up → the council goes ONLINE', async () => {
    _fl.up = true;
    _fl.json = { verdicts: { SOL: { verdict: 'LONG', confidence: 80, note: 'router', analysis: 'ok' } } };
    const out = await aiCouncilVerify(CAND, { KEYS: {}, OPENAI_COMPAT: COMPAT }, 'CRYPTO');
    expect(out.online).toBe(true);
    expect(out.model).toContain('freellmapi');
    expect(out.verdicts?.SOL?.verdict).toBe('LONG');
  });

  it('CONTRACT 5 — paid keys + no router → honest offline, ZERO paid provider calls', async () => {
    const out = await aiCouncilVerify(CAND, { KEYS: { gemini: 'g', huggingface: 'h', groq: 'q' }, OPENAI_COMPAT: COMPAT }, 'CRYPTO');
    expect(out.online).toBe(false);
    expect(out.model).toBeNull();
    expect(fetchCalls.some(u => ['generativelanguage', 'api.groq.com', 'router.huggingface.co'].some(f => u.includes(f)))).toBe(false);
  });

  it('CONTRACT 5b — no engines at all → honest offline (no crash)', async () => {
    const out = await aiCouncilVerify(CAND, { KEYS: {}, OPENAI_COMPAT: COMPAT }, 'CRYPTO');
    expect(out.online).toBe(false);
    expect(out.model).toBeNull();
  });
});

describe('the GLOBAL COUNCIL gate is router-aware', () => {
  it('CONTRACT 6 — zero provider keys + router up → council runs personas (not deterministic)', async () => {
    _fl.up = true;
    _fl.json = { verdicts: { SOL: { bull: 60, bear: 20, note: 'n', analysis: 'a' } } };
    routes = {
      'api.binance.com': async () => ({ ok: false, status: 500, json: async () => ({}) }),
    };
    const out = await runCouncilBoard({
      market: 'CRYPTO',
      signals: [{ symbol: 'SOL', side: 'LONG', confidence: 78, ltp: 9000 }],
      regime: {},
      deps: { KEYS: {}, OPENAI_COMPAT: COMPAT },
    });
    expect(out).toBeTruthy();
    // the LLM path ran (persona asks hit the router) — the board did NOT
    // collapse to the deterministic-only quant path
    expect(_fl.calls.length).toBeGreaterThan(0);
  });
});
