// ============================================================
// server/ai/accuracyDashboard.js — v21.33.0 [PHASE K1]
// ------------------------------------------------------------
// MASTER PLAN Phase K1: single "Accuracy & Health" view aggregator.
// Scorecard-v2 slices + drift verdict + flag matrix + shadow-report
// summary + latency P50/P95 + meta-model state + protection stats
// ek payload me — /api/ai/accuracy-dashboard serve karta hai.
//
// READ-ONLY aggregate. Koi exchange call nahi, koi decision nahi.
// Har section independently fail-open hota hai (ek source down →
// uska verdict "unavailable", baaki dashboard zinda).
// ============================================================
import { computeMtfDirectionScorecardV2, getMtfLedgerSnapshot } from './signalLedger.js';
import { driftReport } from './driftMonitor.js';
import { flagMatrixSnapshot } from './championChallenger.js';
import { loadMetaModel } from './metaModel.js';
import { latencyRecorder, percentileMs } from './lib/latencyStats.js';

function _safe(fn, fallback) {
  try {
    const v = fn();
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}

function _latencySummary() {
  return _safe(() => {
    const rec = latencyRecorder();
    if (!rec || typeof rec.snapshot !== 'function') return { available: false };
    const snap = rec.snapshot();
    const lanes = {};
    for (const [lane, samples] of Object.entries(snap?.lanes || {})) {
      lanes[lane] = {
        n: Array.isArray(samples) ? samples.length : 0,
        p50Ms: Array.isArray(samples) && samples.length ? Math.round(percentileMs(samples, 0.5)) : null,
        p95Ms: Array.isArray(samples) && samples.length ? Math.round(percentileMs(samples, 0.95)) : null,
      };
    }
    return { available: Object.keys(lanes).length > 0, lanes };
  }, { available: false });
}

function _ledgerHealth(rows) {
  return _safe(() => {
    const resolved = rows.filter((r) => r?.resolved === true);
    const pending = rows.filter((r) => r?.resolved !== true);
    const fv2 = rows.filter((r) => Number(r?.featureSnapshot?.fv) === 2).length;
    const withFilters = rows.filter((r) => Array.isArray(r?.filtersFired) && r.filtersFired.length > 0).length;
    const withLatency = rows.filter((r) => Number.isFinite(Number(r?.latencyMs))).length;
    const n = rows.length || 1;
    return {
      totalRows: rows.length,
      resolved: resolved.length,
      pending: pending.length,
      schemaVersion2Pct: Math.round((fv2 / n) * 100),
      filtersFiredCoveragePct: Math.round((withFilters / n) * 100),
      latencyCoveragePct: Math.round((withLatency / n) * 100),
    };
  }, { available: false });
}

function _shadowSummary(rows) {
  return _safe(() => {
    const guardStats = {};
    for (const r of rows) {
      for (const f of Array.isArray(r?.filtersFired) ? r.filtersFired : []) {
        const g = String(f?.guard || '?');
        if (!guardStats[g]) guardStats[g] = { seen: 0, wouldBlock: 0 };
        guardStats[g].seen += 1;
        if (/block/i.test(String(f?.verdict || ''))) guardStats[g].wouldBlock += 1;
      }
    }
    for (const s of Object.values(guardStats)) {
      s.wouldBlockPct = s.seen ? Math.round((s.wouldBlock / s.seen) * 100) : 0;
    }
    return { available: Object.keys(guardStats).length > 0, guards: guardStats };
  }, { available: false });
}

/**
 * K1 — the full dashboard payload. Pure aggregation, fail-open per
 * section. `minNGate` semantics (A4): n<30 insufficient, n>=100
 * reviewable, n>=150 decision-grade.
 */
export function buildAccuracyDashboard({ now = Date.now(), windowDays = 30 } = {}) {
  const ts = Number(now) || Date.now();
  const rows = _safe(() => getMtfLedgerSnapshot().rows, []);

  const scorecard = _safe(() => computeMtfDirectionScorecardV2({ windowDays, now: ts }), null);
  const drift = _safe(() => driftReport({ now: ts }), null);
  const flags = _safe(() => flagMatrixSnapshot(), { flags: {} });
  const meta = _safe(() => loadMetaModel(), null);
  const latency = _latencySummary();
  const ledgerHealth = _ledgerHealth(rows);
  const shadow = _shadowSummary(rows);

  // E5 calibration honesty: claimed vs realised per tier bucket
  const calibration = _safe(() => {
    const byTier = {};
    for (const r of rows) {
      if (r?.resolved !== true) continue;
      const tier = r.tier || 'UNKNOWN';
      if (!byTier[tier]) byTier[tier] = { n: 0, claimed: [], realised: [] };
      byTier[tier].n += 1;
      const p = Number(r.pWinClaimed);
      if (Number.isFinite(p)) byTier[tier].claimed.push(p);
      const win = r.outcome === 'T1_HIT' || r.outcome === 'T2_HIT' ? 1 : 0;
      byTier[tier].realised.push(win);
    }
    const out = {};
    for (const [tier, s] of Object.entries(byTier)) {
      const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
      const claimed = mean(s.claimed);
      const realised = mean(s.realised);
      const overconfident = claimed != null && realised != null && s.n >= 30 && realised < claimed - 0.10;
      out[tier] = {
        n: s.n,
        claimedPct: claimed == null ? null : Math.round(claimed * 100),
        realisedPct: realised == null ? null : Math.round(realised * 100),
        overconfident,
        note: overconfident ? 'OVERCONFIDENT warning: realised < claimed − 10pt (E5)' : null,
      };
    }
    return out;
  }, {});

  return {
    ok: true,
    generatedAt: new Date(ts).toISOString(),
    windowDays,
    version: 'accuracy-dashboard/1',
    scorecard,
    drift: drift ? { verdict: drift.verdict, summary: drift.summary, ts: drift.ts } : { verdict: 'UNAVAILABLE' },
    flags: flags.flags || {},
    champion: { version: flags.version, gitSha: flags.gitSha, baselineFile: flags.baselineFile },
    metaModel: meta
      ? { available: true, version: meta.version, n: meta.n, metrics: meta.metrics }
      : { available: false, reason: 'no artifact (n<300 ya OOS fail) — calibrated rule score active' },
    latency,
    ledgerHealth,
    shadowSummary: shadow,
    calibrationByTier: calibration,
    kpiTargets: {
      netExpectancy: 'lower 95% CI > 0 at n>=150 (per promoted tier)',
      hitTp1VsBaseline: '>= +3-5pts ya same hit-rate with fewer trades',
      ece: '<= 5pt on decision-grade buckets',
      signalStability: '>= 85-90% bar-close survival',
      protection: '100% live trades SL verified within 10s; 0 naked positions',
      directionInvariants: '0 violations (selftest + property tests)',
    },
  };
}
