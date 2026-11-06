// ============================================================
// test/v21320DataQuality.test.ts — v21.32.0 PHASE B UNIT TESTS
// ------------------------------------------------------------
//   • B1 candleIntegrity — dupes / reorder / gaps / forming bar / outliers
//   • B2 priceCrossCheck — divergence verdicts (fail-open on missing)
//   • B3 latencyStats — P50/P95 recorder (deterministic)
// ============================================================
import { describe, it, expect } from 'vitest';
import { cleanCandles, closedOnlyCandles, detectOutlierBars } from '../server/ai/lib/candleIntegrity.js';
import { crossCheckPrice, priceSourceTelemetry } from '../server/ai/lib/priceCrossCheck.js';
import { createLatencyRecorder, percentileMs } from '../server/ai/lib/latencyStats.js';

const T0 = 1_790_000_000_000;
const TF5 = 5 * 60_000;
const mk = (i: number, over: Record<string, any> = {}) => ({
  time: T0 + i * TF5, open: 100, high: 101, low: 99, close: 100.5, volume: 10, ...over,
});

describe('v21.32.0 B1 — candleIntegrity.cleanCandles', () => {
  it('clean series untouched rehta hai (no-op)', () => {
    const bars = Array.from({ length: 20 }, (_, i) => mk(i));
    const out = cleanCandles(bars, { tfMin: 5, now: T0 + 20 * TF5 });
    expect(out.candles.length).toBe(20);
    expect(out.droppedDuplicates).toBe(0);
    expect(out.reordered).toBe(false);
    expect(out.gapCount).toBe(0);
    expect(out.degraded).toBe(false);
    expect(out.issues.length).toBe(0);
  });

  it('duplicate timestamps drop hote hain (last occurrence rakhta hai)', () => {
    const bars = Array.from({ length: 20 }, (_, i) => mk(i));
    bars[10] = { ...bars[10], close: 999 }; // dupe with different close
    bars.push({ ...bars[10] });             // duplicate of index 10
    const out = cleanCandles(bars, { tfMin: 5, now: T0 + 25 * TF5 });
    expect(out.droppedDuplicates).toBe(1);
    expect(out.candles.length).toBe(20);
  });

  it('out-of-order series sort hoti hai (reordered=true)', () => {
    const bars = Array.from({ length: 20 }, (_, i) => mk(i));
    const shuffled = [bars[0], bars[5], bars[1], bars[2], bars[3], bars[4], ...bars.slice(6)];
    const out = cleanCandles(shuffled, { tfMin: 5, now: T0 + 20 * TF5 });
    expect(out.reordered).toBe(true);
    expect(out.candles.length).toBe(20);
  });

  it('gap detection: missing bars count + degraded flag', () => {
    const bars = [mk(0), mk(1), mk(2), mk(7), mk(8), mk(9), mk(10)]; // 3–6 missing (4 bars)
    const out = cleanCandles(bars, { tfMin: 5, now: T0 + 20 * TF5 });
    expect(out.gapCount).toBe(1);
    expect(out.missingBars).toBe(4);
    expect(out.degraded).toBe(false); // 1 gap <= maxGaps 3
    const bad = [mk(0), mk(2), mk(4), mk(6), mk(8), mk(10)];
    const out2 = cleanCandles(bad, { tfMin: 5, now: T0 + 20 * TF5 });
    expect(out2.gapCount).toBe(5);
    expect(out2.degraded).toBe(true);
  });

  it('forming (partial) last bar detect hota hai — closedOnly use drop karta hai', () => {
    const bars = Array.from({ length: 20 }, (_, i) => mk(i));
    const now = T0 + 19 * TF5 + 60_000; // last bar (i=19) closes at T0+20*TF5 → still forming
    const pass = cleanCandles(bars, { tfMin: 5, now });
    expect(pass.lastBarClosed).toBe(false);
    const closed = closedOnlyCandles(bars, { tfMin: 5, now });
    expect(closed.candles.length).toBe(19); // forming bar dropped
    expect(closed.formingBarDropped).toBe(1);
    // bar close hone ke baad — sab closed
    const now2 = T0 + 21 * TF5;
    const pass2 = cleanCandles(bars, { tfMin: 5, now: now2 });
    expect(pass2.lastBarClosed).toBe(true);
    const closed2 = closedOnlyCandles(bars, { tfMin: 5, now: now2 });
    expect(closed2.candles.length).toBe(20);
    expect(closed2.formingBarDropped).toBe(0);
  });

  it('timestamp-less last bar conservative drop (closed-only view)', () => {
    const bars = Array.from({ length: 20 }, (_, i) => mk(i));
    delete (bars[19] as any).time;
    const out = closedOnlyCandles(bars, { tfMin: 5, now: T0 + 30 * TF5 });
    expect(out.candles.length).toBe(19);
    expect(out.formingBarDropped).toBe(1);
  });

  it('outlier wick + zero-volume bar suspect flag (1-tick spike exclusion)', () => {
    const bars = Array.from({ length: 30 }, (_, i) => mk(i));
    bars[25] = mk(25, { high: 140, low: 99, volume: 0 }); // wick 40 vs ATR ~2 → 20×
    const out = detectOutlierBars(bars, { atrPeriod: 14, wickAtrMult: 4 });
    expect(out.suspects.length).toBe(1);
    expect(out.suspects[0].index).toBe(25);
    expect(out.suspects[0].wickOverAtr).toBeGreaterThan(4);
    // volume wale normal wick par suspect NAHI (sirf zero-volume wick)
    const bars2 = Array.from({ length: 30 }, (_, i) => mk(i));
    bars2[25] = mk(25, { high: 140, low: 99, volume: 55 });
    expect(detectOutlierBars(bars2, { atrPeriod: 14, wickAtrMult: 4 }).suspects.length).toBe(0);
  });
});

describe('v21.32.0 B2 — priceCrossCheck (multi-source divergence)', () => {
  it('OK jab divergence threshold ke andar', () => {
    const out = crossCheckPrice({ execPrice: 100.10, refPrice: 100.00 });
    expect(out.verdict).toBe('OK');
    expect(out.divergencePct).toBeCloseTo(0.1, 6);
    expect(out.thresholdPct).toBeCloseTo(0.15, 6);
  });

  it('DIVERGED jab divergence > max(0.15%, 1.5×spread)', () => {
    expect(crossCheckPrice({ execPrice: 100.5, refPrice: 100 }).verdict).toBe('DIVERGED');
    // tight threshold via spread: spread 10bps → 1.5×10bps = 0.15% (same as min)
    const tight = crossCheckPrice({ execPrice: 100.4, refPrice: 100, spreadBps: 10 });
    expect(tight.verdict).toBe('DIVERGED');
    // wide spread raises the threshold: spread 100bps → 1.5%
    const wide = crossCheckPrice({ execPrice: 101.2, refPrice: 100, spreadBps: 100 });
    expect(wide.verdict).toBe('OK');
    expect(wide.thresholdPct).toBeCloseTo(1.5, 6);
  });

  it('missing data par UNKNOWN (fail-open — D4: block nahi)', () => {
    expect(crossCheckPrice({ execPrice: 100, refPrice: null }).verdict).toBe('UNKNOWN');
    expect(crossCheckPrice({ execPrice: null, refPrice: 100 }).verdict).toBe('UNKNOWN');
  });

  it('telemetry row shape (priceSources[] entry)', () => {
    const t = priceSourceTelemetry({ execPrice: 100.2, refPrice: 100.0, refName: 'binance-perp', spreadBps: 8 });
    expect(t.crossCheck).toBe('DIVERGED');
    expect(t.refName).toBe('binance-perp');
    expect(t.at).toBeNull(); // pure — caller stamps
  });
});

describe('v21.32.0 B3 — latencyStats (P50/P95 recorder)', () => {
  it('P50/P95 percentiles deterministic + budget verdict', () => {
    const rec = createLatencyRecorder();
    const now = 1_790_000_000_000;
    const xs = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100 ms
    xs.forEach((ms, i) => rec.record('rowToOrder', ms, { now: now + i }));
    const s = rec.summary({ now: now + 1000, budgetMs: 95 });
    const lane = s.lanes.rowToOrder;
    expect(lane.n).toBe(100);
    expect(lane.p50Ms).toBe(50);
    expect(lane.p95Ms).toBe(95);
    expect(lane.maxMs).toBe(100);
    expect(lane.withinBudgetP95).toBe(true); // 95 <= 95
    const s2 = rec.summary({ now: now + 1000, budgetMs: 90 });
    expect(s2.lanes.rowToOrder.withinBudgetP95).toBe(false);
  });

  it('invalid lane / negative values reject; stamp→finish delta', () => {
    const rec = createLatencyRecorder();
    expect(rec.record('nonsense', 5)).toBe(false);
    expect(rec.record('tickToRow', -5)).toBe(false);
    const now = 1_790_000_000_000;
    const st = rec.stamp('orderToAck', { now });
    expect(st!.lane).toBe('orderToAck');
    expect(rec.finish(st!, { now: now + 120 })).toBe(true);
    const s = rec.summary({ now: now + 200 });
    expect(s.lanes.orderToAck.n).toBe(1);
    expect(s.lanes.orderToAck.lastMs).toBe(120);
  });

  it('pure percentileMs helper', () => {
    expect(percentileMs([10, 20, 30, 40, 100], 0.5)).toBe(30);
    expect(percentileMs([], 0.5)).toBeNull();
    expect(percentileMs([5, 1, 4], 0.95)).toBe(5);
  });
});
