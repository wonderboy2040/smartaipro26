// ============================================================
// src/components/aitrading/MTFSignalsBoardPanel.tsx — v21.16.0
// ------------------------------------------------------------
// MTF DUAL-TIMEFRAME SIGNALS BOARD + SUPERINTELLIGENCE (USER SPEC):
//   INTRADAY mode → 15m TF = deep candle analysis (bias boss)
//                   5m TF  = action (entry / SL / TP timing)
//                   exit window = 15–20 min (3–4 bars of 5m)
//   SWING mode    → 1h TF  = deep candle analysis (bias boss)
//                   15m TF = action (entry / SL / TP timing)
//                   exit window = 60–90 min (4–6 bars of 15m)
//
// v21.16.0 SUPERINTELLIGENCE: har signal ka SUPER score (confluence
// engine conviction + 7-factor expert blend — trend/momentum/volume/
// SMC-zones/volatility/regime/R:R) + tier ladder (ELITE 85+ / STRONG
// 80+ / ACTION 65+ / WATCH) + staged-exit blueprint (T1 40% + BE-lock,
// T2 40%, runner 20% trail).
//
// v21.16.0 AUTO-LINK (USER SPEC: "75+ score strong signals ko paper
// trade auto se link karo"): AUTO strip toggle ON karo → 75+ ARMED
// fresh signals paper tickets auto-open hote hain (server loop 30s,
// quota/cooldown/per-symbol gated) + hold-window TIME-EXIT bhi live
// (mtfAutoEntry.js). WAIT 70-cap · CONFLICT 0 — by construction kabhi
// auto-link nahi hote.
//
// Data: GET /api/ai/mtf-board (mtfBoard.js) + /api/ai/mtf-auto/status
// (mtfAutoEntry.js). Self-fetching + 60s auto-refresh.
// ============================================================
import { memo, useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { apiFetch, getProxyBase } from '../../utils/api';
import type { MarketKind, MtfBoard, MtfBoardMode, MtfBoardSignal, MtfAutoStatus, MtfSignalState, MtfSuperTier } from './types';

const inr = (v: number | null | undefined, dp = 0) =>
  v == null || !Number.isFinite(v) ? '—' : `₹${v.toLocaleString('en-IN', { maximumFractionDigits: dp })}`;
const usd = (v: number | null | undefined) =>
  v == null || !Number.isFinite(v) ? '—' : `$${v.toLocaleString('en-US', { maximumFractionDigits: v >= 100 ? 2 : 4 })}`;

const MODES: Array<{ key: MtfBoardMode; label: string; hint: string }> = [
  { key: 'intraday', label: '⚡ INTRADAY', hint: '15m analysis → 5m action · exit 15–20 min' },
  { key: 'swing', label: '🌊 SWING 1–1.5hr', hint: '1h analysis → 15m action · exit 60–90 min' },
];

async function fetchMtfBoard(market: MarketKind, mode: MtfBoardMode): Promise<MtfBoard | null> {
  const m = market === 'INDIA' ? 'INDIA' : 'CRYPTO';
  try {
    const r = await apiFetch(`${getProxyBase()}/api/ai/mtf-board?market=${m}&mode=${mode}&t=${Date.now()}`, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

// v21.16.0 AUTO-LINK status + toggle (mtfAutoEntry.js endpoints)
async function fetchMtfAutoStatus(): Promise<MtfAutoStatus | null> {
  try {
    const r = await apiFetch(`${getProxyBase()}/api/ai/mtf-auto/status?t=${Date.now()}`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}
async function toggleMtfAuto(enabled: boolean): Promise<MtfAutoStatus | null> {
  try {
    const r = await apiFetch(`${getProxyBase()}/api/ai/mtf-auto/toggle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    return await r.json().catch(() => null);
  } catch { return null; }
}

// ---------------- chips & colors ----------------
function stateChipCls(state: MtfSignalState): string {
  if (state === 'ARMED') return 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/50';
  if (state === 'WAIT') return 'bg-amber-500/15 text-amber-300 border border-amber-500/40';
  if (state === 'CONFLICT') return 'bg-red-500/15 text-red-300 border border-red-500/40';
  return 'bg-slate-600/20 text-slate-400 border border-slate-600/30';
}
function stateLabel(state: MtfSignalState): string {
  if (state === 'ARMED') return '🎯 ARMED — trade ready';
  if (state === 'WAIT') return '⏳ WAIT — bias set, trigger pending';
  if (state === 'CONFLICT') return '⚔ CONFLICT — no trade';
  return '· NO BIAS';
}
function biasCls(bias?: string): string {
  if (bias === 'BULLISH') return 'text-emerald-300';
  if (bias === 'BEARISH') return 'text-red-300';
  return 'text-slate-400';
}
function timingCls(q?: string): string {
  if (q === 'GOOD') return 'text-emerald-300';
  if (q === 'CAUTION') return 'text-amber-300';
  if (q === 'POOR' || q === 'BLOCKED') return 'text-red-300';
  return 'text-slate-500';
}

// v21.16.0 — superintel tier chips
function tierCls(tier?: MtfSuperTier): string {
  if (tier === 'ELITE') return 'bg-fuchsia-500/20 text-fuchsia-300 border border-fuchsia-500/50';
  if (tier === 'STRONG') return 'bg-violet-500/20 text-violet-300 border border-violet-500/50';
  if (tier === 'ACTION') return 'bg-cyan-500/15 text-cyan-300 border border-cyan-500/40';
  if (tier === 'WATCH') return 'bg-slate-600/20 text-slate-400 border border-slate-600/40';
  return 'bg-slate-700/20 text-slate-500 border border-slate-700/40';
}
function superScoreCls(score: number): string {
  if (score >= 85) return 'text-fuchsia-300';
  if (score >= 80) return 'text-violet-300';
  if (score >= 75) return 'text-cyan-300';
  return 'text-slate-400';
}

function strengthBar(strength: number): ReactElement {
  const w = Math.max(2, Math.min(100, strength));
  const color = strength >= 60 ? 'bg-emerald-400' : strength >= 35 ? 'bg-cyan-400' : 'bg-slate-500';
  return (
    <div className="flex items-center gap-1">
      <div className="h-1.5 w-14 rounded-full bg-black/40 overflow-hidden" title={`analysis-TF bias strength ${strength}/100`}>
        <div className={`h-full ${color}`} style={{ width: `${w}%` }} />
      </div>
      <span className="text-[9px] font-mono text-slate-500">{strength}</span>
    </div>
  );
}

// ---------------- one signal card ----------------
function MtfSignalCard({ sig, market, modeLabel }: { sig: MtfBoardSignal; market: MarketKind; modeLabel: string }) {
  const a = sig.analysis;
  const act = sig.action;
  const sup = sig.super;
  const bp = sig.blueprint;
  const fmt = market === 'CRYPTO' ? usd : inr;
  const long = sig.side === 'LONG';
  const armed = sig.state === 'ARMED';

  return (
    <div className={`bg-black/25 rounded-xl p-3 ${armed ? (long ? 'border-l-2 border-l-emerald-500' : 'border-l-2 border-l-red-500') : 'border-l-2 border-l-slate-600/60'} ${sig.stale ? 'opacity-60' : ''}`}>
      {/* header */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs font-black text-white">{sig.symbol}</span>
        {sig.side && (
          <span className={`px-1.5 py-0.5 rounded text-[9px] font-black ${long ? 'bg-emerald-500/15 text-emerald-300' : 'bg-red-500/15 text-red-300'}`}>{sig.side}</span>
        )}
        <span className={`px-1.5 py-0.5 rounded text-[9px] font-black ${stateChipCls(sig.state)}`}>{stateLabel(sig.state)}</span>
        <span className="px-1.5 py-0.5 rounded text-[9px] font-black bg-violet-500/15 text-violet-300 border border-violet-500/30" title="confluence score — ALIGNMENT of TFs (count nahi, alignment accuracy deta hai)">
          CS {sig.confluenceScore}
        </span>
        {sup && (
          <span className={`px-1.5 py-0.5 rounded text-[9px] font-black ${tierCls(sup.tier)}`} title={`SUPERINTELLIGENCE score — confluence (${sig.confluenceScore}) + 7-factor expert (${sup.expertScore ?? '—'}) blend${sup.drivers?.length ? ' · ' + sup.drivers.join(' · ') : ''}`}>
            🧠 SUPER {sup.aiScore} · {sup.tier}
          </span>
        )}
        {sig.autoTrade?.eligible && (
          <span className="px-1.5 py-0.5 rounded text-[9px] font-black bg-amber-400/20 text-amber-200 border border-amber-400/50 animate-pulse" title={`75+ AUTO-LINK eligible — auto-link ON hone par ye signal paper trade me auto-open hoga (bar: ${sig.autoTrade.bar})`}>
            ⚡ AUTO-LINK
          </span>
        )}
        <span className="ml-auto flex items-center gap-2">
          {sig.stale && <span className="text-[8px] font-mono text-amber-500/80" title="candle data stale — session closed ho sakti hai">STALE</span>}
          <span className="text-[11px] font-mono text-slate-300">{fmt(sig.ltp)}</span>
          {sig.changePct != null && (
            <span className={`text-[10px] font-mono font-bold ${sig.changePct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
              {sig.changePct >= 0 ? '+' : ''}{sig.changePct.toFixed(2)}%
            </span>
          )}
        </span>
      </div>

      <div className="mt-2 grid gap-2 md:grid-cols-2">
        {/* ---- ANALYSIS TF block (deep read) ---- */}
        <div className="rounded-lg bg-cyan-500/5 border border-cyan-500/15 p-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[9px] font-black text-cyan-300 tracking-wide">🔍 ANALYSIS · {a?.tf ?? '—'} (bias boss)</span>
            {a && <span className={`text-[10px] font-black ${biasCls(a.bias)}`}>{a.bias}</span>}
          </div>
          {a && (
            <div className="mt-1.5 space-y-1">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[9px] font-mono text-slate-500">trend: {a.trend.label}</span>
                {strengthBar(a.strength)}
              </div>
              <div className="text-[9px] font-mono text-slate-400">
                structure: <span className={a.structure.dir > 0 ? 'text-emerald-400' : a.structure.dir < 0 ? 'text-red-400' : 'text-slate-400'}>{a.structure.label}</span>
              </div>
              <div className="grid grid-cols-4 gap-1 text-center text-[9px] font-mono">
                <div className="bg-black/30 rounded px-1 py-0.5"><div className="text-slate-600 text-[8px]">RSI</div><div className="text-slate-300">{a.momentum.rsi ?? '—'}</div></div>
                <div className="bg-black/30 rounded px-1 py-0.5"><div className="text-slate-600 text-[8px]">ADX</div><div className="text-slate-300">{a.strengthAdx.adx ?? '—'}</div></div>
                <div className="bg-black/30 rounded px-1 py-0.5"><div className="text-slate-600 text-[8px]">KEY HI</div><div className="text-slate-300">{a.structure.keyHigh != null ? fmt(a.structure.keyHigh) : '—'}</div></div>
                <div className="bg-black/30 rounded px-1 py-0.5"><div className="text-slate-600 text-[8px]">KEY LO</div><div className="text-slate-300">{a.structure.keyLow != null ? fmt(a.structure.keyLow) : '—'}</div></div>
              </div>
              <div className="text-[9px] text-cyan-200/70 italic leading-snug">🕯 {a.candleReadNote}</div>
            </div>
          )}
        </div>

        {/* ---- ACTION TF block (entry/SL/TP) ---- */}
        <div className={`rounded-lg p-2 border ${armed ? 'bg-emerald-500/5 border-emerald-500/20' : 'bg-black/30 border-slate-700/30'}`}>
          <div className="flex items-center justify-between gap-2">
            <span className="text-[9px] font-black text-amber-300 tracking-wide">⚡ ACTION · {act?.tf ?? '—'} (timing)</span>
            {act?.trigger && <span className="px-1 py-0.5 rounded text-[8px] font-black bg-amber-500/15 text-amber-200 border border-amber-500/30">{act.trigger}</span>}
          </div>
          {act && (
            <div className="mt-1.5 space-y-1">
              <div className="text-[9px] text-slate-400 leading-snug">{act.triggerNote || '—'}</div>
              {act.state === 'ARMED' && act.entry != null && (
                <div className="grid grid-cols-4 gap-1 text-center text-[9px] font-mono">
                  <div className="bg-black/30 rounded px-1 py-0.5"><div className="text-slate-600 text-[8px]">ENTRY</div><div className="text-slate-200">{fmt(act.entry)}</div></div>
                  <div className="bg-red-500/10 rounded px-1 py-0.5"><div className="text-red-400/70 text-[8px]">SL</div><div className="text-red-300">{act.stopLoss != null ? fmt(act.stopLoss) : '—'}</div></div>
                  <div className="bg-emerald-500/10 rounded px-1 py-0.5"><div className="text-emerald-400/70 text-[8px]">TP1 (1.5R)</div><div className="text-emerald-300">{act.target1 != null ? fmt(act.target1) : '—'}</div></div>
                  <div className="bg-emerald-500/10 rounded px-1 py-0.5"><div className="text-emerald-400/70 text-[8px]">TP2 (2.5R)</div><div className="text-emerald-300">{act.target2 != null ? fmt(act.target2) : '—'}</div></div>
                </div>
              )}
              <div className="flex items-center gap-2 flex-wrap text-[9px] font-mono">
                {act.entryZone && <span className="text-slate-500">zone: {fmt(act.entryZone[0])}–{fmt(act.entryZone[1])}</span>}
                {act.riskPct != null && <span className="text-slate-500">risk: {act.riskPct}%</span>}
                <span className={timingCls(act.timing.quality)} title={act.timing.note}>⏱ {act.timing.quality}</span>
                {act.rsi != null && <span className="text-slate-500">RSI {Math.round(act.rsi)}</span>}
              </div>
              {act.slBasis && <div className="text-[8px] font-mono text-slate-600 leading-snug">SL: {act.slBasis}</div>}
            </div>
          )}
        </div>
      </div>

      {/* ---- exit plan (time-boxed) ---- */}
      {sig.exit && (
        <div className="mt-1.5 flex items-center gap-2 flex-wrap text-[9px] font-mono">
          <span className="px-1.5 py-0.5 rounded bg-violet-500/10 text-violet-300 border border-violet-500/25" title={sig.exit.timeStopNote}>
            ⏰ {modeLabel}: {sig.exit.holdWindowMin[0]}–{sig.exit.holdWindowMin[1]} min ({sig.exit.expectedBars})
          </span>
          <span className="text-slate-500" title={sig.exit.trailNote}>TP1 → SL@entry (breakeven)</span>
        </div>
      )}

      {/* ---- v21.16.0: SUPERINTELLIGENCE 7-factor strip + blueprint ---- */}
      {sup?.factors && sup.factors.length > 0 && (
        <div className="mt-2 rounded-lg bg-fuchsia-500/5 border border-fuchsia-500/15 p-2">
          <div className="flex items-center justify-between gap-2 mb-1.5">
            <span className="text-[9px] font-black text-fuchsia-300 tracking-wide">🧠 SUPERINTEL · 7-factor expert {sup.expertScore != null ? `(${sup.expertScore}/100)` : ''}</span>
            <span className={`text-[9px] font-black ${superScoreCls(sup.aiScore)}`} title="confluence conviction + expert factors blend">
              composite {sup.aiScore}/100
            </span>
          </div>
          <div className="grid grid-cols-7 gap-1">
            {sup.factors.map(f => (
              <div key={f.key} className="text-center" title={`${f.label}: ${f.value}/100 (weight ${Math.round(f.weight * 100)}%)`}>
                <div className="h-1 rounded-full bg-black/40 overflow-hidden">
                  <div
                    className={`h-full ${f.value >= 70 ? 'bg-emerald-400' : f.value >= 50 ? 'bg-cyan-400' : 'bg-red-400/70'}`}
                    style={{ width: `${Math.max(3, Math.min(100, f.value))}%` }}
                  />
                </div>
                <div className={`text-[8px] font-mono mt-0.5 ${f.value >= 70 ? 'text-emerald-300' : f.value >= 50 ? 'text-slate-400' : 'text-red-300/80'}`}>{f.value}</div>
              </div>
            ))}
          </div>
          {sup.quality.extensionVeto && (
            <div className="text-[8px] font-mono text-red-300/80 mt-1">⚠ extension veto — timing POOR (RSI exhaustion), score capped</div>
          )}
        </div>
      )}
      {bp && (
        <div className="mt-1.5 rounded-lg bg-black/30 border border-slate-700/40 p-2">
          <div className="flex items-center justify-between gap-2 mb-1">
            <span className="text-[9px] font-black text-amber-200 tracking-wide">📋 PRO BLUEPRINT — staged exits (40/40/20)</span>
            <span className="text-[8px] font-mono text-slate-500" title={bp.entryTiming.note}>{bp.entryTiming.mode === 'IMMEDIATE' ? '⏱ entry window OPEN' : '⏱ pullback limit zone'}</span>
          </div>
          <div className="grid grid-cols-3 gap-1 text-center text-[9px] font-mono">
            {bp.exitPlan.slice(0, 3).map((e, i) => (
              <div key={i} className="bg-black/30 rounded px-1 py-0.5" title={e.action}>
                <div className="text-slate-600 text-[8px]">T{i + 1} · {e.bookPct}%</div>
                <div className="text-emerald-300">{fmt(e.at)}</div>
              </div>
            ))}
          </div>
          <div className="text-[8px] font-mono text-slate-600 mt-1 leading-snug">{bp.invalidation} · {bp.leverageNote}</div>
        </div>
      )}

      {/* ---- reasons ---- */}
      {sig.reasons.length > 0 && (
        <ul className="mt-1.5 space-y-0.5">
          {sig.reasons.slice(0, 4).map((r, i) => (
            <li key={i} className="text-[9px] text-slate-500 leading-snug">• {r}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------- the board panel ----------------
export const MTFSignalsBoardPanel = memo(function MTFSignalsBoardPanel({ market = 'INDIA' }: { market?: MarketKind }) {
  const [mode, setMode] = useState<MtfBoardMode>('intraday');
  const [board, setBoard] = useState<MtfBoard | null>(null);
  const [loading, setLoading] = useState(false);
  const [showHow, setShowHow] = useState(false);
  // v21.16.0 AUTO-LINK state (server loop status + toggle)
  const [autoSt, setAutoSt] = useState<MtfAutoStatus | null>(null);
  const [autoBusy, setAutoBusy] = useState(false);
  // stale-response guard (SwingDeskPanel discipline) + 5s auto-refresh (P4)
  const seqRef = useRef(0);
  const modeRef = useRef(mode);
  modeRef.current = mode;

  const load = useCallback(async (m: MtfBoardMode) => {
    const seq = ++seqRef.current;
    setLoading(true);
    const v = await fetchMtfBoard(market, m);
    if (seq !== seqRef.current) return; // newer mode-switch owns the panel
    setBoard(v);
    setLoading(false);
  }, [market]);

  const loadAuto = useCallback(async () => {
    setAutoSt(await fetchMtfAutoStatus());
  }, []);

  const onToggleAuto = useCallback(async () => {
    if (autoBusy) return;
    setAutoBusy(true);
    try {
      const next = !(autoSt?.enabled ?? false);
      const st = await toggleMtfAuto(next);
      if (st) setAutoSt(st);
      if (next) load(modeRef.current); // ON hote hi fresh board — AUTO badges live
    } finally { setAutoBusy(false); }
  }, [autoBusy, autoSt, load]);

  useEffect(() => { load(mode); }, [load, mode]);
  useEffect(() => { loadAuto(); }, [loadAuto]);
  useEffect(() => {
    // P4 (ultra-fast prices): 60s → 5s board refresh. The server caches the
    // board scan on a 2s TTL, so a 5s client poll stays cheap (mostly a
    // cache read) while the board no longer sits up-to-a-minute stale.
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') {
        load(modeRef.current);
        loadAuto();
      }
    }, 5_000);
    return () => clearInterval(t);
  }, [load, loadAuto]);

  const cfg = board?.modeCfg;
  const counts = board?.counts;
  const ageS = board?.generatedAt ? Math.max(0, Math.round((Date.now() - board.generatedAt) / 1000)) : null;
  const modeMeta = MODES.find(m => m.key === mode)!;
  const autoOn = autoSt?.enabled ?? false;
  const lastEntry = autoSt?.lastEntry;
  const lastEntryAgeMin = lastEntry?.at ? Math.max(0, Math.round((Date.now() - lastEntry.at) / 60000)) : null;

  return (
    <div className="quantum-panel rounded-2xl p-4">
      {/* header */}
      <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
        <span className="text-xs font-black text-slate-200">
          🧭 MTF Signals Board — {market === 'INDIA' ? 'NSE' : 'crypto'} · {cfg?.analysisTf ?? (mode === 'intraday' ? '15m' : '1h')} analysis → {cfg?.actionTf ?? (mode === 'intraday' ? '5m' : '15m')} action
        </span>
        <div className="flex items-center gap-2">
          <span className="px-2 py-0.5 rounded-md text-[9px] font-black bg-fuchsia-500/10 text-fuchsia-300 border border-fuchsia-500/20" title="SUPERINTELLIGENCE v21.16 — confluence + 7-factor expert composite">superintel</span>
          <span className="px-2 py-0.5 rounded-md text-[9px] font-black bg-violet-500/10 text-violet-300 border border-violet-500/20">confluence desk</span>
          <button onClick={() => load(mode)} className="quantum-btn-ghost px-2 py-1 rounded-lg text-[10px] font-bold" aria-label="Refresh MTF board">
            <span className={loading ? 'inline-block animate-spin' : ''}>🔄</span>
          </button>
        </div>
      </div>

      {/* v21.16.0 AUTO-LINK control strip — 75+ strong signals paper auto-entry */}
      <div className={`rounded-xl border p-2.5 mb-2.5 ${autoOn ? 'bg-amber-500/10 border-amber-500/40' : 'bg-black/30 border-slate-700/40'}`}>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={onToggleAuto}
            disabled={autoBusy}
            className={`px-3 py-1.5 rounded-lg text-[10px] font-black tracking-wide border transition-colors disabled:opacity-50 ${
              autoOn
                ? 'bg-amber-500/25 text-amber-200 border-amber-400/60'
                : 'bg-black/40 text-slate-400 border-slate-700/50 hover:text-slate-200'
            }`}
            title="75+ super-score ARMED fresh signals automatically paper trades me open hote hain — SL/T1(50%+BE)/T2/EOD watcher-managed + hold-window TIME-EXIT"
          >
            {autoBusy ? '…' : autoOn ? '⚡ AUTO-LINK ON' : '⚡ AUTO-LINK OFF'}
          </button>
          <span className="text-[10px] text-slate-400">
            {autoOn
              ? <>75+ ARMED signals → <b className="text-amber-200">paper auto-trade</b> (30s loop) · hold-window time-exit live</>
              : <>OFF — toggle ON karo to 75+ strong signals paper trades me auto-link honge</>}
          </span>
          <span className="ml-auto flex items-center gap-1.5 text-[9px] font-mono text-slate-500 flex-wrap">
            {autoSt && <>
              <span className="px-1.5 py-0.5 rounded bg-black/40 border border-slate-700/40">entries {autoSt.entriesToday}/{autoSt.cfg.quotaPerDay}</span>
              <span className="px-1.5 py-0.5 rounded bg-black/40 border border-slate-700/40">bar {autoSt.cfg.minScore}+</span>
              {autoSt.cooldownRemainingMin > 0 && <span className="px-1.5 py-0.5 rounded bg-black/40 border border-slate-700/40">cooldown {autoSt.cooldownRemainingMin}m</span>}
              {autoSt.timeExits > 0 && <span className="px-1.5 py-0.5 rounded bg-violet-500/10 text-violet-300 border border-violet-500/25">time-exits {autoSt.timeExits}</span>}
            </>}
          </span>
        </div>
        {lastEntry && (
          <div className="mt-1.5 text-[9px] font-mono text-slate-500 flex items-center gap-2 flex-wrap" title={`paper #${lastEntry.paperId ?? '—'} · mode ${lastEntry.mode} · qty ${lastEntry.qty}`}>
            <span className="text-slate-600">last auto-entry:</span>
            <span className="text-slate-300 font-bold">{lastEntry.symbol} {lastEntry.side}</span>
            <span className="text-slate-500">SUPER {lastEntry.aiScore}</span>
            <span className="text-slate-500">@ {lastEntry.entry}</span>
            {lastEntryAgeMin != null && <span className="text-slate-600">{lastEntryAgeMin}m ago</span>}
            {lastEntry.holdWindowMin && <span className="text-slate-600">window {lastEntry.holdWindowMin[0]}–{lastEntry.holdWindowMin[1]}m</span>}
          </div>
        )}
        {counts?.autoReady != null && (
          <div className="mt-1 text-[9px] font-mono text-slate-600">
            abhi {counts.autoReady} signal(s) {board?.autoBar ?? 75}+ bar par {autoOn ? 'auto-link queue me' : 'eligible (OFF)'}{board?.autoReadySymbols?.length ? ` · ${board.autoReadySymbols.slice(0, 4).join(' · ')}` : ''}
          </div>
        )}
      </div>

      {/* mode tabs */}
      <div className="flex items-center gap-2 flex-wrap mb-2">
        {MODES.map(m => (
          <button
            key={m.key}
            onClick={() => setMode(m.key)}
            className={`px-3 py-1.5 rounded-lg text-[10px] font-black tracking-wide border transition-colors ${
              mode === m.key
                ? 'bg-cyan-500/20 text-cyan-200 border-cyan-500/50'
                : 'bg-black/30 text-slate-500 border-slate-700/40 hover:text-slate-300'
            }`}
            title={m.hint}
          >
            {m.label}
          </button>
        ))}
        <span className="text-[9px] font-mono text-slate-600 ml-1">{modeMeta.hint}</span>
        {ageS != null && <span className="text-[9px] font-mono text-slate-600 ml-auto">{ageS}s ago · {board?.scanned ?? 0} scanned</span>}
      </div>

      {/* counts strip */}
      {counts && (
        <div className="flex items-center gap-1.5 flex-wrap text-[10px] font-mono mb-2.5">
          <span className="px-2 py-1 rounded-lg bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">🎯 armed {counts.armed}</span>
          {counts.autoReady != null && counts.autoReady > 0 && (
            <span className={`px-2 py-1 rounded-lg border ${autoOn ? 'bg-amber-400/15 text-amber-200 border-amber-400/40' : 'bg-black/30 text-amber-300/70 border-amber-500/20'}`} title="75+ ARMED fresh signals — auto-link eligible">
              ⚡ auto-ready {counts.autoReady}
            </span>
          )}
          <span className="px-2 py-1 rounded-lg bg-amber-500/10 text-amber-300 border border-amber-500/25">⏳ wait {counts.wait}</span>
          <span className="px-2 py-1 rounded-lg bg-red-500/10 text-red-300 border border-red-500/25">⚔ conflict {counts.conflict}</span>
          <span className="px-2 py-1 rounded-lg bg-black/30 text-slate-500 border border-slate-700/40">flat {counts.noBias}</span>
          {board?.conflictSymbols?.length > 0 && (
            <span className="text-[9px] text-slate-600" title={`LTF in against of HTF bias — no-trade zone: ${board.conflictSymbols.join(', ')}`}>
              ({board.conflictSymbols.slice(0, 5).join(', ')}{board.conflictSymbols.length > 5 ? '…' : ''})
            </span>
          )}
        </div>
      )}

      {/* signals grid */}
      {!board?.ok && (
        <div className="py-5 text-center text-[11px] text-slate-500">
          {loading ? `${cfg?.analysisTf ?? ''} + ${cfg?.actionTf ?? ''} candles padhe ja rahe hain…` : 'Board unavailable — candle sources down ya bahut thin. Thodi der me retry hoga.'}
        </div>
      )}
      {board?.ok && board.signals.length === 0 && (
        <div className="py-5 text-center text-[11px] text-slate-500">
          {loading ? 'Scanning…' : 'Koi confluence setup nahi — analysis TF flat ya sab LTF conflict me hai. Yahi honest no-trade zone hai (signals manufacture nahi hote).'}
        </div>
      )}
      {board?.ok && board.signals.length > 0 && (
        <div className="grid gap-2 xl:grid-cols-2">
          {board.signals.map(s => (
            <MtfSignalCard key={`${s.mode}-${s.symbol}`} sig={s} market={market} modeLabel={board.modeCfg?.label ?? ''} />
          ))}
        </div>
      )}

      {/* methodology / accuracy explainer */}
      <div className="mt-2.5">
        <button onClick={() => setShowHow(v => !v)} className="text-[10px] font-bold text-cyan-400/80 hover:text-cyan-300 underline underline-offset-2">
          {showHow ? '▾' : '▸'} Kya multi-timeframe se accuracy milti hai? (methodology)
        </button>
        {showHow && (
          <div className="mt-1.5 rounded-lg bg-black/30 border border-slate-700/40 p-2.5 space-y-1.5">
            <p className="text-[10px] text-slate-400 leading-relaxed">
              <b className="text-slate-300">Haan — lekin sirf ALIGNMENT se, TF count se nahi.</b> Ek TF par noise bahut hota hai (5m par random wicks); bina HTF ke har LTF signal equal nahi hota.
              {cfg?.analysisTf ?? '15m'} par trend + structure + momentum ka <b>bias</b> banta hai, aur {cfg?.actionTf ?? '5m'} sirf <b>timing</b> deta hai — entry ka exact moment, SL ka exact swing, TP ka R-based level.
            </p>
            <p className="text-[10px] text-slate-500 leading-relaxed">
              Is board ka <b>confluence score</b> tabhi badhta hai jab (a) analysis-TF strength + ADX trending ho, (b) action-TF trigger usi direction me ho, (c) entry-timing RSI zone sahi ho.
              Conflict (LTF against HTF) = <b>zero score + no-trade</b> — yahi discipline accuracy ka asli source hai. 3 aligned TFs &gt; 6 conflicted TFs.
            </p>
            <p className="text-[10px] text-slate-500 leading-relaxed">
              <b className="text-fuchsia-300">v21.16 SUPERINTELLIGENCE:</b> SUPER score = confluence conviction + <b>7-factor expert</b> (trend structure / momentum zone / volume flow / SMC supply-demand zones / volatility fit / bias regime / R:R geometry) ka weighted blend.
              Tier ladder: <b>ELITE 85+</b> · STRONG 80+ · ACTION 65+ · WATCH 50+. Honest caps: WAIT 70 par capped, CONFLICT 0 — isliye <b className="text-amber-200">75+ AUTO-LINK sirf ARMED fresh signals</b> ko hi mil sakta hai (by construction, weighted-luck nahi).
              Auto-link ON → 75+ signals paper tickets auto-open (SL / T1 50%+breakeven / T2 / EOD watcher-managed + hold-window TIME-EXIT).
            </p>
            {board?.methodology && <p className="text-[9px] text-slate-600 italic">{board.methodology}</p>}
          </div>
        )}
      </div>
      {board?.disclaimer && <p className="text-[9px] text-slate-600 mt-2 italic">⚠️ {board.disclaimer}</p>}
    </div>
  );
});
