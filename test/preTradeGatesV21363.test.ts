// ============================================================
// test/preTradeGatesV21363.test.ts — v21.36.3 PRE-TRADE GATE PROMOTION
// ------------------------------------------------------------
// USER COMPLAINT (verbatim): "paper trade lagaya toh sab against signal
// jaa rahe hai — short trade pe long, long trade pe short." LIVE recheck
// verdict: direction side tha hi sahi (candles/board/FreeLLMAPI teeno
// aligned; regression suite + live direction-cert PASS). "Against signal"
// feel ki asal wajah ENTRY QUALITY thi — weak/late/neg-EV entries, kyunki
// teeno pre-trade gates (mcOdds / lateWave / breakoutConfirm) shadow
// (observe-only) par hi khadi thin. Live shadow stats pehle se batate the:
// monteCarloOdds 7 decisions me 3 would-block (neg-edge+stop-heavy).
//
// v21.36.3: dono quality gates + late-wave ENFORCE default ban gayi (fresh
// deploys — jo server/data/ wipe karte hain — safe se start karein). Ye
// file us promotion ko locks:
//   • MTF_AUTO_DEFAULTS me saare teen enforce
//   • _sanitizeCfg fallback: unknown/legacy value → enforce (kabhi nahi
//     silently shadow par wapas)
//   • accessor env-fallback: blank env → enforce
//   • explicit operator override (shadow/off) ab bhi honored
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-trade-gates-21363-'));
process.env.MTF_AUTO_DATA_DIR = TMP_DATA;

import {
  __resetMtfAutoForTests,
  mcOddsGateMode,
  breakoutConfirmGateMode,
  lateWaveGateMode,
} from '../server/ai/mtfAutoLink.js';

const ENV_KEYS = ['MC_ODDS_GATE', 'LATE_WAVE_GATE', 'BREAKOUT_CONFIRM_GATE'] as const;
const SAVED: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    SAVED[k] = process.env[k];
    delete process.env[k];
  }
  __resetMtfAutoForTests();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (SAVED[k] == null) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
  __resetMtfAutoForTests();
});

describe('v21.36.3 — pre-trade quality gates: ENFORCE by default', () => {
  it('no env, no persisted config → all three gates resolve ENFORCE', () => {
    expect(mcOddsGateMode()).toBe('enforce');
    expect(breakoutConfirmGateMode()).toBe('enforce');
    expect(lateWaveGateMode()).toBe('enforce');
  });

  it('unknown persisted values fall back to ENFORCE (never silently shadow)', () => {
    __resetMtfAutoForTests({
      config: {
        mcOddsGate: 'banana', lateWaveGate: '', breakoutConfirmGate: 'legacy-observed',
      } as never,
    });
    // truly-unknown/blank → new enforce default (v21.36.3 promotion)
    expect(mcOddsGateMode()).toBe('enforce');
    expect(lateWaveGateMode()).toBe('enforce');
    expect(breakoutConfirmGateMode()).toBe('enforce');
  });

  it('documented legacy aliases still resolve shadow (dry-run/observe)', () => {
    __resetMtfAutoForTests({
      config: { mcOddsGate: 'dry-run', lateWaveGate: 'observe' } as never,
    });
    expect(mcOddsGateMode()).toBe('shadow');
    expect(lateWaveGateMode()).toBe('shadow');
  });

  it('explicit operator override still honored (shadow + off)', () => {
    __resetMtfAutoForTests({
      config: { mcOddsGate: 'shadow', lateWaveGate: 'off', breakoutConfirmGate: 'shadow' } as never,
    });
    expect(mcOddsGateMode()).toBe('shadow');
    expect(lateWaveGateMode()).toBe('off');
    expect(breakoutConfirmGateMode()).toBe('shadow');
  });

  it('env var overrides persisted config (rollout convention)', () => {
    __resetMtfAutoForTests({ config: { mcOddsGate: 'shadow' } as never });
    process.env.MC_ODDS_GATE = 'enforce';
    expect(mcOddsGateMode()).toBe('enforce');
    delete process.env.MC_ODDS_GATE;
  });
});
