/**
 * liveFixtureUsers — make the live-DB suites self-healing.
 *
 * NOT a test file (no .test.ts suffix), so check:test-registration ignores it.
 *
 * ── THE FAILURE THIS FIXES ──────────────────────────────────────────────────
 * The live-DB security suites create auth users at DETERMINISTIC emails
 * (`${PREFIX}attacker@example.com`, `${PREFIX}plain@example.com`, …) and delete
 * them in an `after` hook. That is fine until a run dies before teardown — a
 * timeout, a cancelled workflow, a concurrency eviction, or a failing assertion
 * that takes the process down. The users then survive, and every subsequent run
 * fails in `before` with:
 *
 *     A user with this email address has already been registered
 *
 * which is a SELF-PERPETUATING failure: once it happens once, the job stays red
 * forever until somebody deletes the rows by hand. That is exactly what had
 * happened — the `live DB · RLS + role/is_official write boundaries` job
 * reported `tests=8 pass=0 fail=0 exit=1`, meaning it never ran a single test,
 * and it had been red across every branch for that reason rather than anything
 * to do with the code under test.
 *
 * Cleaning up by hand fixes today and not tomorrow. Deleting a stale fixture
 * user before creating it fixes both: the next run heals itself, with no manual
 * database operation and nobody needing to know this can happen.
 *
 * ── WHY DELETING HERE IS SAFE ───────────────────────────────────────────────
 * This only ever deletes an account whose email EXACTLY equals one the suite is
 * about to create, and those emails are fixture-prefixed and @example.com. It
 * cannot match a real account. It is also precisely what the suite's own `after`
 * hook would have done had it run.
 */

/** Pages to scan before giving up. 10 x 1000 covers any plausible test project. */
const MAX_PAGES = 10;
const PER_PAGE = 1000;

/**
 * Delete any pre-existing auth user at `email`, plus its profiles row.
 *
 * Returns true when something was actually removed, so callers can log that the
 * run healed a leftover rather than starting clean.
 *
 * Never throws: a failure here must not mask the real error the caller is about
 * to produce when it tries to create the user itself.
 */
export async function purgeFixtureUser(admin: any, email: string): Promise<boolean> {
  const target = email.toLowerCase();
  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const { data, error } = await admin.auth.admin.listUsers({ page, perPage: PER_PAGE });
      if (error) return false;
      const users: any[] = data?.users ?? [];
      if (users.length === 0) return false;

      const hit = users.find((u) => String(u?.email ?? "").toLowerCase() === target);
      if (hit?.id) {
        // Profile first: profiles.id references auth.users, and leaving an
        // orphan row behind would break the next insert on a unique handle.
        try { await admin.from("profiles").delete().eq("id", hit.id); } catch { /* best effort */ }
        try { await admin.auth.admin.deleteUser(hit.id); } catch { /* best effort */ }
        return true;
      }

      if (users.length < PER_PAGE) return false; // last page, no match
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * Purge several fixture emails. Logs once if anything was left over, because a
 * run that had to heal itself is worth seeing in the CI output — it means a
 * previous run died before its teardown.
 */
export async function purgeFixtureUsers(admin: any, emails: readonly string[]): Promise<void> {
  let healed = 0;
  for (const email of emails) {
    if (await purgeFixtureUser(admin, email)) healed += 1;
  }
  if (healed > 0) {
    console.log(
      `[liveFixtureUsers] removed ${healed} leftover fixture user(s) from a previous run that did not reach its teardown`,
    );
  }
}
