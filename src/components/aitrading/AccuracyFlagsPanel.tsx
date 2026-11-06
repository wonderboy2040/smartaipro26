// ============================================================
// src/components/aitrading/AccuracyFlagsPanel.tsx — v21.33.0
// ------------------------------------------------------------
// MASTER PLAN [PHASE K1/K3]: "Accuracy & Health" strip + flag matrix.
// Data: GET /api/ai/accuracy-dashboard + GET /api/ai/flags (60s poll,
// self-contained — board ke 2s poll se alag, is panel par load nahi).
//
// KYA DIKHATA HAI:
//   • Drift verdict (STABLE/DRIFTING/ALARM) + champion version
//   • Flag matrix — har flag off/shadow/enforce chip (champion default
//     + env override honest display)
//   • Meta-model state (artifact hai ya nahi — n<300 par inactive)
//   • Calibration honesty: tier buckets jahan realised << claimed
//     (E5 OVERCONFIDENT warning)
//   • Latency P50/P95 lanes (B3)
//   • Promotion rule note — flips typed-confirm se hi hote hain
//
// YE PANEL SIRF READ-ONLY VIEW HAI. Flag changes operator typed-confirm
// endpoint se hote hain (FLAG-HISTORY audit ke saath) — UI se koi
// one-click live flag flip NAHI (plan J: "no silent auto-tune").
// ============================================================
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Activity } from 'lucide-react';
import { apiFetch, getProxyBase } from '../../utils/api';

type FlagState = { default: string; env: string | null; effective: string };

type FlagsResponse = {
  ok?: boolean;
  version?: string | null;
  gitSha?: string | null;
  baselineFile?: string | null;
  flags?: Record<string, FlagState>;
};

type DashboardResponse = {
  ok?: boolean;
  generatedAt?: string;
  version?: string;
  drift?: { verdict?: string; summary?: string };
  champion?: { version?: string | null; gitSha?: string | null };
  metaModel?: { available?: boolean; version?: string; n?: number; reason?: string };
  latency?: { available?: boolean; lanes?: Record<string, { n?: number; p50Ms?: number | null; p95Ms?: number | null }> };
  ledgerHealth?: { totalRows?: number; resolved?: number; pending?: number; schemaVersion2Pct?: number };
  calibrationByTier?: Record<string, { n?: number; claimedPct?: number | null; realisedPct?: number | null; overconfident?: boolean }>;
  shadowSummary?: { available?: boolean; guards?: Record<string, { seen?: number; wouldBlock?: number; wouldBlockPct?: number }> };
};

const MODE_STYLE: Record<string, string> = {
  enforce: 'bg-emerald-500/15 text-emerald-200 border-emerald-400/40',
  shadow: 'bg-amber-500/15 text-amber-200 border-amber-400/40',
  off: 'bg-slate-800/60 text-slate-400 border-slate-700',
};

const DRIFT_STYLE: Record<string, string> = {
  STABLE: 'bg-emerald-500/15 text-emerald-200 border-emerald-400/40',
  DRIFTING: 'bg-amber-500/15 text-amber-200 border-amber-400/40',
  ALARM: 'bg-rose-500/15 text-rose-200 border-rose-400/50',
};

export const AccuracyFlagsPanel = memo(function AccuracyFlagsPanel() {
  const [flags, setFlags] = useState<FlagsResponse | null>(null);
  const [dash, setDash] = useState<DashboardResponse | null>(null);
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inflight = useRef(false);

  const load = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    try {
      const [f, d] = await Promise.all([
        apiFetch(`${getProxyBase()}/api/ai/flags?t=${Date.now()}`, { signal: AbortSignal.timeout(12000) }).catch(() => null),
        apiFetch(`${getProxyBase()}/api/ai/accuracy-dashboard?t=${Date.now()}`, { signal: AbortSignal.timeout(15000) }).catch(() => null),
      ]);
      if (f?.ok) { setFlags(await f.json()); setErr(null); } else if (f) setErr('flags unavailable');
      if (d?.ok) setDash(await d.json());
    } catch {
      setErr('accuracy dashboard unavailable');
    } finally {
      inflight.current = false;
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => { void load(); }, 60_000);
    return () => { clearInterval(t); };
  }, [load]);

  const flagEntries = Object.entries(flags?.flags || {});
  const driftVerdict = String(dash?.drift?.verdict || '?').toUpperCase();
  const overconfidentTiers = Object.entries(dash?.calibrationByTier || {}).filter(([, v]) => v?.overconfident);
  const latencyLanes = Object.entries(dash?.latency?.lanes || {});

  return (
    <div data-testid="accuracy-flags-panel" className="mt-2 rounded-xl border border-violet-500/25 bg-slate-950/80 px-3 py-1.5">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <button type="button" onClick={() => { setOpen(!open); if (!open) void load(); }}
          className="flex items-center gap-1.5 text-[9px] font-black tracking-wider uppercase text-violet-300 hover:text-violet-200">
          <Activity size={11} /> 🎯 Accuracy &amp; Health / Flags
          <span className="text-slate-500">{open ? '▲' : '▼'}</span>
        </button>
        <div className="flex items-center gap-1.5 flex-wrap text-[9px] font-mono">
          <span className={`px-1.5 py-0.5 rounded border font-black ${DRIFT_STYLE[driftVerdict] || MODE_STYLE.off}`}>
            DRIFT: {driftVerdict}
          </span>
          <span className="px-1.5 py-0.5 rounded bg-slate-900 border border-slate-700/70 text-slate-300">
            champion v{flags?.version || dash?.champion?.version || '—'}
          </span>
          <span className="px-1.5 py-0.5 rounded bg-slate-900 border border-slate-700/70 text-slate-300">
            meta-model {dash?.metaModel?.available ? `✓ v${dash.metaModel.version} (n=${dash.metaModel.n})` : 'inactive'}
          </span>
          {flagEntries.length > 0 && (
            <span className="px-1.5 py-0.5 rounded bg-slate-900 border border-slate-700/70 text-slate-400">
              {flagEntries.filter(([, f]) => f.effective === 'enforce').length} enforce · {flagEntries.filter(([, f]) => f.effective === 'shadow').length} shadow · {flagEntries.filter(([, f]) => f.effective === 'off').length} off
            </span>
          )}
          {err && <span className="text-[8px] text-rose-300/80">{err}</span>}
        </div>
      </div>

      {open && (
        <div className="mt-1.5 border-t border-slate-800/80 pt-1.5">
          {/* Flag matrix */}
          <div className="flex items-center gap-1 flex-wrap text-[9px] font-mono">
            {flagEntries.map(([name, f]) => (
              <span key={`flag-${name}`} data-testid={`flag-chip-${name}`}
                className={`px-1.5 py-0.5 rounded border font-bold ${MODE_STYLE[String(f.effective).toLowerCase()] || MODE_STYLE.off}`}
                title={`${name} — default ${f.default}${f.env ? ` · env ${f.env}` : ''} → effective ${f.effective}`}>
                {name}: {String(f.effective).toUpperCase()}
              </span>
            ))}
          </div>

          {/* Calibration honesty (E5) */}
          {overconfidentTiers.length > 0 && (
            <div className="mt-1 text-[9px] font-mono text-rose-200">
              ⚠ OVERCONFIDENT: {overconfidentTiers.map(([tier, v]) => `${tier} claimed ${v.claimedPct}% → realised ${v.realisedPct}% (n=${v.n})`).join(' · ')}
            </div>
          )}

          {/* Latency lanes (B3) */}
          {latencyLanes.length > 0 && (
            <div className="mt-1 flex items-center gap-2 flex-wrap text-[9px] font-mono text-slate-300">
              <span className="font-black text-slate-400 uppercase">⏱ Latency:</span>
              {latencyLanes.map(([lane, v]) => (
                <span key={`lat-${lane}`} className="px-1.5 py-0.5 rounded bg-slate-900 border border-slate-700/70">
                  {lane}: P50 {v.p50Ms != null ? `${v.p50Ms}ms` : '—'} · P95 {v.p95Ms != null ? `${v.p95Ms}ms` : '—'}
                </span>
              ))}
            </div>
          )}

          {/* Ledger health */}
          {dash?.ledgerHealth && (
            <div className="mt-1 flex items-center gap-2 flex-wrap text-[9px] font-mono text-slate-400">
              <span>ledger: {dash.ledgerHealth.totalRows ?? 0} rows · {dash.ledgerHealth.resolved ?? 0} resolved · fv2 {dash.ledgerHealth.schemaVersion2Pct ?? 0}%</span>
              {dash?.metaModel && !dash.metaModel.available && (
                <span className="text-slate-500">({dash.metaModel.reason || 'meta-model inactive'})</span>
              )}
            </div>
          )}

          <div className="mt-1 text-[8px] text-slate-500">
            Flag flips promoted hone ke liye: shadow-report verdict useful + n ≥ 100–150 + coverage ≥ 80% + 1 hafte observe + typed-confirm (FLAG-HISTORY audit). Promotion kabhi silent/auto nahi.
          </div>
        </div>
      )}
    </div>
  );
});
