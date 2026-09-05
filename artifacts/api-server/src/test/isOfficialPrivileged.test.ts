/**
 * profiles.is_official is privileged in BOTH directions — migration 2079
 *
 * `is_official` gates publisher surfaces (Portava editorial feed, the official
 * badge). Two defects in the guard that protected it, both found by probing the
 * control rather than reading it:
 *
 *   1. `enforce_is_official_service_role()` tested `current_setting('role')`
 *      alone. On a direct postgres connection that GUC is 'none', so it REJECTED
 *      legitimate superuser administration — while telling the operator "only
 *      the service role may do this", which is false from where they stand. Since
 *      no application path writes this column at all, direct DB access was the
 *      only way to grant official status, and it was the path being refused.
 *
 *   2. It fired only on false->true. true->false was unguarded, so — with
 *      migration 2078 having re-granted `authenticated` column UPDATE on all
 *      non-`role` columns, and RLS permitting `id = auth.uid()` — an official
 *      account holder could clear their own badge and could NOT restore it.
 *
 * WHY THESE RUN AGAINST A REAL DATABASE
 * -------------------------------------
 * The protection is a BEFORE INSERT OR UPDATE trigger. The api-server's fake
 * Supabase clients enforce no triggers, no RLS and no grants — against a fake
 * client every negative test here would pass unconditionally and assert nothing.
 * Same pattern as `rlsHardening.test.ts` and `profileRoleNotSelfWritable.test.ts`.
 *
 * READ THIS BEFORE TRUSTING A GREEN RUN
 * -------------------------------------
 * These tests SKIP without credentials, and this repo has no CI that supplies
 * them (finding 18; the `test` script pins SUPABASE_URL to a dead 127.0.0.1:9).
 * A green suite does NOT mean these ran. Run them deliberately:
 *
 *   pnpm run test:is-official-privileged
 *
 * Every negative test re-reads `is_official` through the service client instead
 * of trusting the returned error. A PostgREST UPDATE matching zero rows under
 * RLS returns no error at all, so "no error" and "the write landed" are
 * different claims; only the authoritative re-read separates them.
 *
 * Requirements:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, EXPO_PUBLIC_SUPABASE_ANON_KEY
 */

// ── THE ALLOWLIST ASSERTION, IN THE EXECUTION PATH ───────────────────────────
//
// FIRST import, deliberately, and placed above `@supabase/supabase-js` on
// purpose: ES modules evaluate their imports in source order, so when this
// guard refuses, the Supabase client library is never even loaded — no client
// is constructed, no auth user is created, and profiles.is_official is never
// touched.
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
// See src/lib/ciSupabaseGuard.mjs and docs/ci/README.md.
import "../lib/ciSupabaseGuard.mjs";

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { purgeFixtureUsers, fixtureEmail } from "./liveFixtureUsers.js";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const ANON_KEY =
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ??
  process.env.SUPABASE_ANON_KEY ??
  "";

const CREDS_AVAILABLE = Boolean(SUPABASE_URL && SERVICE_ROLE_KEY && ANON_KEY);

if (!CREDS_AVAILABLE) {
  console.warn(
    "\n[isOfficialPrivileged] SKIPPING — no live credentials.\n" +
      "  These are database-boundary tests; without a real database they\n" +
      "  cannot fail and prove nothing. A skip is not a pass.\n",
  );
}

// ── Clients ───────────────────────────────────────────────────────────────────

/** Service-role client: bypasses RLS. Fixtures + authoritative verification. */
function adminClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
}

/** A client carrying a real user's JWT — the Postgres `authenticated` role. */
function userClient(accessToken: string): SupabaseClient {
  return createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PREFIX = "is_official_guard_test_";
const PASSWORD = "test-password-123";

/** An ordinary user who is NOT official — tries to award themselves the badge. */
let plainId = "";
let plainToken = "";
/** A user the service role marks official — tries to clear their OWN badge. */
let officialId = "";
let officialToken = "";

/** Authoritative read — service client, bypasses RLS and the trigger. */
async function readOfficial(userId: string): Promise<boolean | null> {
  const { data, error } = await adminClient()
    .from("profiles")
    .select("is_official")
    .eq("id", userId)
    .single();
  if (error) throw new Error(`readOfficial(${userId}): ${error.message}`);
  return (data as { is_official: boolean | null }).is_official;
}

/**
 * Force the badge back to true via the privileged path.
 *
 * Called at the start of every test that needs it, because these tests share
 * one fixture and must not depend on each other's outcomes. Without this, a
 * test asserting "the badge is still true" passes whenever an EARLIER test
 * failed to clear it — and fails when an earlier test succeeded, reporting the
 * wrong defect at the wrong line. That is exactly what happened on the first
 * pre-migration run: the cross-user test failed because the self-demotion test
 * had already cleared the badge, not because any cross-user write landed.
 */
async function ensureBadge(): Promise<void> {
  const { error } = await adminClient()
    .from("profiles")
    .update({ is_official: true })
    .eq("id", officialId);
  if (error) throw new Error(`ensureBadge: ${error.message}`);
  assert.equal(await readOfficial(officialId), true, "ensureBadge: badge not restored");
}

async function makeUser(tag: string): Promise<{ id: string; token: string }> {
  const sc = adminClient();
  const email = fixtureEmail(`${PREFIX}${tag}@example.com`);
  const { data: created, error: cErr } = await sc.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  });
  if (cErr || !created?.user) throw new Error(`createUser(${tag}): ${cErr?.message}`);
  const id = created.user.id;

  const { error: pErr } = await sc.from("profiles").insert({
    id,
    handle: `${PREFIX}${tag}`,
    username: `${PREFIX}${tag}`,
    name: `is_official guard ${tag}`,
  });
  if (pErr) throw new Error(`profile(${tag}): ${pErr.message}`);

  const anon = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false },
  });
  const { data: session, error: sErr } = await anon.auth.signInWithPassword({
    email,
    password: PASSWORD,
  });
  if (sErr || !session?.session) throw new Error(`signIn(${tag}): ${sErr?.message}`);
  return { id, token: session.session.access_token };
}

before(async () => {
  if (!CREDS_AVAILABLE) return;

  // Heal leftovers from a run that died before its teardown. Without this, one
  // crashed run makes every subsequent run fail in this hook with "A user with
  // this email address has already been registered" — a self-perpetuating red
  // that no code change can clear.
  await purgeFixtureUsers(adminClient(), [
    fixtureEmail(`${PREFIX}plain@example.com`),
    fixtureEmail(`${PREFIX}official@example.com`),
    // Created mid-test with finally-cleanup; they leak only when a run crashes
    // before teardown, which is exactly the state that wedges the next run red.
    fixtureEmail(`${PREFIX}normal@example.com`),
    fixtureEmail(`${PREFIX}fresh@example.com`),
  ]);

  ({ id: plainId, token: plainToken } = await makeUser("plain"));
  ({ id: officialId, token: officialToken } = await makeUser("official"));

  // Grant the badge via the privileged path so the demotion tests have a
  // true->false transition to attempt. If this fails the suite is meaningless,
  // so fail loudly here rather than letting later tests pass vacuously.
  const { error } = await adminClient()
    .from("profiles")
    .update({ is_official: true })
    .eq("id", officialId);
  if (error) throw new Error(`fixture: service role could not grant badge: ${error.message}`);
  assert.equal(await readOfficial(officialId), true, "fixture: badge was not granted");
});

after(async () => {
  if (!CREDS_AVAILABLE) return;
  const sc = adminClient();
  for (const id of [plainId, officialId]) {
    if (!id) continue;
    await sc.from("profiles").delete().eq("id", id);
    await sc.auth.admin.deleteUser(id);
  }
});

describe("1. an ordinary user CANNOT award themselves the official badge", { skip: !CREDS_AVAILABLE }, () => {
  it("false -> true via supabase-js is refused", async () => {
    await userClient(plainToken)
      .from("profiles")
      .update({ is_official: true })
      .eq("id", plainId);
    assert.equal(
      await readOfficial(plainId),
      false,
      "ESCALATION: a user granted themselves the official badge",
    );
  });

  it("false -> true via raw PostgREST PATCH is refused", async () => {
    await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${plainId}`, {
      method: "PATCH",
      headers: {
        apikey: ANON_KEY,
        Authorization: `Bearer ${plainToken}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify({ is_official: true }),
    });
    assert.equal(
      await readOfficial(plainId),
      false,
      "ESCALATION: raw PostgREST bypassed the is_official guard",
    );
  });
});

describe("2. an official account holder CANNOT clear their own badge", { skip: !CREDS_AVAILABLE }, () => {
  // This is the direction the old trigger did not guard. Before 2079 this
  // succeeded, and the holder could not restore the badge afterwards.
  it("true -> false by the badge holder is refused", async () => {
    await ensureBadge();
    await userClient(officialToken)
      .from("profiles")
      .update({ is_official: false })
      .eq("id", officialId);
    assert.equal(
      await readOfficial(officialId),
      true,
      "INTEGRITY GAP: the holder cleared their own official badge",
    );
  });

  it("true -> false via raw PostgREST PATCH is refused", async () => {
    await ensureBadge();
    await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${officialId}`, {
      method: "PATCH",
      headers: {
        apikey: ANON_KEY,
        Authorization: `Bearer ${officialToken}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify({ is_official: false }),
    });
    assert.equal(await readOfficial(officialId), true, "INTEGRITY GAP: raw PostgREST cleared the badge");
  });
});

describe("3. a user CANNOT change another user's badge", { skip: !CREDS_AVAILABLE }, () => {
  it("cross-user write is refused", async () => {
    await ensureBadge();
    await userClient(plainToken)
      .from("profiles")
      .update({ is_official: false })
      .eq("id", officialId);
    assert.equal(await readOfficial(officialId), true, "LATERAL: another user cleared the badge");
  });
});

describe("4. the sanctioned path still works in BOTH directions", { skip: !CREDS_AVAILABLE }, () => {
  // The point of 2079 is not to lock the column — it is to make the privileged
  // path work where it previously did not. A test that only proved refusal
  // would be satisfied by a column nobody can write.
  it("service role can revoke and re-grant", async () => {
    await ensureBadge();
    const sc = adminClient();

    const { error: revokeErr } = await sc
      .from("profiles")
      .update({ is_official: false })
      .eq("id", officialId);
    assert.equal(revokeErr, null, `privileged revoke failed: ${revokeErr?.message}`);
    assert.equal(await readOfficial(officialId), false, "privileged revoke did not apply");

    const { error: grantErr } = await sc
      .from("profiles")
      .update({ is_official: true })
      .eq("id", officialId);
    assert.equal(grantErr, null, `privileged re-grant failed: ${grantErr?.message}`);
    assert.equal(await readOfficial(officialId), true, "privileged re-grant did not apply");
  });
});

describe("5. an ordinary INSERT carrying is_official is refused", { skip: !CREDS_AVAILABLE }, () => {
  // profiles_insert permits WITH CHECK (id = auth.uid()), so a user whose
  // profile does not yet exist gets one free INSERT. Without an INSERT guard
  // that first write would be a free badge.
  it("self-INSERT with is_official=true does not yield a badge", async () => {
    const sc = adminClient();
    const email = fixtureEmail(`${PREFIX}fresh@example.com`);
    const { data: created, error: cErr } = await sc.auth.admin.createUser({
      email,
      password: PASSWORD,
      email_confirm: true,
    });
    if (cErr || !created?.user) throw new Error(`createUser(fresh): ${cErr?.message}`);
    const freshId = created.user.id;

    try {
      const anon = createClient(SUPABASE_URL, ANON_KEY, {
        auth: { persistSession: false },
      });
      const { data: session } = await anon.auth.signInWithPassword({ email, password: PASSWORD });
      const token = session!.session!.access_token;

      await userClient(token).from("profiles").insert({
        id: freshId,
        handle: `${PREFIX}fresh`,
        username: `${PREFIX}fresh`,
        name: "is_official guard fresh",
        is_official: true,
      });

      const { data } = await sc
        .from("profiles")
        .select("is_official")
        .eq("id", freshId)
        .maybeSingle();
      const got = (data as { is_official: boolean } | null)?.is_official ?? null;
      assert.ok(
        got === null || got === false,
        `ESCALATION: self-INSERT produced is_official=${got}`,
      );
    } finally {
      await sc.from("profiles").delete().eq("id", freshId);
      await sc.auth.admin.deleteUser(freshId);
    }
  });

  it("an ordinary signup INSERT (is_official omitted) is NOT blocked", async () => {
    // Guard the guard: if the INSERT branch rejected normal signups, every
    // account creation would break. Proves the trigger is not simply denying.
    const sc = adminClient();
    const email = fixtureEmail(`${PREFIX}normal@example.com`);
    const { data: created, error: cErr } = await sc.auth.admin.createUser({
      email,
      password: PASSWORD,
      email_confirm: true,
    });
    if (cErr || !created?.user) throw new Error(`createUser(normal): ${cErr?.message}`);
    const normalId = created.user.id;

    try {
      const anon = createClient(SUPABASE_URL, ANON_KEY, {
        auth: { persistSession: false },
      });
      const { data: session } = await anon.auth.signInWithPassword({ email, password: PASSWORD });
      const token = session!.session!.access_token;

      const { error } = await userClient(token).from("profiles").insert({
        id: normalId,
        handle: `${PREFIX}normal`,
        username: `${PREFIX}normal`,
        name: "is_official guard normal",
      });
      assert.equal(error, null, `ordinary signup INSERT was blocked: ${error?.message}`);
      assert.equal(await readOfficial(normalId), false, "ordinary signup should be non-official");
    } finally {
      await sc.from("profiles").delete().eq("id", normalId);
      await sc.auth.admin.deleteUser(normalId);
    }
  });
});
