// ============================================================
// test/freellmapiJsonMode.test.ts - strict-JSON lane contract
// ------------------------------------------------------------
// v21.36.2 LIVE-CAUGHT: auto:fast answered prose, so llmChain armed the
// "no-json response" breaker and parked every AI lane in a 5-minute
// cooldown. The text JSON lane must request OpenAI JSON mode, and must
// fall back once when an upstream model rejects response_format.
// ============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const URL_BASE = 'http://127.0.0.1:59999';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function chatOk(content: string): Response {
  return jsonResponse({
    model: 'auto:fast',
    choices: [{ message: { content }, finish_reason: 'stop' }],
    usage: { total_tokens: 10 },
  });
}

async function loadModule() {
  vi.resetModules();
  const mod = await import('../server/ai/freellmapi.js');
  mod.__resetFreeLlmForTests();
  return mod;
}

describe('freellmapi strict JSON lane', () => {
  beforeEach(() => {
    process.env.FREELLMAPI_URL = URL_BASE;
    process.env.FREELLMAPI_API_KEY = 'test-unified-key';
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.FREELLMAPI_URL;
    delete process.env.FREELLMAPI_API_KEY;
  });

  it('forces response_format json_object + stream:false on the text lane', async () => {
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: any, opts: any = {}) => {
      const u = String(url);
      if (u.endsWith('/api/ping')) return jsonResponse({ ok: true });
      if (u.includes('/v1/models')) return jsonResponse({ data: [{ id: 'auto:fast' }] });
      if (u.includes('/v1/chat/completions')) {
        bodies.push(JSON.parse(String(opts.body)));
        return chatOk('{"ok":true}');
      }
      throw new Error(`unexpected fetch: ${u}`);
    }));
    const mod = await loadModule();
    const out = await mod.freeLlmJson('Reply with JSON', { model: 'auto:fast' });
    expect(out.json).toEqual({ ok: true });
    expect(bodies).toHaveLength(1);
    expect(bodies[0].response_format).toEqual({ type: 'json_object' });
    expect(bodies[0].stream).toBe(false);
  });

  it('retries once without response_format when the upstream rejects it (400)', async () => {
    const bodies: any[] = [];
    let chatCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: any, opts: any = {}) => {
      const u = String(url);
      if (u.endsWith('/api/ping')) return jsonResponse({ ok: true });
      if (u.includes('/v1/models')) return jsonResponse({ data: [{ id: 'auto:fast' }] });
      if (u.includes('/v1/chat/completions')) {
        bodies.push(JSON.parse(String(opts.body)));
        chatCalls++;
        if (chatCalls === 1) return jsonResponse({ error: { message: 'response_format not supported' } }, 400);
        return chatOk('{"ok":true,"retry":true}');
      }
      throw new Error(`unexpected fetch: ${u}`);
    }));
    const mod = await loadModule();
    const out = await mod.freeLlmJson('Reply with JSON', { model: 'auto:fast' });
    expect(out.json).toEqual({ ok: true, retry: true });
    expect(bodies).toHaveLength(2);
    expect(bodies[0].response_format).toEqual({ type: 'json_object' });
    expect(bodies[1].response_format).toBeUndefined();
  });

  it('stays honest when the model answers prose (json = null, no throw)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: any) => {
      const u = String(url);
      if (u.endsWith('/api/ping')) return jsonResponse({ ok: true });
      if (u.includes('/v1/models')) return jsonResponse({ data: [{ id: 'auto:fast' }] });
      if (u.includes('/v1/chat/completions')) return chatOk('I cannot answer that.');
      throw new Error(`unexpected fetch: ${u}`);
    }));
    const mod = await loadModule();
    const out = await mod.freeLlmJson('Reply with JSON', { model: 'auto:fast' });
    expect(out.json).toBeNull();
    expect(out.text).toBe('I cannot answer that.');
  });
});
