# SmartAI Pro — ACCURACY DEFINITIONS (v21.32.0)

> **Status: FROZEN (Phase A1, master plan).** Ye document "accuracy" ki HAR definition
> ek jagah freeze karta hai — scorecard v2, shadow-report, baseline aur KPI reporting
> sab inhi definitions ko use karte hain. Koi bhi naya metric pehle yahan document
> hoga, phir code me jayega.
>
> **Honest framing:** "Higher accuracy" = *measurable improvement* (calibrated
> probability, positive net expectancy, kam false signals). Koi fixed win-rate ka
> wada nahi. Markets non-stationary hain; koi bhi system har trade sahi nahi karega.
> Saare numerical thresholds starting hypotheses hain — inhe apne ledger/replay data
> se validate karna zaroori hai.

---

## 1. Labeling: triple-barrier (conservative)

Har logged MTF signal (entry `E`, side, planned SL/T1/T2 — **system ke actual plan
levels**, hypothetical nahi) ke liye:

- `SL = E ∓ k_sl·ATR` **ya** system ka actual planned `stopLoss` (jo bhi plan ne diya).
- `TP1 = plan.t1`, `TP2 = plan.t2`.
- Horizon `H` = plan ka `suggestedHoldMin` (fallback: 48 trigger-TF bars).
- Entry ke baad ke bars ke high/low scan karo.
- **Agar ek hi bar me SL aur TP dono touch hon → SL pehle maano (conservative).**
- Label ∈ `{TP2, TP1, SL, TIMEOUT}` + MFE/MAE (in R) + time-to-touch (bars/minutes).

Implementation: `scripts/lib/tripleBarrier.js` (`labelSignal`).

`TIMEOUT` rows ka `directionHit` existing v21.28 rule se aata hai
(`mfeR ≥ 0.5 && maeR < 1.0` ya `outcomeR > 0`).

---

## 2. Metric definitions (ek jagah)

| Metric | Definition | Notes |
|--------|-----------|-------|
| **Hit-TP1** | Signal ke baad price entry→TP1 distance **pehle** touch kare, SL se pehle (triple-barrier). | `label ∈ {TP1, TP2}` |
| **Hit-TP2** | TP2 pehle touch ho, SL se pehle. | `label = TP2` |
| **Stop-rate** | SL pehle touch. | `label = SL` |
| **Timeout-rate** | Horizon `H` bars me koi barrier nahi. | `label = TIMEOUT` |
| **Direction accuracy @H** | `H` bars baad close, signal direction me `≥ 0.5×ATR` move. | TIMEOUT resolution ka `directionHit` |
| **Net expectancy (R)** | `avg(R)` after fees + slippage + funding. | 1R = planned risk (entry−SL distance) |
| **Profit factor (PF)** | `Σ wins / Σ losses` (net R, sign-safe). | `null` jab koi loss nahi |
| **Max drawdown (R)** | Peak-to-trough on cumulative R equity of taken signals. | % drawdown alag se report |
| **Calibration error (ECE)** | `Σ_b (n_b/N)·\|claimed_b − realised_b\|` over pWin buckets. | Chahiye `pWinClaimed` (A3) |
| **Brier score** | `mean((p − outcome)²)` | `p = pWinClaimed`, outcome = TP1/TP2 hit |
| **Signal stability** | % signals jo bar-close tak same direction rakhein (repaint measure). | `signalStable` ledger field |
| **Late-entry cost** | entry price − ideal trigger price, in R. | Entry-timing guard tuning (Phase F) |
| **MFE / MAE** | Max favourable / adverse excursion, in R. | Ledger me already tracked |
| **Wilson 95% CI** | `p̂=k/n; z=1.96; c=(p̂+z²/2n)/(1+z²/n); h=z·√(p̂(1−p̂)/n + z²/4n²)/(1+z²/n); CI=[c−h, c+h]` | `scripts/lib/stats.js` |
| **Bootstrap CI (expectancy)** | 2000-iter deterministic-seed resample of per-signal R. | `scripts/lib/stats.js` |

---

## 3. Min-n gates (kab number ko trust karein)

| n (resolved) | State | UI chip |
|--------------|-------|---------|
| `n < 30` | **insufficient** | grey chip — koi decision nahi |
| `30 ≤ n < 100` | early signal | amber chip — sirf trend dekho |
| `n ≥ 100` | **reviewable** | normal chip — compare kar sakte ho |
| `n ≥ 150` | **decision-grade** | green chip — flag promotion allowed |

Shadow-report verdicts ke liye alag se: blocked-set verdict tabhi valid jab
**n ≥ 100** dono sets me aur **data-coverage ≥ 80%**.

---

## 4. Counterfactual shadow verdicts (A5)

Har guard/flag ke liye **would-block set** vs **taken set** compare hota hai:

- **useful** — blocked-set expectancy taken-set se significantly kharab
  (bootstrap p < 0.1 ya CI non-overlap) **aur** n ≥ 100.
- **harmful** — blocked-set better (filter winners ko kaat raha hai).
- **neutral** — otherwise.
- **invalid** — data-coverage < 80% (e.g. perp data present %).

Output: `docs/SHADOW-REPORT-<date>.md` + `docs/FLAG-HISTORY.md` me flip record.

---

## 5. Scorecard v2 buckets

Per `tier × desk(market) × regime × side × session` slice, report:
`n`, Hit-TP1 (Wilson 95% CI), Hit-TP2, Stop-rate, TIMEOUT-rate, expectancy R
(bootstrap 95% CI), PF, MFE/MAE medians, ECE/Brier (jab pWinClaimed available),
avg time-to-TP1, stability %.

Session buckets (IST): `pre-open (≤09:15)`, `morning (09:15–11:00)`,
`midday (11:00–14:00)`, `close (14:00–15:30)`, `after (<18:00)`, `night (>18:00)`.

---

## 6. KPI acceptance form (targets = "baseline se improvement")

- Net expectancy (R) per promoted tier: **lower 95% bootstrap CI bound > 0** at n ≥ 150.
- Hit-TP1 (ELITE/STRONG) vs baseline: ≥ +3–5 pts **ya** same hit-rate with fewer
  trades & higher expectancy (CI non-overlap).
- ECE ≤ 5 pts on decision-grade buckets; Brier ≤ baseline.
- Signal stability (bar-close survival) ≥ 85–90%.
- Max drawdown (95th pct bootstrap) within pre-declared cap (e.g. ≤ 6–8R).
- Direction invariants: 0 violations.
- Protection: 100% live trades SL-verified within 10s of entry.

Agar KPIs na milein ⇒ change promote nahi hoga (rollback ya rework).

---

## 7. Ledger schema (A3 — v2)

Har MTF scan row par ab ye extra store hota hai (lookahead-free — sirf signal
time tak ka data):

```
schemaVersion: 2
featureSnapshot: {                      // fv: 1 — signal-time features
  tier, superScore, regime,
  ctx: { dir, score, adx, atrPct, rsi, barsInTrend, exhausted, squeeze, bbWidthPct, er },
  trig: { dir, score, volRatio, bodyPct, rsi, overextended, pullbackReclaim, reversalRisk }
}
pWinClaimed           // pWinCalibrated ya winRatePct (jo available ho)
closedBarConfirmed    // barConfirmation se
signalAtOpenBar / signalAtCloseBar / signalStable   // v21.28 se
spreadBps, liquidityUSD, fundingBps8h, perpDataStatus, eventWindow
filtersFired[]        // har guard ka verdict (shadow bhi) — {guard, verdict, reason}
latencyMs             // row builtAt → record time
```

`hydrateMtfLedger` v1 rows ko backward-compatibly migrate karta hai
(missing → `null`, kabhi 0 nahi — "unknown" ≠ "zero").
