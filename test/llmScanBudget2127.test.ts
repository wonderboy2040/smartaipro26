// test/llmScanBudget2127.test.ts — FreeLLMAPI per-call budgets
//
// The board Council scan must never inherit the long deep-analysis
// budget. When a routed upstream accepts the request but never
// generates, a cold board scan could otherwise park for minutes
// (debate = up to 3 calls + legacy fallback), far beyond the UI / bot
// polling window.
//
// Contract:
//   • scan default  → FREELLMAPI_SCAN_TIMEOUT_MS  (60s)
//   • deep default  → FREELLMAPI_DEEP_TIMEOUT_MS  (180s)
//   • explicit per-call timeout always wins and aborts the fetch.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REAL_FETCH = globalThis.fetch;
let councilAsk: any;
let councilAskDeep: any;
let aiMode: any;
let sentinel: any;
let freeLlm: any;

const jsonRes = (body: any, headers: Record<string, string> = {}) => Promise.resolve({
  ok: true,
  status: 200,
  headers: { get: (k: string) => headers[k.toLowerCase()] || null },
  text: async () => JSON.stringify(body),
  json: async () => body,
});

const probeOk = (url: string) => {
  if (url.endsWith('/api/ping')) return jsonRes({ ok: true });
  if (url.includes('/v1/models')) return jsonRes({ data: [{ id: 'auto:smart' }, { id: 'qwen2.5-vl-72b' }] });
  return null;
};

beforeAll(async () => {
  sentinel = await import('../server/ai/llmSentinel.js');
  aiMode = await import('../server/ai/aiMode.js');
  freeLlm = await import('../server/ai/freellmapi.js');
  ({ councilAsk, councilAskDeep } = await import('../server/ai/llmChain.js'));
});

beforeEach(() => {
  vi.stubEnv('FREELLMAPI_URL', 'http://127.0.0.1:31415');
  vi.stubEnv('FREELLMAPI_API_KEY', 'test-unified-key');
  freeLlm.__resetFreeLlmForTests();
  sentinel.__resetSentinelForTests();
  aiMode.setAiMode('smart');
});

afterAll(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  globalThis.fetch = REAL_FETCH;
});

describe('FreeLLMAPI bounded scan budget', () => {
  it('a hung chat completion is aborted at the caller budget (never the deep default)', async () => {
    let aborted = false;
    vi.stubGlobal('fetch', vi.fn((url: any, init?: any) => {
      const probe = probeOk(String(url));
      if (probe) return probe;
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        const onAbort = () => { aborted = true; reject(new Error('aborted')); };
        if (signal?.aborted) onAbort();
        else signal?.addEventListener('abort', onAbort, { once: true });
      });
    }));
    const t = Date.now();
    const out = await councilAsk('hung prompt', {}, { timeoutMs: 150 });
    const elapsed = Date.now() - t;
    expect(out).toEqual({ json: null, model: null });
    expect(aborted).toBe(true);
    expect(elapsed).toBeLessThan(5_000);
  });

  it('default scan budget is 60s and deep budget stays 180s (source contract)', () => {
    const src = fs.readFileSync(path.join(APP_ROOT, 'server', 'ai', 'llmChain.js'), 'utf8');
    expect(src).toMatch(/FREELLMAPI_SCAN_TIMEOUT_MS'\)\s*\|\|\s*_envMs\('FREELLMAPI_TIMEOUT_MS'\)\s*\|\|\s*60_000/);
    expect(src).toMatch(/FREELLMAPI_DEEP_TIMEOUT_MS'\)\s*\|\|\s*_envMs\('FREELLMAPI_TIMEOUT_MS'\)\s*\|\|\s*180_000/);
    expect(src).toMatch(/return deep \? DEEP_TIMEOUT_MS : SCAN_TIMEOUT_MS;/);
    expect(src).toMatch(/const budget = _timeoutMs\(deep, opts\.timeoutMs\);/);
    expect(src).toMatch(/timeoutMs: budget,/);
  });

  it('deep analysis still resolves through the auto:smart seat', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', vi.fn((url: any, init?: any) => {
      const probe = probeOk(String(url));
      if (probe) return probe;
      const body = JSON.parse(String(init?.body || '{}'));
      seen.push(String(body.model));
      return jsonRes(
        { choices: [{ message: { role: 'assistant', content: '{"verdicts":{}}' } }], model: 'auto:smart' },
        { 'x-routed-via': 'kilo/glm-5.2:free' },
      );
    }));
    aiMode.setAiMode('fast');
    const out = await councilAskDeep('deep prompt', {});
    expect(out.json).toEqual({ verdicts: {} });
    expect(out.model).toBe('freellmapi:kilo/glm-5.2:free');
    expect(seen[0]).toBe('auto:smart');
  });
});
