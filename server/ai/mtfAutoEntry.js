// ============================================================
// server/ai/mtfAutoEntry.js — v21.16.0 MTF AUTO-LINK ENGINE
// ------------------------------------------------------------
// USER SPEC: "MTF board ke trade signals jo 75+ score ke hain —
// action me strong signals ko paper trade AUTO TRADE se link karo"
//
// FLOW (har 30s tick, optionsAutoEntry pattern):
//   getMtfBoard(market, mode)          [cached 90s — cheap]
//     → signals jahan state=ARMED
//         && super.aiScore >= 75 (MTF_AUTO_BAR — config se tunable)
//         && autoTrade.eligible (fresh data + complete blueprint)
//     → [gates] enabled · NSE fresh-entry window (INDIA only;
//             crypto 24/7) · kill-switch · quota/day · per-symbol
//             per-day cap · cooldown · one-per-symbol+mode+side
//             (openPaperTrade ka apna guard bhi hai)
//     → openPaperTrade({ entry, SL, TP1, TP2, market }) — PAPER
//       ticket, risk-1R sizing, label `MTF · AUTO`
//
// TIME-STOP (user ka asli spec — "15-20 min / 60-90 min me exit"):
//   watcher (stream.js) SL/T1(50%+BE)/T2/EOD auto-manage karta hai;
//   YE tick MTF-auto trades ka hold-window bhi honor karta hai —
//   window expire + TP/SL miss → closePaperTrade @ live price
//   (reason 'MTF-TIME-EXIT'). Paper engine me pehle sirf 15:10
//   EOD tha; ab mode ka time-box bhi live hai.
//
// STATE: server/data/mtf-auto-config.json (user toggle + caps)
//        server/data/mtf-auto-state.json  (quota/cooldown counters)
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isNseMarketOpen, freshEntriesAllowedFor } from '../intraday/time.js';
import { getMtfBoard, MTF_AUTO_BAR, MTF_MODES } from './mtfBoard.js';

// v21.16.0 [LIVE-FIX] QUOTE-SCALE PARITY: MTF crypto board ke levels
// USDT-scale (Binance/Bybit candle chain) hote hain, jabki paper watcher
// crypto quotes CoinDCX **INR** (POLINR/BTCINR…) se laata hai. Auto-entry
// bina conversion ke khulti to pehle hi watcher tick par phantom SL_HIT
// hota (live-verify me pakda gaya: BTC entry 81738 USDT vs watcher 81.5
// lakh INR). Ab: CoinDCX INR ticker hi entry scale banta hai — saare levels
// (entry/SL/T1/T2) usi ratio se convert hote hain (R:R geometry EXACT
// preserve), qty INR-notional se. Ticker missing (jaise POL jo CoinDCX par
// nahi hai) → honest skip — watcher us trade ko price hi nahi kar sakta.
const INR_USDT_PARITY_TOL = 0.10; // ±10% (CoinDCX premium vs Binance×USDINR)

async function _cryptoInrMap() {
  try {
    const { fetchCoinDcxTickers } = await import('../cryptoStream.js');
    const tickers = await fetchCoinDcxTickers();
    const m = new Map();
    for (const t of (tickers || [])) {
      const p = parseFloat(t?.last_price);
      if (p > 0) m.set(String(t?.market || '').toUpperCase(), p);
    }
    return m;
  } catch { return new Map(); }
}

async function _usdInr() {
  try {
    const { usdInrFallback } = await import('./lib/usdinr.js');
    return usdInrFallback();
  } catch { return 84; }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'data');
// v21.35.3 [PRO-LEVEL RECHECK — TEST-ISOALATION CONTRACT]: same env
// resolution as mtfAutoLink.js / mtfRowLedgerStore.js — Pehle yeh module
// production server/data ko HARD-CODE karke read/write karta tha, isliye
// har full-suite run me uska __resetMtfAutoForTests() LIVE mtf-auto config
// + state files ko delete kar deta tha (risk caps + auto-trade book wipe).
// Ab hermetic test dirs (MTF_AUTO_DATA_DIR / SMARTAI_DATA_DIR) honor hote
// hain; production pe destructive test hooks guard se protected.
const _dataDir = () =>
  process.env.MTF_AUTO_DATA_DIR ||
  (process.env.SMARTAI_DATA_DIR ? path.resolve(process.env.SMARTAI_DATA_DIR) : DATA_DIR);
const _dataDirIsProduction = () => _dataDir() === DATA_DIR;
const CFG_FILE = () => path.join(_dataDir(), 'mtf-auto-config.json');
const STATE_FILE = () => path.join(_dataDir(), 'mtf-auto-state.json');

const DEFAULT_CFG = {
  enabled: false,          // opt-in — UI toggle se ON hota hai
  minScore: MTF_AUTO_BAR,  // 75 — user ki "75+ score" bar
  quotaPerDay: 6,          // dono modes + dono markets ka combined/day
  cooldownMin: 15,         // same symbol pe agli auto-entry itne min baad
  perSymbolPerDay: 2,      // ek symbol din me max itni auto entries
  notionalINR: 20000,      // INDIA sizing (approx capital per ticket)
  notionalUSDT: 100,       // CRYPTO sizing
};

const DEFAULT_STATE = { day: null, count: 0, perSymbol: {}, lastEntryAt: {}, lastEntry: null, timeExits: 0 };

function _nowIST() {
  return new Date(Date.now() + (5.5 * 3600_000)).toISOString().slice(0, 10);
}

function _readJson(file, fallback) {
  try { return { ...fallback, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; }
  catch { return { ...fallback }; }
}
function _writeJson(file, obj) {
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(obj, null, 2)); }
  catch { /* best-effort — runtime state hai, restart pe fresh */ }
}

export function loadMtfAutoCfg() { return _readJson(CFG_FILE(), DEFAULT_CFG); }
export function saveMtfAutoCfg(cfg) { _writeJson(CFG_FILE(), cfg); }
function _loadState() {
  const s = _readJson(STATE_FILE(), DEFAULT_STATE);
  const today = _nowIST();
  if (s.day !== today) {
    return { ...DEFAULT_STATE, day: today, count: 0, perSymbol: {}, lastEntryAt: {}, lastEntry: s.lastEntry || null, timeExits: 0 };
  }
  return s;
}
function _saveState(s) { _writeJson(STATE_FILE(), s); }

// ---- status view (API + UI ke liye) ----
export function mtfAutoStatus() {
  const cfg = loadMtfAutoCfg();
  const s = _loadState();
  return {
    ok: true,
    enabled: !!cfg.enabled,
    cfg: {
      minScore: Number(cfg.minScore), quotaPerDay: Number(cfg.quotaPerDay),
      cooldownMin: Number(cfg.cooldownMin), perSymbolPerDay: Number(cfg.perSymbolPerDay),
      notionalINR: Number(cfg.notionalINR), notionalUSDT: Number(cfg.notionalUSDT),
    },
    autoBar: MTF_AUTO_BAR,
    day: s.day,
    entriesToday: s.count,
    quotaLeft: Math.max(0, Number(cfg.quotaPerDay) - Number(s.count || 0)),
    cooldownRemainingMin: (() => {
      const last = Math.max(0, ...Object.values(s.lastEntryAt || {}).map(Number));
      if (!last) return 0;
      const left = Number(cfg.cooldownMin) - Math.floor((Date.now() - last) / 60000);
      return Math.max(0, left);
    })(),
    lastEntry: s.lastEntry || null,
    timeExits: Number(s.timeExits || 0),
  };
}

export function setMtfAutoEnabled(enabled) {
  const cfg = loadMtfAutoCfg();
  cfg.enabled = !!enabled;
  saveMtfAutoCfg(cfg);
  return mtfAutoStatus();
}

// ---- sizing (notional-based, min-qty honest) ----
// CRYPTO entries INR-scale par khulti hain (CoinDCX watcher parity) —
// isliye crypto qty bhi notionalINR se. INDIA pehle jaisa ₹-scale.
function _qtyFor(entry, market, cfg) {
  if (!(entry > 0)) return null;
  if (market === 'CRYPTO') {
    const q = +(Number(cfg.notionalINR) / entry).toFixed(4);
    return q >= 0.0001 ? q : null;
  }
  const q = Math.floor(Number(cfg.notionalINR) / entry);
  return q >= 1 ? q : null;
}

// ---- the tick (30s loop se call hota hai) ----
let _tickBusy = false; // re-entrancy guard — overlapping ticks double-open se bachate hain
export async function mtfAutoTick(deps, sendTelegram) {
  if (_tickBusy) return { ok: true, idle: 'busy' };
  _tickBusy = true;
  try {
    return await _mtfAutoTickInner(deps, sendTelegram);
  } finally {
    _tickBusy = false;
  }
}

async function _mtfAutoTickInner(deps, sendTelegram) {
  const cfg = loadMtfAutoCfg();
  if (!cfg.enabled) return { ok: true, idle: 'disabled' };

  const { openPaperTrade, closePaperTrade, getPaperSummary } = await import('../intraday/paperTrading.js');

  // ---- PHASE 1: TIME-STOP — hold-window expire hone par MTF-auto
  // trades live price par band karo (user ka 15-20/60-90 min spec).
  // Paper watcher T1/T2/SL/EOD sambhalta hai; ye mode time-box hai.
  const timeExit = await _mtfTimeStopPass(closePaperTrade, sendTelegram);

  // ---- session gate: INDIA fresh-entry window (crypto 24/7) ----
  // board-level gate — per-signal INDIA entries ke liye
  const indiaEntriesOpen = (() => {
    try { return isNseMarketOpen() && freshEntriesAllowedFor('INDIA'); } catch { return false; }
  })();

  // kill switch (shared trading config — India agent jaisa)
  try {
    const { loadConfig } = await import('./coindcxOrders.js');
    const trading = loadConfig();
    if (trading?.killSwitch) return { ok: true, idle: 'kill-switch' };
  } catch { /* config unavailable — continue (paper-only engine) */ }

  // quota state
  const s = _loadState();
  if (Number(s.count || 0) >= Number(cfg.quotaPerDay)) return { ok: true, idle: 'quota-done' };
  const now = Date.now();

  // already-open (symbol+side) — pre-filter se openPaperTrade ka
  // error-loop avoid hota hai (engine ka one-per-symbol+dir guard hai)
  let openSet = new Set();
  try {
    const sum = getPaperSummary();
    openSet = new Set((sum?.open || []).map(t => `${String(t.symbol || '').toUpperCase()}|${String(t.direction || '').toUpperCase()}`));
  } catch { /* summary unavailable — openPaperTrade khud guard karega */ }

  const boards = [];
  for (const market of ['INDIA', 'CRYPTO']) {
    for (const mode of Object.keys(MTF_MODES)) {
      if (market === 'INDIA' && !indiaEntriesOpen) continue;
      try {
        const b = await getMtfBoard(market, mode);
        if (b?.ok) boards.push(b);
      } catch { /* board down — skip */ }
    }
  }
  if (boards.length === 0) return { ok: true, idle: 'no-boards' };

  // v21.16.0 [LIVE-FIX]: CoinDCX INR quote map (crypto candidates ke liye
  // watcher-parity scale) + USDINR reference
  const cryptoInr = await _cryptoInrMap();
  const usdInr = await _usdInr();

  const inCooldownFor = (sym) => {
    const at = Number((s.lastEntryAt || {})[String(sym || '').toUpperCase()] || 0);
    return at > 0 && (now - at) < Number(cfg.cooldownMin) * 60000;
  };

  // ---- candidates: ARMED + 75+ + eligible, super-score desc ----
  const minScore = Math.max(50, Number(cfg.minScore) || MTF_AUTO_BAR);
  const candidates = [];
  for (const b of boards) {
    for (const sig of (b.signals || [])) {
      if (sig?.state !== 'ARMED') continue;
      if (sig.stale) continue;
      const aiScore = Number(sig.super?.aiScore ?? 0);
      if (aiScore < minScore) continue;
      if (!sig.autoTrade?.eligible) continue;
      const act = sig.action || {};
      const entry = Number(act.entry), sl = Number(act.stopLoss);
      const t1 = Number(act.target1), t2 = act.target2 != null ? Number(act.target2) : null;
      const side = String(sig.side || '').toUpperCase();
      if (!(entry > 0) || !(sl > 0) || !(t1 > 0)) continue;
      // level sanity (paper engine ka contract)
      if (side === 'LONG' && (sl >= entry || t1 <= entry || (t2 != null && t2 <= entry))) continue;
      if (side === 'SHORT' && (sl <= entry || t1 >= entry || (t2 != null && t2 >= entry))) continue;

      // v21.16.0 [LIVE-FIX] CRYPTO: USDT levels → CoinDCX INR scale.
      // Ticker missing → skip (watcher price nahi kar sakta — POL case).
      // Ratio vs USDINR ±10% se zyada → parity anomaly → skip.
      let fxEntry = entry, fxSl = sl, fxT1 = t1, fxT2 = t2, fx = 1;
      if (sig.market === 'CRYPTO') {
        const inr = cryptoInr.get(`${sig.symbol}INR`);
        if (!(inr > 0)) continue; // honest skip — CoinDCX pair nahi hai
        fx = inr / entry;
        if (Math.abs(fx - usdInr) / usdInr > INR_USDT_PARITY_TOL) continue; // scale anomaly
        fxEntry = +(entry * fx).toFixed(2);
        fxSl = +(sl * fx).toFixed(2);
        fxT1 = +(t1 * fx).toFixed(2);
        fxT2 = t2 != null ? +(t2 * fx).toFixed(2) : null;
      }

      // gates: open-dedupe · per-symbol/day · cooldown
      if (openSet.has(`${sig.symbol}|${side}`)) continue;
      if (Number((s.perSymbol || {})[sig.symbol] || 0) >= Number(cfg.perSymbolPerDay)) continue;
      if (inCooldownFor(sig.symbol)) continue;
      candidates.push({ sig, board: b, aiScore, entry: fxEntry, sl: fxSl, t1: fxT1, t2: fxT2, side, market: sig.market, mode: sig.mode, converted: fx !== 1 });
    }
  }
  if (candidates.length === 0) {
    return { ok: true, idle: timeExit.exited > 0 ? 'time-exit-only' : 'no-qualifying-signal' };
  }

  // best candidate (highest super score) — ek tick me sirf EK entry
  // (chase-discipline: queue nahi, best hi lete hain)
  const pick = candidates.sort((a, b) => b.aiScore - a.aiScore)[0];

  // v21.16.0 INDIA parity: Groww quote vs board entry >5% → stale-board
  // skip (fresh card agle pass banegi). Quote unavailable → proceed
  // (₹ scale dono feeds me same hai, board 90s cache fresh hai).
  if (pick.market === 'INDIA') {
    try {
      const { fetchGrowwNseQuote } = await import('./growwQuote.js');
      const q = await fetchGrowwNseQuote(pick.sig.symbol);
      const live = Number(q?.price);
      if (live > 0 && pick.entry > 0 && Math.abs(live - pick.entry) / pick.entry > 0.05) {
        return { ok: true, idle: `stale-board-skip — ${pick.sig.symbol} board ${pick.entry} vs live ${Math.round(live * 100) / 100} (>5%); fresh card agle pass` };
      }
    } catch { /* quote down — board levels hi (paper engine) */ }
  }

  const qty = _qtyFor(pick.entry, pick.market, cfg);
  if (!qty) return { ok: true, idle: 'sizing-failed' };

  const label = `MTF ${pick.mode === 'swing' ? 'SWING' : 'INTRADAY'} · SUPER ${pick.aiScore} · AUTO${pick.converted ? ' · ₹' : ''}`;
  const res = openPaperTrade({
    symbol: pick.sig.symbol,
    direction: pick.side,
    entry: pick.entry,
    qty,
    stopLoss: pick.sl,
    target1: pick.t1,
    target2: pick.t2 != null ? pick.t2 : undefined,
    market: pick.market,
    label,
  });
  if (res?.error) return { ok: false, error: res.error };

  // state update (quota/cooldown)
  const sym = String(pick.sig.symbol || '').toUpperCase();
  s.count = Number(s.count || 0) + 1;
  s.perSymbol = { ...(s.perSymbol || {}), [sym]: Number((s.perSymbol || {})[sym] || 0) + 1 };
  s.lastEntryAt = { ...(s.lastEntryAt || {}), [sym]: now };
  s.lastEntry = {
    at: now, symbol: sym, market: pick.market, mode: pick.mode, side: pick.side,
    aiScore: pick.aiScore, entry: pick.entry, stopLoss: pick.sl, target1: pick.t1, target2: pick.t2, qty,
    holdWindowMin: pick.board.modeCfg?.holdWindowMin || null, paperId: res?.trade?.id ?? null,
    inrConverted: !!pick.converted,
  };
  _saveState(s);

  const cfgLabel = pick.board.modeCfg?.label || pick.mode;
  const line = `🧭 <b>MTF AUTO-LINK (paper)</b> — ${sym} ${pick.side} · ${cfgLabel}${pick.converted ? ' · levels ₹ (CoinDCX scale)' : ''}\n` +
    `Entry ${pick.entry} · SL ${pick.sl} · T1 ${pick.t1} (50% + BE) · T2 ${pick.t2 ?? '—'}\n` +
    `SUPER ${pick.aiScore}/100 · CS ${pick.sig.confluenceScore}/100 · qty ${qty} · quota ${s.count}/${cfg.quotaPerDay}`;
  try { if (sendTelegram) await sendTelegram(line); } catch { /* notify best-effort */ }
  return { ok: true, opened: s.lastEntry };
}

// ---- TIME-STOP pass: MTF-auto paper trades ka hold-window ----
async function _mtfTimeStopPass(closePaperTrade, sendTelegram) {
  let exited = 0;
  try {
    const { getPaperSummary } = await import('../intraday/paperTrading.js');
    const sum = getPaperSummary();
    const open = (sum?.open || []).filter(t => String(t?.label || '').includes('MTF') && String(t?.label || '').includes('AUTO'));
    for (const t of open) {
      const m = String(t?.label || '').match(/MTF\s+(INTRADAY|SWING)/);
      if (!m) continue;
      const modeCfg = MTF_MODES[m[1].toLowerCase() === 'swing' ? 'swing' : 'intraday'];
      const windowMaxMin = modeCfg.holdWindowMin[1];
      const ageMin = (Date.now() - Number(t.openedAt || 0)) / 60000;
      if (ageMin < windowMaxMin + 2) continue; // +2min grace (fill lag)
      // live price — paper engine lastPrice fallback rakhta hai
      const res = closePaperTrade(t.id, { [t.symbol]: { price: t.lastPrice } }, 'MTF-TIME-EXIT');
      if (res?.ok) exited++;
    }
    if (exited > 0) {
      const st = _loadState();
      st.timeExits = Number(st.timeExits || 0) + exited;
      _saveState(st);
      const line = `⏰ <b>MTF TIME-EXIT (paper)</b> — ${exited} trade(s) hold-window expire par band (mode time-box discipline)`;
      try { if (sendTelegram) await sendTelegram(line); } catch { /* best-effort */ }
    }
  } catch { /* non-fatal — next tick retry */ }
  return { exited };
}

// test hook — hermetic tests config/state reset + busy guard clear
// v21.35.3 [PRO-LEVEL RECHECK — PRODUCTION FILE GUARD]: a test-only hook must
// never delete the REAL server/data files. When no hermetic test-dir env
// (MTF_AUTO_DATA_DIR / SMARTAI_DATA_DIR) is active — e.g. a preceding test's
// afterAll `delete`-d the override and the process fell back to the module
// default — this hook used to rmSync the LIVE mtf-auto config + state, which
// is exactly how a full-suite run wiped the operator's risk caps + auto book.
// The busy-guard reset still applies unconditionally; the destructive file
// ops are suppressed on the production dir.
export function __resetMtfAutoForTests() {
  const onProduction = _dataDirIsProduction();
  if (!onProduction) {
    try {
      fs.rmSync(CFG_FILE(), { force: true });
      fs.rmSync(STATE_FILE(), { force: true });
    } catch { /* best-effort */ }
  }
  _tickBusy = false;
}
