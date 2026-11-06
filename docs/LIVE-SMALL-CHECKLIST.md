# LIVE-SMALL CHECKLIST (Phase H2 / S3) — CoinDCX Futures Safety Tests

> **RULE: Live-arm se PEHLE ye 9 tests chahiye.** Har test ka result + raw
> response snippet (secrets REDACTED) is file me ya iske side-me save hota hai.
> `PRE_TP1_TRAIL` aur `EXIT_POLICY_V3` jaise flags **tab tak `shadow` rahenge**
> jab tak #1–#3 pass na hon (FLAG-HISTORY.md dekho).
>
> Size: MINIMUM viable quantity, 1 symbol (e.g. BTCUSDT perp), sabse chhota leverage.
> Har test ke baad: `flatten-all` (typed confirm) se position guarantee-clean.

---

## Test #1 — Stop dikh raha hai open-orders me?

- **Kya karna hai:** Ek live-small LONG arm karo (native SL/TP attached). Turant
  `GET /exchange/v1/derivatives/futures/orders` (open orders) poll karo.
- **PASS:** SL order open-orders list me visible, side=SELL, qty=entry qty, price=SL.
- **FAIL:** SL list me nahi → **PRE_TP1_TRAIL enforce FORBIDDEN** (G10).

Result: `_______________` · Raw snippet (redacted): `_______________`

## Test #2 — SL replace ya stack? (PRE_TP1_TRAIL ka core assumption)

- **Kya karna hai:** Existing SL ko naye (tighter) price pe modify/replace karo —
  bilkul waise jaise pre-TP1 trail karta hai.
- **PASS (REPLACE):** purana SL order gaya, naya SL aaya — net 1 SL order.
- **PASS (STACK):** dono SL orders rahenge — **phir trail logic ko
  cancel-then-place karna hoga** (yaqty-aware), warna duplicate reduce risk.
- **FAIL/AMBIGUOUS:** trail **enforce nahi hoga** — `shadow` only.

Result (replace/stack/fail): `_______________` · Raw: `_______________`

## Test #3 — Partial reduce verify (safeReduce live parity)

- **Kya karna hai:** Position ka ~50% reduce karo (TP1 partial jaisa). Read-back
  se position qty confirm karo.
- **PASS:** position qty exactly entryQty−reduceQty; koi extra/duplicate order nahi.
- **FAIL:** `liveTp1Partial` OFF hi rahega (G4 gate).

Result: `_______________` · Raw: `_______________`

## Test #4 — Already-flat pe reduce call (idempotency)

- **Kya karna hai:** Flat hone ke BAAD ek safeReduce call simulate karo (ya stale
  monitor tick).
- **PASS:** koi naya order nahi bana; clean "already flat" verdict.
- **FAIL:** 0-qty ya duplicate order attempt → reconciler fix hone tak live TP
  automation band.

Result: `_______________` · Raw: `_______________`

## Test #5 — Attached TP/SL cleanup on manual exit

- **Kya karna hai:** Manual market exit karo jab attached TP/SL pending hon.
- **PASS:** hygiene ne dono protective orders cancel kiye (phase-aware cleanup);
  open-orders empty.
- **FAIL:** orphan protective orders rahe → **PROTECTION MISSING alert** +
  `classifyOpenOrder` fix (H3) zaroori.

Result: `_______________` · Raw: `_______________`

## Test #6 — ENTRY-class vs PROTECTIVE-class classification (G12)

- **Kya karna hai:** Open orders dump karo; `classifyOpenOrder` ka verdict note karo —
  khaas kar plain LIMIT TP ka (kya wo ENTRY class me ja raha hai?).
- **PASS:** native TP/SL fingerprint (type/price/side fields) → PROTECTIVE class;
  **unknown → kept** (fail-closed).
- **FAIL:** TP ko ENTRY bola gaya → H3 fingerprint refine + fixtures add karo.

Result: `_______________` · Raw (TP order ka shape, redacted): `_______________`

## Test #7 — Double-click / duplicate arm (idempotency key)

- **Kya karna hai:** Ek hi signal par 2 baar turant arm-fire karo (double-submit).
- **PASS:** sirf 1 entry order (`tradeActionLog` idempotency `tradeId:action:seq`).

Result: `_______________` · Raw: `_______________`

## Test #8 — Arm blockers (risk caps)

- **Kya karna hai:** Daily-loss cap hit karke (ya caps=0 config test env me) arm
  attempt karo.
- **PASS:** entry block hua, blocker reason log hua, koi exchange call nahi hui.

Result: `_______________`

## Test #9 — Flatten-all (typed confirm)

- **Kya karna hai:** Live position + pending orders ke saath `flatten-all`.
- **PASS:** position closed, protective orders cancelled, journal/exchange sync
  (reconciler mismatch = 0).

Result: `_______________`

---

## H1 (S2) — Futures endpoints docs-verify

`[VERIFY-DOCS]` — CoinDCX official docs se ye confirm karo (constants + fixtures
`server/ai/futures.js` me):

| Endpoint | Status |
|----------|--------|
| List orders (open orders) | `_______________` |
| Cancel order (single) | `_______________` |
| Cancel-all / batch cancel | `_______________` |
| Positions endpoint | `_______________` |
| Rate-limit headers / caps | `_______________` |
| Pagination (page/length params) | `_______________` |

> Galat path ⇒ safe-fail already hai, par **order hygiene tab silently kaam
> nahi karega** — isliye ye verify mandatory hai pehle.

## Sign-off

- [ ] Test 1–9 results saved (is file me)
- [ ] H1 endpoint table filled
- [ ] `PRE_TP1_TRAIL` → `enforce` tabhi jab #1 + #2 pass (FLAG-HISTORY entry)
- [ ] `liveTp1Partial` → live tabhi jab #3 pass
- [ ] Operator: `_______________` · Date: `_______________`
