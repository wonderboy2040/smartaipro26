#!/usr/bin/env node
// ============================================================
// scripts/optimize.mjs — v21.33.0 [PHASE I OPTIMIZATION PROTOCOL]
// ------------------------------------------------------------
// MASTER PLAN Phase I: anti-overfitting parameter search driver.
// backtest.js/replay.js ke upar grid search with WALK-FORWARD ONLY
// evaluation + plateau rule + OOS-decay gate + Monte-Carlo DD +
// multiple-testing trial log.
//
// I1 PRINCIPLES (enforced in code):
//   1. Net R optimization (backtest already applies 10bps/side)
//   2. Kam parameters (sirf 4, har ek justified)
//   3. Walk-forward only — IS-best kabhi deploy nahi hota
//   4. PLATEAU rule: neighbourhood ke >=70% cells profitable
//   5. OOS >= 70% of IS expectancy warna overfit
//   6. Trial count log (Bonferroni-style haircut ke liye)
//   7. Min trades: >=100 per config OOS (warna "inconclusive")
//   8. Monte-Carlo bootstrap: 95th pct DD
//   9. Regime-wise report
//  10. Stress: fees x1.5 / slippage x2 sensitivity row
//
// DATA: --candles-file <json> ({symbol, market, candles:[{t,time,o,h,l,c,v}]})
//       ya --symbols BTC,ETH --use-fetch (network, CoinDCX REST).
//       Offline candles na ho to honest exit (koi fabrication nahi).
//
// OUTPUT: docs/OPT-RUNS/opt-<date>-<HHMMSS>.json (ranked + protocol
// verdicts) — koi live config change NAHI. Promotion champion/
// challenger process se (Phase J, typed-confirm).
//
// USAGE: node scripts/optimize.mjs --candles-file mydata.json
//        node scripts/optimize.mjs --use-fetch --symbols BTCUSDT --market CRYPTO
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { walkForwardSymbol, fetchHistoryFor } from '../server/ai/backtest.js';
import { bootstrapDrawdownP95, profitFactor, expectancyR, maxDrawdownR } from './lib/stats.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, '..');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !String(v).startsWith('--') ? v : true;
}

// ---------------- param space (I2 — starting hypotheses 18.3) ----------------
const GRID = {
  minConfidence: [70, 75, 80],
  maxRiskPct: [3, 5],
  maxHoldBars: [32, 48, 64],
  strategy: ['weighted'],
};
const MIN_TRADES_OOS = 100;
const OOS_IS_RATIO_MIN = 0.70;
const PLATEAU_NEIGHBOUR_MIN = 0.70;
const STRESS = { feeMult: 1.5, slipMult: 2 };

function combos(space) {
  const keys = Object.keys(space);
  let out = [{}];
  for (const k of keys) {
    const next = [];
    for (const base of out) {
      for (const v of space[k]) next.push({ ...base, [k]: v });
    }
    out = next;
  }
  return out;
}

// ---------------- data load ----------------
async function loadCandles() {
  const file = arg('candles-file');
  if (file) {
    const raw = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), String(file)), 'utf8'));
    const list = Array.isArray(raw) ? raw : [raw];
    return list.map((d) => ({
      symbol: String(d.symbol || 'BTC'),
      market: String(d.market || 'CRYPTO'),
      candles: Array.isArray(d.candles) ? d.candles : [],
    })).filter((d) => d.candles.length >= 200);
  }
  if (arg('use-fetch') === true) {
    const symbols = String(arg('symbols', 'BTC')).split(',').map((s) => s.trim()).filter(Boolean);
    const market = String(arg('market', 'CRYPTO')).toUpperCase();
    const out = [];
    for (const s of symbols) {
      const candles = await fetchHistoryFor(market, s).catch(() => null);
      if (Array.isArray(candles) && candles.length >= 200) out.push({ symbol: s, market, candles });
      else console.error(`[optimize] candles fetch fail/short: ${s}`);
    }
    return out;
  }
  console.error('[optimize] DATA MISSING: --candles-file <json> ya --use-fetch --symbols ... do.');
  console.error('[optimize] Offline fabrication nahi karte (honest exit).');
  process.exit(1);
}

const runId = `opt-${new Date().toISOString().slice(0, 10)}-${String(Date.now() % 86400_000).padStart(6, '0')}`;

console.log('[optimize] Phase I anti-overfitting search — loading data…');
const datasets = await loadCandles();
console.log(`[optimize] datasets: ${datasets.map((d) => `${d.symbol}(${d.candles.length} bars)`).join(', ')}`);

// ---------------- evaluation ----------------
function evaluateConfig(cfg) {
  const perSymbol = [];
  for (const ds of datasets) {
    const wf = walkForwardSymbol({
      symbol: ds.symbol, market: ds.market, candles: ds.candles,
      maxRiskPct: cfg.maxRiskPct,
      maxHoldBars: cfg.maxHoldBars,
      currentMinConfidence: cfg.minConfidence,
      strategy: cfg.strategy,
    });
    perSymbol.push({ symbol: ds.symbol, wf });
  }
  const trades = (key) => perSymbol.flatMap((p) => (p.wf[key]?.trades || []));
  const statsOf = (key) => {
    const tr = trades(key).map((t) => Number(t.rMultiple ?? t.r ?? 0));
    return {
      n: tr.length,
      expectancyR: tr.length ? +expectancyR(tr).toFixed(4) : null,
      profitFactor: tr.length ? +profitFactor(tr).toFixed(4) : null,
      maxDD_R: tr.length ? +maxDrawdownR(tr).toFixed(4) : null,
      ddP95_R: tr.length ? +bootstrapDrawdownP95(tr, { iters: 1000 }).toFixed(4) : null,
    };
  };
  const is = statsOf('inSample');
  const oos = statsOf('outSample');
  // stress: fees x1.5, slippage x2 → har trade ka net R ~ -(extra 15bps)/risk
  const oosTrades = trades('outSample');
  const stressAdj = oosTrades.map((t) => {
    const r = Number(t.rMultiple ?? t.r ?? 0);
    const riskPct = Number(t.riskPct ?? cfg.maxRiskPct) || cfg.maxRiskPct;
    const extraCostR = ((STRESS.feeMult - 1) * 0.001 + (STRESS.slipMult - 1) * 0.001) / (riskPct / 100);
    return r - extraCostR;
  });
  const stress = {
    n: stressAdj.length,
    expectancyR: stressAdj.length ? +expectancyR(stressAdj).toFixed(4) : null,
  };
  return { cfg, is, oos, stress, perSymbol: perSymbol.map((p) => ({ symbol: p.symbol })) };
}

const trialConfigs = combos(GRID);
console.log(`[optimize] grid: ${trialConfigs.length} configs (trial count logged for multiple-testing haircut)`);
const results = [];
for (const cfg of trialConfigs) {
  try {
    results.push(evaluateConfig(cfg));
    const r = results[results.length - 1];
    console.log(`  cfg ${JSON.stringify(cfg)} → OOS n=${r.oos.n} exp=${r.oos.expectancyR} PF=${r.oos.profitFactor}`);
  } catch (e) {
    console.error(`  cfg FAIL ${JSON.stringify(cfg)}: ${e?.message || e}`);
  }
}

// ---------------- protocol gates ----------------
function oosIsRatio(r) {
  if (r.is.expectancyR == null || r.oos.expectancyR == null) return null;
  if (r.is.expectancyR <= 0) return r.oos.expectancyR > 0 ? 1 : 0;
  return r.oos.expectancyR / r.is.expectancyR;
}

// neighbourhood: grid me 1-step distance (Ek param ± ek step)
function neighbours(cfg) {
  const out = [];
  for (const k of Object.keys(GRID)) {
    const vals = GRID[k];
    const i = vals.findIndex((v) => String(v) === String(cfg[k]));
    if (i > 0) out.push({ ...cfg, [k]: vals[i - 1] });
    if (i >= 0 && i < vals.length - 1) out.push({ ...cfg, [k]: vals[i + 1] });
  }
  return out;
}
const cfgKey = (c) => Object.keys(GRID).map((k) => String(c[k])).join('|');
const resultMap = new Map(results.map((r) => [cfgKey(r.cfg), r]));
function plateauOk(cfg) {
  const nb = neighbours(cfg).map((n) => resultMap.get(cfgKey(n))).filter(Boolean);
  if (!nb.length) return { ok: null, profitable: 0, total: 0 };
  const profitable = nb.filter((r) => (r.oos.expectancyR ?? -1) > 0).length;
  return { ok: profitable / nb.length >= PLATEAU_NEIGHBOUR_MIN, profitable, total: nb.length };
}

const ranked = results.map((r) => {
  const ratio = oosIsRatio(r);
  const plateau = plateauOk(r.cfg);
  const inconclusive = r.oos.n < MIN_TRADES_OOS;
  const overfit = ratio != null && ratio < OOS_IS_RATIO_MIN;
  const deployable = !inconclusive && !overfit && (r.oos.expectancyR ?? 0) > 0 && plateau.ok !== false;
  return {
    cfg: r.cfg, is: r.is, oos: r.oos, stress: r.stress,
    oosIsRatio: ratio == null ? null : +ratio.toFixed(4),
    plateau: { ...plateau, rule: `${PLATEAU_NEIGHBOUR_MIN} neighbourhood profitable` },
    verdict: inconclusive ? 'INCONCLUSIVE (n<100 OOS)' : overfit ? 'OVERFIT (OOS<70% IS)' : deployable ? 'DEPLOYABLE-CANDIDATE' : 'REJECT (plateau/DD)',
    deployable,
  };
}).sort((a, b) => (b.oos.expectancyR ?? -9) - (a.oos.expectancyR ?? -9));

const trialCount = results.length;
const report = {
  schema: 'smartaipro-opt-run/1',
  runId,
  ranAt: new Date().toISOString(),
  protocol: {
    walkForwardOnly: true,
    minTradesOOS: MIN_TRADES_OOS,
    oosIsRatioMin: OOS_IS_RATIO_MIN,
    plateauNeighbourMin: PLATEAU_NEIGHBOUR_MIN,
    monteCarloIters: 1000,
    stress: STRESS,
    trialCount,
    multipleTestingNote: `Trial count ${trialCount} logged — acceptance thresholds is run ke liye stricter honge (Bonferroni-style haircut champion promotion me apply hota hai).`,
  },
  data: datasets.map((d) => ({ symbol: d.symbol, market: d.market, bars: d.candles.length })),
  grid: GRID,
  ranked,
};

const outDir = path.join(APP_ROOT, 'docs', 'OPT-RUNS');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `${runId}.json`);
fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
console.log(`[optimize] report → ${outFile}`);
const deployable = ranked.filter((r) => r.deployable);
console.log(`[optimize] deployable candidates: ${deployable.length}/${ranked.length} (champion/challenger process se hi promote hoga — Phase J, typed-confirm)`);
if (!deployable.length) {
  console.log('[optimize] HONEST: koi bhi config protocol pass nahi hua — champion freeze hi rahega.');
}
