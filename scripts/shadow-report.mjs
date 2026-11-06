#!/usr/bin/env node
// ============================================================
// scripts/shadow-report.mjs — v21.32.0 [PHASE A5] COUNTERFACTUAL
// ------------------------------------------------------------
// MASTER PLAN (A5): har guard/flag ke liye would-block set vs taken
// set ka counterfactual outcome comparison:
//   useful   — blocked-set expectancy taken-set se significantly kharab
//              (bootstrap p<0.1 ya CI non-overlap) AUR n>=100 dono me
//   harmful  — blocked-set better (filter winners kaat raha hai)
//   neutral  — otherwise
//   invalid  — data-coverage < 80% (e.g. perp data present %)
//
// DATA SOURCES (read-only):
//   server/data/mtf-row-ledger.json   — rows with filtersFired[] (A3)
//                                       + resolved outcomes (outcomeR)
//   server/data/mtf-auto-state.json   — shadowStats per guard (decisions/
//                                       wouldBlock counts, R11 harness)
//
// OUTPUT:
//   docs/SHADOW-REPORT-<date>.md
//   docs/FLAG-HISTORY.md me ek "report generated" entry (koi flag flip
//   NAHI — promotion hamesha manual, typed-confirm rahta hai)
//
// SAFETY: read-only inputs; sirf docs likhta hai.
// USAGE: node scripts/shadow-report.mjs [--data-dir server/data]
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  wilson, bootstrapMeanCI, bootstrapCompareMean, minNGate,
} from './lib/stats.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, '..');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !String(v).startsWith('--') ? v : true;
}

const dataDir = path.resolve(APP_ROOT, String(arg('data-dir', 'server/data')));
const ledgerFile = path.join(dataDir, 'mtf-row-ledger.json');
const autoStateFile = path.join(dataDir, 'mtf-auto-state.json');

let rows = [];
try {
  const raw = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  rows = Array.isArray(raw?.rows) ? raw.rows : [];
} catch {
  console.error(`[shadow-report] ledger file nahi mila / invalid: ${ledgerFile}`);
  console.error('[shadow-report] Server chala lo (rows me filtersFired A3 schema se aate hain), phir dobara run karo.');
  process.exit(1);
}
let shadowStats = {};
try {
  const st = JSON.parse(fs.readFileSync(autoStateFile, 'utf8'));
  shadowStats = st?.shadowStats && typeof st.shadowStats === 'object' ? st.shadowStats : {};
} catch { /* optional source — fail-open */ }

const resolved = rows.filter((r) => r?.resolved === true && Number.isFinite(Number(r.outcomeR)));
const dateTag = new Date().toISOString().slice(0, 10);

// Guard discovery: ledger ke filtersFired me jo guards mile + harness stats me jo
const guards = new Map();
for (const r of resolved) {
  for (const f of Array.isArray(r.filtersFired) ? r.filtersFired : []) {
    const g = String(f?.guard || '').trim();
    if (!g) continue;
    if (!guards.has(g)) guards.set(g, { blocked: [], taken: [], seen: 0 });
    const rec = guards.get(g);
    rec.seen++;
    const wouldBlock = /block|would-block|veto/i.test(String(f?.verdict || ''));
    (wouldBlock ? rec.blocked : rec.taken).push(r);
  }
}
for (const g of Object.keys(shadowStats)) {
  if (!guards.has(g)) guards.set(g, { blocked: [], taken: [], seen: 0 });
}

const BLOCK_VERDICT_MIN_N = 100;   // A5: verdict tabhi valid jab n>=100
const COVERAGE_MIN_PCT = 80;       // A5: data-coverage < 80% → invalid

function summarize(list) {
  const n = list.length;
  const tp1 = list.filter((r) => r.outcome === 'T1_HIT' || r.outcome === 'T2_HIT').length;
  const rs = list.map((r) => Number(r.outcomeR));
  const w = wilson(tp1, n);
  const bci = bootstrapMeanCI(rs, 2000, 3);
  const wins = rs.filter((x) => x > 0).reduce((a, b) => a + b, 0);
  const losses = rs.filter((x) => x < 0).reduce((a, b) => a + b, 0);
  const maes = list.map((r) => Number(r.maeR)).filter(Number.isFinite);
  return {
    n,
    hitTp1Pct: n ? Math.round((tp1 / n) * 1000) / 10 : null,
    hitTp1CI: w.lo != null ? [Math.round(w.lo * 1000) / 10, Math.round(w.hi * 1000) / 10] : null,
    expectancyR: bci.mean != null ? Math.round(bci.mean * 100) / 100 : null,
    expCI: bci.lo != null ? [Math.round(bci.lo * 100) / 100, Math.round(bci.hi * 100) / 100] : null,
    pf: losses !== 0 ? Math.round((wins / Math.abs(losses)) * 100) / 100 : null,
    medianMaeR: maes.length ? maes.sort((a, b) => a - b)[Math.floor(maes.length / 2)] : null,
  };
}

const report = [];
for (const [g, data] of guards) {
  const harness = shadowStats[g];
  const blocked = summarize(data.blocked);
  const taken = summarize(data.taken);
  const coveragePct = resolved.length ? Math.round((data.seen / resolved.length) * 1000) / 10 : 0;
  const cmp = (data.blocked.length > 0 && data.taken.length > 0)
    ? bootstrapCompareMean(data.blocked.map((r) => Number(r.outcomeR)), data.taken.map((r) => Number(r.outcomeR)))
    : { p: null, diffMeans: null };
  let verdict = 'neutral';
  const reasons = [];
  if (coveragePct < COVERAGE_MIN_PCT) {
    verdict = 'invalid';
    reasons.push(`data-coverage ${coveragePct}% < ${COVERAGE_MIN_PCT}%`);
  }
  if (verdict !== 'invalid') {
    if (blocked.n < BLOCK_VERDICT_MIN_N || taken.n < BLOCK_VERDICT_MIN_N) {
      verdict = 'neutral';
      reasons.push(`n insufficient (blocked ${blocked.n}/${BLOCK_VERDICT_MIN_N}, taken ${taken.n}/${BLOCK_VERDICT_MIN_N}) — accumulate more shadow decisions`);
    } else if (cmp.p != null && cmp.diffMeans != null) {
      // diffMeans = taken − blocked (positive = taken-set better = filter useful)
      if (cmp.diffMeans > 0 && (cmp.p < 0.1 || (blocked.expCI && taken.expCI && blocked.expCI[1] < taken.expCI[0]))) {
        verdict = 'useful';
        reasons.push(`blocked-set ${blocked.expectancyR}R vs taken ${taken.expectancyR}R (p=${cmp.p.toFixed(3)})`);
      } else if (cmp.diffMeans < 0 && (cmp.p < 0.1 || (blocked.expCI && taken.expCI && taken.expCI[1] < blocked.expCI[0]))) {
        verdict = 'harmful';
        reasons.push(`blocked-set ${blocked.expectancyR}R BETTER than taken ${taken.expectancyR}R (p=${cmp.p.toFixed(3)}) — filter winners kaat raha hai`);
      } else {
        reasons.push(`no significant separation (p=${cmp.p.toFixed(3)}, Δ=${Math.round((cmp.diffMeans || 0) * 100) / 100}R)`);
      }
    } else {
      reasons.push('not enough rows on both sides');
    }
  }
  report.push({
    guard: g, verdict, reasons, coveragePct,
    harness: harness ? {
      decisions: harness.decisions ?? 0,
      wouldBlock: harness.wouldBlock ?? 0,
      wouldBlockPct: harness.wouldBlockPct ?? (Number(harness.decisions) > 0
        ? Math.round(((Number(harness.wouldBlock) || 0) / Number(harness.decisions)) * 1000) / 10
        : null),
    } : null,
    blocked, taken,
  });
}
report.sort((a, b) => {
  const rank = { harmful: 0, useful: 1, neutral: 2, invalid: 3 };
  return (rank[a.verdict] - rank[b.verdict]) || (b.blocked.n - a.blocked.n);
});

const fmtCI = (ci) => (ci ? `[${ci[0]}, ${ci[1]}]` : '—');
const lines = [
  `# Shadow Counterfactual Report — ${dateTag}`,
  '',
  `> Generated: ${new Date().toISOString()} · resolved ledger rows: ${resolved.length} (out of ${rows.length})`,
  `> Rule (A5): verdict **useful** = blocked-set significantly worse (p<0.1 ya CI non-overlap) + n≥100 dono sets + coverage≥${COVERAGE_MIN_PCT}%.`,
  `> **Koi flag flip nahi hua** — promotion hamesha manual (FLAG-HISTORY.md + typed confirm).`,
  '',
  '| guard | verdict | coverage | blocked n | blocked Hit-TP1 | blocked expR | taken n | taken Hit-TP1 | taken expR | ΔexpR | p | notes |',
  '|---|---|---|---|---|---|---|---|---|---|---|---|',
];
for (const r of report) {
  lines.push(`| ${r.guard} | **${r.verdict}** | ${r.coveragePct}% | ${r.blocked.n} | ${r.blocked.hitTp1Pct ?? '—'}% ${fmtCI(r.blocked.hitTp1CI)} | ${r.blocked.expectancyR ?? '—'}R | ${r.taken.n} | ${r.taken.hitTp1Pct ?? '—'}% ${fmtCI(r.taken.hitTp1CI)} | ${r.taken.expectancyR ?? '—'}R | ${(() => { if (r.blocked.expectancyR == null || r.taken.expectancyR == null) return '—'; const d = Math.round((r.taken.expectancyR - r.blocked.expectancyR) * 100) / 100; return `${d >= 0 ? '+' : ''}${d}`; })()} | ${(() => { const p = r.reasons.find((x) => /p=/.test(x)); return p ? p.match(/p=([0-9.]+)/)?.[1] : '—'; })()} | ${r.reasons.join('; ')}${r.harness ? ` · harness: ${r.harness.decisions} decisions, ${r.harness.wouldBlockPct ?? '—'}% would-block` : ''} |`);
}
lines.push('', '---', '');
if (report.length === 0) {
  lines.push('_Abhi tak kisi guard ke filtersFired records nahi mile — A3 schema v2 rows accumulate hone do (≥2 hafte data), phir ye report meaningful banega._');
} else {
  lines.push('### Promotion checklist (har flag ke liye, 15.2 rule)');
  lines.push('');
  lines.push('1. Shadow-report verdict `useful` (upar table)');
  lines.push('2. n ≥ 100–150 dono sets me');
  lines.push('3. Data-coverage ≥ 80%');
  lines.push('4. Koi DD worsening nahi (scorecard v2 se cross-check)');
  lines.push('5. 1 hafte observe, ek flag at a time');
  lines.push('6. FLAG-HISTORY.md entry + shadow-report link');
  lines.push('');
}
lines.push('_Verdict "harmful" wale guards ko demote karne ka case banao (config se `off`); "invalid" wale ka data pehle fix karo._', '');

const outPath = path.resolve(APP_ROOT, 'docs', `SHADOW-REPORT-${dateTag}.md`);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, lines.join('\n'), 'utf8');

// FLAG-HISTORY.md me "report generated" entry (flip record nahi — sirf audit trail)
const fhPath = path.resolve(APP_ROOT, 'docs', 'FLAG-HISTORY.md');
let fh = '';
try { fh = fs.readFileSync(fhPath, 'utf8'); } catch { fh = ''; }
const guardSummary = report.map((r) => r.guard + '=' + r.verdict).join(', ');
const entry = `| ${new Date().toISOString()} | (report) | shadow-report generated: ${path.basename(outPath)} — ${report.length} guard(s): ${guardSummary} | manual review pending |`;
if (fh.includes('## Flip log')) {
  fh = fh.replace('## Flip log\n', `## Flip log\n${entry}\n`);
} else {
  fh = `${fh}\n\n## Flip log\n${entry}\n`;
}
fs.writeFileSync(fhPath, fh, 'utf8');

console.log(`[shadow-report] wrote ${path.relative(APP_ROOT, outPath)}`);
for (const r of report) {
  console.log(`  ${r.guard.padEnd(24)} ${r.verdict.padEnd(8)} coverage ${String(r.coveragePct).padStart(5)}%  blocked n=${r.blocked.n}  taken n=${r.taken.n}`);
}
console.log(`[shadow-report] FLAG-HISTORY.md updated with report entry (no flag flips).`);
