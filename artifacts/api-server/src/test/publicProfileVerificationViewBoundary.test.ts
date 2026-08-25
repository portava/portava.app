/**
 * publicProfileVerificationViewBoundary.test.ts — the public_profile_verification view boundary.
 *
 * RED before migration 2162, GREEN after. Verified on portava-ci: pre-2162
 * public.public_profile_verification was a security_invoker=FALSE (SECURITY
 * DEFINER) view over profiles, owned by postgres, with anon+authenticated DML.
 * Because it executed as owner it BYPASSED profiles RLS: a stranger could UPDATE
 * verification_status='verified' onto ANY profile through the view (the direct
 * base UPDATE is RLS-blocked), and could read the verification of profiles that
 * profiles_select would hide (private / non-friend). Post-2162 the view is
 * security_invoker=true and SELECT-only: cross-user/anon forgery is denied, the
 * private-profile read leak is closed, and public badge reads still work.
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
import { purgeFixtureUsers } from "./liveFixtureUsers.js";

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
// victim = private profile; publicUser = public profile; stranger = attacker (not a friend of either)
let victimId = "", publicUserId = "", strangerId = "", strangerToken = "";

async function makeUser(tag: string, isPrivate: boolean): Promise<string> {
  const sc = adminClient();
  const email = `${PREFIX}${tag}@example.com`;
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

before(async () => {
  if (!CREDS_AVAILABLE) return;
  await purgeFixtureUsers(adminClient(), [`${PREFIX}victim@example.com`, `${PREFIX}public@example.com`, `${PREFIX}stranger@example.com`]);
  victimId = await makeUser("victim", true);
  publicUserId = await makeUser("public", false);
  strangerId = await makeUser("stranger", false);
  // stranger's token
  const { data: s, error } = await anonClient().auth.signInWithPassword({ email: `${PREFIX}stranger@example.com`, password: PASSWORD });
  if (error || !s?.session) throw new Error(`signIn(stranger): ${error?.message}`);
  strangerToken = s.session.access_token;
  // service-role verifies the PUBLIC user (legit), so the view should surface it publicly
  const { error: vErr } = await adminClient().from("profiles")
    .update({ verification_status: "verified", verification_level: "trusted_traveler", verified_since: new Date().toISOString(), host_verified_at: new Date().toISOString() })
    .eq("id", publicUserId);
  if (vErr) throw new Error(`fixture verify public user: ${vErr.message}`);
});
after(async () => {
  if (!CREDS_AVAILABLE) return;
  await purgeFixtureUsers(adminClient(), [`${PREFIX}victim@example.com`, `${PREFIX}public@example.com`, `${PREFIX}stranger@example.com`]);
});

describe("public_profile_verification view boundary", { skip: !CREDS_AVAILABLE }, () => {
  it("a stranger CANNOT forge verification on another profile through the view", async () => {
    const before = await baseStatus(victimId);
    const { error } = await userClient(strangerToken).from(VIEW)
      .update({ verification_status: "verified", verification_level: "trusted_traveler" }).eq("profile_id", victimId);
    assert.ok(error, "the view is SELECT-only; a write must be refused");
    assert.equal(await baseStatus(victimId), before, "victim's base verification must be unchanged");
  });
  it("anon CANNOT forge verification through the view", async () => {
    const { error } = await anonClient().from(VIEW).update({ verification_status: "verified" }).eq("profile_id", publicUserId);
    assert.ok(error, "anon write through the view must be refused");
  });
  it("the private-profile read leak is closed (stranger cannot see a private profile's verification)", async () => {
    const { data, error } = await userClient(strangerToken).from(VIEW).select("profile_id, verification_status").eq("profile_id", victimId);
    assert.ifError(error);
    assert.equal((data ?? []).length, 0, "a private, non-friend profile must not be visible through the invoker view");
  });
  it("a public profile's verified badge IS visible through the view (authenticated)", async () => {
    const { data, error } = await userClient(strangerToken).from(VIEW).select("profile_id, verification_status, host_verified").eq("profile_id", publicUserId).maybeSingle();
    assert.ifError(error);
    assert.ok(data, "a public profile's verification must be visible");
    assert.equal((data as any).verification_status, "verified");
    assert.equal((data as any).host_verified, true, "computed badge column must reflect host_verified_at");
  });
  it("anon can read a public profile's verified badge", async () => {
    const { data, error } = await anonClient().from(VIEW).select("profile_id, verification_status").eq("profile_id", publicUserId).maybeSingle();
    assert.ifError(error);
    assert.equal((data as any)?.verification_status, "verified", "anon must still read public badges");
  });
  it("the service role can verify a profile and the view reflects it", async () => {
    const sc = adminClient();
    const { error } = await sc.from("profiles").update({ verification_status: "verified", verification_level: "basic_verified" }).eq("id", victimId);
    assert.ifError(error);
    // read the view as the owner (victim) — the owner always sees their own row (profiles_select id=auth.uid())
    const { data } = await sc.from(VIEW).select("verification_status").eq("profile_id", victimId).maybeSingle();
    assert.equal((data as any)?.verification_status, "verified", "service-role verification must be reflected in the view");
    await sc.from("profiles").update({ verification_status: "unverified", verification_level: "none" }).eq("id", victimId);
  });
});
