/**
 * Neutralising a provider API key in a test.
 *
 * THE GENERAL PROBLEM, which is not specific to Foursquare: a test that wants
 * to assert "no key is configured" deletes the env var it was written against.
 * That is correct only for as long as exactly one variable can supply the key.
 * The moment a provider gains an environment-specific split — a DEV/PROD pair
 * in front of a legacy shared variable — deleting the legacy one stops meaning
 * "absent", because the resolver never looks at it while a preferred variable
 * is set. The test keeps compiling, keeps reading as if it tests the absent
 * case, and quietly tests something else.
 *
 * It fails in both directions, and the second is worse than the first:
 *
 *   CLEARING the legacy var no longer produces "absent" — the code still
 *   resolves a key, takes the configured path, and the test fails (loudly, at
 *   least) for a reason that has nothing to do with the behaviour under test.
 *
 *   SETTING the legacy var no longer injects a key — the code resolves the
 *   REAL secret from the preferred variable instead. The test passes, and is
 *   green for the wrong reason. If any fetch stub in it ever fails open, it
 *   calls the live provider on production quota, which is the exact thing the
 *   dev/prod split was introduced to prevent.
 *
 * So the question a test has to answer is not "which variable did I write this
 * against" but "which variables can supply this key at all". This module holds
 * that answer per provider, in resolver precedence order, and operates on the
 * whole chain rather than any single member of it.
 *
 * When a provider gains another variable, add it here. The drift guard in
 * apiKeyEmptyVsAbsent.test.ts reads the resolver's source and fails if this
 * list does not match it, so the update is not left to whoever remembers.
 */

/**
 * Every variable that can supply the Foursquare key, in the order
 * resolveFoursquareApiKey (src/lib/foursquareApiKey.ts) consults them.
 *
 * Both env-specific variables are listed even though only one is preferred in
 * a given NODE_ENV: a test must neutralise the chain regardless of which
 * environment it happens to run under, and a suite that only cleared the
 * variable for its own NODE_ENV would break the day CI set the other one.
 */
export const FOURSQUARE_KEY_VARS = [
  'FSQ_API_KEY_PROD',
  'FSQ_API_KEY_DEV',
  'FOURSQUARE_API_KEY',
] as const;

export type KeyEnvSnapshot = Record<string, string | undefined>;

/** Capture the current values so a test can restore exactly what it found. */
export function snapshotKeyEnv(vars: readonly string[]): KeyEnvSnapshot {
  const snap: KeyEnvSnapshot = {};
  for (const v of vars) snap[v] = process.env[v];
  return snap;
}

/**
 * Restore a snapshot, including restoring "was not set at all" as unset rather
 * than as an empty string — the two are different states to classifyApiKey, and
 * collapsing them is how one test leaks a false "empty key" into the next.
 */
export function restoreKeyEnv(snap: KeyEnvSnapshot): void {
  for (const [v, value] of Object.entries(snap)) {
    if (value === undefined) delete process.env[v];
    else process.env[v] = value;
  }
}

/** Make the key genuinely absent: every source in the chain unset. */
export function clearKeyEnv(vars: readonly string[]): void {
  for (const v of vars) delete process.env[v];
}

/**
 * Make the key resolve to exactly `value`.
 *
 * Clears the whole chain first, then sets the LAST variable — the shared
 * fallback the resolver reaches when no environment-specific variable is set.
 *
 * Deliberately the last and not the first. Precedence here is not a fixed
 * order: the resolver picks its preferred variable from NODE_ENV
 * (FSQ_API_KEY_PROD in production, FSQ_API_KEY_DEV otherwise) and consults only
 * that one before falling back. Setting the first entry would inject nothing at
 * all in a dev-mode run — the resolver would look at FSQ_API_KEY_DEV, find it
 * unset, fall through to an unset legacy variable and report the key as absent.
 * Clearing the specific pair and setting the fallback is the one arrangement
 * that resolves to `value` under every NODE_ENV.
 *
 * Pass '' to produce the present-but-empty state.
 */
export function setKeyEnv(vars: readonly string[], value: string): void {
  clearKeyEnv(vars);
  process.env[vars[vars.length - 1]!] = value;
}
