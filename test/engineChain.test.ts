// ============================================================
// test/engineChain.test.ts — FreeLLMAPI-first engine chain
// ------------------------------------------------------------
// End-to-end pins for the desk-agent provider chain:
//   1. FREELMAPI FIRST — the managed router answers with zero
//      direct provider keys.
//   2. DIRECT FALLBACK — provider keys still work when the router
//      is closed.
//   3. FAST-FAIL — a provider in cooldown is skipped with ZERO
//      network calls (no repeated 30s hangs per message).
//   4. HALF-OPEN — cooldown expiry auto-retries the engine.
//   5. HONEST DEGRADED MODE — the deterministic answer ends with an
//      ENGINE STATUS line (why offline + how to fix).
//   6. councilAsk (signals/council path) is router-aware too.
// ============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// hermetic data dir (same contract as cryptoAgent.test.ts)
process.env.SMART_AI_TEST = '1';
process.env.SMARTAI_DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../.test-data-engine-chain');

const cxConnected = vi.hoisted(() => ({ on: false }));
vi.mock('../server/mcp/coindcx.js', () => ({
  coindcxConnected: () => cxConnected.on,
  coindcxPrivate: vi.fn(),
  coindcxStatus: () => ({ connected: false }),
}));

const mockGetSignals = vi.fn();
const mockGetDeepSignal = vi.fn();
vi.mock('../server/ai/signals.js', () => ({
  getSignals: (...a: any[]) => mockGetSignals(...a),
  getDeepSignal: (...a: any[]) => mockGetDeepSignal(...a),
  buildRegime: vi.fn(async () => ({ btcChange: 1.2, btcTrend: 'UP' })),
  getFreshSignalForExec: vi.fn(async () => null),
  getFreshFuturesSignalForExec: vi.fn(async () => null),
}));

vi.mock('../server/ai/futures.js', async (importOriginal: any) => {
  const actual = await importOriginal();
  return {
    ...actual,
    walletSnapshot: vi.fn(),
    fetchUsdInr: vi.fn(async () => 84),
    executeFuturesSignal: vi.fn(),
    closeFuturesPosition: vi.fn(),
  };
});

vi.mock('../server/ai/agent.js', () => ({
  loadAgentConfig: () => ({ enabled: true, mode: 'paper', minAiScore: 75, rollingWindow: 10, minRollingWinRate: 35, correlationGuard: true, dynamicTimeExit: true, maxHoldMin: 90 }),
  agentStatus: vi.fn(),
}));

// FreeLLMAPI bridge stub — the chain's primary engine.
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
    provider: 'freellmapi',
    url: 'http://127.0.0.1:31415/v1/chat/completions',
    baseUrl: 'http://127.0.0.1:31415',
    apiKey: 'unified-test-key',
    defModel: 'auto:balanced',
    deepModel: 'auto:smart',
    fastModel: 'auto:fast',
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

import { runCryptoAgent } from '../server/ai/cryptoAgent.js';
import { councilAsk } from '../server/ai/llmChain.js';
import { __resetAiModeForTests } from '../server/ai/aiMode.js';
import { engineTrack, engineSnapshot, __resetSentinelForTests } from '../server/ai/llmSentinel.js';

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

const okChat = (content: string) => async () => ({
  ok: true, status: 200,
  json: async () => ({ choices: [{ message: { role: 'assistant', content, tool_calls: [] } }] }),
});
const badStatus = (code: number) => async () => ({ ok: false, status: code, json: async () => ({}) });

const COMPAT = {
  groq: { url: 'https://api.groq.com/openai/v1/chat/completions', defModel: 'openai/gpt-oss-120b' },
  cerebras: { url: 'https://api.cerebras.ai/v1/chat/completions', defModel: 'gpt-oss-120b' },
  openrouter: { url: 'https://openrouter.ai/api/v1/chat/completions', defModel: 'z-ai/glm-5.2:free' },
  huggingface: { url: 'https://router.huggingface.co/v1/chat/completions', defModel: 'Qwen/Qwen3-235B-A22B-Instruct-2507' },
  nvidia: { url: 'https://integrate.api.nvidia.com/v1/chat/completions', defModel: 'openai/gpt-oss-120b' },
};

const SOL_DEEP = [{ role: 'user', content: 'SOL ka deep analysis karo — entry, SL, leverage sab exact numbers me' }];
const SOL_SIGNAL = {
  ok: true, signal: {
    symbol: 'SOL', side: 'LONG', grade: 'STRONG', confidence: 82, agreement: 0.85,
    voters: 9, totalModels: 11, ltp: 9000, changePct: 2.1,
    superIntel: { aiScore: 83, tier: 'STRONG', blueprint: { entryZone: [8900, 9100], leverage: 3, maxSaneLeverage: 7, liquidation: 6200 } },
    plan: { entry: 9000, stopLoss: 8600, target1: 9400, target2: 9800, riskPct: 4.4, rewardRisk: 2 },
    quality: { veto: null, mtf: '2/3', session: 'open' },
    votes: [{ name: 'TrendMatrix', dir: 1, conf: 80, reasons: ['stack up'] }],
  },
};

beforeEach(() => {
  __resetSentinelForTests();
  __resetAiModeForTests();
  _fl.up = false;
  _fl.routedVia = 'kilo/glm-5.2:free';
  _fl.json = { verdict: 'CONFIRM', confidence: 80 };
  _fl.calls.length = 0;
  fetchCalls.length = 0;
  routes = {};
  mockGetDeepSignal.mockReset().mockResolvedValue(SOL_SIGNAL);
  mockGetSignals.mockReset().mockResolvedValue({ ok: true, market: 'CRYPTO', signals: [] });
});
afterEach(() => {
  // NOTE: deliberately NO vi.unstubAllGlobals() here — the module-level
  // fetch stub must survive across tests (routes/fetchCalls are reset
  // manually in beforeEach).
  vi.restoreAllMocks();
});

describe('engine chain — the crypto desk agent', () => {
  it('FREELMAPI FIRST: answers through the local router with ZERO provider keys', async () => {
    _fl.up = true;
    routes = { '127.0.0.1:31415/v1/chat/completions': okChat('SOL LONG ticket — router answer') };
    const out = await runCryptoAgent(SOL_DEEP, { KEYS: {}, OPENAI_COMPAT: COMPAT });
    expect(out.ok).toBe(true);
    expect(out.engine).toContain('freellmapi');
    expect(out.degraded).toBeUndefined();
    expect(fetchCalls.some(u => u.includes('127.0.0.1:31415/v1/chat/completions'))).toBe(true);
    const sentAuth = (fetchCalls.length > 0);
    expect(sentAuth).toBe(true);
  });

  it('DIRECT FALLBACK: router down → a configured provider still answers', async () => {
    _fl.up = false;
    routes = { 'api.groq.com': okChat('groq fallback ticket') };
    const out = await runCryptoAgent(SOL_DEEP, { KEYS: { groq: 'g' }, OPENAI_COMPAT: COMPAT });
    expect(out.ok).toBe(true);
    expect(out.engine).toContain('groq');
    expect(fetchCalls.some(u => u.includes('api.groq.com'))).toBe(true);
  });

  it('FAST-FAIL: a provider in cooldown is skipped with ZERO network calls to it', async () => {
    engineTrack('groq', new Error('groq 500'));
    engineTrack('groq', new Error('groq 500')); // 2nd → 30s cooldown
    routes = { 'api.groq.com': badStatus(500) };
    const out = await runCryptoAgent(SOL_DEEP, {
      KEYS: { groq: 'g' },
      OPENAI_COMPAT: COMPAT,
    });
    expect(fetchCalls.some(u => u.includes('api.groq.com'))).toBe(false);
    expect(out.ok).toBe(true);
    expect(out.engine).toBe('super-intel-deterministic');
    expect(out.degraded).toBe(true);
    expect(out.text).toContain('FULL TICKET');
  });

  it('HALF-OPEN: cooldown expiry auto-retries the engine (no restart needed)', async () => {
    const past = Date.now() - 400_000;
    engineTrack('groq', new Error('groq 500'), past);
    engineTrack('groq', new Error('groq 500'), past); // cooldown already expired NOW
    routes = { 'api.groq.com': okChat('recovered engine answer') };
    const out = await runCryptoAgent(SOL_DEEP, {
      KEYS: { groq: 'g' },
      OPENAI_COMPAT: COMPAT,
    });
    expect(out.ok).toBe(true);
    expect(out.engine).toContain('groq');
    expect(fetchCalls.some(u => u.includes('api.groq.com'))).toBe(true);
  });

  it('DEGRADED honesty: nothing configured → deterministic ticket + ENGINE STATUS guidance line', async () => {
    const out = await runCryptoAgent(SOL_DEEP, { KEYS: {}, OPENAI_COMPAT: {} });
    expect(out.ok).toBe(true);
    expect(out.engine).toBe('super-intel-deterministic');
    expect(out.text).toContain('FULL TICKET');
    expect(out.text).toContain('ENGINE STATUS');
    expect(out.text).toContain('FreeLLMAPI');
    const providerFrags = ['generativelanguage', 'api.groq.com', 'api.cerebras.ai', 'openrouter.ai', 'router.huggingface.co', 'integrate.api.nvidia.com'];
    expect(fetchCalls.some(u => providerFrags.some(f => u.includes(f)))).toBe(false);
  });

  it('DEGRADED honesty: failed engines are named with reason + auto-retry in the status line', async () => {
    engineTrack('groq', new Error('groq 429'));
    engineTrack('groq', new Error('groq 429'));
    routes = { 'api.groq.com': badStatus(429) };
    const out = await runCryptoAgent(SOL_DEEP, { KEYS: { groq: 'g' }, OPENAI_COMPAT: COMPAT });
    expect(out.degraded).toBe(true);
    expect(out.text).toContain('ENGINE STATUS');
    expect(out.text).toContain('groq');
    expect(out.text).toContain('cooldown');
    expect(out.text).toContain('429');
    expect(fetchCalls.some(u => u.includes('api.groq.com'))).toBe(false);
  });
});

describe('councilAsk (signals/council chain) — FreeLLMAPI contract', () => {
  it('answers via the router and never touches a direct provider', async () => {
    _fl.up = true;
    _fl.json = { verdict: 'CONFIRM', confidence: 80, reason: 'router' };
    const { json, model } = await councilAsk('prompt', {
      KEYS: { gemini: 'g', groq: 'q', huggingface: 'h' },
      OPENAI_COMPAT: COMPAT,
    });
    expect(model).toBe('freellmapi:kilo/glm-5.2:free');
    expect(json?.verdict).toBe('CONFIRM');
    expect(_fl.calls.length).toBe(1);
    const providerFrags = ['generativelanguage', 'api.groq.com', 'api.cerebras.ai', 'openrouter.ai', 'router.huggingface.co', 'integrate.api.nvidia.com'];
    expect(fetchCalls.some(u => providerFrags.some(f => u.includes(f)))).toBe(false);
  });

  it('a cooled router is fast-skipped with ZERO network calls', async () => {
    _fl.up = true;
    engineTrack('freellmapi', new Error('freellmapi 500'));
    engineTrack('freellmapi', new Error('freellmapi 500'));
    const out = await councilAsk('prompt', { KEYS: { gemini: 'g' }, OPENAI_COMPAT: COMPAT });
    expect(out).toEqual({ json: null, model: null });
    expect(_fl.calls.length).toBe(0);
    expect(fetchCalls.length).toBe(0);
  });
});
