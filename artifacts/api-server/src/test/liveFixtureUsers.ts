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
 * 2292_intel_stmt_trigger_removal_ig_campaign.sql removes it again, and
 * src/test/appendOnlyCascade.test.ts refuses the next copy.
 *
 * (2292 arrived on main from the IG campaign while this branch was in flight,
 * doing the same three tables. This branch had written its own 2291 for the
 * same removal; the duplicate was dropped rather than merged, and the DDL was
 * applied to portava-ci once.)
 *
 * ── AND WHY LAYER 3 THEN BROKE LAYER 1 (2026-09-05, ROUND 2) ────────────────
 * Layer 3 below sweeps "every stranded run-scoped variant" of a fixture
 * address. It had no way to tell a STRANDED variant from a LIVE one, so a sweep
 * by run A deleted run B's fixture users while B was still using them — undoing
 * layer 1 for both runs. Layer 4 (`isSweepableFixtureUser`) is the missing
 * distinction: ours at any age, somebody else's only once it is too old to
 * belong to a live run. Its header carries the measurement and the reasoning.
 *
 * ── SO THERE ARE NOW FOUR LAYERS, AND THEY ARE INDEPENDENT ──────────────────
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
 *   4. PEER PROTECTION (`isSweepableFixtureUser`). What (3) collects is a
 *      candidate list, not a delete list. An address belonging to another run
 *      is deleted only when the account is old enough that no live run can
 *      still own it; an address belonging to THIS run is deleted at any age,
 *      because that is the teardown path.
 *
 * ── WHY DELETING HERE IS SAFE ───────────────────────────────────────────────
 * This only ever deletes an account whose email is a fixture email the suite
 * itself owns: the exact local part it is about to create, optionally carrying
 * a `+`-suffixed run id, at the same fixture domain (@example.com /
 * @portava-test.invalid — both reserved, neither routable). It cannot match a
 * real account, it cannot take a concurrent run's account with it, and it is
 * precisely what the suite's own `after` hook would have done had it run.
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
 * ── THIS ANSWERS "IS THIS ADDRESS ONE OF OURS", NOT "MAY I DELETE IT" ───────
 * Those are different questions and conflating them is the defect fixed below.
 * `classifyFixtureEmail` and `isSweepableFixtureUser` answer the second one.
 * Keep using this one to RECOGNISE a fixture address; never to authorise a
 * delete.
 */
export function matchesFixtureEmail(candidateEmail: string, base: string): boolean {
  return classifyFixtureEmail(candidateEmail, base) !== null;
}

/**
 * Which run an address belongs to, relative to THIS process.
 *
 *   "mine"     — `stem+r<FIXTURE_RUN_ID>@domain`: this process created it.
 *   "foreign"  — `stem+<anything else>@domain`: some OTHER run created it. That
 *                run may be dead (stranded leftovers) or ALIVE RIGHT NOW.
 *   "unscoped" — exactly `stem@domain`: predates run-scoping, so it has no run
 *                to belong to. Treated like "foreign": unowned, not ours.
 *   null       — not one of ours at all.
 */
export type FixtureEmailScope = "mine" | "foreign" | "unscoped";

export function classifyFixtureEmail(candidateEmail: string, base: string): FixtureEmailScope | null {
  const candidate = candidateEmail.toLowerCase();
  const at = base.lastIndexOf("@");
  if (at < 0) return null;
  const stem = base.slice(0, at).split("+")[0].toLowerCase();
  const domain = base.slice(at + 1).toLowerCase();
  if (candidate === `${stem}@${domain}`) return "unscoped";
  if (!candidate.startsWith(`${stem}+`) || !candidate.endsWith(`@${domain}`)) return null;
  const suffix = candidate.slice(stem.length + 1, candidate.length - domain.length - 1);
  return suffix === `r${FIXTURE_RUN_ID.toLowerCase()}` ? "mine" : "foreign";
}

// ─────────────────────────────────────────────────────────────────────────────
// LABELS: THE SAME PROBLEM, ONE TABLE OVER
//
// ── THE DEFECT, 2026-09-05 (round 3) ────────────────────────────────────────
// Run-scoping an auth user's EMAIL fixes collisions on `auth.users`. It does
// nothing for the ordinary rows a live suite creates alongside that user and
// then identifies by a deterministic STRING: `rlsHardening.test.ts` owned
//
//     FIXTURE_HANDLES     = ["rls_hardening_test_private", "…_public"]
//     FIXTURE_EVENT_TITLE = "rls_hardening_test_private_event"
//     FIXTURE_TRIP_TITLE  = "rls_hardening_test_private_trip"
//
// and its `purgeFixtures()` deleted `trips` where `title = FIXTURE_TRIP_TITLE`,
// `events` where `title = FIXTURE_EVENT_TITLE`, and `profiles` where the handle
// was one of the two. Those constants are IDENTICAL in every process, so two
// concurrent runs — or two attempts of the same run — deleted each other's
// trip, event and profile rows mid-suite. It is exactly the failure
// `fixtureEmail()` was introduced to remove, expressed in a column that is not
// an email address, and the profiles half additionally collides on
// `profiles_handle_key` (handle is UNIQUE) rather than merely disappearing.
//
// ── THE SCHEME, AND WHY `+r<run>` IS NOT REUSED HERE ────────────────────────
// A label is scoped with a `_r<run id>` SUFFIX, not the `+r<run id>`
// sub-address the email path uses. `+` is meaningful (and conventional) in an
// email local part and meaningless in a handle; a handle is a user-facing
// identifier and the fixture rows should look like the identifiers the product
// actually stores. `profiles.handle` is `text NOT NULL` with `profiles_handle_key
// UNIQUE (handle)` and NO check constraint, no length cap, and no format
// validator anywhere in the repo (verified against
// baseline/20260819_baseline_structure.sql and every migration), so the scheme
// is constrained only by uniqueness — which is precisely what it provides.
// FIXTURE_RUN_ID is at most 12 characters, so a scoped label grows by 14.
//
// ── SAME TWO-PART RULE, ONE IMPLEMENTATION ─────────────────────────────────
// `decideSweep` below is THE decision, and both the user path and the row path
// route through it. Neither half of it works alone — see the long comment on
// FIXTURE_SWEEP_MIN_AGE_MS.
// ─────────────────────────────────────────────────────────────────────────────

/** The generalised name: a scope answer is about a fixture IDENTIFIER, not only an email. */
export type FixtureScope = FixtureEmailScope;

/**
 * Turn a base fixture label (a handle, a title, any deterministic identifier
 * string) into this run's unique one.
 *
 *   fixtureLabel("rls_hardening_test_private_trip")
 *     -> "rls_hardening_test_private_trip_r3f9a1c2b04"
 *
 * Idempotent for this run: passing an already-scoped label returns it unchanged.
 */
export function fixtureLabel(base: string): string {
  const suffix = `_r${FIXTURE_RUN_ID}`;
  return base.endsWith(suffix) ? base : `${base}${suffix}`;
}

/**
 * Which run a label belongs to, relative to THIS process. Same three answers as
 * `classifyFixtureEmail`, same meanings.
 *
 * Case-sensitive, unlike the email variant: GoTrue lower-cases addresses, but a
 * handle or a title is stored verbatim, so folding case here would let
 * `..._RPEERRUN` read as one of ours.
 */
export function classifyFixtureLabel(candidateLabel: string, base: string): FixtureScope | null {
  if (candidateLabel === base) return "unscoped";
  if (!candidateLabel.startsWith(`${base}_r`)) return null;
  const suffix = candidateLabel.slice(base.length + 2);
  if (suffix === "") return null;
  return suffix === FIXTURE_RUN_ID ? "mine" : "foreign";
}

/**
 * ── DEFECT, MEASURED 2026-09-05: THE SWEEP DELETED OTHER RUNS' USERS ────────
 *
 * `purgeFixtureUsers` is called from some suites' `before` hooks to sweep
 * fixtures a dead run stranded. It deleted every account `matchesFixtureEmail`
 * accepted — which includes `stem+r<SOMEBODY ELSE'S RUN>@domain`. So a sweep by
 * run A deleted run B's live fixture users, mid-suite, and defeated the exact
 * property `fixtureEmail()` had just been introduced to provide. On main's
 * attempt 2 that day, three suites that were ALREADY run-scoped
 * (profile-role-not-self-writable, local-guide-self-promotion,
 * rbp-self-verification) still went red with `readRole(<uuid>): Cannot coerce
 * the result to a single JSON object` — their own rows, deleted by a peer.
 *
 * ── WHY NEITHER HALF OF THE FIX WORKS ALONE ────────────────────────────────
 *
 * RUN-ID ALONE ("only delete addresses carrying my run id") is safe but inert:
 * every genuinely stranded account carries some OTHER run's id, so nothing
 * would ever be swept and the 56-orphaned-user problem returns. It cannot
 * distinguish a stranded run from a live one — both are "not me".
 *
 * AGE ALONE ("only delete accounts older than N") protects live peers, but
 * breaks the case the helper exists for: a suite's own `after` hook purges the
 * users it created SECONDS ago, and an age gate would refuse to. Teardown would
 * stop working and every run would strand its own fixtures — the orphan problem
 * again, arriving from the other direction. It also still races: a run slower
 * than N is indistinguishable from a dead one.
 *
 * BOTH, and each half is load-bearing:
 *
 *   mine                → always sweepable. Definitionally safe: no other run
 *                         can hold this address, and this is the teardown path.
 *   foreign / unscoped  → sweepable ONLY if the account is older than
 *                         FIXTURE_SWEEP_MIN_AGE_MS.
 *
 * The age gate is a bound on how long a peer's fixtures are protected, so it
 * must exceed the longest a live run can hold one. The DB jobs in live-db.yml
 * cap at 45 minutes INCLUDING the slot re-verification, and fixture users are
 * created after that; two hours is more than twice the worst case. A stranded
 * account younger than that is simply swept by the next run — sweeping is
 * hygiene, not a correctness dependency, because run-scoped addresses mean a
 * leftover can no longer block anybody.
 *
 * An account whose age cannot be determined is NOT swept. "I could not tell how
 * old it is" and "it is old" are different answers and only one of them is safe
 * to act on.
 */
export const FIXTURE_SWEEP_MIN_AGE_MS: number = sweepMinAgeMs(
  process.env.PORTAVA_FIXTURE_SWEEP_MIN_AGE_MINUTES,
);

/**
 * Exported so the rule is testable rather than only its one evaluation.
 *
 * A blank value falls back to the default rather than parsing as zero:
 * `Number("")` is 0, and a zero window would make every foreign address
 * immediately sweepable — the original defect, reintroduced by an empty
 * environment variable. Non-positive and unparseable values are refused for the
 * same reason.
 */
export function sweepMinAgeMs(raw: string | undefined): number {
  const DEFAULT_MS = 120 * 60_000; // two hours; see the block comment above
  if (typeof raw !== "string" || raw.trim() === "") return DEFAULT_MS;
  const minutes = Number(raw.trim());
  if (!Number.isFinite(minutes) || minutes <= 0) return DEFAULT_MS;
  return minutes * 60_000;
}

/** Parse a `created_at`. Returns null when it is absent or unusable. */
function createdAtMs(row: unknown): number | null {
  const raw = (row as { created_at?: unknown } | null)?.created_at;
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const ms = new Date(raw as string | number).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * THE ONE DECISION, as a pure function of (whose it is, how old it is, now).
 *
 * Every sweeper in the repository routes through this — `purgeFixtureUsersDetailed`,
 * `purgeFixtureRowsDetailed`, and rlsHardening's `findFixtureUserIds` — because
 * two implementations of "may I delete this" is how one of them deletes a
 * peer's row. Exported so the rule itself is testable, not only its callers.
 */
export function decideSweep(
  scope: FixtureScope | null,
  createdMs: number | null,
  nowMs: number,
): boolean {
  if (scope === null) return false;
  if (scope === "mine") return true; // ours, at any age — this is the teardown path
  if (createdMs === null) return false; // cannot date it -> cannot claim it is stranded
  return nowMs - createdMs >= FIXTURE_SWEEP_MIN_AGE_MS;
}

/** Fold a row's scope across several bases. "mine" wins over everything. */
function scopeAcross(
  value: string,
  bases: readonly string[],
  classify: (candidate: string, base: string) => FixtureScope | null,
): FixtureScope | null {
  if (value === "") return null;
  let scope: FixtureScope | null = null;
  for (const base of bases) {
    const s = classify(value, base);
    if (s === "mine") return "mine";
    if (s !== null && scope === null) scope = s;
  }
  return scope;
}

/**
 * May this suite delete this auth user? The `decideSweep` rule, applied to an
 * address. `purgeFixtureUsersDetailed` and rlsHardening's `findFixtureUserIds`
 * both ask through here, so there is one answer rather than two that can
 * disagree.
 */
export function isSweepableFixtureUser(
  user: unknown,
  baseEmails: readonly string[],
  nowMs: number = Date.now(),
): boolean {
  const email = String((user as { email?: unknown } | null)?.email ?? "");
  return decideSweep(scopeAcross(email, baseEmails, classifyFixtureEmail), createdAtMs(user), nowMs);
}

/**
 * The row equivalent: may this suite delete this ordinary table row, identified
 * by a run-scoped label in `column`?
 *
 * Same rule, same reasons. An undatable row is never swept — for a row this is
 * not a hypothetical: a `select` that forgot to ask for `created_at` would
 * otherwise turn every peer's live row into a sweep target, which is the defect
 * arriving through a typo.
 */
export function isSweepableFixtureRow(
  row: unknown,
  column: string,
  baseLabels: readonly string[],
  nowMs: number = Date.now(),
): boolean {
  const raw = (row as Record<string, unknown> | null)?.[column];
  const value = typeof raw === "string" ? raw : "";
  return decideSweep(scopeAcross(value, baseLabels, classifyFixtureLabel), createdAtMs(row), nowMs);
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

  // isSweepableFixtureUser, NOT matchesFixtureEmail. The difference is the whole
  // 2026-09-05 fix: a matching address belonging to a LIVE concurrent run is
  // recognisably one of ours and still must not be deleted. See its header.
  const now = Date.now();
  const targets = users.filter((u) => isSweepableFixtureUser(u, baseEmails, now));

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

export type RowPurgeOutcome = {
  /** Labels of the rows actually deleted. */
  deleted: string[];
  /** Labels of candidate rows deliberately LEFT ALONE (a live peer's, or undatable). */
  spared: string[];
  /** Rows whose delete — or whose lookup — was REFUSED, with the reason. */
  failed: Array<{ label: string; reason: string }>;
};

/**
 * Sweep ordinary table rows a live suite identifies by a run-scoped label.
 *
 * ── HOW THE CANDIDATES ARE FOUND, AND WHY THE `like` IS ONLY A PREFILTER ────
 * A stranded row carries some OTHER run's id, which this process cannot
 * enumerate, so an `eq`/`in` list cannot reach it — the query has to be a
 * prefix match. PostgREST's `like` has no ESCAPE clause, and `_` is a
 * single-character SQL wildcard, so `rls_hardening_test_private_trip%` matches
 * MORE than it appears to. That is tolerable here and nowhere else, because the
 * pattern only decides which rows are LOOKED AT: `isSweepableFixtureRow` then
 * decides, on the exact string, which may be deleted, and every delete is by
 * primary key. Widening the prefilter can therefore cost a few wasted rows; it
 * can never widen the delete.
 *
 * `created_at` is selected explicitly because the age half of the rule depends
 * on it and a row without it is spared rather than swept.
 *
 * NEVER THROWS, for the same reason `purgeFixtureUsersDetailed` does not: a
 * teardown that throws replaces the failure the test was about to report with
 * one about cleanup.
 */
export async function purgeFixtureRowsDetailed(
  admin: any,
  table: string,
  column: string,
  baseLabels: readonly string[],
  nowMs: number = Date.now(),
): Promise<RowPurgeOutcome> {
  const outcome: RowPurgeOutcome = { deleted: [], spared: [], failed: [] };
  const seen = new Set<string>();

  for (const base of baseLabels) {
    let rows: Array<Record<string, unknown>>;
    try {
      const { data, error } = await admin
        .from(table)
        .select(`id, ${column}, created_at`)
        .like(column, `${base}%`);
      if (error) {
        outcome.failed.push({ label: base, reason: `select ${table}: ${error.message ?? String(error)}` });
        continue;
      }
      rows = (data ?? []) as Array<Record<string, unknown>>;
    } catch (err) {
      outcome.failed.push({ label: base, reason: `select ${table} threw: ${String(err)}` });
      continue;
    }

    for (const row of rows) {
      const id = String(row?.id ?? "");
      if (id === "" || seen.has(id)) continue;
      seen.add(id);

      const label = typeof row?.[column] === "string" ? (row[column] as string) : "";
      if (!isSweepableFixtureRow(row, column, [base], nowMs)) {
        if (label !== "") outcome.spared.push(label);
        continue;
      }

      try {
        const { error } = await admin.from(table).delete().eq("id", id);
        if (error) {
          outcome.failed.push({ label, reason: `delete ${table}: ${error.message ?? String(error)}` });
          continue;
        }
      } catch (err) {
        outcome.failed.push({ label, reason: `delete ${table} threw: ${String(err)}` });
        continue;
      }
      outcome.deleted.push(label);
    }
  }

  return outcome;
}
