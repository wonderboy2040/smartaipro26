// ============================================================
// server/ai/lib/candleIntegrity.js — v21.32.0 [PHASE B1]
// ------------------------------------------------------------
// MASTER PLAN: candle integrity layer — PURE functions.
//   • duplicate timestamps drop, out-of-order sort
//   • gap detection (missing bars → gapCount + degraded flag)
//   • partial/forming bar detection (closed-only slice for decisions)
//   • outlier wick filter (wick > N×ATR + volume ~0 → suspect)
//
// KYON: indicators (RSI/ATR/ADX/VWAP…) corrupted series par chup-chaap
// galat values dete hain. Ye layer series ko CLEAN karke deta hai aur
// honest "degraded" telemetry — guess nahi.
//
// PURE — koi IO/clock nahi (`now` caller deta hai, tests deterministic).
// Tests: test/candleIntegrityV21320.test.ts
// ============================================================

/** ms → minutes label helper (5m/15m/1h…) */
export function tfMinutesMs(tfMin) {
  const m = Number(tfMin);
  return Number.isFinite(m) && m > 0 ? Math.round(m * 60_000) : null;
}

function _ts(c) {
  const raw = Number(c?.ts ?? c?.time ?? c?.t ?? c?.timestamp);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  return raw < 1e11 ? raw * 1000 : raw; // sec → ms
}

/**
 * Core integrity pass.
 *
 * @param {Array} candles raw series (any order, may contain dupes/gaps/forming bar)
 * @param {object} opts
 * @param {number} opts.tfMin          timeframe in minutes (gap detection + forming-bar close time)
 * @param {number} [opts.now]          epoch ms (default Date.now())
 * @param {number} [opts.maxGaps]      is se zyada gaps → degraded (default 3)
 * @returns {{candles:Array, cleaned:Array, droppedDuplicates:number, reordered:boolean,
 *   gapCount:number, missingBars:number, degraded:boolean, lastBarClosed:boolean|null,
 *   lastBarAgeMs:number|null, formingBarDropped:number, issues:string[]}}
 */
export function cleanCandles(candles, { tfMin = 5, now = Date.now(), maxGaps = 3 } = {}) {
  const issues = [];
  const src = Array.isArray(candles) ? candles.filter((c) => c && Number(c?.close) > 0) : [];
  if (src.length === 0) {
    return {
      candles: [], cleaned: [], droppedDuplicates: 0, reordered: false,
      gapCount: 0, missingBars: 0, degraded: false, lastBarClosed: null,
      lastBarAgeMs: null, formingBarDropped: 0, issues: ['no usable candles'],
    };
  }
  const tfMs = tfMinutesMs(tfMin) ?? 5 * 60_000;

  // 1) timestamps ke saath pair; timestamp-less bars END me preserve
  //    (drop nahi — unka OHLC data valid hai, sirf gap-detect me use nahi
  //    ho sakte). closed-only view unhe conservative drop karta hai.
  const stamped = [], unstamped = [];
  for (const c of src) {
    const t = _ts(c);
    if (t == null) unstamped.push(c);
    else stamped.push({ t, c });
  }
  if (unstamped.length) issues.push(`${unstamped.length} bar(s) without timestamp (kept at end, order-only)`);

  // 2) out-of-order detect + sort (ascending)
  let reordered = false;
  for (let i = 1; i < stamped.length; i++) {
    if (stamped[i].t < stamped[i - 1].t) { reordered = true; break; }
  }
  if (reordered) {
    stamped.sort((a, b) => a.t - b.t);
    issues.push('out-of-order bars sorted ascending');
  }

  // 3) duplicate timestamps drop (sirf last occurrence rakho — exchange
  //    finalize hone par wahi complete bar hota hai)
  const seen = new Map();
  let droppedDuplicates = 0;
  for (const { t, c } of stamped) {
    if (seen.has(t)) droppedDuplicates++;
    seen.set(t, c);
  }
  if (droppedDuplicates > 0) issues.push(`${droppedDuplicates} duplicate-timestamp bar(s) dropped`);

  const uniq = [...seen.entries()].map(([t, c]) => ({ ...c, _tsMs: t }));
  // timestamp-less bars end me (order preserved) — gap detection me nahi
  const kept = [...uniq, ...unstamped.map((c) => ({ ...c, _tsMs: null }))];

  // 4) gap detection — consecutive bars me tfMs ka integer multiple hona
  //    chahiye; beech me kitne bars missing the.
  let gapCount = 0, missingBars = 0;
  for (let i = 1; i < uniq.length; i++) {
    const diff = uniq[i]._tsMs - uniq[i - 1]._tsMs;
    if (diff <= 0) continue;
    const bars = Math.round(diff / tfMs);
    if (bars > 1 && diff % tfMs < tfMs * 0.25) { // ~aligned grid pe hi ginno
      gapCount++;
      missingBars += bars - 1;
    }
  }
  if (gapCount > 0) issues.push(`${gapCount} gap(s) → ${missingBars} missing bar(s)`);

  // 5) forming-bar detection: last STAMPED bar ka close-time abhi aaya hai?
  //    closeTime = openTime + tfMs. closeTime > now → FORMING (partial).
  //    (unstamped tail par status unknown rehta hai — closed-only view
  //    use conservative drop karta hai.)
  const lastStamped = uniq[uniq.length - 1] ?? null;
  let lastBarClosed = null, lastBarAgeMs = null;
  if (lastStamped) {
    const lastCloseTime = lastStamped._tsMs + tfMs;
    const age = Number(now) - lastCloseTime;
    lastBarAgeMs = Number.isFinite(age) ? Math.round(age) : null;
    lastBarClosed = age >= 0 ? true : (age > -tfMs ? false : null);
  }

  const degraded = gapCount > maxGaps;
  if (degraded) issues.push(`degraded: ${gapCount} gaps > ${maxGaps} — indicators par trust kam rakho`);

  return {
    candles: kept.map(({ _tsMs, ...c }) => c),
    cleaned: kept.map(({ _tsMs, ...c }) => c),
    droppedDuplicates: droppedDuplicates,
    reordered,
    gapCount,
    missingBars,
    degraded,
    lastBarClosed,
    lastBarAgeMs: Number.isFinite(lastBarAgeMs) ? Math.round(lastBarAgeMs) : null,
    formingBarDropped: 0,
    issues,
  };
}

/**
 * Closed-only slice — decision features (C1 non-repainting rule) ke liye.
 * Forming last bar drop hota hai jab wo abhi close nahi hui. `pass` ka
 * `.cleaned` use karta hai taaki dupes/order pehle hi settle hon.
 */
export function closedOnlyCandles(candles, { tfMin = 5, now = Date.now(), graceMs = 0 } = {}) {
  const pass = cleanCandles(candles, { tfMin, now });
  const tfMs = tfMinutesMs(tfMin) ?? 5 * 60_000;
  const list = pass.cleaned;
  if (list.length === 0) return { ...pass, candles: [], formingBarDropped: 0, issues: [...pass.issues] };
  const last = list[list.length - 1];
  const t = _ts(last);
  if (t == null) {
    // timestamp nahi → closed-status UNKNOWN → conservative: drop last bar
    // (decision features ke liye unknown-forming bar risk nahi le sakte).
    return {
      ...pass,
      candles: list.slice(0, -1),
      formingBarDropped: 1,
      issues: [...pass.issues, 'last bar timestamp missing — dropped for closed-only view'],
    };
  }
  const closedAt = (t + tfMs + Number(graceMs)) || 0;
  if (closedAt > Number(now)) {
    return {
      ...pass,
      candles: list.slice(0, -1),
      formingBarDropped: 1,
      issues: [...pass.issues, 'forming (partial) last bar dropped for closed-only view'],
    };
  }
  return { ...pass, candles: list, formingBarDropped: 0, issues: pass.issues };
}

/**
 * Outlier tick/wick filter (B1): wick > `wickAtrMult`×ATR **aur** volume ≈ 0
 * → suspect bar. Suspect bars ko replace nahi karte — unhe flag karte hain
 * taaki signal trigger unse exclude ho sake (caller decide karta hai).
 * PURE.
 */
export function detectOutlierBars(candles, { atrPeriod = 14, wickAtrMult = 4, volZeroMax = 1e-9 } = {}) {
  const list = Array.isArray(candles) ? candles : [];
  if (list.length < atrPeriod + 1) return { suspects: [], atr: null, n: list.length };
  // local ATR (Wilder-style seed nahi — simple mean of TR; sirf outlier
  // gating ke liye hai, display indicator nahi)
  const trs = [];
  for (let i = 1; i < list.length; i++) {
    const h = Number(list[i].high), l = Number(list[i].low), pc = Number(list[i - 1].close);
    if (Number.isFinite(h) && Number.isFinite(l) && Number.isFinite(pc)) {
      trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    }
  }
  if (trs.length < atrPeriod) return { suspects: [], atr: null, n: list.length };
  const atr = trs.slice(-atrPeriod).reduce((a, b) => a + b, 0) / atrPeriod;
  const suspects = [];
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    const h = Number(c.high), l = Number(c.low), o = Number(c.open), cl = Number(c.close);
    const vol = Number(c.volume ?? c.vol ?? 0);
    if (![h, l, o, cl].every(Number.isFinite)) continue;
    const upperWick = h - Math.max(o, cl);
    const lowerWick = Math.min(o, cl) - l;
    const maxWick = Math.max(upperWick, lowerWick);
    const volZero = !Number.isFinite(vol) || vol <= volZeroMax;
    if (maxWick > wickAtrMult * atr && volZero) {
      suspects.push({
        index: i,
        ts: _ts(c),
        wickOverAtr: Math.round((maxWick / Math.max(1e-12, atr)) * 100) / 100,
        volume: Number.isFinite(vol) ? vol : null,
        reason: 'wick > mult×ATR with ~zero volume (suspect 1-tick spike)',
      });
    }
  }
  return { suspects, atr: Math.round(atr * 1e6) / 1e6, n: list.length };
}
