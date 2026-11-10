// ============================================================
// server/ai/lib/strategies/smartMoney.js — the 5 Smart Money / ICT classics
// ------------------------------------------------------------
//   1. Liquidity Sweep Reversal (session level, kill-zone, sweep ≥0.1 ATR)
//   2. FVG Retest (1.5 ATR displacement, 0.1 ATR gap, 20 bars, EMA200)
//   3. Sweep + Structure Shift (BOS/CHoCH) + FVG confluence
//   4. ICT Silver Bullet (NY 10–11am window, bias + FVG)
//   5. Order Block Retest (institutional OB + structure)
// ============================================================
import { atr, emaSeries, fairValueGap } from '../indicators.js';
import {
  detectOrderBlock, detectSweep, ictKillZone, swingStructure,
} from '../smc.js';
import {
  candleTs, closeArr, inUtcWindow, rrLevels, vote,
} from './common.js';

function lastTs(candles) {
  for (let i = candles.length - 1; i >= 0; i--) {
    const t = candleTs(candles[i]);
    if (t != null) return t;
  }
  return null;
}

function atrPct(candles) {
  const a = atr(candles, 14);
  const close = candles[candles.length - 1]?.close;
  if (!(a > 0) || !(close > 0)) return null;
  return { a, pct: (a / close) * 100 };
}

function liquiditySweepReversal(candles) {
  if (candles.length < 25) return null;
  const sweep = detectSweep(candles, 3);
  if (!sweep) {
    return vote({
      id: 'liquidity_sweep_reversal', name: 'Liquidity Sweep Reversal', family: 'smartMoney',
      reasons: ['No liquidity sweep in last 3 bars — standing aside'],
    });
  }
  const ap = atrPct(candles);
  const minWick = ap ? ap.pct * 0.1 : 0;
  const wickOk = sweep.wick >= minWick;
  const ts = lastTs(candles);
  const kz = ts != null ? ictKillZone(ts) : { inZone: false, name: 'unknown' };
  const dir = sweep.dir;
  let strength = 0.52;
  if (wickOk) strength += 0.12;
  if (kz.inZone) strength += 0.12;
  if (sweep.barAge <= 1) strength += 0.08;
  const close = candles[candles.length - 1].close;
  const stop = dir === 1
    ? Math.min(...candles.slice(-3).map(c => c.low))
    : Math.max(...candles.slice(-3).map(c => c.high));
  return vote({
    id: 'liquidity_sweep_reversal', name: 'Liquidity Sweep Reversal', family: 'smartMoney',
    dir, strength,
    reasons: [`${sweep.type} @ ${sweep.level.toFixed(4)} (wick ${sweep.wick.toFixed(2)}%)${kz.inZone ? ` · ${kz.name} kill-zone` : ''}`],
    levels: rrLevels({ dir, entry: close, stop }),
    meta: { sweep, killZone: kz.name, wickOk, minWickPct: minWick },
  });
}

function fvgRetest(candles) {
  if (candles.length < 30) return null;
  const fvg = fairValueGap(candles, { lookback: 20 });
  if (!fvg) return null;
  const ap = atrPct(candles);
  const zone = fvg.dir === 1 ? fvg.bullishFvg : fvg.bearishFvg;
  const gapSize = zone ? Math.abs(zone.top - zone.bottom) : 0;
  const gapOk = ap ? gapSize >= ap.a * 0.1 : gapSize > 0;
  const tapped = fvg.dir === 1 ? fvg.inBullFvgTap : fvg.inBearFvgTap;
  const closes = closeArr(candles);
  const e200 = closes.length >= 200 ? emaSeries(closes, 200) : null;
  const ema200 = e200 ? e200[e200.length - 1] : null;
  const close = closes[closes.length - 1];
  const filterOk = ema200 == null ? null : (fvg.dir === 1 ? close > ema200 : close < ema200);
  const dir = tapped && gapOk && filterOk !== false ? fvg.dir : 0;
  let strength = dir === 0 ? 0 : 0.72;
  if (dir !== 0 && filterOk === true) strength += 0.06;
  return vote({
    id: 'fvg_retest', name: 'FVG Retest', family: 'smartMoney',
    dir, strength,
    reasons: [dir !== 0
      ? `${fvg.activeType} — 20-bar FVG retest${filterOk === true ? ' + EMA200 filter' : ''}`
      : tapped
        ? `FVG tapped but ${gapOk ? 'EMA200 filter opposes' : 'gap < 0.1 ATR'}`
        : `FVG ${fvg.dir === 1 ? 'bullish' : fvg.dir === -1 ? 'bearish' : 'none'} — no retest`],
    levels: dir !== 0 && zone
      ? rrLevels({ dir, entry: close, stop: dir === 1 ? zone.bottom - (ap?.a || 0) * 0.1 : zone.top + (ap?.a || 0) * 0.1 })
      : null,
    meta: { activeType: fvg.activeType, gapAtr: ap && ap.a > 0 ? gapSize / ap.a : null, filterOk, ema200 },
  });
}

function sweepStructureFvg(candles) {
  if (candles.length < 40) return null;
  const sweep = detectSweep(candles, 5);
  const structure = swingStructure(candles, { strength: 3, lookback: 120 });
  const fvg = fairValueGap(candles, { lookback: 20 });
  const structDir = structure?.event && structure.event.barAge <= 20 ? structure.event.dir : 0;
  const fvgDir = fvg?.dir || 0;
  const sweepDir = sweep?.dir || 0;
  const aligned = sweepDir !== 0 && sweepDir === structDir && structDir === fvgDir;
  const close = candles[candles.length - 1].close;
  const dir = aligned ? sweepDir : 0;
  return vote({
    id: 'sweep_structure_fvg', name: 'Sweep + Structure + FVG', family: 'smartMoney',
    dir,
    strength: dir === 0 ? 0 : 0.86,
    reasons: [dir !== 0
      ? `Sweep → ${structure.event.type} → FVG all ${dir === 1 ? 'bullish' : 'bearish'}`
      : `Confluence incomplete (sweep ${sweepDir}, structure ${structDir}, FVG ${fvgDir})`],
    levels: dir !== 0
      ? rrLevels({ dir, entry: close, stop: dir === 1 ? Math.min(...candles.slice(-5).map(c => c.low)) : Math.max(...candles.slice(-5).map(c => c.high)) })
      : null,
    meta: { sweepDir, structDir, fvgDir, event: structure?.event?.type || null },
  });
}

function ictSilverBullet(candles) {
  if (candles.length < 30) return null;
  const ts = lastTs(candles);
  const inWindow = ts != null && inUtcWindow(ts, 14, 16); // NY 10–11am (EST/EDT cover)
  const closes = closeArr(candles);
  const e200 = closes.length >= 200 ? emaSeries(closes, 200) : null;
  const ema200 = e200 ? e200[e200.length - 1] : null;
  const close = closes[closes.length - 1];
  const emaBias = ema200 == null ? 0 : close > ema200 ? 1 : close < ema200 ? -1 : 0;
  const sweep = detectSweep(candles, 5);
  const sweepBias = sweep?.dir || 0;
  const fvg = fairValueGap(candles, { lookback: 10 });
  const fvgBias = fvg?.dir || 0;
  let dir = 0;
  if (inWindow) {
    if (emaBias !== 0 && sweepBias === -emaBias) dir = 0;
    else dir = emaBias || sweepBias || 0;
    if (dir !== 0 && fvgBias !== 0 && fvgBias !== dir) dir = 0;
  }
  let strength = dir === 0 ? 0 : 0.55;
  if (dir !== 0 && fvgBias === dir) strength += 0.15;
  if (dir !== 0 && sweepBias === dir) strength += 0.1;
  return vote({
    id: 'ict_silver_bullet', name: 'ICT Silver Bullet (NY 10–11)', family: 'smartMoney',
    dir, strength,
    reasons: [dir !== 0
      ? `Silver Bullet window — bias ${dir === 1 ? 'bullish' : 'bearish'}${fvgBias === dir ? ' + FVG' : ''}${sweepBias === dir ? ' + sweep' : ''}`
      : inWindow
        ? `In window but bias/FVG conflict (EMA ${emaBias}, sweep ${sweepBias}, FVG ${fvgBias})`
        : 'Outside NY 10–11am Silver Bullet window'],
    levels: dir !== 0
      ? rrLevels({ dir, entry: close, stop: dir === 1 ? Math.min(...candles.slice(-10).map(c => c.low)) : Math.max(...candles.slice(-10).map(c => c.high)) })
      : null,
    meta: { inWindow, emaBias, sweepBias, fvgBias },
  });
}

function orderBlockRetest(candles) {
  if (candles.length < 30) return null;
  const ob = detectOrderBlock(candles, 1.6, 60);
  if (!ob) {
    return vote({
      id: 'order_block_retest', name: 'Order Block Retest', family: 'smartMoney',
      reasons: ['No fresh order block'],
    });
  }
  const structure = swingStructure(candles, { strength: 3, lookback: 120 });
  const structAligned = structure?.trend === ob.dir;
  const dir = ob.inRetest ? ob.dir : 0;
  let strength = dir === 0 ? 0 : 0.62;
  if (dir !== 0 && structAligned) strength += 0.1;
  const close = candles[candles.length - 1].close;
  return vote({
    id: 'order_block_retest', name: 'Order Block Retest', family: 'smartMoney',
    dir, strength,
    reasons: [dir !== 0
      ? `${ob.type} retest (${ob.bottom.toFixed(4)}–${ob.top.toFixed(4)})${structAligned ? ' + structure' : ''}`
      : `${ob.type} ${ob.nearPct.toFixed(2)}% away — no retest yet`],
    levels: dir !== 0 ? rrLevels({ dir, entry: close, stop: dir === 1 ? ob.bottom : ob.top }) : null,
    meta: { type: ob.type, top: ob.top, bottom: ob.bottom, nearPct: ob.nearPct, structAligned },
  });
}

export const SMART_MONEY_STRATEGIES = [
  { id: 'liquidity_sweep_reversal', name: 'Liquidity Sweep Reversal', family: 'smartMoney', fn: liquiditySweepReversal },
  { id: 'fvg_retest', name: 'FVG Retest', family: 'smartMoney', fn: fvgRetest },
  { id: 'sweep_structure_fvg', name: 'Sweep + Structure + FVG', family: 'smartMoney', fn: sweepStructureFvg },
  { id: 'ict_silver_bullet', name: 'ICT Silver Bullet (NY 10–11)', family: 'smartMoney', fn: ictSilverBullet },
  { id: 'order_block_retest', name: 'Order Block Retest', family: 'smartMoney', fn: orderBlockRetest },
];
