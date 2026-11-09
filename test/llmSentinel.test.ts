// ============================================================
// test/llmSentinel.test.ts — AI ENGINE SENTINEL (FreeLLMAPI)
// ------------------------------------------------------------
// Pins the circuit-breaker contract behind the "AI language
// engines offline" fix:
//   • 2 consecutive failures arm a cooldown (1 blip ≠ offline)
//   • backoff ladder 30s → 60s → 120s → 300s (cap)
//   • 429 → 90s cooldown · 401/403 → 15 min (bad key)
//   • engineOk resets · expiry = half-open (auto-retry)
//   • snapshot NEVER leaks key values (booleans + errors only)
//   • FreeLLMAPI is the first tracked engine
// ============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  engineSkip, engineTrack, engineOk, engineClearCooldowns,
  engineSnapshot, engineStatusLine,
  getAiGuardModels, evaluateMtfRowWithAiGuard,
  __resetSentinelForTests, SENTINEL_PROVIDERS,
} from '../server/ai/llmSentinel.js';

const T0 = 1_700_000_000_000; // fixed epoch for deterministic math

beforeEach(() => { __resetSentinelForTests(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('circuit breaker core', () => {
  it('unknown provider is never skipped', () => {
    expect(engineSkip('groq', T0)).toBe(false);
  });

  it('ONE failure does NOT arm the cooldown (a blip is not an outage)', () => {
    engineTrack('groq', new Error('groq 500'), T0);
    expect(engineSkip('groq', T0 + 1000)).toBe(false);
  });

  it('TWO consecutive failures arm a 30s cooldown', () => {
    engineTrack('groq', new Error('groq 500'), T0);
    engineTrack('groq', new Error('groq 500'), T0 + 1000);
    expect(engineSkip('groq', T0 + 2000)).toBe(true);          // inside
    expect(engineSkip('groq', T0 + 31_000)).toBe(false);       // half-open
  });

  it('backoff ladder: 30s → 60s → 120s → 300s (capped)', () => {
    const t = T0;
    engineTrack('groq', new Error('e1'), t);           // 1st — no cooldown
    engineTrack('groq', new Error('e2'), t);           // 2nd — 30s
    expect(engineSkip('groq', t + 29_000)).toBe(true);
    expect(engineSkip('groq', t + 31_000)).toBe(false);
    engineTrack('groq', new Error('e3'), t);           // 3rd — 60s
    expect(engineSkip('groq', t + 59_000)).toBe(true);
    expect(engineSkip('groq', t + 61_000)).toBe(false);
    engineTrack('groq', new Error('e4'), t);           // 4th — 120s
    expect(engineSkip('groq', t + 119_000)).toBe(true);
    engineTrack('groq', new Error('e5'), t);           // 5th — 300s (cap)
    engineTrack('groq', new Error('e6'), t);           // 6th — still 300s
    expect(engineSkip('groq', t + 299_000)).toBe(true);
    expect(engineSkip('groq', t + 301_000)).toBe(false);
  });

  it('429 rate-limit gets the dedicated 90s cooldown', () => {
    engineTrack('freellmapi', new Error('freellmapi 429'), T0);
    engineTrack('freellmapi', new Error('freellmapi 429'), T0);
    expect(engineSkip('freellmapi', T0 + 89_000)).toBe(true);
    expect(engineSkip('freellmapi', T0 + 91_000)).toBe(false);
  });

  it('401/403 (bad key) parks 15 minutes — the key will not heal itself', () => {
    engineTrack('cerebras', new Error('cerebras 401'), T0);
    engineTrack('cerebras', new Error('cerebras 403'), T0);
    expect(engineSkip('cerebras', T0 + 899_000)).toBe(true);
    expect(engineSkip('cerebras', T0 + 901_000)).toBe(false);
  });

  it('engineOk resets the breaker completely', () => {
    engineTrack('gemini', new Error('gemini 500'), T0);
    engineTrack('gemini', new Error('gemini 500'), T0);
    expect(engineSkip('gemini', T0 + 1000)).toBe(true);
    engineOk('gemini', T0 + 2000);
    expect(engineSkip('gemini', T0 + 3000)).toBe(false);
    const snap = engineSnapshot({ gemini: 'x' }, T0 + 3000).find(e => e.provider === 'gemini');
    expect(snap?.state).toBe('ready');
  });

  it('success after failures does not re-arm (consecFails reset)', () => {
    engineTrack('groq', new Error('groq 500'), T0);
    engineOk('groq', T0);
    engineTrack('groq', new Error('groq 500'), T0); // 1st failure again — no cooldown
    expect(engineSkip('groq', T0 + 1000)).toBe(false);
  });

  it('engineClearCooldowns half-opens every engine NOW (the RECHECK button)', () => {
    engineTrack('gemini', new Error('gemini 500'), T0);
    engineTrack('gemini', new Error('gemini 500'), T0);
    engineTrack('groq', new Error('groq 429'), T0);
    engineTrack('groq', new Error('groq 429'), T0);
    expect(engineSkip('gemini', T0 + 1000)).toBe(true);
    expect(engineSkip('groq', T0 + 1000)).toBe(true);
    engineClearCooldowns();
    expect(engineSkip('gemini', T0 + 1000)).toBe(false);
    expect(engineSkip('groq', T0 + 1000)).toBe(false);
  });

  it('tracks FreeLLMAPI first, then the direct-key fallbacks', () => {
    expect(SENTINEL_PROVIDERS).toEqual(['freellmapi', 'gemini', 'groq', 'cerebras', 'openrouter', 'huggingface', 'nvidia']);
  });
});

describe('engineSnapshot — masked health view', () => {
  it('reports no-key for every unconfigured engine and NEVER leaks key values', () => {
    const snap = engineSnapshot({ groq: 'gsk_secret_value' }, T0);
    const s = JSON.stringify(snap);
    expect(s).not.toContain('gsk_secret_value');
    expect(snap.find(e => e.provider === 'groq')?.configured).toBe(true);
    expect(snap.find(e => e.provider === 'gemini')?.configured).toBe(false);
    expect(snap.find(e => e.provider === 'gemini')?.state).toBe('no-key');
  });

  it('labels FreeLLMAPI as the local router', () => {
    const fl = engineSnapshot({}, T0).find(e => e.provider === 'freellmapi');
    expect(fl?.label).toContain('FREELMAPI');
  });

  it('carries cooldownRemainSec + the masked last error', () => {
    engineTrack('groq', new Error('groq 429 too many requests'), T0);
    engineTrack('groq', new Error('groq 429 too many requests'), T0);
    const e = engineSnapshot({ groq: 'k' }, T0 + 5000).find(x => x.provider === 'groq');
    expect(e?.state).toBe('cooldown');
    expect(e?.cooldownRemainSec).toBe(85);
    expect(e?.lastError).toContain('429');
  });

  it('shows ready with lastOkAgeSec after a success', () => {
    engineOk('groq', T0);
    const e = engineSnapshot({ groq: 'k' }, T0 + 40_000).find(x => x.provider === 'groq');
    expect(e?.state).toBe('ready');
    expect(e?.lastOkAgeSec).toBe(40);
  });
});

describe('engineStatusLine — the actionable offline reason', () => {
  it('no router → the FreeLLMAPI start guidance line', () => {
    const line = engineStatusLine({}, T0);
    expect(line).toContain('FreeLLMAPI');
    expect(line).toContain('OFFLINE');
    expect(line).toContain('127.0.0.1:31415');
  });

  it('a cooled engine shows provider + seconds + auto-retry', () => {
    engineTrack('groq', new Error('groq 429'), T0);
    engineTrack('groq', new Error('groq 429'), T0);
    const line = engineStatusLine({ groq: 'k' }, T0 + 5000);
    expect(line).toContain('groq');
    expect(line).toContain('cooldown');
    expect(line).toContain('auto-retry');
  });

  it('an ONLINE engine is stated plainly', () => {
    engineOk('gemini', T0);
    const line = engineStatusLine({ gemini: 'k' }, T0 + 1000);
    expect(line).toContain('gemini: ONLINE');
  });
});

describe('MTF AI guard — rule fallback stays honest', () => {
  it('getAiGuardModels reports the three FreeLLMAPI virtual seats', () => {
    const g = getAiGuardModels();
    expect(g.engine).toBe('freellmapi');
    expect(g.models).toEqual(['auto:fast', 'auto:smart', 'auto:balanced']);
    expect(g.count).toBe(3);
  });

  it('offline router returns a rule-based verdict, never a fabricated AI lock', () => {
    const r = evaluateMtfRowWithAiGuard({
      symbol: 'BTCUSDT', side: 'LONG', mode: 'INTRADAY',
      superScore: 70, worldAligned8Count: 7, aligned: true,
      triggerFired: true, netRR_T2: 1.9,
    });
    expect(['rule', 'freellmapi']).toContain(r.engine);
    if (r.engine === 'rule') {
      expect(r.ruleBasedGuard).toBe(true);
      expect(r.honestLabel).toContain('Rule-Based');
    }
    expect(r.totalModels).toBe(3);
    expect(typeof r.verdict).toBe('string');
  });
});
