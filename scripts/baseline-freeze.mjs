#!/usr/bin/env node
// ============================================================
// scripts/baseline-freeze.mjs — v21.32.0 [PHASE A6] BASELINE + CHAMPION
// ------------------------------------------------------------
// MASTER PLAN (A6): docs/BASELINE-<date>.json (current version par
// frozen snapshot) + config/champion.json (champion config snapshot).
// Baad ka HAR change isi baseline se compare hoga.
//
// SAFETY: READ-ONLY inputs (ledger + package.json). Output: 2 files.
// Koi exchange call nahi, server boot nahi, live config touch nahi.
//
// USAGE: node scripts/baseline-freeze.mjs [--data-dir server/data] [--tag <label>]
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import {
  hydrateMtfLedger, computeMtfDirectionScorecardV2, computeMtfDirectionScorecard,
} from '../server/ai/signalLedger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, '..');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !String(v).startsWith('--') ? v : true;
}

const dataDir = path.resolve(APP_ROOT, String(arg('data-dir', 'server/data')));
const tag = String(arg('tag', '')) || '';
const ledgerFile = path.join(dataDir, 'mtf-row-ledger.json');
const dateTag = new Date().toISOString().slice(0, 10);

const pkg = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8'));
let gitSha = 'unknown';
try { gitSha = execSync('git rev-parse --short HEAD', { cwd: APP_ROOT }).toString().trim(); } catch { /* no git */ }

let rows = [];
let ledgerAvailable = false;
try {
  const raw = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  rows = Array.isArray(raw?.rows) ? raw.rows : [];
  ledgerAvailable = rows.length > 0;
} catch { /* honest: no data yet */ }

// Guards ka current mode snapshot (champion config) — mtfAutoLink se
// read-only import bhaari hai; env + defaults hi kaafi honest snapshot hai.
const guardEnv = (envKey, fallback) => ({
  env: process.env[envKey] ?? null,
  default: fallback,
  effective: String(process.env[envKey] ?? fallback).toLowerCase(),
});

hydrateMtfLedger(rows);
const v2 = computeMtfDirectionScorecardV2({ windowDays: 30, now: Date.now() });
const legacy = computeMtfDirectionScorecard({ windowDays: 30, now: Date.now() });

const baseline = {
  schema: 'smartaipro-baseline/1',
  frozenAt: new Date().toISOString(),
  version: pkg.version,
  gitSha,
  tag: tag || `v${pkg.version}-freeze`,
  dataSource: ledgerAvailable ? 'server/data/mtf-row-ledger.json' : 'NO-LEDGER-DATA (fresh install — re-run after ≥2 weeks of board scans)',
  windowDays: 30,
  ledgerRows: rows.length,
  scorecardV2: v2,
  legacyScorecard: {
    n: legacy.n ?? null,
    directionHitRate: legacy.directionHitRate ?? null,
    t1HitPct: legacy.t1HitPct ?? null,
    avgR: legacy.avgR ?? null,
    wilsonLB: legacy.wilsonLB ?? null,
    byTier: Object.fromEntries(Object.entries(legacy.byTier || {}).map(([k, s]) => [k, { n: s.n, tp1HitPct: s.tp1HitPct, expectancyR: s.expectancyR, avgMfeR: s.avgMfeR, avgMaeR: s.avgMaeR }])),
  },
  compareRule: 'Har baad ka change (flag flip, feature, exit change) isi baseline ke overall + byTier slices se compare hoga. Promotion ke liye: lower 95% CI bound > 0 at n>=150 (KPI §6).',
};

const baselinePath = path.resolve(APP_ROOT, 'docs', `BASELINE-${dateTag}.json`);
fs.writeFileSync(baselinePath, JSON.stringify(baseline, null, 2), 'utf8');

const champion = {
  schema: 'smartaipro-champion-config/1',
  frozenAt: new Date().toISOString(),
  version: pkg.version,
  gitSha,
  baselineFile: path.basename(baselinePath),
  flags: {
    PRE_TP1_TRAIL: guardEnv('PRE_TP1_TRAIL', 'shadow'),
    entryTimingGuard: guardEnv('ENTRY_TIMING_GUARD', 'enforce'),
    closedBarConfirm: guardEnv('CLOSED_BAR_CONFIRM', 'shadow'),
    EXIT_POLICY_V3: guardEnv('EXIT_POLICY_V3', 'shadow'),
    eventSessionFilter: guardEnv('EVENT_SESSION_FILTER', 'shadow'),
    regimeFilter: guardEnv('REGIME_FILTER', 'shadow'),
    perpVeto: guardEnv('PERP_VETO', 'shadow'),
    reversalGuardV2: guardEnv('REVERSAL_GUARD_V2', 'shadow'),
    clusterGuard: guardEnv('CLUSTER_GUARD', 'shadow'),
    META_MODEL: guardEnv('META_MODEL', 'off'),
    liveTp1Partial: guardEnv('LIVE_TP1_PARTIAL', 'off'),
    liveRunner: guardEnv('LIVE_RUNNER', 'off'),
    stallExit: guardEnv('STALL_EXIT', 'off'),
    retestEntry: guardEnv('RETEST_ENTRY', 'off'),
    volTargeting: guardEnv('VOL_TARGETING', 'off'),
    kellyResearch: guardEnv('KELLY_RESEARCH', 'off'),
  },
  promotionRule: 'Challenger promote tabhi jab: OOS expectancy better + n>=150 + DD not worse + 2 hafte stable (Phase J). Rollback: env/config se off + FLAG-HISTORY entry.',
};
const championPath = path.resolve(APP_ROOT, 'config', 'champion.json');
fs.mkdirSync(path.dirname(championPath), { recursive: true });
fs.writeFileSync(championPath, JSON.stringify(champion, null, 2), 'utf8');

console.log(`[baseline] wrote ${path.relative(APP_ROOT, baselinePath)} (${rows.length} ledger rows, v${pkg.version}, ${gitSha})`);
console.log(`[baseline] wrote ${path.relative(APP_ROOT, championPath)} (champion flag snapshot)`);
if (!ledgerAvailable) {
  console.log('[baseline] NOTE: koi ledger data nahi tha — baseline structure + honest nulls ke saath freeze hua.');
  console.log('[baseline] ≥2 hafte board scan ke baad dobara run karo taaki numbers freeze ho.');
}
