// ============================================================
// test/signalLifecycleV21330.test.ts — v21.33.0 PHASE D5/D6 TESTS
// ------------------------------------------------------------
//   • D5  lifecycle: CANDIDATE → CONFIRMED → ARMED → FIRED → EXPIRED
//   • D5  anti-flicker hysteresis: margin (+8) AND dwell (≥2 bars)
//   • D5  post-stop-out cooldown (same symbol+side)
//   • D6  rollingCorrelation + evaluateSignalCluster (best-in-cluster)
//   • F-g entryDedupKey + claimEntryDedup (idempotent claim)
// ============================================================
import { describe, it, expect } from 'vitest';
import {
  advanceLifecycle, blankLifecycle, LIFECYCLE_DEFAULTS,
  rollingCorrelation, evaluateSignalCluster, entryDedupKey, claimEntryDedup,
  entryCooldownActive,
} from '../server/ai/signalLifecycle.js';

const NOW = 1_700_000_000_000;

describe('v21.33.0 D5 — lifecycle state machine', () => {
  it('new signal → CANDIDATE', () => {
    const { record } = advanceLifecycle(null, { symbol: 'BTC', side: 'LONG', score: 70, now: NOW });
    expect(record.state).toBe('CANDIDATE');
    expect(record.side).toBe('LONG');
  });
  it('closed-bar confirm → CONFIRMED (score floor meet)', () => {
    let { record } = advanceLifecycle(null, { symbol: 'BTC', side: 'LONG', score: 70, now: NOW });
    record = advanceLifecycle(record, { symbol: 'BTC', side: 'LONG', score: 70, closedBarConfirmed: true, now: NOW + 1000 }).record;
    expect(record.state).toBe('CONFIRMED');
  });
  it('trigger fired → ARMED → FIRED', () => {
    let r = advanceLifecycle(null, { symbol: 'BTC', side: 'LONG', score: 70, now: NOW }).record;
    r = advanceLifecycle(r, { side: 'LONG', score: 70, closedBarConfirmed: true, now: NOW + 1 }).record;
    r = advanceLifecycle(r, { side: 'LONG', score: 70, triggerFired: true, now: NOW + 2 }).record;
    expect(r.state).toBe('ARMED');
    r = advanceLifecycle(r, { side: 'LONG', score: 70, fired: true, now: NOW + 3 }).record;
    expect(r.state).toBe('FIRED');
    expect(r.firedAt).toBe(NOW + 3);
  });
  it('FIRED terminal — STOP_OUT cooldown arm hota hai', () => {
    let r = advanceLifecycle(null, { symbol: 'BTC', side: 'LONG', score: 70, now: NOW, barTime: 1 }).record;
    r = advanceLifecycle(r, { side: 'LONG', score: 70, closedBarConfirmed: true, now: NOW + 1 }).record;
    r = advanceLifecycle(r, { side: 'LONG', score: 70, triggerFired: true, now: NOW + 2 }).record;
    r = advanceLifecycle(r, { side: 'LONG', score: 70, fired: true, now: NOW + 3 }).record;
    expect(r.state).toBe('FIRED');
    const out = advanceLifecycle(r, { side: 'LONG', stopOut: true, now: NOW + 4 });
    expect(out.transition).toBe('STOP_OUT');
    expect(out.record.cooldownUntil).toBe(NOW + 4 + LIFECYCLE_DEFAULTS.cooldownMin * 60_000);
  });
  it('cooldown active → FIRED blocked, state ARMED pe revert', () => {
    // re-arm cycle after a stop-out: naya candidate same side
    let r = blankLifecycle({ symbol: 'BTC', side: 'LONG', now: NOW + 2 });
    r = advanceLifecycle(r, { side: 'LONG', score: 70, closedBarConfirmed: true, now: NOW + 3 }).record;
    r = advanceLifecycle(r, { side: 'LONG', score: 70, triggerFired: true, now: NOW + 4 }).record;
    r.cooldownUntil = NOW + 10_000; // simulate active cooldown
    const out = advanceLifecycle(r, { side: 'LONG', score: 70, fired: true, now: NOW + 5 });
    expect(out.transition).toBe('FIRED_BLOCKED_BY_COOLDOWN');
    expect(out.record.state).toBe('ARMED');
  });
  // v21.35.0 [A5]: side OMIT ('') ki fire-tick pehle cooldown bypass kar
  // leti thi (side==null dead code tha). Ab missing side = record ki side
  // (fail-closed). Genuinely-opposite side free hai.
  it('v21.35.0 [A5]: side-OMITTED fire tick cooldown se BLOCK (fail-closed)', () => {
    let r = blankLifecycle({ symbol: 'BTC', side: 'LONG', now: NOW + 2 });
    r = advanceLifecycle(r, { side: 'LONG', score: 70, closedBarConfirmed: true, now: NOW + 3 }).record;
    r = advanceLifecycle(r, { side: 'LONG', score: 70, triggerFired: true, now: NOW + 4 }).record;
    r.cooldownUntil = NOW + 10_000;
    r.stopOutSide = 'LONG'; // stopped-out side record ki side ke barabar
    const out = advanceLifecycle(r, { score: 70, fired: true, now: NOW + 5 }); // side nahi bheja
    expect(out.transition).toBe('FIRED_BLOCKED_BY_COOLDOWN');
    expect(out.record.state).toBe('ARMED');
  });
  it('v21.35.0 [A5]: genuinely-OPPOSITE side fire cooldown se free (semantics preserved)', () => {
    // record ab SHORT hai; purana stop-out LONG par hua tha — hedge entry free
    let r = blankLifecycle({ symbol: 'BTC', side: 'SHORT', now: NOW + 2 });
    r = advanceLifecycle(r, { side: 'SHORT', score: 70, closedBarConfirmed: true, now: NOW + 3 }).record;
    r = advanceLifecycle(r, { side: 'SHORT', score: 70, triggerFired: true, now: NOW + 4 }).record;
    r.cooldownUntil = NOW + 10_000;
    r.stopOutSide = 'LONG';
    const out = advanceLifecycle(r, { side: 'SHORT', score: 70, fired: true, now: NOW + 5 });
    expect(out.transition).toBe('FIRED'); // opposite-side entry cooldown me bhi allowed
    expect(out.record.state).toBe('FIRED');
  });
});

describe('v21.33.0 D5 — anti-flicker hysteresis', () => {
  it('flip bina margin ke SUPPRESS hota hai (score +8 chahiye)', () => {
    let r = advanceLifecycle(null, { symbol: 'BTC', side: 'LONG', score: 80, now: NOW }).record;
    const out = advanceLifecycle(r, { symbol: 'BTC', side: 'SHORT', score: 83, now: NOW + 1 });
    expect(out.wouldFlip).toBe(true);
    expect(out.flipAccepted).toBe(false);
    expect(out.transition).toBe('FLIP_SUPPRESSED');
    expect(out.record.side).toBe('LONG'); // side preserved — flicker blocked
  });
  it('margin + dwell dono meet → flip ACCEPT, ladder reset CANDIDATE', () => {
    let r = advanceLifecycle(null, { symbol: 'BTC', side: 'LONG', score: 80, now: NOW, barTime: 1000 }).record;
    r = advanceLifecycle(r, { side: 'LONG', score: 80, barTime: 2000, now: NOW + 1 }).record; // dwell 1
    r = advanceLifecycle(r, { side: 'LONG', score: 80, barTime: 3000, now: NOW + 2 }).record; // dwell 2
    const out = advanceLifecycle(r, { side: 'SHORT', score: 90, barTime: 4000, now: NOW + 3 });
    expect(out.flipAccepted).toBe(true);
    expect(out.record.side).toBe('SHORT');
    expect(out.record.state).toBe('CANDIDATE');
    expect(out.record.flips).toBe(1);
  });
  it('dwell satisfy par margin missing → phir bhi suppress', () => {
    let r = advanceLifecycle(null, { symbol: 'BTC', side: 'LONG', score: 80, now: NOW, barTime: 1000 }).record;
    r = advanceLifecycle(r, { side: 'LONG', score: 80, barTime: 2000, now: NOW + 1 }).record;
    r = advanceLifecycle(r, { side: 'LONG', score: 80, barTime: 3000, now: NOW + 2 }).record;
    const out = advanceLifecycle(r, { side: 'SHORT', score: 85, now: NOW + 3 });
    expect(out.flipAccepted).toBe(false);
  });
  // v21.35.0 [A6]: score unknown (ya rec.score unknown) → flip SUPPRESS.
  // Pehle marginOk=true default tha — dwell akela bina evidence flip
  // accept kar leta tha. Fail-closed: unknown evidence = suppress.
  it('v21.35.0 [A6]: missing score flip SUPPRESS hota hai (dwell satisfy bhi ho)', () => {
    let r = advanceLifecycle(null, { symbol: 'BTC', side: 'LONG', score: 80, now: NOW, barTime: 1000 }).record;
    r = advanceLifecycle(r, { side: 'LONG', score: 80, barTime: 2000, now: NOW + 1 }).record;
    r = advanceLifecycle(r, { side: 'LONG', score: 80, barTime: 3000, now: NOW + 2 }).record;
    const out = advanceLifecycle(r, { side: 'SHORT', now: NOW + 3 }); // score OMIT
    expect(out.wouldFlip).toBe(true);
    expect(out.flipAccepted).toBe(false);
    expect(out.transition).toBe('FLIP_SUPPRESSED');
    expect(out.record.side).toBe('LONG');
    // rec.score unknown (blank record) + naya score diya → wahi suppress
    let r2 = blankLifecycle({ symbol: 'ETH', side: 'LONG', now: NOW });
    r2.dwellBars = 5; // dwell satisfy
    const out2 = advanceLifecycle(r2, { side: 'SHORT', score: 95, now: NOW + 1 });
    expect(out2.flipAccepted).toBe(false);
    expect(out2.transition).toBe('FLIP_SUPPRESSED');
  });
  it('EXPIRED after horizon bars bina fire ke', () => {
    let r = advanceLifecycle(null, { symbol: 'BTC', side: 'LONG', score: 70, now: NOW, barTime: 1 }).record;
    r = advanceLifecycle(r, { side: 'LONG', score: 70, closedBarConfirmed: true, now: NOW + 1 }).record; // CONFIRMED
    r = advanceLifecycle(r, { side: 'LONG', score: 70, triggerFired: true, now: NOW + 2 }).record;        // ARMED
    expect(r.state).toBe('ARMED');
    r.seenBars = LIFECYCLE_DEFAULTS.expireBars; // fast-forward horizon
    const out = advanceLifecycle(r, { side: 'LONG', score: 70, now: NOW + 3 });
    expect(out.record.state).toBe('EXPIRED');
  });
  // v21.35.0 [A7]: caller barTime nahi deta (price-lane ticks) to seenBars
  // kabhi increment nahi hota tha — immortal CANDIDATE/CONFIRMED/ARMED.
  // Wall-clock fallback: enteredStateAt se expireBars·tfMs (opts.now +
  // opts.tfMs inject karke deterministic).
  it('v21.35.0 [A7]: barTime-guma ticks wall-clock expiry se age out hote hain', () => {
    const tfMs = 60_000; // 1m bars (test injection)
    const horizon = LIFECYCLE_DEFAULTS.expireBars * tfMs;
    let r = advanceLifecycle(null, { symbol: 'BTC', side: 'LONG', score: 70, now: NOW }).record;
    expect(r.seenBars).toBe(0); // barTime kabhi nahi diya → seenBars 0
    const before = advanceLifecycle(r, { side: 'LONG', score: 70 }, { now: NOW + horizon - 1, tfMs });
    expect(before.record.state).toBe('CANDIDATE'); // horizon ke andar nahi
    const at = advanceLifecycle(r, { side: 'LONG', score: 70 }, { now: NOW + horizon, tfMs });
    expect(at.transition).toBe('EXPIRED');
    expect(at.record.state).toBe('EXPIRED');
    expect(at.record.expiredAt).toBe(NOW + horizon);
  });
  it('v21.35.0 [A7]: barTime diya ho to wall-clock branch skip (seenBars hi maayne)', () => {
    const tfMs = 60_000;
    const horizon = LIFECYCLE_DEFAULTS.expireBars * tfMs;
    let r = advanceLifecycle(null, { symbol: 'BTC', side: 'LONG', score: 70, now: NOW, barTime: 1 }).record;
    // wall-clock bohot paar, par seenBars 0 aur barTime present → no expiry
    const out = advanceLifecycle(r, { side: 'LONG', score: 70, barTime: 2 }, { now: NOW + horizon * 10, tfMs });
    expect(out.record.state).toBe('CANDIDATE');
  });
});

describe('v21.33.0 D6 — cluster + rolling correlation', () => {
  const upA = Array.from({ length: 80 }, (_, i) => 100 + i);
  const upB = Array.from({ length: 80 }, (_, i) => 50 + i * 0.5);
  // anti-phase alternating returns → genuinely negative correlation
  const antiA = Array.from({ length: 80 }, (_, i) => 100 + (i % 2 === 0 ? 1 : -1));
  const antiB = Array.from({ length: 80 }, (_, i) => 100 + (i % 2 === 0 ? -1 : 1));
  it('identical direction series → corr ~ 1', () => {
    expect(rollingCorrelation(upA, upB, 60)).toBeGreaterThan(0.95);
  });
  it('anti-phase series → corr ~ -1', () => {
    expect(rollingCorrelation(antiA, antiB, 60)).toBeLessThan(-0.95);
  });
  it('short series → null', () => {
    expect(rollingCorrelation([1, 2], [2, 1], 60)).toBeNull();
  });
  it('static cluster: SOL vs AVAX same ALT_L1 cluster', () => {
    const cl = evaluateSignalCluster({
      candidate: { symbol: 'SOLUSDT', side: 'LONG', score: 80 },
      others: [{ symbol: 'AVAXUSDT', side: 'LONG', score: 75 }],
    });
    expect(cl.cluster).toBe('ALT_L1');
    expect(cl.sameCluster.length).toBe(1);
    expect(cl.bestInCluster).toBe(true); // candidate score 80 > 75
  });
  it('rolling corr ≥ 0.8 → dynamically same cluster', () => {
    const cl = evaluateSignalCluster({
      candidate: { symbol: 'XYZ', side: 'LONG', score: 80 },
      others: [{ symbol: 'ABC', side: 'LONG', score: 70, closes: upB }],
      closesBySymbol: { XYZ: upA, ABC: upB },
    });
    expect(cl.sameCluster.length).toBe(1);
    expect(cl.sameCluster[0].corr).toBeGreaterThan(0.8);
  });
  it('maxPerCluster reach + candidate NOT best → wouldBlock', () => {
    const cl = evaluateSignalCluster({
      candidate: { symbol: 'SOLUSDT', side: 'LONG', score: 70 },
      others: [
        { symbol: 'AVAXUSDT', side: 'LONG', score: 75 },
        { symbol: 'DOTUSDT', side: 'LONG', score: 72 },
      ],
      maxPerCluster: 2,
    });
    expect(cl.count).toBe(2);
    expect(cl.bestInCluster).toBe(false);
    expect(cl.wouldBlock).toBe(true);
  });
  // v21.35.0 [A8]: OTHER:<prefix> buckets (unmapped symbols) STATIC-same
  // nahi hain — MOONUSDT/MOONBIRDSUSDT dono 'OTHER:MOO' milte the bina
  // kisi correlation evidence ke. Sirf dynamic corr >= threshold hi
  // same-cluster bana sakta hai.
  it('v21.35.0 [A8]: OTHER:MOO bucket static-same NAHI (zero evidence)', () => {
    const cl = evaluateSignalCluster({
      candidate: { symbol: 'MOONUSDT', side: 'LONG', score: 80 },
      others: [{ symbol: 'MOONBIRDSUSDT', side: 'LONG', score: 75 }],
      maxPerCluster: 1,
    });
    expect(cl.cluster).toBe('OTHER:MOO');
    expect(cl.sameCluster.length).toBe(0);
    expect(cl.count).toBe(0);
    expect(cl.wouldBlock).toBe(false);
  });
  it('v21.35.0 [A8]: OTHER bucket dynamic corr ≥ 0.8 se hi same-cluster ban sakta hai', () => {
    const cl = evaluateSignalCluster({
      candidate: { symbol: 'MOONUSDT', side: 'LONG', score: 80 },
      others: [{ symbol: 'MOONBIRDSUSDT', side: 'LONG', score: 70 }],
      closesBySymbol: { MOONUSDT: upA, MOONBIRDSUSDT: upB },
    });
    expect(cl.sameCluster.length).toBe(1);
    expect(cl.sameCluster[0].static).toBe(false); // dynamic corr se aaya
    expect(cl.sameCluster[0].corr).toBeGreaterThan(0.8);
  });
  // v21.35.0 [A8]: hedges concentration nahi hain — cap sirf SAME-side
  // others ginte hain; best-in-cluster logic sab par unchanged chalta hai.
  it('v21.35.0 [A8]: opposite-side (hedge) others cluster cap me COUNT nahi hote', () => {
    const cl = evaluateSignalCluster({
      candidate: { symbol: 'SOLUSDT', side: 'LONG', score: 70 },
      others: [
        { symbol: 'AVAXUSDT', side: 'SHORT', score: 95 }, // hedge — high score bhi
        { symbol: 'DOTUSDT', side: 'SHORT', score: 90 },   // hedge
      ],
      maxPerCluster: 2,
    });
    expect(cl.sameCluster.length).toBe(2);      // sab cluster me hain (best-in-cluster ke liye)
    expect(cl.bestInCluster).toBe(false);       // best logic unchanged — SHORT 95 jeeta
    expect(cl.count).toBe(0);                   // par concentration cap me hedge count nahi
    expect(cl.wouldBlock).toBe(false);
  });
  it('v21.35.0 [A8]: mixed others — sirf same-side wale cap ke against ginte hain', () => {
    const cl = evaluateSignalCluster({
      candidate: { symbol: 'SOLUSDT', side: 'LONG', score: 70 },
      others: [
        { symbol: 'AVAXUSDT', side: 'LONG', score: 75 },
        { symbol: 'DOTUSDT', side: 'SHORT', score: 95 },
        { symbol: 'LINKUSDT', side: 'LONG', score: 72 },
      ],
      maxPerCluster: 2,
    });
    expect(cl.count).toBe(2); // AVAX + LINK (LONG); DOT hedge — nahi gira
    expect(cl.wouldBlock).toBe(true); // candidate 70 best nahi (75 jeeta)
  });
});

describe('v21.33.0 F-g — entry dedup', () => {
  it('key format: market:SYMBOL:SIDE:barTime', () => {
    expect(entryDedupKey({ symbol: 'btcusdt', side: 'long', barTime: 12345, market: 'crypto' }))
      .toBe('CRYPTO:BTCUSDT:LONG:12345');
  });
  it('invalid side / missing barTime → null key (fail-open)', () => {
    expect(entryDedupKey({ symbol: 'BTC', side: 'FLAT', barTime: 1 })).toBeNull();
    expect(entryDedupKey({ symbol: 'BTC', side: 'LONG', barTime: null })).toBeNull();
  });
  it('claim idempotent: pehla true, dobara false', () => {
    const store = new Set();
    store._ordered = [];
    const k = 'CRYPTO:BTC:LONG:123';
    expect(claimEntryDedup(store, k)).toBe(true);
    expect(claimEntryDedup(store, k)).toBe(false);
    expect(store.has(k)).toBe(true);
  });
  it('different barTime → alag key, dono claim ho sakte hain', () => {
    const store = new Set();
    store._ordered = [];
    expect(claimEntryDedup(store, 'CRYPTO:BTC:LONG:123')).toBe(true);
    expect(claimEntryDedup(store, 'CRYPTO:BTC:LONG:124')).toBe(true);
  });
  it('entryCooldownActive window math', () => {
    const stopOutAt = NOW;
    expect(entryCooldownActive({ symbol: 'BTC', side: 'LONG', stopOutAt, cooldownMin: 20, now: NOW + 19 * 60_000 })).toBe(true);
    expect(entryCooldownActive({ symbol: 'BTC', side: 'LONG', stopOutAt, cooldownMin: 20, now: NOW + 21 * 60_000 })).toBe(false);
    expect(entryCooldownActive({ symbol: 'BTC', side: 'LONG', stopOutAt: null, now: NOW })).toBe(false);
  });
});
