// ============================================================
// test/routeStrategyV21365.test.ts — v21.36.5 ROUTE STRATEGY
// ------------------------------------------------------------
// USER SPEC: "Jab site load hota hai / trade signal pe / final
// (sniper) entry me / deep ensemble me — kaunsi FreeLLMAPI route
// (smartest / fastest / balanced) use karni hai? Aur Decisions
// routing bhi add karo."
//
// This file LOCKS the route-strategy table (server/ai/routeStrategy.js):
//   • SITE LOAD          → auto:balanced   (fastest route that still
//                                            proves the router)
//   • MTF warm guard     → auto:balanced   (fastest strict-JSON route;
//                                            auto:fast is prose-prone)
//   • TRADE SIGNAL       → profile baseline (smart→smart, balanced→
//                          balanced, fast→fast), escalated to smartest
//                          for deep / multi-symbol / high-conviction debate
//   • FINAL SNIPER ENTRY → auto:smart (the money moment), with one
//                          honest downgrade: low-conviction row under a
//                          FAST profile → auto:reliable
//   • DEEP ENSEMBLE      → auto:smart (depth beats latency)
// Plus the DECISIONS routing view (getDecisionRoute) and the operator
// pin contract (env FREELLMAPI_*_MODEL / opts.model always win).
// ============================================================
import { describe, it, expect, beforeEach } from 'vitest';
import {
  ROUTE_TABLE, ROUTES,
  resolveRouteModel, guardSeatModel, getDecisionRoute, routeStrategyStatus,
  __setAiModeForTests, __resetAiModeForTests,
} from '../server/ai/routeStrategy.js';

beforeEach(() => { __resetAiModeForTests(); });

describe('v21.36.5 route-strategy table (which route, when)', () => {
  it('registers exactly the five user use-cases', () => {
    const ids = ROUTE_TABLE.map(r => r.id);
    expect(ids).toEqual(['site-load', 'mtf-ai-guard', 'trade-signal', 'final-entry', 'deep-ensemble']);
  });

  it('SITE LOAD rides the FASTEST route that still proves the router (balanced, never a smart-seat boot probe)', () => {
    for (const prof of ['smart', 'balanced', 'fast']) {
      __setAiModeForTests(prof);
      const r = resolveRouteModel('site-load', {});
      expect(r.model).toBe('auto:balanced');
      expect(r.route).toBe('balanced');
    }
  });

  it('MTF warm guard = the FASTEST strict-JSON route (balanced), profile-independent', () => {
    for (const prof of ['smart', 'balanced', 'fast']) {
      __setAiModeForTests(prof);
      expect(guardSeatModel()).toBe('auto:balanced');
      expect(resolveRouteModel('mtf-ai-guard', {}).route).toBe('balanced');
    }
    // never the prose-prone auto:fast, never a smart burn on a throwaway verdict
    expect(guardSeatModel()).not.toBe('auto:fast');
    expect(guardSeatModel()).not.toBe('auto:smart');
  });

  it('TRADE SIGNAL baseline = the user profile (legacy contract)', () => {
    const cases: Array<[string, string]> = [
      ['smart', 'auto:smart'],
      ['balanced', 'auto:balanced'],
      ['fast', 'auto:fast'],
    ];
    for (const [prof, model] of cases) {
      __setAiModeForTests(prof as 'smart' | 'balanced' | 'fast');
      expect(resolveRouteModel('trade-signal', {}).model).toBe(model);
    }
  });

  it('TRADE SIGNAL escalates to SMARTEST for deep / multi-symbol / high-conviction debate — even under a FAST profile', () => {
    __setAiModeForTests('fast');
    expect(resolveRouteModel('trade-signal', { deep: true }).model).toBe('auto:smart');
    expect(resolveRouteModel('trade-signal', { multiSymbol: true }).model).toBe('auto:smart');
    expect(resolveRouteModel('trade-signal', { debate: true, score: 92 }).model).toBe('auto:smart');
    // a plain low-conviction single-symbol scan under FAST stays fast
    expect(resolveRouteModel('trade-signal', { score: 50 }).model).toBe('auto:fast');
  });

  it('FINAL / SNIPER ENTRY = SMARTEST by default (the money moment)', () => {
    for (const prof of ['smart', 'balanced']) {
      __setAiModeForTests(prof);
      expect(resolveRouteModel('final-entry', {}).model).toBe('auto:smart');
      expect(resolveRouteModel('final-entry', { score: 92 }).model).toBe('auto:smart');
    }
  });

  it('FINAL / SNIPER ENTRY honest downgrade: low-conviction row under FAST profile rides the reliable seat', () => {
    __setAiModeForTests('fast');
    expect(resolveRouteModel('final-entry', { score: 50 }).model).toBe('auto:reliable');
    // but the same low-conviction row under SMART/BALANCED still earns the smart seat
    __setAiModeForTests('balanced');
    expect(resolveRouteModel('final-entry', { score: 50 }).model).toBe('auto:smart');
  });

  it('DEEP ENSEMBLE = SMARTEST always (depth beats latency, profile-independent)', () => {
    for (const prof of ['smart', 'balanced', 'fast']) {
      __setAiModeForTests(prof);
      const r = resolveRouteModel('deep-ensemble', {});
      expect(r.model).toBe('auto:smart');
      expect(r.route).toBe('smartest');
    }
  });

  it('operator pin ALWAYS beats the table (env FREELLMAPI_*_MODEL / opts.model contract)', () => {
    __setAiModeForTests('fast');
    expect(resolveRouteModel('trade-signal', {}, { pin: 'mymodel' }).model).toBe('mymodel');
    expect(resolveRouteModel('deep-ensemble', {}, { pin: 'auto:reliable' }).model).toBe('auto:reliable');
    // empty pin = no override
    expect(resolveRouteModel('trade-signal', {}, { pin: '  ' }).model).toBe('auto:fast');
  });

  it('unknown use-case falls back to the profile default seat — never a fabricated smart claim', () => {
    __setAiModeForTests('fast');
    const r = resolveRouteModel('nope', {});
    expect(r.model).toBe('auto:fast');
    expect(r.route).toBe('nope');
    __setAiModeForTests('balanced');
    expect(resolveRouteModel('', {}).model).toBe('auto:balanced');
  });

  it('route labels resolve to the four documented virtual routes', () => {
    expect(ROUTES.smartest()).toBe('auto:smart');
    expect(ROUTES.balanced()).toBe('auto:balanced');
    expect(ROUTES.fastest()).toBe('auto:fast');
    expect(ROUTES.reliable()).toBe('auto:reliable');
  });
});

describe('v21.36.5 DECISIONS routing view (the per-symbol route the UI shows)', () => {
  it('resolves a symbol trade decision to the lane model + reason', () => {
    __setAiModeForTests('smart');
    const d = getDecisionRoute({ symbol: 'btc', side: 'short', score: 92 });
    expect(d.symbol).toBe('BTC');
    expect(d.side).toBe('SHORT');
    expect(d.useCase).toBe('FINAL / SNIPER ENTRY DECISION');
    expect(d.model).toBe('auto:smart');
    expect(d.deep).toBe(false);
    expect(typeof d.reason).toBe('string');
  });

  it('deep=true routes the decision to the DEEP ENSEMBLE lane', () => {
    __setAiModeForTests('fast');
    const d = getDecisionRoute({ symbol: 'SOL', score: 40, deep: true });
    expect(d.useCase).toBe('DEEP ENSEMBLE / COUNCIL');
    expect(d.deep).toBe(true);
    // deep lane = smartest even under a FAST profile
    expect(d.model).toBe('auto:smart');
  });

  it('score-aware: low score under FAST profile downgrades the entry lane', () => {
    __setAiModeForTests('fast');
    const low = getDecisionRoute({ symbol: 'XRP', score: 40 });
    const high = getDecisionRoute({ symbol: 'XRP', score: 92 });
    expect(low.model).toBe('auto:reliable');
    expect(high.model).toBe('auto:smart');
    expect(low.score).toBe(40);
  });

  it('routeStrategyStatus() exposes the full table + routes for the endpoint', () => {
    const st = routeStrategyStatus();
    expect(st.ok).toBe(true);
    expect(st.table).toHaveLength(5);
    for (const t of st.table) {
      expect(typeof t.useCase).toBe('string');
      expect(typeof t.model).toBe('string');
      expect(typeof t.why).toBe('string');
    }
    expect(st.routes.smartest).toBe('auto:smart');
    expect(st.routes.reliable).toBe('auto:reliable');
    // the guard lane's live pick is exposed on the table (balanced)
    expect(st.table.find(t => t.id === 'mtf-ai-guard')?.model).toBe('auto:balanced');
  });
});
