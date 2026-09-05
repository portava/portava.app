/**
 * discoveryPlaceWriteBoundary.test.ts — the discovery_places client-write boundary.
 *
 * RED before migration 2153, GREEN after. Verified on portava-ci: pre-2153 an
 * authenticated user could INSERT a discovery place with verified=true,
 * status='active' (injected into the public Discovery feed) and even attribute it
 * to another user (submitter impersonation) — the RLS INSERT policy only checks
 * auth.uid() IS NOT NULL. Post-2153 all client INSERT/UPDATE/DELETE fail 42501,
 * while the authorized public read (status='active') and the service-role write
 * path still work.
 *
 * Every legitimate discovery_places write is service-role (trackOsmPlaceSave and
 * the visuals/compass services); there is no user-facing submit route. 2153 makes
 * anon+authenticated SELECT-only.
 *
 * Live-DB suite. Run: node --import tsx/esm --test src/test/discoveryPlaceWriteBoundary.test.ts
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
if (!CREDS_AVAILABLE) console.warn("\n[discoveryPlaceWriteBoundary] SKIPPING — no live credentials.\n");

function adminClient(): SupabaseClient { return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } }); }
function anonClient(): SupabaseClient { return createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } }); }
function userClient(t: string): SupabaseClient {
  return createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${t}` } } });
}

const PREFIX = "disc_place_test_";
const PASSWORD = "test-password-123";
const TABLE = "discovery_places";
let ownerId = "", ownerToken = "", strangerId = "", placeId = "";

async function makeUser(tag: string): Promise<{ id: string; token: string }> {
  const sc = adminClient();
  const email = fixtureEmail(`${PREFIX}${tag}@example.com`);
  const { data: c, error: cErr } = await sc.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (cErr || !c?.user) throw new Error(`createUser(${tag}): ${cErr?.message}`);
  const id = c.user.id;
  const { error: pErr } = await sc.from("profiles").upsert({ id, handle: `${PREFIX}${tag}`, username: `${PREFIX}${tag}`, name: `dp ${tag}` }, { onConflict: "id" });
  if (pErr) throw new Error(`profile(${tag}): ${pErr.message}`);
  const { data: s, error: sErr } = await anonClient().auth.signInWithPassword({ email, password: PASSWORD });
  if (sErr || !s?.session) throw new Error(`signIn(${tag}): ${sErr?.message}`);
  return { id, token: s.session.access_token };
}
async function readPlace(id: string): Promise<any | null> {
  const { data } = await adminClient().from(TABLE).select("*").eq("id", id).maybeSingle();
  return data ?? null;
}

before(async () => {
  if (!CREDS_AVAILABLE) return;
  await purgeFixtureUsers(adminClient(), [fixtureEmail(`${PREFIX}owner@example.com`), fixtureEmail(`${PREFIX}stranger@example.com`)]);
  ({ id: ownerId, token: ownerToken } = await makeUser("owner"));
  ({ id: strangerId } = await makeUser("stranger"));
  const { data, error } = await adminClient().from(TABLE)
    .insert({ name: "svc active", place_type: "restaurant", submitted_by: ownerId, verified: true, status: "active" })
    .select("id").single();
  if (error) throw new Error(`fixture: could not seed place: ${error.message}`);
  placeId = (data as any).id;
});
after(async () => {
  if (!CREDS_AVAILABLE) return;
  const sc = adminClient();
  if (placeId) await sc.from(TABLE).delete().eq("id", placeId);
  await sc.from(TABLE).delete().in("submitted_by", [ownerId, strangerId]);
  for (const id of [ownerId, strangerId]) if (id) { await sc.from("profiles").delete().eq("id", id); await sc.auth.admin.deleteUser(id); }
});

function assertDenied(error: any, what: string): void {
  assert.ok(error, `${what}: expected a permission error, got success — the boundary is open`);
  const code = String(error.code ?? ""); const msg = String(error.message ?? "").toLowerCase();
  assert.ok(code === "42501" || msg.includes("permission denied"), `${what}: expected 42501, got code=${code} msg=${error.message}`);
}

describe("discovery_places client-write boundary", { skip: !CREDS_AVAILABLE }, () => {
  it("authenticated cannot INSERT a forged verified+active place", async () => {
    const { error } = await userClient(ownerToken).from(TABLE)
      .insert({ name: "forged", place_type: "restaurant", submitted_by: ownerId, verified: true, status: "active" });
    assertDenied(error, "insert-forge");
    const { data } = await adminClient().from(TABLE).select("id").eq("name", "forged");
    assert.equal((data ?? []).length, 0, "no forged place must be created");
  });
  it("authenticated cannot INSERT a place attributed to another user (impersonation)", async () => {
    const { error } = await userClient(ownerToken).from(TABLE)
      .insert({ name: "impersonated", place_type: "restaurant", submitted_by: strangerId, verified: true, status: "active" });
    assertDenied(error, "insert-impersonate");
  });
  it("authenticated cannot INSERT even a content-only place", async () => {
    const { error } = await userClient(ownerToken).from(TABLE).insert({ name: "content-only", place_type: "restaurant" });
    assertDenied(error, "insert-content-only");
  });
  it("authenticated cannot UPDATE a place", async () => {
    const { error } = await userClient(ownerToken).from(TABLE).update({ verified: true, status: "active" }).eq("id", placeId);
    assertDenied(error, "update");
  });
  it("authenticated cannot DELETE a place", async () => {
    const { error } = await userClient(ownerToken).from(TABLE).delete().eq("id", placeId);
    assertDenied(error, "delete");
  });
  it("an upsert (alternate form) does not bypass the boundary", async () => {
    const { error } = await userClient(ownerToken).from(TABLE)
      .upsert({ name: "upsert", place_type: "restaurant", submitted_by: ownerId, verified: true, status: "active" });
    assertDenied(error, "upsert");
  });
  it("anon cannot write, but the authorized public read still works", async () => {
    const { error: wErr } = await anonClient().from(TABLE).insert({ name: "anon", place_type: "restaurant", verified: true, status: "active" });
    assertDenied(wErr, "anon-insert");
    const { data, error: rErr } = await anonClient().from(TABLE).select("id").eq("id", placeId).eq("status", "active");
    assert.ifError(rErr);
    assert.equal((data ?? []).length, 1, "anon must still read the active place");
  });
  it("the service role can still create and verify places", async () => {
    const { data, error } = await adminClient().from(TABLE)
      .insert({ name: "svc created", place_type: "restaurant", submitted_by: ownerId, verified: false, status: "pending" }).select("id").single();
    assert.ifError(error);
    const svcId = (data as any).id;
    const { error: uErr } = await adminClient().from(TABLE).update({ verified: true, status: "active" }).eq("id", svcId);
    assert.ifError(uErr);
    assert.equal((await readPlace(svcId))?.status, "active");
    await adminClient().from(TABLE).delete().eq("id", svcId);
  });
});
