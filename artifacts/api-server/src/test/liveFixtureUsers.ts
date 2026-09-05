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
 * forever until somebody deletes the rows by hand. And it is worse than a red
 * job: the failure is in `before`, so node:test CANCELS every test in the file
 * and reports `tests=8 pass=0 fail=0 exit=1`. A security suite that asserts
 * nothing looks, in every line except the exit code, like a security suite.
 *
 * ── WHY THE FIRST FIX (PURGE-BEFORE-CREATE) WAS NOT ENOUGH ──────────────────
 * The first version of this module purged the exact fixture emails before
 * creating them. On 2026-09-05 the job was still red with exactly the same
 * error — and the log showed why, in two adjacent lines:
 *
 *     [liveFixtureUsers] removed 3 leftover fixture user(s) …
 *     Error: createUser(attacker): A user with this email address has already
 *            been registered
 *
 * The purge REPORTED removing three users and removed none. supabase-js returns
 * `{ error }`; it does not throw. Both deletes here ignored the returned value,
 * so a refused delete was indistinguishable from a successful one. THE CLEANUP
 * WAS ITSELF A SILENT-SUCCESS DEFECT — the same shape as the bug it was written
 * to fix, one level down.
 *
 * What refused it: 2276/2277/2279 re-attached a statement-level
 * `BEFORE DELETE … FOR EACH STATEMENT` append-only trigger to three new intel
 * tables. A statement-level BEFORE trigger fires when the statement starts, so
 * it fires even for a cascade that would delete zero rows — and deleting a
 * profiles row cascades into intel_presence_verifications. 2137 had removed
 * exactly that trigger from the original intel tables, for exactly this reason;
 * three later migrations copied 2130's shape and reintroduced it.
 * 2291_intel_stmt_trigger_removal_round2.sql removes it again, and
 * src/test/appendOnlyStatementTriggers.test.ts refuses the next copy.
 *
 * ── SO THERE ARE NOW THREE LAYERS, AND THEY ARE INDEPENDENT ─────────────────
 *   1. RUN-SCOPED EMAILS (`fixtureEmail`). A leftover row from a previous run
 *      can no longer collide with this run's fixtures AT ALL, whatever went
 *      wrong last time and whether or not any cleanup works. This is the layer
 *      that makes the job green, and it depends on nothing else.
 *   2. HONEST CLEANUP (`purgeFixtureUsers`). Deletes are checked and a failure
 *      is REPORTED rather than counted as a success. It never throws — masking
 *      the caller's real error is how a teardown turns a legible failure into a
 *      mystery — but it can no longer be silent.
 *   3. PREFIX-SCOPED PURGE. Because (1) makes each run's emails different, a
 *      purge that matched only exact strings would never again find a leftover.
 *      Callers pass the same base emails as before; matching is on the local
 *      part before any `+` sub-address, so one call collects this run's users
 *      AND every stranded run-scoped variant of them.
 *
 * ── WHY DELETING HERE IS SAFE ───────────────────────────────────────────────
 * This only ever deletes an account whose email is a fixture email the suite
 * itself owns: the exact local part it is about to create, optionally carrying
 * a `+`-suffixed run id, at the same fixture domain (@example.com /
 * @portava-test.invalid — both reserved, neither routable). It cannot match a
 * real account, and it is precisely what the suite's own `after` hook would
 * have done had it run.
 */

import { randomBytes } from "node:crypto";

/**
 * One id per test PROCESS. node:test runs each live suite as its own process,
 * so this scopes emails to a single file's single run — which is the unit that
 * either reaches its teardown or does not.
 *
 * Overridable so a run can be labelled (or reproduced) from the outside; the
 * default is random rather than time-based because two jobs on the same runner
 * can start inside the same millisecond.
 */
export const FIXTURE_RUN_ID: string =
  process.env.PORTAVA_FIXTURE_RUN_ID?.trim().toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12) ||
  randomBytes(5).toString("hex");

/**
 * Turn a base fixture email into this run's unique one.
 *
 *   fixtureEmail("verif_guard_test_attacker@example.com")
 *     -> "verif_guard_test_attacker+r3f9a1c2b04@example.com"
 *
 * The `+` sub-address (RFC 5233) is deliberate: the local part still BEGINS
 * with the suite's documented fixture prefix, so the address stays greppable,
 * obviously a fixture, and matchable by the purge below — while being a
 * different account to GoTrue, which stores the address verbatim.
 *
 * Idempotent: passing an already-scoped address returns it unchanged, so a file
 * that wraps in more than one place cannot double-suffix.
 */
export function fixtureEmail(base: string): string {
  const at = base.lastIndexOf("@");
  if (at < 0) throw new Error(`fixtureEmail: not an email address: ${base}`);
  const local = base.slice(0, at);
  const domain = base.slice(at + 1);
  const stem = local.split("+")[0];
  return `${stem}+r${FIXTURE_RUN_ID}@${domain}`;
}

/**
 * The exact-or-run-scoped matcher. `stem@domain` and `stem+anything@domain`
 * match; nothing else does. Case-insensitive, because GoTrue lower-cases.
 *
 * Exported because a suite that sweeps its own fixtures (rlsHardening) has to
 * ask the same question, and two implementations of "is this one of mine" is
 * how one of them ends up wrong.
 */
export function matchesFixtureEmail(candidateEmail: string, base: string): boolean {
  const candidate = candidateEmail.toLowerCase();
  const at = base.lastIndexOf("@");
  if (at < 0) return false;
  const stem = base.slice(0, at).split("+")[0].toLowerCase();
  const domain = base.slice(at + 1).toLowerCase();
  return candidate === `${stem}@${domain}` || (candidate.startsWith(`${stem}+`) && candidate.endsWith(`@${domain}`));
}

/** Pages to scan before giving up. GoTrue caps per_page server-side, so the
 *  page size is a request, not a promise — the loop stops on an EMPTY page and
 *  never on a short one. A short page used to end the scan on page 1. */
const MAX_PAGES = 50;
const PER_PAGE = 200;

/**
 * Find one auth user by exact email, across EVERY page.
 *
 * `admin.auth.admin.listUsers()` with no arguments returns the first page only
 * — 50 users — and the suites that reused a fixture user by looking it up that
 * way silently stopped finding it once the CI project passed 50 accounts. It
 * surfaced as `could not create or find test user memlife_live_a@…`, which
 * reads like the user is missing rather than like the search was truncated.
 *
 * Throws on a listing error rather than returning null: "not found" and "could
 * not look" are different answers and only one of them is safe to act on.
 */
export async function findUserByEmail(admin: any, email: string): Promise<string> {
  const target = email.toLowerCase();
  const users = await listAllUsers(admin);
  return users.find((u) => String(u?.email ?? "").toLowerCase() === target)?.id ?? "";
}

/**
 * Delete one fixture auth user BY ID, reporting a refusal instead of dropping
 * it. Never throws, for the same reason purgeFixtureUsers does not.
 *
 * Replaces `deleteUser(id).catch(() => {})`, which discarded nothing: supabase-js
 * resolves with `{ error }` rather than rejecting, so the `.catch` never ran and
 * the refusal was never even reachable. Every such call site looked like it had
 * considered failure and had not.
 */
export async function deleteFixtureUser(admin: any, id: string): Promise<boolean> {
  if (!id) return false;
  try {
    const { error } = await admin.auth.admin.deleteUser(id);
    if (error) {
      console.error(`[liveFixtureUsers] CLEANUP FAILED for auth user ${id} — ${error.message ?? String(error)}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[liveFixtureUsers] CLEANUP FAILED for auth user ${id} — ${String(err)}`);
    return false;
  }
}

export type PurgeOutcome = {
  /** Fixture users found and successfully deleted. */
  deleted: string[];
  /** Fixture users found whose delete was REFUSED, with the reason. */
  failed: Array<{ email: string; reason: string }>;
};

async function listAllUsers(admin: any): Promise<any[]> {
  const all: any[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: PER_PAGE });
    if (error) throw new Error(`listUsers(page ${page}): ${error.message ?? String(error)}`);
    const users: any[] = data?.users ?? [];
    if (users.length === 0) return all;
    all.push(...users);
  }
  return all;
}

/**
 * Delete every auth user matching one of `baseEmails` (exact local part, or the
 * same local part carrying a `+` run id), plus its profiles row.
 *
 * NEVER THROWS. A teardown that throws replaces the failure the test was about
 * to report with one about cleanup. It does, however, return what happened and
 * log anything that went wrong — the previous version returned a bare boolean
 * computed from "we issued the call", which is what made a database that
 * refused every delete look like a database that accepted them.
 */
export async function purgeFixtureUsersDetailed(
  admin: any,
  baseEmails: readonly string[],
): Promise<PurgeOutcome> {
  const outcome: PurgeOutcome = { deleted: [], failed: [] };
  if (baseEmails.length === 0) return outcome;

  let users: any[];
  try {
    users = await listAllUsers(admin);
  } catch (err) {
    outcome.failed.push({ email: baseEmails.join(", "), reason: `could not list users: ${String(err)}` });
    return outcome;
  }

  const targets = users.filter((u) => {
    const email = String(u?.email ?? "");
    return email !== "" && baseEmails.some((base) => matchesFixtureEmail(email, base));
  });

  for (const user of targets) {
    const email = String(user.email);
    if (!user?.id) continue;

    // Profile first: profiles.id references auth.users, and leaving an orphan
    // row behind would break the next insert on a unique handle. Its error is
    // NOT fatal on its own (there may be no profiles row), but a refusal here
    // predicts the auth delete below, so it is worth reporting.
    let profileRefusal = "";
    try {
      const { error } = await admin.from("profiles").delete().eq("id", user.id);
      if (error) profileRefusal = `profiles delete refused: ${error.message ?? String(error)}`;
    } catch (err) {
      profileRefusal = `profiles delete threw: ${String(err)}`;
    }

    try {
      const { error } = await admin.auth.admin.deleteUser(user.id);
      if (error) {
        outcome.failed.push({
          email,
          reason: [`deleteUser refused: ${error.message ?? String(error)}`, profileRefusal].filter(Boolean).join(" | "),
        });
        continue;
      }
    } catch (err) {
      outcome.failed.push({ email, reason: [`deleteUser threw: ${String(err)}`, profileRefusal].filter(Boolean).join(" | ") });
      continue;
    }
    outcome.deleted.push(email);
  }

  return outcome;
}

/**
 * The call shape every suite already uses. Logs, never throws.
 *
 * A successful removal is worth one line, because it means a previous run died
 * before its teardown. A REFUSED removal is worth a loud one, because it means
 * the shared CI database is accumulating fixture accounts and nothing else will
 * say so.
 */
export async function purgeFixtureUsers(admin: any, baseEmails: readonly string[]): Promise<void> {
  const { deleted, failed } = await purgeFixtureUsersDetailed(admin, baseEmails);

  if (deleted.length > 0) {
    console.log(
      `[liveFixtureUsers] removed ${deleted.length} fixture user(s): ${deleted.join(", ")}`,
    );
  }
  for (const { email, reason } of failed) {
    console.error(
      `[liveFixtureUsers] CLEANUP FAILED for ${email} — ${reason}. ` +
        `The shared CI database is now retaining a fixture account. This does not fail the run ` +
        `(run-scoped emails mean it cannot block the next one), but it will accumulate until fixed.`,
    );
  }
}

/**
 * Single-email convenience, kept for callers that had it. Returns true only
 * when something was actually deleted — which is now a claim about the
 * database's answer, not about the call having been made.
 */
export async function purgeFixtureUser(admin: any, email: string): Promise<boolean> {
  const { deleted } = await purgeFixtureUsersDetailed(admin, [email]);
  return deleted.length > 0;
}
