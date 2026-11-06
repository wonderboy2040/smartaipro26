// ============================================================
// server/ai/signalLifecycle.js — v21.33.0 [PHASE D5/D6 + F-g]
// ------------------------------------------------------------
// MASTER PLAN Phase D: signal lifecycle state machine + anti-flicker
// hysteresis + post-stop-out cooldown + entry dedup (F-g) + rolling
// correlation cluster (D6).
//
// LIFECYCLE: CANDIDATE → CONFIRMED (closed-bar) → ARMED (live
// trigger) → FIRED (entry) → EXPIRED. Ek state machine jo board
// scan ke har tick par advance hoti hai — PURE, caller state apne
// paas rakhta hai (map of symbol → lifecycle record).
//
// ANTI-FLICKER (D5): direction flip ke liye MARGIN + DWELL dono
// chahiye — naya side score ≥ purana + margin (default +8) AUR
// purana signal min dwell bars (default 2) jee chuka ho. Cooldown:
// stop-out ke baad same symbol+side par cooldownMin (default 20m).
//
// DEFAULT SHADOW: state machine label + wouldFlip/wouldBlock
// verdicts — enforce par bhi side kabhi flip nahi karta (direction
// authority MTF plan ki hai); flicker-guard sirf "flip accept karne
// se INAAT" deta hai.
//
// PURE module — koi IO nahi. Deterministic.
// ============================================================
import { correlationClusterOf } from './tradeGuards.js';

export const LIFECYCLE_STATES = Object.freeze(['CANDIDATE', 'CONFIRMED', 'ARMED', 'FIRED', 'EXPIRED']);

export const LIFECYCLE_DEFAULTS = Object.freeze({
  flipMargin: 8,        // naya side score ≥ old + 8 hi tab (plan 18.3)
  minDwellBars: 2,      // flip se pehle purana side ≥2 bars dwell
  cooldownMin: 20,      // stop-out ke baad same symbol+side cooldown (15–30 range)
  confirmMinScore: 50,  // CANDIDATE → CONFIRMED floor
  armMinScore: 65,      // CONFIRMED → ARMED floor (ACTION tier)
  expireBars: 48,       // horizon default (fallback: 48 trigger bars)
  clusterCorr: 0.80,    // D6: corr ≥ 0.8 ⇒ same cluster
});

function _num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function normalizeLifecycleMode(raw, fallback = 'shadow') {
  const v = String(raw ?? '').trim().toLowerCase();
  if (v === 'enforce' || v === 'on' || v === '1' || v === 'true') return 'enforce';
  if (v === 'off' || v === '0' || v === 'false' || v === 'disabled') return 'off';
  if (v === 'shadow' || v === 'dry-run' || v === 'observe') return 'shadow';
  return fallback === 'enforce' || fallback === 'off' ? fallback : 'shadow';
}

export function blankLifecycle({ symbol = '', side = '', now = Date.now(), barTime = null } = {}) {
  return {
    symbol: String(symbol || '').toUpperCase(),
    side: String(side || '').toUpperCase(),
    state: 'CANDIDATE',
    score: null,
    enteredStateAt: Number(now) || Date.now(),
    dwellBars: 0,
    lastBarTime: _num(barTime),
    lastFlipAt: null,
    flips: 0,
    firedAt: null,
    expiredAt: null,
    stopOutAt: null,
    cooldownUntil: null,
    seenBars: 0,
  };
}

/**
 * Advance one lifecycle tick for a symbol.
 * prev: purana lifecycle record (null → naya CANDIDATE).
 * next: { side, score, closedBarConfirmed, triggerFired, fired, barTime, expired, stopOut, now }
 * Returns { record, transition, wouldFlip, flipAccepted, verdict } —
 * record ko caller persist karta hai. FLIP kabhi side force nahi
 * karta: wouldFlip=true + flipAccepted=false → caller purana side
 * rakhta hai (flicker suppressed); flipAccepted=true → naya side.
 */
export function advanceLifecycle(prev, next = {}, opts = {}) {
  const cfg = { ...LIFECYCLE_DEFAULTS, ...opts };
  // v21.35.0 [A7]: deterministic now — next.now (legacy signature) ??
  // opts.now (test-injectable wall-clock) ?? Date.now().
  const now = Number(next.now ?? opts.now) || Date.now();
  // v21.35.0 [A7]: barTime-guma (price-lane ticks) ke liye wall-clock
  // expiry ka bar-duration — default 5m trigger-TF assumption.
  const tfMs = Math.max(1, Number(opts.tfMs) || 300_000);
  const side = String(next.side || '').toUpperCase();
  const score = _num(next.score);
  const barTime = _num(next.barTime);
  const validSide = side === 'LONG' || side === 'SHORT';

  if (!prev) {
    const rec = blankLifecycle({ symbol: next.symbol, side: validSide ? side : '', now, barTime });
    if (score != null) rec.score = score;
    return {
      record: rec,
      transition: 'NEW_CANDIDATE',
      wouldFlip: false,
      flipAccepted: false,
      verdict: validSide ? 'candidate_created' : 'invalid_side_ignored',
    };
  }

  const rec = { ...prev };
  // new closed bar seen? (barTime change = naya closed trigger bar)
  const newBar = barTime != null && (rec.lastBarTime == null || barTime > rec.lastBarTime);
  if (newBar) {
    rec.lastBarTime = barTime;
    rec.dwellBars += 1;
    rec.seenBars += 1;
  }

  let transition = null;
  let wouldFlip = false;
  let flipAccepted = false;
  let verdict = 'no_change';

  // EXPIRED / FIRED are terminal for this cycle
  if (rec.state === 'EXPIRED' || rec.state === 'FIRED') {
    if (next.stopOut === true && rec.state === 'FIRED') {
      rec.stopOutAt = now;
      rec.stopOutSide = rec.side; // v21.34.0: cooldown isi side par scoped hai
      rec.cooldownUntil = now + cfg.cooldownMin * 60_000;
      transition = 'STOP_OUT';
      verdict = 'stop_out_cooldown_armed';
    }
    return { record: rec, transition: transition || null, wouldFlip: false, flipAccepted: false, verdict: transition ? verdict : 'terminal_state' };
  }

  // anti-flicker: side change check FIRST (CANDIDATE/CONFIRMED/ARMED me hi)
  if (validSide && side !== rec.side && rec.side) {
    wouldFlip = true;
    // v21.35.0 [A6]: score unknown → flip SUPPRESS (fail-closed). Pehle
    // missing score par marginOk=true tha — dwell akela flip accept kar
    // leta tha bina kisi evidence ke. Unknown evidence = suppress (honest).
    const marginOk = score != null && rec.score != null
      ? score >= rec.score + cfg.flipMargin
      : false;
    const dwellOk = rec.dwellBars >= cfg.minDwellBars;
    flipAccepted = marginOk && dwellOk;
    if (flipAccepted) {
      rec.side = side;
      rec.score = score ?? rec.score;
      rec.dwellBars = 0;
      rec.flips += 1;
      rec.lastFlipAt = now;
      rec.state = 'CANDIDATE'; // flip resets the ladder
      rec.enteredStateAt = now;
      transition = 'FLIP_ACCEPTED';
      verdict = `flip_${rec.side}_after_margin+${cfg.flipMargin}_dwell_${cfg.minDwellBars}`;
    } else {
      transition = 'FLIP_SUPPRESSED';
      verdict = `flip_to_${side}_suppressed_needs_${marginOk ? 'dwell' : 'margin'}`;
    }
  } else if (score != null) {
    rec.score = score;
  }

  // state ladder (sirf same-side ya accepted-flip par)
  if (transition !== 'FLIP_SUPPRESSED') {
    const closedConfirmed = next.closedBarConfirmed === true;
    const triggerFired = next.triggerFired === true;
    if (rec.state === 'CANDIDATE' && closedConfirmed && (score == null || score >= cfg.confirmMinScore)) {
      rec.state = 'CONFIRMED';
      rec.enteredStateAt = now;
      transition = transition || 'CONFIRMED';
    } else if (rec.state === 'CONFIRMED' && triggerFired && (score == null || score >= cfg.armMinScore)) {
      rec.state = 'ARMED';
      rec.enteredStateAt = now;
      transition = transition || 'ARMED';
    } else if ((rec.state === 'ARMED' || rec.state === 'CONFIRMED') && next.fired === true) {
      // v21.34.0 [ARM-GATE — LADDER SKIP FIX]: CONFIRMED se seedha FIRED
      // allowed NAHI tha kyunki ARMED ka score floor (armMinScore) +
      // triggerFired requirement bypass ho jata tha — caller ne `fired`
      // bhej diya to low-score CONFIRMED bhi fire ho sakta tha. Ab
      // CONFIRMED→FIRED sirf tab jab ARMED ki saari conditions khud
      // satisfy hon (trigger + armMinScore).
      if (rec.state === 'CONFIRMED' && !(triggerFired && (score == null || score >= cfg.armMinScore))) {
        // ladder skip blocked — CONFIRMED hi rehta hai (honest no_change)
      } else {
        rec.state = 'FIRED';
        rec.firedAt = now;
        rec.enteredStateAt = now;
        transition = 'FIRED';
      }
    } else if ((rec.state === 'ARMED' || rec.state === 'CONFIRMED' || rec.state === 'CANDIDATE')
      && (rec.seenBars >= cfg.expireBars
        // v21.35.0 [A7]: caller barTime nahi deta (price-lane ticks) to
        // seenBars kabhi increment nahi hota → immortal states. Wall-clock
        // fallback: enteredStateAt se expireBars·tfMs paar ho gaya to
        // EXPIRED (tests opts.now + opts.tfMs se deterministic banate hain).
        || (barTime == null && rec.enteredStateAt != null && now - rec.enteredStateAt >= cfg.expireBars * tfMs))) {
      // v21.34.0 [IMMORTAL-STATE FIX]: expiry pehle sirf ARMED par lagti
      // thi — CANDIDATE/CONFIRMED kabhi expire nahi hote the aur stale
      // records caller map me forever latke rehte the (baad me kisi bhi
      // horizon ke bahar fire ho sakte the). Ab teeno non-terminal states
      // expireBars par EXPIRE hote hain.
      rec.state = 'EXPIRED';
      rec.expiredAt = now;
      rec.enteredStateAt = now;
      transition = 'EXPIRED';
    }
  }

  // cooldown gate: stop-out ke baad same side re-entry blocked till cooldownUntil
  // v21.34.0 [COOLDOWN SIDE-SCOPED]: spec "same symbol+side par cooldown"
  // tha par gate kisi bhi side ke FIRED ko rok deta tha (over-restrictive).
  // Ab block sirf tab jab fired side == stopped-out side ho.
  let cooldownActive = false;
  if (rec.cooldownUntil != null && now < rec.cooldownUntil) {
    cooldownActive = true;
    const stoppedSide = rec.stopOutSide || rec.side; // jis side ka stop-out hua
    // v21.35.0 [A5]: `side` normalized string hai — `side == null` dead
    // code tha, isliye side OMIT ('') ki hui fire-tick cooldown bypass kar
    // leti thi. Missing/empty side ko record ki hi side maano (fail-closed);
    // genuinely-opposite side ka semantics pehle jaisa hi free hai.
    if (transition === 'FIRED' && (!side || side === stoppedSide)) {
      rec.state = 'ARMED'; // cooldown ne fire roka (same-side hi)
      rec.firedAt = null;
      transition = 'FIRED_BLOCKED_BY_COOLDOWN';
      verdict = `cooldown_active_${Math.ceil((rec.cooldownUntil - now) / 60000)}m`;
    }
  }

  return {
    record: rec,
    transition,
    wouldFlip,
    flipAccepted,
    cooldownActive,
    verdict: transition ? verdict : 'no_change',
  };
}

// ------------------------------------------------------------
// D6 — rolling-return correlation cluster
// Static cluster map (tradeGuards.correlationClusterOf) + rolling
// correlation ≥ 0.8 ⇒ dynamically same cluster. Best-score-in-
// cluster wins; post-loss cluster cooldown optional.
// ------------------------------------------------------------
export function rollingCorrelation(aCloses = [], bCloses = [], window = 60) {
  if (!Array.isArray(aCloses) || !Array.isArray(bCloses)) return null;
  const n = Math.min(aCloses.length, bCloses.length, window + 1);
  if (n < 21) return null;
  const a = aCloses.slice(-n);
  const b = bCloses.slice(-n);
  const aR = [];
  const bR = [];
  for (let i = 1; i < n; i++) {
    if (a[i - 1] > 0 && b[i - 1] > 0) {
      aR.push(Math.log(a[i] / a[i - 1]));
      bR.push(Math.log(b[i] / b[i - 1]));
    }
  }
  if (aR.length < 20) return null;
  const mA = aR.reduce((x, y) => x + y, 0) / aR.length;
  const mB = bR.reduce((x, y) => x + y, 0) / bR.length;
  let cov = 0, varA = 0, varB = 0;
  for (let i = 0; i < aR.length; i++) {
    cov += (aR[i] - mA) * (bR[i] - mB);
    varA += (aR[i] - mA) ** 2;
    varB += (bR[i] - mB) ** 2;
  }
  if (!(varA > 0 && varB > 0)) return null;
  return +(cov / Math.sqrt(varA * varB)).toFixed(4);
}

/**
 * D6 cluster verdict for a candidate against open/other signals.
 * others: [{ symbol, side, score, closes? }] — candidate ka cluster
 * sab se pehle static map se, phir rolling corr se refine.
 */
export function evaluateSignalCluster({
  candidate = {}, others = [], closesBySymbol = {}, corrThreshold = LIFECYCLE_DEFAULTS.clusterCorr, maxPerCluster = 2,
} = {}) {
  const candSym = String(candidate.symbol || '').toUpperCase();
  const candSide = String(candidate.side || '').toUpperCase();
  const candCluster = correlationClusterOf(candSym);
  const sameCluster = [];
  for (const o of Array.isArray(others) ? others : []) {
    const oSym = String(o.symbol || '').toUpperCase();
    if (!oSym || oSym === candSym) continue;
    // v21.35.0 [A8]: OTHER:* prefix buckets (unmapped symbols ka 3-letter
    // prefix fallback) STATIC-same nahi hain — MOONUSDT/MOONBIRDSUSDT
    // dono 'OTHER:MOO' mil jaate the bina kisi correlation evidence ke.
    // Sirf dynamic corr >= threshold hi unhe same-cluster bana sakta hai.
    const oCluster = correlationClusterOf(oSym);
    const staticSame = oCluster === candCluster && !/^OTHER/i.test(String(candCluster));
    let corr = null;
    const aC = closesBySymbol[candSym];
    const bC = closesBySymbol[oSym];
    if (Array.isArray(aC) && Array.isArray(bC)) corr = rollingCorrelation(aC, bC);
    const dynamicSame = corr != null && corr >= corrThreshold;
    if (staticSame || dynamicSame) {
      sameCluster.push({ symbol: oSym, side: String(o.side || '').toUpperCase(), score: _num(o.score), static: staticSame, corr });
    }
  }
  // best-score-in-cluster: candidate jeet-ta hai agar uska score sab se uncha
  const candScore = _num(candidate.score);
  const bestOther = sameCluster.reduce((best, o) => (o.score != null && (best == null || o.score > best) ? o.score : best), null);
  const bestInCluster = candScore != null && (bestOther == null || candScore > bestOther);
  // v21.35.0 [A8]: concentration cap sirf SAME-side others ginte hain —
  // opposite-side entries HEDGE hain, concentration nahi. Side unknown
  // (candidate ya other) ho to conservative count hi rehta hai.
  // best-in-cluster logic (upar) sameCluster ke SAB par chalti hai — unchanged.
  const count = sameCluster.filter(o => !candSide || !o.side || o.side === candSide).length;
  const wouldBlock = count >= Math.max(1, maxPerCluster) && !bestInCluster;
  return {
    filter: 'signalCluster',
    cluster: candCluster,
    candidate: { symbol: candSym, side: candSide, score: candScore },
    sameCluster,
    count,
    maxPerCluster,
    bestInCluster,
    wouldBlock,
    reason: wouldBlock
      ? `${candCluster} cluster me ${count} signals, candidate best nhai (best other score ${bestOther})`
      : null,
  };
}

// ------------------------------------------------------------
// F-g — entry dedup by symbol:side:barTime
// Ek hi closed-bar signal par double-entry fire nahi honi chahiye.
// Caller ke Set/Map me key claim karo (idempotent).
// ------------------------------------------------------------
export function entryDedupKey({ symbol = '', side = '', barTime = null, market = '' } = {}) {
  const s = String(symbol || '').toUpperCase();
  const sd = String(side || '').toUpperCase();
  const m = String(market || '').toUpperCase();
  const bt = _num(barTime);
  if (!s || (sd !== 'LONG' && sd !== 'SHORT') || bt == null) return null;
  return `${m}:${s}:${sd}:${bt}`;
}

/**
 * Idempotent claim: pehli baar true (claim ho gaya), dobara false.
 * store: Set-like { has(k), add(k) } — caller owned. Map .add() nahi
 * rakhta, isliye Map pass karna hamesha false deta hai — v21.35.0 [A9]
 * docstring fix (purana doc Map bhi support likhta tha, jo galat tha).
 */
export function claimEntryDedup(store, key, { maxEntries = 4096 } = {}) {
  if (!store || !key || typeof store.has !== 'function' || typeof store.add !== 'function') return false;
  if (store.has(key)) return false;
  store.add(key);
  // bounded: entries drop FIFO when caller passes an array-backed set
  if (Array.isArray(store._ordered) && store._ordered.length > maxEntries) {
    const drop = store._ordered.shift();
    if (drop) store.delete(drop);
  }
  return true;
}

/** Cooldown check helper — stop-out ke baad same symbol+side entry? */
export function entryCooldownActive({ stopOutAt = null, cooldownMin = LIFECYCLE_DEFAULTS.cooldownMin, now = Date.now() } = {}) {
  const so = _num(stopOutAt);
  if (so == null) return false;
  const until = so + Math.max(0, Number(cooldownMin) || 0) * 60_000;
  return Number(now) < until;
}
