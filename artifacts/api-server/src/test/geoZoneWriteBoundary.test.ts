/**
 * geoZoneWriteBoundary.test.ts — the geo_zones client-write boundary.
 *
 * RED before migration 2159, GREEN after. Verified on portava-ci: pre-2159 an
 * authenticated user self-set verified=true / featured=true on a geo zone (1 row)
 * — geo_zones_public_read exposes every zone, so verified/featured confer trust
 * and placement. Two RLS defects compounded it: geo_zones_auth_insert only checks
 * auth.uid() IS NOT NULL (created_by impersonation), and geo_zones_owner_update
 * USING ((auth.uid()=created_by) OR is_system) let ANY authenticated user edit
 * system zones. Post-2159 every client INSERT/UPDATE/DELETE fails 42501, while the
 * public read and the service-role write path still work.
 *
 * Every legitimate geo_zones write is service-role (geo_zones_service_all). 2159
 * makes anon+authenticated SELECT-only; the RLS write policies remain but are now
 * unreachable by clients (no write grant), so the forge, the impersonation and the
 * system-zone edit are all closed at the privilege layer.
 *
 * Live-DB suite: kept out of the curated npm test list; run by the live-DB job.
 * Run: node --import tsx/esm --test src/test/geoZoneWriteBoundary.test.ts
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
if (!CREDS_AVAILABLE) console.warn("\n[geoZoneWriteBoundary] SKIPPING — no live credentials.\n");

function adminClient(): SupabaseClient { return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } }); }
function anonClient(): SupabaseClient { return createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } }); }
function userClient(t: string): SupabaseClient {
  return createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${t}` } } });
}

const PREFIX = "geo_zone_test_";
const PASSWORD = "test-password-123";
const TABLE = "geo_zones";
let ownerId = "", ownerToken = "", zoneId = "", systemZoneId = "";

async function makeUser(tag: string): Promise<{ id: string; token: string }> {
  const sc = adminClient();
  const email = fixtureEmail(`${PREFIX}${tag}@example.com`);
  const { data: c, error: cErr } = await sc.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (cErr || !c?.user) throw new Error(`createUser(${tag}): ${cErr?.message}`);
  const id = c.user.id;
  const { error: pErr } = await sc.from("profiles").upsert({ id, handle: `${PREFIX}${tag}`, username: `${PREFIX}${tag}`, name: `gz ${tag}` }, { onConflict: "id" });
  if (pErr) throw new Error(`profile(${tag}): ${pErr.message}`);
  const { data: s, error: sErr } = await anonClient().auth.signInWithPassword({ email, password: PASSWORD });
  if (sErr || !s?.session) throw new Error(`signIn(${tag}): ${sErr?.message}`);
  return { id, token: s.session.access_token };
}
async function readZone(id: string): Promise<any | null> {
  const { data } = await adminClient().from(TABLE).select("*").eq("id", id).maybeSingle();
  return data ?? null;
}

before(async () => {
  if (!CREDS_AVAILABLE) return;
  await purgeFixtureUsers(adminClient(), [fixtureEmail(`${PREFIX}owner@example.com`)]);
  ({ id: ownerId, token: ownerToken } = await makeUser("owner"));
  const sc = adminClient();
  const { data, error } = await sc.from(TABLE).insert({ name: `${PREFIX}zone`, zone_type: "city", verified: false, featured: false }).select("id").single();
  if (error) throw new Error(`fixture: could not seed zone: ${error.message}`);
  zoneId = (data as any).id;
  const { data: sys, error: sErr } = await sc.from(TABLE).insert({ name: `${PREFIX}system`, zone_type: "city", is_system: true }).select("id").single();
  if (sErr) throw new Error(`fixture: could not seed system zone: ${sErr.message}`);
  systemZoneId = (sys as any).id;
});
after(async () => {
  if (!CREDS_AVAILABLE) return;
  const sc = adminClient();
  for (const z of [zoneId, systemZoneId]) if (z) await sc.from(TABLE).delete().eq("id", z);
  await sc.from(TABLE).delete().like("name", `${PREFIX}%`);
  await purgeFixtureUsers(sc, [fixtureEmail(`${PREFIX}owner@example.com`)]);
});

function assertDenied(error: any, what: string): void {
  assert.ok(error, `${what}: expected a permission error, got success — the boundary is open`);
  const code = String(error.code ?? ""); const msg = String(error.message ?? "").toLowerCase();
  assert.ok(code === "42501" || msg.includes("permission denied"), `${what}: expected 42501, got code=${code} msg=${error.message}`);
}

describe("geo_zones client-write boundary", { skip: !CREDS_AVAILABLE }, () => {
  it("authenticated cannot INSERT a zone (even content-only)", async () => {
    const { error } = await userClient(ownerToken).from(TABLE).insert({ name: `${PREFIX}forged`, zone_type: "city" });
    assertDenied(error, "insert");
    const { data } = await adminClient().from(TABLE).select("id").eq("name", `${PREFIX}forged`);
    assert.equal((data ?? []).length, 0, "no client-created zone must exist");
  });
  it("authenticated cannot INSERT a forged verified+featured zone", async () => {
    const { error } = await userClient(ownerToken).from(TABLE).insert({ name: `${PREFIX}vf`, zone_type: "city", verified: true, featured: true });
    assertDenied(error, "insert-forge");
  });
  it("authenticated cannot self-verify / self-feature a zone", async () => {
    const { error } = await userClient(ownerToken).from(TABLE).update({ verified: true, featured: true }).eq("id", zoneId);
    assertDenied(error, "update-verify");
    const z = await readZone(zoneId);
    assert.equal(z?.verified, false);
    assert.equal(z?.featured, false);
  });
  it("authenticated cannot edit a system zone (closes the owner_update OR is_system defect)", async () => {
    const { error } = await userClient(ownerToken).from(TABLE).update({ name: "hijacked-system" }).eq("id", systemZoneId);
    assertDenied(error, "update-system");
    assert.equal((await readZone(systemZoneId))?.name, `${PREFIX}system`);
  });
  it("authenticated cannot DELETE a zone", async () => {
    const { error } = await userClient(ownerToken).from(TABLE).delete().eq("id", zoneId);
    assertDenied(error, "delete");
    assert.ok(await readZone(zoneId), "zone must survive");
  });
  it("an upsert (alternate form) does not bypass the boundary", async () => {
    const { error } = await userClient(ownerToken).from(TABLE).upsert({ name: `${PREFIX}ups`, zone_type: "city", verified: true });
    assertDenied(error, "upsert");
  });
  it("anon cannot write, but the public read still works", async () => {
    const { error: wErr } = await anonClient().from(TABLE).update({ verified: true }).eq("id", zoneId);
    assertDenied(wErr, "anon-update");
    const { data, error: rErr } = await anonClient().from(TABLE).select("id").eq("id", zoneId);
    assert.ifError(rErr);
    assert.equal((data ?? []).length, 1, "anon must still read the zone");
  });
  it("the service role can still create and verify zones", async () => {
    const sc = adminClient();
    const { data, error } = await sc.from(TABLE).insert({ name: `${PREFIX}svc`, zone_type: "city", verified: false }).select("id").single();
    assert.ifError(error);
    const svcId = (data as any).id;
    const { error: uErr } = await sc.from(TABLE).update({ verified: true, featured: true }).eq("id", svcId);
    assert.ifError(uErr);
    assert.equal((await readZone(svcId))?.verified, true);
    await sc.from(TABLE).delete().eq("id", svcId);
  });
});
