#!/usr/bin/env node
// ============================================================
// scripts/scorecard.mjs — v21.32.0 [PHASE A4] SCORECARD V2 CLI
// ------------------------------------------------------------
// MASTER PLAN (A4): persisted MTF row ledger → hydrate →
// computeMtfDirectionScorecardV2 → docs/SCORECARD-<date>.md
// (tier × desk × regime × side × session slices, Wilson CI,
// bootstrap CI, ECE/Brier, min-n gates).
//
// SAFETY: READ-ONLY input (ledger file sirf padhta hai); output sirf
// ek markdown report. Koi config/state/exchange call nahi.
//
// USAGE (repo app/ folder se):
//   node scripts/scorecard.mjs
//   node scripts/scorecard.mjs --data-dir server/data --window 30
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  hydrateMtfLedger, computeMtfDirectionScorecardV2, getMtfLedgerSnapshot,
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
const windowDays = Number(arg('window', 30)) || 30;
const ledgerFile = path.join(dataDir, 'mtf-row-ledger.json');

let rows = [];
try {
  const raw = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  rows = Array.isArray(raw?.rows) ? raw.rows : [];
} catch {
  console.error(`[scorecard] ledger file nahi mila / invalid: ${ledgerFile}`);
  console.error('[scorecard] Server ko ek baar chala lo — board scan rows likhta hai. Phir ye report generate hogi.');
  process.exit(1);
}

hydrateMtfLedger(rows);
const sc = computeMtfDirectionScorecardV2({ windowDays, now: Date.now() });

const pct = (v) => (v == null ? '—' : `${v}%`);
const r2s = (v) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v}R`);
const ci = (c) => (c && c.lo != null ? `[${c.lo}, ${c.hi}]` : '—');
const dateTag = new Date().toISOString().slice(0, 10);

function sliceTable(title, obj) {
  const keys = Object.keys(obj || {});
  const lines = [`### ${title}`, '',
    '| slice | n | gate | Hit-TP1 (Wilson 95% CI) | Hit-TP2 | Stop | Timeout | Expectancy (bootstrap 95% CI) | PF | med MFE | med MAE | ECE | Brier | Stability |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|'].slice(0, 4);
  lines[3] = '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|';
  if (!keys.length) return `${lines.join('\n')}\n| _none_ | — | — | — | — | — | — | — | — | — | — | — | — | — |\n`;
  for (const k of keys) {
    const s = obj[k];
    lines.push(`| ${k} | ${s.n} | ${s.gate?.state ?? '—'} | ${pct(s.hitTp1Pct)} ${ci(s.hitTp1WilsonCI)} | ${pct(s.hitTp2Pct)} | ${pct(s.stopRatePct)} | ${pct(s.timeoutRatePct)} | ${r2s(s.expectancyR)} ${ci(s.expectancyBootstrapCI)} | ${s.profitFactor ?? '—'} | ${s.medianMfeR ?? '—'} | ${s.medianMaeR ?? '—'} | ${s.ece ?? '—'} | ${s.brier ?? '—'} | ${pct(s.stabilityPct)} |`);
  }
  return lines.join('\n') + '\n';
}

const o = sc.overall;
const md = [
  `# MTF Scorecard v2 — ${dateTag}`,
  '',
  `> Generated: ${new Date().toISOString()} · window: ${windowDays}d · ledger rows: ${sc.totalScans} (${sc.resolvedCount} resolved, ${sc.pendingCount} pending)`,
  `> Definitions: docs/ACCURACY-DEFINITIONS.md (frozen). Min-n gates: <30 insufficient · ≥100 reviewable · ≥150 decision-grade.`,
  `> Schema coverage: v2=${sc.schemaVersionCoverage.v2}, legacy=${sc.schemaVersionCoverage.legacy} · pWin coverage: ${sc.pWinCoveragePct ?? '—'}%`,
  '',
  '## Overall (resolved)',
  '',
  `- n: **${o.n}** (${o.gate?.state ?? '—'})`,
  `- Hit-TP1: **${pct(o.hitTp1Pct)}** Wilson 95% CI ${ci(o.hitTp1WilsonCI)}`,
  `- Hit-TP2: ${pct(o.hitTp2Pct)} · Stop-rate: ${pct(o.stopRatePct)} · Timeout: ${pct(o.timeoutRatePct)}`,
  `- Net expectancy: **${r2s(o.expectancyR)}** bootstrap 95% CI ${ci(o.expectancyBootstrapCI)} · PF ${o.profitFactor ?? '—'}`,
  `- Median MFE/MAE: ${o.medianMfeR ?? '—'}R / ${o.medianMaeR ?? '—'}R`,
  `- Calibration: ECE ${o.ece ?? '—'} (n=${o.eceN}) · Brier ${o.brier ?? '—'}`,
  `- Stability: ${pct(o.stabilityPct)} · avg time-to-TP1: ${o.avgTimeToTp1Min ?? '—'} min`,
  '',
  sliceTable('By tier', sc.byTier),
  sliceTable('By desk (market)', sc.byDesk),
  sliceTable('By regime', sc.byRegime),
  sliceTable('By side', sc.bySide),
  sliceTable('By session (IST)', sc.bySession),
  sliceTable('By tier × regime', sc.byTierRegime),
  '---',
  '',
  '_Honest note: ECE/Brier sirf unhi rows par hain jinka pWinClaimed record hua tha. n < 30 wale slices par koi decision na lo._',
  '',
].join('\n');

const outPath = path.resolve(APP_ROOT, 'docs', `SCORECARD-${dateTag}.md`);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, md, 'utf8');
console.log(`[scorecard] wrote ${path.relative(APP_ROOT, outPath)} (${sc.resolvedCount} resolved rows, window ${windowDays}d)`);
console.log(`[scorecard] overall Hit-TP1 ${pct(o.hitTp1Pct)} ${ci(o.hitTp1WilsonCI)} · expectancy ${r2s(o.expectancyR)} ${ci(o.expectancyBootstrapCI)} · gate: ${o.gate?.state}`);
