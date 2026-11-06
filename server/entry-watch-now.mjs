// One-off watcher: poll mtf-auto-state.json every 15s; exit 0 when a new open
// trade appears (printing full detail + gate verdicts), exit 2 on 40-min timeout
// (printing latest gate-block reasons). For manual user-requested live entry watch.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __d = path.dirname(fileURLToPath(import.meta.url));
const STATE = path.join(__d, 'data', 'mtf-auto-state.json');
const POLL_MS = 15_000;
const TIMEOUT_MS = 40 * 60_000;
const START = Date.now();

const t = x => new Date(x).toISOString();

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return null; }
}

function openTrades(st) {
  return (st?.book || []).filter(b => b.status === 'open' && !b.closedAt);
}

function tail(st, kind, n = 4) {
  return (st?.events || []).filter(e => e.kind === kind).slice(-n);
}

console.log('[watch] armed at', t(START), 'poll', POLL_MS, 'timeout', TIMEOUT_MS);

const timer = setInterval(() => {
  const st = readState();
  if (!st) return;
  const open = openTrades(st);
  if (open.length > 0) {
    console.log('[watch] OPEN TRADE DETECTED at', t(Date.now()));
    for (const b of open) {
      console.log('[watch] OPEN:', JSON.stringify(b, null, 2).slice(0, 1200));
    }
    const ss = st.shadowStats || {};
    for (const k of ['lateWave', 'monteCarloOdds', 'breakoutConfirm']) {
      const v = ss[k];
      if (!v) continue;
      const last = (v.samples || []).slice(-2);
      console.log(`[watch] gate ${k} dec=${v.decisions} wouldBlock=${v.wouldBlock} lastAt=${t(v.lastAt || 0)} lastReasons:`, last.map(s => s.reason || '-').join(' ; '));
    }
    console.log('[watch] recent gate events:');
    [...tail(st, 'entry-gate-block'), ...tail(st, 'entry-gate-shadow')].forEach(e =>
      console.log(' ', t(e.at), e.kind, '|', e.text));
    clearInterval(timer);
    process.exit(0);
  }
  if (Date.now() - START >= TIMEOUT_MS) {
    console.log('[watch] TIMEOUT — no new entry in 40 min.');
    console.log('[watch] latest gate-block events:');
    tail(st, 'entry-gate-block', 6).forEach(e => console.log(' ', t(e.at), '|', e.text));
    const lt = st.lastTick;
    console.log('[watch] lastTick skipped:', lt ? lt.skipped : '(none)');
    clearInterval(timer);
    process.exit(2);
  }
}, POLL_MS);
