// ============================================================
// server/ai/llmChain.js — v21.27 · THE ONE SHARED LLM PROVIDER CHAIN
// ------------------------------------------------------------
// v11.0: extracted from signals.js so the Global Market Council can
// ride the SAME chain without a circular import (signals ↔ council).
//
// v21.27 SITE-WIDE LOCAL / CLOUD SWITCH (this file):
//   • LOCAL → keyless Ollama only. Zero cloud calls.
//   • CLOUD → OpenCode free models FIRST (GLM fast seat / DeepSeek deep
//     seat), then Ollama as the fallback. Paid provider keys are NEVER
//     attempted in either mode (Gemini/Groq/Cerebras/OpenRouter/HF/NVIDIA
//     were removed from this chain).
//   • aiEngineOnline() is the single availability gate for the Council,
//     the LLM second-opinion validator and the council/dialogue paths.
//   • AI mode is server-wide + restart-safe (server/ai/aiMode.js).
//
// The v18.x sentinel still owns the LOCAL Ollama breaker; the OpenCode
// bridge owns its own per-model breaker + rate limits.
// ============================================================
import {
  engineSkip, engineTrack, engineOk, ollamaProbe, ollamaCompatCfg, ollamaVisionModel,
  OLLAMA_NUM_CTX, OLLAMA_NUM_CTX_DEEP, OLLAMA_KEEP_ALIVE,
} from './llmSentinel.js';
import { tryParseJson, stripThinking } from './llmJson.js';
import { askOpenCode, resolveSeatModel, opencodeProbe } from './opencodeBridge.js';
import { getAiMode } from './aiMode.js';

export { tryParseJson };
export { stripThinking };

// CPU-local models are slow (first prompt + 14B deep-reasoner especially).
// deepseek-r1:14b needs ~2-3 min for a real JSON verdict on a 15GB laptop,
// so the old 90s budget guaranteed deep-path timeouts. Env-overridable.
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS) || 240_000;
// v21.27.1 FIX (pro-level recheck): SCAN seats need their own bounded budget.
// Sharing the 240s deep budget parked a whole board cycle for minutes when
// the local daemon accepted the request but never generated (observed: board
// cold scan >120s on INDIA alone; debate = up to 3 calls). 45s keeps the
// board responsive; a timeout arms the sentinel breaker so later calls in the
// same cycle fast-fail instead of each paying the full budget.
const OLLAMA_SCAN_TIMEOUT_MS = Number(process.env.OLLAMA_SCAN_TIMEOUT_MS) || 45_000;

/** Per-call Ollama budget: explicit caller override → deep 240s / scan 45s.
 *  Env is read at call time so tests/smokes can bound a wedged daemon. */
function _ollamaTimeoutMs(deep, timeoutMs) {
  const explicit = Number(timeoutMs);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  if (deep) return OLLAMA_TIMEOUT_MS;
  const scanEnv = Number(process.env.OLLAMA_SCAN_TIMEOUT_MS);
  return Number.isFinite(scanEnv) && scanEnv > 0 ? scanEnv : OLLAMA_SCAN_TIMEOUT_MS;
}

// v21.0: the local Ollama base (sentinel ke jaisa hi env resolve — ek
// hi default, dono modules me consistent).
const OLLAMA_URL = (process.env.OLLAMA_BASE || 'http://127.0.0.1:11434').replace(/\/+$/, '');

/**
 * v21.0 / v21.18.0 NATIVE OLLAMA CALL (/api/chat — ZERO-ERROR UPGRADE).
 *   • Supports message.content + message.thinking fallback (Ollama v0.9+ CoT)
 *   • Auto-fallback on HTTP 404 (if deepModel isn't pulled, falls back to scan model)
 *   • Auto-retry without format:'json' if a reasoning model returns empty content under grammar lock
 */
async function askOllamaNative(prompt, { deep = false, images = null, system = null, model = null, timeoutMs = null } = {}) {
  const cfg = ollamaCompatCfg({ deep });
  const useModel = model || cfg.defModel;
  const budgetMs = _ollamaTimeoutMs(deep, timeoutMs);
  const ollamaBase = String(cfg.url || '').replace(/\/v1\/chat\/completions$/, '') || OLLAMA_URL;
  const buildBody = (m, useJsonFormat = true) => ({
    model: m,
    stream: false,
    messages: [
      ...(system ? [{ role: 'system', content: system }] : [{ role: 'system', content: 'You are a superintelligence quantitative trading analyst. Respond with STRICT valid JSON only.' }]),
      { role: 'user', content: prompt, ...(Array.isArray(images) && images.length ? { images } : {}) },
    ],
    ...(useJsonFormat ? { format: 'json' } : {}),
    // Scan/vision seats must answer fast (the 8B Qwen3 otherwise burns the
    // whole budget on hidden thinking and can leave `content` empty). The
    // deep seat keeps native reasoning for the 14B R1 model.
    ...(deep ? {} : { think: false }),
    options: {
      temperature: 0.2,
      num_ctx: deep ? OLLAMA_NUM_CTX_DEEP : OLLAMA_NUM_CTX,
      num_predict: 2048,
    },
    keep_alive: OLLAMA_KEEP_ALIVE,
  });
  let r = await fetch(`${ollamaBase}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildBody(useModel, true)),
    signal: AbortSignal.timeout(budgetMs),
  });
  // v21.18.0: agar deep model locally pull nahi hai (HTTP 404), turant
  // scan model pe fallback karo — zero error!
  if (r.status === 404 && deep) {
    const scanModel = ollamaCompatCfg({ deep: false })?.defModel;
    if (scanModel && scanModel !== useModel) {
      r = await fetch(`${ollamaBase}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildBody(scanModel, true)),
        signal: AbortSignal.timeout(budgetMs),
      });
    }
  }
  if (!r.ok) throw new Error(`ollama http ${r.status}`);
  const j = await r.json();
  const text = (j?.message?.content || '') + (j?.message?.thinking ? '\n' + j.message.thinking : '') + (j?.response ? '\n' + j.response : '');
  const parsed = tryParseJson(text);
  if (parsed) return parsed;
  // v21.18.0: reasoning models (deepseek-r1 / qwen3) kabhi-kabhi format:'json'
  // grammar lock me empty content dete hain — ek baar bina format:'json' retry!
  const r2 = await fetch(`${ollamaBase}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildBody(useModel, false)),
    signal: AbortSignal.timeout(budgetMs),
  }).catch(() => null);
  if (r2?.ok) {
    const j2 = await r2.json().catch(() => null);
    const t2 = (j2?.message?.content || '') + (j2?.message?.thinking ? '\n' + j2.message.thinking : '') + (j2?.response ? '\n' + j2.response : '');
    return tryParseJson(t2);
  }
  return null;
}

/**
 * Legacy export — kept for older imports/tests only. The v1 LOCAL/CLOUD
 * switch does NOT use paid provider keys: `aiEngineOnline()` is the
 * decision gate for the Council / deep / validator lanes.
 */
export function aiKeysPresent(KEYS) {
  return !!(KEYS && (
    KEYS.gemini || KEYS.groq || KEYS.cerebras
    || KEYS.openrouter || KEYS.huggingface || KEYS.nvidia
  ));
}

/**
 * Is at least one engine usable RIGHT NOW?
 *   LOCAL → keyless Ollama reachable.
 *   CLOUD → OpenCode CLI ready (not logged-out) OR Ollama fallback.
 * Never throws, never returns paid-key state: those providers are no
 * longer in the v1 Council / deep / validator lanes.
 */
export async function aiEngineOnline(_deps = null) {
  const mode = getAiMode();
  let ocOnline = false;
  if (mode === 'cloud' || mode === 'both') {
    const oc = await opencodeProbe().catch(() => null);
    ocOnline = !!(oc?.available && oc?.loggedIn !== false);
  }
  const olOnline = !!(await ollamaProbe().catch(() => false));
  // BOTH: either engine online is enough — the merge degrades honestly to
  // the single live engine (never silently to paid APIs).
  if (mode === 'both') return ocOnline || olOnline;
  if (mode === 'cloud') return ocOnline || olOnline;
  return olOnline;
}

/**
 * CLOUD leg: OpenCode free model first.
 *   fast seat → GLM (normal scan / council / validator)
 *   deep seat → DeepSeek (deep single-symbol analysis)
 * The bridge owns its per-model breaker + rate limits, so failures
 * (busy / cooldown / free-limit / timeout / bad JSON) simply return
 * null here — the caller falls back to Ollama, never to paid APIs.
 */
async function _askOpenCodeLeg(prompt, { deep = false } = {}) {
  const ocModel = resolveSeatModel(deep ? 'deep' : 'fast');
  if (!ocModel) return { json: null, model: null };
  try {
    const out = await askOpenCode(prompt, { model: ocModel, deep });
    const json = out?.json;
    if (json && typeof json === 'object' && !Array.isArray(json)) {
      return { json, model: out.model };
    }
    return { json: null, model: null };
  } catch {
    // Bridge already recorded the failure in its per-model breaker.
    return { json: null, model: null };
  }
}

/**
 * LOCAL leg: keyless Ollama (native /api/chat). Sentinel-tracked like
 * any engine: success clears the breaker, failure arms it, an open
 * cooldown fast-fails.
 */
async function _askOllamaLeg(prompt, { deep = false, timeoutMs = null } = {}) {
  if (engineSkip('ollama')) return { json: null, model: null };
  const reachable = await ollamaProbe().catch(() => false);
  if (!reachable) return { json: null, model: null };
  let json = null, threw = false;
  try {
    json = await askOllamaNative(prompt, { deep, timeoutMs });
  } catch (e) {
    threw = true;
    engineTrack('ollama', e);
  }
  if (json) {
    engineOk('ollama');
    // v21.0.3 HONEST MODEL ATTRIBUTION: provider-name ke bajaye REAL
    // model naam (scan → ollama:qwen3:8b, deep → ollama:deepseek-r1:14b).
    return { json, model: `ollama:${ollamaCompatCfg({ deep }).defModel}` };
  }
  if (!threw) engineTrack('ollama', new Error('ollama no-json response'));
  return { json: null, model: null };
}

/**
 * One ask through the ACTIVE site mode. Returns { json, model } or
 * { json: null, model: null } — never throws.
 *
 * LOCAL → Ollama only (no cloud call at all).
 * CLOUD → OpenCode free model first (GLM scan / DeepSeek deep), then
 *         the Ollama fallback. Paid cloud APIs are never attempted.
 * BOTH  → OpenCode cloud AND local Ollama run in PARALLEL; their
 *         verdicts are merged (agree → average confidence, conflict →
 *         the confident engine at a 30% discount, single-engine →
 *         honest degradation). Paid APIs are never attempted either.
 *
 * `deps` is accepted for call-site compatibility but is deliberately
 * unused — provider keys no longer select the engine. The runtime
 * switch (server/data/ai-mode.json) does.
 */
export async function councilAsk(prompt, _deps = null, opts = {}) {
  const deep = !!opts.deep;
  const mode = getAiMode();
  if (mode === 'both') return _councilAskBoth(prompt, { deep, timeoutMs: opts.timeoutMs });
  if (mode === 'cloud') {
    const cloud = await _askOpenCodeLeg(prompt, { deep });
    if (cloud.json) return cloud;
  }
  return _askOllamaLeg(prompt, { deep, timeoutMs: opts.timeoutMs });
}

// ---------------- BOTH mode — parallel dual-engine merge ----------------

const CONFLICT_CONFIDENCE_FACTOR = 0.7;

/**
 * Deterministic pair-merge of two parsed verdict objects
 * ({verdict, confidence, note, analysis, ...}). Rules:
 *   AGREE    → shared verdict, confidence = average
 *   CONFLICT → the higher-confidence engine wins, confidence × 0.7
 *   single   → the one parsed engine, untouched
 * Returns { json, via: 'agree' | 'conflict' | 'single-a' | 'single-b' | 'none' }.
 * Never throws: bad inputs degrade to the available side.
 */
function _isMap(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Deterministic pair-merge of two parsed verdict objects
 * ({verdict, confidence, note, analysis, ...}). Rules:
 *   AGREE    → shared verdict, confidence = average
 *   CONFLICT → the higher-confidence engine wins, confidence × 0.7
 *   single   → the one parsed engine, untouched
 * Returns { json, via: 'agree' | 'conflict' | 'single-a' | 'single-b' | 'none' }.
 * Never throws: bad inputs degrade to the available side.
 */
function _mergeVerdictPair(a, b) {
  if (a && !b) return { json: a, via: 'single-a' };
  if (b && !a) return { json: b, via: 'single-b' };
  if (!a && !b) return { json: null, via: 'none' };
  const va = String(a?.verdict ?? '').toUpperCase();
  const vb = String(b?.verdict ?? '').toUpperCase();
  if (!va || !vb) {
    // One side has no scalar verdict — keep whichever does (cloud first).
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
  // Conflict: the confident engine wins; tie → cloud engine (a).
  const ca = Number(a.confidence) || 0;
  const cb = Number(b.confidence) || 0;
  const winner = cb > ca ? b : a;
  const json = { ...winner };
  json.confidence = Math.round((Number(winner.confidence) || 0) * CONFLICT_CONFIDENCE_FACTOR);
  json.note = `DUAL-CONFLICT (cloud ${va} ${ca}% vs local ${vb} ${cb}%) — ${String(winner === a ? vb : va)} favoured, confidence discounted${a.note ? ` · ${a.note}` : ''}`.slice(0, 160);
  return { json, via: 'conflict' };
}

/**
 * One per-symbol slot merge (used for BOTH the `verdicts` map and the
 * debate `cases` map). `scoreField` is 'confidence' for verdicts slots and
 * 'strength' for cases slots.
 *   AGREE    → same scalar, averaged score
 *   CONFLICT → higher-score engine wins, score × 0.7
 *   merged   → no comparable scalar (debate case prose {case,strength}):
 *              cloud slot canonical, local prose APPENDED (never dropped),
 *              score = max of the two — both engines genuinely contributed
 *   single-* → only one engine had this symbol
 */
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
    json.note = `DUAL-CONFLICT (cloud ${va} ${ca} vs local ${vb} ${cb}) — ${String(winner === a ? vb : va)} favoured, score discounted${loser.note ? ` · ${loser.note}` : ''}`.slice(0, 160);
    return { json, via: 'conflict' };
  }
  // No comparable scalar (debate case slots carry {case, strength} prose):
  // keep BOTH engines' data — cloud canonical, local's differing case
  // appended rather than silently dropped; score = the stronger one.
  const json = { ...b, ...a };
  json[scoreField] = Math.round(Math.max(ca, cb));
  if (typeof b.case === 'string' && b.case && b.case !== a.case) {
    json.case = `${a.case || ''} | LOCAL: ${b.case}`;
  }
  const note = [a.note, b.note].filter(Boolean).map(String).join(' · ').slice(0, 160);
  if (note) json.note = note;
  return { json, via: 'merged' };
}

/**
 * Merge the two BOTH-mode legs ({ json, model }). The merged payload keeps
 * every key consumers read (verdicts map, debate cases map, sentiment,
 * top-level verdict) — extra `via`/`dualEngine` fields are informational
 * only. Single-engine / no-engine cases degrade honestly and NEVER claim a
 * dual-engine model string when only one engine actually contributed.
 */
export function mergeBothVerdicts(ocLeg, olLeg) {
  const aj = ocLeg?.json ?? null;
  const bj = olLeg?.json ?? null;
  const engines = [ocLeg?.model, olLeg?.model].filter(Boolean);
  if (!aj && !bj) return { json: null, model: null, via: 'none' };
  if (aj && !bj) return { json: { ...aj, via: 'single-cloud' }, model: ocLeg.model, via: 'single-cloud' };
  if (!aj && bj) return { json: { ...bj, via: 'single-local' }, model: olLeg.model, via: 'single-local' };

  const stats = { engines: engines.length ? engines : null, agree: 0, conflict: 0, merged: 0, single: 0 };
  const merged = { ...aj };

  // Per-symbol map merge for the two shapes the council/debate lanes use:
  //   verdicts: {SYM:{verdict,confidence,note,analysis}} (council + validator)
  //   cases:    {SYM:{case,strength}} (bull/bear advocate debate)
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
    // A per-symbol map on both legs → both engines genuinely contributed.
    via = stats.conflict > 0 ? 'conflict' : stats.agree > 0 ? 'agree' : 'dual';
    model = engines.length ? engines.join(' + ') : null;
    merged.via = via;
    merged.model = model;
    // v21.35.3 [RECHECK FIX #2 — validator shape-drift]: if BOTH legs drifted
    // to the `{verdicts:{SYM:{...}}}` map shape WITHOUT a top-level `verdict`
    // (Ollama 8B occasionally answers the validator's strict-JSON prompt in
    // the council map shape), a single-symbol map is unwrapped to the
    // top level so consumers reading `json.verdict` (llmValidator) still get
    // a verdict instead of silently null-ing the whole second-opinion call.
    // Multi-symbol maps are NOT unwrapped (no honest single verdict exists).
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
      : (top.via === 'single-a' ? ocLeg.model : olLeg.model);
    // A scalar (top-level verdict) agree/conflict is itself a genuine
    // dual-engine contribution — reflect it in the stats counters so the
    // attribution is honest even when there is no per-symbol map.
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

/**
 * BOTH mode: the two legs run in PARALLEL (wall time = the slower one).
 *
 * v21.35.3 [RECHECK FIX #1 — deep-timeout asymmetry]: a BOTH DEEP call must
 * not block on the local 240s deep budget when the cloud deep seat (45s cap)
 * already produced a valid verdict at t≈45s. Without an explicit caller
 * budget, the Ollama leg of a DEEP BOTH ask is capped at the cloud deep
 * budget — a slow local 14B deep leg then degrades HONESTLY to single-cloud
 * instead of stalling the UI ~240s (and, through the 3-step deep debate +
 * legacy fallback, up to ~14min). LOCAL-only mode keeps its full budget
 * (it never runs the cloud leg), and an explicit `timeoutMs` still wins.
 */
async function _councilAskBoth(prompt, { deep = false, timeoutMs = null } = {}) {
  const olTimeoutMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
    ? timeoutMs
    : (deep ? Math.max(1, Number(process.env.OPENCODE_DEEP_TIMEOUT_MS) || 45_000) : null);
  const [ocLeg, olLeg] = await Promise.all([
    _askOpenCodeLeg(prompt, { deep }),
    _askOllamaLeg(prompt, { deep, timeoutMs: olTimeoutMs }),
  ]);
  const merged = mergeBothVerdicts(ocLeg, olLeg);
  if (!merged.json) return { json: null, model: null };
  return { json: merged.json, model: merged.model };
}

/**
 * v20.6.1: deep-analysis variant of councilAsk. Identical to councilAsk
 * EXCEPT it uses OLLAMA_DEEP_MODEL (e.g. deepseek-r1:14b) instead of
 * OLLAMA_MODEL (e.g. qwen3:8b) for the local-engine leg. Designed for
 * the user's 16GB laptop setup:
 *   • scan path (signals.js board compute) → councilAsk → qwen3:8b
 *   • deep single-symbol analysis (getDeepSignal → /api/ai/deep/:sym)
 *     → councilAskDeep → deepseek-r1:14b (auto-swap on Ollama's side
 *     when OLLAMA_MAX_LOADED_MODELS=1; cost ~30-60s per transition).
 *
 * Cloud providers are tried FIRST (same chain as councilAsk) when
 * LLM_LOCAL_ONLY is unset. The deep-model swap only applies to the
 * local Ollama leg. The scan path NEVER triggers a swap → no perf hit.
 */
export async function councilAskDeep(prompt, deps) {
  return councilAsk(prompt, deps, { deep: true });
}

/**
 * v21.0 VISION SEAT — chart-screenshot analysis. Ollama me native
 * multimodal models (qwen2.5vl:7b / qwen3-vl:8b) ko chart image
 * + structured prompt milta hai; verdict STRICT JSON me aata hai
 * (format:'json' + think-strip native path se).
 * Cloud engines ke paas vision nahi hai (ye seat LOCAL-ONLY hai) —
 * model installed nahi → { json: null, model: null } (honest abstain,
 * sentinel-track nahi kyunki capability-missing failure nahi hai).
 * images: [base64, ...] (data-URL prefix ke BINA — Ollama format).
 */
export async function councilAskVision(prompt, images, _deps = null, opts = {}) {
  if (!Array.isArray(images) || images.length === 0) return { json: null, model: null };
  const visionModel = ollamaVisionModel();
  if (!visionModel) return { json: null, model: null };
  // v21.1.1 [audit C3]: isolated breaker ko FAST-FAIL me consult karo —
  // breaker arm tha par call se PEHLE check nahi hota tha, isliye cooldown
  // ke dauraan har vision request full 90s timeout tak jalati thi. Ab
  // cooldown = instant skip (expiry par auto-retry).
  if (engineSkip('ollama-vision')) return { json: null, model: null };
  const reachable = await ollamaProbe().catch(() => false);
  if (!reachable) return { json: null, model: null };
  // v21.0.6 [audit B2]: vision failures apna ALAG circuit breaker
  // ('ollama-vision') arm karte hain — pehle shared 'ollama' breaker
  // arm hota tha, isliye 2 weak-JSON vision calls board ke scan seat
  // (councilAsk ollama leg) ko 30s+ ke liye park kar deti thi.
  // engineSnapshot sirf SENTINEL_PROVIDERS dikhata hai, isliye
  // 'ollama-vision' breaker UI me nahi aata (sirf isolation ka kaam).
  try {
    const json = await askOllamaNative(prompt, {
      model: visionModel,
      images,
      system: 'You are an elite technical analyst reading a trading chart screenshot. Respond with STRICT JSON only.',
      timeoutMs: opts.timeoutMs || OLLAMA_TIMEOUT_MS,
    });
    if (json) { engineOk('ollama-vision'); return { json, model: `ollama:${visionModel}` }; }
    engineTrack('ollama-vision', new Error('ollama-vision no-json response'));
    return { json: null, model: null };
  } catch (e) {
    engineTrack('ollama-vision', e);
    return { json: null, model: null };
  }
}

export const __testables = { tryParseJson, askOllamaNative, stripThinking };
