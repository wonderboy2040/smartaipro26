// ============================================================
// server/ai/routeStrategy.js — v21.36.5 FREE-LANES ROUTE STRATEGY
// ------------------------------------------------------------
// THE IDEA (user: "Jab site load hota hai kaunsa route strategy use karni
// hai, trade signal pe kaunsa, final entry (sniper) pe kaunsa, deep
// ensemble me kaunsa FreeLLMAPI — smartest/fastest/balanced"):
//
// FreeLLMAPI's four virtual routes have DIFFERENT shapes:
//   auto:smart     — smartest eligible model (depth, latency ~seconds..min)
//   auto:balanced  — fastest eligible model that still answers STRICT JSON
//   auto:fast      — lowest-latency model (prose-prone; the v21.36.2
//                    lesson: a JSON lane must never sit on it by default)
//   auto:reliable  — retry-friendly model (quota-aware), built exactly
//                    for bounded fire-and-forget guard calls
//
// This module is the SINGLE source of truth for which route serves which
// use-case. The table below IS the user's ask, made executable:
//
//   SITE LOAD (site-boot probe + first-visit readiness)
//     → FASTEST that still proves the router: auto:balanced
//     (a smart-seat probe at boot would sit on quota for ~30s)
//
//   MTF AI-GUARD warm seat (bounded fire-and-forget, 25s deadline,
//     30s cache, ≤6 calls/30s window)
//     → BALANCED: auto:balanced = the FASTEST route that still reliably
//     answers strict JSON. auto:fast is prose-prone on a JSON lane
//     (the v21.36.2 miss-class, silent this time); auto:reliable is the
//     documented fallback when the router is quota-saturated. Never
//     burns the smart route on a throwaway verdict; the seat re-arms
//     from cache, not a fresh ask.
//     (v21.36.5: pehle FAST hardcoded tha, ab route table se balanced.)
//
//   TRADE SIGNAL DECISION (councilAsk non-deep lanes: SVA/verifier,
//     6-seat verdicts, bull/bear debate + judge, single-symbol AI confirm)
//     → BALANCED by default; the DEEP path always escalates to SMART:
//     a scan profile is a latency preference, not a reason to weaken a
//     single-symbol verdict.
//     → DEBATE + MULTI-SYMBOL council calls escalate SMARTEST
//       (auto:smart) — the v21.36.4 4096-token 6-symbol lesson: one
//       smart seat must read the whole board, not truncated prose.
//
//   FINAL / SNIPER ENTRY DECISION (deep-monitor super-agent +
//     boardAiConfirm + llmValidator: the money moment, 4.5s deadline)
//     → SMART: the sniper entry is the money moment, so the SMARTEST
//     seat confirms it by default. One honest downgrade — a
//     LOW-CONVICTION row (< 85) under a FAST profile rides the
//     retry-friendly auto:reliable seat instead of burning a smart call
//     on a weak signal. This is the "final entry smartest" upgrade
//     (the warm guard is only ever balanced — it never spends smart).
//
//   DEEP ENSEMBLE / COUNCIL (6 specialists + bull/bear + judge +
//     boardAiConfirm deep)
//     → SMART (auto:smart), temp 0.15, 180s budget — depth beats
//       latency. Vision stays on its pinned multimodal ladder.
//
//   DECISIONS ROUTING (getDecisionRoute) — the per-symbol view the UI's
//     Signal Recheck panel shows: which route a specific symbol's
//     trade/entry decision rides RIGHT NOW + why, so no seat is a
//     black box.
//
// Honesty rules:
//   • a route resolution NEVER throws — an unknown route falls back to
//     the profile's default (getAiMode), never a fabricated smart claim;
//   • explicit pins (FREELLMAPI_*_MODEL env / opts.model) always win —
//     an operator override beats the strategy table;
//   • the table is pure data + pure functions: tests drive it with
//     __setAiModeForTests, no env mutation.
// ============================================================
import { FREELLMAPI_MODELS } from './freellmapi.js';
import { getAiMode, AI_PROFILE_MODELS } from './aiMode.js';

// v21.36.5 test seam — drives the profile without touching the persisted
// ai-mode.json / env. null = fall through to the real getAiMode().
let _testAiMode = null;
function _profile() {
  if (_testAiMode) return _testAiMode;
  try { return getAiMode(); } catch { return 'smart'; }
}

/** The four smartest/fastest/balanced/reliable routes in one place. */
export const ROUTES = Object.freeze({
  smartest: () => FREELLMAPI_MODELS.smart,      // auto:smart
  balanced: () => FREELLMAPI_MODELS.balanced,   // auto:balanced
  fastest: () => FREELLMAPI_MODELS.fast,        // auto:fast
  reliable: () => FREELLMAPI_MODELS.reliable,   // auto:reliable
});

/**
 * The use-case table (the single source of truth). `pick` runs with the
 * live context and returns a route key — this is where "smartest vs
 * fastest vs balanced" is decided PER CONTEXT, not per deploy.
 */
export const ROUTE_TABLE = Object.freeze([
  {
    id: 'site-load',
    useCase: 'SITE LOAD',
    desc: 'Router liveness probe + first-visit readiness (30s positive / 12s negative cache).',
    route: 'balanced',
    pick: () => 'balanced',
    why: 'FASTEST that still proves the router — a smart-seat probe at boot would sit on quota for ~30s.',
  },
  {
    id: 'mtf-ai-guard',
    useCase: 'MTF AI-GUARD (warm)',
    desc: 'Fire-and-forget guard seat, 25s deadline, 30s cache, ≤6 calls/30s window.',
    route: 'balanced',
    pick: () => 'balanced',
    why: 'FASTEST route that still reliably answers strict JSON. auto:fast is prose-prone on a JSON lane (the v21.36.2 miss); balanced is the quality/latency blend, and auto:reliable is the fallback when the router is quota-saturated. (v21.36.5: pehle FAST, ab BALANCED.)',
  },
  {
    id: 'trade-signal',
    useCase: 'TRADE SIGNAL DECISION',
    desc: 'Council ask non-deep lanes: SVA/verifier + 6-seat verdicts + bull/bear debate + judge (single-symbol).',
    route: 'balanced',
    pick: (ctx, profile) => {
      // Escalations FIRST (the strategy layer's job): a deep verdict, a
      // board-wide multi-symbol read, or a high-conviction DEBATE must get
      // the smartest seat — the user's scan profile is a latency
      // preference, never a reason to weaken one of those.
      if (ctx?.deep) return 'smartest';
      if (ctx?.multiSymbol) return 'smartest';
      if (ctx?.debate && (ctx.multiSymbol || Number(ctx.score ?? 0) >= 80 || profile === 'smart')) return 'smartest';
      // Baseline = the user's own header profile (legacy contract the
      // chain-env tests lock: smart→smart, balanced→balanced, fast→fast).
      if (profile === 'smart') return 'smartest';
      if (profile === 'fast') return 'fastest';
      return 'balanced';
    },
    why: 'BALANCED by default (fastest JSON-reliable); the DEEP path and every multi-symbol/DEBATE call escalate to the SMARTEST seat. A scan profile is a latency preference, never a weaker verdict.',
  },
  {
    id: 'final-entry',
    useCase: 'FINAL / SNIPER ENTRY DECISION',
    desc: 'The money moment — deep-monitor super-agent + boardAiConfirm + llmValidator on a specific trade (4.5s deadline, JSON-strict).',
    route: 'smartest',
    pick: (ctx, profile) => {
      // SNIPER ENTRY = the money moment → the SMARTEST route by default.
      // One honest downgrade: a LOW-CONVICTION row (< 85) under the FAST
      // profile rides the retry-friendly reliable seat instead of burning a
      // smart call on a weak signal.
      if (Number(ctx?.score ?? 0) < 85 && profile === 'fast') return 'reliable';
      return 'smartest';
    },
    why: 'SNIPER DEFAULT = SMART: a money-moment confirm rides the smartest seat; only a low-conviction row under a FAST profile downgrades to the retry-friendly reliable seat. Final entry smartest, warm guard balanced — that is the upgrade.',
  },
  {
    id: 'deep-ensemble',
    useCase: 'DEEP ENSEMBLE / COUNCIL',
    desc: '6 specialist seats + bull/bear + judge + boardAiConfirm deep, vision on its pinned multimodal ladder.',
    route: 'smartest',
    pick: () => 'smartest',
    why: 'SMART, temp 0.15, 180s budget — depth beats latency. Vision rides its pinned ladder, never the auto route.',
  },
]);

const _ROUTE_KEYS = new Set(Object.keys(ROUTES));

/**
 * Resolve one use-case to a concrete model string.
 *   • explicit `pin` (env FREELLMAPI_*_MODEL / opts.model) ALWAYS wins;
 *   • otherwise `ctx` drives the table's `pick`, falling back to the
 *     route's declared default;
 *   • unknown route key → the profile's default model (honest fallback).
 * @returns {{ model: string, route: string, reason: string, pin: string|null }}
 */
export function resolveRouteModel(routeId, ctx = {}, { pin = null } = {}) {
  if (pin && String(pin).trim()) {
    return { model: String(pin).trim(), route: routeId, reason: 'operator pin (env/opts.model) beats the strategy table', pin: String(pin).trim() };
  }
  const row = ROUTE_TABLE.find(r => r.id === routeId);
  if (!row) {
    // Unknown use-case → the profile's default seat. Never throw, never
    // claim a smart model for an unlisted lane (honest fallback).
    return { model: AI_PROFILE_MODELS?.[_profile()] || FREELLMAPI_MODELS.smart, route: routeId || 'default', reason: 'unknown route — profile default seat', pin: null };
  }
  let key = row.pick(ctx, _profile());
  if (typeof key !== 'string' || !_ROUTE_KEYS.has(key)) key = row.route;
  return { model: ROUTES[key](), route: key, reason: row.why, pin: null };
}

/**
 * The MTF warm-guard seat's model (the bounded fire-and-forget lane).
 * Delegates to the table so the "reliable, not fast" upgrade stays in
 * ONE place.
 */
export function guardSeatModel() {
  return resolveRouteModel('mtf-ai-guard', {}).model;
}

/**
 * Per-symbol DECISIONS ROUTING view — what the Signal Recheck panel shows:
 * which route a specific symbol's trade/entry decision rides right now,
 * and why. PURE (no I/O) — the caller supplies the live score.
 * @returns {{ route, model, useCase, reason, symbol, side, score, deep: boolean }}
 */
export function getDecisionRoute({ symbol, side, score = null, deep = false, pin = null } = {}) {
  const ctx = { score, deep, symbol: String(symbol || '').toUpperCase() || null, side: String(side || '').toUpperCase() || null };
  const r = resolveRouteModel(deep ? 'deep-ensemble' : 'final-entry', ctx, { pin });
  return {
    ...r,
    symbol: ctx.symbol, side: ctx.side,
    score: Number.isFinite(Number(score)) ? Number(score) : null,
    deep: !!deep,
    useCase: deep ? 'DEEP ENSEMBLE / COUNCIL' : 'FINAL / SNIPER ENTRY DECISION',
  };
}

/** Live status view (the /api/ai/route-strategy endpoint's body). */
export function routeStrategyStatus() {
  return {
    ok: true,
    version: 'v21.36.5',
    profile: _profile(),
    defaultModel: AI_PROFILE_MODELS?.[_profile()] || FREELLMAPI_MODELS.smart,
    routes: {
      smartest: FREELLMAPI_MODELS.smart,
      balanced: FREELLMAPI_MODELS.balanced,
      fastest: FREELLMAPI_MODELS.fast,
      reliable: FREELLMAPI_MODELS.reliable,
      vision: FREELLMAPI_MODELS.vision,
    },
    // v21.36.5: the table shows the RESOLVED pick for the current profile,
    // not just the row's declared default — so "route" and "model" always
    // agree (a FAST profile's trade-signal lane honestly shows auto:fast).
    table: ROUTE_TABLE.map(r => {
      const res = resolveRouteModel(r.id, {}, {});
      return {
        id: r.id, useCase: r.useCase, desc: r.desc,
        route: res.route,
        defaultRoute: r.route,
        model: res.model,
        why: res.reason || r.why,
      };
    }),
  };
}

/** Test seam — drive the profile without env/files. */
export function __setAiModeForTests(mode) {
  _testAiMode = mode === undefined ? null : mode;
}
export function __resetAiModeForTests() {
  _testAiMode = null;
}
