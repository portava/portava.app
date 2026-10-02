/**
 * `measured()` — narrow a trust score that the test has ARRANGED to be measured.
 *
 * WHY THIS EXISTS
 * ===============
 * Q1 (owner decision 2026-09-22) made `TrustScoreResult.overall_score` and every
 * category `number | null`, where `null` means NOT SCORED. That is the point of
 * the change, and it correctly makes `tsc` reject `result.categories.x > 50` in
 * the suites that seed events and then assert on the resulting number.
 *
 * There were two ways to answer that, and only one of them is honest:
 *
 *   `x!` or `as number` — silences the compiler and asserts nothing. If the
 *      engine regressed and returned `null` where the test seeded events, the
 *      comparison would run against `null`, coerce to 0, and the assertion
 *      would fail somewhere downstream with a message about the wrong thing —
 *      or, for `assert.ok(x < 50)`, PASS, because `null < 50` is true. That is
 *      the precise failure mode Q1 exists to eliminate, reintroduced in the
 *      tests that are supposed to guard it.
 *
 *   `measured(x)` — this. It FAILS LOUDLY, at the call site, naming the value,
 *      when a score the test arranged to exist is missing. "This category was
 *      measured" stops being an assumption the compiler was told to ignore and
 *      becomes an assertion the suite actually makes.
 *
 * Use it ONLY where the test has seeded the events that produce the score. A
 * test whose subject IS the null case must assert `=== null` directly and must
 * not route through here.
 */
import assert from "node:assert/strict";

export function measured(value: number | null | undefined, label = "trust score"): number {
  assert.ok(
    value !== null && value !== undefined,
    `${label}: expected a MEASURED score, got ${String(value)} (not scored). ` +
      `The test seeded events for this category, so a null here means the engine stopped scoring them.`,
  );
  return value as number;
}
