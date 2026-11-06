# FLAG HISTORY (Phase A5 / 15.2 / L)

> Har flag flip (off ↔ shadow ↔ enforce) ka AUDIT TRAIL. Promotion rule:
> shadow-report verdict `useful` + n ≥ 100–150 + data-coverage ≥ 80% +
> no DD worsening + 1 hafte observe + **manual typed-confirm**. Rollback:
> env/config se `off` + is table me entry + alert.
>
> **Koi bhi flag default-enforce me nahi jaata bina is table me shadow-report
> link ke (release gate L).**

## v21.34.0 — advance-pro re-audit (NO flag flips — sirf gate-engine honesty)

> Deep re-audit me **koi bhi flag ki value nahi badli** (sab shadow/off as-is). Sirf promotion/acceptance ENGINES fail-closed hue: championChallenger ab CI-non-overlap (cLo > championHi) + DD-known REQUIRED; train-meta acceptance ab rule-score baseline + forward-only walk-forward; metaModel artifact feature-schema deep-validated. Ekta CHAMPION data field add hui — `oosExpectancyHiR` (CI upper) — operator baseline bootstrap se bharega, missing = promotion refuse (honest).

## Current flag matrix (v21.33.0)

| Flag | v21.32 (pehle) | v21.33 (ab) | Kyon | Promotion path |
|------|----------------|-------------|------|----------------|
| `PRE_TP1_TRAIL` | shadow | shadow (unchanged) | G10: LIVE-SMALL #1–#2 abhi tak pass nahi | H2 #1–#2 pass → enforce |
| `entryTimingGuard` | enforce | enforce (unchanged) | pehle se enforce, thresholds F-e late-entry data se tune honge | keep |
| `closedBarConfirm` | shadow | shadow | A5 report pending | shadow-report `useful` → enforce |
| `EXIT_POLICY_V3` | shadow | shadow | paper↔live parity test baaki | paper → live-small |
| `eventSessionFilter` | shadow | shadow | A5 report pending | A5 → enforce |
| `regimeFilter` | shadow | shadow | A5 report pending (CHOP block) | A5 → enforce |
| `perpVeto` | shadow | shadow | coverage ≥80% chahiye pehle | coverage + A5 → enforce |
| `reversalGuardV2` | shadow | shadow | evidence-driven (G5) | A5 → thresholds tune |
| `clusterGuard` | shadow | shadow | low priority (S10) | data-driven clusters |
| `META_MODEL` | off | off (unchanged) | Phase E — dataset ≥300 chahiye; trainer artifact bina OOS-beat ke refuse karta hai. Board-scan A5 shadow recording chalti rehti hai (measurement, flag-gated behaviour nahi) | off → shadow → enforce (E gates) |
| `liveTp1Partial` / `liveRunner` / `stallExit` | off | off | S3 #3 / S9 (paper ≥100 trades) | per S3/S9 |
| `retestEntry` / `volTargeting` / `kellyResearch` | off | off | research flags (F/G) | research only |
| `SIGNAL_FAMILY` | (new) | **shadow** | Phase D1 — family/regime fit labels + would-block verdicts ledger me (A5 data) | shadow-report `useful` → enforce |
| `HIERARCHICAL_MTF` | (new) | **shadow** | Phase D2 — HTF veto layer labels (A5 data) | shadow-report `useful` → enforce |
| `GROUPED_CONFLUENCE` | (new) | **shadow** | Phase D3 — grouped score report-only (score replace nahi hota) | parity proof → enforce |
| `SIGNAL_LIFECYCLE` | (new) | **shadow** | Phase D5 — CANDIDATE→CONFIRMED→ARMED→FIRED/EXPIRED labels + anti-flicker telemetry | stability ≥85–90% → enforce |
| `ADAPTIVE_TP` | (new) | **shadow** | Phase G2 — MFE-percentile TP suggestion; levels apply NAHI hote | backtest-validated → enforce |
| `SPREAD_GATE` | (new) | **shadow** | Phase F-c — spreadBps entry veto (coverage abhi missing — fail-open) | coverage ≥80% + A5 → enforce |
| `SLIPPAGE_GATE` | (new) | **shadow** | Phase F-b — expected-slippage > 0.15R veto (needs depth telemetry) | coverage + A5 → enforce |
| `CHAMPION_CHALLENGER` | (new) | **shadow** | Phase J — promote/rollback engine + hourly watch (typed-confirm endpoint) | operator choice |

> **v21.33.0 NOTE:** Naye Phase C–G flags sab **SHADOW default** hain — sirf
> labels/measurement/telemetry. **Koi live trade behaviour change nahi** jab
> tak A5 shadow-report `useful` verdict + typed-confirm se promote na ho.
> Direction chain (LONG→BUY / SHORT→SELL certificate) in flags se kabhi
> touch nahi hoti — ye sirf take/skip/label decisions hain.

## Flip log

| Timestamp | Flag | Change | Evidence / Link | Operator |
|-----------|------|--------|-----------------|----------|
| 2026-10-31 (v21.32.0) | `PRE_TP1_TRAIL` | enforce → **shadow** (default) | Master plan Phase A/H + G10: LIVE-SMALL-CHECKLIST #1–#2 (SL visibility + replace-vs-stack) abhi tak pass nahi — bina proof ke trail enforce rakhna unsafe. Env `PRE_TP1_TRAIL=enforce` se wapas enforce possible (operator choice). | plan-applied (this release) |
| 2026-11-01 (v21.33.0) | `SIGNAL_FAMILY`, `HIERARCHICAL_MTF`, `GROUPED_CONFLUENCE`, `SIGNAL_LIFECYCLE`, `ADAPTIVE_TP`, `SPREAD_GATE`, `SLIPPAGE_GATE`, `CHAMPION_CHALLENGER` | (new) → **shadow** (default) | Master plan Phases C–J (v21.33.0 release). Naye modules: featureVector fv:2, signalFamilies, signalLifecycle, metaModel, entryQuality, adaptiveTargets, championChallenger, accuracyDashboard. Sab shadow-first (plan §15.2) — A5 counterfactual data accumulate hoga, promote manual typed-confirm se. | plan-applied (this release) |

<!-- `shadow-report.mjs` har run par yahan "report generated" audit entry
     add karta hai (flip record NAHI). Pehli asli run aapke live ledger data
     ke saath hogi — tab tak koi synthetic entry nahi hai. -->
