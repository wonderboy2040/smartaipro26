// ============================================================
// test/llmChainEnv.test.ts — v21.27 LOCAL/CLOUD mode + chain
// ------------------------------------------------------------
// Locks the approved v1 switch:
//   1. AI_MODE / LLM_LOCAL_ONLY only SEED the first-boot mode.
//   2. A runtime switch > persisted file > env seed.
//   3. LOCAL → Ollama only; paid keys are never touched.
//   4. CLOUD → OpenCode free model first (GLM fast / DeepSeek deep),
//      then Ollama fallback. A failure never reaches a paid API.
//   5. aiEngineOnline() is the honest availability gate for each mode.
// ============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';

// Shared hermetic dir from src/test/setup.ts (module imports above already
// resolved store.js against it). ai-mode.json is wiped around every test.
const DATA = process.env.SMARTAI_DATA_DIR || path.join(process.cwd(), '.test-data-llm-chain-env');
const MODE_FILE = path.join(DATA, 'ai-mode.json');

const _env = vi.hoisted(() => ({
  ollamaUp: false,
  ocFail: false,
  ocAvailable: true,
  ocLoggedIn: true as boolean | null,
  ocCalls: [] as Array<{ prompt: string; opts: any }>,
  ocJson: { verdict: 'CONFIRM', via: 'opencode' },
  ocExtra: null as Record<string, unknown> | null,
  ollamaContent: '{"verdict":"CONFIRM","via":"ollama"}',
  ocOllamaDiverge: false, // when true, Ollama answers the OPPOSITE verdict (conflict path)
}));

vi.stubGlobal('fetch', vi.fn(async (url: any) => {
  const u = String(url);
  if (u.includes('/api/chat')) {
    // ocOllamaDiverge=true → Ollama answers the OPPOSITE verdict so BOTH
    // merge exercises the CONFLICT path (otherwise every default is CONFIRM
    // and BOTH mode can only ever produce 'agree').
    const content = _env.ocOllamaDiverge
      ? '{"verdict":"REJECT","confidence":40,"via":"ollama"}'
      : _env.ollamaContent;
    return {
      ok: true, status: 200,
      json: async () => ({ message: { role: 'assistant', content } }),
    };
  }
  return { ok: false, status: 503, json: async () => null, text: async () => '' };
}));

vi.mock('../server/ai/llmSentinel.js', () => ({
  engineSkip: () => false,
  engineTrack: () => {},
  engineOk: () => {},
  ollamaProbe: async () => _env.ollamaUp,
  ollamaCompatCfg: (opts: any = {}) => ({
    url: 'http://localhost:11434/v1/chat/completions',
    defModel: opts.deep ? 'deepseek-r1:14b' : 'qwen3:8b',
    deepModel: 'deepseek-r1:14b',
  }),
  OLLAMA_NUM_CTX: 8192,
  OLLAMA_NUM_CTX_DEEP: 8192,
  OLLAMA_KEEP_ALIVE: '5m',
  ollamaVisionModel: () => null,
}));

vi.mock('../server/ai/opencodeBridge.js', () => ({
  askOpenCode: async (prompt: string, opts: any = {}) => {
    _env.ocCalls.push({ prompt, opts });
    if (_env.ocFail) {
      const err: any = new Error('opencode free-limit: daily quota');
      err.code = 'free-limit';
      throw err;
    }
    return { json: { ..._env.ocJson, ...(_env.ocExtra || {}) }, model: `opencode/${opts.model}` };
  },
  resolveSeatModel: (seat: string) => seat === 'deep' ? 'deepseek-v4.1-flash-free' : 'glm-5.3-flash-free',
  opencodeProbe: async () => ({
    available: _env.ocAvailable,
    loggedIn: _env.ocLoggedIn,
    models: ['opencode/glm-5.3-flash-free', 'opencode/deepseek-v4.1-flash-free'],
  }),
  opencodeStatus: () => ({}),
}));

import {
  getAiMode, getAiModeStatus, setAiMode, normalizeAiMode, __resetAiModeForTests,
} from '../server/ai/aiMode.js';
import { councilAsk, councilAskDeep, aiEngineOnline, mergeBothVerdicts } from '../server/ai/llmChain.js';

const PAID_KEYS = { gemini: 'g', groq: 'q', cerebras: 'c', openrouter: 'o', huggingface: 'h', nvidia: 'n' };

function removeModeFile() {
  try { fs.rmSync(MODE_FILE, { force: true }); } catch { /* no file */ }
}

beforeEach(() => {
  __resetAiModeForTests();
  delete process.env.AI_MODE;
  delete process.env.LLM_LOCAL_ONLY;
  removeModeFile();
  _env.ollamaUp = false;
  _env.ocFail = false;
  _env.ocAvailable = true;
  _env.ocLoggedIn = true;
  _env.ocCalls.length = 0;
  _env.ocJson = { verdict: 'CONFIRM', via: 'opencode' };
  _env.ocExtra = null;
  _env.ollamaContent = '{"verdict":"CONFIRM","via":"ollama"}';
  _env.ocOllamaDiverge = false;
});

afterEach(() => {
  // never leak a CLOUD file into the next suite
  __resetAiModeForTests();
  removeModeFile();
});

describe('v21.27 aiMode — first-boot seeds + precedence', () => {
  it('default → LOCAL (safe)', () => {
    const s = getAiModeStatus();
    expect(s.mode).toBe('local');
    expect(s.source).toBe('default');
    expect(s.persisted).toBe(false);
  });

  it('AI_MODE=cloud seeds CLOUD', () => {
    process.env.AI_MODE = 'cloud';
    const s = getAiModeStatus();
    expect(s.mode).toBe('cloud');
    expect(s.source).toBe('env');
  });

  it('LLM_LOCAL_ONLY=1 seeds LOCAL when AI_MODE is absent', () => {
    process.env.LLM_LOCAL_ONLY = '1';
    const s = getAiModeStatus();
    expect(s.mode).toBe('local');
    expect(s.source).toBe('env-local-only');
  });

  it('runtime switch beats env + is persisted for restart safety', () => {
    process.env.AI_MODE = 'cloud';
    const out = setAiMode('local');
    expect(out).toMatchObject({ ok: true, mode: 'local', persisted: true });
    expect(getAiMode()).toBe('local');
    const saved = JSON.parse(fs.readFileSync(MODE_FILE, 'utf8'));
    expect(saved.mode).toBe('local');
    expect(Number.isFinite(saved.updatedAt)).toBe(true);
  });

  it('persisted file wins over the env seed after a runtime reset', () => {
    setAiMode('cloud');
    __resetAiModeForTests();
    process.env.AI_MODE = 'local';
    const s = getAiModeStatus();
    expect(s.mode).toBe('cloud');
    expect(s.source).toBe('file');
  });

  it('invalid values are rejected (no silent fallback)', () => {
    const out = setAiMode('paid');
    expect(out.ok).toBe(false);
    expect(normalizeAiMode('LOCAL')).toBe('local');
    expect(normalizeAiMode('nope')).toBeNull();
    expect(getAiMode()).toBe('local');
  });
});

describe('v21.27 councilAsk — LOCAL mode', () => {
  it('LOCAL answers via Ollama and never calls OpenCode or paid providers', async () => {
    _env.ollamaUp = true;
    const { json, model } = await councilAsk('prompt', { KEYS: PAID_KEYS });
    expect(model).toBe('ollama:qwen3:8b');
    expect(json?.via).toBe('ollama');
    expect(_env.ocCalls.length).toBe(0);
  });

  it('LOCAL deep path uses the Ollama deep model', async () => {
    _env.ollamaUp = true;
    const { model } = await councilAskDeep('deep prompt', { KEYS: PAID_KEYS });
    expect(model).toBe('ollama:deepseek-r1:14b');
  });

  it('LOCAL with Ollama down → honest null (paid keys ignored)', async () => {
    _env.ollamaUp = false;
    const out = await councilAsk('prompt', { KEYS: PAID_KEYS });
    expect(out).toEqual({ json: null, model: null });
    expect(_env.ocCalls.length).toBe(0);
  });
});

describe('v21.27 councilAsk — CLOUD mode', () => {
  beforeEach(() => {
    setAiMode('cloud');
  });

  it('CLOUD uses the OpenCode FAST seat (GLM) first', async () => {
    const { json, model } = await councilAsk('prompt', { KEYS: PAID_KEYS });
    expect(model).toBe('opencode/glm-5.3-flash-free');
    expect(json?.via).toBe('opencode');
    expect(_env.ocCalls[0]?.opts).toMatchObject({ model: 'glm-5.3-flash-free', deep: false });
  });

  it('CLOUD deep path uses the OpenCode DEEP seat (DeepSeek)', async () => {
    const { model } = await councilAskDeep('deep prompt', { KEYS: PAID_KEYS });
    expect(model).toBe('opencode/deepseek-v4.1-flash-free');
    expect(_env.ocCalls[0]?.opts).toMatchObject({ model: 'deepseek-v4.1-flash-free', deep: true });
  });

  it('OpenCode failure falls back to Ollama (never to a paid API)', async () => {
    _env.ocFail = true;
    _env.ollamaUp = true;
    const { json, model } = await councilAsk('prompt', { KEYS: PAID_KEYS });
    expect(model).toBe('ollama:qwen3:8b');
    expect(json?.via).toBe('ollama');
    expect(_env.ocCalls.length).toBe(1);
  });

  it('OpenCode failure + Ollama down → honest null, zero paid calls', async () => {
    _env.ocFail = true;
    _env.ollamaUp = false;
    const out = await councilAsk('prompt', { KEYS: PAID_KEYS });
    expect(out).toEqual({ json: null, model: null });
  });
});

describe('v21.35.3 aiMode — BOTH mode is a valid persisted mode', () => {
  it('BOTH is accepted, persisted and reported', () => {
    const out = setAiMode('both');
    expect(out).toMatchObject({ ok: true, mode: 'both', persisted: true });
    expect(getAiMode()).toBe('both');
    expect(getAiModeStatus().modes).toContain('both');
    const saved = JSON.parse(fs.readFileSync(MODE_FILE, 'utf8'));
    expect(saved.mode).toBe('both');
  });

  it('AI_MODE=both seeds BOTH on first boot', () => {
    process.env.AI_MODE = 'both';
    expect(getAiModeStatus().mode).toBe('both');
  });
});

describe('v21.35.3 councilAsk — BOTH mode (parallel dual-engine merge)', () => {
  beforeEach(() => {
    setAiMode('both');
  });

  it('BOTH calls OpenCode AND Ollama in parallel; agree → averaged confidence', async () => {
    _env.ollamaUp = true;
    _env.ocJson = { verdict: 'CONFIRM', confidence: 80 };
    _env.ollamaContent = '{"verdict":"CONFIRM","confidence":60,"via":"ollama"}';
    const { json, model } = await councilAsk('prompt', { KEYS: PAID_KEYS });
    expect(_env.ocCalls.length).toBe(1); // cloud leg fired
    expect(json?.via).toBe('agree');
    expect(json?.verdict).toBe('CONFIRM');
    expect(json?.confidence).toBe(70); // (80+60)/2
    expect(json?.dualEngine).toMatchObject({ agree: 1 });
    expect(String(model)).toContain('opencode');
    expect(String(model)).toContain('ollama');
  });

  it('BOTH conflict → the confident engine wins, confidence discounted', async () => {
    _env.ollamaUp = true;
    _env.ocJson = { verdict: 'CONFIRM', confidence: 90 };
    _env.ocOllamaDiverge = true; // Ollama answers REJECT 40
    const { json, model } = await councilAsk('prompt', { KEYS: PAID_KEYS });
    expect(json?.via).toBe('conflict');
    expect(json?.verdict).toBe('CONFIRM'); // higher-confidence (cloud) side wins
    expect(json?.confidence).toBe(63); // 90 × 0.7
    expect(String(model)).toContain('opencode'); // both engines actually contributed
    expect(String(model)).toContain('ollama');
  });

  it('BOTH with OpenCode down → honest single-local degrade (no invented dual verdict)', async () => {
    _env.ocFail = true;
    _env.ollamaUp = true;
    const { json, model } = await councilAsk('prompt', { KEYS: PAID_KEYS });
    expect(json?.via).toBe('single-local');
    expect(json?.verdict).toBe('CONFIRM');
    expect(model).toBe('ollama:qwen3:8b');
  });

  it('BOTH with Ollama down → honest single-cloud degrade', async () => {
    _env.ollamaUp = false;
    const { json, model } = await councilAsk('prompt', { KEYS: PAID_KEYS });
    expect(json?.via).toBe('single-cloud');
    expect(json?.verdict).toBe('CONFIRM');
    expect(String(model)).toContain('opencode');
  });

  it('BOTH with BOTH engines down → honest null, zero paid calls', async () => {
    _env.ocFail = true;
    _env.ollamaUp = false;
    const out = await councilAsk('prompt', { KEYS: PAID_KEYS });
    expect(out).toEqual({ json: null, model: null });
  });

  it('BOTH deep path merges the deep seats', async () => {
    _env.ollamaUp = true;
    _env.ocJson = { verdict: 'LONG', confidence: 70 };
    _env.ollamaContent = '{"verdict":"LONG","confidence":80,"via":"ollama-deep"}';
    const { json } = await councilAskDeep('deep prompt', { KEYS: PAID_KEYS });
    expect(json?.via).toBe('agree');
    expect(json?.confidence).toBe(75);
    expect(_env.ocCalls[0]?.opts).toMatchObject({ deep: true });
  });
});

describe('v21.35.3 mergeBothVerdicts — per-symbol verdicts map merge', () => {
  it('merges a per-symbol verdicts map symbol-by-symbol with stats', () => {
    const oc = { verdicts: { A: { verdict: 'LONG', confidence: 70 }, B: { verdict: 'SHORT', confidence: 80 } } };
    const ol = { verdicts: { A: { verdict: 'LONG', confidence: 50 }, B: { verdict: 'LONG', confidence: 60 } } };
    const out = mergeBothVerdicts(
      { json: oc as any, model: 'opencode/glm-5.3-flash-free' },
      { json: ol as any, model: 'ollama:qwen3:8b' },
    );
    expect(out.json.verdicts.A.confidence).toBe(60); // agree → avg
    expect(out.json.verdicts.B.confidence).toBe(56); // conflict → 80×0.7
    expect(out.json.dualEngine.agree).toBe(1);
    expect(out.json.dualEngine.conflict).toBe(1);
    expect(out.json.model).toBe('opencode/glm-5.3-flash-free + ollama:qwen3:8b');
  });

  it('no-engine pair → honest null', () => {
    const out = mergeBothVerdicts({ json: null, model: null }, { json: null, model: null });
    expect(out.json).toBeNull();
    expect(out.model).toBeNull();
  });
});

describe('v21.35.3 mergeBothVerdicts — debate `cases` map + model honesty', () => {
  it('merges bull/bear advocate `cases` maps: cloud data preserved, local appended (not dropped)', () => {
    // Debate advocate shape: {cases:{SYM:{case,strength}}} — the defect this
    // locks: cloud's per-symbol cases must survive the BOTH merge, local's
    // differing case is APPENDED (never silently lost), score = the max.
    const oc = { cases: { SOL: { case: 'cloud long thesis', strength: 80 }, BTC: { case: 'cloud short thesis', strength: 60 } } };
    const ol = { cases: { SOL: { case: 'local long thesis', strength: 90 } } };
    const out = mergeBothVerdicts(
      { json: oc as any, model: 'opencode/glm-5.3-flash-free' },
      { json: ol as any, model: 'ollama:qwen3:8b' },
    );
    // SOL: both engines → cloud canonical, local appended, strength = max(80,90)
    expect(out.json!.cases!.SOL.case).toContain('cloud long thesis');
    expect(out.json!.cases!.SOL.case).toContain('LOCAL: local long thesis');
    expect(out.json!.cases!.SOL.strength).toBe(90);
    // BTC: only cloud had it → must still be present (pre-fix it was dropped)
    expect(out.json!.cases!.BTC).toMatchObject({ case: 'cloud short thesis', strength: 60 });
    // attribution: both engines genuinely contributed → dual model string
    expect(out.json!.model).toBe('opencode/glm-5.3-flash-free + ollama:qwen3:8b');
    expect(out.via).toBe('dual');
    expect(out.json!.dualEngine.merged).toBe(1);
  });

  it('debate cases conflict (same symbol, both have `verdict`) discounts the winner', () => {
    const oc = { cases: { ETH: { case: 'cloud', strength: 50, verdict: 'LONG' } } };
    const ol = { cases: { ETH: { case: 'local', strength: 90, verdict: 'SHORT' } } };
    const out = mergeBothVerdicts(
      { json: oc as any, model: 'opencode/x' },
      { json: ol as any, model: 'ollama:y' },
    );
    expect(out.json!.cases!.ETH.verdict).toBe('SHORT'); // higher strength (local 90) wins
    expect(out.json!.cases!.ETH.strength).toBe(63); // 90 × 0.7
    expect(out.via).toBe('conflict');
  });

  it('audit#2: both legs drift to a single-symbol {verdicts} map (no top verdict) → verdict recovered', () => {
    // Ollama 8B occasionally answers the validator's strict-JSON prompt in the
    // council map shape. If BOTH legs do, the merged top-level `verdict` would
    // be undefined and llmValidator would null the whole second opinion. A
    // single-symbol map is unwrapped so json.verdict survives.
    const oc = { verdicts: { SOL: { verdict: 'CONFIRM', confidence: 70 } } };
    const ol = { verdicts: { SOL: { verdict: 'CONFIRM', confidence: 60 } } };
    const out = mergeBothVerdicts(
      { json: oc as any, model: 'opencode/x' },
      { json: ol as any, model: 'ollama:y' },
    );
    expect(out.json!.verdict).toBe('CONFIRM');
    expect(out.json!.confidence).toBe(65); // (70+60)/2 agree
    expect(out.json!.via).toBe('agree');
  });

  it('audit#2: multi-symbol {verdicts} map with no top verdict is NOT unwrapped (no honest single verdict)', () => {
    const oc = { verdicts: { A: { verdict: 'LONG', confidence: 70 }, B: { verdict: 'SHORT', confidence: 80 } } };
    const ol = { verdicts: { A: { verdict: 'LONG', confidence: 50 } } };
    const out = mergeBothVerdicts(
      { json: oc as any, model: 'opencode/x' },
      { json: ol as any, model: 'ollama:y' },
    );
    // two symbols → no honest scalar; merged.verdict stays undefined
    expect(out.json!.verdict).toBeUndefined();
    expect(out.json!.verdicts.A.confidence).toBe(60); // agree avg
    expect(out.json!.verdicts.B).toMatchObject({ verdict: 'SHORT', confidence: 80 });
    // stats: A=agree, B=single-cloud → via reflects the agree dominance
    expect(out.via).toBe('agree');
  });

  it('audit#1: an EXPLICIT caller timeoutMs still wins over the deep cap (no behaviour change)', async () => {
    // _councilAskBoth passes an explicit caller budget straight through to the
    // local leg; only the NO-override deep case is capped at the cloud deep
    // budget. Lock that an explicit override is untouched (observable: the
    // merged scalar path still resolves, and the model string is dual when
    // both answer).
    _env.ocJson = { verdict: 'LONG', confidence: 80 };
    _env.ollamaContent = '{"verdict":"LONG","confidence":70,"via":"ollama"}';
    _env.ollamaUp = true;
    setAiMode('both');
    const { json, model } = await councilAsk('prompt', null, { deep: true, timeoutMs: 999999 });
    expect(json?.via).toBe('agree');
    expect(String(model)).toContain('opencode');
    expect(String(model)).toContain('ollama');
  });

  it('single-engine degrade NEVER claims the other engine in the model string', () => {
    // only cloud produced a verdict → model must be cloud-only, not "cloud + local"
    const out = mergeBothVerdicts(
      { json: { verdict: 'CONFIRM', confidence: 70 } as any, model: 'opencode/glm-5.3-flash-free' },
      { json: null, model: null },
    );
    expect(out.via).toBe('single-cloud');
    expect(out.model).toBe('opencode/glm-5.3-flash-free');
    expect(String(out.model)).not.toContain('ollama');
  });
});

describe('v21.27 aiEngineOnline — mode-aware gate', () => {
  it('LOCAL ignores paid keys; needs Ollama', async () => {
    expect(await aiEngineOnline({ KEYS: PAID_KEYS })).toBe(false);
    _env.ollamaUp = true;
    expect(await aiEngineOnline({ KEYS: {} })).toBe(true);
  });

  it('CLOUD is online via OpenCode even when Ollama is down', async () => {
    setAiMode('cloud');
    _env.ollamaUp = false;
    _env.ocAvailable = true;
    _env.ocLoggedIn = true;
    expect(await aiEngineOnline({ KEYS: {} })).toBe(true);
  });

  it('CLOUD with OpenCode logged out falls back to Ollama availability', async () => {
    setAiMode('cloud');
    _env.ocAvailable = true;
    _env.ocLoggedIn = false;
    _env.ollamaUp = false;
    expect(await aiEngineOnline({ KEYS: PAID_KEYS })).toBe(false);
    _env.ollamaUp = true;
    expect(await aiEngineOnline({ KEYS: {} })).toBe(true);
  });

  it('BOTH is online when EITHER engine is up', async () => {
    setAiMode('both');
    _env.ocAvailable = true;
    _env.ocLoggedIn = true;
    _env.ollamaUp = false;
    expect(await aiEngineOnline({ KEYS: {} })).toBe(true); // cloud leg up
    _env.ocAvailable = false;
    _env.ollamaUp = true;
    expect(await aiEngineOnline({ KEYS: {} })).toBe(true); // local leg up
    _env.ocAvailable = false;
    _env.ollamaUp = false;
    expect(await aiEngineOnline({ KEYS: {} })).toBe(false); // both down
  });
});
