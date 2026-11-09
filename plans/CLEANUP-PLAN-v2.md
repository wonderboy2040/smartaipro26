# SmartAI Pro v21.35.7 — Cleanup Plan v2 (CODE-VERIFIED)

> **ARCHIVED plan.** The AI-lane section below predates the v22.0 FreeLLMAPI
> migration; its "local engine trio" notes now refer to the FreeLLMAPI AI
> guard (`aiGuard`). Current architecture: `docs/CHANGES.md` v22.0.0.

**Base:** your diagram-only `CLEANUP` plan (Sections 1–8).
**What I added:** I have code access (I built the blueprint from it), so I closed the "verify karo" gap on every load-bearing claim. Section 0 below is the **verified delta** — findings that flipped from *Medium/Low confidence* to **CONFIRMED / REFUTED with file:line**. The rest of your plan stands; I've re-prioritized it using the evidence.

> Rule unchanged: **nothing here touched live config, deleted a file, or forced a trade.** Verification only. `mtf-auto-config.json` still shows `enabled:false` — the R-01 landmine is **real but dormant** until you flip it on.

---

## 0. VERIFIED AGAINST CODE — the delta

### V-1 · R-01 live floor → **CONFIRMED, and dormant**
`server/data/mtf-auto-config.json` on disk, read this session:

```
universalLiveFloor = 50      ← WATCH tier, real-money trigger when enabled
universalTradeAll  = true
multiTradeMode     = true
maxConcurrentTrades= 8
executionMode      = live
enabled            = false   ← dormant right now
```
Your "CRITICAL" call is correct: floor 50 + `tradeAll` + 8 concurrent + `live` **would** open real WATCH-tier positions the moment `enabled` becomes true. **Action unchanged (P2.1)** — but note the safety net is *currently effective* only because `enabled=false`. The moment you re-arm live for the "highest profit" run, P2.1 **must** land first.

### V-2 · R-04 secrets → **CONFIRMED, worse than you feared**
`server/data/mcp-coindcx.json` on disk, keys present:

```
apiKey  (48 chars)   — plaintext, NOT masked
secret  (64 chars)   — plaintext, NOT masked
+ connectedAt, lastSyncAt, lastError
```
Two refinements to your finding:
- **This folder is NOT a git repo and has NO `.gitignore`.** So the leak vector is *not* "committed to a remote." It's: plaintext secrets on disk that a user backup / OneDrive / "copy the SmartAI folder" would carry verbatim. **Fix = P2.5 as you wrote (keys → `.env` only; `mcp-coindcx.json` keeps non-secret metadata).**
- **The code even re-persists them:** `_executeMtfDualLiveOrderInner` (futures.js ~2690) writes `saveJSON('mcp-coindcx.json', { apiKey, secret, … })` on first live order. So P2.5 must also stop that write, or the keys re-appear in the plaintext file after the first trade.

### V-3 · R-03 / D-06 execution paths → **REFUTED as "bypass", CONFIRMED as "duplication"**
The plan assumed `executeSignal` was *the* primitive to funnel into, and worried "gates may be bypassed." Reality:

- **`executeSignal` is SPOT-ONLY** (`${symbol}INR`, coindcxOrders.js:539) and is *already* full-stop gated (v21.23.8 spot-full-stop default-on). Not the futures path at all.
- The **auto live path uses a 5th primitive: `executeMtfDualLiveOrder`** (futures.js:2624), reached via `routes.js:1794 liveExecute → executeMtfDualLiveOrder`. This is what placed the LINK/BNB/WLD trades this session.
- **It already enforces a strong ladder on its own:** order idempotency (R1, `claimAction`/`finishAction`), a 1-session-1-trade in-flight lock, `killSwitch`, credential check. **So there is no gate-free back door into live CoinDCX futures.** Your R-03 "gates sirf mtfAutoLink par lagte hain — manual/telegram bypass kar sakte hain" is **overstated.**
- What actually *is* true: **5 live-order primitives, each with its own copy of a gate ladder** (`executeSignal`, `executeFuturesSignal`, `executeGlobalSignal`, `executeMtfDualLiveOrder`, `executeIndiaSignal`). The risk is **divergence** (two ladders drift, one gains a kill the other misses), not "any path skips all checks."
- **The real, narrower gap you should target:** the three **entry-quality gates** (`entryGates.js` MC-odds / breakout / late-wave) and local engine direction-verification are enforced **upstream in `mtfAutoLink` candidate selection**, *not inside* `executeMtfDualLiveOrder`. So a manual/telegram call that reaches `executeMtfDualLiveOrder` directly **skips the entry gates.** That's the actual P2.3/P2.4 surface.

**Net:** P2.3's goal (single `placeLiveOrder` choke point) is still worth doing, but framed as *"consolidate 5 primitives + move entry-gates into the shared primitive"* — not *"stop a bypass that doesn't exist."*

### V-4 · R-02 direction-verification not in commit → **HALF-REFUTED**
- The **deterministic** direction certificate (`directionCertificate.js` → `buildDirectionCertificate`) **IS a hard commit-block** in the auto path: `mtfAutoLink.js:1185,1200` — `if (!directionCertificate.ok)` → no action, polarity-invert hard-block. So "direction-verification advisory, wrong-direction trade not stopped" is **wrong for the deterministic cert** — it blocks.
- The **local engine trio** is the genuinely-advisory part (fire-and-forget, 30s cache, does not gate the commit) — your instinct there is **correct** (D-04/U-11/P3.9 stand).
- **P2.4 therefore narrows to:** keep the deterministic cert blocking (it already is); decide what to do with the local engine trio only. Don't rebuild a blocking gate that already exists.

### V-5 · U-07 ml-service "not in blueprint, so dead" → **REFUTED**
`ml-service` / onnx is referenced across `ensemble.js`, `expertPicks.js`, `expertMode.js`, `mlHealth.js`, `models.js`, `outcomeHarvester.js`, `ramGovernor.js`. `expertPicks.js` is a live 10-model engine, not dead code. **It is wired; the question is only whether the *process* is currently running** — `mlHealth.js` probes it. **Do not delete expertPicks on a diagram guess.** (Your own "Low/Medium — verify" label was the right one; the code refutes the "silently empty" worry. Keep it pending a P1 process audit.)

### V-6 · D-01 / U-05 Telegram "2 paths both active" → **DESIGN ALREADY EXCLUDES CONFLICT**
`telegram-bot/bot.mjs` is **long-polling, zero-dependency**, and on startup it calls `tg.deleteWebhook()` (bot.mjs:109,200) specifically to prevent the 409 polling/webhook conflict. The server-side `telegram/webhook.js` coexists but is neutralized whenever the polling bot runs. **Severity downgraded:** it's not "two ingestions live at once" — it's "two implementations, one wins." P3.1 simplifies to *pick the winner (polling for local Windows, webhook for public HTTPS) and delete the other*, exactly as you had.

### V-7 · India broker breadth (correction to D-06)
`server/ai/dhan.js` (284 lines), `growwApi.js`, `indiaOrders.js`, `executeIndiaSignal` all exist. Your "5+ CoinDCX paths" is actually "5+ paths across **CoinDCX spot + CoinDCX futures + India (Dhan/Groww)**." Consolidation scope is bigger than one exchange. (No action change; just correct the diagram's under-representation.)

---

## 1. Corrected priority (from the evidence)

Your original order was: *P2 safety → P1 instrument → P3 dedupe.* With the code facts, sharpen it:

1. **P2.1 live-floor schema (V-1)** — hard gate before ANY re-arm of `enabled:true`. Highest-leverage single change.
2. **P2.5 secrets → `.env` only (V-2)** — and stop the `saveJSON('mcp-coindcx.json',{apiKey,secret})` re-persist in futures.js.
3. **P2.3/P2.4 execution consolidation (V-3, V-4)** — now scoped precisely: (a) consolidate the 5 live primitives onto one choke point, (b) move the 3 entry-gates + deterministic cert check *into* that choke point so manual/telegram/agent calls can't skip them, (c) drop the local engine trio from the commit path (keep advisory or remove per P3.9).
4. **P1 instrumentation** — you need the 7-day route hits *before* touching U-01/U-03/U-04/U-08/U-09. But **skip V-5/V-7 in the delete list** until the process audit says otherwise.
5. **P3 dedupe** — with D-01 downgraded and D-06 reframed, the safe-quick wins are D-02 (paper), D-09/D-10 (journals/config), D-11 (backtest), D-12 (SSE).

---

## 2. Executable artifacts (sharpened from your Section 4/5)

Your `route-callers.mjs` and `routeUsage.js` are good and correct as written — keep them. Two additions the code check revealed you'll want:

### A. Execution-surface audit (one grep gives you the consolidation map)
```bash
# every module that can place a real order — the D-06/V-3 target list
grep -rn "executeSignal\|executeFuturesSignal\|executeGlobalSignal\|executeMtfDualLiveOrder\|executeIndiaSignal" \
  server --include=*.js | grep -viE "export|function .*\(opts|/\*\*|//|reject\("
# plaintext-secret writers (V-2)
grep -rn "saveJSON('mcp-coindcx.json'\|apiKey.*secret" server --include=*.js
```

### B. Entry-gate placement proof (the V-3 gap, one test each)
For each of the 5 primitives, assert: kill-switch blocks live, an `entryGates` fail blocks, a `directionCertificate.ok===false` blocks. Any primitive that can place a live order *without* those three = the real defect to close.

### C. Golden snapshot (your P0 item 5) — concrete
Fixed-candle fixtures for all 19 CRYPTO symbols → record `{score, direction, tier, entryGates[3], directionCertificate.ok, wouldCommit}` per symbol **before** touching anything. After P2: gate/floor deltas allowed (that's the intended change) but **signal/score/direction must be byte-identical**. After P3: everything byte-identical.

---

## 3. What I would *not* touch yet (evidence says "leave it")

- **`expertPicks` / `ml-service`** (V-5) — wired, possibly live. Audit, don't delete.
- **The deterministic direction certificate** (V-4) — it's already a correct hard gate; don't rebuild it.
- **`bot.mjs` polling + `deleteWebhook`** (V-6) — already conflict-safe; just pick a winner, don't rush.
- **`enabled:false` config** — leave exactly as-is through P0–P3. Only P2.1 changes its *validation*, not its *value*.

---

## 4. Suggested new Section 2.E — Risk (code-verified, replaces your Section 2.C rows)

| ID | Verified finding | Status |
|---|---|---|
| R-01 | floor 50 + tradeAll + 8 conc + `executionMode:live`, `enabled:false` → live WATCH-tier money on re-arm | **CONFIRMED / dormant** |
| R-02 | deterministic direction cert **already hard-blocks** commit (mtfAutoLink:1185/1200); only local engine trio is advisory | **HALF-REFUTED** |
| R-03 | no gate-free live path; 5 primitives each carry kill-switch/idempotency; real gap = entry-gates not in the shared primitive | **REFRAMED** |
| R-04 | `mcp-coindcx.json` plaintext 48+64-char key/secret on disk; folder is **not git, no .gitignore**; code re-persists keys after first trade | **CONFIRMED, worse** |
| R-06 | JSON concurrency (3s trail + 8 trades + writers) — your `writeJsonAtomic` fix stands; add it to `mcp-coindcx.json` too | **CONFIRMED** |

Keep your R-05 (runtime `npm install` in supervisor), R-07 (supervision gap: bot + local engine + ml-service unsupervised), R-08 (version-pinned cert must re-pin on 21.36).

---

## 5. Decisions list — two items the code now answers for you

Your Section 7 had 8 open questions. Code resolves two:

- **Q6 `tapetide`** and **Q3 "does Bot Lab use US data"** → still need your input (no code answer).
- **Q5 local engine trio** → code confirms it's *already* advisory (V-4), so the real choice is only *"keep advisory vs remove."* Removing is cleaner on a 16GB host; keep only if shadow data shows it changes outcomes.
- **Q1 live floor** → code confirms current = 50 (V-1). If you say "no live WATCH trades," P2.1 floors it at 65 (ACTION) as you suggested; the schema will *enforce* it.

---

*Deliverable written to `plans/CLEANUP-PLAN-v2.md`. Nothing was restarted, no live config changed, no file deleted. Trading server still stopped as you left it.*
