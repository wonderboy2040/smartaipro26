// ============================================================
// server/ai/ollamaLifecycle.js — Ollama model RAM manager
// ------------------------------------------------------------
// AI-ENGINE MODE (local/cloud/both) ke saath local Ollama ki
// model loading ko manage karta hai — process nahi, sirf RAM:
//
//   • cloud mode   → unloadAllOllamaModels(): har loaded model ko
//                    `keep_alive: 0` se unload karo, OLLAMA_BASE
//                    service khud chalta rehta hai (no re-download,
//                    no restart, no process kill).
//   • local/both   → warmOllamaModels(): OLLAMA_MODEL (fast seat)
//                    ko `OLLAMA_KEEP_ALIVE` ke saath preload karo
//                    taaki first board-scan cold-load nahi ho.
//
// PURITY: sirf Ollama REST (/api/ps, /api/generate) — koi Ollama
// CLI / process management nahi. Har call bounded timeout,
// fire-and-forget style, NEVER throws (mode switch kabhi fail nahi
// hota Ollama ki wajah se — at worst model waise hi RAM me rehta hai,
// jaise aaj tak tha).
//
// WHY (user spec v21.36.0): "cloud mode par local Ollama service band
// hona chahiye" — 16GB machine par loaded qwen3:8b + qwen2.5vl:7b
// ≈ 6-9GB RAM zinda rakhte the; cloud OpenCode scoring ke waqt wo
// RAM node server + browser ko milti hai.
// ============================================================
const OLLAMA_BASE = (process.env.OLLAMA_BASE || 'http://127.0.0.1:11434').replace(/\/+$/, '');

const UNLOAD_TIMEOUT_MS = 5_000;
const WARM_TIMEOUT_MS = 15_000;

const _state = {
  lastAction: 'none',       // 'unloaded' | 'warmed' | 'skipped'
  lastActionAt: 0,
  lastModels: [],           // jo models unloads / warmed hue
  lastError: null,
};

/**
 * GET /api/ps — abhi RAM me loaded hain kaunse models.
 * Returns array of model names; Ollama down/absent par [].
 */
async function loadedModels() {
  try {
    const r = await fetch(`${OLLAMA_BASE}/api/ps`, { signal: AbortSignal.timeout(3_000) });
    if (!r.ok) return [];
    const j = await r.json().catch(() => ({}));
    return (Array.isArray(j?.models) ? j.models : []).map(m => String(m?.name || '')).filter(Boolean);
  } catch {
    return [];
  }
}

/** Ek model ko RAM se unload karo (keep_alive 0 = instant eviction). */
async function unloadOne(name, keepAlive = '0') {
  try {
    const r = await fetch(`${OLLAMA_BASE}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: name, prompt: '', keep_alive: keepAlive, stream: false }),
      signal: AbortSignal.timeout(UNLOAD_TIMEOUT_MS),
    });
    // Ollama 200 return karta hai; model ab RAM me resident nahi hota.
    if (!r.ok) return false;
    await r.body?.cancel?.().catch(() => {});
    return true;
  } catch {
    return false;
  }
}

/**
 * SAARE abhi-loaded Ollama models ko unload karo (RAM free).
 * Ollama service khud chalti rehti hai; models agle use par
 * dobara load hote hain (disk se, ~5-20s). Never throws.
 */
export async function unloadAllOllamaModels() {
  _state.lastAction = 'unloaded';
  _state.lastActionAt = Date.now();
  _state.lastError = null;
  try {
    const names = await loadedModels();
    _state.lastModels = names;
    for (const n of names) await unloadOne(n, '0');
    return { ok: true, unloaded: names, base: OLLAMA_BASE };
  } catch (e) {
    _state.lastError = String(e?.message || e);
    return { ok: false, unloaded: [], error: _state.lastError };
  }
}

/**
 * Local/both mode par fast-seat model ko preload (warm) karo.
 * `keepAlive` default OLLAMA_KEEP_ALIVE env (5m/30m) — model RAM me
 * utna der rahega, phir Ollama apne aap evict kar dega.
 * Never throws; Ollama down par skip.
 */
export async function warmOllamaModels(models = [], keepAlive = null) {
  _state.lastAction = 'warmed';
  _state.lastActionAt = Date.now();
  _state.lastError = null;
  try {
    const keep = keepAlive || process.env.OLLAMA_KEEP_ALIVE || '5m';
    const warm = (Array.isArray(models) ? models : []).filter(Boolean).slice(0, 3);
    let okCount = 0;
    for (const m of warm) {
      const ok = await (async () => {
        try {
          const r = await fetch(`${OLLAMA_BASE}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: m, prompt: '', keep_alive: keep, stream: false }),
            signal: AbortSignal.timeout(WARM_TIMEOUT_MS),
          });
          if (!r.ok) return false;
          await r.body?.cancel?.().catch(() => {});
          return true;
        } catch { return false; }
      })();
      if (ok) okCount++;
    }
    _state.lastModels = warm;
    return { ok: true, warmed: warm, loaded: okCount, keepAlive: keep };
  } catch (e) {
    _state.lastError = String(e?.message || e);
    return { ok: false, warmed: [], error: _state.lastError };
  }
}

/** Status view for /api/ai/mode + UI (honest, secret-free). */
export function ollamaLifecycleStatus(now = Date.now()) {
  return {
    managed: true,
    lastAction: _state.lastAction,
    lastActionAgeSec: _state.lastActionAt ? Math.max(0, Math.round((now - _state.lastActionAt) / 1000)) : null,
    lastModels: [..._state.lastModels],
    lastError: _state.lastError,
    base: OLLAMA_BASE,
  };
}

/** Test hook. */
export function __resetOllamaLifecycleForTests() {
  _state.lastAction = 'none';
  _state.lastActionAt = 0;
  _state.lastModels = [];
  _state.lastError = null;
}
