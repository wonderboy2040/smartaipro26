// ============================================================
// server/ai/aiMode.js — site-wide FreeLLMAPI intelligence profile
// ------------------------------------------------------------
// The site no longer owns an inference engine. Every AI lane talks to
// the local FreeLLMAPI router, which holds the provider keys and picks
// the best eligible model per request. The only site-wide choice left
// is the routing profile:
//
//   SMART    (default) → auto:smart    · deepest council / validator /
//                                       deep analysis answers
//   BALANCED           → auto:balanced · quality/latency blend for the
//                                       desk agents and board scans
//   FAST               → auto:fast     · quick scans / MTF guard seats
//
// The profile is persisted atomically at server/data/ai-mode.json and
// read fresh on every AI call, so the header switch applies without a
// restart and survives one.
//
// Precedence: explicit runtime switch > persisted file > AI_MODE /
// FREELLMAPI_PROFILE env > safe default SMART.
//
// Legacy values: the old LOCAL / CLOUD / BOTH modes all map to SMART.
// FreeLLMAPI is local-first by design (the router runs on this machine
// and its upstreams are free), so there is no paid-vs-local split left.
// ============================================================
import { loadJSON, saveJSON } from '../lib/store.js';

export const AI_MODES = ['smart', 'balanced', 'fast'];
export const AI_MODE_FILE = 'ai-mode.json';
const DEFAULT_MODE = 'smart';

/** Profile → FreeLLMAPI virtual model. */
export const AI_PROFILE_MODELS = {
  smart: 'auto:smart',
  balanced: 'auto:balanced',
  fast: 'auto:fast',
};

/** Legacy persisted/env values from the previous engine-mode era. */
const LEGACY_MODE_MAP = {
  local: 'smart',
  cloud: 'smart',
  both: 'smart',
  max: 'smart',
  intelligent: 'smart',
};

let _runtimeMode = null;

/** Normalize a user/env value. Returns 'smart' | 'balanced' | 'fast' | null. */
export function normalizeAiMode(value) {
  const mode = String(value ?? '').trim().toLowerCase();
  if (AI_MODES.includes(mode)) return mode;
  if (LEGACY_MODE_MAP[mode]) return LEGACY_MODE_MAP[mode];
  return null;
}

/** First-boot default from env. Never overrides a persisted mode. */
function _envMode() {
  const raw = process.env.AI_MODE || process.env.FREELLMAPI_PROFILE;
  const explicit = normalizeAiMode(raw);
  if (explicit) {
    return {
      mode: explicit,
      source: process.env.AI_MODE ? 'env' : 'env-profile',
      legacy: AI_MODES.includes(String(raw ?? '').trim().toLowerCase()) ? null : String(raw ?? '').trim(),
    };
  }
  return { mode: DEFAULT_MODE, source: 'default', legacy: null };
}

function _persisted() {
  const data = loadJSON(AI_MODE_FILE, {});
  const raw = String(data?.mode ?? '').trim().toLowerCase();
  const mode = normalizeAiMode(raw);
  if (!mode) return null;
  return {
    mode,
    legacy: AI_MODES.includes(raw) ? null : raw,
    updatedAt: Number.isFinite(Number(data?.updatedAt)) ? Number(data.updatedAt) : null,
  };
}

/** The effective profile. Runtime switch > persisted file > env > default. */
export function getAiMode() {
  return getAiModeStatus().mode;
}

/** Full status view for the API/UI (never contains secrets). */
export function getAiModeStatus() {
  if (_runtimeMode) {
    const saved = _persisted();
    return {
      mode: _runtimeMode,
      profile: _runtimeMode,
      model: AI_PROFILE_MODELS[_runtimeMode],
      engine: 'freellmapi',
      source: 'runtime',
      persisted: !!saved && saved.mode === _runtimeMode,
      updatedAt: saved?.mode === _runtimeMode ? saved.updatedAt : null,
      modes: [...AI_MODES],
    };
  }
  const saved = _persisted();
  if (saved) {
    return {
      mode: saved.mode,
      profile: saved.mode,
      model: AI_PROFILE_MODELS[saved.mode],
      engine: 'freellmapi',
      source: 'file',
      persisted: true,
      updatedAt: saved.updatedAt,
      legacy: saved.legacy,
      modes: [...AI_MODES],
    };
  }
  const env = _envMode();
  return {
    mode: env.mode,
    profile: env.mode,
    model: AI_PROFILE_MODELS[env.mode],
    engine: 'freellmapi',
    source: env.source,
    persisted: false,
    updatedAt: null,
    legacy: env.legacy,
    modes: [...AI_MODES],
  };
}

export function isSmartMode() {
  return getAiMode() === 'smart';
}

export function isBalancedMode() {
  return getAiMode() === 'balanced';
}

export function isFastMode() {
  return getAiMode() === 'fast';
}

/**
 * Switch the profile now. Applies to this process immediately even when
 * the filesystem is read-only (`persisted:false` reports that honestly);
 * a writable server/data/ai-mode.json makes it restart-safe.
 */
export function setAiMode(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  const mode = normalizeAiMode(raw);
  if (!mode) {
    return { ok: false, mode: null, persisted: false, error: 'mode must be "smart", "balanced" or "fast"' };
  }
  _runtimeMode = mode;
  const persisted = saveJSON(AI_MODE_FILE, { mode, updatedAt: Date.now() });
  return {
    ok: true,
    mode,
    profile: mode,
    model: AI_PROFILE_MODELS[mode],
    legacy: AI_MODES.includes(raw) ? null : raw,
    persisted,
  };
}

/** Test hook — drop the in-process override (file/env are re-read). */
export function __resetAiModeForTests() {
  _runtimeMode = null;
}
