// TEMP: ETH live-trade monitor (one-shot 30m watch) — polls :8080, emits state changes.
import fs from 'node:fs';
const env = fs.readFileSync('.env', 'utf8');
const TOKEN = (env.match(/^API_TOKEN=(.*)$/m) || [])[1]?.trim().replace(/^["']|["']$/g, '') || '';

const PID = '7379efc7-38cc-467a-a098-c90be88e992b';
const entry = 2046.77, qty = 0.117, SL = 2058.97, TP1 = 2034.89, TP2 = 2022.86;
const ARM_AT = 2042.13;      // trail: peakR >= 0.5 (NORMAL vol) — SHORT favorable move
const NOLOSS = 2043.25;      // shadow no-loss SL (fee 0.19R + buffer 0.1R)
const FEEBE = 2044.47;       // round-trip fee breakeven floor
const R = Math.abs(entry - SL); // 12.20

const j = async (p) => {
  const r = await fetch('http://localhost:8080' + p, { headers: { Authorization: 'Bearer ' + TOKEN } });
  return r.json();
};

let lastStage = null, lastBoardSide = null, lastDeepSide = null;
let armedSent = false, heartbeat = 0;
const t0 = Date.now();

while (true) {
  let out = [];
  // 1) position journal state
  const pos = await j('/api/ai/positions').catch(() => ({ positions: [] }));
  const p = (pos.positions || []).find(x => x.id === PID);
  const ltp = p?.ltp ?? null;
  const stage = p?.exitStage ?? null;
  const stillOpen = Boolean(p && p.status === 'OPEN');
  const pnl = ltp != null ? +(entry - ltp) * qty : null; // SHORT

  if (p && stage !== lastStage) { out.push(`ETH stage → ${stage}${lastStage ? ` (was ${lastStage})` : ''}`); lastStage = stage; }
  if (ltp != null && ltp <= ARM_AT && !armedSent) { out.push(`🔒 TRAIL ARMED — ltp ${ltp} ≤ arm@${ARM_AT} (peakR≥0.5) → shadow no-loss SL ${NOLOSS} (fee 0.19R + buffer) — live SL abhi ${SL}`); armedSent = true; }
  if (ltp != null && ltp <= TP1 + 2) out.push(`⚠ ltp ${ltp} ≤ TP1 ${TP1}+2 — TP1 zone`);
  if (ltp != null && ltp >= SL - 3) out.push(`🚨 ltp ${ltp} within 3 of SL ${SL} — adverse`);
  if (stillOpen && pnl != null && Math.abs(pnl) > 0.4) out.push(`pnl ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} USDT (${(pnl / (qty * R)).toFixed(2)}R gross) ltp ${ltp}`);
  if (!stillOpen) { out.push(`ETH POSITION CLOSED — final ${pnl != null ? (pnl >= 0 ? '+' : '') + pnl.toFixed(2) + ' USDT (' + (pnl / (qty * R)).toFixed(2) + 'R)' : 'n/a'} — monitoring complete`); }

  // 2) board side + finalVerdict (2s-cached board — cheap)
  try {
    const b = await j('/api/ai/mtf-dual/board?market=CRYPTO&mode=INTRADAY').catch(() => ({}));
    const row = (b.rows || []).find(x => x.symbol === 'ETH') || (b.scanRows || []).find(x => x.symbol === 'ETH');
    const bs = row?.side ?? null;
    const fv = row?.finalVerdict?.decision ?? null;
    if (bs !== lastBoardSide) {
      out.push(`BOARD ETH side: ${lastBoardSide ?? '—'} → ${bs}${fv ? ` · FINAL=${fv} · score=${row?.superScore}` : ''}${bs === 'LONG' ? ' — signal FLIPPED LONG' : ''}`);
      lastBoardSide = bs;
    }
  } catch { /* poll skipped */ }

  // 3) deep side (30s-cached — a bounded cost)
  if (heartbeat % 2 === 0) {
    try {
      const d = await j('/api/ai/deep/ETH?market=CRYPTO').catch(() => ({}));
      const ds = d?.signal?.side ?? null;
      if (ds !== lastDeepSide) out.push(`DEEP ETH side: ${lastDeepSide ?? '—'} → ${ds} (conf ${d?.signal?.confidence ?? '-'})${ds === 'LONG' ? ' — deep ensemble FLIPPED LONG' : ''}`);
      lastDeepSide = ds;
    } catch { /* poll skipped */ }
  }

  if (out.length) console.log(`[t+${Math.round((Date.now() - t0) / 1000)}s] ` + out.join(' | '));
  else if (++heartbeat % 5 === 0) {
    // 5-min heartbeat: compact state (silence != confirmation)
    console.log(`[heartbeat t+${Math.round((Date.now() - t0) / 60000)}m] ETH ${stillOpen ? 'OPEN' : 'CLOSED'} ltp=${ltp ?? '?'} pnl=${pnl != null ? pnl.toFixed(2) + ' USDT' : '?'} board=${lastBoardSide ?? '?'} deep=${lastDeepSide ?? '?'} stage=${stage ?? '?'} trailArmed=${armedSent}`);
  }
  if (!stillOpen) break; // terminal — report and stop
  await new Promise(r => setTimeout(r, 60_000));
}
console.log('monitor loop ended');
