# Master Plan Progress Tracker — Higher-Accuracy Trade Signals

> Base: v21.31.0 (`4826451`) · Plan apply: **v21.32.0** (Phase A + B + C-partial + H-docs) · **v21.33.0** (Phase C full + D + E + F + G + I + J + K + L + cleanup + direction hardening) · **v21.34.0** (advance-pro deep re-audit: exec-stack integrity + ML-gate honesty + shadow-contract fixes) · **v21.35.0** (site recheck round-2: 3-parallel audit — live-lane races + champion-gate wiring + shadow-module latent traps + v21.34.0 stale-test cure)
> Ye file har plan-phase ka live status rakhti hai. Tick sirf tab jab code + tests dono ho.

## Phase status

| Phase | Scope | Status | Kya hua |
|-------|-------|--------|---------|
| **A — Measurement foundation** | A1–A6 | ✅ **DONE (v21.32.0)** | definitions frozen, triple-barrier labeler, ledger schema v2, scorecard v2 (+API+CLI), shadow-report CLI, baseline+champion freeze |
| **B — Data quality & latency** | B1–B3 | ✅ **DONE (v21.32.0)** | candleIntegrity (pure), priceCrossCheck (pure), latencyStats recorder (tickToRow wired) |
| **C — Feature layer** | C1–C4 | ✅ **DONE (v21.33.0)** | fv:2 featureVector (F2 realized-vol ratio, F8 RSI/MACD divergence — confirmed pivots no-repaint, F9 RS-vs-BTC + beta/corr, F11 session features, F13 bar-shape) wired into board rows + ledger (schema fv:2). F5/F6/F7/F10/F12 pehle se the (volume profile/CVD/depth/perp) |
| **D — Signal generation** | D1–D6 | ✅ **DONE (v21.33.0)** | signalFamilies.js (4 families + fit gate + hierarchical MTF HTF-veto + grouped confluence caps + veto stack) + signalLifecycle.js (CANDIDATE→CONFIRMED→ARMED→FIRED→EXPIRED + anti-flicker margin/dwell + stop-out cooldown + rolling-corr cluster + F-g dedup) — sab SHADOW |
| **E — Meta-model** | E1–E5 | ✅ **DONE (v21.33.0)** | metaModel.js (logistic JSON-weights inference + isotonic + META_MODEL gate off/shadow/enforce, side kabhi flip nahi) + scripts/train-meta.mjs trainer (purged walk-forward, OOS Brier/ECE/AUC vs calibrated-score baseline, n≥300 refusal, artifact models/meta-*.json) |
| **F — Entry quality** | F-a–g | ✅ **DONE (v21.33.0)** | entryQuality.js (spread gate 2×median/hard-cap, slippage model a+b·(size/depth)+c·spread + 0.15R budget, retest entry plan direction-correct, funding-window proximity) + entry dedup wired in mtfAutoLink (F-g) |
| **G — Exits/risk/sizing** | G1–G6 | ✅ **DONE (v21.33.0)** | G1 SL-hybrid + G6 DD-governor/fixed-fractional pehle se the; adaptiveTargets.js (G2 MFE-p40–50/p75 TP with geometry invariant, G6 vol-targeting clamp [0.5,1.0] + quarter-Kelly research refusals) wired SHADOW; pre-TP1 trail shadow (G10) |
| **H — CoinDCX hardening** | H2-docs + flag + SL polarity guard | 🟡 **PARTIAL** | LIVE-SMALL-CHECKLIST + FLAG-HISTORY + PRE_TP1_TRAIL→shadow + **v21.33.0: validateStopPolarity guard in updateCoinDcxPositionSl (wrong-side SL/TP push REJECT)** + liquidation-estimate side-honesty. H1/H3–H9 need live operator |
| **I — Optimization** | I1–I4 | ✅ **DONE (v21.33.0)** | scripts/optimize.mjs — grid search walk-forward-only + plateau rule (≥70% neighbours) + OOS≥70%·IS + min-100-trades + Monte-Carlo DD p95 + stress row + trial-count log → docs/OPT-RUNS/*.json |
| **J — Learning loop** | J | ✅ **DONE (v21.33.0)** | championChallenger.js (promotion rule engine + typed-confirm promote/rollback + FLAG-HISTORY audit + hourly watch in index.js) + DRIFT ALARM telegram push (K2) |
| **K — Monitoring/UI** | K1–K4 | ✅ **DONE (v21.33.0)** | accuracyDashboard.js + `/api/ai/accuracy-dashboard` (scorecard-v2 + drift + flags + shadow summary + latency + calibration honesty) + `/api/ai/flags` + flags/change endpoint + AccuracyFlagsPanel.tsx UI (flag matrix chips) |
| **L — Testing & release gates** | L | ✅ **DONE (v21.33.0)** | 148 naye tests (8 files: featureVector/families/lifecycle/metaModel/entryQuality/adaptiveTargets/championChallenger/directionInvariants), typecheck+lint+build+routes green, CI workflow repo-root par pehle se hai |

## v21.35.0 EXTRA — SITE RECHECK ROUND-2 (user: "v21.33.0 ye latest site code recheck karke dekho sabhi working fine hai kya advance pro level pe koi issues hai tho fix kardo")

Teen NAYE parallel deep-audit passes (shadow-modules / exec-stack / server-wiring). Direction core FIR SE zero-inversion. Highlights (details CHANGES.md v21.35.0 me):

- **LIVE RACES (3 HIGH):** PM native-TP full-close vs documented 40/30/30 ladder (ab SL-only setProtection) · journal `pnl:null`→0 daily-loss blindness + ghost-race merge-aware overwrite · reconciler orphan-flatten vs PM entry no-SL window (pendingEntryPairs registry).
- **CHAMPION GATE WIRING (HIGH):** evaluateChallengerPromotion engine call-site par kabhi laga nahi tha — ab `/api/ai/flags/change` promote par REQUIRED (stats) ya explicit evidence (fail-closed); historyWritten honesty; challenger cLo symmetric fail-closed.
- **SILENT-LANE CURE:** 60s/15s/3s swallowed catches ab logged + healthMonitor deep-monitor stale alert (positions-open gated) + mtf-row-ledger durable boot-restore + book trim.
- **SHADOW MODULES:** strictScore/MEAN_REV live wiring, BTC closesAt age-gate, lifecycle cooldown/margin fail-closed + wall-clock expiry, metaModel deep validation + side-aware divergence, entryQuality window/depth/retest honesty, adaptiveTargets MFE de-censoring.
- **QUALITY:** v21.34.0 ke 2 stale version-pin tests cure (uska green-claim galat tha); +59 regression tests; suite ab **278 files / 5091 GREEN**, tsc/eslint/build/routes/version sab pass.

## v21.34.0 EXTRA — ADVANCE-PRO DEEP RE-AUDIT (user: "v21.33.0 recheck karke dekho sabhi working fine hai kya advance pro level pe koi issues hai tho fix kardo")

3 parallel deep-audit passes + direction-chain manual review. Direction core FIR SE zero-inversion verified. Jo mile aur fix hua:

- **EXEC-STACK (3 HIGH):** PM give-back R-base mismatch (partials ko hi "retrace" maan leta tha — runner premature force-close; ab pure price-R) · PM exits ka journal write-back missing (OPEN rows → one-per-pair lockout + maxOpen exhaustion + phantom heat + daily-loss blindness + restart GHOST loop; ab har ladder action sync) · hydrate stage-restore (restart pe double T1 partial; ab stage/qty/sl/peak/candles persist + restore).
- **ML GATES (2 HIGH):** train-meta aggregate baseline model-pRaw par evaluate ho raha tha (acceptance gate self-comparison — kharab model bhi pass) → ab rule-score par · blocked-CV → TRUE forward-only walk-forward (future-regime train nahi).
- **DIRECTION LATENT-HARDENING:** smartTrail silent-LONG default (tri-state) · reversalEngine row-side normalize + non-tradable level guard · PM port-side validate · metaModel feature-schema deep validation · F9 BTC 1-bar lookahead fix (LIVE ledger tak ja raha tha).
- **PROMOTION FAIL-CLOSED:** champion CI-non-overlap REQUIRED + formula sahi (cLo > championHi) · DD-unknown refuse · watch real shadow verdicts · mode validation.
- **RISK MATH:** sizing NaN-guards (caps silently bypass ho sakte the) · feeCovered honesty · hardGate NaN fail-closed · globalRisk market case · lifecycle immortal-states/arm-gate/cooldown-side · families strictScore-enforce + [0..1] scale · entryQuality liquidity-hoist + slippage-b recalibration.
- **SERVER:** CORS-before-body-parse · validateEnv arming se pehle · vision-check validation+cap · rate-map flood cap.
- **Tests:** positionManagerV21340 (12 naye) + champion/families naye cases — suite ab ~5040 green.

## v21.33.0 EXTRA (user-requested, plan se beyond)

- **DIRECTION HARDENING** (user ka #1 concern — "Long signal pakka LONG jana chahiye TP1/TP2 tak"):
  - Deep audit: poora signal→order→SL/TP→trail→partial-close chain polarity-verified — **koi active inversion bug nahi** (7 historical inversion classes already fixed).
  - `validateStopPolarity()` pure guard: LONG SL/TP current-price ke wrong side → push REJECT (premature close se bachav); SHORT mirror; profit-lock allowed.
  - Liquidation estimates: unknown side → **null** (silent-LONG display estimate khatam) — futures/globalFutures/coindcxOrders.
  - `directionInvariantsV21330.test.ts`: polarity + certificate + tradePlanner TP-geometry regression locks.
- **CLEANUP**: 9 orphan/dead files deleted (2× e2e boot checks, PHASE-2 checklist, audit.md, DEEP-RECHECK.md, smart-trail-replay.mjs, stale baseline, ensembleAdapter dead web, bots/core/audit.js) + saare stale references fixed. Repo temp-file/broken-code/duplicate-free.

## Master checklist (plan §18.5) — current ticks

**Safety first**
- [x] `PRE_TP1_TRAIL=shadow` until H2 #1–#2 pass ← **v21.32.0 apply (G10)**
- [x] H2 LIVE-SMALL checklist **document** (9 tests + H1 endpoint table) — results operator bharega
- [ ] H1 endpoints docs-verified + fixtures *(operator, live)*
- [ ] H2 checklist 1–9 **done, results saved** *(operator, live)*
- [ ] H3 native TP/SL fingerprint in `classifyOpenOrder` *(needs live fixtures)*
- [x] H4 rearm safety net *(pehle se — routes 3s fast-SL loop + read-back retry)*
- [ ] Live caps non-zero in server config *(operator check)*
- [x] `npm run check` green *(local verified v21.33.0; CI workflow repo-root `.github/workflows/ci.yml` me pehle se wired)*

**Measurement**
- [x] A1–A6 + B1–B3 *(v21.32.0)*
- [x] C3 features F2/F8/F9/F11/F13 + fv:2 snapshot + no-lookahead tests *(v21.33.0)*
- [x] C2 golden-vector: independent-reference property tests (deterministic series + hand-verified RSI/pivot vectors) *(v21.33.0 — TradingView export fixtures operator apne data se bana sakta hai)*

**Signals**
- [x] D1 families · D2 hierarchical MTF · D3 grouped confluence · D5 lifecycle/hysteresis · D6 cluster corr *(v21.33.0, sab SHADOW)*
- [x] E trainer + inference + gate (off→shadow→enforce; artifact bina n≥300 + OOS-beat ke nahi banta) *(v21.33.0)*
- [x] F entry quality (retest plan, slippage model+gate, spread gate, funding window, entry dedup) *(v21.33.0)*

**Exits & risk**
- [x] G1 SL hybrid *(pehle se)* · G2 data-driven TP SHADOW suggestion *(v21.33.0)* · G3 trail validation metric A5 report me *(v21.32.0)* · G6 vol-targeting + Kelly research *(v21.33.0, off)*
- [ ] G4 partial/runner paper→live-small *(data-gated)* · G5 reversal tuned *(A5 ke baad)*

**Ops**
- [x] K1 dashboard API + K3 flag panel UI + K2 DRIFT telegram *(v21.33.0)*
- [x] J champion/challenger engine + hourly watch *(v21.33.0)*
- [x] I optimizer protocol *(v21.33.0 — chalane ke liye candles-file ya --use-fetch chahiye)*
- [ ] H5 reconciler loop · H7 always-on host · H8 auto-halt *(operator/live-gated)*

**Promotion discipline**
- [x] FLAG-HISTORY.md exists + PRE_TP1_TRAIL flip + v21.33.0 naye-flags entry recorded
- [x] Flag matrix UI + typed-confirm endpoint (manual flips ka audit trail)
- [ ] Har future flag flip ka FLAG-HISTORY entry + shadow-report link

## Next steps (plan order)

1. **≥2 hafte data collect** karo — server chalao, board scans ledger bharenge (fv:2 schema se, naye shadow guards ke verdicts ke saath).
2. `node scripts/scorecard.mjs` + `node scripts/shadow-report.mjs` chala ke pehle asli reports lo.
3. `node scripts/train-meta.mjs` (n≥300 hone par) → `META_MODEL=shadow` → A5 evidence → enforce.
4. **H1/H2 live-small** operator ke haath me — pass hone ke baad PRE_TP1_TRAIL → enforce (FLAG-HISTORY entry).
5. `node scripts/optimize.mjs --candles-file <json>` se parameter search (protocol-enforced).

## Data-dependent gates (honest)

- Scorecard v2 slices abhi "insufficient" honge (n<30) — data collect hone tak ye NORMAL hai.
- ECE/Brier sirf unhi rows par jinka `pWinClaimed` record hua (pWin coverage metric dekho).
- Shadow-report verdicts ke liye n ≥ 100 dono sets + coverage ≥ 80% chahiye — pehle 2 hafte sirf accumulation.
- Meta-model artifact trainer ke acceptance gate se hi banega — n<300 ya OOS-beat-fail par REFUSE (honest cold-start).
- Naye Phase C–G flags SAB SHADOW default — koi live trade behaviour change nahi bina A5 + typed-confirm ke.
