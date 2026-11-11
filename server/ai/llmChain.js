// ============================================================
// server/ai/llmChain.js — v22.0 · THE ONE FREELMAPI CHAIN
// ------------------------------------------------------------
// Every council / deep-analysis / validator lane rides the local
// FreeLLMAPI router. There is no second engine leg or CLI bridge:
//
//   • profile SMART (default) → auto:smart
//   • profile BALANCED        → auto:balanced
//   • profile FAST            → auto:fast
//   • deep analysis ALWAYS    → auto:smart (depth beats latency)
//   • vision                  → pinned multimodal model ladder
//
// FreeLLMAPI owns upstream provider keys, quotas and routing. The site
// only tracks one health record ('freellmapi') in llmSentinel:
//   engineSkip → fast-fail during cooldown
//   engineOk   → clear the breaker on a valid verdict
//   engineTrack→ arm the breaker on a real failure
//
// aiEngineOnline() is the single availability gate for the Council,
// the LLM second-opinion validator and the council/dialogue paths.
// ============================================================
import { engineSkip, engineTrack, engineOk } from './llmSentinel.js';
import { tryParseJson, stripThinking } from './llmJson.js';
import {
  freeLlmJson,
  freeLlmVision,
  freeLlmProbe,
  freeLlmKeyPresentCached,
  FREELLMAPI_MODELS,
} from './freellmapi.js';
import { getAiMode, AI_PROFILE_MODELS } from './aiMode.js';
import { resolveRouteModel } from './routeStrategy.js';

export { tryParseJson };
export { stripThinking };

// FreeLLMAPI answers are remote (its upstream providers), not CPU-local:
// a scan verdict is normally 1-10s; deep reasoning can take a minute+.
// FREELLMAPI_TIMEOUT_MS is the documented shared fallback.
const _envMs = (name) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : null;
};
const SCAN_TIMEOUT_MS = _envMs('FREELLMAPI_SCAN_TIMEOUT_MS') || _envMs('FREELLMAPI_TIMEOUT_MS') || 60_000;
const DEEP_TIMEOUT_MS = _envMs('FREELLMAPI_DEEP_TIMEOUT_MS') || _envMs('FREELLMAPI_TIMEOUT_MS') || 180_000;

/** Per-call budget: explicit caller override → deep / scan default. */
function _timeoutMs(deep, explicit) {
  const n = Number(explicit);
  if (Number.isFinite(n) && n > 0) return n;
  return deep ? DEEP_TIMEOUT_MS : SCAN_TIMEOUT_MS;
}

function _profileModel(deep, opts = {}) {
  // v21.36.5 ROUTE STRATEGY: the model is no longer a flat profile alias —
  // it's the route-strategy table's pick for this LANE. Baseline = the
  // user's header profile (smart/balanced/fast, the legacy contract the
  // chain-env tests lock); the table then escalates where context demands
  // the smartest seat (deep verdicts, multi-symbol board reads, high-conviction
  // debates). Explicit env pins STILL win over the table for their own lane
  // (DEEP_MODEL pins the deep lane; FAST_MODEL pins only the fast-profile
  // lane — exactly the legacy semantics, now lane-scoped).
  const mode = getAiMode();
  const ctx = {
    deep: !!deep,
    multiSymbol: !!opts.multiSymbol,
    debate: !!opts.debate,
    score: opts.score != null ? Number(opts.score) : null,
  };
  if (deep) {
    const pin = String(process.env.FREELLMAPI_DEEP_MODEL || '').trim();
    if (pin) return pin;
    return resolveRouteModel('deep-ensemble', ctx).model;
  }
  if (mode === 'fast') {
    const pin = String(process.env.FREELLMAPI_FAST_MODEL || '').trim();
    if (pin) return pin;
  }
  return resolveRouteModel('trade-signal', ctx).model;
}

function _modelLabel(out, fallbackModel) {
  return `freellmapi:${out?.routedVia || out?.model || fallbackModel}`;
}

/**
 * Legacy helper — kept for older imports. Provider keys are NOT what
 * makes the council lanes online; FreeLLMAPI does.
 */
export function aiKeysPresent(KEYS) {
  if (freeLlmKeyPresentCached()) return true;
  if (String(process.env.FREELLMAPI_API_KEY || '').trim()) return true;
  return !!(KEYS && (
    KEYS.gemini || KEYS.groq || KEYS.cerebras
    || KEYS.openrouter || KEYS.huggingface || KEYS.nvidia
  ));
}

/**
 * Is the FreeLLMAPI router usable RIGHT NOW?
 * Never throws. A sentinel cooldown fast-fails; expiry auto-retries.
 */
export async function aiEngineOnline(_deps = null) {
  if (engineSkip('freellmapi')) return false;
  return !!(await freeLlmProbe().catch(() => false));
}

/**
 * One strict-JSON ask through the active FreeLLMAPI profile.
 * Returns { json, model } or { json: null, model: null } — never throws.
 */
export async function councilAsk(prompt, _deps = null, opts = {}) {
  const deep = !!opts.deep;
  if (engineSkip('freellmapi')) return { json: null, model: null };
  // Honest gate: never call the JSON helper when the router is down. The
  // direct provider keys are NOT a fallback for the council lane.
  if (!(await freeLlmProbe().catch(() => false))) return { json: null, model: null };
  // v21.36.5 ROUTE STRATEGY: the route pick is lane-aware — callers can
  // tag the ask with the context that escalates it (multiSymbol board
  // reads / debate calls / a candidate's superScore). opts.model and env
  // pins always beat the table.
  const model = opts.model || _profileModel(deep, opts);
  const budget = _timeoutMs(deep, opts.timeoutMs);
  let out;
  try {
    out = await freeLlmJson(prompt, {
      model,
      temperature: opts.temperature ?? (deep ? 0.15 : 0.2),
      // v21.36.4: 2048 truncated multi-symbol council JSON (only 3-4 of 6
      // verdicts survived). 4096 covers a full 6-symbol board with analysis.
      maxTokens: opts.maxTokens ?? 4096,
      timeoutMs: budget,
      ...(opts.system ? { system: opts.system } : {}),
    });
  } catch (e) {
    engineTrack('freellmapi', e);
    return { json: null, model: null };
  }
  const json = out?.json;
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    // v21.36.3 LIVE-CAUGHT: a PROSE answer is a model-quality miss, not a
    // router outage. Arming the shared breaker here (2 misses → 30-300s
    // cooldown) made the whole board's AI Council seat show "offline"
    // right after a debate step returned unparseable text. The strict-JSON
    // lane already retries without response_format; keep the breaker for
    // real transport/HTTP failures only.
    return { json: null, model: null };
  }
  engineOk('freellmapi');
  return { json, model: _modelLabel(out, model) };
}

/**
 * Deep-analysis variant — same router, smart seat, longer budget.
 */
export async function councilAskDeep(prompt, deps, opts = {}) {
  return councilAsk(prompt, deps, { ...opts, deep: true });
}

/**
 * Vision seat — chart screenshots via the pinned FreeLLMAPI multimodal
 * ladder. Failures use an ISOLATED breaker so a weak vision answer can
 * never park the board/council scan seat.
 * images: raw base64 or data URLs.
 */
export async function councilAskVision(prompt, images, _deps = null, opts = {}) {
  if (!Array.isArray(images) || images.length === 0) return { json: null, model: null };
  if (engineSkip('freellmapi-vision')) return { json: null, model: null };
  if (!(await freeLlmProbe().catch(() => false))) return { json: null, model: null };
  try {
    const out = await freeLlmVision(prompt, images, {
      timeoutMs: opts.timeoutMs || Number(process.env.FREELLMAPI_VISION_TIMEOUT_MS) || 90_000,
    });
    if (!out?.json) {
      engineTrack('freellmapi-vision', new Error('freellmapi-vision no-json response'));
      return { json: null, model: null };
    }
    engineOk('freellmapi-vision');
    return { json: out.json, model: _modelLabel(out, FREELLMAPI_MODELS.vision) };
  } catch (e) {
    engineTrack('freellmapi-vision', e);
    return { json: null, model: null };
  }
}

// ---------------- deterministic dual-verdict merge (compat utility) ----------------
// Kept for callers/tests that merge two already-parsed verdict objects.
// The live chain no longer runs two engines in parallel; FreeLLMAPI's
// own router/fusion handles model selection.

const CONFLICT_CONFIDENCE_FACTOR = 0.7;

function _isMap(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function _mergeVerdictPair(a, b) {
  if (a && !b) return { json: a, via: 'single-a' };
  if (b && !a) return { json: b, via: 'single-b' };
  if (!a && !b) return { json: null, via: 'none' };
  const va = String(a?.verdict ?? '').toUpperCase();
  const vb = String(b?.verdict ?? '').toUpperCase();
  if (!va || !vb) {
    return va ? { json: a, via: 'single-a' } : { json: b, via: 'single-b' };
  }
  if (va === vb) {
    const ca = Number(a.confidence) || 0;
    const cb = Number(b.confidence) || 0;
    const json = { ...a };
    if (b.analysis && !a.analysis) json.analysis = b.analysis;
    json.confidence = Math.round((ca + cb) / 2);
    json.note = `DUAL-AGREE${a.note ? ` · ${a.note}` : ''}`.slice(0, 160);
    return { json, via: 'agree' };
  }
  const ca = Number(a.confidence) || 0;
  const cb = Number(b.confidence) || 0;
  const winner = cb > ca ? b : a;
  const json = { ...winner };
  json.confidence = Math.round((Number(winner.confidence) || 0) * CONFLICT_CONFIDENCE_FACTOR);
  json.note = `DUAL-CONFLICT (a ${va} ${ca}% vs b ${vb} ${cb}%) — ${String(winner === a ? vb : va)} favoured, confidence discounted${a.note ? ` · ${a.note}` : ''}`.slice(0, 160);
  return { json, via: 'conflict' };
}

function _mergeSlotPair(a, b, scoreField) {
  if (a && !b) return { json: a, via: 'single-a' };
  if (b && !a) return { json: b, via: 'single-b' };
  if (!a && !b) return { json: null, via: 'none' };
  const va = String(a.verdict ?? '').toUpperCase();
  const vb = String(b.verdict ?? '').toUpperCase();
  const ca = Number(a[scoreField]) || 0;
  const cb = Number(b[scoreField]) || 0;
  if (va && va === vb) {
    const json = { ...a, ...b };
    json[scoreField] = Math.round((ca + cb) / 2);
    json.note = `DUAL-AGREE${a.note ? ` · ${a.note}` : ''}`.slice(0, 160);
    return { json, via: 'agree' };
  }
  if (va && vb && va !== vb) {
    const winner = cb > ca ? b : a;
    const loser = winner === a ? b : a;
    const json = { ...winner };
    json[scoreField] = Math.round((Number(winner[scoreField]) || 0) * CONFLICT_CONFIDENCE_FACTOR);
    json.note = `DUAL-CONFLICT (a ${va} ${ca} vs b ${vb} ${cb}) — ${String(winner === a ? vb : va)} favoured, score discounted${loser.note ? ` · ${loser.note}` : ''}`.slice(0, 160);
    return { json, via: 'conflict' };
  }
  const json = { ...b, ...a };
  json[scoreField] = Math.round(Math.max(ca, cb));
  if (typeof b.case === 'string' && b.case && b.case !== a.case) {
    json.case = `${a.case || ''} | B: ${b.case}`;
  }
  const note = [a.note, b.note].filter(Boolean).map(String).join(' · ').slice(0, 160);
  if (note) json.note = note;
  return { json, via: 'merged' };
}

/**
 * Merge two parsed verdict payloads ({ json, model }). Pure and
 * deterministic — used by offline checks and any legacy caller.
 */
export function mergeBothVerdicts(aLeg, bLeg) {
  const aj = aLeg?.json ?? null;
  const bj = bLeg?.json ?? null;
  const engines = [aLeg?.model, bLeg?.model].filter(Boolean);
  if (!aj && !bj) return { json: null, model: null, via: 'none' };
  if (aj && !bj) return { json: { ...aj, via: 'single-a' }, model: aLeg.model, via: 'single-a' };
  if (!aj && bj) return { json: { ...bj, via: 'single-b' }, model: bLeg.model, via: 'single-b' };

  const stats = { engines: engines.length ? engines : null, agree: 0, conflict: 0, merged: 0, single: 0 };
  const merged = { ...aj };
  let mapMerged = false;
  for (const key of ['verdicts', 'cases']) {
    const srcA = _isMap(aj[key]) ? aj[key] : null;
    const srcB = _isMap(bj[key]) ? bj[key] : null;
    if (!srcA && !srcB) continue;
    const scoreField = key === 'cases' ? 'strength' : 'confidence';
    const A = srcA || {};
    const B = srcB || {};
    const out = {};
    for (const sym of new Set([...Object.keys(A), ...Object.keys(B)])) {
      const pair = _mergeSlotPair(_isMap(A[sym]) ? A[sym] : null, _isMap(B[sym]) ? B[sym] : null, scoreField);
      out[sym] = pair.json;
      if (pair.via === 'agree') stats.agree++;
      else if (pair.via === 'conflict') stats.conflict++;
      else if (pair.via === 'merged') stats.merged++;
      else stats.single++;
    }
    merged[key] = out;
    mapMerged = true;
  }
  if (!merged.sentiment && _isMap(bj.sentiment)) merged.sentiment = bj.sentiment;

  let via;
  let model;
  if (mapMerged) {
    via = stats.conflict > 0 ? 'conflict' : stats.agree > 0 ? 'agree' : 'dual';
    model = engines.length ? engines.join(' + ') : null;
    merged.via = via;
    merged.model = model;
    if (!merged.verdict && _isMap(merged.verdicts)) {
      const syms = Object.keys(merged.verdicts);
      if (syms.length === 1) {
        const only = merged.verdicts[syms[0]];
        if (_isMap(only) && String(only.verdict || '')) {
          merged.verdict = only.verdict;
          if (only.confidence != null) merged.confidence = only.confidence;
        }
      }
    }
  } else {
    const top = _mergeVerdictPair(aj, bj);
    via = top.via;
    model = (top.via === 'agree' || top.via === 'conflict')
      ? (engines.length ? engines.join(' + ') : null)
      : (top.via === 'single-a' ? aLeg.model : bLeg.model);
    if (top.via === 'agree') stats.agree++;
    else if (top.via === 'conflict') stats.conflict++;
    else if (top.via === 'single-a' || top.via === 'single-b') stats.single++;
    if (top.json) {
      for (const [k, v] of Object.entries(top.json)) {
        if (!(k in merged) || ['verdict', 'confidence', 'note', 'analysis'].includes(k)) merged[k] = v;
      }
    }
    merged.via = via;
    merged.model = model;
  }
  merged.dualEngine = stats;
  return { json: merged, model, via };
}

export const __testables = { tryParseJson, stripThinking, freeLlmJson, _profileModel, _timeoutMs };
