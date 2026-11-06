// ============================================================
// server/ai/entryQuality.js — v21.33.0 [PHASE F ENTRY EXECUTION]
// ------------------------------------------------------------
// MASTER PLAN Phase F: entry execution quality gates + retest entry
// plan. Sab SHADOW default — koi live behaviour change nahi jab tak
// FLAG-HISTORY me promote na ho.
//
//   F-c SPREAD GATE       spreadBps ≤ max(2×rollingMedian, hardCap)
//   F-b SLIPPAGE GATE     expected slippage > 0.15R → skip
//                         (model: slippageBps = a + b·(size/depth) + c·spreadBps)
//   F-a RETEST ENTRY      breakout par immediate-market ki jagah
//                         optional limit retest (level ± 0.10–0.25×ATR,
//                         expiry N bars, miss = skip — NO chase)
//   F-f FUNDING WINDOW    funding settlement −3m..+1m me naye
//                         high-leverage entries ke liye proximity flag
//                         (R4 blackout alag se shadow me chal raha hai)
//
// PURE module — no exchange calls. Side sirf READ hota hai; koi
// direction flip nahi (LONG→BUY / SHORT→SELL certificate intact).
// ============================================================

export const ENTRY_QUALITY_DEFAULTS = Object.freeze({
  spreadHardCapBps: 12,        // F-c: absolute cap
  spreadMedianMult: 2,         // F-c: 2× rolling median
  spreadMedianWindow: 50,      // rolling median window (entries)
  slippageMaxR: 0.15,          // F-b: expected slippage budget (R units)
  slippageModelA: 2,           // F-b: base bps
  // v21.34.0 [SLIPPAGE IMPACT TERM RECALIBRATED]: b 0.000004 (bps per
  // notional/depth ratio) ka depth-term ~6 orders of magnitude chhota tha
  // — 2×-depth trade aur 2%-of-depth trade dono ko same slippage milti
  // thi (model effectively a + c·spread). Ab b=4: size=depth → +4bps
  // impact, size=0.5×depth → +2bps — square-root-law ke conservative
  // linear proxy ke saath consistent. Shadow ledger me expected-vs-realised
  // compare hi final calibration karega.
  slippageModelB: 4,            // F-b: bps per (notional/depthUSD)
  slippageModelC: 0.35,        // F-b: bps per spread bps
  retestAtrLow: 0.10,          // F-a: level ± ATR band
  retestAtrHigh: 0.25,
  retestExpiryBars: 8,         // F-a: expiry N trigger bars, miss = skip
  fundingWindowPreMin: 3,      // F-f
  fundingWindowPostMin: 1,
});

function _num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function normalizeQualityMode(raw, fallback = 'shadow') {
  const v = String(raw ?? '').trim().toLowerCase();
  if (v === 'enforce' || v === 'on' || v === '1' || v === 'true') return 'enforce';
  if (v === 'off' || v === '0' || v === 'false' || 'disabled' === v) return 'off';
  if (v === 'shadow' || v === 'dry-run' || v === 'observe') return 'shadow';
  return fallback === 'enforce' || fallback === 'off' ? fallback : 'shadow';
}

// ------------------------------------------------------------
// F-c — Spread gate. spreadBps missing → fail-open (honest), par
// coverage flag ke saath (fabricated block mana hai — plan D4).
// ------------------------------------------------------------
export function rollingMedianSpread(spreadHistory = []) {
  const xs = (Array.isArray(spreadHistory) ? spreadHistory : [])
    .map(_num)
    .filter((v) => v != null && v > 0);
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return +(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2).toFixed(2);
}

export function evaluateSpreadGate({
  spreadBps = null, spreadHistory = [], mode = 'shadow',
  hardCapBps = ENTRY_QUALITY_DEFAULTS.spreadHardCapBps,
  medianMult = ENTRY_QUALITY_DEFAULTS.spreadMedianMult,
  // v21.35.0 [A12]: spreadMedianWindow ab PLUMBED hai — pehle ye config
  // dead thi (rollingMedianSpread FULL history map karta tha), isliye
  // spread-regime shift ke baad bhi pura purana median cap kheenchta
  // rehta tha (stale full-history median se over-block). Ab sirf last-N
  // entries ka median — cap formula max(hardCap, medianMult×median) same.
  medianWindow = ENTRY_QUALITY_DEFAULTS.spreadMedianWindow,
  liquidityUSD = null, minLiquidityUSD = null,
} = {}) {
  const m = normalizeQualityMode(mode);
  const sp = _num(spreadBps);
  const win = Math.max(1, Math.floor(Number(medianWindow) || ENTRY_QUALITY_DEFAULTS.spreadMedianWindow));
  const hist = Array.isArray(spreadHistory) ? spreadHistory : [];
  const med = rollingMedianSpread(hist.slice(-win)); // v21.35.0 [A12]: window-bounded
  const reasons = [];
  if (sp != null) {
    const cap = med != null
      ? Math.max(hardCapBps, med * medianMult)
      : hardCapBps;
    if (sp > cap) reasons.push(`spread ${sp}bps > cap ${+cap.toFixed(2)}bps (${med != null ? `${medianMult}×median${med}bp, floor ${hardCapBps}` : `hard ${hardCapBps}`})`);
  }
  // v21.34.0 [LIQUIDITY HOIST]: liquidity-floor check pehle `sp != null`
  // ke ANDAR tha — spread telemetry absent hone par liquidity breach BHI
  // evaluate hi nahi hota tha (gate silently skip). Ab independent: spread
  // missing ho to bhi thin-liquidity block hota hai (fail-open sirf tab
  // jab liquidity data khud missing ho).
  const liq = _num(liquidityUSD);
  const liqFloor = _num(minLiquidityUSD);
  if (liqFloor != null && liq != null && liq < liqFloor) {
    reasons.push(`24h liquidity $${Math.round(liq)} < floor $${liqFloor}`);
  }
  const wouldBlock = reasons.length > 0;
  return {
    filter: 'spreadGate', mode: m, active: m !== 'off',
    spreadBps: sp, rollingMedianBps: med, capBps: med != null ? +Math.max(hardCapBps, med * medianMult).toFixed(2) : hardCapBps,
    coverage: sp != null,
    liquidityUSD: liq, minLiquidityUSD: liqFloor,
    wouldBlock, blocked: m === 'enforce' && wouldBlock, shadow: m === 'shadow',
    reason: wouldBlock ? reasons[0] : null, reasons,
  };
}

// ------------------------------------------------------------
// F-b — Slippage model + gate.
//   slippageBps = a + b·(notional / depthUSD) + c·spreadBps
// Expected slippage R me convert: (bps/10000)·notional / riskUSD.
// > 0.15R → skip. Caller realised-slippage ledger me log karta hai
// (expected vs realised compare — F-b second half).
// ------------------------------------------------------------
export function estimateSlippageBps({
  notionalUSD = null, depthUSD = null, spreadBps = null,
  a = ENTRY_QUALITY_DEFAULTS.slippageModelA,
  b = ENTRY_QUALITY_DEFAULTS.slippageModelB,
  c = ENTRY_QUALITY_DEFAULTS.slippageModelC,
} = {}) {
  const notional = _num(notionalUSD);
  const depth = _num(depthUSD);
  const sp = _num(spreadBps);
  if (notional == null || !(notional > 0)) return null;
  const depthTerm = depth != null && depth > 0 ? b * (notional / depth) : 0;
  const spreadTerm = sp != null ? c * sp : 0;
  return +(a + depthTerm + spreadTerm).toFixed(2);
}

export function evaluateSlippageGate({
  side = null, notionalUSD = null, depthUSD = null, spreadBps = null,
  riskUSD = null, mode = 'shadow', maxR = ENTRY_QUALITY_DEFAULTS.slippageMaxR,
} = {}) {
  const m = normalizeQualityMode(mode);
  const s = String(side || '').toUpperCase();
  const bps = estimateSlippageBps({ notionalUSD, depthUSD, spreadBps });
  const notional = _num(notionalUSD);
  const risk = _num(riskUSD);
  const depth = _num(depthUSD);
  // v21.35.0 [A13]: depth null/<=0 par depthTerm=0 hota tha jabki coverage
  // true — base+spread-only bps CONFIDENT slippageBps ki tarah report hota
  // tha (asl impact ~3× under-report, 0.15R budget ke paas verdict flip).
  // Ab honest: depth ke bina computable FALSE (verdict fail-open doctrine
  // par hi hai — par coverage/reason depth-missing bolega, number ka
  // confidence fabricate nahi hota).
  const depthOk = depth != null && depth > 0;
  const computable = bps != null && depthOk && notional != null && risk != null && risk > 0 && (s === 'LONG' || s === 'SHORT');
  let expectedSlippageR = null;
  if (computable) {
    expectedSlippageR = +((bps / 10_000) * notional / risk).toFixed(4);
  }
  const wouldBlock = computable && expectedSlippageR > maxR;
  return {
    filter: 'slippageGate', mode: m, active: m !== 'off', side: s,
    coverage: computable,
    slippageBps: bps, expectedSlippageR,
    maxR,
    wouldBlock, blocked: m === 'enforce' && wouldBlock, shadow: m === 'shadow',
    reason: wouldBlock
      ? `expected slippage ${expectedSlippageR}R > ${maxR}R budget`
      : (!computable
        ? (depthOk
          ? 'not computable (missing risk/side — fail-open)'
          : 'not computable (missing order-book depth — fail-open; bina depth ke impact ~3× under-report hota)')
        : null),
  };
}

// ------------------------------------------------------------
// F-a — Retest entry plan (breakout signals ke liye optional).
// Immediate market ki jagah limit retest level: trigger level se
// pull-back side me band (LONG: level − band; SHORT: level + band).
// Expiry N trigger bars. Miss = SKIP — chase guard (35% of risk)
// pehle se active hai; ye usko plan-level pe le aata hai.
// DEFAULT OFF (research flag — plan 15.2).
// ------------------------------------------------------------
export function retestEntryPlan({
  side = null, breakoutLevel = null, atr = null, triggerBarTime = null,
  atrBand = null, expiryBars = ENTRY_QUALITY_DEFAULTS.retestExpiryBars, tfMs = 5 * 60_000,
} = {}) {
  const s = String(side || '').toUpperCase();
  const level = _num(breakoutLevel);
  const a = _num(atr);
  const tbt = _num(triggerBarTime);
  if ((s !== 'LONG' && s !== 'SHORT') || level == null || !(level > 0) || a == null || !(a > 0)) {
    return { available: false, reason: 'missing side/level/atr', limitPrice: null, expiryAt: null };
  }
  // v21.35.0 [A14]: triggerBarTime missing → expiryAt null banta tha par
  // plan available:true rehta tha — limit REST indefinitely karta tha
  // (policy: miss = skip, NO chase — expiry hi policy ki jaan hai). Ab
  // honest refuse: bina expiry ke plan nahi (caller fresh barTime ke saath
  // dobara plan karega).
  if (tbt == null) {
    return { available: false, reason: 'missing_trigger_bar_time', limitPrice: null, expiryAt: null };
  }
  const band = _num(atrBand) != null
    ? Math.min(ENTRY_QUALITY_DEFAULTS.retestAtrHigh, Math.max(ENTRY_QUALITY_DEFAULTS.retestAtrLow, _num(atrBand)))
    : 0.18; // mid of 0.10–0.25 default
  const limitPrice = s === 'LONG' ? level - band * a : level + band * a;
  const expiryAt = tbt != null ? tbt + expiryBars * (Number(tfMs) || 5 * 60_000) : null;
  return {
    available: true,
    side: s,
    breakoutLevel: level,
    atrBand: +band.toFixed(3),
    limitPrice: +limitPrice.toFixed(6),
    expiryBars,
    expiryAt,
    policy: 'miss = skip (NO chase)',
  };
}

/** Live tick par retest level touch check (limit fill simulation). */
export function retestTouched({ side = null, limitPrice = null, ltp = null }) {
  const s = String(side || '').toUpperCase();
  const lp = _num(limitPrice);
  const px = _num(ltp);
  if ((s !== 'LONG' && s !== 'SHORT') || lp == null || px == null) return null;
  return s === 'LONG' ? px <= lp : px >= lp;
}

// ------------------------------------------------------------
// F-f — Funding-window proximity (R4 blacklist se alag — ye sirf
// "settlement ke 3 min pehle" naye entry ka proximity flag hai).
// ------------------------------------------------------------
export function fundingWindowProximity({ nextFundingTs = null, now = Date.now() } = {}) {
  const nf = _num(nextFundingTs);
  const t = Number(now) || Date.now();
  if (nf == null) return { available: false, minutesToFunding: null, inPreWindow: false, inPostWindow: false };
  const diffMin = (nf - t) / 60_000;
  return {
    available: true,
    minutesToFunding: +diffMin.toFixed(2),
    inPreWindow: diffMin >= 0 && diffMin <= ENTRY_QUALITY_DEFAULTS.fundingWindowPreMin,
    inPostWindow: diffMin < 0 && diffMin >= -ENTRY_QUALITY_DEFAULTS.fundingWindowPostMin,
    nextFundingTs: nf,
  };
}

/**
 * Composite entry-quality verdict (veto stack ka liquiditySpread rung).
 * Ye direction ko kabhi touch nahi karta — sirf execution quality.
 */
export function evaluateEntryQuality({
  side = null, spreadBps = null, spreadHistory = [], notionalUSD = null,
  depthUSD = null, riskUSD = null, liquidityUSD = null, minLiquidityUSD = null,
  mode = 'shadow',
} = {}) {
  const m = normalizeQualityMode(mode);
  const spread = evaluateSpreadGate({ spreadBps, spreadHistory, mode: m, liquidityUSD, minLiquidityUSD });
  const slip = evaluateSlippageGate({ side, notionalUSD, depthUSD, spreadBps, riskUSD, mode: m });
  const reasons = [...(spread.wouldBlock ? spread.reasons : []), ...(slip.wouldBlock ? [slip.reason] : [])];
  const wouldBlock = reasons.length > 0;
  return {
    filter: 'entryQuality', mode: m, active: m !== 'off',
    spreadGate: spread, slippageGate: slip,
    coverage: spread.coverage || slip.coverage,
    wouldBlock, blocked: m === 'enforce' && wouldBlock, shadow: m === 'shadow',
    reason: wouldBlock ? reasons[0] : null, reasons,
  };
}
