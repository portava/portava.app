/**
 * profiles.role is not self-writable — finding 17 (docs/security/admin-authz-audit.md §2)
 *
 * All 33 admin guards authorise by reading `profiles.role`. These tests assert
 * at the DATABASE boundary that the column the guards trust cannot be written
 * by the user it describes.
 *
 * WHY THESE RUN AGAINST A REAL DATABASE
 * -------------------------------------
 * The protections under test are a column-level GRANT and a BEFORE INSERT OR
 * UPDATE trigger. The api-server's fake Supabase clients enforce neither RLS,
 * nor grants, nor triggers, nor FKs. Written against a fake client, tests 2-5
 * would pass unconditionally — they could not fail, and would assert nothing.
 * So this file follows the `rlsHardening.test.ts` pattern: real Supabase,
 * skipped when credentials are absent.
 *
 * READ THIS BEFORE TRUSTING A GREEN RUN
 * -------------------------------------
 * These tests SKIP without credentials, and the repo has no CI that supplies
 * them (no .github/workflows; the `test` script pins SUPABASE_URL to a dead
 * 127.0.0.1:9). A green suite therefore does NOT mean these executed. Run them
 * deliberately:
 *
 *   pnpm run test:profile-role-not-self-writable
 *
 * Every negative test re-reads `role` through the service client afterwards
 * rather than trusting the returned error. An UPDATE that matches zero rows
 * under RLS returns no error at all, so "no error" and "the write happened"
 * are different claims — only the authoritative re-read distinguishes them.
 *
 * Requirements:
 *   SUPABASE_URL                  — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY     — service-role key (fixtures + authoritative reads)
 *   EXPO_PUBLIC_SUPABASE_ANON_KEY — anon key (to build real authenticated sessions)
 */

// ── THE ALLOWLIST ASSERTION, IN THE EXECUTION PATH ───────────────────────────
//
// FIRST import, deliberately, and placed above `@supabase/supabase-js` on
// purpose: ES modules evaluate their imports in source order, so when this
// guard refuses, the Supabase client library is never even loaded — no client
// is constructed, no auth user is created, and profiles.role is never touched.
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
import { purgeFixtureUsers } from "./liveFixtureUsers.js";

// ── Env-var checks ────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const ANON_KEY =
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ??
  process.env.SUPABASE_ANON_KEY ??
  "";

const CREDS_AVAILABLE = Boolean(SUPABASE_URL && SERVICE_ROLE_KEY && ANON_KEY);

if (!CREDS_AVAILABLE) {
  console.warn(
    "\n[profileRoleNotSelfWritable] SKIPPING — no live credentials.\n" +
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

/** Anon client: used to sign in and obtain a real user JWT. */
function anonClient(): SupabaseClient {
  return createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false },
  });
}

/**
 * A client carrying a real user's access token — the Postgres `authenticated`
 * role, exactly what travel-buddy-standalone/src/lib/supabase.ts produces.
 * This is the attacker's position: a normal signed-in app user.
 */
function userClient(accessToken: string): SupabaseClient {
  return createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PREFIX = "role_guard_test_";
const PASSWORD = "test-password-123";

/** The attacker: an ordinary authenticated user attempting to self-elevate. */
let attackerId = "";
let attackerToken = "";
/** The victim: a second real user, target of the cross-user attempt. */
let victimId = "";

/** Authoritative role read — service client, bypasses RLS. */
async function readRole(userId: string): Promise<string | null> {
  const { data, error } = await adminClient()
    .from("profiles")
    .select("role")
    .eq("id", userId)
    .single();
  if (error) throw new Error(`readRole(${userId}): ${error.message}`);
  return (data as { role: string | null }).role;
}

before(async () => {
  if (!CREDS_AVAILABLE) return;
  const admin = adminClient();

  // Heal leftovers from a run that died before its teardown. See
  // liveFixtureUsers.ts — one crashed run otherwise wedges this job red
  // permanently, which is exactly what had happened.
  await purgeFixtureUsers(admin, [
    `${PREFIX}attacker@example.com`,
    `${PREFIX}victim@example.com`,
    `${PREFIX}fresh@example.com`,
  ]);

  const { data: attacker, error: aErr } = await admin.auth.admin.createUser({
    email: `${PREFIX}attacker@example.com`,
    password: PASSWORD,
    email_confirm: true,
  });
  if (aErr) throw new Error(`Setup: create attacker: ${aErr.message}`);
  attackerId = attacker.user.id;

  const { data: victim, error: vErr } = await admin.auth.admin.createUser({
    email: `${PREFIX}victim@example.com`,
    password: PASSWORD,
    email_confirm: true,
  });
  if (vErr) throw new Error(`Setup: create victim: ${vErr.message}`);
  victimId = victim.user.id;

  // handle_new_user() creates the profile rows; ensure the fields we rely on.
  const { error: pErr } = await admin.from("profiles").upsert(
    [
      { id: attackerId, handle: `${PREFIX}attacker`, name: "Role Guard Attacker" },
      { id: victimId, handle: `${PREFIX}victim`, name: "Role Guard Victim" },
    ],
    { onConflict: "id" },
  );
  if (pErr) throw new Error(`Setup: upsert profiles: ${pErr.message}`);

  const { data: signIn, error: sErr } = await anonClient().auth.signInWithPassword({
    email: `${PREFIX}attacker@example.com`,
    password: PASSWORD,
  });
  if (sErr) throw new Error(`Setup: sign in attacker: ${sErr.message}`);
  attackerToken = signIn.session?.access_token ?? "";
  if (!attackerToken) throw new Error("Setup: no access token for attacker");

  // Both fixtures must start at 'user', or the negative tests prove nothing.
  assert.equal(await readRole(attackerId), "user", "fixture attacker must start as 'user'");
  assert.equal(await readRole(victimId), "user", "fixture victim must start as 'user'");
});

after(async () => {
  if (!CREDS_AVAILABLE) return;
  const admin = adminClient();
  // Scoped strictly to the two users this file created. Cascades to profiles.
  if (attackerId) await admin.auth.admin.deleteUser(attackerId);
  if (victimId) await admin.auth.admin.deleteUser(victimId);
});

// ── 1. Not simply locked ──────────────────────────────────────────────────────

describe("1. a user CAN still update permitted profile fields", { skip: !CREDS_AVAILABLE }, () => {
  it("updates bio and name through PostgREST as the row owner", async () => {
    const marker = `role-guard bio ${Date.now()}`;
    const { error } = await userClient(attackerToken)
      .from("profiles")
      .update({ bio: marker, name: "Renamed By Owner" })
      .eq("id", attackerId);

    assert.ifError(error);

    const { data } = await adminClient()
      .from("profiles")
      .select("bio, name")
      .eq("id", attackerId)
      .single();

    // If the fix over-reached into a blanket REVOKE UPDATE, this is what fails.
    assert.equal((data as any).bio, marker, "permitted column bio must still be writable");
    assert.equal((data as any).name, "Renamed By Owner", "permitted column name must still be writable");
  });
});

// ── 2. Self-elevation ─────────────────────────────────────────────────────────

describe("2. a user CANNOT change their own role", { skip: !CREDS_AVAILABLE }, () => {
  it("rejects self-elevation to admin and leaves role unchanged", async () => {
    const { error } = await userClient(attackerToken)
      .from("profiles")
      .update({ role: "admin" })
      .eq("id", attackerId);

    assert.ok(error, "expected the write to be refused at the database boundary");

    // The authoritative check. This is the assertion that actually matters:
    // it fails if the write landed regardless of what the client reported.
    assert.equal(await readRole(attackerId), "user", "role must be unchanged after a self-elevation attempt");
  });
});

// ── 3. Cross-user elevation ───────────────────────────────────────────────────

describe("3. a user CANNOT change another user's role", { skip: !CREDS_AVAILABLE }, () => {
  it("leaves the victim's role unchanged", async () => {
    // RLS (id = auth.uid()) alone would make this match zero rows and return
    // NO error, which is why the re-read below is the real assertion.
    await userClient(attackerToken)
      .from("profiles")
      .update({ role: "admin" })
      .eq("id", victimId);

    assert.equal(await readRole(victimId), "user", "victim's role must be unchanged");
  });
});

// ── 4. The authorised privileged path still works ─────────────────────────────

describe("4. the authorised privileged path CAN change role", { skip: !CREDS_AVAILABLE }, () => {
  it("admin_set_profile_role promotes and demotes via the service role", async () => {
    const admin = adminClient();

    const { error: upErr } = await admin.rpc("admin_set_profile_role", {
      target_user_id: victimId,
      new_role: "admin",
    });
    assert.ifError(upErr);
    assert.equal(await readRole(victimId), "admin", "privileged promotion must succeed");

    const { error: downErr } = await admin.rpc("admin_set_profile_role", {
      target_user_id: victimId,
      new_role: "user",
    });
    assert.ifError(downErr);
    assert.equal(await readRole(victimId), "user", "privileged demotion must succeed");
  });

  it("rejects a role outside ('user','admin')", async () => {
    // 'owner' is accepted by rentABuddyRollout.ts but has zero rows in
    // production. The boundary deliberately does not honour it.
    const { error } = await adminClient().rpc("admin_set_profile_role", {
      target_user_id: victimId,
      new_role: "owner",
    });
    assert.ok(error, "unsupported role must be rejected");
    assert.equal(await readRole(victimId), "user", "role must be unchanged after a rejected value");
  });
});

// ── 5. Alternate write paths — the one that matters ───────────────────────────

describe("5. alternate write paths cannot bypass the boundary", { skip: !CREDS_AVAILABLE }, () => {
  it("5a. direct PostgREST update of role alone is refused", async () => {
    const { error } = await userClient(attackerToken)
      .from("profiles")
      .update({ role: "admin" })
      .eq("id", attackerId);
    assert.ok(error, "direct update must be refused");
    assert.equal(await readRole(attackerId), "user");
  });

  it("5b. role smuggled alongside a permitted column is refused, and the permitted column does not land either", async () => {
    // The subtle one: a partial write would be worse than an outright bypass,
    // because it looks like a successful profile edit.
    const marker = `smuggle-${Date.now()}`;
    const { error } = await userClient(attackerToken)
      .from("profiles")
      .update({ bio: marker, role: "admin" })
      .eq("id", attackerId);

    assert.ok(error, "mixed-column update containing role must be refused");
    assert.equal(await readRole(attackerId), "user", "role must not change");

    const { data } = await adminClient()
      .from("profiles")
      .select("bio")
      .eq("id", attackerId)
      .single();
    assert.notEqual((data as any).bio, marker, "the whole statement must fail atomically, not partially apply");
  });

  it("5c. upsert on an existing row cannot change role", async () => {
    // supabase-js upsert is INSERT ... ON CONFLICT DO UPDATE — a different
    // statement from UPDATE, and historically a common way past column grants.
    const { error } = await userClient(attackerToken)
      .from("profiles")
      .upsert({ id: attackerId, handle: `${PREFIX}attacker`, name: "Upserted", role: "admin" }, { onConflict: "id" });

    assert.ok(error, "upsert carrying role must be refused");
    assert.equal(await readRole(attackerId), "user");
  });

  it("5d. inserting a brand-new profile row with role=admin is refused", async () => {
    // profiles_insert permits `id = auth.uid()`, so without the INSERT branch
    // of the trigger the very first write would be a free role assignment.
    const admin = adminClient();
    const { data: fresh, error: cErr } = await admin.auth.admin.createUser({
      email: `${PREFIX}fresh@example.com`,
      password: PASSWORD,
      email_confirm: true,
    });
    if (cErr) throw new Error(`5d: create fresh user: ${cErr.message}`);
    const freshId = fresh.user.id;

    try {
      // handle_new_user() already made the row; remove it so this is a true INSERT.
      await admin.from("profiles").delete().eq("id", freshId);

      const { data: signIn, error: sErr } = await anonClient().auth.signInWithPassword({
        email: `${PREFIX}fresh@example.com`,
        password: PASSWORD,
      });
      if (sErr) throw new Error(`5d: sign in fresh user: ${sErr.message}`);
      const freshToken = signIn.session?.access_token ?? "";

      const { error } = await userClient(freshToken)
        .from("profiles")
        .insert({ id: freshId, handle: `${PREFIX}fresh`, name: "Fresh", role: "admin" });

      assert.ok(error, "insert carrying role=admin must be refused");

      const { data: after } = await admin
        .from("profiles")
        .select("role")
        .eq("id", freshId)
        .maybeSingle();
      // Either no row (insert refused outright) or a row that is not admin.
      if (after) {
        assert.notEqual((after as any).role, "admin", "a self-inserted row must never be admin");
      }
    } finally {
      await admin.auth.admin.deleteUser(freshId);
    }
  });

  it("5e. the privileged RPC is not callable by an ordinary user", async () => {
    // EXECUTE is granted to service_role only; an authenticated caller must
    // not be able to reach the function that legitimately writes role.
    const { error } = await userClient(attackerToken).rpc("admin_set_profile_role", {
      target_user_id: attackerId,
      new_role: "admin",
    });

    assert.ok(error, "authenticated caller must not be able to execute admin_set_profile_role");
    assert.equal(await readRole(attackerId), "user");
  });

  it("5f. a definer-context RPC does not inherit privilege from being definer", async () => {
    // caller_may_write_profile_role() reads the `role` GUC, which SECURITY
    // DEFINER does not change. Called by an ordinary user it must report false,
    // so no future definer wrapper silently becomes a role-granting path.
    const { data, error } = await userClient(attackerToken).rpc("caller_may_write_profile_role");
    assert.ifError(error);
    assert.equal(data, false, "an authenticated caller must never be treated as privileged");
  });

  it("5g. the service role retains direct table access (the legitimate mechanism)", async () => {
    // The bootstrap path documented in the production runbook must still work,
    // or the fix has broken admin provisioning.
    const admin = adminClient();
    const { error } = await admin.from("profiles").update({ role: "admin" }).eq("id", victimId);
    assert.ifError(error);
    assert.equal(await readRole(victimId), "admin", "service role must retain direct write access");

    const { error: restoreErr } = await admin.from("profiles").update({ role: "user" }).eq("id", victimId);
    assert.ifError(restoreErr);
    assert.equal(await readRole(victimId), "user");
  });
});
