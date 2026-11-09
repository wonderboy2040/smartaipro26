// ============================================================
// aitrading/EngineHealthStrip — AI ENGINE SENTINEL (UI)
// ------------------------------------------------------------
// Live health chips for the FreeLLMAPI router + any direct-key
// fallback engines, plus a RECHECK button.
//   • READY (green)    — engine answered recently
//   • COOLDOWN (amber) — engine down, AUTO-RETRY in Ns (sentinel
//                        half-open; no restart needed)
//   • ERROR (red)      — last error shown on hover (e.g. 429)
//   • NO KEY (slate)   — fallback engine not configured
//   • FREELMAPI (cyan) — local router status + smart/balanced/fast
//                        virtual models and pinned vision ladder
// Data: GET /api/ai/engines (30s auto-refresh + refreshKey bump on
// every agent answer), POST /api/ai/engines/recheck (clears cooldowns
// NOW + re-probes the router). Key values never reach the browser.
// ============================================================
import { memo, useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../../utils/api';
import { RefreshCw, Zap } from 'lucide-react';

type EngineState = 'no-key' | 'idle' | 'cooldown' | 'ready' | 'tried';
type AiMode = 'smart' | 'balanced' | 'fast';

interface EngineRow {
  provider: string;
  configured: boolean;
  state: EngineState;
  lastError?: string | null;
  cooldownRemainSec?: number;
  lastOkAgeSec?: number | null;
}

interface FreeLlmInfo {
  available?: boolean;
  reachable?: boolean;
  baseUrl?: string | null;
  apiBase?: string | null;
  keyPresent?: boolean;
  keySource?: string;
  modelsCount?: number;
  models?: Record<string, string>;
  visionModels?: string[];
  lastRoutedVia?: string | null;
  checkedAgeSec?: number | null;
  probeLatencyMs?: number | null;
  lastError?: string | null;
}

interface AiGuardInfo {
  engine?: string;
  reachable?: boolean;
  profile?: AiMode;
  fastModel?: string;
  deepModel?: string;
  sentinelModel?: string;
  models?: string[];
}

interface AiModeInfo {
  mode: AiMode;
  source?: string;
  persisted?: boolean;
}

const LABEL: Record<string, string> = {
  freellmapi: 'FREELMAPI',
  gemini: 'GEMINI', groq: 'GROQ', cerebras: 'CEREBRAS',
  openrouter: 'OPENROUTER', huggingface: 'HUGGINGFACE', nvidia: 'NVIDIA',
};

const MODE_SOURCE_LABEL: Record<string, string> = {
  runtime: 'runtime switch',
  file: 'saved server/data/ai-mode.json',
  env: 'AI_MODE env seed',
  'env-profile': 'FREELLMAPI_PROFILE env seed',
  default: 'safe default',
};

const MODE_CLASS: Record<AiMode, string> = {
  smart: 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300',
  balanced: 'bg-cyan-500/15 border-cyan-500/30 text-cyan-300',
  fast: 'bg-violet-500/15 border-violet-500/30 text-violet-300',
};

function modeTip(m: AiModeInfo | null): string {
  if (!m) return 'Intelligence profile unknown — /api/ai/engines se mode nahi aaya';
  const src = MODE_SOURCE_LABEL[m.source || ''] || m.source || 'unknown';
  const saved = m.persisted ? 'restart-safe (saved)' : 'runtime only (filesystem read-only)';
  const model = m.mode === 'smart' ? 'auto:smart' : m.mode === 'balanced' ? 'auto:balanced' : 'auto:fast';
  const note = m.mode === 'smart'
    ? 'Deepest council / validator / desk-agent answers.'
    : m.mode === 'balanced'
      ? 'Quality/latency blend for desk agents and board scans; deep analysis still uses auto:smart.'
      : 'Quickest eligible model for scans and the MTF guard; deep analysis still uses auto:smart.';
  return `${m.mode.toUpperCase()} → ${model}. ${note} Source: ${src} · ${saved}.`;
}

function freeLlmTip(st: FreeLlmInfo | null, guard: AiGuardInfo | null, mode: AiModeInfo | null): string {
  if (!st) return 'FreeLLMAPI status unavailable — desktop app start karo (default 127.0.0.1:31415)';
  const active = mode ? `active profile ${mode.mode.toUpperCase()}` : undefined;
  const parts = [
    st.available ? 'router ONLINE' : st.reachable ? 'router reachable but NO unified key' : 'router OFFLINE',
    active,
    st.baseUrl ? st.baseUrl : undefined,
    st.keyPresent ? `key from ${st.keySource || 'unknown'}` : 'unified key missing',
    st.modelsCount != null ? `${st.modelsCount} models available` : undefined,
    st.models ? `smart=${st.models.smart} · balanced=${st.models.balanced} · fast=${st.models.fast}` : undefined,
    st.visionModels?.length ? `vision: ${st.visionModels.join(', ')}` : undefined,
    guard?.models?.length ? `AI guard seats: ${guard.models.join(' + ')}` : undefined,
    st.lastRoutedVia ? `last routed via ${st.lastRoutedVia}` : undefined,
    st.checkedAgeSec != null ? `probed ${st.checkedAgeSec}s pehle` : undefined,
    st.lastError ? `last error: ${st.lastError}` : undefined,
  ].filter(Boolean) as string[];
  return parts.join(' · ');
}

function chipClass(e: EngineRow): string {
  if (e.provider === 'freellmapi') {
    return e.configured
      ? 'bg-cyan-500/15 border-cyan-500/30 text-cyan-300'
      : 'bg-white/[0.02] border-white/10 text-slate-600';
  }
  if (!e.configured) return 'bg-white/[0.02] border-white/10 text-slate-600';
  switch (e.state) {
    case 'ready': return 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300';
    case 'cooldown': return 'bg-amber-500/15 border-amber-500/30 text-amber-300';
    case 'tried': return 'bg-red-500/10 border-red-500/25 text-red-300';
    default: return 'bg-white/[0.03] border-white/10 text-slate-400';
  }
}

/** Compact virtual-model label: 'auto:smart' → 'SMART'. */
function modelShort(m?: string | null): string {
  if (!m) return '';
  const raw = String(m);
  if (raw.startsWith('auto:')) return raw.slice(5).toUpperCase();
  if (raw === 'fusion') return 'FUSION';
  return raw.slice(0, 14).toUpperCase();
}

function chipText(e: EngineRow, st: FreeLlmInfo | null, mode: AiModeInfo | null): string {
  if (e.provider === 'freellmapi') {
    if (!e.configured) return 'FREELMAPI —';
    const active = modelShort(st?.models?.[mode?.mode || 'smart'] || (mode?.mode ? `auto:${mode.mode}` : 'auto:smart'));
    const routed = st?.lastRoutedVia ? ` · ${st.lastRoutedVia.split('/').pop()}` : '';
    switch (e.state) {
      case 'cooldown': return `FREELMAPI ↻${e.cooldownRemainSec ?? 0}s`;
      case 'tried': return 'FREELMAPI ✗';
      case 'ready': return `FREELMAPI ✓ ${active}${routed}`;
      default: return `FREELMAPI ${active}`;
    }
  }
  if (!e.configured) return `${LABEL[e.provider] || e.provider} NO-KEY`;
  switch (e.state) {
    case 'ready': return `${LABEL[e.provider] || e.provider} ✓`;
    case 'cooldown': return `${LABEL[e.provider] || e.provider} ↻${e.cooldownRemainSec ?? 0}s`;
    case 'tried': return `${LABEL[e.provider] || e.provider} ✗`;
    default: return `${LABEL[e.provider] || e.provider} ·`;
  }
}

function chipTitle(e: EngineRow, st: FreeLlmInfo | null, guard: AiGuardInfo | null, mode: AiModeInfo | null): string {
  if (e.provider === 'freellmapi') return freeLlmTip(st, guard, mode);
  if (!e.configured) return 'Direct provider key configured nahi hai — fallback engine sirf tab chalta hai jab key ho. FreeLLMAPI primary hai.';
  switch (e.state) {
    case 'ready': return `engine ONLINE (last ok ${e.lastOkAgeSec ?? '?'}s pehle) · direct-key fallback`;
    case 'cooldown': return `down — AUTO-RETRY ${e.cooldownRemainSec ?? 0}s me (sentinel half-open) · last: ${e.lastError || '?'}`;
    case 'tried': return `last error: ${e.lastError || 'no response'} · direct-key fallback`;
    default: return 'armed — abhi koi attempt nahi hua · direct-key fallback';
  }
}

export const EngineHealthStrip = memo(function EngineHealthStrip({ refreshKey = 0 }: { refreshKey?: number }) {
  const [rows, setRows] = useState<EngineRow[]>([]);
  const [freeLlm, setFreeLlm] = useState<FreeLlmInfo | null>(null);
  const [aiGuard, setAiGuard] = useState<AiGuardInfo | null>(null);
  const [mode, setMode] = useState<AiModeInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const apply = useCallback((d: any) => {
    if (Array.isArray(d?.engines)) { setRows(d.engines); setFailed(false); }
    setFreeLlm(d?.freellmapi && typeof d.freellmapi === 'object' ? d.freellmapi : null);
    setAiGuard(d?.aiGuard && typeof d.aiGuard === 'object' ? d.aiGuard : null);
    const m = d?.mode;
    setMode(m && (m.mode === 'smart' || m.mode === 'balanced' || m.mode === 'fast') ? m : null);
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/ai/engines', { signal: AbortSignal.timeout(8000) });
      if (!res.ok) { setFailed(true); return; }
      apply(await res.json().catch(() => ({})));
    } catch { setFailed(true); /* silent — strip is auxiliary */ }
  }, [apply]);

  const recheck = useCallback(async () => {
    setBusy(true);
    try {
      const res = await apiFetch('/api/ai/engines/recheck', { method: 'POST', signal: AbortSignal.timeout(20000) });
      if (res.ok) apply(await res.json().catch(() => ({})));
    } catch { /* silent */ } finally { setBusy(false); }
  }, [apply]);

  useEffect(() => {
    load();
    // Visibility-gated — hidden tab pe network poll band.
    const t = setInterval(() => { if (!document.hidden) load(); }, 30_000);
    return () => clearInterval(t);
  }, [load, refreshKey]);

  if (!rows.length && !mode && !freeLlm) return null;

  const fl = rows.find(e => e.provider === 'freellmapi');
  const fallbackRows = rows.filter(e => e.provider !== 'freellmapi');
  const routerReady = !!freeLlm?.available;

  return (
    <div className="flex items-center gap-1.5 px-3 pb-2 flex-wrap">
      <span className="flex items-center gap-1 text-[9px] font-black font-mono text-slate-500" title="AI engine health — FreeLLMAPI owns the provider keys. Offline router auto-retry karta hai; RECHECK abhi try karta hai.">
        <Zap size={10} /> AI ENGINES
      </span>
      {mode && (
        <span
          className={`px-1.5 py-0.5 rounded-md text-[9px] font-mono font-bold border ${MODE_CLASS[mode.mode]}`}
          title={modeTip(mode)}
        >
          {mode.mode.toUpperCase()} PROFILE
        </span>
      )}
      {fl && (
        <span
          className={`px-1.5 py-0.5 rounded-md text-[9px] font-mono font-bold border ${chipClass(fl)}`}
          title={chipTitle(fl, freeLlm, aiGuard, mode)}
        >
          {chipText(fl, freeLlm, mode)}
        </span>
      )}
      {fallbackRows.map(e => (
        <span
          key={e.provider}
          className={`px-1.5 py-0.5 rounded-md text-[9px] font-mono font-bold border ${chipClass(e)}`}
          title={chipTitle(e, freeLlm, aiGuard, mode)}
        >
          {chipText(e, freeLlm, mode)}
        </span>
      ))}
      <button
        onClick={recheck}
        disabled={busy}
        className="ml-auto flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[9px] font-black font-mono border border-cyan-500/30 bg-cyan-500/10 text-cyan-300 hover:border-cyan-400/60 hover:text-cyan-200 transition-all disabled:opacity-40"
        title="cooldowns clear karo + FreeLLMAPI router ko abhi dobara probe karo (half-open)"
      >
        <RefreshCw size={9} className={busy ? 'animate-spin' : ''} /> {busy ? 'CHECKING…' : 'RECHECK'}
      </button>
      {!routerReady && !failed && (
        <span className="w-full text-[9px] text-amber-400/80 font-mono leading-relaxed pt-0.5">
          FreeLLMAPI router reachable nahi ({freeLlm?.lastError || 'desktop app band hai'}) — AI lanes deterministic rahenge jab tak router online nahi hota. Start karo: FreeLLMAPI desktop app (default <b>127.0.0.1:31415</b>) aur RECHECK dabao. Direct provider keys (agar set hain) fallback hain.
        </span>
      )}
    </div>
  );
});
