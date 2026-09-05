/**
 * RLS Hardening tests — direct Supabase client reads as unauthorized users.
 *
 * These tests use the real Supabase instance (not a fake client) to verify
 * that Row-Level Security policies block unauthorized access at the database
 * layer, independent of the API server.
 *
 * Requirements:
 *   SUPABASE_URL             — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — service-role key (for inserting test fixtures)
 *   EXPO_PUBLIC_SUPABASE_ANON_KEY — anon key (for testing unauthenticated reads)
 *
 * All tests are skipped when credentials are absent so CI still passes without
 * a live Supabase connection.
 *
 * Run: node --import tsx/esm --env-file-if-exists=.env --test src/test/rlsHardening.test.ts
 */

// ── THE ALLOWLIST ASSERTION, IN THE EXECUTION PATH ───────────────────────────
//
// FIRST import, deliberately, and placed above `@supabase/supabase-js` on
// purpose: ES modules evaluate their imports in source order, so when this
// guard refuses, the Supabase client library is never even loaded — no client
// is constructed, no auth user is created, no query is issued.
//
// It asserts that the project ref resolved from SUPABASE_URL is the one
// sanctioned CI project and exits 2 if it cannot establish that (unset
// allowlist, unparseable URL, and any non-sanctioned ref all refuse).
// .github/scripts/run-live-suite.sh fails this step on any non-zero exit.
//
// It is not a workflow step, so no YAML edit can skip it. This suite is
// reached from live-db.yml's live-db-security-suites job; deleting the
// `Preflight — Supabase target must be the sanctioned CI project` step from
// that job, disabling it with `if:`, moving it after the install step, or
// adding a brand-new job in a brand-new workflow file all still land here,
// because this process cannot start without it.
//
// NOTE ON THE HEADER ABOVE: "All tests are skipped when credentials are absent
// so CI still passes without a live Supabase connection" describes this file's
// behaviour, and that behaviour is a defect, not a feature — it is why
// .github/scripts/run-live-suite.sh scores this suite on its OUTPUT (pass > 0,
// skipped == 0) rather than its exit code. The guard below is a different
// thing again: it refuses to let the process reach an UNSANCTIONED database at
// all, whether or not credentials are complete.
//
// See src/lib/ciSupabaseGuard.mjs and docs/ci/README.md.
import "../lib/ciSupabaseGuard.mjs";

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { fixtureEmail, isSweepableFixtureUser } from "./liveFixtureUsers.js";

// ── Env-var checks ────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const ANON_KEY =
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ??
  process.env.SUPABASE_ANON_KEY ??
  "";

const CREDS_AVAILABLE = Boolean(SUPABASE_URL && SERVICE_ROLE_KEY && ANON_KEY);

// ── Clients ───────────────────────────────────────────────────────────────────

/** Service-role client: bypasses RLS — used for test-fixture setup only. */
function adminClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
}

/** Anon client: no auth — equivalent to an unauthenticated/public request. */
function anonClient(): SupabaseClient {
  return createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false },
  });
}

// ── Test IDs (deterministic so cleanup is reliable) ───────────────────────────

const RLS_TEST_PREFIX = "rls_hardening_test_";

/**
 * THE FIXTURES THIS SUITE OWNS, NAMED IN ONE PLACE.
 *
 * WHY THIS BLOCK EXISTS — the failure it is written against
 * ========================================================
 * On 2026-08-15 this suite reported `tests=15 pass=0 fail=0 skipped=0 exit=1`
 * on every live-DB run in the repository, across unrelated branches, with:
 *
 *     Error: Setup: create userA: A user with this email address has already
 *            been registered
 *
 * Two `CI (live DB)` runs fired on the SAME commit 28 seconds apart (push, then
 * pull_request) and interleaved against the shared CI project. Each created one
 * of the two fixture users and then collided on the other. Both threw — and
 * both threw BEFORE `testProfileIdPrivate` / `testProfileIdPublic` were
 * assigned, because the assignment sat below both throw sites. So `after()` had
 * no id to delete, and each run left one orphaned auth user behind.
 *
 * The emails are deterministic, so those orphans made the collision PERMANENT:
 * every subsequent run, on every branch, failed identically. Recovery required
 * a human deleting rows out of the CI project by hand.
 *
 * That is a self-inflicted instance of the rule this repository already runs on:
 * a failure that destroys the information needed to recover from it. The suite
 * could not clean up after itself precisely BECAUSE it had failed, so the first
 * failure was the last one that meant anything — every run after it reported the
 * same red regardless of the code under test.
 *
 * Two changes, and they are separate:
 *
 *   1. `purgeFixtures()` runs FIRST in `before()`, not only in `after()`. Setup
 *      no longer assumes it is starting from a clean project. A poisoned project
 *      heals on the next run instead of staying poisoned until someone notices.
 *
 *   2. Every created user id is recorded the instant it exists — `createdUserIds`
 *      below — so a throw between two creates still leaves teardown a handle.
 *      Recording after the last throw site is what turned a transient collision
 *      into a permanent one.
 *
 * WHAT THIS DOES NOT FIX, STATED RATHER THAN IMPLIED
 * =================================================
 * It does not make the suite concurrency-safe. Two runs overlapping will still
 * interfere: the second one's purge deletes the first one's live fixtures. What
 * changes is that the damage is no longer PERMANENT — the next run sweeps and
 * proceeds, instead of every future run failing on a leftover row. The real
 * remedy is one live-DB run at a time; that is a workflow-trigger question
 * (`live-db.yml` fires on both `push` and `pull_request`), and it is deliberately
 * not decided here. Note that a naive `concurrency:` group is NOT a safe fix on
 * its own: `live DB · verdict` fails on a cancelled run by design, so cancelling
 * a superseded run would trade this failure for a different red.
 */
const FIXTURE_EMAILS = [
  fixtureEmail(`${RLS_TEST_PREFIX}private@example.com`),
  fixtureEmail(`${RLS_TEST_PREFIX}public@example.com`),
] as const;

const FIXTURE_HANDLES = [`${RLS_TEST_PREFIX}private`, `${RLS_TEST_PREFIX}public`] as const;
const FIXTURE_EVENT_TITLE = `${RLS_TEST_PREFIX}private_event`;
const FIXTURE_TRIP_TITLE = `${RLS_TEST_PREFIX}private_trip`;

/**
 * Every auth user THIS process created, appended the instant the id exists.
 * Teardown deletes these in addition to whatever the email sweep finds, so a
 * user created moments before an unrelated failure is still cleaned up.
 */
const createdUserIds: string[] = [];

/**
 * Bound on the `listUsers` sweep. Exceeding it THROWS rather than returning a
 * partial answer: a sweep that quietly stopped early would report "no orphans"
 * having looked at a fraction of the project, which is the same shape of lie
 * this whole block exists to remove.
 */
const MAX_USER_PAGES = 20;
const USERS_PER_PAGE = 1000;

/**
 * Ids of any auth user this suite is ALLOWED TO DELETE.
 *
 * The decision is delegated to isSweepableFixtureUser, which is the same one
 * purgeFixtureUsers makes, so there is one answer to "may I delete this" rather
 * than two that can disagree. It covers this run's `+r<run>`-scoped addresses
 * at any age, and a stranded variant from another run only once that account is
 * old enough that no live run can still own it.
 *
 * This used to match on address ALONE (matchesFixtureEmail), which swept a
 * concurrent run's live fixtures out from under it — measured 2026-09-05, five
 * suites red across two overlapping runs. See liveFixtureUsers.ts.
 */
async function findFixtureUserIds(admin: SupabaseClient): Promise<string[]> {
  const found: string[] = [];
  const now = Date.now();

  for (let page = 1; page <= MAX_USER_PAGES; page++) {
    const { data, error } = await admin.auth.admin.listUsers({
      page,
      perPage: USERS_PER_PAGE,
    });
    if (error) throw new Error(`purgeFixtures: listUsers page ${page}: ${error.message}`);

    const users = data?.users ?? [];
    for (const u of users) {
      if (isSweepableFixtureUser(u, FIXTURE_EMAILS, now)) found.push(u.id);
    }
    // A short page is the last page.
    if (users.length < USERS_PER_PAGE) return found;
  }

  throw new Error(
    `purgeFixtures: listUsers exceeded ${MAX_USER_PAGES} pages of ${USERS_PER_PAGE}. ` +
      `Refusing to report a partial sweep as a clean one.`,
  );
}

/**
 * Remove every row this suite owns, whether this process created it or a
 * previous crashed run left it. Safe to call on a clean project.
 *
 * Deletion order follows the FK chain: trips and events reference profiles,
 * profiles hang off auth users. Matched by EXACT value, never by a LIKE
 * pattern — `_` is a single-character wildcard in SQL LIKE, so
 * `rls_hardening_test_%` matches far more than it appears to.
 */
async function purgeFixtures(admin: SupabaseClient): Promise<void> {
  const { error: tErr } = await admin.from("trips").delete().eq("title", FIXTURE_TRIP_TITLE);
  if (tErr) throw new Error(`purgeFixtures: delete trips: ${tErr.message}`);

  const { error: eErr } = await admin.from("events").delete().eq("title", FIXTURE_EVENT_TITLE);
  if (eErr) throw new Error(`purgeFixtures: delete events: ${eErr.message}`);

  // Deleting the auth user cascades to its profile, but a profile whose user is
  // already gone would keep the unique handle and break the upsert below.
  const { error: pErr } = await admin
    .from("profiles")
    .delete()
    .in("handle", [...FIXTURE_HANDLES]);
  if (pErr) throw new Error(`purgeFixtures: delete profiles: ${pErr.message}`);

  const ids = new Set<string>([...(await findFixtureUserIds(admin)), ...createdUserIds]);
  for (const id of ids) {
    const { error } = await admin.auth.admin.deleteUser(id);
    // Already gone is the desired end state, not a failure.
    if (error && !/not.?found/i.test(error.message)) {
      throw new Error(`purgeFixtures: deleteUser ${id}: ${error.message}`);
    }
  }
  createdUserIds.length = 0;
}

/** Create one fixture user, recording its id BEFORE anything else can throw. */
async function createFixtureUser(admin: SupabaseClient, email: string): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: "test-password-123",
    email_confirm: true,
  });
  if (error) throw new Error(`Setup: create ${email}: ${error.message}`);
  const id = data.user.id;
  createdUserIds.push(id);
  return id;
}

/** IDs that we'll insert and then clean up */
let testProfileIdPrivate: string;
let testProfileIdPublic: string;
let testEventIdPrivate: string;
let testTripIdPrivate: string;

// ── Setup / teardown ──────────────────────────────────────────────────────────

before(async () => {
  if (!CREDS_AVAILABLE) return;

  const admin = adminClient();

  // Start from a known-empty state rather than assuming one. This is the line
  // that heals a project poisoned by an earlier crashed run.
  await purgeFixtures(admin);

  // ── Create two auth users for test profiles ──────────────────────────────
  testProfileIdPrivate = await createFixtureUser(admin, FIXTURE_EMAILS[0]);
  testProfileIdPublic = await createFixtureUser(admin, FIXTURE_EMAILS[1]);

  // ── Upsert profile rows (auto-created by trigger, but set is_private) ────
  const { error: pErr } = await admin.from("profiles").upsert([
    {
      id: testProfileIdPrivate,
      handle: FIXTURE_HANDLES[0],
      name: "RLS Test Private",
      is_private: true,
    },
    {
      id: testProfileIdPublic,
      handle: FIXTURE_HANDLES[1],
      name: "RLS Test Public",
      is_private: false,
    },
  ]);
  if (pErr) throw new Error(`Setup: upsert profiles: ${pErr.message}`);

  // ── Create a private event hosted by the private profile ─────────────────
  const { data: ev, error: evErr } = await admin
    .from("events")
    .insert({
      host_id: testProfileIdPrivate,
      title: FIXTURE_EVENT_TITLE,
      visibility: "invite_only",
      state: "open",
    })
    .select("id")
    .single();
  if (evErr) throw new Error(`Setup: create event: ${evErr.message}`);
  testEventIdPrivate = ev.id;

  // ── Create a private trip owned by the private profile ───────────────────
  const { data: tr, error: trErr } = await admin
    .from("trips")
    .insert({
      owner_id: testProfileIdPrivate,
      title: FIXTURE_TRIP_TITLE,
      destination_city: "Testville",
      visibility: "private",
      status: "planning",
    })
    .select("id")
    .single();
  if (trErr) throw new Error(`Setup: create trip: ${trErr.message}`);
  testTripIdPrivate = tr.id;
});

after(async () => {
  if (!CREDS_AVAILABLE) return;

  const admin = adminClient();

  // Delete by id where we have one — the narrowest possible match, and the only
  // way to remove rows whose title a concurrent run may since have reused.
  if (testTripIdPrivate) {
    await admin.from("trips").delete().eq("id", testTripIdPrivate);
  }
  if (testEventIdPrivate) {
    await admin.from("events").delete().eq("id", testEventIdPrivate);
  }

  // Then the identity sweep, which is what runs when setup threw and there are
  // no ids to delete by. `node:test` runs `after` even when `before` throws,
  // which is the whole reason this is reachable on the failure path.
  //
  // It must not throw: a teardown that fails masks the real failure with its
  // own, and the next run's `before()` purge is the backstop. Report and move on.
  try {
    await purgeFixtures(admin);
  } catch (err) {
    console.error(
      `rlsHardening teardown: purgeFixtures failed — the next run's setup purge ` +
        `is expected to clear this: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("RLS hardening — unauthenticated (anon) reads", { skip: !CREDS_AVAILABLE }, () => {
  it("anon read of a private profile row returns empty", async () => {
    const { data, error } = await anonClient()
      .from("profiles")
      .select("id")
      .eq("id", testProfileIdPrivate);

    assert.ifError(error);
    assert.deepEqual(
      data,
      [],
      "RLS should block anon access to private profile"
    );
  });

  it("anon read of a public profile row is allowed", async () => {
    const { data, error } = await anonClient()
      .from("profiles")
      .select("id")
      .eq("id", testProfileIdPublic);

    assert.ifError(error);
    assert.ok(
      data && data.length === 1,
      "Anon should see public profiles"
    );
  });

  it("anon read of a private (invite_only) event returns empty", async () => {
    const { data, error } = await anonClient()
      .from("events")
      .select("id")
      .eq("id", testEventIdPrivate);

    assert.ifError(error);
    assert.deepEqual(
      data,
      [],
      "RLS should block anon access to private event"
    );
  });

  it("anon read of a private trip returns empty", async () => {
    const { data, error } = await anonClient()
      .from("trips")
      .select("id")
      .eq("id", testTripIdPrivate);

    assert.ifError(error);
    assert.deepEqual(
      data,
      [],
      "RLS should block anon access to private trip"
    );
  });

  it("anon read of notifications table returns empty", async () => {
    const { data, error } = await anonClient()
      .from("notifications")
      .select("id")
      .limit(5);

    assert.ifError(error);
    assert.deepEqual(data, [], "Anon must not read any notifications rows");
  });

  it("anon read of trip_members returns empty", async () => {
    const { data, error } = await anonClient()
      .from("trip_members")
      .select("trip_id")
      .eq("trip_id", testTripIdPrivate);

    assert.ifError(error);
    assert.deepEqual(
      data,
      [],
      "RLS should block anon access to trip_members of a private trip"
    );
  });

  it("anon read of event_attendees returns empty", async () => {
    const { data, error } = await anonClient()
      .from("event_attendees")
      .select("event_id")
      .eq("event_id", testEventIdPrivate);

    assert.ifError(error);
    assert.deepEqual(
      data,
      [],
      "RLS should block anon access to event_attendees"
    );
  });

  it("anon read of user_follows returns empty", async () => {
    const { data, error } = await anonClient()
      .from("user_follows")
      .select("follower_id")
      .limit(5);

    assert.ifError(error);
    assert.deepEqual(data, [], "Anon must not read user_follows rows");
  });

  it("anon read of user_friendships returns empty", async () => {
    const { data, error } = await anonClient()
      .from("user_friendships")
      .select("user_a")
      .limit(5);

    assert.ifError(error);
    assert.deepEqual(data, [], "Anon must not read user_friendships rows");
  });
});

describe("RLS hardening — wrong-user (signed-in non-member) reads", { skip: !CREDS_AVAILABLE }, () => {
  /**
   * Sign in as the *public* test user (who has no relationship with the
   * private event / trip) and verify they cannot read those rows.
   *
   * Signs in ONCE and reuses the session across every `it()` below, rather
   * than re-authenticating per test. This describe block used to call
   * signInWithPassword fresh in all six tests — six real password sign-ins
   * for the same fixture account within a couple of seconds — which is
   * exactly the shape Supabase Auth's sign-in rate limit throttles. Observed
   * live 2026-08-20 (CI run 32333778070): 14/15 rlsHardening tests passed,
   * one `it()` in this block failed with `Error: Test sign-in failed: {}` —
   * an intermittent flake, not a deterministic failure (later runs against
   * the same project passed 15/15). Caching the signed-in client cuts this
   * block's sign-in calls from six to one; it is still a real password
   * sign-in producing a real session, not a fabricated/injected token.
   */
  let publicUserClientPromise: Promise<SupabaseClient> | null = null;
  function publicUserClient(): Promise<SupabaseClient> {
    if (!publicUserClientPromise) {
      publicUserClientPromise = (async () => {
        const client = createClient(SUPABASE_URL, ANON_KEY, {
          auth: { persistSession: false },
        });
        const { error } = await client.auth.signInWithPassword({
          email: fixtureEmail(`${RLS_TEST_PREFIX}public@example.com`),
          password: "test-password-123",
        });
        if (error) throw new Error(`Test sign-in failed: ${error.message}`);
        return client;
      })();
    }
    return publicUserClientPromise;
  }

  it("non-member authenticated user cannot read private event row", async () => {
    const client = await publicUserClient();
    const { data, error } = await client
      .from("events")
      .select("id")
      .eq("id", testEventIdPrivate);

    assert.ifError(error);
    assert.deepEqual(
      data,
      [],
      "Non-member signed-in user should not see private event"
    );
  });

  it("non-member authenticated user cannot read private trip row", async () => {
    const client = await publicUserClient();
    const { data, error } = await client
      .from("trips")
      .select("id")
      .eq("id", testTripIdPrivate);

    assert.ifError(error);
    assert.deepEqual(
      data,
      [],
      "Non-member signed-in user should not see private trip"
    );
  });

  it("non-member cannot read trip_members of a private trip", async () => {
    const client = await publicUserClient();
    const { data, error } = await client
      .from("trip_members")
      .select("trip_id")
      .eq("trip_id", testTripIdPrivate);

    assert.ifError(error);
    assert.deepEqual(
      data,
      [],
      "Non-member should not read trip_members of a private trip"
    );
  });

  it("non-member cannot read event_attendees of a private event", async () => {
    const client = await publicUserClient();
    const { data, error } = await client
      .from("event_attendees")
      .select("event_id")
      .eq("event_id", testEventIdPrivate);

    assert.ifError(error);
    assert.deepEqual(
      data,
      [],
      "Non-member should not read event_attendees of a private event"
    );
  });

  it("authenticated user cannot read another user's notifications", async () => {
    const client = await publicUserClient();
    const { data, error } = await client
      .from("notifications")
      .select("id")
      .eq("user_id", testProfileIdPrivate);

    assert.ifError(error);
    assert.deepEqual(
      data,
      [],
      "Authenticated user must not read another user's notifications"
    );
  });

  it("private profile is hidden from non-friend signed-in user", async () => {
    const client = await publicUserClient();
    const { data, error } = await client
      .from("profiles")
      .select("id")
      .eq("id", testProfileIdPrivate);

    assert.ifError(error);
    assert.deepEqual(
      data,
      [],
      "Private profile must be hidden from non-friend authenticated user"
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// auth.uid() RESOLUTION — THE POSITIVE CONTROL
//
// WHY THIS BLOCK EXISTS
//
// Every assertion above this point is NEGATIVE: anon cannot read X, a
// signed-in non-member cannot read Y. That is the right shape for a hardening
// suite, but it has a blind spot that matters more than it looks.
//
// If PostgREST failed to verify the session JWT and auth.uid() returned NULL
// for an AUTHENTICATED request, every one of those tests would still pass —
// the signed-in user would see nothing, which is exactly what "cannot read"
// asserts. The suite would go green while RLS was, in effect, denying
// everyone. A green run therefore does not distinguish "RLS is correctly
// scoping the caller" from "auth.uid() is broken and nobody can see anything".
//
// That distinction became load-bearing on 2026-08-28: replit.md records that
// after Supabase rotated this project's JWT signing key to ES256/EC P-256,
// "PostgREST hasn't fully picked up the new key so auth.uid() returns NULL and
// RLS fails", which is why trip creation was routed through the API server on
// the service-role key. Roughly 100 migrations' worth of policies depend on
// auth.uid(). Whether that note is stale or still true cannot be read off the
// negative tests, so this block asserts the positive directly.
//
// THE DISCRIMINATOR
//
// The private fixture profile is already proven unreadable by anon ("anon read
// of a private profile row returns empty") and by a different signed-in user
// ("private profile is hidden from non-friend signed-in user"). So if its OWNER
// can read it, the only thing that can have made the difference is auth.uid()
// resolving to that owner. One row back = auth.uid() is non-NULL AND matches
// the authenticated identity. Zero rows back = auth.uid() did not resolve, and
// this suite's other 15 passes were vacuous.
// ─────────────────────────────────────────────────────────────────────────────

describe("auth.uid() resolution — positive control", { skip: !CREDS_AVAILABLE }, () => {
  let privateUserClientPromise: Promise<SupabaseClient> | null = null;
  function privateUserClient(): Promise<SupabaseClient> {
    if (!privateUserClientPromise) {
      privateUserClientPromise = (async () => {
        const client = createClient(SUPABASE_URL, ANON_KEY, {
          auth: { persistSession: false },
        });
        const { error } = await client.auth.signInWithPassword({
          email: fixtureEmail(`${RLS_TEST_PREFIX}private@example.com`),
          password: "test-password-123",
        });
        if (error) throw new Error(`Test sign-in failed: ${error.message}`);
        return client;
      })();
    }
    return privateUserClientPromise;
  }

  it("owner CAN read their own private profile — auth.uid() resolves and matches the session", async () => {
    const client = await privateUserClient();

    const { data: userData, error: userErr } = await client.auth.getUser();
    assert.ifError(userErr);
    const sessionUserId = userData?.user?.id;
    assert.ok(sessionUserId, "Signed-in session carried no user id");

    const { data, error } = await client
      .from("profiles")
      .select("id")
      .eq("id", testProfileIdPrivate);

    assert.ifError(error);
    assert.equal(
      data?.length,
      1,
      "auth.uid() did NOT resolve: the owner could not read their own private " +
        "profile row. Every negative assertion in this suite is vacuous when " +
        "this fails — RLS is denying everyone, not scoping the caller."
    );
    assert.equal(
      data?.[0]?.id,
      sessionUserId,
      "auth.uid() resolved to an identity other than the authenticated user"
    );
    assert.equal(
      data?.[0]?.id,
      testProfileIdPrivate,
      "Returned row is not the fixture's private profile"
    );
  });

  it("anon control — the same row is invisible without a session", async () => {
    const { data, error } = await anonClient()
      .from("profiles")
      .select("id")
      .eq("id", testProfileIdPrivate);

    assert.ifError(error);
    assert.deepEqual(
      data,
      [],
      "Anon must not read the private profile row. If this returns a row, the " +
        "positive test above proves nothing about auth.uid()."
    );
  });
});
