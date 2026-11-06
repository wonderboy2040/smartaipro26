# Deep Monitor — site localhost pe + direction accuracy + paper LONG/SHORT + SL-trail

## Context
User ask (Hinglish): *"site localhost pe run karo aur deep monitor karo — trade signals accurate directions pakka hai ya nahi, paper test karke long/short signals dekho accurately kaam kar rahe hai kya, aur smart intelligence SL-trail bhi dekho."*

This is a **runtime monitoring** task — no code changes planned unless the monitoring exposes a real defect (then fix + regression test). Report findings at the end.

**Current state (verified read-only):**
- Node server ALREADY UP on `:8080` (pid 11048, v21.35.2, `/api/ping` 200, `/health` ok, frontend `GET /` → 200, `dist/.build-version` == 21.35.2 — no STALE-BUILD).
- ml-service ALREADY UP on `:8100` (pid 7260, `/health` ok, `models_loaded: {hmm: true, signal: false}` — signal model absent is degraded-but-expected; in-process ensemble is authoritative).
- Auth for scripted calls: read `API_TOKEN` from `app/.env`, send as `Authorization: Bearer <token>` (verified: board endpoint returns 401 unauthenticated, 200 with Bearer — token saved to `app/.api-token` for the run).
- **Do NOT restart the server** — restarting would clear the open paper-trade state and the deep-monitor book we're about to exercise.

## Step 0 — Confirm site on localhost
- `curl http://127.0.0.1:8080/api/ping` (expect `pong:true`) and `http://127.0.0.1:8100/health` (expect `status:ok`). Both currently up; only re-boot (`cd app && npm start` / `cd app/ml-service && python -m uvicorn app.main:app --port 8100`) if a probe fails.

## Step 1 — Direction accuracy: "are signals pakka?"
Use the app's own ground-truth tooling (built exactly for the "sab signals opposite" complaint):
1. `GET /api/ai/direction-selftest` (public) — deterministic proof: rising candles → LONG/BUY, falling → SHORT/SELL, SL/target polarity, no silent-LONG on unknown side, mirror-shield. Expect `pass:true` (boot log showed 18/18).
2. `GET /api/ai/direction-live-certificate` — same cert but through the REAL data chain (CoinDCX candles). Expect `pass:true` (boot showed PASS, 6 chain).
3. Live board audit: `GET /api/ai/mtf-dual/board?market=INDIA&mode=INTRADAY` and `?market=CRYPTO` (Bearer auth). For every row check:
   - `directionCertificate.side === row.side` (no inversion),
   - `orderSide` mapping correct: LONG→buy, SHORT→sell (null `orderSide` = cert blocked → must pair with `autoEligible:false` — that's the v21.26.4 honesty gate, NOT an inversion),
   - `pakkaDirectionLabel` / verdict: CONFLICT rows must carry conflicts in the cert (board-ensemble-opposite / SVA-FLIP / counterTrend / counterHtf / supply-demand) and `autoEligible:false`,
   - `ensembleSignalAvailable === false` rows are ALWAYS blocked (no gate relaxed).
   - Verdict counts: N cert-OK-and-consistent vs M conflict-blocked, ZERO genuine side↔orderSide inversions.

## Step 2 — Paper test: LONG + SHORT signals
1. Read `GET /api/intraday-paper` (Bearer) — baseline open trades (known: #32 AVAX LONG CRYPTO-INR ₹865.16, #33 DOGE SHORT ₹7.65, #34 BTC LONG FUTURES-USDT 78203.5, #35 SOL SHORT 94.42, all ccy-mapped correctly since 21.35.2).
2. Signal-driven paper: from the board pick **one ARMED LONG row and one ARMED SHORT row** with tradeable levels; `POST /api/ai/mtf-dual/paper { symbol, market, side, mode:"intraday", hold:45 }` (server re-derives the row + cert). Success = `ok:true` with `trade`, `orderSide`, `directionCertificate`. A `409 blocked` (trigger pending / pakka-not-verified / counter-HTF) is an **honest gate pass**, not a failure — record it.
3. Deterministic paper (both sides guaranteed): `POST /api/intraday-paper` with live-anchored levels from `GET /api/crypto-prices`:
   - LONG: entry = live, SL ~2.5% below, T1 ~2.5% above, T2 ~5% above (SL<entry<T1<T2).
   - SHORT: entry = live, SL ~2.5% above, T1 below, T2 lower (SL>entry>T1>T2).
   - Then **inversion probes**: inverted LONG (SL above entry) and inverted SHORT (SL below entry) → both must return `error` and create NO trade (level-contract guard).
4. P&L polarity check: `GET /api/intraday-paper` → for each new trade verify `unrealizedPnl` sign matches direction vs `lastPrice` (LONG up = +, SHORT up = −), and the 21.35.2 `ccy` value (CRYPTO→INR, FUTURES→USDT, GLOBALFUTURES→USDC).
5. Keep the two new paper trades OPEN during Step 3; **clean up afterwards** via `POST /api/intraday-paper/close {id}` (close only the ones we opened; leave pre-existing user trades #32–35 alone unless close is needed for trail observation).

## Step 3 — Smart-intelligence SL-trail
1. **Deterministic mechanism** (no market risk): `node scripts/smart-trail-replay.mjs 5000 7` from `app/` — feeds synthetic price paths through the REAL `evaluateActiveTradeDeepMonitor` under `SMART_TRAIL_V2` off vs enforce. Read the per-tape summaries (neutral / direction-right / adverse choppy): sanity checks — v2 must not trail-worse than v1 on direction-right tape; adverse chopper tape shows bounded loss; `capture%` reflects exit/peak on ≥1.5R winners.
2. **Direction-polarity invariant**: quick node probe of `evaluateActiveTradeDeepMonitor` (import from `server/ai/mtfAutoLink.js`):
   - LONG: LTP rising → `trailedStopLoss` ratchets UP only (≥ initial SL); LTP falling back through the trailed SL → `shouldExitDefensiveSl` / exit reason;
   - SHORT: LTP falling → SL ratchets DOWN only; rally back through SL → defensive exit;
   - unknown/missing side → `directionBlocked:true` (v21.25.0 no-silent-LONG guard), no trail;
   - opposite-side board row fired while position open → `reversalDetected` (fee-safe reversal book when fees covered).
3. **Live tie-in**: with the Step-2 paper trades open, re-poll `GET /api/intraday-paper` over ~30–60s (watcher ticks) and confirm the trail fields move in the favorable direction only (`trailedStopLoss`/peak tracking, no widening), cross-checking `GET /api/ai/mtf-dual/board` deep-monitor fields (`trailedStopLoss`, `stageLabel`).

## Step 4 — Report
Hinglish summary: (a) directions pakka? — selftest/live-cert results + board zero-inversion counts; (b) paper LONG/SHORT — what opened, level-integrity + P&L-polarity checks, inversion probes rejected, honest 409 blocks if any; (c) SL-trail — replay stats + polarity invariants + live behavior; (d) cleanup done; (e) any defect found → fixed with a regression test + `npx vitest run <file>` green.

## Verification / "done" means
- Both probes green (:8080 ping, :8100 health), site confirmed running on localhost.
- Direction audit: 0 genuine side/orderSide inversions; conflict rows honestly blocked.
- Paper: one LONG + one SHORT opened & verified (geometry + P&L sign + ccy), inverted probes rejected, test trades closed.
- Trail: replay PASS + tightening invariant holds for both sides + defensive/reversal/blocked probes correct.
- Findings delivered to user.

## Key files (read-mostly)
- `server/ai/directionCertificate.js` — cert-v1 (side/orderSide/conflicts/geometry)
- `server/ai/mtfDualBoard.js` — board rows + honesty gate (`ensembleSignalAvailable`)
- `server/ai/mtfAutoLink.js` — `evaluateActiveTradeDeepMonitor` (deep monitor + trail)
- `server/ai/smartTrail.js` — smart-trail plan (v2 ratchet + rolling TP2)
- `server/intraday/paperTrading.js` — `openPaperTrade` level-contract + ccy domain fix
- `server/ai/routes.js` — `/api/ai/mtf-board` / `mtf-dual/board` / `mtf-dual/paper`
- `server/intraday/routes.js` — `/api/intraday-paper` (+`/close`)
- `scripts/smart-trail-replay.mjs` — synthetic trail harness
