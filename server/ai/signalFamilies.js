// ============================================================
// server/ai/signalFamilies.js — v21.33.0 [PHASE D1/D2/D3/D4]
// ------------------------------------------------------------
// MASTER PLAN Phase D: strategy families + hierarchical MTF
// alignment + grouped confluence scoring + veto stack.
//
// PURE module — no IO, deterministic, side kabhi flip nahi hota.
// Default mode SHADOW (plan 15.2): sirf label + wouldBlock verdict;
// enforce hone par bhi ye module direction DECIDE nahi karta —
// side hamesha existing MTF plan/certificate se aata hai. Ye sirf
// "is signal is family/regime me lene layak hai" ka fit answer deta
// hai. Direction authority: mtf.js + directionCertificate.js.
//
// FAMILIES (plan D1 table):
//   TREND_PULLBACK       valid: TREND_UP/TREND_DOWN (ADX≥18, ER≥0.30)
//   BREAKOUT_SQUEEZE     valid: SQUEEZE→expansion (squeezeFired)
//   MEAN_REVERSION       valid: CHOP (ADX<15, ER≤0.20) — flag-gated
//   MOMENTUM_CONTINUE    valid: HIGH_VOL trend with flow confirm
// Har family ka spec: entry hint, invalidation hint, target hint,
// valid/forbidden regimes, minScore, expected hold.
// ============================================================
import { classifyRowRegime } from './mtfRegime.js';

export const FAMILY_MODES = Object.freeze(['off', 'shadow', 'enforce']);

export const FAMILIES = Object.freeze({
  TREND_PULLBACK: Object.freeze({
    id: 'TREND_PULLBACK',
    label: 'Trend-Pullback',
    validRegimes: ['TREND_UP', 'TREND_DOWN'],
    forbiddenRegimes: ['CHOP'],
    minScore: 65,
    expectedHoldMin: 90,
    entryHint: 'HTF aligned, pullback to EMA/VWAP zone, trigger-bar reversal in trend direction',
    invalidationHint: 'close beyond pullback swing / 1.2–1.8×ATR',
    targetHint: 'prior swing / 2R–3R',
    slAtrMult: [1.2, 1.8],
    counterTrend: false,
  }),
  BREAKOUT_SQUEEZE: Object.freeze({
    id: 'BREAKOUT_SQUEEZE',
    label: 'Breakout (post-squeeze)',
    validRegimes: ['SQUEEZE', 'TREND_UP', 'TREND_DOWN'],
    forbiddenRegimes: ['CHOP'],
    minScore: 70,
    expectedHoldMin: 60,
    entryHint: 'close beyond range/BB with volume ≥1.5× & ER rising',
    invalidationHint: 'close back inside range',
    targetHint: 'measured move / ATR multiple',
    slAtrMult: [1.0, 1.5],
    counterTrend: false,
  }),
  MEAN_REVERSION: Object.freeze({
    id: 'MEAN_REVERSION',
    label: 'Mean-Reversion (range)',
    validRegimes: ['CHOP'],
    forbiddenRegimes: ['TREND_UP', 'TREND_DOWN', 'HIGH_VOL'],
    minScore: 72,
    expectedHoldMin: 45,
    entryHint: 'extreme at VAH/VAL/VWAP-2σ + RSI exhaustion + rejection candle',
    invalidationHint: 'close beyond band 0.5–1×ATR',
    targetHint: 'VWAP/POC',
    slAtrMult: [1.0, 1.4],
    // HTF-against allowed (plan D2: counter-trend explicitly allowed)
    counterTrend: true,
    requiresFlag: 'MEAN_REV_ENABLED',
  }),
  MOMENTUM_CONTINUE: Object.freeze({
    id: 'MOMENTUM_CONTINUE',
    label: 'Momentum-Continuation',
    validRegimes: ['HIGH_VOL', 'TREND_UP', 'TREND_DOWN'],
    forbiddenRegimes: ['CHOP'],
    minScore: 75,
    expectedHoldMin: 120,
    entryHint: 'strong trigger with flow confirm (volume + CVD/taker)',
    invalidationHint: 'structure break',
    targetHint: 'trail',
    slAtrMult: [1.6, 2.4],
    counterTrend: false,
  }),
});

function _num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function normalizeFamilyMode(raw, fallback = 'shadow') {
  const v = String(raw ?? '').trim().toLowerCase();
  if (v === 'enforce' || v === 'on' || v === '1' || v === 'true') return 'enforce';
  if (v === 'off' || v === '0' || v === 'false' || v === 'disabled') return 'off';
  if (v === 'shadow' || v === 'dry-run' || v === 'observe') return 'shadow';
  return fallback === 'enforce' || fallback === 'off' ? fallback : 'shadow';
}

function _regimeOf(row = {}) {
  // v21.35.0 [A4]: regime OBJECT bina string label ke String() se
  // '[OBJECT OBJECT]' fabricate hota tha — ek always-truthy fake regime jo
  // NULL/UNKNOWN checks ko pass kar jaata tha. Aisa object (ya array)
  // classifyRowRegime fallback par jaata hai (sahi evidence-based path).
  const raw = row.regime;
  if (raw != null && typeof raw === 'object' && typeof raw.label !== 'string') {
    return classifyRowRegime(row) || 'UNKNOWN';
  }
  const explicit = String(raw?.label ?? raw ?? '').trim().toUpperCase();
  if (explicit && explicit !== 'NULL' && explicit !== 'UNKNOWN') return explicit;
  return classifyRowRegime(row) || 'UNKNOWN';
}

/**
 * D1 — regime → family routing + fit verdict.
 * Pure classification: koi side decision nahi. Returns the family the
 * row's regime+trigger evidence points to, plus per-family fit.
 */
export function classifySignalFamily({
  row = {}, adx = null, er = null, squeezeFired = null, volRatio = null, meanRevEnabled = false,
} = {}) {
  const regime = _regimeOf(row);
  const ctx = row.context && typeof row.context === 'object' ? row.context : {};
  const adxE = _num(adx ?? ctx.adx ?? row.adx);
  const erE = _num(er ?? ctx.er ?? row.er);
  const sqf = squeezeFired ?? ctx.squeezeFired ?? row.squeezeFired ?? (row.context?.squeezeFired ?? null);
  const volE = _num(volRatio ?? row.trigger?.volRatio);
  const trigDir = _num(row.trigger?.dir);

  const evidence = { regime, adx: adxE, er: erE, squeezeFired: sqf == null ? null : Boolean(sqf), volRatio: volE };
  const fits = {};

  // TREND_PULLBACK: directional ADX + efficient tape + trigger aligned
  const trendish = regime === 'TREND_UP' || regime === 'TREND_DOWN';
  const adxOk = adxE == null ? null : adxE >= 18;
  const erOk = erE == null ? null : erE >= 0.30;
  fits.TREND_PULLBACK = {
    family: 'TREND_PULLBACK',
    regimeOk: trendish,
    adxOk, erOk,
    triggerAligned: trigDir == null ? null : (trendish ? (regime === 'TREND_UP' ? trigDir > 0 : trigDir < 0) : null),
    wouldBlock: regime === 'CHOP',
    reason: regime === 'CHOP' ? 'CHOP me trend-follow default block (D1)' : null,
  };

  // BREAKOUT_SQUEEZE: squeeze fired OR breakout-shaped trigger with volume
  const volOk = volE == null ? null : volE >= 1.5;
  fits.BREAKOUT_SQUEEZE = {
    family: 'BREAKOUT_SQUEEZE',
    regimeOk: regime === 'SQUEEZE' || Boolean(sqf),
    squeezeFired: sqf == null ? null : Boolean(sqf),
    volOk,
    wouldBlock: false,
    reason: null,
  };

  // MEAN_REVERSION: CHOP only + flag-gated (plan: sirf meanRevEnabled)
  const chopOk = regime === 'CHOP';
  const adxChop = adxE == null ? null : adxE < 15;
  const erChop = erE == null ? null : erE <= 0.20;
  fits.MEAN_REVERSION = {
    family: 'MEAN_REVERSION',
    regimeOk: chopOk,
    adxChop, erChop,
    flagEnabled: Boolean(meanRevEnabled),
    wouldBlock: !chopOk || !meanRevEnabled,
    reason: !meanRevEnabled
      ? 'meanRevEnabled flag off — mean-reversion family inactive (D1)'
      : (!chopOk ? `mean-reversion sirf CHOP me (regime=${regime})` : null),
  };

  // MOMENTUM_CONTINUE: HIGH_VOL trend + strong trigger + flow
  const highVolTrend = (regime === 'HIGH_VOL' && trendish) || regime === 'HIGH_VOL';
  fits.MOMENTUM_CONTINUE = {
    family: 'MOMENTUM_CONTINUE',
    regimeOk: highVolTrend,
    volOk,
    wouldBlock: regime === 'CHOP',
    reason: regime === 'CHOP' ? 'CHOP me momentum-continuation block (D1)' : null,
  };

  // Primary family: strongest evidence first
  let primary = null;
  if (fits.BREAKOUT_SQUEEZE.regimeOk && (fits.BREAKOUT_SQUEEZE.squeezeFired === true)) primary = 'BREAKOUT_SQUEEZE';
  else if (fits.TREND_PULLBACK.regimeOk && (adxOk !== false) && (erOk !== false)) primary = 'TREND_PULLBACK';
  else if (fits.MOMENTUM_CONTINUE.regimeOk && volOk !== false) primary = 'MOMENTUM_CONTINUE';
  else if (fits.MEAN_REVERSION.regimeOk && meanRevEnabled) primary = 'MEAN_REVERSION';
  else if (trendish) primary = 'TREND_PULLBACK';

  return {
    regime,
    primary,
    evidence,
    fits,
    spec: primary ? FAMILIES[primary] : null,
  };
}

/**
 * D1 — family/regime FIT gate (shadow default). Family ke validRegimes
 * me regime hona + forbiddenRegimes me na hona + minScore meet.
 */
export function evaluateFamilyFit({
  row = {}, side = null, family = null, mode = 'shadow', score = null, meanRevEnabled = false,
} = {}) {
  const m = normalizeFamilyMode(mode);
  const s = String(side ?? row.side ?? '').toUpperCase();
  const fam = FAMILIES[family] ? family : classifySignalFamily({ row, meanRevEnabled }).primary;
  const regime = _regimeOf(row);
  const reasons = [];
  if (!fam) {
    return {
      filter: 'familyFit', mode: m, active: m !== 'off', family: null, regime, side: s,
      wouldBlock: false, blocked: false, shadow: m === 'shadow', reason: 'no family classified (evidence insufficient)',
      reasons: [], verdict: 'NEUTRAL',
    };
  }
  const spec = FAMILIES[fam];
  // v21.35.0 [A4]: row.score bhi fallback chain me — kuch callers fv:2
  // rows superScore ke bajaye score field par laate hain, warna minScore
  // check silently skip hota tha (sc null → no block).
  const sc = _num(score ?? row.superScore ?? row.score ?? row.context?.score);
  if (!spec.validRegimes.includes(regime)) reasons.push(`${regime} not in ${fam} valid regimes (${spec.validRegimes.join('/')})`);
  if (spec.forbiddenRegimes.includes(regime)) reasons.push(`${regime} is FORBIDDEN for ${fam}`);
  if (sc != null && sc < spec.minScore) reasons.push(`score ${sc} < family minScore ${spec.minScore}`);
  const wouldBlock = reasons.length > 0;
  return {
    filter: 'familyFit', mode: m, active: m !== 'off', family: fam, regime, side: s,
    validRegimes: spec.validRegimes, forbiddenRegimes: spec.forbiddenRegimes,
    minScore: spec.minScore, expectedHoldMin: spec.expectedHoldMin,
    slAtrMult: spec.slAtrMult,
    wouldBlock, blocked: m === 'enforce' && wouldBlock, shadow: m === 'shadow',
    reason: wouldBlock ? reasons[0] : null, reasons,
  };
}

// ------------------------------------------------------------
// D2 — Hierarchical MTF alignment (HTF veto layer)
// 3-layer permission model, additive nahi hierarchical:
//   L1 HTF (4h/1d bias)  — veto power (counter-trend only if family allows)
//   L2 Context TF        — trend + structure + regime
//   L3 Trigger TF        — closed-bar trigger
// Agreement = weighted fraction of aligned layers.
// ------------------------------------------------------------
export function evaluateHierarchicalMtf({
  side = null, htfBias = null, contextDir = null, triggerDir = null, family = null,
  mode = 'shadow', strictScore = 82, score = null,
} = {}) {
  const m = normalizeFamilyMode(mode);
  const s = String(side || '').toUpperCase();
  const sSign = s === 'LONG' ? 1 : s === 'SHORT' ? -1 : 0;
  const htf = String(htfBias ?? '').toUpperCase(); // BULLISH | BEARISH | NEUTRAL | ''
  const htfSign = htf === 'BULLISH' ? 1 : htf === 'BEARISH' ? -1 : 0;
  const ctxDir = _num(contextDir);
  const trigDir = _num(triggerDir);
  const fam = FAMILIES[family] ? family : null;
  const counterAllowed = fam ? FAMILIES[fam].counterTrend === true : false;

  const layers = [
    { layer: 'HTF', weight: 0.40, sign: htfSign, available: htfSign !== 0 || htf === 'NEUTRAL' },
    { layer: 'CONTEXT', weight: 0.35, sign: ctxDir == null ? 0 : Math.sign(ctxDir), available: ctxDir != null },
    { layer: 'TRIGGER', weight: 0.25, sign: trigDir == null ? 0 : Math.sign(trigDir), available: trigDir != null },
  ];
  const available = layers.filter(l => l.available);
  const weightSum = available.reduce((a, l) => a + l.weight, 0);
  const alignedWeight = available.filter(l => l.sign === sSign && sSign !== 0).reduce((a, l) => a + l.weight, 0);
  const againstWeight = available.filter(l => l.sign === -sSign && sSign !== 0).reduce((a, l) => a + l.weight, 0);
  const agreement = weightSum > 0 ? +(alignedWeight / weightSum).toFixed(4) : null;
  const disagreement = weightSum > 0 ? +(againstWeight / weightSum).toFixed(4) : null;

  const reasons = [];
  let htfVeto = false;
  if (sSign !== 0 && htfSign === -sSign) {
    if (!counterAllowed) {
      htfVeto = true;
      reasons.push(`HTF ${htf} against ${s} and family ${fam || '?'} is not counter-trend-allowed`);
    } else {
      // v21.34.0 [STRICT-SCORE ENFORCED]: pehle counter-trend waiver ke
      // saath "stricter score 82 required" sirf ek STRING tha — koi rule
      // exist nahi karta tha, koi bhi score (30 bhi) pass ho jata tha. Ab
      // score diya gaya ho aur strictScore se kam ho → counter-trend
      // entry block (enforce me). Score null (unknown) → waiver honest
      // fail-open (fabricated block mana hai).
      const scoreNum = _num(score);
      if (scoreNum != null && scoreNum < strictScore) {
        htfVeto = true;
        reasons.push(`HTF ${htf} against ${s} — counter-trend family ${fam} allowed PAR score ${scoreNum} < strict ${strictScore} → block`);
      } else {
        reasons.push(`HTF ${htf} against ${s} — counter-trend allowed (family ${fam})${scoreNum != null ? ` — score ${scoreNum} ≥ strict ${strictScore}` : ` — score unknown (fail-open), strict ${strictScore} required jab score mile`}`);
      }
    }
  }
  if (ctxDir != null && Math.sign(ctxDir) === -sSign && sSign !== 0) {
    reasons.push(`context TF against ${s}`);
  }
  const wouldBlock = htfVeto;
  return {
    filter: 'hierarchicalMtf', mode: m, active: m !== 'off', side: s, family: fam,
    layers: layers.map(l => ({ layer: l.layer, sign: l.sign, available: l.available })),
    agreement, disagreement, weightSum: +weightSum.toFixed(4),
    htfVeto, strictScore,
    wouldBlock, blocked: m === 'enforce' && wouldBlock, shadow: m === 'shadow',
    reason: wouldBlock ? reasons[0] : null, reasons,
  };
}

// ------------------------------------------------------------
// D3 — Grouped confluence scoring (correlation-aware)
// Components ko evidence-GROUPS me daalo taaki ek hi information
// double-count na ho (RSI+StochRSI+MACD teeno momentum hain = ek
// group cap). Per-group cap = max 25% of score. Missing-source
// renormalization: jo groups available hain unke weights ko total
// me normalize karo, weightSum log karo.
// ------------------------------------------------------------
export const CONFLUENCE_GROUPS = Object.freeze({
  trend: { cap: 0.25, components: ['emaStack', 'supertrend', 'adx'] },
  momentum: { cap: 0.25, components: ['rsi', 'macd', 'roc'] },
  structure: { cap: 0.25, components: ['smc', 'structure', 'supplyDemand'] },
  flow: { cap: 0.20, components: ['volumeProfile', 'cvd', 'liquiditySweep'] },
  volatility: { cap: 0.15, components: ['squeeze', 'bbWidth', 'atrPercentile'] },
  derivatives: { cap: 0.15, components: ['funding', 'longShortRatio', 'basis'] },
  context: { cap: 0.15, components: ['htfBias', 'mtf6', 'vwap'] },
});

/**
 * components: [{ group, k, dir(+1/-1/0), weight? }] — dir side ke
 * perspective me ALIGNED (+1) ya AGAINST (−1) hai.
 * v21.34.0 [SCALE HONESTY]: `score` ab TRUE [0..1] hai — raw group
 * contributions ko totalCap (1.40) se normalize karke. Pehle raw
 * sum (max 1.40) hi `score` tha jabki docstring [0..1] bolta tha —
 * koi bhi consumer "score ≥ 0.9 = strong" jaisi threshold galat
 * scale par compare karta. `rawScore` (0..1.40) debugging ke liye
 * exposed; `weightSum` ab AVAILABLE groups ki cap-coverage hai
 * (missing-source renormalization jo docstring hamesha bolta tha).
 */
export function groupedConfluenceScore(components = [], { side = null } = {}) {
  const s = String(side || '').toUpperCase();
  const sSign = s === 'LONG' ? 1 : s === 'SHORT' ? -1 : 0;
  const valid = (Array.isArray(components) ? components : [])
    .map(c => ({
      group: String(c?.group || '').toLowerCase(),
      k: String(c?.k || '?'),
      dir: _num(c?.dir) == null ? 0 : Math.sign(_num(c.dir)),
      weight: _num(c?.weight) == null ? 1 : Math.max(0, _num(c.weight)),
    }))
    .filter(c => c.group && CONFLUENCE_GROUPS[c.group] && sSign !== 0);
  const groupState = {};
  for (const g of Object.keys(CONFLUENCE_GROUPS)) {
    groupState[g] = { aligned: 0, against: 0, weight: 0, capped: false };
  }
  for (const c of valid) {
    const st = groupState[c.group];
    st.weight += c.weight;
    if (c.dir === sSign) st.aligned += c.weight;
    else if (c.dir === -sSign) st.against += c.weight;
  }
  // per-group net aligned fraction × group weight, capped at group cap
  let raw = 0;
  let availableCap = 0; // v21.34.0: available groups ki cap sum (weightSum ke liye)
  const breakdown = [];
  for (const [g, st] of Object.entries(groupState)) {
    if (st.weight <= 0) { breakdown.push({ group: g, available: false, contribution: 0 }); continue; }
    const frac = Math.max(0, (st.aligned - st.against) / st.weight); // 0..1 aligned fraction
    const cap = CONFLUENCE_GROUPS[g].cap;
    const contribution = Math.min(cap, frac * cap);
    raw += contribution;
    availableCap += cap;
    breakdown.push({
      group: g, available: true,
      aligned: +st.aligned.toFixed(3), against: +st.against.toFixed(3),
      frac: +frac.toFixed(3), cap, contribution: +contribution.toFixed(4),
      // v21.34.0: `capped` ka matlab ab honest hai — group ka contribution
      // apne cap pe pahunch gaya (fully aligned). Purana `frac*cap > cap`
      // kabhi true ho hi nahi sakta tha (frac ≤ 1) — dead flag tha.
      capped: frac >= 0.999,
    });
  }
  const totalCap = Object.values(CONFLUENCE_GROUPS).reduce((a, g) => a + g.cap, 0);
  // v21.34.0: weightSum = available groups ki cap coverage (evidence
  // availability) — pehle raw/totalCap tha jo availability nahi, score hi tha.
  const weightSum = +((totalCap > 0 ? availableCap / totalCap : 0)).toFixed(4);
  return {
    score: +(totalCap > 0 ? raw / totalCap : 0).toFixed(4), // TRUE [0..1] normalized
    rawScore: +raw.toFixed(4), // 0..totalCap — un-normalized (debug/back-compat)
    weightSum,
    groups: breakdown,
    side: s || null,
  };
}

// ------------------------------------------------------------
// D4 — Veto stack (ordered; fail-closed on contradiction,
// fail-open on missing data). Ye COMPOSER hai: individual guards
// kahin aur evaluate hote hain (tradeGuards/entryQuality/etc.) —
// yahan unke verdicts ordered stack me aa kar ek decision bante
// hain. Missing data par block NAHI (fabricated block mana hai) —
// coverage metric alag se report hota hai.
// ------------------------------------------------------------
export const VETO_STACK_ORDER = Object.freeze([
  'priceCrosscheck',
  'liquiditySpread',
  'entryTiming',
  'eventSession',
  'regimeFamilyFit',
  'perpCrowding',
  'cluster',
  'reversalRisk',
  'directionCertificate',
  'riskCaps',
]);

/**
 * verdicts: { [name]: { available: boolean, wouldBlock: boolean, reason?: string } }
 * Returns the composed stack decision. CONTRADICTION fail-closed:
 * agar direction certificate invalid hai → hard block (ye safety hai).
 * MISSING (available:false) → skip (fail-open) + coverage me count.
 */
export function composeVetoStack(verdicts = {}, { mode = 'shadow' } = {}) {
  const m = normalizeFamilyMode(mode);
  const stack = [];
  for (const name of VETO_STACK_ORDER) {
    const v = verdicts?.[name];
    if (!v || typeof v !== 'object') {
      stack.push({ name, available: false, wouldBlock: false, reason: 'not evaluated (missing data — fail-open)' });
      continue;
    }
    const available = v.available !== false;
    stack.push({
      name,
      available,
      wouldBlock: available && v.wouldBlock === true,
      reason: v.reason ? String(v.reason).slice(0, 140) : null,
    });
  }
  const evaluated = stack.filter(s => s.available);
  const blocking = evaluated.filter(s => s.wouldBlock);
  const coverage = stack.length ? +(evaluated.length / stack.length).toFixed(4) : 0;
  // fail-closed contradiction: certificate invalid → block regardless
  const cert = stack.find(s => s.name === 'directionCertificate');
  const certInvalid = cert?.available === true && cert.wouldBlock === true;
  const wouldBlock = certInvalid || blocking.length > 0;
  return {
    filter: 'vetoStack', mode: m, active: m !== 'off',
    stack, coverage,
    blockingCount: blocking.length,
    firstBlock: blocking[0]?.name ?? null,
    wouldBlock, blocked: m === 'enforce' && wouldBlock, shadow: m === 'shadow',
    reason: blocking[0]?.reason ?? (certInvalid ? 'direction certificate INVALID' : null),
    reasons: blocking.map(b => `${b.name}: ${b.reason || 'blocked'}`),
    failClosedOn: certInvalid ? 'directionCertificate' : null,
  };
}
