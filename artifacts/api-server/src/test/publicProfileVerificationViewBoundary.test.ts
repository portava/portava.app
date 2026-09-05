/**
 * publicProfileVerificationViewBoundary.test.ts — the public_profile_verification view boundary.
 *
 * RED before migration 2162, GREEN after. On CI the view had drifted to
 * security_invoker=FALSE (SECURITY DEFINER) over profiles, owned by postgres,
 * with anon+authenticated DML — so executing as owner it BYPASSED profiles RLS:
 * a stranger/anon could UPDATE verification_status='verified' onto ANY profile
 * through the view, and could read verification for profiles profiles_select
 * hides. 2162 converges CI onto production's already-correct state:
 * security_invoker=true AND service_role-only (REVOKE ALL from anon+authenticated,
 * no SELECT re-granted). Verified read-only on production 2026-08-24 — prod is
 * exactly this, and the app reads verification via service-role routes, never a
 * direct anon/authenticated view read.
 *
 * (Companion: 2163 adds the profiles trigger that closes self-verification of
 * one's OWN row — see profileVerificationSelfWriteBoundary.test.ts.)
 *
 * Live-DB suite: kept out of the curated npm test list; run by the live-DB job.
 * Run: node --import tsx/esm --test src/test/publicProfileVerificationViewBoundary.test.ts
 */
import "../lib/ciSupabaseGuard.mjs";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { purgeFixtureUsers, fixtureEmail } from "./liveFixtureUsers.js";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY ?? "";
const CREDS_AVAILABLE = Boolean(SUPABASE_URL && SERVICE_ROLE_KEY && ANON_KEY);
if (!CREDS_AVAILABLE) console.warn("\n[publicProfileVerificationViewBoundary] SKIPPING — no live credentials.\n");

function adminClient(): SupabaseClient { return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } }); }
function anonClient(): SupabaseClient { return createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } }); }
function userClient(t: string): SupabaseClient {
  return createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${t}` } } });
}

const PREFIX = "ppv_view_test_";
const PASSWORD = "test-password-123";
const VIEW = "public_profile_verification";
let publicUserId = "", strangerId = "", strangerToken = "";

async function makeUser(tag: string, isPrivate: boolean): Promise<string> {
  const sc = adminClient();
  const email = fixtureEmail(`${PREFIX}${tag}@example.com`);
  const { data: c, error: cErr } = await sc.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (cErr || !c?.user) throw new Error(`createUser(${tag}): ${cErr?.message}`);
  const id = c.user.id;
  const { error: pErr } = await sc.from("profiles").upsert({ id, handle: `${PREFIX}${tag}`, username: `${PREFIX}${tag}`, name: `ppv ${tag}`, is_private: isPrivate }, { onConflict: "id" });
  if (pErr) throw new Error(`profile(${tag}): ${pErr.message}`);
  return id;
}
async function baseStatus(id: string): Promise<string | null> {
  const { data } = await adminClient().from("profiles").select("verification_status").eq("id", id).maybeSingle();
  return data ? (data as any).verification_status : null;
}
function assertNoData(error: any, data: any, what: string): void {
  // Service-role-only view: anon/authenticated have no privilege → a permission
  // error, or (defensively) an empty set. Never the row.
  assert.ok(error || (data ?? []).length === 0, `${what}: anon/authenticated must not read the view (got ${(data ?? []).length} row(s), error=${error?.message ?? "none"})`);
}

before(async () => {
  if (!CREDS_AVAILABLE) return;
  await purgeFixtureUsers(adminClient(), [fixtureEmail(`${PREFIX}public@example.com`), fixtureEmail(`${PREFIX}stranger@example.com`)]);
  publicUserId = await makeUser("public", false);
  strangerId = await makeUser("stranger", false);
  const { data: s, error } = await anonClient().auth.signInWithPassword({ email: fixtureEmail(`${PREFIX}stranger@example.com`), password: PASSWORD });
  if (error || !s?.session) throw new Error(`signIn(stranger): ${error?.message}`);
  strangerToken = s.session.access_token;
  const { error: vErr } = await adminClient().from("profiles")
    .update({ verification_status: "verified", verification_level: "trusted_traveler", verified_since: new Date().toISOString(), host_verified_at: new Date().toISOString() })
    .eq("id", publicUserId);
  if (vErr) throw new Error(`fixture verify public user: ${vErr.message}`);
});
after(async () => {
  if (!CREDS_AVAILABLE) return;
  await purgeFixtureUsers(adminClient(), [fixtureEmail(`${PREFIX}public@example.com`), fixtureEmail(`${PREFIX}stranger@example.com`)]);
});

describe("public_profile_verification view boundary", { skip: !CREDS_AVAILABLE }, () => {
  it("a stranger CANNOT forge verification on another profile through the view", async () => {
    const before = await baseStatus(strangerId);
    const { error } = await userClient(strangerToken).from(VIEW)
      .update({ verification_status: "verified", verification_level: "trusted_traveler" }).eq("profile_id", publicUserId);
    assert.ok(error, "a write through the service-role-only view must be refused");
    assert.equal(await baseStatus(strangerId), before, "no base verification may change");
  });
  it("anon CANNOT write through the view", async () => {
    const { error } = await anonClient().from(VIEW).update({ verification_status: "verified" }).eq("profile_id", publicUserId);
    assert.ok(error, "anon write through the view must be refused");
  });
  it("an authenticated user CANNOT read the view at all (service-role-only, matches prod)", async () => {
    const { data, error } = await userClient(strangerToken).from(VIEW).select("profile_id, verification_status").eq("profile_id", publicUserId);
    assertNoData(error, data, "authenticated view read");
  });
  it("anon CANNOT read the view", async () => {
    const { data, error } = await anonClient().from(VIEW).select("profile_id, verification_status").eq("profile_id", publicUserId);
    assertNoData(error, data, "anon view read");
  });
  it("the service role CAN read the view and it reflects base verification", async () => {
    const { data, error } = await adminClient().from(VIEW).select("profile_id, verification_status, host_verified").eq("profile_id", publicUserId).maybeSingle();
    assert.ifError(error);
    assert.ok(data, "service role must read the view");
    assert.equal((data as any).verification_status, "verified");
    assert.equal((data as any).host_verified, true, "computed badge column must reflect host_verified_at");
  });
});
