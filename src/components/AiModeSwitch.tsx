// ============================================================
// src/components/AiModeSwitch.tsx — FreeLLMAPI intelligence profile
// ------------------------------------------------------------
// One site-wide routing profile, controlled from the header.
// v21.36.5 ROUTE STRATEGY (server/ai/routeStrategy.js) decides the
// CONCRETE route per use-case on top of this profile:
//   SITE LOAD          → auto:balanced (fastest router proof)
//   MTF warm guard     → auto:balanced (fastest strict-JSON route;
//                        auto:fast is prose-prone — the v21.36.2 miss)
//   signal verify      → profile baseline (smart/balanced/fast),
//                        escalated to auto:smart for deep / multi-symbol
//   FINAL SNIPER ENTRY → auto:smart (the money moment)
//   DEEP ENSEMBLE      → auto:smart (depth beats latency)
// Every lane rides the local FreeLLMAPI router, which owns the
// upstream provider keys and free-tier quotas. The server persists
// the choice (server/data/ai-mode.json) and re-reads it on every AI
// call, so switching needs NO restart and survives one.
// ============================================================
import { memo, useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../utils/api';

type AiMode = 'smart' | 'balanced' | 'fast';
const MODES: readonly AiMode[] = ['smart', 'balanced', 'fast'];

interface AiModeStatus {
  mode: AiMode;
  source: string;
  persisted: boolean;
  updatedAt: number | null;
}

const SOURCE_LABEL: Record<string, string> = {
  runtime: 'runtime switch (applied now)',
  file: 'saved server/data/ai-mode.json',
  env: 'AI_MODE env seed',
  'env-profile': 'FREELLMAPI_PROFILE env seed',
  default: 'safe default',
};

function modeTitle(mode: AiMode | null): string {
  if (mode === 'smart') {
    return 'SMART — FreeLLMAPI auto:smart. Highest-intelligence eligible model for the AI Council, deep analysis, global council, borderline validator and desk agents. Best accuracy, highest latency.';
  }
  if (mode === 'balanced') {
    return 'BALANCED — FreeLLMAPI auto:balanced. Quality/latency blend for desk agents and board scans; deep analysis still uses auto:smart.';
  }
  if (mode === 'fast') {
    return 'FAST — FreeLLMAPI auto:fast scan profile. Fast scans use auto:fast; deep analysis, multi-symbol council reads and the sniper entry still use auto:smart (route strategy v21.36.5). The MTF warm guard rides auto:balanced (fastest strict-JSON route).';
  }
  return 'FreeLLMAPI intelligence profile — loading…';
}

function isMode(v: unknown): v is AiMode {
  return v === 'smart' || v === 'balanced' || v === 'fast';
}

export const AiModeSwitch = memo(function AiModeSwitch() {
  const [status, setStatus] = useState<AiModeStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [tick, setTick] = useState(0);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/ai/mode', { signal: AbortSignal.timeout(8000) });
      if (!res.ok) { setFailed(true); return; }
      const d = await res.json().catch(() => null);
      if (isMode(d?.mode)) {
        setStatus({
          mode: d.mode,
          source: String(d.source || ''),
          persisted: !!d.persisted,
          updatedAt: Number.isFinite(Number(d.updatedAt)) ? Number(d.updatedAt) : null,
        });
        setFailed(false);
      }
    } catch { setFailed(true); /* header control is auxiliary — never block the shell */ }
  }, []);

  useEffect(() => {
    load();
    // Slow poll keeps a second browser tab in sync; hidden tabs stay quiet.
    const t = setInterval(() => { if (!document.hidden) load(); }, 60_000);
    return () => clearInterval(t);
  }, [load, tick]);

  const setMode = useCallback(async (mode: AiMode) => {
    if (busy || status?.mode === mode) return;
    setBusy(true);
    try {
      const res = await apiFetch('/api/ai/mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
        signal: AbortSignal.timeout(8000),
      });
      const d = await res.json().catch(() => null);
      if (res.ok && d?.ok && isMode(d.mode)) {
        setStatus({
          mode: d.mode,
          source: String(d.source || 'runtime'),
          persisted: !!d.persisted,
          updatedAt: Number.isFinite(Number(d.updatedAt)) ? Number(d.updatedAt) : null,
        });
        setFailed(false);
        setTick(x => x + 1);
      } else {
        setFailed(true);
      }
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }, [busy, status?.mode]);

  const mode = status?.mode ?? null;
  const source = status ? (SOURCE_LABEL[status.source] || status.source || 'unknown') : 'loading…';
  const persisted = status ? (status.persisted ? 'restart-safe (saved)' : 'NOT saved — read-only filesystem, runtime only') : '';
  const title = `${modeTitle(mode)}${status ? `\nSource: ${source} · ${persisted}` : ''}${failed ? '\nStatus endpoint unreachable — last known profile shown.' : ''}`;

  const activeClass = (m: AiMode) => m === 'smart'
    ? 'bg-emerald-500/20 text-emerald-200 border border-emerald-400/40'
    : m === 'balanced'
      ? 'bg-cyan-500/20 text-cyan-200 border border-cyan-400/40'
      : 'bg-violet-500/20 text-violet-200 border border-violet-400/40';

  return (
    <div
      className="flex items-center gap-1 quantum-panel p-1 rounded-xl"
      role="group"
      aria-label="FreeLLMAPI intelligence profile"
      title={title}
    >
      <span className={`px-1 text-[9px] font-black font-mono ${failed ? 'text-red-400' : 'text-slate-500'}`}>AI</span>
      {MODES.map(m => {
        const active = mode === m;
        return (
          <button
            key={m}
            type="button"
            onClick={() => void setMode(m)}
            disabled={busy || !status}
            aria-pressed={active}
            title={modeTitle(m)}
            className={`px-2 py-1 rounded-lg text-[9px] font-black font-mono tracking-wider transition-all disabled:opacity-40 ${
              active
                ? activeClass(m)
                : 'text-slate-500 hover:text-slate-300 hover:bg-white/[0.04] border border-transparent'
            }`}
          >
            {m.toUpperCase()}
          </button>
        );
      })}
      {busy && <span className="px-1 text-[9px] font-mono text-cyan-300 animate-pulse">…</span>}
    </div>
  );
});
