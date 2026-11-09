// ============================================================
// server/ai/freellmapi.js — FreeLLMAPI local router bridge
// ------------------------------------------------------------
// FreeLLMAPI (https://github.com/tashfeenahmed/freellmapi) runs a
// local OpenAI-compatible gateway (desktop default 127.0.0.1:31415).
// It owns the provider keys, model catalog, quotas and smart routing,
// so the site NEVER needs provider keys in .env for the AI lanes.
//
// This bridge is the ONE place that talks to it:
//   • base URL auto-detection — FREELLMAPI_URL, the desktop
//     config.json port, then 31415 / 3001 loopback candidates
//   • unified API key auto-discovery — FREELLMAPI_API_KEY env, then
//     settings.unified_api_key in the local freeapi.db (read-only)
//   • cached liveness + model-catalog probe (single flight)
//   • chat / strict-JSON / vision helpers with an auth retry
//   • honest status for /api/ai/engines (never leaks the key)
//
// Routing aliases exposed by FreeLLMAPI (verified live):
//   auto:smart    → highest-intelligence eligible model
//   auto:balanced → balanced quality / latency
//   auto:fast     → fastest eligible model
//   auto:reliable → most reliable / retry-friendly model
//   fusion        → multi-model synthesis (only when explicitly asked)
//
// PURITY: no circuit breaker here. llmChain/llmSentinel own health
// tracking so a dead router is skipped fast and auto-recovers.
// ============================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tryParseJson } from './llmJson.js';

export const FREELLMAPI_PROVIDER = 'freellmapi';

/** Virtual router models (served by FreeLLMAPI itself). */
export const FREELLMAPI_MODELS = {
  smart: 'auto:smart',
  balanced: 'auto:balanced',
  fast: 'auto:fast',
  reliable: 'auto:reliable',
  fusion: 'fusion',
  vision: process.env.FREELLMAPI_VISION_MODEL || 'qwen2.5-vl-72b',
};

/** Default vision ladder — pinned because the plain `auto` router may
 *  pick a text-only model when images are present. Verified live:
 *  qwen2.5-vl-72b answers chart screenshots in ~3s. */
const DEFAULT_VISION_MODELS = ['qwen2.5-vl-72b', 'llama-3.2-90b-vision', 'llama-3.2-11b-vision'];

const DEFAULT_ROOTS = [
  'http://127.0.0.1:31415',
  'http://localhost:31415',
  'http://127.0.0.1:3001',
  'http://localhost:3001',
];

// Probe cache: positive 30s, negative 12s. A manual recheck bypasses it.
const PROBE_TTL_OK_MS = 30_000;
const PROBE_TTL_FAIL_MS = 12_000;

const _state = {
  baseUrl: '',
  reachable: false,
  key: '',
  keySource: 'none', // 'env' | 'db' | 'none'
  dbPath: null,
  models: [],
  visionModels: [],
  checkedAt: 0,
  checking: null,
  lastError: null,
  probeLatencyMs: null,
  lastRoutedVia: null,
};

export class FreeLlmError extends Error {
  constructor(message, { status = null, code = 'freellmapi-error', body = null } = {}) {
    super(message);
    this.name = 'FreeLlmError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

function _cleanBase(raw) {
  let s = String(raw || '').trim().replace(/\/+$/, '');
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  // Accept either the root or the OpenAI-compatible /v1 base.
  s = s.replace(/\/v1$/i, '');
  return s.replace(/\/+$/, '');
}

function _configDirs() {
  const dirs = [];
  const appData = process.env.APPDATA;
  if (appData) dirs.push(path.join(appData, 'FreeLLMAPI'));
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) dirs.push(path.join(xdg, 'FreeLLMAPI'));
  try {
    dirs.push(path.join(os.homedir(), '.config', 'FreeLLMAPI'));
    dirs.push(path.join(os.homedir(), 'Library', 'Application Support', 'FreeLLMAPI'));
    dirs.push(path.join(os.homedir(), 'AppData', 'Roaming', 'FreeLLMAPI'));
  } catch { /* homedir is always available, but never block on it */ }
  return [...new Set(dirs)];
}

/** Root URLs to probe, env first, then the desktop config port. */
function _candidateRoots() {
  const roots = [];
  const envUrl = process.env.FREELLMAPI_URL || process.env.FREELLMAPI_BASE_URL;
  if (envUrl) roots.push(_cleanBase(envUrl));
  for (const dir of _configDirs()) {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
      const port = Number(cfg?.port);
      if (Number.isFinite(port) && port > 0) {
        roots.push(`http://127.0.0.1:${port}`);
        roots.push(`http://localhost:${port}`);
      }
    } catch { /* no desktop config — keep probing defaults */ }
  }
  roots.push(...DEFAULT_ROOTS);
  return [...new Set(roots.filter(Boolean))];
}

/** Local freeapi.db candidates (desktop userData + self-host data dir). */
function _dbCandidates() {
  const out = [];
  const explicit = process.env.FREELLMAPI_DB_PATH || process.env.FREEAPI_DB_PATH;
  if (explicit) out.push(explicit);
  for (const dir of _configDirs()) out.push(path.join(dir, 'freeapi.db'));
  try {
    out.push(path.join(process.cwd(), 'data', 'freeapi.db'));
    out.push(path.join(process.cwd(), 'server', 'data', 'freeapi.db'));
  } catch { /* cwd always exists */ }
  return [...new Set(out)];
}

async function _readDbKey(dbPath) {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db.prepare("SELECT value FROM settings WHERE key = 'unified_api_key'").get();
      return row?.value ? String(row.value).trim() : '';
    } finally {
      db.close();
    }
  } catch {
    return '';
  }
}

/** Discover the unified key without ever logging or returning it to a client. */
async function _discoverKey(force = false) {
  const envKey = String(process.env.FREELLMAPI_API_KEY || process.env.FREELLMAPI_KEY || '').trim();
  if (envKey) {
    _state.key = envKey;
    _state.keySource = 'env';
    return envKey;
  }
  if (!force && _state.key && _state.keySource === 'db') return _state.key;
  for (const dbPath of _dbCandidates()) {
    if (!dbPath || !fs.existsSync(dbPath)) continue;
    const key = await _readDbKey(dbPath);
    if (key) {
      _state.key = key;
      _state.keySource = 'db';
      _state.dbPath = dbPath;
      return key;
    }
  }
  _state.key = '';
  _state.keySource = 'none';
  return '';
}

function _visionLadder() {
  const pin = String(process.env.FREELLMAPI_VISION_MODEL || '').trim();
  const envList = String(process.env.FREELLMAPI_VISION_MODELS || '').split(',').map(s => s.trim()).filter(Boolean);
  const ladder = [...new Set([pin, ...envList].filter(Boolean))];
  const ordered = ladder.length ? ladder : DEFAULT_VISION_MODELS;
  const available = new Set(_state.models);
  if (!available.size) return ordered;
  const present = ordered.filter(m => available.has(m));
  // If the operator configured a custom id that the catalog does not list,
  // still try it first — model availability can lag the catalog.
  return present.length ? present : ordered;
}

/**
 * Liveness + auth + catalog probe. Cached; single flight; force bypasses.
 * Returns true only when the router is reachable AND a usable key exists.
 */
export async function freeLlmProbe(force = false) {
  const now = Date.now();
  const ttl = _state.reachable ? PROBE_TTL_OK_MS : PROBE_TTL_FAIL_MS;
  if (!force && _state.checkedAt && now - _state.checkedAt < ttl) return _state.reachable && !!_state.key;
  if (_state.checking) return _state.checking;

  _state.checking = (async () => {
    const t0 = Date.now();
    let lastErr = null;
    for (const root of _candidateRoots()) {
      try {
        const ping = await fetch(`${root}/api/ping`, { signal: AbortSignal.timeout(2500) });
        if (!ping.ok) { lastErr = `ping ${ping.status}`; continue; }

        let key = await _discoverKey();
        _state.baseUrl = root;
        _state.reachable = true;
        _state.key = key;
        if (!key) {
          _state.lastError = 'FreeLLMAPI reachable but no unified API key found (set FREELLMAPI_API_KEY or start the desktop app)';
          _state.probeLatencyMs = Date.now() - t0;
          return false;
        }

        let modelsRes = await fetch(`${root}/v1/models?available=true`, {
          headers: { Authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(8000),
        });
        if (modelsRes.status === 401 || modelsRes.status === 403) {
          key = await _discoverKey(true);
          _state.key = key;
          if (key) {
            modelsRes = await fetch(`${root}/v1/models?available=true`, {
              headers: { Authorization: `Bearer ${key}` },
              signal: AbortSignal.timeout(8000),
            });
          }
        }
        if (!modelsRes.ok) {
          _state.lastError = `models ${modelsRes.status}`;
          _state.probeLatencyMs = Date.now() - t0;
          return false;
        }
        const catalog = await modelsRes.json().catch(() => null);
        const ids = Array.isArray(catalog?.data) ? catalog.data.map(m => String(m?.id || '')).filter(Boolean) : [];
        _state.models = ids;
        _state.visionModels = _visionLadder();
        _state.lastError = null;
        _state.probeLatencyMs = Date.now() - t0;
        return true;
      } catch (e) {
        lastErr = String(e?.message || e);
      }
    }
    _state.reachable = false;
    _state.lastError = lastErr || 'FreeLLMAPI unreachable';
    _state.probeLatencyMs = Date.now() - t0;
    return false;
  })()
    .catch(e => {
      _state.reachable = false;
      _state.lastError = String(e?.message || e);
      return false;
    })
    .finally(() => {
      _state.checkedAt = Date.now();
      _state.checking = null;
    });

  return _state.checking;
}

/** Sync view for sentinel snapshots (never triggers network I/O). */
export function freeLlmReachableCached() {
  return !!(_state.reachable && _state.key);
}

export function freeLlmKeyPresentCached() {
  return !!_state.key;
}

/** Honest status block for /api/ai/engines — key value is NEVER exposed. */
export function freeLlmStatus() {
  return {
    provider: FREELLMAPI_PROVIDER,
    name: 'FreeLLMAPI',
    available: !!(_state.reachable && _state.key),
    reachable: !!_state.reachable,
    baseUrl: _state.baseUrl || null,
    apiBase: _state.baseUrl ? `${_state.baseUrl}/v1` : null,
    keyPresent: !!_state.key,
    keySource: _state.keySource,
    dbPath: _state.dbPath || null,
    modelsCount: _state.models.length,
    models: { ...FREELLMAPI_MODELS },
    visionModels: _state.visionModels.length ? [..._state.visionModels] : [...DEFAULT_VISION_MODELS],
    model: FREELLMAPI_MODELS.smart,
    checkedAgeSec: _state.checkedAt ? Math.max(0, Math.round((Date.now() - _state.checkedAt) / 1000)) : null,
    probeLatencyMs: _state.probeLatencyMs,
    lastRoutedVia: _state.lastRoutedVia,
    lastError: _state.lastError,
  };
}

async function _ensureReady(force = false) {
  if (!force && _state.reachable && _state.key) return true;
  return freeLlmProbe(force);
}

async function _refreshKey() {
  const key = await _discoverKey(true);
  _state.key = key;
  return !!key;
}

function _normalizeMessages(input, system = null) {
  if (Array.isArray(input)) {
    const messages = input
      .filter(m => m && (m.role === 'system' || m.role === 'user' || m.role === 'assistant' || m.role === 'tool'))
      .map(m => ({ role: m.role, content: m.content }));
    if (system && !messages.some(m => m.role === 'system')) messages.unshift({ role: 'system', content: system });
    return messages;
  }
  return [
    ...(system ? [{ role: 'system', content: system }] : []),
    { role: 'user', content: String(input ?? '') },
  ];
}

/**
 * One OpenAI-compatible chat call through FreeLLMAPI.
 * Supports tools/tool_choice, JSON mode and a 401 auth retry.
 * Throws FreeLlmError with an honest message/status on failure.
 */
export async function freeLlmChat({
  model = FREELLMAPI_MODELS.smart,
  messages,
  system = null,
  temperature = 0.2,
  maxTokens = 2048,
  tools = null,
  toolChoice = null,
  jsonMode = false,
  timeoutMs = 120_000,
} = {}) {
  const reqMessages = _normalizeMessages(messages, system);
  if (!reqMessages.length) throw new FreeLlmError('messages[] required', { code: 'bad-request' });
  const ok = await _ensureReady();
  if (!ok) {
    throw new FreeLlmError(_state.lastError || 'FreeLLMAPI unreachable', { code: 'freellmapi-unavailable' });
  }

  const body = {
    model,
    messages: reqMessages,
    temperature: Math.min(2, Math.max(0, Number(temperature) || 0)),
    max_tokens: Math.max(1, Math.min(8192, Math.round(Number(maxTokens) || 2048))),
    stream: false,
  };
  if (Array.isArray(tools) && tools.length) {
    body.tools = tools;
    if (toolChoice) body.tool_choice = toolChoice;
  }
  if (jsonMode) body.response_format = { type: 'json_object' };

  const t0 = Date.now();
  const send = (key) => fetch(`${_state.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(Math.max(1000, Number(timeoutMs) || 120_000)),
  });

  let res;
  try {
    res = await send(_state.key);
  } catch (e) {
    throw new FreeLlmError(`FreeLLMAPI request failed: ${e?.message || e}`, { code: 'network-error' });
  }
  // A rotated unified key must not park the whole site until restart.
  if ((res.status === 401 || res.status === 403) && await _refreshKey()) {
    try {
      res = await send(_state.key);
    } catch (e) {
      throw new FreeLlmError(`FreeLLMAPI request failed after key refresh: ${e?.message || e}`, { code: 'network-error' });
    }
  }

  const rawText = await res.text().catch(() => '');
  let payload = null;
  try { payload = rawText ? JSON.parse(rawText) : null; } catch { payload = null; }
  if (!res.ok) {
    const message = payload?.error?.message || payload?.message || `FreeLLMAPI HTTP ${res.status}`;
    throw new FreeLlmError(String(message).slice(0, 400), {
      status: res.status,
      code: payload?.error?.code || payload?.code || 'http-error',
      body: payload,
    });
  }

  const choice = payload?.choices?.[0] || null;
  const content = choice?.message?.content;
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map(p => (typeof p === 'string' ? p : p?.text || '')).join('\n')
      : '';
  const routedVia = res.headers.get('x-routed-via') || null;
  _state.lastRoutedVia = routedVia;
  return {
    text: String(text || '').trim(),
    model: String(payload?.model || model),
    routedVia,
    latencyMs: Date.now() - t0,
    usage: payload?.usage || null,
    finishReason: choice?.finish_reason || null,
    toolCalls: choice?.message?.tool_calls || [],
    raw: payload,
  };
}

/**
 * Strict-JSON variant. Returns { json, text, model, routedVia, latencyMs }.
 * `json` is null when the model answered prose — callers must stay honest
 * instead of inventing a verdict.
 */
export async function freeLlmJson(prompt, {
  system = 'You are a superintelligence quantitative trading analyst. Reply with STRICT valid JSON only — no markdown fences, no prose before or after the object.',
  model = FREELLMAPI_MODELS.smart,
  temperature = 0.2,
  maxTokens = 2048,
  timeoutMs = 120_000,
} = {}) {
  const req = {
    model,
    messages: _normalizeMessages(prompt, system),
    temperature,
    maxTokens,
    timeoutMs,
  };
  // v21.36.2 [JSON-MODE FIX — LIVE-CAUGHT]: auto:fast ne prose answer diya
  // (reasoning text, no object) → llmChain ne "no-json response" track karke
  // 2 fails par breaker arm kar diya aur poora AI lane 5-min cooldown me chala
  // gaya. FreeLLMAPI OpenAI-compatible response_format support karta hai
  // (verified live: auto:fast + response_format={"type":"json_object"} →
  // clean {"ok":true}). Yahan force karo; strict system prompt backup rehta hai.
  let out;
  try {
    out = await freeLlmChat({ ...req, jsonMode: true });
  } catch (e) {
    // Kuch upstream models response_format reject karte hain (400/422) —
    // un par ek baar plain retry, warna valid verdicts permanently block ho
    // jate. Koi silent JSON fabrication nahi: text wahi strict parser se
    // guzarta hai.
    if (e?.status === 400 || e?.status === 422) out = await freeLlmChat({ ...req, jsonMode: false });
    else throw e;
  }
  return { ...out, json: tryParseJson(out.text) };
}

function _asDataUrl(image) {
  const s = String(image || '').trim();
  if (!s) return '';
  if (/^data:image\//i.test(s)) return s;
  return `data:image/png;base64,${s}`;
}

/**
 * Vision seat — chart screenshots. FreeLLMAPI's plain `auto` router can
 * select a text-only model, so the vision ladder is PINNED to real
 * multimodal ids and falls forward on 429/timeout/parse failure.
 * `images` accepts raw base64 (legacy format) or data URLs.
 */
export async function freeLlmVision(prompt, images, {
  system = 'You are an elite technical analyst reading a trading chart screenshot. Reply with STRICT valid JSON only.',
  timeoutMs = 90_000,
  maxTokens = 1200,
  temperature = 0.1,
} = {}) {
  const list = (Array.isArray(images) ? images : [images]).map(_asDataUrl).filter(Boolean);
  if (!list.length) throw new FreeLlmError('vision images required', { code: 'bad-request' });
  const ok = await _ensureReady();
  if (!ok) throw new FreeLlmError(_state.lastError || 'FreeLLMAPI unreachable', { code: 'freellmapi-unavailable' });

  const content = [
    { type: 'text', text: String(prompt || '') },
    ...list.map(url => ({ type: 'image_url', image_url: { url } })),
  ];
  const ladder = _visionLadder();
  const errors = [];
  for (const model of ladder) {
    try {
      const out = await freeLlmChat({
        model,
        messages: [{ role: 'user', content }],
        system,
        temperature,
        maxTokens,
        timeoutMs,
      });
      const json = tryParseJson(out.text);
      if (json) {
        return {
          json,
          text: out.text,
          model: out.model,
          routedVia: out.routedVia,
          latencyMs: out.latencyMs,
        };
      }
      errors.push(`${model}: no JSON verdict`);
    } catch (e) {
      errors.push(`${model}: ${e?.message || e}`);
      // 401/403 means the unified key is bad for every model — no point
      // burning the whole ladder on the same auth wall.
      if (e?.status === 401 || e?.status === 403) break;
    }
  }
  throw new FreeLlmError(`FreeLLMAPI vision failed — ${errors.join(' | ')}`, { code: 'vision-failed' });
}

/**
 * OpenAI-compatible config for the desk-agent loops (tool calling).
 * The agent loops receive the key via `cfg.apiKey` so no KEYS entry is
 * required and the unified key never enters provider key maps.
 */
export async function freeLlmAgentCfg() {
  const ok = await _ensureReady();
  if (!ok) return null;
  return {
    provider: FREELLMAPI_PROVIDER,
    url: `${_state.baseUrl}/v1/chat/completions`,
    baseUrl: _state.baseUrl,
    apiKey: _state.key,
    defModel: FREELLMAPI_MODELS.balanced,
    deepModel: FREELLMAPI_MODELS.smart,
    fastModel: FREELLMAPI_MODELS.fast,
  };
}

/**
 * Boot warm-up: force a fresh probe + catalog load so the first board
 * scan never pays discovery latency. Never throws — boot must not fail
 * because the desktop router is closed.
 */
export async function warmFreeLlm() {
  const ok = await freeLlmProbe(true).catch(() => false);
  return { ok, ...freeLlmStatus() };
}

/** Test hook — clear all cached discovery/probe state. */
export function __resetFreeLlmForTests() {
  _state.baseUrl = '';
  _state.reachable = false;
  _state.key = '';
  _state.keySource = 'none';
  _state.dbPath = null;
  _state.models = [];
  _state.visionModels = [];
  _state.checkedAt = 0;
  _state.checking = null;
  _state.lastError = null;
  _state.probeLatencyMs = null;
  _state.lastRoutedVia = null;
}

export const __testables = { _candidateRoots, _dbCandidates, _cleanBase, _visionLadder };
