/**
 * profileVerificationSelfWriteBoundary.test.ts — profiles verification columns are not self-writable.
 *
 * RED before migration 2163, GREEN after. profiles grants anon+authenticated
 * TABLE-LEVEL INSERT/UPDATE, so the nine platform-verification columns
 * (verification_status, verification_level, verified_since, id_verified_at,
 * selfie_verified_at, home_country_verified_at, host_verified_at,
 * buddy_verified_at, safety_flags_count) were client-writable; profiles_update
 * RLS (id=auth.uid()) let a user self-verify their OWN row directly. 2163 adds a
 * BEFORE INSERT OR UPDATE trigger — mirroring the existing role / is_official
 * guards, gated by caller_may_write_profile_role() — that rejects a non-default
 * insert or any change to these columns by a non-privileged caller (42501), while
 * leaving normal profile content edits and default signups untouched.
 *
 * Boundary test — real database, skipped without credentials (see
 * profileRoleNotSelfWritable.test.ts for why a skip is not a pass).
 * Run: node --import tsx/esm --test src/test/profileVerificationSelfWriteBoundary.test.ts
 */
import "../lib/ciSupabaseGuard.mjs";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { purgeFixtureUsers, fixtureEmail, fixtureLabel } from "./liveFixtureUsers.js";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY ?? "";
const CREDS_AVAILABLE = Boolean(SUPABASE_URL && SERVICE_ROLE_KEY && ANON_KEY);
if (!CREDS_AVAILABLE) console.warn("\n[profileVerificationSelfWriteBoundary] SKIPPING — no live credentials.\n");

function adminClient(): SupabaseClient { return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } }); }
function anonClient(): SupabaseClient { return createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } }); }
function userClient(t: string): SupabaseClient {
  return createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${t}` } } });
}

const PREFIX = "verif_guard_test_";
const PASSWORD = "test-password-123";
let attackerId = "", attackerToken = "", victimId = "";

async function makeUser(tag: string): Promise<{ id: string; token: string }> {
  const sc = adminClient();
  const email = fixtureEmail(`${PREFIX}${tag}@example.com`);
  const { data: c, error: cErr } = await sc.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (cErr || !c?.user) throw new Error(`createUser(${tag}): ${cErr?.message}`);
  const id = c.user.id;
  const { error: pErr } = await sc.from("profiles").upsert({ id, handle: fixtureLabel(`${PREFIX}${tag}`), username: fixtureLabel(`${PREFIX}${tag}`), name: `vg ${tag}` }, { onConflict: "id" });
  if (pErr) throw new Error(`profile(${tag}): ${pErr.message}`);
  const { data: s, error: sErr } = await anonClient().auth.signInWithPassword({ email, password: PASSWORD });
  if (sErr || !s?.session) throw new Error(`signIn(${tag}): ${sErr?.message}`);
  return { id, token: s.session.access_token };
}
async function readVerification(id: string): Promise<{ status: string; level: string; id_verified_at: string | null }> {
  const { data, error } = await adminClient().from("profiles").select("verification_status, verification_level, id_verified_at").eq("id", id).single();
  if (error) throw new Error(`readVerification(${id}): ${error.message}`);
  return { status: (data as any).verification_status, level: (data as any).verification_level, id_verified_at: (data as any).id_verified_at };
}

before(async () => {
  if (!CREDS_AVAILABLE) return;
  await purgeFixtureUsers(adminClient(), [fixtureEmail(`${PREFIX}attacker@example.com`), fixtureEmail(`${PREFIX}victim@example.com`), fixtureEmail(`${PREFIX}fresh@example.com`)]);
  ({ id: attackerId, token: attackerToken } = await makeUser("attacker"));
  ({ id: victimId } = await makeUser("victim"));
  assert.equal((await readVerification(attackerId)).status, "unverified", "fixture must start unverified");
});
after(async () => {
  if (!CREDS_AVAILABLE) return;
  await purgeFixtureUsers(adminClient(), [fixtureEmail(`${PREFIX}attacker@example.com`), fixtureEmail(`${PREFIX}victim@example.com`), fixtureEmail(`${PREFIX}fresh@example.com`)]);
});

describe("profiles verification columns are not self-writable", { skip: !CREDS_AVAILABLE }, () => {
  it("a user CAN still edit permitted profile fields", async () => {
    const marker = `verif-guard bio ${Date.now()}`;
    const { error } = await userClient(attackerToken).from("profiles").update({ bio: marker, name: "Renamed" }).eq("id", attackerId);
    assert.ifError(error);
    const { data } = await adminClient().from("profiles").select("bio").eq("id", attackerId).single();
    assert.equal((data as any).bio, marker, "permitted column must still be writable (fix must not over-reach)");
  });
  it("a user CANNOT self-set verification_status", async () => {
    const { error } = await userClient(attackerToken).from("profiles").update({ verification_status: "verified" }).eq("id", attackerId);
    assert.ok(error, "self-verification must be refused at the database boundary");
    assert.equal((await readVerification(attackerId)).status, "unverified", "status must be unchanged");
  });
  it("a user CANNOT self-set verification_level or id_verified_at", async () => {
    const { error: e1 } = await userClient(attackerToken).from("profiles").update({ verification_level: "trusted_traveler" }).eq("id", attackerId);
    assert.ok(e1, "verification_level self-set must be refused");
    const { error: e2 } = await userClient(attackerToken).from("profiles").update({ id_verified_at: new Date().toISOString() }).eq("id", attackerId);
    assert.ok(e2, "id_verified_at self-set must be refused");
    const v = await readVerification(attackerId);
    assert.equal(v.level, "none");
    assert.equal(v.id_verified_at, null);
  });
  it("verification smuggled alongside a permitted column is refused, and the permitted column does not land either", async () => {
    const marker = `smuggle-${Date.now()}`;
    const { error } = await userClient(attackerToken).from("profiles").update({ bio: marker, verification_status: "verified" }).eq("id", attackerId);
    assert.ok(error, "mixed-column update containing verification must be refused");
    assert.equal((await readVerification(attackerId)).status, "unverified", "status must not change");
    const { data } = await adminClient().from("profiles").select("bio").eq("id", attackerId).single();
    assert.notEqual((data as any).bio, marker, "the statement must fail atomically, not partially apply");
  });
  it("a user CANNOT self-verify via upsert on their existing row", async () => {
    const { error } = await userClient(attackerToken).from("profiles")
      .upsert({ id: attackerId, handle: fixtureLabel(`${PREFIX}attacker`), name: "Upserted", verification_status: "verified" }, { onConflict: "id" });
    assert.ok(error, "upsert carrying verification must be refused");
    assert.equal((await readVerification(attackerId)).status, "unverified");
  });
  it("a user CANNOT change another user's verification (cross-user)", async () => {
    // RLS (id=auth.uid()) matches zero rows and returns no error — the re-read is the real assertion.
    await userClient(attackerToken).from("profiles").update({ verification_status: "verified" }).eq("id", victimId);
    assert.equal((await readVerification(victimId)).status, "unverified", "victim's verification must be unchanged");
  });
  it("a fresh signup inserting default verification is allowed; forged verification at insert is refused", async () => {
    const admin = adminClient();
    const { data: fresh, error: cErr } = await admin.auth.admin.createUser({ email: fixtureEmail(`${PREFIX}fresh@example.com`), password: PASSWORD, email_confirm: true });
    if (cErr) throw new Error(`fresh: ${cErr.message}`);
    const freshId = fresh.user.id;
    try {
      await admin.from("profiles").delete().eq("id", freshId); // handle_new_user made the row; make this a true INSERT
      const { data: s } = await anonClient().auth.signInWithPassword({ email: fixtureEmail(`${PREFIX}fresh@example.com`), password: PASSWORD });
      const freshToken = s!.session!.access_token;
      // default insert (no verification columns) must succeed
      const { error: okErr } = await userClient(freshToken).from("profiles").insert({ id: freshId, handle: fixtureLabel(`${PREFIX}fresh`), name: "Fresh" });
      assert.ifError(okErr);
      // now a forged-verification insert on a second fresh id must be refused
      await admin.from("profiles").delete().eq("id", freshId);
      const { error: forgeErr } = await userClient(freshToken).from("profiles")
        .insert({ id: freshId, handle: fixtureLabel(`${PREFIX}fresh`), name: "Fresh", verification_status: "verified", verification_level: "trusted_traveler" });
      assert.ok(forgeErr, "insert carrying verified status must be refused");
      const { data: after } = await admin.from("profiles").select("verification_status").eq("id", freshId).maybeSingle();
      if (after) assert.notEqual((after as any).verification_status, "verified", "a self-inserted row must not be verified");
    } finally {
      await admin.auth.admin.deleteUser(freshId);
    }
  });
  it("the service role retains direct verification write (the legitimate mechanism)", async () => {
    const admin = adminClient();
    const { error } = await admin.from("profiles")
      .update({ verification_status: "verified", verification_level: "trusted_traveler", verified_since: new Date().toISOString() }).eq("id", victimId);
    assert.ifError(error);
    assert.equal((await readVerification(victimId)).status, "verified", "service role must retain verification write access");
    await admin.from("profiles").update({ verification_status: "unverified", verification_level: "none", verified_since: null }).eq("id", victimId);
  });
});
