// ============================================================
// scripts/lib/tripleBarrier.js — v21.32.0 PHASE A2 LABELER
// ------------------------------------------------------------
// MASTER PLAN (Phase A2): conservative triple-barrier labeling.
// Har logged signal ke liye {TP2, TP1, SL, TIMEOUT} label + MFE/MAE
// + time-to-touch. "Conservative" = agar ek hi bar me SL aur TP dono
// touch hon → SL pehle maano (worst-case pehle).
//
// Bar levels SYSTEM KE ACTUAL PLAN se aate hain (entry/SL/TP1/TP2 jo
// plan ne diye) — koi hypothetical barriers nahi.
//
// PURE module — koi IO nahi. Tests: test/tripleBarrierV21320.test.ts
// ============================================================

/**
 * Label one signal with the conservative triple-barrier method.
 *
 * @param {object} p
 * @param {'LONG'|'SHORT'} p.side
 * @param {number} p.entry       planned entry price (> 0)
 * @param {number} p.sl          planned stop-loss price (> 0)
 * @param {number} p.tp1         planned TP1 price (> 0)
 * @param {number} [p.tp2]       planned TP2 price (optional; null → TP1 only)
 * @param {Array<{t?:number,h:number,l:number,c?:number}>} p.bars  bars AFTER entry
 * @param {number} p.horizon     max bars to scan (plan suggestedHoldMin / TF, fallback 48)
 * @returns {{label:'TP2'|'TP1'|'SL'|'TIMEOUT', bar:number, mfe:number, mae:number,
 *   timeToTouch:number|null, tp2Provided:boolean}|null}
 *   null jab inputs invalid hon (honest refusal — fabricated label nahi).
 */
export function labelSignal({ side, entry, sl, tp1, tp2, bars, horizon }) {
  const long = side === 'LONG';
  const e = Number(entry), s = Number(sl), t1 = Number(tp1);
  const t2 = tp2 == null ? null : Number(tp2);
  const h = Number(horizon);
  if (!(e > 0) || !(s > 0) || !(t1 > 0)) return null;
  if (side !== 'LONG' && side !== 'SHORT') return null;
  if (!Array.isArray(bars) || bars.length === 0) return null;
  if (!Number.isFinite(h) || h <= 0) return null;
  // Direction sanity: LONG me SL neeche + TP upar hona chahiye (SHORT ulta).
  // Ulta plan = invalid labeling input, label nahi banega.
  if (long ? (s >= e || t1 <= e) : (s <= e || t1 >= e)) return null;
  if (t2 != null && !Number.isFinite(t2)) return null;
  if (t2 != null && (long ? t2 <= t1 : t2 >= t1)) return null;

  const scanBars = Math.min(bars.length, Math.floor(h));
  let mfe = 0, mae = 0;
  for (let i = 0; i < scanBars; i++) {
    const b = bars[i];
    const hi = Number(b?.h ?? b?.high);
    const lo = Number(b?.l ?? b?.low);
    if (!Number.isFinite(hi) || !Number.isFinite(lo) || !(hi > 0) || !(lo > 0)) continue;
    const favour = long ? hi - e : e - lo;
    const adverse = long ? e - lo : hi - e;
    mfe = Math.max(mfe, favour);
    mae = Math.max(mae, adverse);
    const hitSl = long ? lo <= s : hi >= s;
    const hitTp2 = t2 != null && (long ? hi >= t2 : lo <= t2);
    const hitTp1 = long ? hi >= t1 : lo <= t1;
    // CONSERVATIVE ORDER: SL pehle check — same-bar SL+TP tie → SL wins.
    if (hitSl) return { label: 'SL', bar: i, mfe, mae, timeToTouch: i, tp2Provided: t2 != null };
    if (hitTp2) return { label: 'TP2', bar: i, mfe, mae, timeToTouch: i, tp2Provided: true };
    if (hitTp1) return { label: 'TP1', bar: i, mfe, mae, timeToTouch: i, tp2Provided: t2 != null };
    // TP1 note: runner continues in sim — outcome resolver (signalLedger)
    // TP1-hit rows ko pending-with-runner treat karta hai; ye labeler
    // barrier-first-touch hi bolta hai.
  }
  return { label: 'TIMEOUT', bar: Math.floor(h), mfe, mae, timeToTouch: null, tp2Provided: t2 != null };
}

/**
 * Label a resolved MTF ledger row (schemaVersion 2, A3) using its stored
 * plan levels. Convenience wrapper — ledger rows already carry
 * entry/stopLoss/t1/t2/holdMin; horizon = holdMin (minutes) ko caller
 * bars me convert karta hai (ya fallback 48 bars).
 */
export function labelLedgerRow(row, { bars, horizonBars = null } = {}) {
  if (!row || typeof row !== 'object') return null;
  const horizon = Number.isFinite(Number(horizonBars)) && Number(horizonBars) > 0
    ? Number(horizonBars)
    : 48;
  return labelSignal({
    side: String(row.side || '').toUpperCase(),
    entry: row.entry,
    sl: row.stopLoss,
    tp1: row.t1,
    tp2: row.t2,
    bars: Array.isArray(bars) ? bars : [],
    horizon,
  });
}

/**
 * A1 "Direction accuracy @H": H bars baad close, signal direction me
 * `>= 0.5 × ATR` move? Returns true/false/null (null = data insufficient —
 * honest unknown).
 */
export function directionAccuracyAtH({ side, entry, atr, closeAtH }) {
  const e = Number(entry), a = Number(atr), c = Number(closeAtH);
  if (!(e > 0) || !(a > 0) || !(c > 0)) return null;
  const long = String(side || '').toUpperCase() === 'LONG';
  const move = long ? c - e : e - c;
  return move >= 0.5 * a;
}
