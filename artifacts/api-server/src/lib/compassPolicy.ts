/**
 * compassPolicy — the Compass policy values, resolved at call time.
 *
 * ── WHAT WAS MISSING, STATED AS THE CENSUS STATED IT ─────────────────────────
 * census-compass CCL-15 grades `01-COMPASS-v2.md:46` BUILT-BUT-WRONG on one of
 * its four criteria, and names the failing one exactly:
 *
 *     "Configurable ✗ — the policy values are compile-time constants read from
 *      no environment variable, flag or settings row: CompassSenseEngine.ts's
 *      ACTIVE_DAILY_CAP and the two above. An owner who approves a different
 *      number today needs a deploy, which is the outcome this clause exists to
 *      prevent."
 *
 * The clause is the second half of a sentence whose first half is already
 * satisfied: *"Reuse approved attention budgets, switching policy, confidence/
 * freshness rules, and permission scopes. If absent, ask for the missing values
 * or proposed policy approval, implement configurable contracts and tests with
 * explicitly synthetic fixtures, and leave activation/certification
 * unresolved."* §7's D3 and D4 record the asking; this module is the
 * configurable contract, and it changes no number by itself.
 *
 * ── WHAT THIS IS NOT ─────────────────────────────────────────────────────────
 * It is NOT a ruling. Every default below is the value the tree already
 * shipped, byte for byte, and with no variable set the contract returns exactly
 * those. Nothing here approves a number, and nothing here enables anything: the
 * spec's own *"leave activation/certification unresolved"* is the reason the
 * defaults are unchanged rather than "improved" while the file was open.
 *
 * It is also NOT a feature flag. These are numeric policy values, not
 * capability gates, and they have no `feature_flags` row and no polarity — a
 * missing, empty or unparseable variable means "the owner has set nothing", and
 * resolves to the shipped default rather than to zero.
 *
 * ── WHY AN UNREADABLE VALUE FALLS BACK RATHER THAN FAILING ───────────────────
 * The two failure modes a naive `Number(env.X)` produces are both silent and
 * both bad in the same direction: a typo'd cap reads as `NaN`, collapses to 0
 * and silences every nudge; a typo'd switching cost reads as 0 and promotes
 * every switch. Both are configuration ACCIDENTS presented as policy. So each
 * value is range-checked against what the number means — a cap is a
 * non-negative integer, a switching cost is a fraction of experience value and
 * therefore lies in 0..1 — and anything outside that is refused in favour of
 * the default.
 */

/** The policy values Compass reads. Every field is the value a surface applies. */
export interface CompassPolicy {
  /** Sense: daily nudge ceiling at the "aware" presence level. */
  readonly awareDailyCap: number;
  /** Sense: daily nudge ceiling at the "active" presence level. */
  readonly activeDailyCap: number;
  /** Decision: how much better (0..1) a candidate must be before SWITCH. */
  readonly switchingCost: number;
}

/**
 * The values this tree shipped before the contract existed. These are the ONLY
 * definition of each number — the surfaces re-export from here rather than
 * spelling a second copy, so a default and an applied value cannot drift.
 */
export const COMPASS_POLICY_DEFAULTS: CompassPolicy = Object.freeze({
  awareDailyCap: 3,
  activeDailyCap: 6,
  switchingCost: 0.25,
});

/** The environment variable that carries each value, named after the field. */
export const COMPASS_POLICY_ENV: Readonly<Record<keyof CompassPolicy, string>> = Object.freeze({
  awareDailyCap: "COMPASS_AWARE_DAILY_CAP",
  activeDailyCap: "COMPASS_ACTIVE_DAILY_CAP",
  switchingCost: "COMPASS_SWITCHING_COST",
});

/** Maximum a daily nudge cap may be set to — a ceiling on the ceiling. */
const MAX_DAILY_CAP = 100;

/** A non-negative integer no larger than the ceiling, or null. */
function readCap(raw: string | undefined): number | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  if (!Number.isSafeInteger(n) || n < 0 || n > MAX_DAILY_CAP) return null;
  return n;
}

/** A finite fraction in 0..1, or null. */
function readFraction(raw: string | undefined): number | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (text.length === 0) return null;
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0 || n > 1) return null;
  return n;
}

/**
 * Resolve the policy contract from a configuration source.
 *
 * Takes the source as an argument rather than reading `process.env` inside the
 * branches so that a test states its configuration as a value instead of
 * mutating global state that another test in the same process would see.
 */
export function compassPolicyContract(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): CompassPolicy {
  return {
    awareDailyCap: readCap(env[COMPASS_POLICY_ENV.awareDailyCap]) ?? COMPASS_POLICY_DEFAULTS.awareDailyCap,
    activeDailyCap: readCap(env[COMPASS_POLICY_ENV.activeDailyCap]) ?? COMPASS_POLICY_DEFAULTS.activeDailyCap,
    switchingCost: readFraction(env[COMPASS_POLICY_ENV.switchingCost]) ?? COMPASS_POLICY_DEFAULTS.switchingCost,
  };
}
