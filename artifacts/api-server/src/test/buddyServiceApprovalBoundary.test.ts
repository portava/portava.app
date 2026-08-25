/**
 * buddyServiceApprovalBoundary.test.ts — the buddy_services approval boundary.
 *
 * RED before migration 2155, GREEN after. Verified on portava-ci: pre-2155 a
 * buddy self-set approved=true on their own service listing (1 row), injecting it
 * into the public marketplace (bs_public_read exposes is_active=true AND
 * approved=true) without admin review. Post-2155 approved/approved_at fail 42501,
 * while the owner's listing CONTENT stays writable.
 *
 * approved is the platform's admin-review gate. The review path uses the
 * service-role client; a direct PostgREST write with the public anon key must not
 * set it. 2155 grants authenticated column INSERT/UPDATE on the content columns
 * only. Ownership is keyed through rent_buddy_profiles.user_id = auth.uid().
 *
 * Live-DB suite: kept out of the curated npm test list; run by the live-DB job.
 * Run: node --import tsx/esm --test src/test/buddyServiceApprovalBoundary.test.ts
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
if (!CREDS_AVAILABLE) console.warn("\n[buddyServiceApprovalBoundary] SKIPPING — no live credentials.\n");

function adminClient(): SupabaseClient { return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } }); }
function anonClient(): SupabaseClient { return createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } }); }
function userClient(t: string): SupabaseClient {
  return createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${t}` } } });
}

const PREFIX = "buddy_svc_test_";
const PASSWORD = "test-password-123";
const TABLE = "buddy_services";
let ownerId = "", ownerToken = "", ownerBuddyId = "", strangerBuddyId = "", svcId = "";

async function makeBuddy(tag: string): Promise<{ id: string; token: string; buddyId: string }> {
  const sc = adminClient();
  const email = `${PREFIX}${tag}@example.com`;
  const { data: c, error: cErr } = await sc.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (cErr || !c?.user) throw new Error(`createUser(${tag}): ${cErr?.message}`);
  const id = c.user.id;
  const { error: pErr } = await sc.from("profiles").upsert({ id, handle: `${PREFIX}${tag}`, username: `${PREFIX}${tag}`, name: `bs ${tag}` }, { onConflict: "id" });
  if (pErr) throw new Error(`profile(${tag}): ${pErr.message}`);
  const { data: rb, error: rbErr } = await sc.from("rent_buddy_profiles").insert({ user_id: id, city: "Cebu" }).select("id").single();
  if (rbErr || !rb) throw new Error(`rent_buddy_profiles(${tag}): ${rbErr?.message}`);
  const { data: s, error: sErr } = await anonClient().auth.signInWithPassword({ email, password: PASSWORD });
  if (sErr || !s?.session) throw new Error(`signIn(${tag}): ${sErr?.message}`);
  return { id, token: s.session.access_token, buddyId: (rb as any).id };
}
async function readSvc(id: string): Promise<any | null> {
  const { data } = await adminClient().from(TABLE).select("*").eq("id", id).maybeSingle();
  return data ?? null;
}

before(async () => {
  if (!CREDS_AVAILABLE) return;
  await purgeFixtureUsers(adminClient(), [`${PREFIX}owner@example.com`, `${PREFIX}stranger@example.com`]);
  ({ id: ownerId, token: ownerToken, buddyId: ownerBuddyId } = await makeBuddy("owner"));
  ({ buddyId: strangerBuddyId } = await makeBuddy("stranger"));
  const { data, error } = await adminClient().from(TABLE)
    .insert({ buddy_id: ownerBuddyId, category: "guide", title: "City walk", description: "orig", hourly_rate_usd: 20, is_active: true, approved: false })
    .select("id").single();
  if (error) throw new Error(`fixture: could not seed service: ${error.message}`);
  svcId = (data as any).id;
  assert.equal((await readSvc(svcId))?.approved, false);
});
after(async () => {
  if (!CREDS_AVAILABLE) return;
  const sc = adminClient();
  for (const b of [ownerBuddyId, strangerBuddyId]) if (b) await sc.from(TABLE).delete().eq("buddy_id", b);
  for (const b of [ownerBuddyId, strangerBuddyId]) if (b) await sc.from("rent_buddy_profiles").delete().eq("id", b);
  await purgeFixtureUsers(sc, [`${PREFIX}owner@example.com`, `${PREFIX}stranger@example.com`]);
});

function assertDenied(error: any, what: string): void {
  assert.ok(error, `${what}: expected a permission error, got success — the boundary is open`);
  const code = String(error.code ?? ""); const msg = String(error.message ?? "").toLowerCase();
  assert.ok(code === "42501" || msg.includes("permission denied"), `${what}: expected 42501, got code=${code} msg=${error.message}`);
}

describe("buddy_services approval boundary", { skip: !CREDS_AVAILABLE }, () => {
  it("owner cannot self-approve their own service", async () => {
    const { error } = await userClient(ownerToken).from(TABLE).update({ approved: true }).eq("id", svcId);
    assertDenied(error, "self-approve");
    assert.equal((await readSvc(svcId))?.approved, false);
  });
  it("owner cannot self-set approved_at", async () => {
    const { error } = await userClient(ownerToken).from(TABLE).update({ approved_at: new Date().toISOString() }).eq("id", svcId);
    assertDenied(error, "approved_at");
    assert.equal((await readSvc(svcId))?.approved_at, null);
  });
  it("a mixed content+approval UPDATE fails atomically", async () => {
    const { error } = await userClient(ownerToken).from(TABLE).update({ title: "Renamed", approved: true }).eq("id", svcId);
    assertDenied(error, "mixed");
    const s = await readSvc(svcId);
    assert.equal(s?.approved, false);
    assert.equal(s?.title, "City walk", "content change must not apply either");
  });
  it("owner CAN edit service content (title, hourly_rate_usd, is_active)", async () => {
    const { error } = await userClient(ownerToken).from(TABLE).update({ title: "Sunset walk", hourly_rate_usd: 30, is_active: false }).eq("id", svcId);
    assert.ifError(error);
    const s = await readSvc(svcId);
    assert.equal(s?.title, "Sunset walk");
    assert.equal(Number(s?.hourly_rate_usd), 30);
  });
  it("owner CAN create own service, but it is unapproved and cannot forge approval", async () => {
    const uc = userClient(ownerToken);
    const { data, error } = await uc.from(TABLE).insert({ buddy_id: ownerBuddyId, category: "guide", title: "New svc" }).select("id, approved").single();
    assert.ifError(error);
    assert.notEqual((data as any)?.approved, true, "a self-inserted service must not be approved");
    await adminClient().from(TABLE).delete().eq("id", (data as any).id);
    const { error: fErr } = await uc.from(TABLE).insert({ buddy_id: ownerBuddyId, category: "guide", title: "forge", approved: true });
    assertDenied(fErr, "insert-forge approved");
  });
  it("owner cannot approve another buddy's service", async () => {
    const { data: other } = await adminClient().from(TABLE).insert({ buddy_id: strangerBuddyId, category: "guide", title: "theirs" }).select("id").single();
    const otherId = (other as any).id;
    const { error } = await userClient(ownerToken).from(TABLE).update({ approved: true }).eq("id", otherId);
    if (!error) assert.notEqual((await readSvc(otherId))?.approved, true);
    await adminClient().from(TABLE).delete().eq("id", otherId);
  });
  it("the service role can still approve a service", async () => {
    const { error } = await adminClient().from(TABLE).update({ approved: true, approved_at: new Date().toISOString() }).eq("id", svcId);
    assert.ifError(error);
    assert.equal((await readSvc(svcId))?.approved, true);
    // and the approved service becomes publicly readable
    await adminClient().from(TABLE).update({ is_active: true }).eq("id", svcId);
    const { data } = await anonClient().from(TABLE).select("id").eq("id", svcId).eq("approved", true).eq("is_active", true);
    assert.equal((data ?? []).length, 1, "anon must read an approved+active service");
  });
  it("anon cannot write", async () => {
    const { error } = await anonClient().from(TABLE).update({ approved: true }).eq("id", svcId);
    assert.ok(error, "anon must not write");
  });
});
