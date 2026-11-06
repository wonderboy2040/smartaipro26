// ============================================================
// server/ai/preTp1Trail.js — v21.31.0 PRE-TP1 NO-LOSS SMART SL TRAIL
// ------------------------------------------------------------
// USER SPEC (verbatim intent): "Auto Trade lagne par AI Agent activate ho —
// highest volatility me smartly SL trail ho; TP1 tak wait na karna pade;
// SL no loss only profit ke hisaab se aage badhe; direction/trend realtime
// live market se fetch hota rahe."
//
// WHAT THIS MODULE OWNS
//   • A deterministic, exchange-independent pre-TP1 stop proposal.
//   • Fee-breakeven + volatility buffer as the FLOOR. Once armed, the stop is
//     never allowed back below that floor by this module.
//   • Ratchet-only behaviour: a proposal can only improve the current stop
//     (higher for LONG, lower for SHORT). It never loosens risk.
//   • Volatility class (LOW/NORMAL/HIGH/EXTREME) + momentum scaling: higher
//     volatility needs more room, so arm/giveback/buffer all widen.
//   • Signed live tick trend is used ONLY to tighten (adverse trend). A
//     favourable trend never widens an already-locked stop.
//   • Never proposes a stop at/through LTP (that would be an instant fill).
//
// WHAT IT DOES NOT OWN
//   • No exchange calls, no book writes, no closing decisions.
//   • No profit guarantee. Before the arm threshold the initial SL remains the
//     protection; a leveraged futures position can still lose money.
// ============================================================

export const PRE_TP1_TRAIL_MODES = Object.freeze(['enforce', 'shadow', 'off']);

// Higher volatility = wider stop. armR is the favourable excursion required
// before the fee-protected floor is locked; givebackR is the distance kept
// behind the favourable peak; bufferR is the profit cushion above the exact
// fee-breakeven level.
export const PRE_TP1_VOL_PROFILE = Object.freeze({
  LOW: Object.freeze({ armR: 0.30, givebackR: 0.30, bufferR: 0.06 }),
  NORMAL: Object.freeze({ armR: 0.38, givebackR: 0.42, bufferR: 0.10 }),
  HIGH: Object.freeze({ armR: 0.50, givebackR: 0.60, bufferR: 0.16 }),
  EXTREME: Object.freeze({ armR: 0.65, givebackR: 0.80, bufferR: 0.22 }),
});

const MOMENTUM_FACTOR = Object.freeze({
  SURGING: 1.10,
  STEADY: 1.00,
  FADING: 0.80,
  UNKNOWN: 1.00,
});

const STRONG_ADVERSE_TREND_PCT = -0.02;

// v21.35.5 [SUPER-TRAIL UPGRADE] — user spec: "high volatality me bhi acha
// kaam kare, high profit BOOK ho, TP1/TP2 tak." Do deterministic gears, dono
// ratchet-only contract ke andar (candidate sirf profit-side tighten hota hai,
// kabhi loose nahi):
//
// 1. PROGRESSIVE PROFIT-LOCK — theek se ek choti aasan problem: HIGH/EXTREME
//    vol me givebackR (0.60-0.80R × momentum) itna wide hota hai ki 0.70R
//    peak pe SL sirf +0.28R par reh jata — pullback me 60%+ profit wapas
//    chala jaata tha. Ab peakR ke saath stepped profit-lock floor: jaise
//    jaise peak badega, wahi peak me se itna hi % lock hota jaayega.
//    Vol/momentum adjust the STEP THRESHOLD (nahi the lock % itself):
//      • HIGH/EXTREME → threshold late (bada pullback tolerance, whipsaw se
//        safe) but lock still compounds — "smooth" high-vol behaviour.
//      • SURGING → threshold late (runner ko space), FADING → early (book).
//
// 2. ULTRA-FAST ADVERSE GEAR — tick-trend -4% (strong reversal signature in
//    a 3s fast loop window) → giveback floor 0.10R: exit ki taraf se smart,
//    profit booking ko save karta hai bina noise par trigger huye (-2% gear
//    pehle se tha, -4% ab second gear hai).

/** [minPeakR, lockPct] steps — peak >= minPeakR (after vol/momentum shift)
 *  par peak-move ka lockPct × VOL_LOCK_SCALE × vol/momentum-gated lock hota
 *  hai. Monotone: higher step = higher %. */
const PROGRESSIVE_LOCK_STEPS = Object.freeze([
  Object.freeze({ minPeakR: 0.45, lockPct: 0.40 }),
  Object.freeze({ minPeakR: 0.70, lockPct: 0.55 }),
  Object.freeze({ minPeakR: 1.00, lockPct: 0.70 }),
  // v21.35.5 [RUNNER-LOCK]: runner TP1/TP2 ki taraf bade hi — 1.5R+ se 80%,
  // 2.0R+ se 85%, 3.0R+ se 90% lock. High-vol HIGH/EXTREME ke liye
  // LOCK_VOL_SCALE se smooth chhota (whipsaw-safe) par monotonically
  // compound hota jaata hai. "Jab tak TP1/TP2 na hojaye high profit book
  // ho" — exactly yahi step: badi trade me se kabhi pullback poori profit
  // kha na paye.
  Object.freeze({ minPeakR: 1.50, lockPct: 0.80 }),
  Object.freeze({ minPeakR: 2.00, lockPct: 0.85 }),
  Object.freeze({ minPeakR: 3.00, lockPct: 0.90 }),
]);
// LOCK KICK-IN shift by vol class: HIGH/EXTREME trail pehle se wide giveback
// rakhte hain (whipsaw-safe) — isliye inki lock THRESHOLD late (peak par jaake
// book hoti hai) + kam scale (kam % lock, runner ko jagah). LOW early +
// aggressive booking (chhoti moves me se bhi profit utha leta hai).
const LOCK_THRESHOLD_VOL_SHIFT = Object.freeze({ LOW: -0.10, NORMAL: 0, HIGH: 0.15, EXTREME: 0.30 });
/** Lock % ke upar volatile-class scale — "smooth" = high vol me kam lock,
 *  lekin trail (wide giveback) dominant rehta hai aur floor kabhi fee-breakeven
 *  se neeche nahi jaata. Ordering invariant: same peakR par
 *  NORMAL lock > HIGH lock > EXTREME lock (profit-lock floor). */
const LOCK_VOL_SCALE = Object.freeze({ LOW: 1.0, NORMAL: 1.0, HIGH: 0.75, EXTREME: 0.50 });
const ADVERSE_GEAR1_TICK_PCT = -0.02;    // routine reversal (existing gear)
const ADVERSE_GEAR2_TICK_PCT = -0.04;    // strong reversal in 3s tick window
const ADVERSE_GEAR1_FACTOR = 0.65;       // legacy tighten factor
const ADVERSE_GEAR1_FLOOR_R = 0.15;      // legacy floor
const ADVERSE_GEAR2_FACTOR = 0.40;       // ultra-fast: tightest trail, book profit
const ADVERSE_GEAR2_FLOOR_R = 0.10;

/**
 * v21.35.5: stepped progressive profit-lock in R units.
 * Pure/deterministic: same peakR + volClass + momentumState → same lock.
 *
 * Thresholds shift: HIGH/EXTREME kick in later (wide-trail classes need the
 * peak to be clearly real before locking — fewer whipsaw stalls), LOW early.
 * Lock % scales down in HIGH/EXTREME (LOCK_VOL_SCALE) so a big runner keeps
 * most of its room — but the floor still compounds as the peak grows, which
 * is the "high vol me bhi high profit BOOK" behaviour.
 * Momentum: SURGING pushes the threshold later (give the runner space),
 * FADING earlier (book now).
 * @returns number (lock as fraction of peak move, in R units) — 0 when no
 *   step has tripped yet (below the first shifted threshold).
 */
export function progressiveProfitLockR(peakR, volClass, momentumState) {
  const vr = Number(peakR);
  if (!Number.isFinite(vr) || vr <= 0) return 0;
  const key = String(volClass || 'NORMAL').toUpperCase();
  const volShift = LOCK_THRESHOLD_VOL_SHIFT[key] ?? 0;
  const volScale = LOCK_VOL_SCALE[key] ?? 1.0;
  const momShift = String(momentumState || 'STEADY').toUpperCase() === 'SURGING' ? 0.15
    : String(momentumState || 'STEADY').toUpperCase() === 'FADING' ? -0.15 : 0;
  let lock = 0;
  for (const step of PROGRESSIVE_LOCK_STEPS) {
    const threshold = step.minPeakR + volShift + momShift;
    if (vr >= threshold) lock = Math.max(lock, step.lockPct * volScale * vr);
  }
  return lock;
}

function _num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function _mode(raw, fallback = 'shadow') {
  const v = String(raw ?? '').trim().toLowerCase();
  if (v === 'enforce' || v === 'on' || v === '1' || v === 'true' || v === 'active') return 'enforce';
  if (v === 'off' || v === '0' || v === 'false' || v === 'disabled' || v === 'none') return 'off';
  if (v === 'shadow' || v === 'dry-run' || v === 'dryrun' || v === 'observe') return 'shadow';
  // v21.32.0 [G10]: unknown → shadow (conservative) — bina LIVE-SMALL
  // #1–#2 proof ke SL replace/stack semantics par act nahi karte.
  return fallback === 'enforce' || fallback === 'off' ? fallback : 'shadow';
}

function _r6(v) {
  return +Number(v).toFixed(6);
}

function _round2(v) {
  return +Number(v).toFixed(2);
}

function _profile(volClass, momentumState) {
  const key = String(volClass || 'NORMAL').toUpperCase();
  const base = PRE_TP1_VOL_PROFILE[key] || PRE_TP1_VOL_PROFILE.NORMAL;
  const factor = MOMENTUM_FACTOR[String(momentumState || 'STEADY').toUpperCase()]
    ?? MOMENTUM_FACTOR.STEADY;
  return {
    volClass: PRE_TP1_VOL_PROFILE[key] ? key : 'NORMAL',
    momentumState: String(momentumState || 'STEADY').toUpperCase(),
    momentumFactor: factor,
    armR: _round2(base.armR),
    givebackR: _round2(base.givebackR * factor),
    bufferR: _round2(base.bufferR * factor),
  };
}

/**
 * Pure pre-TP1 stop proposal.
 *
 * @param {object} input
 *   mode                enforce | shadow | off
 *   side                LONG | SHORT
 *   entry               entry price
 *   initialStopLoss     original protective stop (risk anchor)
 *   currentStopLoss     currently carried stop (ratchet base)
 *   peakPrice           favourable extreme since entry
 *   ltp                 live last traded price
 *   risk                |entry - initialStopLoss| (R)
 *   feeFloor            exact round-trip fee-breakeven price
 *   volClass            LOW | NORMAL | HIGH | EXTREME
 *   momentumState       SURGING | STEADY | FADING | UNKNOWN
 *   tickTrendPct        signed % trend over the live tick window (+ = with trade)
 *   tickTrendAdverse    true when the live tick trend is confirmed adverse
 *   allowMove           false = compute telemetry but never apply (stale quote)
 *
 * @returns {object} telemetry; `proposedSl` is the ratcheted candidate only
 *   when `applied` is true (enforce) — shadow reports what WOULD happen.
 */
export function evaluatePreTp1NoLossTrail(input = {}) {
  // v21.32.0 [G10]: default shadow — enforce LIVE-SMALL #1–#2 ke baad.
  const mode = _mode(input.mode, 'shadow');
  const side = String(input.side || '').toUpperCase();
  const isLong = side === 'LONG';
  const entry = _num(input.entry);
  const initialSl = _num(input.initialStopLoss);
  const currentSl = _num(input.currentStopLoss, initialSl);
  const ltp = _num(input.ltp);
  const risk = _num(input.risk, Math.abs(entry - initialSl));
  const feeFloor = _num(input.feeFloor);
  const profile = _profile(input.volClass, input.momentumState);
  const trendPct = input.tickTrendPct == null ? null : _num(input.tickTrendPct);
  const trendAdverse = input.tickTrendAdverse === true
    || (trendPct != null && trendPct <= STRONG_ADVERSE_TREND_PCT);

  const base = {
    mode,
    available: mode !== 'off',
    active: false,
    armed: false,
    applied: false,
    reason: null,
    side: isLong ? 'LONG' : (side === 'SHORT' ? 'SHORT' : null),
    volClass: profile.volClass,
    momentumState: profile.momentumState,
    armR: profile.armR,
    armPrice: null,
    peakR: 0,
    currentR: 0,
    feeFloor: feeFloor > 0 ? _r6(feeFloor) : null,
    feeR: null,
    bufferR: profile.bufferR,
    givebackR: profile.givebackR,
    noLossSl: null,
    trailSl: null,
    proposedSl: null,
    currentStopLoss: currentSl > 0 ? _r6(currentSl) : null,
    lockedProfitR: null,
    trendPct: trendPct == null ? null : _num(trendPct),
    trendAdverse,
    trendTightened: false,
    ratchetOnly: true,
  };

  if (mode === 'off') return { ...base, reason: 'mode_off' };
  if (!isLong && side !== 'SHORT') return { ...base, reason: 'invalid_side' };
  if (!(entry > 0) || !(ltp > 0) || !(risk > 0)) return { ...base, reason: 'invalid_inputs' };
  if (!(feeFloor > 0)) return { ...base, reason: 'missing_fee_floor' };

  const rawPeak = _num(input.peakPrice, entry);
  const peak = isLong
    ? Math.max(rawPeak, entry, ltp)
    : Math.min(rawPeak > 0 ? rawPeak : entry, entry, ltp);
  const peakMove = isLong ? (peak - entry) : (entry - peak);
  const currentMove = isLong ? (ltp - entry) : (entry - ltp);
  const peakR = peakMove / risk;
  const currentR = currentMove / risk;
  const feeDistance = Math.abs(feeFloor - entry);
  const feeR = feeDistance / risk;
  // Arm only when the favourable excursion can pay the round-trip fee AND
  // leave the volatility buffer untouched. Defensive arm is allowed earlier
  // (fee covered) when the live trend has already turned adverse.
  const armR = _round2(Math.max(profile.armR, feeR + 0.10));
  const defensiveArmR = _round2(Math.max(feeR + 0.04, 0.20));
  const peakCoveredFee = isLong ? peak > feeFloor : peak < feeFloor;
  const armedNormal = peakCoveredFee && peakR >= armR;
  const armedDefensive = peakCoveredFee && trendAdverse && peakR >= defensiveArmR;
  const armed = armedNormal || armedDefensive;

  const noLossSl = isLong
    ? feeFloor + profile.bufferR * risk
    : feeFloor - profile.bufferR * risk;
  // v21.35.5 ULTRA-FAST ADVERSE GEAR — two tightening gears on the live tick
  // trend (only ever tightens; a favourable trend must never widen a locked
  // stop). Gear-1 (-2%): legacy. Gear-2 (-4%, strong reversal in the 3s
  // window): giveback floor 0.10R — book the profit, exit the other way.
  const adverseGear = trendAdverse
    ? (trendPct != null && trendPct <= ADVERSE_GEAR2_TICK_PCT ? 2 : 1)
    : 0;
  const adverseFactorR = adverseGear === 2 ? ADVERSE_GEAR2_FACTOR : ADVERSE_GEAR1_FACTOR;
  const adverseFloorR = adverseGear === 2 ? ADVERSE_GEAR2_FLOOR_R : ADVERSE_GEAR1_FLOOR_R;
  const givebackR = adverseGear > 0
    ? _round2(Math.max(adverseFloorR, profile.givebackR * adverseFactorR))
    : profile.givebackR;
  const trailSl = isLong
    ? peak - givebackR * risk
    : peak + givebackR * risk;
  // v21.35.5 PROGRESSIVE PROFIT-LOCK — as the peak grows, lock a growing
  // fraction of the peak move (stepped, vol/momentum-shifted thresholds).
  // Profit-side only: it can only RAISE the candidate (LONG) / LOWER it
  // (SHORT) — a strict ratchet, never a loosening. This is the "high
  // volatility me bhi high profit book ho" gear: wide high-vol giveback
  // still rides the move, but the floor compounds instead of stalling.
  const progressiveLockR = progressiveProfitLockR(peakR, profile.volClass, profile.momentumState);
  const profitLockSl = isLong
    ? entry + progressiveLockR * risk
    : entry - progressiveLockR * risk;
  const candidate = isLong
    ? Math.max(noLossSl, trailSl, profitLockSl)
    : Math.min(noLossSl, trailSl, profitLockSl);

  const armPrice = isLong ? entry + armR * risk : entry - armR * risk;
  const lockedProfitR = isLong ? (candidate - entry) / risk : (entry - candidate) / risk;

  const out = {
    ...base,
    active: true,
    armed,
    armR,
    defensiveArmR,
    armPrice: _r6(armPrice),
    peakR: _round2(peakR),
    currentR: _round2(currentR),
    feeR: _round2(feeR),
    givebackR,
    adverseGear,
    progressiveLockR: _round2(progressiveLockR),
    profitLockSl: _r6(profitLockSl),
    trendTightened: Boolean(trendAdverse && profile.givebackR > givebackR),
    noLossSl: _r6(noLossSl),
    trailSl: _r6(trailSl),
    lockedProfitR: _round2(lockedProfitR),
  };

  if (!armed) {
    return {
      ...out,
      reason: peakCoveredFee ? 'below_arm_threshold' : 'fee_not_covered',
    };
  }

  // Never propose a stop at/through the live price: that is an instant fill,
  // not protection. Keep a small honest gap (>= 2% of R and >= 5 bps of LTP).
  const gap = Math.max(risk * 0.02, ltp * 0.0005);
  const crossesLtp = isLong ? candidate >= (ltp - gap) : candidate <= (ltp + gap);
  if (crossesLtp) {
    return { ...out, reason: 'would_cross_ltp' };
  }
  if (!(candidate > 0)) return { ...out, reason: 'invalid_candidate' };

  const improves = currentSl > 0
    ? (isLong ? candidate > currentSl + 1e-9 : candidate < currentSl - 1e-9)
    : true;
  if (!improves) {
    return { ...out, reason: 'no_improvement', proposedSl: null };
  }

  const proposedSl = _r6(candidate);
  const applied = mode === 'enforce' && input.allowMove !== false;
  return {
    ...out,
    applied,
    proposedSl: applied ? proposedSl : null,
    wouldApplySl: applied ? null : proposedSl,
    reason: applied ? 'applied' : (input.allowMove === false ? 'move_not_allowed' : 'shadow'),
  };
}
