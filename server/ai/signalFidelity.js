// ============================================================
// server/ai/signalFidelity.js — v21.37.0 [SIGNAL FIDELITY + LOSS-CHURN]
// ------------------------------------------------------------
// Two pure, deterministic guards built from the RESOLVED MTF ledger
// (2.8 days, 1480 resolved rows; 178 live-ish rows):
//
//   1. SIGNAL-FIDELITY GATE (pre-entry)
//      The live-ish sample showed that entries with the cleanest
//      multi-factor confirmation carried the edge:
//        • CHOP/TRANSITION regime .... 29% win, avgR -0.32, 65% stop-hit
//        • familyFit=would-block ..... 29% win, avgR -0.35, 65% stop-hit
//        • RSI 45-55 dead zone ....... 33% win, avgR -0.13
//        • overbought LONG (RSI>75) .. 0/10 win
//        • stable closed-bar signal .. 53% win vs 39% unstable
//      Hard vetoes: unfit regime, unfit family/regime fit, hierarchical
//      HTF veto, RSI exhaustion/dead-zone, reversal/trap hints. Soft
//      confirmations (stable bar, ADX floor, pullback reclaim, HTF
//      agreement) must meet a configurable minimum; with NO computable
//      soft evidence the gate FAILS OPEN (missing data ≠ bad data).
//
//   2. LOSS-CHURN LOCK (pre-entry, same symbol)
//      The book showed repeated same-price XAU/XAG entries within
//      minutes of a UC_FLIP_MINIMAL_LOSS_EXIT / EXCHANGE_POSITION_CLOSED
//      row, each with tiny peakR. A recent non-profit close now locks
//      the SAME side for a short cooldown; two non-profit closes inside
//      the window lock BOTH sides for a longer cooling period. Profitable
//      closes never lock. Manual rows are ignored. A confirmed opposite
//      flip is still allowed after a single loss (it is a reversal, not
//      churn) but never after the loss streak threshold.
//
// NOTHING here places/closes orders or reads files. Callers decide the
// mode (off / shadow / enforce) and scope (live / all).
// ============================================================

import { normalizeGuardMode, regimeOf } from './tradeGuards.js';

export const SIGNAL_FIDELITY_DEFAULTS = Object.freeze({
  mode: 'enforce',
  scope: 'live',
  blockRegimes: Object.freeze(['CHOP', 'TRANSITION']),
  adxFloor: 20,
  rsiLongMin: 55,
  rsiLongMax: 75,
  rsiShortMin: 25,
  rsiShortMax: 45,
  minSoftPoints: 1,
  allowMeanReversionChop: true,
});

export const LOSS_CHURN_DEFAULTS = Object.freeze({
  mode: 'enforce',
  scope: 'live',
  cooldownMin: 20,
  windowMin: 120,
  streak: 2,
  streakLockMin: 60,
  ignoreManual: true,
});

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function clamp(n, lo, hi, fallback) {
  const v = num(n);
  if (v == null) return fallback;
  return Math.min(hi, Math.max(lo, v));
}

function upper(v) {
  return String(v ?? '').trim().toUpperCase();
}

function symbolKey(v) {
  // Same canonicalisation as normalizeLinkSymbol/mtfDualBoard (pure copy —
  // importing mtfAutoLink here would create a cycle): FUT_/GLOB_ prefix,
  // B-XAU_USDT venue form, BTCUSDT concatenated quote, BTC-INR dashed quote.
  const s = String(v ?? '').trim().toUpperCase().replace(/^(FUT_|GLOB_)/, '').replace(/^B-/, '');
  const m = s.match(/^([A-Z0-9]{2,10}?)(USDT|USDC|INR|USD)$/);
  if (m && m[1].length >= 2) return m[1];
  return s.replace(/[-_.](USDT|USDC|INR|USD|PERP)$/, '');
}

/** First finite RSI from the row (board trigger first, then feature vector). */
export function rsiOf(row = {}) {
  for (const v of [row?.trigger?.rsi, row?.featureVector?.trig?.rsi, row?.context?.rsi]) {
    const n = num(v);
    if (n != null) return n;
  }
  return null;
}

/** First finite ADX from the row (board context first). */
export function adxOf(row = {}) {
  for (const v of [row?.context?.adx, row?.featureVector?.ctx?.adx]) {
    const n = num(v);
    if (n != null) return n;
  }
  return null;
}

/** Closed-bar stability: true / false / null (unknown). */
export function stabilityOf(row = {}) {
  for (const v of [row?.barConfirmation?.stable, row?.signalStability?.stable, row?.signalStable]) {
    if (typeof v === 'boolean') return v;
  }
  return null;
}

/** Classify the side-relative RSI zone. */
export function rsiZoneOf(side, rsi) {
  const v = num(rsi);
  if (v == null) return { zone: 'na', aligned: null, exhausted: null };
  const s = upper(side);
  if (s === 'LONG') {
    if (v > 75) return { zone: 'overbought', aligned: false, exhausted: true };
    if (v < 55) return { zone: 'dead-zone', aligned: false, exhausted: false };
    return { zone: v > 70 ? 'strong' : 'aligned', aligned: true, exhausted: false };
  }
  if (s === 'SHORT') {
    if (v < 25) return { zone: 'oversold', aligned: false, exhausted: true };
    if (v > 45) return { zone: 'dead-zone', aligned: false, exhausted: false };
    return { zone: v < 30 ? 'strong' : 'aligned', aligned: true, exhausted: false };
  }
  return { zone: 'na', aligned: null, exhausted: null };
}

/**
 * Pure signal-fidelity evaluation.
 *
 * @returns {{
 *   filter: 'signalFidelity', mode: string, active: boolean,
 *   side: string|null, regime: string, family: string|null,
 *   rsi: number|null, adx: number|null, stable: boolean|null,
 *   softPoints: number, availableSoft: number, minSoftPoints: number,
 *   hardReasons: string[], reasons: string[],
 *   wouldBlock: boolean, blocked: boolean, shadow: boolean,
 *   qualityScore: number, evidence: object
 * }}
 */
export function evaluateSignalFidelity({
  row = {}, side = null, mode = 'enforce',
  familyFit = null, hierarchicalMtf = null,
  cfg = {}, meanRevEnabled = false,
} = {}) {
  const m = normalizeGuardMode(mode, 'enforce');
  const s = upper(side ?? row?.side);
  const regime = regimeOf(row);
  const family = familyFit?.family ?? row?.family ?? null;
  const meanRev = upper(family) === 'MEAN_REVERSION';
  const blockRegimes = Array.isArray(cfg?.signalFidelityBlockRegimes)
    ? cfg.signalFidelityBlockRegimes.map(upper)
    : [...SIGNAL_FIDELITY_DEFAULTS.blockRegimes];
  const adxFloor = clamp(cfg?.signalFidelityAdxFloor, 0, 60, SIGNAL_FIDELITY_DEFAULTS.adxFloor);
  const rsiLongMin = clamp(cfg?.signalFidelityRsiLongMin, 0, 100, SIGNAL_FIDELITY_DEFAULTS.rsiLongMin);
  const rsiLongMax = clamp(cfg?.signalFidelityRsiLongMax, 0, 100, SIGNAL_FIDELITY_DEFAULTS.rsiLongMax);
  const rsiShortMin = clamp(cfg?.signalFidelityRsiShortMin, 0, 100, SIGNAL_FIDELITY_DEFAULTS.rsiShortMin);
  const rsiShortMax = clamp(cfg?.signalFidelityRsiShortMax, 0, 100, SIGNAL_FIDELITY_DEFAULTS.rsiShortMax);
  const minSoft = clamp(cfg?.signalFidelityMinSoft, 0, 8, SIGNAL_FIDELITY_DEFAULTS.minSoftPoints);
  const allowMeanRevChop = (cfg?.signalFidelityAllowMeanReversionChop ?? SIGNAL_FIDELITY_DEFAULTS.allowMeanReversionChop) !== false;

  const rsi = rsiOf(row);
  const adx = adxOf(row);
  const stable = stabilityOf(row);
  const pullbackReclaim = typeof row?.trigger?.pullbackReclaim === 'boolean'
    ? row.trigger.pullbackReclaim
    : null;
  const htfAgreement = num(hierarchicalMtf?.agreement);
  const htfAvailable = Array.isArray(hierarchicalMtf?.layers)
    ? hierarchicalMtf.layers.some(l => upper(l?.layer) === 'HTF' && l?.available === true)
    : false;

  const hardReasons = [];
  if (s !== 'LONG' && s !== 'SHORT') {
    hardReasons.push('direction unresolved — LONG/SHORT required');
  }

  // Regime: the exact ledger failure modes. MEAN_REVERSION is the only
  // family explicitly designed for CHOP (flag-gated); every other family
  // must trade with the trend or in a squeeze.
  if (blockRegimes.includes(regime)) {
    const meanRevChopOk = allowMeanRevChop
      && meanRev
      && meanRevEnabled === true
      && regime === 'CHOP'
      && familyFit?.wouldBlock !== true;
    if (!meanRevChopOk) {
      hardReasons.push(`${regime} regime — no directional follow-through`);
    }
  }

  // Family/regime fit already encodes valid + forbidden regimes and the
  // family's score floor. A would-block verdict was the single worst
  // bucket in the live-ish ledger (29% win, -0.35R avg).
  if (familyFit && familyFit.wouldBlock === true) {
    hardReasons.push(`family ${familyFit.family || '?'} unfit for ${regime}${familyFit.reason ? ` — ${familyFit.reason}` : ''}`);
  }
  if (hierarchicalMtf && hierarchicalMtf.wouldBlock === true) {
    hardReasons.push(`hierarchical HTF veto${hierarchicalMtf.reason ? ` — ${hierarchicalMtf.reason}` : ''}`);
  }

  // RSI momentum alignment. Missing RSI fails open; a computable dead
  // zone / exhaustion is a hard veto (0/10 overbought LONG wins).
  if (rsi != null) {
    if (s === 'LONG') {
      if (rsi > rsiLongMax) hardReasons.push(`overbought LONG (RSI ${rsi.toFixed(1)} > ${rsiLongMax}) — exhaustion risk`);
      else if (rsi < rsiLongMin) hardReasons.push(`LONG momentum dead zone (RSI ${rsi.toFixed(1)} < ${rsiLongMin}) — no follow-through`);
    } else if (s === 'SHORT') {
      if (rsi < rsiShortMin) hardReasons.push(`oversold SHORT (RSI ${rsi.toFixed(1)} < ${rsiShortMin}) — exhaustion risk`);
      else if (rsi > rsiShortMax) hardReasons.push(`SHORT momentum dead zone (RSI ${rsi.toFixed(1)} > ${rsiShortMax}) — no follow-through`);
    }
  }

  // Defence-in-depth: the generic lane already filters these, but a
  // reconstructed/cached row (or the flip-reverse lane) must never slip
  // an opposing/exhausted wave into a new position.
  if (row?.trigger?.overextended === true) hardReasons.push('trigger overextended — late wave');
  if (row?.trigger?.postPeakTrap === true) hardReasons.push('trigger post-peak trap');
  if (row?.trigger?.reversalRisk === true) hardReasons.push('trigger reversal risk');
  if (row?.trigger?.opposingFlow === true) hardReasons.push('trigger opposing flow');
  if (row?.context?.exhausted === true) hardReasons.push('context exhausted');
  if (row?.trapVeto === true) hardReasons.push('trap veto');
  if (row?.zoneWallVeto === true) hardReasons.push('zone-wall veto');
  if (row?.boardSideConflict === true) hardReasons.push('board side conflict');

  // Soft evidence: each is a genuine confirmation, never fabricated.
  const soft = [
    { key: 'stable', available: stable != null, ok: stable === true },
    { key: 'adx', available: adx != null, ok: adx != null && adx >= adxFloor },
    { key: 'pullbackReclaim', available: pullbackReclaim != null, ok: pullbackReclaim === true },
    { key: 'htfAgreement', available: htfAvailable && htfAgreement != null, ok: htfAgreement != null && htfAgreement >= 0.66 },
  ];
  const availableSoft = soft.filter(x => x.available).length;
  const softPoints = soft.filter(x => x.available && x.ok).length;
  const softOk = availableSoft === 0 ? true : softPoints >= minSoft;
  const reasons = [...hardReasons];
  if (!softOk) {
    const failed = soft.filter(x => x.available && !x.ok).map(x => x.key);
    reasons.push(`only ${softPoints}/${availableSoft} soft confirmations (need ${minSoft})${failed.length ? ` — missing ${failed.join(', ')}` : ''}`);
  }

  const wouldBlock = reasons.length > 0;
  const qualityScore = hardReasons.length > 0
    ? 0
    : Math.round(45 + (availableSoft > 0 ? (softPoints / availableSoft) * 45 : 20) + (stable === true ? 10 : 0));

  return {
    filter: 'signalFidelity', mode: m, active: m !== 'off',
    side: s === 'LONG' || s === 'SHORT' ? s : null,
    regime, family,
    rsi, adx, stable, pullbackReclaim,
    softPoints, availableSoft, minSoftPoints: minSoft,
    hardReasons, reasons,
    reason: wouldBlock ? (reasons[0] || 'signal-fidelity') : null,
    wouldBlock, blocked: m === 'enforce' && wouldBlock,
    shadow: m === 'shadow',
    qualityScore: Math.max(0, Math.min(100, qualityScore)),
    evidence: Object.fromEntries(soft.map(x => [x.key, { available: x.available, ok: x.ok }])),
  };
}

/**
 * Classify a closed book row as profit / loss / neutral / unknown.
 * Honest fallback: a missing P&L is only called a loss when the row's peak
 * excursion stayed below 0.50R (the tiny-peak churn signature); a clear
 * excursion (peak >= 0.50R with a non-negative current R) is a profit. An
 * ambiguous null-P&L row is left UNKNOWN so it cannot arm a churn lock.
 */
export function classifyCloseOutcome(row = {}) {
  const pnl = num(row?.pnl);
  if (pnl != null) return pnl > 0 ? 'profit' : (pnl < 0 ? 'loss' : 'neutral');
  const reason = upper(row?.closeReason);
  if (/TP1|TP2|TARGET_HIT|PROFIT|BOOKED|RUNNER|TRAILED_SL_PROFIT/.test(reason)) return 'profit';
  if (/LOSS|STOP|SL_HIT|FLIP|REVERSAL|STALL|TIME_STOP|ADVERSE|INVALID|EXPIRED/.test(reason)) return 'loss';
  if (reason === 'MANUAL') return 'unknown';
  if (reason === 'EXCHANGE_POSITION_CLOSED' || reason === 'PAPER_ENGINE_CLOSED' || reason === '') {
    const peak = num(row?.peakR);
    const current = num(row?.currentR);
    if (peak != null && peak >= 0.50 && (current == null || current >= 0.15)) return 'profit';
    if (peak != null && peak < 0.50) return 'loss';
  }
  return 'unknown';
}

export function isNonProfitClose(row = {}) {
  const c = classifyCloseOutcome(row);
  return c === 'loss' || c === 'neutral';
}

/**
 * Pure per-symbol loss-churn lock.
 *
 * @returns {{
 *   filter: 'lossChurnLock', mode: string, active: boolean,
 *   symbol: string, side: string|null,
 *   wouldLock: boolean, locked: boolean,
 *   reason: string|null, until: number|null,
 *   lossStreak: number, recentLosses: number,
 *   lastLossAt: number|null, lastLossSide: string|null, lastCloseReason: string|null,
 *   singleSideLock: boolean, streakLock: boolean
 * }}
 */
export function evaluateLossChurnLock({
  symbol = '', side = null, closedRows = [], now = Date.now(),
  mode = 'enforce', cfg = {}, flipConfirmed = false,
} = {}) {
  const m = normalizeGuardMode(mode, 'enforce');
  const sym = symbolKey(symbol);
  const s = upper(side);
  const cooldownMin = clamp(cfg?.lossChurnCooldownMin, 0, 1440, LOSS_CHURN_DEFAULTS.cooldownMin);
  const windowMin = clamp(cfg?.lossChurnWindowMin, 1, 10080, LOSS_CHURN_DEFAULTS.windowMin);
  const streakThreshold = Math.max(1, Math.round(clamp(cfg?.lossChurnStreak, 1, 20, LOSS_CHURN_DEFAULTS.streak)));
  const streakLockMin = clamp(cfg?.lossChurnStreakLockMin, 0, 10080, LOSS_CHURN_DEFAULTS.streakLockMin);
  const ignoreManual = (cfg?.lossChurnIgnoreManual ?? LOSS_CHURN_DEFAULTS.ignoreManual) !== false;
  const windowMs = windowMin * 60_000;
  const cooldownMs = cooldownMin * 60_000;
  const streakLockMs = streakLockMin * 60_000;

  const rows = (Array.isArray(closedRows) ? closedRows : [])
    .filter(b => b && upper(b.status) === 'CLOSED' && num(b.closedAt) != null && num(b.closedAt) <= now + 1000)
    .filter(b => symbolKey(b.symbol) === sym)
    .filter(b => !(ignoreManual && (upper(b.openedBy) === 'MANUAL' || upper(b.closeReason) === 'MANUAL')))
    .sort((a, b) => num(b.closedAt) - num(a.closedAt));

  const recent = rows.filter(b => now - num(b.closedAt) <= windowMs);
  const losses = recent.filter(isNonProfitClose);

  // Single-loss same-side cooldown: the exact churn signature (re-enter
  // the same side minutes after a minimal-loss/flip close).
  const sameSideLoss = losses.find(b => upper(b.side) === s) || null;
  const singleSideLock = Boolean(sameSideLoss && cooldownMs > 0 && now - num(sameSideLoss.closedAt) < cooldownMs);
  const singleUntil = sameSideLoss ? num(sameSideLoss.closedAt) + cooldownMs : null;

  // Consecutive non-profit closes: a profit resets the streak; neutral /
  // unknown rows are skipped (they carry no honest outcome evidence).
  let lossStreak = 0;
  let lastLoss = null;
  for (const b of recent) {
    const outcome = classifyCloseOutcome(b);
    if (outcome === 'profit') break;
    if (outcome === 'loss' || outcome === 'neutral') {
      lossStreak += 1;
      lastLoss = lastLoss || b;
    }
  }
  const streakLock = Boolean(
    streakLockMs > 0
    && lossStreak >= streakThreshold
    && lastLoss
    && now - num(lastLoss.closedAt) < streakLockMs,
  );
  const streakUntil = lastLoss ? num(lastLoss.closedAt) + streakLockMs : null;

  const reason = streakLock
    ? `${lossStreak} non-profit closes within ${windowMin}m — both sides cooling down (${Math.max(0, Math.ceil((streakUntil - now) / 60_000))}m left)`
    : singleSideLock
      ? `${s} re-entry after ${upper(sameSideLoss?.closeReason) || 'non-profit'} close — same-side lock (${Math.max(0, Math.ceil((singleUntil - now) / 60_000))}m left)`
      : null;

  const wouldLock = Boolean(streakLock || (singleSideLock && flipConfirmed !== true));
  return {
    filter: 'lossChurnLock', mode: m, active: m !== 'off',
    symbol: sym, side: s === 'LONG' || s === 'SHORT' ? s : null,
    wouldLock, locked: m === 'enforce' && wouldLock,
    reason: wouldLock ? reason : null,
    until: streakLock ? streakUntil : (singleSideLock ? singleUntil : null),
    lossStreak, recentLosses: losses.length,
    lastLossAt: lastLoss ? num(lastLoss.closedAt) : null,
    lastLossSide: lastLoss ? upper(lastLoss.side) : null,
    lastCloseReason: lastLoss ? (lastLoss.closeReason ?? null) : null,
    singleSideLock, streakLock,
    cooldownMin, windowMin, streakThreshold, streakLockMin,
  };
}
