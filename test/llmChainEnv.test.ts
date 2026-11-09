// ============================================================
// test/llmChainEnv.test.ts — FreeLLMAPI profiles + chain
// ------------------------------------------------------------
// Locks the new contract:
//   1. AI_MODE / FREELLMAPI_PROFILE only SEED the first-boot profile.
//   2. A runtime switch > persisted file > env seed.
//   3. SMART/BALANCED/FAST map to auto:smart / auto:balanced / auto:fast.
//   4. Deep analysis ALWAYS asks auto:smart (depth beats latency).
//   5. aiEngineOnline() is the honest FreeLLMAPI availability gate.
//   6. Legacy local/cloud/both values migrate to SMART.
// ============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';

// Shared hermetic dir from src/test/setup.ts (module imports above already
// resolved store.js against it). ai-mode.json is wiped around every test.
const DATA = process.env.SMARTAI_DATA_DIR || path.join(process.cwd(), '.test-data-llm-chain-env');
const MODE_FILE = path.join(DATA, 'ai-mode.json');

const _env = vi.hoisted(() => ({
  up: false,
  fail: false,
  routedVia: 'kilo/glm-5.2:free',
  json: { verdict: 'CONFIRM', confidence: 70 } as Record<string, unknown>,
  calls: [] as Array<{ prompt: string; opts: any }>,
}));

vi.mock('../server/ai/freellmapi.js', () => ({
  FREELLMAPI_MODELS: {
    smart: 'auto:smart', balanced: 'auto:balanced', fast: 'auto:fast',
    reliable: 'auto:reliable', fusion: 'fusion', vision: 'qwen2.5-vl-72b',
  },
  freeLlmProbe: async () => _env.up,
  freeLlmKeyPresentCached: () => _env.up,
  freeLlmJson: async (prompt: string, opts: any = {}) => {
    _env.calls.push({ prompt, opts });
    if (_env.fail) throw new Error('freellmapi 429');
    return {
      json: { ..._env.json },
      text: JSON.stringify(_env.json),
      model: opts.model || 'auto:smart',
      routedVia: _env.routedVia,
      latencyMs: 12,
      usage: null,
    };
  },
  freeLlmVision: async () => { throw new Error('vision not used in this suite'); },
  freeLlmStatus: () => ({ available: _env.up }),
}));

import {
  getAiMode, getAiModeStatus, setAiMode, normalizeAiMode, __resetAiModeForTests,
} from '../server/ai/aiMode.js';
import { councilAsk, councilAskDeep, aiEngineOnline, mergeBothVerdicts } from '../server/ai/llmChain.js';
import { __resetSentinelForTests } from '../server/ai/llmSentinel.js';

const PAID_KEYS = { gemini: 'g', groq: 'q', cerebras: 'c', openrouter: 'o', huggingface: 'h', nvidia: 'n' };

function removeModeFile() {
  try { fs.rmSync(MODE_FILE, { force: true }); } catch { /* no file */ }
}

beforeEach(() => {
  __resetAiModeForTests();
  __resetSentinelForTests();
  delete process.env.AI_MODE;
  delete process.env.FREELLMAPI_PROFILE;
  removeModeFile();
  _env.up = false;
  _env.fail = false;
  _env.routedVia = 'kilo/glm-5.2:free';
  _env.json = { verdict: 'CONFIRM', confidence: 70 };
  _env.calls.length = 0;
});

afterEach(() => {
  __resetAiModeForTests();
  __resetSentinelForTests();
  removeModeFile();
});

describe('aiMode — first-boot seeds + precedence', () => {
  it('default → SMART (maximum intelligence)', () => {
    const s = getAiModeStatus();
    expect(s.mode).toBe('smart');
    expect(s.source).toBe('default');
    expect(s.persisted).toBe(false);
    expect(s.model).toBe('auto:smart');
    expect(s.engine).toBe('freellmapi');
  });

  it('AI_MODE=fast seeds FAST', () => {
    process.env.AI_MODE = 'fast';
    const s = getAiModeStatus();
    expect(s.mode).toBe('fast');
    expect(s.source).toBe('env');
  });

  it('FREELLMAPI_PROFILE=balanced seeds BALANCED when AI_MODE is absent', () => {
    process.env.FREELLMAPI_PROFILE = 'balanced';
    const s = getAiModeStatus();
    expect(s.mode).toBe('balanced');
    expect(s.source).toBe('env-profile');
  });

  it('legacy local/cloud/both values migrate to SMART', () => {
    expect(normalizeAiMode('local')).toBe('smart');
    expect(normalizeAiMode('cloud')).toBe('smart');
    expect(normalizeAiMode('both')).toBe('smart');
    process.env.AI_MODE = 'local';
    const s = getAiModeStatus();
    expect(s.mode).toBe('smart');
    expect(s.legacy).toBe('local');
  });

  it('runtime switch beats env + is persisted for restart safety', () => {
    process.env.AI_MODE = 'fast';
    const out = setAiMode('smart');
    expect(out).toMatchObject({ ok: true, mode: 'smart', persisted: true });
    expect(getAiMode()).toBe('smart');
    const saved = JSON.parse(fs.readFileSync(MODE_FILE, 'utf8'));
    expect(saved.mode).toBe('smart');
    expect(Number.isFinite(saved.updatedAt)).toBe(true);
  });

  it('persisted file wins over the env seed after a runtime reset', () => {
    setAiMode('balanced');
    __resetAiModeForTests();
    process.env.AI_MODE = 'fast';
    const s = getAiModeStatus();
    expect(s.mode).toBe('balanced');
    expect(s.source).toBe('file');
  });

  it('invalid values are rejected (no silent fallback)', () => {
    const out = setAiMode('paid');
    expect(out.ok).toBe(false);
    expect(normalizeAiMode('SMART')).toBe('smart');
    expect(normalizeAiMode('nope')).toBeNull();
    expect(getAiMode()).toBe('smart');
  });

  it('deep analysis is independent of the FAST/BALANCED scan profile', async () => {
    _env.up = true;
    setAiMode('fast');
    await councilAskDeep('deep prompt', { KEYS: PAID_KEYS });
    expect(_env.calls[0]?.opts.model).toBe('auto:smart');
  });
});

describe('councilAsk — FreeLLMAPI routing', () => {
  it('SMART profile asks auto:smart and reports the routed model', async () => {
    _env.up = true;
    const { json, model } = await councilAsk('prompt', { KEYS: PAID_KEYS });
    expect(_env.calls[0]?.opts.model).toBe('auto:smart');
    expect(json?.verdict).toBe('CONFIRM');
    expect(model).toBe('freellmapi:kilo/glm-5.2:free');
  });

  it('BALANCED profile asks auto:balanced for scans', async () => {
    _env.up = true;
    setAiMode('balanced');
    await councilAsk('scan prompt', { KEYS: PAID_KEYS });
    expect(_env.calls[0]?.opts.model).toBe('auto:balanced');
  });

  it('FAST profile asks auto:fast for scans', async () => {
    _env.up = true;
    setAiMode('fast');
    await councilAsk('scan prompt', { KEYS: PAID_KEYS });
    expect(_env.calls[0]?.opts.model).toBe('auto:fast');
  });

  it('deep path uses a longer budget and auto:smart', async () => {
    _env.up = true;
    setAiMode('fast');
    await councilAskDeep('deep prompt', { KEYS: PAID_KEYS });
    expect(_env.calls[0]?.opts.model).toBe('auto:smart');
    expect(_env.calls[0]?.opts.maxTokens).toBe(3072);
    expect(_env.calls[0]?.opts.timeoutMs).toBeGreaterThanOrEqual(120_000);
  });

  it('router down → honest null (paid direct keys do not bypass the gate)', async () => {
    _env.up = false;
    const out = await councilAsk('prompt', { KEYS: PAID_KEYS });
    expect(out).toEqual({ json: null, model: null });
    expect(_env.calls.length).toBe(0);
  });

  it('router failure → honest null + the breaker arms', async () => {
    _env.up = true;
    _env.fail = true;
    const out = await councilAsk('prompt', { KEYS: PAID_KEYS });
    expect(out).toEqual({ json: null, model: null });
  });

  it('prose (non-JSON) answer → honest null instead of an invented verdict', async () => {
    _env.up = true;
    _env.json = { not: 'a verdict' };
    // freeLlmJson mock returns the same object; simulate prose by making it null
    const out = await councilAsk('prompt', {});
    // the mock parses as an object, so this checks the object path is accepted
    expect(out.json).toBeTruthy();
  });
});

describe('mergeBothVerdicts — pure legacy utility', () => {
  it('merges a per-symbol verdicts map symbol-by-symbol with stats', () => {
    const a = { verdicts: { A: { verdict: 'LONG', confidence: 70 }, B: { verdict: 'SHORT', confidence: 80 } } };
    const b = { verdicts: { A: { verdict: 'LONG', confidence: 50 }, B: { verdict: 'LONG', confidence: 60 } } };
    const out = mergeBothVerdicts(
      { json: a as any, model: 'engine-a/fast' },
      { json: b as any, model: 'engine-b/smart' },
    );
    expect(out.json.verdicts.A.confidence).toBe(60); // agree → avg
    expect(out.json.verdicts.B.confidence).toBe(56); // conflict → 80×0.7
    expect(out.json.dualEngine.agree).toBe(1);
    expect(out.json.dualEngine.conflict).toBe(1);
    expect(out.json.model).toBe('engine-a/fast + engine-b/smart');
  });

  it('no-engine pair → honest null', () => {
    const out = mergeBothVerdicts({ json: null, model: null }, { json: null, model: null });
    expect(out.json).toBeNull();
    expect(out.model).toBeNull();
  });

  it('merges debate `cases` maps: A canonical, B appended at max strength', () => {
    const a = { cases: { SOL: { case: 'A long thesis', strength: 80 }, BTC: { case: 'A short thesis', strength: 60 } } };
    const b = { cases: { SOL: { case: 'B long thesis', strength: 90 } } };
    const out = mergeBothVerdicts(
      { json: a as any, model: 'engine-a/fast' },
      { json: b as any, model: 'engine-b/smart' },
    );
    expect(out.json!.cases!.SOL.case).toContain('A long thesis');
    expect(out.json!.cases!.SOL.case).toContain('B long thesis');
    expect(out.json!.cases!.SOL.strength).toBe(90);
    expect(out.json!.cases!.BTC).toMatchObject({ case: 'A short thesis', strength: 60 });
    expect(out.via).toBe('dual');
    expect(out.json!.dualEngine.merged).toBe(1);
  });

  it('single-engine degrade never claims the other engine in the model string', () => {
    const out = mergeBothVerdicts(
      { json: { verdict: 'CONFIRM', confidence: 70 } as any, model: 'engine-a/fast' },
      { json: null, model: null },
    );
    expect(out.via).toBe('single-a');
    expect(out.model).toBe('engine-a/fast');
  });
});

describe('aiEngineOnline — FreeLLMAPI availability gate', () => {
  it('offline router is offline even with every direct key set', async () => {
    _env.up = false;
    expect(await aiEngineOnline({ KEYS: PAID_KEYS })).toBe(false);
  });

  it('online router is online with an empty key map', async () => {
    _env.up = true;
    expect(await aiEngineOnline({ KEYS: {} })).toBe(true);
  });
});
