// ============================================================
// server/ai/championChallenger.js — v21.33.0 [PHASE J]
// ------------------------------------------------------------
// MASTER PLAN Phase J: champion/challenger promote/rollback ENGINE.
//
// PROMOTION RULE (plan 15.2 / J): challenger ko promote tabhi jab
//   • OOS expectancy champion se better (bootstrap CI non-overlap)
//   • n ≥ 150
//   • max drawdown worse NAHI
//   • 2 hafte stable
// v21.35.0 [F-1]: ye engine ab CALL SITE par enforce hota hai —
// applyFlagChange promote par stats (request ya champion.json ke
// challengers[f]/championStats) milte hi rule REQUIRED hai; stats ke bina
// promote sirf explicit operator-evidence string ke saath (response me
// honesty note ki quantitative rule verify NAHI hua). Pehle engine sirf
// library me padi thi — typed-string kisi bhi flag ko bypass kar deta tha.
// Promotion HAMESHA manual typed-confirm ke saath (FLAG-HISTORY entry +
// audit). Rollback 1 command + typed-confirm.
//
// Koi silent auto-tune live NAHI (plan J: "human approve").
// Koi exchange call nahi. champion.json + FLAG-HISTORY.md + env
// read/write hi hota hai.
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, '../..');
const CHAMPION_FILE = path.join(APP_ROOT, 'config', 'champion.json');
const FLAG_HISTORY_FILE = path.join(APP_ROOT, 'docs', 'FLAG-HISTORY.md');
// v21.33.0 test hook: real config/docs files ko touch kiye bina IO test
// karne ke liye path override (production me hamesha null).
let _pathsForTests = null;
export function __setChallengerPathsForTests({ championFile = null, flagHistoryFile = null } = {}) {
  _pathsForTests = { championFile, flagHistoryFile };
}
function _championFile() { return _pathsForTests?.championFile || CHAMPION_FILE; }
function _flagHistoryFile() { return _pathsForTests?.flagHistoryFile || FLAG_HISTORY_FILE; }

export const CHALLENGER_DEFAULTS = Object.freeze({
  minN: 150,
  stabilityDays: 14,
});

function _num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function _utcDate(d) {
  return new Date(d).toISOString().slice(0, 10);
}

// ------------------------------------------------------------
// Promotion evaluation (pure)
// challenger: { oosExpectancyR, oosExpectancyLoR (CI), oosExpectancyHiR (CI, optional), n, maxDDR, stableSince }
// champion:   { oosExpectancyR, oosExpectancyLoR, oosExpectancyHiR (CI), n, maxDDR }
// ------------------------------------------------------------
export function evaluateChallengerPromotion({
  challenger = {}, champion = {}, minN = CHALLENGER_DEFAULTS.minN, stabilityDays = CHALLENGER_DEFAULTS.stabilityDays,
} = {}) {
  const cOos = _num(challenger.oosExpectancyR);
  // v21.35.0 [F-7 SYMMETRIC FAIL-CLOSED]: challenger Lo missing tha to point
  // estimate se fallback hota tha — bina CI wala challenger point-values par
  // "CI non-overlap" pass kar leta tha, jabki champion-side unknown = refuse.
  // Ab dono side symmetric: cLo missing → null → NOT eligible.
  const cLo = _num(challenger.oosExpectancyLoR);
  const cN = _num(challenger.n);
  const cDD = _num(challenger.maxDDR);
  const pOos = _num(champion.oosExpectancyR);
  const _pLo = _num(champion.oosExpectancyLoR ?? champion.oosExpectancyR); // v21.34.0: kept for API compat (Lo consumer: report side)
  const pHi = _num(champion.oosExpectancyHiR ?? null);
  const pDD = _num(champion.maxDDR);
  const stableSince = challenger.stableSince ? new Date(challenger.stableSince).getTime() : null;
  const stableDays = stableSince ? (Date.now() - stableSince) / 86_400_000 : null;

  const checks = {
    nOk: cN != null && cN >= minN,
    oosBetter: cOos != null && pOos != null ? cOos > pOos : null,
    // v21.34.0 [CI NON-OVERLAP — FIXED + REQUIRED]: documented rule "bootstrap
    // CI non-overlap" pehle (a) compute hota tha par `passed` me REQUIRED
    // nahi tha, aur (b) formula `cLo > pOos || cLo > pLo` galat tha —
    // champion ka UPPER bound missing tha, to koi bhi overlap case pass
    // ho jata tha. Sahi test: challenger ka LOWER bound champion ke UPPER
    // bound se UPAR ho (cLo > pHi). Champion Hi missing → null (unknown) —
    // UNKNOWN me promotion nahi (fail-closed; operator baseline bootstrap
    // se Hi bharega).
    ciNonOverlap: cLo != null && pHi != null ? cLo > pHi : null,
    // v21.35.0 [F-7]: ciNonOverlap ke liye cLo missing bhi null (unknown) hai
    // — whyNot string me honest reason.
    // v21.34.0 [DD FAIL-CLOSED]: `ddNotWorse !== false` null (DD unknown)
    // ko pass karta tha — ek 9.9R drawdown challenger bhi DD-unknown
    // champion ke against eligible ho sakta tha. Ab DD dono known + not
    // worse hi pass (unknown = NOT eligible, honest).
    ddNotWorse: cDD != null && pDD != null ? cDD <= pDD + 1e-9 : null,
    stable: stableDays != null ? stableDays >= stabilityDays : false,
  };
  const passed = checks.nOk === true
    && checks.oosBetter === true
    && checks.ciNonOverlap === true
    && checks.ddNotWorse === true
    && checks.stable === true;
  const whyNot = passed ? null : [
    checks.nOk !== true && `n ${cN ?? '?'} < ${minN}`,
    checks.oosBetter !== true && `OOS ${cOos ?? '?'} champion ${pOos ?? '?'} se better nahi`,
    checks.ciNonOverlap !== true && (checks.ciNonOverlap === null
      ? 'CI unknown (challenger Lo ya champion Hi missing) — fail-closed'
      : `CI overlap (challenger Lo ${cLo} <= champion Hi ${pHi})`),
    checks.ddNotWorse !== true && (checks.ddNotWorse === null
      ? 'DD unknown (challenger/champion) — fail-closed'
      : `challenger DD ${cDD} champion ${pDD} se worse`),
    checks.stable !== true && `stability < ${stabilityDays} din`,
  ].filter(Boolean).join(' · ');
  return {
    promotionEligible: passed,
    checks,
    required: { minN, stabilityDays, oosBetter: true, ciNonOverlap: true, ddNotWorse: true },
    note: passed
      ? 'ELIGIBLE — promotion ab bhi MANUAL typed-confirm se hogi (FLAG-HISTORY entry ke saath)'
      : `NOT ELIGIBLE — ${whyNot || 'challenger shadow me hi rahega'}`,
  };
}

// ------------------------------------------------------------
// champion.json / FLAG-HISTORY.md IO (safe, best-effort)
// ------------------------------------------------------------
export function loadChampion() {
  try {
    return JSON.parse(fs.readFileSync(_championFile(), 'utf8'));
  } catch {
    return null;
  }
}

export function flagMatrixSnapshot(env = process.env) {
  const champ = loadChampion();
  const flags = {};
  for (const [name, f] of Object.entries(champ?.flags || {})) {
    const envVal = env[name] ?? null;
    flags[name] = {
      default: f?.default ?? 'off',
      env: envVal,
      effective: String(envVal ?? f?.default ?? 'off').toLowerCase(),
    };
  }
  return {
    version: champ?.version || null,
    gitSha: champ?.gitSha || null,
    baselineFile: champ?.baselineFile || null,
    frozenAt: champ?.frozenAt || null,
    flags,
  };
}

function appendFlagHistory(row) {
  try {
    const file = _flagHistoryFile();
    let existing = '';
    try { existing = fs.readFileSync(file, 'utf8'); } catch { /* new file */ }
    const marker = '<!-- championChallenger append marker -->';
    const entry = `\n| ${new Date().toISOString()} | ${row.flag} | ${row.change} | ${row.evidence} | ${row.operator} |\n`;
    if (existing.includes(marker)) {
      existing = existing.replace(marker, `${marker}${entry}`);
    } else {
      existing = `${existing}\n${entry}${marker}\n`;
    }
    fs.writeFileSync(file, existing, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Typed-confirm promotion/rollback. confirmTyped EXACT string hona
 * chahiye: `PROMOTE <FLAG>` ya `ROLLBACK <FLAG>`. Galat string →
 * refuse (operator error se protection).
 *
 * v21.35.0 [F-1 PROMOTION GATE]: `stats: { challenger, champion }` (request
 * body ya champion.json ke `challengers[flag]` / `championStats` sections)
 * resolve hone par evaluateChallengerPromotion engine REQUIRED hai — fail
 * par promote refuse. Stats bina promote ke liye explicit non-empty
 * `evidence` string ZAROORI (canned default se silent pass khatam) aur
 * response `eligibility.checked:false` honesty ke saath jaata hai.
 * v21.35.0 [F-4]: `historyWritten` — FLAG-HISTORY append ka boolean result
 * ab response me honest hai (pehle note "entry + alert ho gaya" jhooth
 * bolta tha jab write fail hota tha; is module me alert call hai hi nahi).
 */
export function applyFlagChange({
  flag = '', action = '', confirmTyped = '', mode = '', evidence = '', operator = 'operator',
  stats = null,
} = {}) {
  const f = String(flag || '').trim().toUpperCase();
  const a = String(action || '').trim().toLowerCase();
  const expected = `${a === 'promote' ? 'PROMOTE' : a === 'rollback' ? 'ROLLBACK' : '?'} ${f}`;
  if (!f || (a !== 'promote' && a !== 'rollback')) {
    return { ok: false, error: 'action must be promote|rollback' };
  }
  // v21.34.0 [MODE VALIDATION]: promote me mode off|shadow|enforce hi
  // chalta hai — typo ('shdow') champion.json me garbage default likh
  // deti thi jo downstream normalizer chupke se off treat karta tha.
  const m = String(mode || 'shadow').trim().toLowerCase();
  if (a === 'promote' && !['off', 'shadow', 'enforce'].includes(m)) {
    return { ok: false, error: `mode must be off|shadow|enforce (mila: "${mode}")` };
  }
  if (String(confirmTyped || '').trim() !== expected) {
    return { ok: false, error: `typed-confirm mismatch — exactly "${expected}" chahiye` };
  }
  const champ = loadChampion();
  if (!champ || !champ.flags || !champ.flags[f]) {
    return { ok: false, error: `flag ${f} champion.json me nahi mila` };
  }
  // ---------- v21.35.0 [F-1] PROMOTION ELIGIBILITY GATE ----------
  let eligibility = {
    checked: false,
    promotionEligible: null,
    note: 'challenger stats available nahi — Phase J quantitative rule (n≥150 + CI non-overlap + DD not-worse + 2-week stable) verify NAHI hua; operator evidence par promote',
  };
  if (a === 'promote') {
    const challengerStats = (stats && typeof stats.challenger === 'object' && stats.challenger)
      ? stats.challenger
      : (champ.challengers && typeof champ.challengers[f] === 'object' ? champ.challengers[f] : null);
    const championStats = (stats && typeof stats.champion === 'object' && stats.champion)
      ? stats.champion
      : (champ.championStats && typeof champ.championStats === 'object' ? champ.championStats : null);
    if (challengerStats) {
      const verdict = evaluateChallengerPromotion({ challenger: challengerStats, champion: championStats || {} });
      eligibility = { checked: true, promotionEligible: verdict.promotionEligible, checks: verdict.checks, note: verdict.note };
      if (!verdict.promotionEligible) {
        return { ok: false, error: `promotion rule FAIL — ${verdict.note}`, flag: f, action: a, eligibility };
      }
    } else if (!String(evidence || '').trim()) {
      // stats nahi + evidence nahi → refuse (fail-closed). Pehle canned
      // default evidence silently pass ho jata tha.
      return {
        ok: false,
        error: 'promote ke liye challenger stats (body: stats.challenger + stats.champion) ya explicit evidence string chahiye — bina A5/quant evidence promote mana hai',
        flag: f,
        action: a,
      };
    }
  }
  const change = a === 'promote'
    ? `${champ.flags[f].effective} → ${m}`
    : `${champ.flags[f].effective} → off`;
  // champion.json update (default change; env override operator khud karega)
  champ.flags[f] = {
    ...champ.flags[f],
    default: a === 'promote' ? m : 'off',
    effective: a === 'promote' ? m : 'off',
    lastChangeAt: new Date().toISOString(),
  };
  champ.lastFlagChange = { flag: f, action: a, at: new Date().toISOString(), operator };
  try {
    fs.mkdirSync(path.dirname(_championFile()), { recursive: true });
    fs.writeFileSync(_championFile(), JSON.stringify(champ, null, 2));
  } catch (e) {
    return { ok: false, error: `champion.json write fail: ${e?.message || e}` };
  }
  const historyWritten = appendFlagHistory({
    flag: f,
    change,
    evidence: String(evidence || '').trim()
      || (a === 'promote'
        ? (eligibility.checked ? 'engine-eligible: evaluateChallengerPromotion PASS' : 'operator-supplied evidence')
        : 'rollback — conservative safety'),
    operator,
  });
  return {
    ok: true,
    flag: f,
    action: a,
    change,
    eligibility,
    // v21.35.0 [F-4]: FLAG-HISTORY write ka honest result — fail par note
    // clearly bolta hai (audit trail operator ka rollback evidence hai).
    historyWritten,
    note: a === 'promote'
      ? `Promoted${historyWritten ? '' : ' — FLAG-HISTORY WRITE FAIL (audit entry NAHI bani; disk/permission check karo!)'}. Env override hatao warna env jeetega; restart ke baad effective.`
      : `Rolled back to off${historyWritten ? ' — FLAG-HISTORY entry saved' : ' — FLAG-HISTORY WRITE FAIL (audit entry NAHI bani; disk/permission check karo!)'}`,
  };
}

/**
 * Challenger status snapshot — shadow-report verdicts + drift + meta
 * model state ka ek aggregate (K1 dashboard ka input).
 */
export function challengerStatus({ shadowVerdicts = {}, driftVerdict = null, metaModel = null, now = Date.now() } = {}) {
  const flags = flagMatrixSnapshot();
  const promoting = Object.entries(shadowVerdicts)
    .filter(([, v]) => String(v || '').toLowerCase() === 'useful')
    .map(([k]) => k);
  return {
    ts: Number(now) || Date.now(),
    champion: { version: flags.version, gitSha: flags.gitSha, baselineFile: flags.baselineFile },
    flagMatrix: flags.flags,
    driftVerdict: driftVerdict || null,
    metaModel: metaModel ? {
      // v21.34.0 [WATCH HONESTY]: `available` field add — index.js ka boot
      // log `boot?.metaModel?.available` padhta tha, jo projection me kabhi
      // nahi tha → model loaded ho ya na ho, log hamesha "inactive (no
      // artifact)" bolta tha. Ab projection sach bolti hai.
      available: true,
      version: metaModel.version || null,
      n: metaModel.n || null,
      metrics: metaModel.metrics || null,
    } : null,
    eligibleForReview: promoting,
    promotionRule: 'OOS expectancy better + CI non-overlap (cLo > champion Hi) + n>=150 + DD not worse (unknown = refuse) + 2 hafte stable + typed-confirm (FLAG-HISTORY)',
  };
}

/** Convenience: promotion checklist for one flag (K3 UI row).
 *  v21.34.0: ye REVIEW-MINIMUM thresholds hain (n≥100, 1 week observe) —
 *  engine ka actual promotion rule evaluateChallengerPromotion me hai
 *  (n≥150, CI non-overlap, 14 din stable). Operator ko dono dikhte hain. */
export function promotionChecklist({ flag = '', shadowReport = {}, ledgerStats = {} } = {}) {
  const n = _num(ledgerStats.n);
  const coverage = _num(ledgerStats.dataCoveragePct);
  const ddWorse = ledgerStats.ddWorse === true;
  return {
    flag,
    verdict: shadowReport.verdict || null,
    nOk: n != null ? n >= 100 : null,
    coverageOk: coverage != null ? coverage >= 80 : null,
    ddOk: !ddWorse,
    observeWeek: ledgerStats.observedWeeks != null ? ledgerStats.observedWeeks >= 1 : null,
    ready: String(shadowReport.verdict || '').toLowerCase() === 'useful'
      && (n != null && n >= 100)
      && (coverage == null || coverage >= 80)
      && !ddWorse,
    next: 'ready → operator typed-confirm se applyFlagChange({action:"promote"})',
  };
}
