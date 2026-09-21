/**
 * The two pure decisions behind `check:census-policy-citations`.
 *
 * Extracted so they are testable without running the whole guard over the real
 * corpus — the same arrangement as lib/transformedFunction.ts and
 * lib/censusHeadCommit.ts, and for the same reason: a guard whose judgement is
 * inline can only be tested by hand-reverting a real document.
 *
 * See census-trips §32.6-§32.7 for the failure these encode.
 */

/**
 * Policy-shaped identifiers a census mentions in backticks.
 *
 * THE VERB IS A SEGMENT, NOT A SUFFIX, AND THAT WAS A REAL BUG
 * ===========================================================
 * The first version required the name to END in a policy verb —
 * `route_plans_member_select`. That is the 0058-era convention, and it is NOT
 * the one this repo now uses: every policy migrations 2760-2777 create is
 * named `<table>_select_crew` (`trip_stages_select_crew`,
 * `trip_goals_select_crew`, …), with the verb in the MIDDLE.
 *
 * So the guard, written to catch a census citing a superseded policy, would
 * have missed every policy the session that wrote it had created. Its own test
 * caught that on the first run, which is the argument for the test rather than
 * the hand-revert.
 *
 * Still deliberately conservative about what a policy name LOOKS like: the verb
 * must be a `_`-delimited segment, so `trip_plan_items` and `is_trip_crew` are
 * not swept in. A broader pattern turns the guard into noise, and a guard that
 * cries wolf gets switched off — after which the real finding comes back.
 */
const CITED_POLICY =
  /`([a-z][a-z0-9_]*_(?:select|insert|update|delete|all)(?:_[a-z0-9_]+)?)`/g;

/** Every policy-shaped name a census cites, lower-cased and de-duplicated. */
export function citedPolicies(censusText: string): string[] {
  return [...new Set([...censusText.matchAll(CITED_POLICY)].map((m) => m[1]!.toLowerCase()))].sort();
}

export type CitationVerdict =
  /** Not a policy in this corpus, or created by exactly one migration. */
  | { kind: "not_applicable" }
  /** Superseded, and the census names the file that currently defines it. */
  | { kind: "current"; last: string }
  /** Superseded, and the census does NOT name that file. The defect. */
  | { kind: "stale"; last: string; chain: string[] };

/**
 * Does this census citation point at the definition currently in force?
 *
 * `creators` is the migrations that CREATE the policy, in chain order. One
 * creator means there is no later definition to have missed, so there is
 * nothing to check — the guard's job is not to demand a citation, it is to
 * catch a citation that has been overtaken.
 */
export function judgeCitation(
  censusText: string,
  creators: readonly string[],
): CitationVerdict {
  if (creators.length <= 1) return { kind: "not_applicable" };
  const last = creators[creators.length - 1]!;
  return censusText.includes(last)
    ? { kind: "current", last }
    : { kind: "stale", last, chain: [...creators] };
}
