// ============================================================
// server/ai/llmSentinel.js — v22.0 AI ENGINE SENTINEL (FreeLLMAPI)
// ------------------------------------------------------------
// ONE local router, one health ledger. FreeLLMAPI owns every upstream
// provider key; the site only needs to know whether the router itself
// is answering and which model it routed the last request to.
//
//   • FAST-FAIL   — 'freellmapi' in cooldown is skipped instantly, so
//     a closed desktop app never costs a 30-120s timeout per board row.
//   • AUTO-RECOVER — cooldown expiry = half-open: the next ask retries.
//     POST /api/ai/engines/recheck clears cooldowns and re-probes NOW.
//   • HONEST STATUS — engineSnapshot() powers GET /api/ai/engines with
//     no-key / cooldown / ready / tried and the masked last error.
//   • MTF AI GUARD — a fire-and-forget `auto:fast` seat votes on warm
//     board rows (CONFIRM / CAUTION), cached 30s and rate-limited so a
//     ~26-symbol scan never floods the router's free quotas.
//
// PURITY: this module never calls a provider directly. The only network
// I/O is the router liveness probe (delegated to freellmapi.js) and the
// bounded, fire-and-forget MTF guard ask.
// ============================================================
import {
  freeLlmProbe,
  freeLlmStatus,
  freeLlmReachableCached,
  freeLlmJson,
  FREELLMAPI_MODELS,
} from './freellmapi.js';
import { getAiMode } from './aiMode.js';

/** All engines the sentinel tracks (order = UI preference). */
export const SENTINEL_PROVIDERS = ['freellmapi', 'gemini', 'groq', 'cerebras', 'openrouter', 'huggingface', 'nvidia'];

const ERR_TRUNC = 120;

const _state = {
  engines: new Map(), // name → { consecFails, lastErr, lastErrAt, cooldownUntil, lastOkAt, calls }
};

function _rec(name) {
  if (!_state.engines.has(name)) {
    _state.engines.set(name, { consecFails: 0, lastErr: null, lastErrAt: 0, cooldownUntil: 0, lastOkAt: 0, calls: 0 });
  }
  return _state.engines.get(name);
}

// ---------------- circuit breaker core ----------------

/** True when the provider is cooling down and must be SKIPPED fast. */
export function engineSkip(provider, now = Date.now()) {
  const r = _state.engines.get(provider);
  return !!(r && r.cooldownUntil > now);
}

/** Report a SUCCESS — resets the breaker, marks ready. */
export function engineOk(provider, now = Date.now()) {
  const r = _rec(provider);
  r.consecFails = 0;
  r.cooldownUntil = 0;
  r.lastOkAt = now;
}

/**
 * Report a FAILURE. Cooldown ladder (armed on the 2nd consecutive
 * failure — one transient blip never parks an engine):
 *   401/403 (bad key)      → 15 min
 *   429     (rate limit)   → 90 s
 *   network / 5xx / other  → 30s → 60s → 120s → 300s (cap)
 */
export function engineTrack(provider, err, now = Date.now()) {
  const r = _rec(provider);
  r.calls++;
  r.lastErrAt = now;
  r.lastErr = String(err?.message || err || 'error').slice(0, ERR_TRUNC);
  r.consecFails++;
  if (r.consecFails >= 2) {
    const msg = r.lastErr;
    const coolMs = /\b(401|403)\b/.test(msg) ? 900_000
      : /\b429\b/.test(msg) ? 90_000
        : [30_000, 60_000, 120_000, 300_000][Math.min(r.consecFails - 2, 3)];
    r.cooldownUntil = now + coolMs;
  }
  return { cooldownMs: Math.max(0, r.cooldownUntil - now) };
}

/** Clear ALL cooldowns (the RECHECK button) — engines half-open now. */
export function engineClearCooldowns() {
  for (const r of _state.engines.values()) r.cooldownUntil = 0;
}

// ---------------- views (NEVER leak key material) ----------------

/**
 * Masked per-engine health view for GET /api/ai/engines and the
 * /api/ai/status `engines` block. `KEYS` is only read for BOOLEAN
 * presence — key values never leave this module.
 */
export function engineSnapshot(KEYS = {}, now = Date.now()) {
  return SENTINEL_PROVIDERS.map((name) => {
    const r = _state.engines.get(name);
    const configured = name === 'freellmapi'
      ? freeLlmReachableCached()
      : !!(KEYS && KEYS[name]);
    const cooling = !!(r && r.cooldownUntil > now);
    const state = !configured ? 'no-key'
      : cooling ? 'cooldown'
        : r?.lastOkAt ? 'ready'
          : r?.lastErrAt ? 'tried' : 'idle';
    return {
      provider: name,
      label: name === 'freellmapi' ? 'FREELMAPI·LOCAL' : name.toUpperCase(),
      configured,
      state,
      lastError: r?.lastErr || null,
      cooldownRemainSec: cooling ? Math.ceil((r.cooldownUntil - now) / 1000) : 0,
      lastOkAgeSec: r?.lastOkAt ? Math.max(0, Math.round((now - r.lastOkAt) / 1000)) : null,
      consecFails: r?.consecFails || 0,
    };
  });
}

/**
 * One compact Hinglish line for the deterministic-mode answer footer —
 * makes "engines offline" actionable instead of scary.
 */
export function engineStatusLine(KEYS = {}, now = Date.now()) {
  const parts = [];
  for (const e of engineSnapshot(KEYS, now)) {
    if (e.provider === 'freellmapi') {
      if (e.state === 'cooldown') parts.push(`FreeLLMAPI: ${e.cooldownRemainSec}s cooldown auto-retry (${e.lastError || 'fail'})`);
      else if (e.configured) parts.push('FreeLLMAPI: ONLINE');
      else parts.push('FreeLLMAPI: OFFLINE (desktop app start karo — default 127.0.0.1:31415)');
      continue;
    }
    if (!e.configured) continue;
    if (e.state === 'cooldown') parts.push(`${e.provider}: ${e.cooldownRemainSec}s cooldown auto-retry (${e.lastError || 'fail'})`);
    else if (e.state === 'ready') parts.push(`${e.provider}: ONLINE`);
    else if (e.state === 'tried') parts.push(`${e.provider}: ${e.lastError || 'no response'}`);
    else parts.push(`${e.provider}: armed`);
  }
  return `${parts.join(' | ')} — RECHECK button dabao ya FreeLLMAPI desktop app start karo`;
}

// ---------------- MTF board AI guard ----------------

// Per-symbol AI verdict cache. A board scan stays <50ms because the
// guard only ever reads this cache; the live ask refreshes in the
// background for the next 30s window.
const _mtfAiCache = new Map();
const MTF_AI_TTL_MS = 30_000;
const MTF_AI_TIMEOUT_MS = Number(process.env.FREELLMAPI_MTF_TIMEOUT_MS) || 25_000;

const _warmWindow = { start: 0, count: 0 };
const WARM_WINDOW_MS = 30_000;
function _warmPerWindow() {
  return Math.max(1, Number(process.env.FREELLMAPI_MTF_WARM_PER_WINDOW) || 6);
}

/** The three FreeLLMAPI guard seats (same three roles as before). */
export function getAiGuardModels() {
  const st = freeLlmStatus();
  return {
    engine: 'freellmapi',
    reachable: !!st.available,
    base: st.baseUrl || null,
    fastModel: FREELLMAPI_MODELS.fast,
    deepModel: FREELLMAPI_MODELS.smart,
    sentinelModel: FREELLMAPI_MODELS.balanced,
    models: [FREELLMAPI_MODELS.fast, FREELLMAPI_MODELS.smart, FREELLMAPI_MODELS.balanced],
    count: 3,
    profile: getAiMode(),
  };
}

function _parseGuard(out) {
  const json = out?.json;
  if (json && typeof json === 'object') {
    const action = String(json.action || json.verdict || '').toUpperCase();
    const verdict = action === 'CONFIRM' ? 'CONFIRM'
      : action === 'REJECT' || action === 'WAIT' || action === 'CAUTION' ? 'CAUTION'
        : null;
    const note = String(json.note || json.reason || '').slice(0, 90);
    return { verdict, note };
  }
  const text = String(out?.text || '').trim();
  if (!text) return { verdict: null, note: '' };
  const verdict = /\b(CAUTION|VETO|REVERSE|AVOID|TRAP|WAIT|SKIP|DISAGREE|REJECT)\b/i.test(text)
    ? 'CAUTION'
    : /\b(CONFIRM|AGREE|LOCK)\b/i.test(text)
      ? 'CONFIRM'
      : null;
  return { verdict, note: text.slice(0, 90) };
}

/**
 * Non-circular 3-seat rule guard + optional live FreeLLMAPI verdict.
 * Seats:
 *   1. Fast Guard   (auto:fast)     — trigger & micro-momentum
 *   2. Deep Guard   (auto:smart)    — 8-indicator structure & net R:R
 *   3. Sentinel Guard (auto:balanced) — conflicts, traps & live caution
 * Never blocks: the live ask is fire-and-forget into the 30s cache.
 */
export function evaluateMtfRowWithAiGuard(rowCtx = {}) {
  const trio = getAiGuardModels();
  const trioLive = trio.reachable;
  const sym = String(rowCtx.symbol || '').toUpperCase();
  const side = rowCtx.side || 'NONE';
  const superScore = Number(rowCtx.superScore) || 0;
  // Unmeasured counts must stay conservative — never fabricate 6/8.
  const worldAligned8Raw = Number(rowCtx.worldAligned8Count ?? rowCtx.worldAlignedCount);
  const worldAligned8 = Math.min(8, Number.isFinite(worldAligned8Raw) ? worldAligned8Raw : 0);
  const aligned = !!rowCtx.aligned;
  const triggerFired = !!rowCtx.triggerFired;
  const netRR = Number(rowCtx.netRR_T2) || 0;
  const hasReversalOrTrap = Boolean(rowCtx.reversalRisk || rowCtx.opposingFlow || rowCtx.trapVeto || rowCtx.zoneWallVeto);
  const hasCrossConflict = Boolean(rowCtx.boardSideConflict || rowCtx.svaConflict || rowCtx.councilConflict);
  const key = `${sym}:${side}:${rowCtx.mode || 'INTRADAY'}`;
  const cached = _mtfAiCache.get(key);
  const liveCaution = Boolean(cached?.liveNote && /\b(CAUTION|VETO|REVERSE|AVOID|TRAP|WAIT|SKIP|DISAGREE)\b/i.test(cached.liveNote));
  const liveConfirm = Boolean(cached?.liveNote && !liveCaution && /\b(CONFIRM|AGREE|LOCK|LONG|SHORT)\b/i.test(cached.liveNote));

  const fastVote = (hasReversalOrTrap || hasCrossConflict)
    ? 0
    : (triggerFired && superScore >= 68) ? 1 : (superScore >= 58 ? 0.5 : 0);
  const deepVote = (rowCtx.trapVeto || rowCtx.zoneWallVeto || hasCrossConflict)
    ? 0
    : (aligned && worldAligned8 >= 6 && netRR >= 1.2) ? 1 : (aligned && worldAligned8 >= 5 ? 0.6 : 0);
  const sentinelVote = (hasReversalOrTrap || hasCrossConflict || liveCaution || rowCtx.counterTrend)
    ? 0
    : (liveConfirm || (aligned && worldAligned8 >= 6 && (triggerFired || netRR >= 1.2)))
      ? 1
      : (aligned && worldAligned8 >= 5 ? 0.6 : 0);
  const voteSum = Number((fastVote + deepVote + sentinelVote).toFixed(2));
  const approvedCount = (fastVote >= 0.6 ? 1 : 0) + (deepVote >= 0.6 ? 1 : 0) + (sentinelVote >= 0.6 ? 1 : 0);

  // Refresh the live guard seat in the background (bounded per window).
  if (trioLive && sym && (side === 'LONG' || side === 'SHORT') && (!cached || Date.now() - cached.at > MTF_AI_TTL_MS)) {
    if (!cached) {
      _mtfAiCache.set(key, {
        at: Date.now(),
        liveNote: null,
        liveVerdict: null,
        latencyMs: null,
        engine: 'rule',
      });
    }
    _warmGuardSeat(key, {
      sym, side, superScore, worldAligned8, netRR,
      hasReversalOrTrap, hasCrossConflict,
    });
  }

  const engine = cached?.engine === 'freellmapi' && cached?.liveNote ? 'freellmapi' : 'rule';
  const verdict = approvedCount === 3
    ? '3/3 FREELMAPI AI LOCK'
    : approvedCount === 2
      ? '2/3 FREELMAPI AI STRONG'
      : '1/3 FREELMAPI WATCH';
  const scoreBoost = approvedCount === 3 ? 4 : approvedCount === 2 ? 2 : 0;
  const hasLiveResponse = Boolean(cached?.liveNote && engine === 'freellmapi');
  const ruleBasedGuard = !hasLiveResponse;
  const modelLabel = FREELLMAPI_MODELS.fast;
  const honestLabel = hasLiveResponse
    ? `Live FreeLLMAPI (${modelLabel}): ${cached?.liveVerdict || verdict}`
    : `Rule-Based Guard ${approvedCount}/3`;

  return {
    optimized: true,
    reachable: trioLive,
    profile: trio.profile,
    engine,
    ruleBasedGuard,
    honestLabel,
    liveVerdict: cached?.liveVerdict ?? null,
    models: trio.models,
    fastModel: trio.fastModel,
    deepModel: trio.deepModel,
    sentinelModel: trio.sentinelModel,
    approvedCount,
    totalModels: 3,
    voteScore: Math.round((voteSum / 3) * 100),
    verdict,
    scoreBoost,
    latencyMs: cached?.latencyMs ?? null,
    liveNote: cached?.liveNote || `${honestLabel} (${modelLabel} → ${verdict})`,
  };
}

function _warmGuardSeat(key, ctx) {
  const now = Date.now();
  if (now - _warmWindow.start >= WARM_WINDOW_MS) {
    _warmWindow.start = now;
    _warmWindow.count = 0;
  }
  if (_warmWindow.count >= _warmPerWindow()) return;
  _warmWindow.count++;
  const prompt = [
    'You are the MOMENTUM GUARD for a trading desk.',
    `Verify this MTF ${ctx.sym} ${ctx.side} setup (score=${ctx.superScore} inst8=${ctx.worldAligned8}/8 RR=${ctx.netRR} revRisk=${ctx.hasReversalOrTrap} conflict=${ctx.hasCrossConflict}).`,
    'Return STRICT JSON only: {"action":"CONFIRM|WAIT|REJECT","confidence":0-100,"note":"<=8 words"}',
  ].join(' ');
  freeLlmJson(prompt, {
    model: FREELLMAPI_MODELS.fast,
    temperature: 0.1,
    maxTokens: 80,
    timeoutMs: MTF_AI_TIMEOUT_MS,
  })
    .then(out => {
      const { verdict, note } = _parseGuard(out);
      if (!verdict) return;
      _mtfAiCache.set(key, {
        at: Date.now(),
        liveNote: note || (verdict === 'CONFIRM' ? 'FreeLLMAPI CONFIRM' : 'FreeLLMAPI CAUTION'),
        liveVerdict: verdict,
        latencyMs: out.latencyMs,
        engine: 'freellmapi',
      });
    })
    .catch(() => {
      // Fire-and-forget: the rule-based guard already answered the board.
    });
}

// ---------------- test hooks ----------------
export function __resetSentinelForTests() {
  _state.engines.clear();
  _mtfAiCache.clear();
  _warmWindow.start = 0;
  _warmWindow.count = 0;
}

export { freeLlmProbe, freeLlmStatus };
