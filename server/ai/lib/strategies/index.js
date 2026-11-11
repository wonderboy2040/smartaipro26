// ============================================================
// server/ai/lib/strategies/index.js — the 25-strategy classic engine
// ------------------------------------------------------------
// THE IDEA: the site already had TrendMatrix/MomentumQuant/SMC seats,
// but a single "trend model" hides WHICH classic setup is actually in
// play. This engine evaluates all 25 playbook strategies independently
// (pure functions, oldest-first candles), then aggregates them into ONE
// regime-weighted consensus that MTF/ensemble/FreeLLMAPI can consume.
//
// Families (25 total — v21.36.4 dedup from 29):
//   trend (7) · breakout (4) · momentum (6) · meanReversion (3) ·
//   smartMoney/ICT (5)
//
// v21.36.4 DEDUP + UPGRADE (user: "duplicate strategy na ho; top
// strategies upgrade karo"):
//   • triple_ema_8_21_55 — REMOVED (pure subset of the EMA9/21 stack
//     read; its EMA55 confirmation now a bonus INSIDE ema_cross_9_21)
//   • keltner_ema20_atr10_2 — REMOVED (same channel-break detector as
//     the Bollinger band-break; double headcount on one signal)
//   • williams_r_14 — REMOVED (same 14-bar range oscillator family as
//     Stochastic; its fresh-range-exit read folded into stochastic_14_3_3)
//   • zscore_50_2_0 — REMOVED (position-only knife-catch fade; its 50-bar
//     2σ read now a confirmation bonus inside vwap_reversion_48_2)
//   Upgrades shipped with the dedup: EMA Cross ATR-separation chop gate,
//   Supertrend weak-tape gate, ADX late-wave decay, BB-squeeze volume
//   confirmation, Stochastic fresh-range-exit bonus, VWAP z-score bonus.
//
// Honesty rules:
//   • insufficient data → evaluator returns null → excluded from the
//     denominator (never a fabricated neutral vote)
//   • dir 0 = evaluated but no setup → counted in readyCount only
//   • family-first aggregation: a family with 8 strategies cannot
//     outvote a family with 4 just by headcount
// ============================================================
import { adx, atrPercentile, efficiencyRatio } from '../indicators.js';
import { ensureAscending } from '../candles.js';
import { TREND_STRATEGIES } from './trend.js';
import { BREAKOUT_STRATEGIES } from './breakout.js';
import { MOMENTUM_STRATEGIES } from './momentum.js';
import { MEAN_REVERSION_STRATEGIES } from './meanReversion.js';
import { SMART_MONEY_STRATEGIES } from './smartMoney.js';

export const STRATEGY_REGISTRY = Object.freeze([
  ...TREND_STRATEGIES,
  ...BREAKOUT_STRATEGIES,
  ...MOMENTUM_STRATEGIES,
  ...MEAN_REVERSION_STRATEGIES,
  ...SMART_MONEY_STRATEGIES,
]);

export const STRATEGY_COUNT = STRATEGY_REGISTRY.length;

export const STRATEGY_FAMILIES = Object.freeze([
  'trend', 'breakout', 'momentum', 'meanReversion', 'smartMoney',
]);

export const FAMILY_LABELS = Object.freeze({
  trend: 'Trend',
  breakout: 'Breakout',
  momentum: 'Momentum',
  meanReversion: 'Mean Reversion',
  smartMoney: 'Smart Money / ICT',
});

// Regime → family emphasis. Trend tape rewards trend/breakout; chop
// rewards mean reversion and fades breakout head-fakes; high-vol tape
// rewards breakout/momentum but punishes catching falling knives.
const FAMILY_WEIGHTS = Object.freeze({
  trend: { trend: 1.25, breakout: 1.05, momentum: 1.0, meanReversion: 0.5, smartMoney: 0.9 },
  range: { trend: 0.6, breakout: 0.75, momentum: 0.9, meanReversion: 1.3, smartMoney: 1.0 },
  volatile: { trend: 0.85, breakout: 1.2, momentum: 1.1, meanReversion: 0.6, smartMoney: 1.05 },
  mixed: { trend: 1.0, breakout: 1.0, momentum: 1.0, meanReversion: 0.9, smartMoney: 1.0 },
});

const round2 = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 100) / 100 : null);

export function classifyStrategyRegime(candles) {
  const closes = candles.map(c => c.close);
  const a = adx(candles, 14);
  const er = efficiencyRatio(closes, 20);
  const adxVal = a?.adx ?? null;
  const erVal = er ?? null;
  // Fast path: strong trend / clear chop needs no ATR percentile scan.
  if (adxVal != null && adxVal >= 25 && erVal != null && erVal >= 0.3) {
    return { regime: 'trend', adx: adxVal, efficiency: erVal, atrPercentile: null };
  }
  if (adxVal != null && adxVal < 20 && erVal != null && erVal < 0.25) {
    return { regime: 'range', adx: adxVal, efficiency: erVal, atrPercentile: null };
  }
  const atrVal = atrPercentile(candles) ?? null;
  let regime = 'mixed';
  if (atrVal != null && atrVal >= 75) regime = 'volatile';
  return { regime, adx: adxVal, efficiency: erVal, atrPercentile: atrVal };
}

/**
 * Evaluate all 25 strategies and build the regime-weighted consensus.
 *
 * @param {Array} candlesIn oldest-first OHLCV candles
 * @param {object} [opts]
 * @param {'LONG'|'SHORT'|null} [opts.side] plan side to grade CONFIRM/CONFLICT
 * @param {string} [opts.market]
 * @param {string} [opts.modeId]
 * @returns {object} consensus snapshot (never throws)
 */
export function evaluateStrategies(candlesIn, opts = {}) {
  const candles = ensureAscending(Array.isArray(candlesIn) ? candlesIn : []);
  if (!Array.isArray(candles) || candles.length < 30) {
    return {
      ok: false,
      reason: `insufficient candles (${candles?.length || 0}/30)`,
      votes: [], readyCount: 0, totalStrategies: STRATEGY_COUNT,
      side: null, dir: 0, confidence: 0, agreement: 0,
      regime: null, families: {}, votesFor: 0, votesAgainst: 0, neutral: 0,
      topDrivers: [], dissent: [], fit: 'NEUTRAL',
    };
  }

  const meta = classifyStrategyRegime(candles);
  const votes = [];
  for (const s of STRATEGY_REGISTRY) {
    try {
      const v = s.fn(candles);
      if (!v || v.ready !== true) continue;
      votes.push({
        ...v,
        id: v.id || s.id,
        name: v.name || s.name,
        family: v.family || s.family,
      });
    } catch {
      // A single bad evaluator must never take the board down.
    }
  }

  const readyCount = votes.length;
  if (readyCount === 0) {
    return {
      ok: false, reason: 'no strategy had enough data',
      votes: [], readyCount: 0, totalStrategies: STRATEGY_COUNT,
      side: null, dir: 0, confidence: 0, agreement: 0,
      regime: meta, families: {}, votesFor: 0, votesAgainst: 0, neutral: 0,
      topDrivers: [], dissent: [], fit: 'NEUTRAL',
    };
  }

  const weights = FAMILY_WEIGHTS[meta.regime] || FAMILY_WEIGHTS.mixed;
  const families = {};
  let weightedNet = 0, weightSum = 0;
  for (const fam of STRATEGY_FAMILIES) {
    const famVotes = votes.filter(v => v.family === fam && v.dir !== 0);
    if (famVotes.length === 0) {
      families[fam] = { dir: 0, net: 0, votes: 0, dedicated: votes.filter(v => v.family === fam).length, forSide: 0, against: 0 };
      continue;
    }
    const signed = famVotes.reduce((a, v) => a + v.dir * v.strength, 0);
    const abs = famVotes.reduce((a, v) => a + v.strength, 0) || 1;
    const net = signed / abs;
    const fw = weights[fam] || 1;
    weightedNet += net * fw;
    weightSum += fw;
    families[fam] = {
      dir: net > 0.2 ? 1 : net < -0.2 ? -1 : 0,
      net: round2(net),
      votes: famVotes.length,
      dedicated: votes.filter(v => v.family === fam).length,
      strength: round2(abs / famVotes.length),
      weight: fw,
    };
  }

  const net = weightSum > 0 ? weightedNet / weightSum : 0;
  const directional = votes.filter(v => v.dir !== 0);
  const bullStrength = directional.filter(v => v.dir === 1).reduce((a, v) => a + v.strength, 0);
  const bearStrength = directional.filter(v => v.dir === -1).reduce((a, v) => a + v.strength, 0);
  const directionalStrength = bullStrength + bearStrength;
  const winningStrength = Math.max(bullStrength, bearStrength);
  const agreement = directionalStrength > 0 ? winningStrength / directionalStrength : 0;

  const side = net > 0.12 && directional.length >= 3 ? 'LONG'
    : net < -0.12 && directional.length >= 3 ? 'SHORT'
      : null;
  const dir = side === 'LONG' ? 1 : side === 'SHORT' ? -1 : 0;
  const confidence = side
    ? Math.round(Math.min(100, Math.max(0, Math.abs(net) * 70 + agreement * 30)))
    : 0;

  const votesFor = side ? votes.filter(v => v.dir === dir).length : 0;
  const votesAgainst = side ? votes.filter(v => v.dir === -dir).length : 0;
  const neutral = votes.filter(v => v.dir === 0).length;

  const aligned = side ? votes.filter(v => v.dir === dir).sort((a, b) => b.strength - a.strength) : [];
  const opposing = side ? votes.filter(v => v.dir === -dir).sort((a, b) => b.strength - a.strength) : [];
  const topDrivers = aligned.slice(0, 5).map(v => ({
    id: v.id, name: v.name, family: v.family,
    strength: round2(v.strength), reason: v.reasons?.[0] || '',
  }));
  const dissent = opposing.slice(0, 4).map(v => ({
    id: v.id, name: v.name, family: v.family,
    strength: round2(v.strength), reason: v.reasons?.[0] || '',
  }));

  const planSide = String(opts.side || '').toUpperCase();
  let fit = 'NEUTRAL';
  if (side && (planSide === 'LONG' || planSide === 'SHORT')) {
    fit = side === planSide ? 'CONFIRM' : 'CONFLICT';
  }

  return {
    ok: true,
    asOf: Date.now(),
    bars: candles.length,
    totalStrategies: STRATEGY_COUNT,
    readyCount,
    votes,
    side,
    dir,
    net: round2(net),
    confidence,
    agreement: round2(agreement),
    regime: meta,
    families,
    votesFor,
    votesAgainst,
    neutral,
    topDrivers,
    dissent,
    fit,
    planSide: planSide || null,
  };
}

/**
 * Position-size of the consensus for a caller-declared side.
 * Positive = confirmation bonus, negative = conflict penalty.
 * Bounded ±8 so one layer can never dominate the fuse.
 */
export function strategyFitScore(consensus, side) {
  if (!consensus?.ok || !consensus.side) return 0;
  const s = String(side || '').toUpperCase();
  if (s !== 'LONG' && s !== 'SHORT') return 0;
  const conf = Number(consensus.confidence) || 0;
  if (consensus.side === s) {
    if (conf >= 75) return 5;
    if (conf >= 60) return 3;
    if (conf >= 45) return 1;
    return 0;
  }
  if (conf >= 75) return -8;
  if (conf >= 60) return -5;
  if (conf >= 45) return -2;
  return 0;
}

/** Compact row shape — what MTF rows/UI/prompts actually need. */
export function compactStrategyConsensus(consensus) {
  if (!consensus?.ok) return null;
  return {
    side: consensus.side,
    dir: consensus.dir,
    confidence: consensus.confidence,
    agreement: consensus.agreement,
    net: consensus.net,
    regime: consensus.regime?.regime || null,
    ready: consensus.readyCount,
    total: consensus.totalStrategies,
    votesFor: consensus.votesFor,
    votesAgainst: consensus.votesAgainst,
    neutral: consensus.neutral,
    fit: consensus.fit,
    families: consensus.families,
    top: consensus.topDrivers,
    dissent: consensus.dissent,
  };
}

/**
 * Ensemble seat adapter (models.js registry). `ctx` is the standard
 * signals context; candles may be absent in pass-1 (honest `na`).
 */
export function classicStrategyVote(ctx) {
  const candles = Array.isArray(ctx) ? ctx : ctx?.candles;
  if (!Array.isArray(candles) || candles.length < 40) {
    return { dir: 0, conf: 0, na: true, reasons: [`${STRATEGY_COUNT}-strategy engine: candles unavailable (structural abstain)`] };
  }
  try {
    const cons = evaluateStrategies(candles, {
      side: Array.isArray(ctx) ? null : ctx?.side,
      market: Array.isArray(ctx) ? null : ctx?.market,
      modeId: Array.isArray(ctx) ? null : ctx?.modeId,
    });
    if (!cons.ok || !cons.side) {
      return {
        dir: 0, conf: 0,
        reasons: [`${STRATEGY_COUNT}-strategy engine: no consensus (${cons.readyCount || 0}/${STRATEGY_COUNT} ready, regime ${cons.regime?.regime || 'n/a'})`],
        strategyConsensus: cons.ok ? compactStrategyConsensus(cons) : null,
      };
    }
    // v21.36.0 ACCURACY GUARD: a grouped seat must not dilute a committee
    // it barely believes in. Sub-45% consensus (the CONFIRM/penalty floor)
    // is a WEAK read — structural abstain so 1 low-conviction vote cannot
    // shave a legitimate 80+ grade down a notch. The compact consensus is
    // still attached for UI/prompt transparency.
    if (cons.confidence < 45) {
      return {
        dir: 0, conf: 0, na: true,
        reasons: [`${STRATEGY_COUNT}-strategy engine: low-conviction ${cons.side} ${cons.confidence}% (regime ${cons.regime?.regime || 'n/a'}) — structural abstain`],
        strategyConsensus: compactStrategyConsensus(cons),
      };
    }
    return {
      dir: cons.dir,
      conf: cons.confidence,
      reasons: cons.topDrivers.slice(0, 2).map(d => `${d.name}: ${d.reason}`),
      ...(cons.votesAgainst > 0 ? { dissent: cons.dissent.map(d => d.name) } : {}),
      strategyConsensus: compactStrategyConsensus(cons),
    };
  } catch (e) {
    return { dir: 0, conf: 0, na: true, reasons: [`${STRATEGY_COUNT}-strategy engine error: ${e?.message || 'unknown'}`] };
  }
}
