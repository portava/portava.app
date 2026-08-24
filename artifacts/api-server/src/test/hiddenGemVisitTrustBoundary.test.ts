/**
 * hiddenGemVisitTrustBoundary.test.ts — hidden_gem_visits.trust_level server-ownership.
 *
 * RED before migration 2154, GREEN after. Verified on portava-ci: pre-2154 an
 * authenticated user could INSERT a visit with trust_level='gps_verified' with no
 * GPS check (verification inflation — 5 such visits upgrade a gem). Post-2154 a
 * client may still record a MANUAL self-visit but cannot set/forge trust_level;
 * it defaults to 'manual'.
 *
 * trust_level, is_suspicious and distance_m are set by the GPS-verification
 * service (service-role). 2154 revokes the broad table-level grant and re-grants
 * authenticated INSERT only on the content columns (gem_id, user_id, latitude,
 * longitude, visited_at) + SELECT (own visits). No client UPDATE (there is no
 * UPDATE policy either), so a manual visit cannot later be escalated.
 *
 * Live-DB suite. Run: node --import tsx/esm --test src/test/hiddenGemVisitTrustBoundary.test.ts
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
if (!CREDS_AVAILABLE) console.warn("\n[hiddenGemVisitTrustBoundary] SKIPPING — no live credentials.\n");

function adminClient(): SupabaseClient { return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } }); }
function anonClient(): SupabaseClient { return createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } }); }
function userClient(t: string): SupabaseClient {
  return createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${t}` } } });
}

const PREFIX = "hgv_trust_test_";
const PASSWORD = "test-password-123";
const TABLE = "hidden_gem_visits";
let ownerId = "", ownerToken = "", strangerId = "", gemId = "", gem2Id = "";
const gemIds: string[] = [];

async function makeUser(tag: string): Promise<{ id: string; token: string }> {
  const sc = adminClient();
  const email = `${PREFIX}${tag}@example.com`;
  const { data: c, error: cErr } = await sc.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (cErr || !c?.user) throw new Error(`createUser(${tag}): ${cErr?.message}`);
  const id = c.user.id;
  const { error: pErr } = await sc.from("profiles").upsert({ id, handle: `${PREFIX}${tag}`, username: `${PREFIX}${tag}`, name: `hgv ${tag}` }, { onConflict: "id" });
  if (pErr) throw new Error(`profile(${tag}): ${pErr.message}`);
  const { data: s, error: sErr } = await anonClient().auth.signInWithPassword({ email, password: PASSWORD });
  if (sErr || !s?.session) throw new Error(`signIn(${tag}): ${sErr?.message}`);
  return { id, token: s.session.access_token };
}
async function makeGem(): Promise<string> {
  const { data, error } = await adminClient().from("hidden_gems").insert({ name: "g", category: "food", city: "Cebu", submitted_by: ownerId, status: "active" }).select("id").single();
  if (error) throw new Error(`fixture gem: ${error.message}`);
  const id = (data as any).id; gemIds.push(id); return id;
}
async function readVisit(gem: string, user: string): Promise<any | null> {
  const { data } = await adminClient().from(TABLE).select("*").eq("gem_id", gem).eq("user_id", user).maybeSingle();
  return data ?? null;
}

before(async () => {
  if (!CREDS_AVAILABLE) return;
  await purgeFixtureUsers(adminClient(), [`${PREFIX}owner@example.com`, `${PREFIX}stranger@example.com`]);
  ({ id: ownerId, token: ownerToken } = await makeUser("owner"));
  ({ id: strangerId } = await makeUser("stranger"));
  gemId = await makeGem();
  gem2Id = await makeGem();
});
after(async () => {
  if (!CREDS_AVAILABLE) return;
  const sc = adminClient();
  for (const g of gemIds) await sc.from(TABLE).delete().eq("gem_id", g);
  for (const g of gemIds) await sc.from("hidden_gems").delete().eq("id", g);
  for (const id of [ownerId, strangerId]) if (id) { await sc.from(TABLE).delete().eq("user_id", id); await sc.from("profiles").delete().eq("id", id); await sc.auth.admin.deleteUser(id); }
});

function assertDenied(error: any, what: string): void {
  assert.ok(error, `${what}: expected a permission error, got success`);
  const code = String(error.code ?? ""); const msg = String(error.message ?? "").toLowerCase();
  assert.ok(code === "42501" || msg.includes("permission denied"), `${what}: expected 42501, got code=${code} msg=${error.message}`);
}

describe("hidden_gem_visits trust_level server-ownership", { skip: !CREDS_AVAILABLE }, () => {
  it("a client CAN record a manual self-visit, which defaults to trust_level=manual", async () => {
    const { error } = await userClient(ownerToken).from(TABLE).insert({ gem_id: gemId, user_id: ownerId, latitude: 10.3, longitude: 123.9 });
    assert.ifError(error);
    assert.equal((await readVisit(gemId, ownerId))?.trust_level, "manual", "a client visit must default to manual");
  });
  it("a client cannot INSERT a visit with trust_level='gps_verified'", async () => {
    const { error } = await userClient(ownerToken).from(TABLE).insert({ gem_id: gem2Id, user_id: ownerId, trust_level: "gps_verified" });
    assertDenied(error, "explicit gps_verified");
    assert.equal(await readVisit(gem2Id, ownerId), null, "no forged visit must exist");
  });
  it("a client cannot forge the other server-owned fields (is_suspicious, distance_m)", async () => {
    const { error } = await userClient(ownerToken).from(TABLE).insert({ gem_id: gem2Id, user_id: ownerId, is_suspicious: false, distance_m: 0 });
    assertDenied(error, "server fields");
  });
  it("a client cannot INSERT a visit for another user", async () => {
    const { error } = await userClient(ownerToken).from(TABLE).insert({ gem_id: gem2Id, user_id: strangerId });
    assertDenied(error, "cross-user");
  });
  it("a client cannot INSERT a manual visit and then UPDATE trust_level to gps_verified", async () => {
    // The manual visit from the first test exists (gemId, ownerId).
    const { error } = await userClient(ownerToken).from(TABLE).update({ trust_level: "gps_verified" }).eq("gem_id", gemId).eq("user_id", ownerId);
    assertDenied(error, "update-escalation");
    assert.equal((await readVisit(gemId, ownerId))?.trust_level, "manual", "the visit must remain manual");
  });
  it("anon cannot write visits", async () => {
    const { error } = await anonClient().from(TABLE).insert({ gem_id: gem2Id, user_id: ownerId, trust_level: "gps_verified" });
    assert.ok(error, "anon must not write");
  });
  it("the service role can still write gps_verified visits (the GPS path + 5-confirmation input)", async () => {
    const g = await makeGem();
    const users: string[] = [];
    for (let i = 0; i < 5; i++) { const u = await makeUser(`v${i}`); users.push(u.id); }
    const rows = users.map((u) => ({ gem_id: g, user_id: u, trust_level: "gps_verified", distance_m: 5, is_suspicious: false }));
    const { error } = await adminClient().from(TABLE).insert(rows);
    assert.ifError(error);
    const { data } = await adminClient().from(TABLE).select("id").eq("gem_id", g).eq("trust_level", "gps_verified");
    assert.equal((data ?? []).length, 5, "the service role must be able to seed the 5 gps_verified confirmations");
    for (const u of users) { await adminClient().from(TABLE).delete().eq("user_id", u); await adminClient().from("profiles").delete().eq("id", u); await adminClient().auth.admin.deleteUser(u); }
  });
});
