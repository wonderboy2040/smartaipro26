// ============================================================
// test/visionSeat.test.ts — FreeLLMAPI VISION SEAT contracts
// ------------------------------------------------------------
// Locks the vision-seat isolation rules:
//   1. vision failures arm the ISOLATED 'freellmapi-vision' circuit
//      breaker — the shared 'freellmapi' breaker (board scan seat)
//      must NEVER cool because a vision call choked (weak JSON from a
//      small VL model is common; the blast radius used to park the
//      scan seat).
//   2. vision success reports 'freellmapi-vision' ok too.
//   3. no images → honest null abstain, zero tracking (capability
//      missing is not a failure).
// Hermetic — router bridge + sentinel stubbed, no network.
// ============================================================
import { describe, it, expect, beforeEach, vi } from 'vitest';

const engineTrack = vi.hoisted(() => vi.fn());
const engineOk = vi.hoisted(() => vi.fn());
const _v = vi.hoisted(() => ({ mode: 'no-json' as 'no-json' | 'throw' | 'ok' }));

vi.mock('../server/ai/freellmapi.js', () => ({
  FREELLMAPI_MODELS: {
    smart: 'auto:smart', balanced: 'auto:balanced', fast: 'auto:fast',
    reliable: 'auto:reliable', fusion: 'fusion', vision: 'qwen2.5-vl-72b',
  },
  freeLlmProbe: async () => true,
  freeLlmKeyPresentCached: () => true,
  freeLlmJson: vi.fn(async () => ({ json: { verdict: 'CONFIRM' } })),
  freeLlmVision: vi.fn(async () => {
    if (_v.mode === 'throw') throw new Error('vision network down');
    if (_v.mode === 'no-json') {
      return { json: null, text: 'garbage — no json here', model: 'qwen2.5-vl-72b', routedVia: null, latencyMs: 5, usage: null };
    }
    return {
      json: { verdict: 'CONFIRM', side: 'LONG', confidence: 72, note: 'higher lows into breakout' },
      text: '{"verdict":"CONFIRM"}',
      model: 'qwen2.5-vl-72b',
      routedVia: 'qwen/qwen2.5-vl-72b',
      latencyMs: 3100,
      usage: null,
    };
  }),
}));

vi.mock('../server/ai/llmSentinel.js', () => ({
  engineSkip: () => false,
  engineTrack: (...a: any[]) => engineTrack(...a),
  engineOk: (...a: any[]) => engineOk(...a),
}));

import { councilAskVision } from '../server/ai/llmChain.js';

beforeEach(() => {
  engineTrack.mockClear();
  engineOk.mockClear();
  _v.mode = 'no-json';
});

describe('FreeLLMAPI — vision seat breaker isolation', () => {
  it('weak-JSON vision failure arms ONLY the freellmapi-vision breaker (scan seat untouched)', async () => {
    const out = await councilAskVision('analyze this chart', ['aGVsbG8=']);
    expect(out).toEqual({ json: null, model: null }); // honest abstain
    expect(engineTrack).toHaveBeenCalledTimes(1);
    expect(engineTrack).toHaveBeenCalledWith('freellmapi-vision', expect.any(Error));
    // THE contract: the SHARED 'freellmapi' breaker must never be armed by vision
    expect(engineTrack).not.toHaveBeenCalledWith('freellmapi', expect.anything());
  });

  it('fetch-throw vision failure also isolates (no shared scan cooldown)', async () => {
    _v.mode = 'throw';
    const out = await councilAskVision('analyze', ['aGVsbG8=']);
    expect(out).toEqual({ json: null, model: null });
    expect(engineTrack).toHaveBeenCalledWith('freellmapi-vision', expect.any(Error));
    expect(engineTrack).not.toHaveBeenCalledWith('freellmapi', expect.anything());
  });

  it('no images → honest null, ZERO tracking (not a failure)', async () => {
    expect(await councilAskVision('p', [])).toEqual({ json: null, model: null });
    expect(engineTrack).not.toHaveBeenCalled();
    expect(engineOk).not.toHaveBeenCalled();
  });

  it('a valid vision answer reports the isolated breaker OK and the pinned multimodal route', async () => {
    _v.mode = 'ok';
    const out = await councilAskVision('analyze chart', ['aGVsbG8=']);
    expect(out.json).toMatchObject({ verdict: 'CONFIRM', side: 'LONG' });
    expect(out.model).toContain('freellmapi:qwen/qwen2.5-vl-72b');
    expect(engineOk).toHaveBeenCalledWith('freellmapi-vision');
    expect(engineTrack).not.toHaveBeenCalled();
  });
});
