// ============================================================
// test/strategiesClassic.test.ts — v21.36.0
// 29-strategy engine + new indicator primitives + integration guards.
// ============================================================
import { describe, it, expect } from 'vitest';
import {
  STRATEGY_REGISTRY, STRATEGY_COUNT, evaluateStrategies,
  strategyFitScore, classicStrategyVote, compactStrategyConsensus,
} from '../server/ai/lib/strategies/index.js';
import {
  psar, heikinAshi, williamsR, cci, donchian, priceZScore,
  keltner, rollingVwapBands, bollingerWidthPercentile,
  computeIndicatorsFromCandles,
} from '../server/ai/lib/indicators.js';
import { parseVerdict, buildFeatureMatrix } from '../server/ai/council.js';
import { aiCouncilVoteFromVerdict } from '../server/ai/models.js';

type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };

function makeCandles(n: number, { drift = 0.004, vol = 0.002, seed = 7 } = {}): Candle[] {
  let s = seed;
  const rand = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  let price = 100;
  const start = Date.UTC(2026, 10, 1, 0, 0, 0);
  return Array.from({ length: n }, (_, i) => {
    const open = price;
    const close = Math.max(1, open * (1 + drift + (rand() - 0.5) * vol));
    const high = Math.max(open, close) * (1 + rand() * 0.001);
    const low = Math.min(open, close) * (1 - rand() * 0.001);
    price = close;
    return { time: start + i * 3_600_000, open, high, low, close, volume: 1000 + rand() * 200 };
  });
}

const up = makeCandles(280, { drift: 0.004 });
const down = makeCandles(280, { drift: -0.004, seed: 11 });

// Realistic pullback tape (every 4th bar bounces) — the live-RSI-41 shape.
// Regime reads RANGE (ADX ~14) and the mean-reversion/ICT families flip
// LONG, producing a LOW-conviction opposing read (~38%). The seat must
// abstain, not shave a legitimate committee grade.
function pullbackTape(n = 90): Candle[] {
  const out: Candle[] = [];
  const t0 = Date.UTC(2026, 10, 1);
  let px = 1290;
  for (let i = 0; i < n; i++) {
    const bounce = i % 4 === 3;
    px = px * (bounce ? 1.0045 : 0.998);
    const c = +px.toFixed(2);
    out.push({
      time: t0 + i * 900_000,
      open: +(px * (bounce ? 1.0004 : 0.9996)).toFixed(2),
      high: +(px * 1.0015).toFixed(2),
      low: +(px * 0.9985).toFixed(2),
      close: c,
      volume: 120_000 + (i % 7) * 9_000,
    });
  }
  return out;
}

describe('29-strategy registry', () => {
  it('registers 29 unique strategies with the 8/5/7/4/5 family split', () => {
    expect(STRATEGY_COUNT).toBe(29);
    expect(STRATEGY_REGISTRY).toHaveLength(29);
    const ids = STRATEGY_REGISTRY.map(s => s.id);
    expect(new Set(ids).size).toBe(29);
    const byFamily = (fam: string) => STRATEGY_REGISTRY.filter(s => s.family === fam).length;
    expect(byFamily('trend')).toBe(8);
    expect(byFamily('breakout')).toBe(5);
    expect(byFamily('momentum')).toBe(7);
    expect(byFamily('meanReversion')).toBe(4);
    expect(byFamily('smartMoney')).toBe(5);
  });
});

describe('strategy consensus', () => {
  it('honest abstain below 30 candles', () => {
    const c = evaluateStrategies(makeCandles(20));
    expect(c.ok).toBe(false);
    expect(c.side).toBeNull();
    expect(c.readyCount).toBe(0);
  });

  it('uptrend → LONG consensus with trend-family alignment', () => {
    const c = evaluateStrategies(up, { side: 'LONG' });
    expect(c.ok).toBe(true);
    expect(c.readyCount).toBe(29);
    expect(c.side).toBe('LONG');
    expect(c.confidence).toBeGreaterThanOrEqual(55);
    expect(c.votesFor).toBeGreaterThan(c.votesAgainst);
    expect(c.families.trend.dir).toBe(1);
    expect(c.fit).toBe('CONFIRM');
    expect(c.topDrivers.length).toBeGreaterThan(0);
    expect(c.regime.regime).toBe('trend');
  });

  it('downtrend → SHORT consensus and SHORT plan fit', () => {
    const c = evaluateStrategies(down, { side: 'SHORT' });
    expect(c.side).toBe('SHORT');
    expect(c.confidence).toBeGreaterThanOrEqual(55);
    expect(c.votesFor).toBeGreaterThan(c.votesAgainst);
    expect(c.families.trend.dir).toBe(-1);
    expect(c.fit).toBe('CONFIRM');
  });

  it('fit score is signed and bounded', () => {
    const c = evaluateStrategies(up, { side: 'LONG' });
    const aligned = strategyFitScore(c, 'LONG');
    const opposed = strategyFitScore(c, 'SHORT');
    expect(aligned).toBeGreaterThan(0);
    expect(aligned).toBeLessThanOrEqual(5);
    expect(opposed).toBeLessThan(0);
    expect(opposed).toBeGreaterThanOrEqual(-8);
    expect(strategyFitScore(c, null as any)).toBe(0);
    expect(strategyFitScore(null, 'LONG')).toBe(0);
  });

  it('compact row shape carries families/top/dissent', () => {
    const c = evaluateStrategies(down, { side: 'LONG' });
    const row = compactStrategyConsensus(c);
    expect(row).not.toBeNull();
    expect(row!.total).toBe(29);
    expect(row!.side).toBe('SHORT');
    expect(Object.keys(row!.families)).toContain('trend');
    expect(Array.isArray(row!.top)).toBe(true);
    expect(row!.fit).toBe('CONFLICT');
  });
});

describe('ensemble seat adapter', () => {
  it('abstains structurally (na) when candles are absent', () => {
    const v = classicStrategyVote({ market: 'CRYPTO', ltp: 100 });
    expect(v.dir).toBe(0);
    expect(v.conf).toBe(0);
    expect(v.na).toBe(true);
  });

  it('votes with consensus when candles are present', () => {
    const v = classicStrategyVote({ candles: up });
    expect(v.na).toBeUndefined();
    expect(v.dir).toBe(1);
    expect(v.conf).toBeGreaterThan(0);
    expect(v.strategyConsensus.total).toBe(29);
  });

  it('sub-45% consensus structurally abstains instead of diluting the quorum', () => {
    const tape = pullbackTape();
    const cons = evaluateStrategies(tape, { side: 'SHORT' });
    expect(cons.ok).toBe(true);
    expect(cons.side).toBe('LONG');
    expect(cons.confidence).toBeLessThan(45);
    const v = classicStrategyVote({ candles: tape, side: 'SHORT', market: 'INDIA' });
    expect(v.dir).toBe(0);
    expect(v.conf).toBe(0);
    expect(v.na).toBe(true);
    expect(v.strategyConsensus.side).toBe('LONG');
    expect(v.reasons.join(' ')).toMatch(/low-conviction/i);
  });
});

describe('new indicator primitives', () => {
  it('psar tracks a rising tape from below', () => {
    const p = psar(up)!;
    expect(p).not.toBeNull();
    expect(p.dir).toBe(1);
    expect(p.value).toBeLessThan(up[up.length - 1].close);
    expect(psar(up.slice(0, 3))).toBeNull();
  });

  it('heikin-ashi builds a positive colour streak on a rise', () => {
    const ha = heikinAshi(up)!;
    expect(ha.streak).toBeGreaterThanOrEqual(3);
    expect(ha.dir).toBe(1);
    expect(ha.close).toBeGreaterThan(0);
  });

  it('williams %R stays inside [-100, 0]', () => {
    const wr = williamsR(up)!;
    expect(wr).toBeGreaterThanOrEqual(-100);
    expect(wr).toBeLessThanOrEqual(0);
    expect(williamsR(up.slice(0, 5))).toBeNull();
  });

  it('CCI is positive on a sustained rise', () => {
    expect(cci(up)!).toBeGreaterThan(0);
  });

  it('donchian channel is ordered and flags an upside break', () => {
    const d = donchian(up)!;
    expect(d.upper).toBeGreaterThan(d.lower);
    expect(d.priorUpper).toBeLessThanOrEqual(d.upper);
    expect(d.breakoutDir).toBe(1);
    expect(d.widthPct).toBeGreaterThan(0);
  });

  it('price Z-score detects a 2σ+ spike', () => {
    const closes = up.map(c => c.close);
    const spike = [...closes.slice(0, -1), closes[closes.length - 1] * 1.15];
    const z = priceZScore(spike, 50)!;
    expect(z.z).toBeGreaterThan(2);
    expect(z.sd).toBeGreaterThan(0);
  });

  it('keltner and VWAP bands are correctly ordered', () => {
    const k = keltner(up)!;
    expect(k.upper).toBeGreaterThan(k.mid);
    expect(k.mid).toBeGreaterThan(k.lower);
    const v = rollingVwapBands(up)!;
    expect(v.upper).toBeGreaterThan(v.vwap);
    expect(v.vwap).toBeGreaterThan(v.lower);
    expect(Number.isFinite(v.z)).toBe(true);
  });

  it('bollinger width percentile is 0..100', () => {
    const pct = bollingerWidthPercentile(up.map(c => c.close), { period: 20, lookback: 100 })!;
    expect(pct).toBeGreaterThanOrEqual(0);
    expect(pct).toBeLessThanOrEqual(100);
    expect(bollingerWidthPercentile(up.slice(0, 30).map(c => c.close), { period: 20, lookback: 100 })).toBeNull();
  });

  it('computeIndicatorsFromCandles exposes the new pack', () => {
    const ind = computeIndicatorsFromCandles(up)!;
    for (const key of ['psar', 'heikinAshi', 'williamsR', 'cci', 'donchian', 'zScore', 'keltner', 'vwapBands', 'bbWidthPct']) {
      expect(ind).toHaveProperty(key);
    }
    expect(ind.donchian?.upper).toBeGreaterThan(ind.donchian?.lower);
  });
});

describe('LLM integration guards', () => {
  it('parseVerdict validates strategyFit vocabulary', () => {
    expect(parseVerdict('technical', { direction: 'LONG', confidence: 60, strategyFit: 'conflict' })!.strategyFit).toBe('CONFLICT');
    expect(parseVerdict('technical', { direction: 'LONG', confidence: 60, strategyFit: 'banana' })!.strategyFit).toBeNull();
    expect(parseVerdict('technical', { direction: 'LONG', confidence: 60 })!.strategyFit).toBeNull();
  });

  it('aiCouncilVoteFromVerdict caps CONFLICT confidence at 70', () => {
    const v = aiCouncilVoteFromVerdict({ verdict: 'LONG', confidence: 92, strategyFit: 'CONFLICT' })!;
    expect(v.dir).toBe(1);
    expect(v.conf).toBe(70);
    expect(v.reasons.join(' ')).toMatch(/CONFLICT/);
    const plain = aiCouncilVoteFromVerdict({ verdict: 'LONG', confidence: 92 })!;
    expect(plain.conf).toBe(92);
  });

  it('buildFeatureMatrix surfaces the compact strategy block', () => {
    const sig = {
      symbol: 'BTC', side: 'LONG', confidence: 70, ltp: 100,
      votes: [{ id: 'classic', name: 'Classic29', dir: 1, conf: 70, weight: 1, strategyConsensus: {
        side: 'LONG', confidence: 72, net: 0.6, agreement: 0.8, regime: 'trend',
        votesFor: 12, votesAgainst: 3, ready: 29, fit: 'CONFIRM',
        families: { trend: { net: 0.9 }, momentum: { net: 0.4 } },
        top: [{ id: 'ema_cross_9_21' }, { id: 'macd_12_26_9' }],
      } }],
    };
    const fm = buildFeatureMatrix({ market: 'CRYPTO', symbol: 'BTC', sig });
    expect(fm.strategy).not.toBeNull();
    expect(fm.strategy!.side).toBe('LONG');
    expect(fm.strategy!.families).toEqual({ trend: 0.9, momentum: 0.4 });
    expect(fm.strategy!.top).toContain('ema_cross_9_21');
  });
});
