/**
 * rentBuddyPackageReviewBoundary.test.ts — the rent_buddy_packages review boundary.
 *
 * RED before migration 2157, GREEN after. Verified on portava-ci: pre-2157 a
 * buddy self-set admin_review_status on their own package (1 row), asserting a
 * platform review outcome. Post-2157 admin_review_status / admin_reviewed_by /
 * admin_reviewed_at fail 42501, while package CONTENT stays writable.
 *
 * The admin_review_* columns are the platform's review record, set by the
 * service-role client. 2157 grants authenticated column INSERT/UPDATE on the
 * content columns only. Ownership is keyed through rent_buddy_profiles.user_id.
 *
 * Live-DB suite: kept out of the curated npm test list; run by the live-DB job.
 * Run: node --import tsx/esm --test src/test/rentBuddyPackageReviewBoundary.test.ts
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
if (!CREDS_AVAILABLE) console.warn("\n[rentBuddyPackageReviewBoundary] SKIPPING — no live credentials.\n");

function adminClient(): SupabaseClient { return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } }); }
function anonClient(): SupabaseClient { return createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } }); }
function userClient(t: string): SupabaseClient {
  return createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${t}` } } });
}

const PREFIX = "rb_pkg_test_";
const PASSWORD = "test-password-123";
const TABLE = "rent_buddy_packages";
let ownerId = "", ownerToken = "", ownerBuddyId = "", strangerBuddyId = "", pkgId = "";

async function makeBuddy(tag: string): Promise<{ id: string; token: string; buddyId: string }> {
  const sc = adminClient();
  const email = fixtureEmail(`${PREFIX}${tag}@example.com`);
  const { data: c, error: cErr } = await sc.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (cErr || !c?.user) throw new Error(`createUser(${tag}): ${cErr?.message}`);
  const id = c.user.id;
  const { error: pErr } = await sc.from("profiles").upsert({ id, handle: `${PREFIX}${tag}`, username: `${PREFIX}${tag}`, name: `rbp ${tag}` }, { onConflict: "id" });
  if (pErr) throw new Error(`profile(${tag}): ${pErr.message}`);
  const { data: rb, error: rbErr } = await sc.from("rent_buddy_profiles").insert({ user_id: id, city: "Cebu" }).select("id").single();
  if (rbErr || !rb) throw new Error(`rent_buddy_profiles(${tag}): ${rbErr?.message}`);
  const { data: s, error: sErr } = await anonClient().auth.signInWithPassword({ email, password: PASSWORD });
  if (sErr || !s?.session) throw new Error(`signIn(${tag}): ${sErr?.message}`);
  return { id, token: s.session.access_token, buddyId: (rb as any).id };
}
async function readPkg(id: string): Promise<any | null> {
  const { data } = await adminClient().from(TABLE).select("*").eq("id", id).maybeSingle();
  return data ?? null;
}
async function seedPkg(buddyId: string, title: string): Promise<string> {
  const { data, error } = await adminClient().from(TABLE)
    .insert({ buddy_id: buddyId, title, category: "tour", duration_h: 3, price_usd: 60, is_active: true })
    .select("id").single();
  if (error) throw new Error(`seed pkg: ${error.message}`);
  return (data as any).id;
}

before(async () => {
  if (!CREDS_AVAILABLE) return;
  await purgeFixtureUsers(adminClient(), [fixtureEmail(`${PREFIX}owner@example.com`), fixtureEmail(`${PREFIX}stranger@example.com`)]);
  ({ id: ownerId, token: ownerToken, buddyId: ownerBuddyId } = await makeBuddy("owner"));
  ({ buddyId: strangerBuddyId } = await makeBuddy("stranger"));
  pkgId = await seedPkg(ownerBuddyId, "Island hop");
});
after(async () => {
  if (!CREDS_AVAILABLE) return;
  const sc = adminClient();
  for (const b of [ownerBuddyId, strangerBuddyId]) if (b) await sc.from(TABLE).delete().eq("buddy_id", b);
  for (const b of [ownerBuddyId, strangerBuddyId]) if (b) await sc.from("rent_buddy_profiles").delete().eq("id", b);
  await purgeFixtureUsers(sc, [fixtureEmail(`${PREFIX}owner@example.com`), fixtureEmail(`${PREFIX}stranger@example.com`)]);
});

function assertDenied(error: any, what: string): void {
  assert.ok(error, `${what}: expected a permission error, got success — the boundary is open`);
  const code = String(error.code ?? ""); const msg = String(error.message ?? "").toLowerCase();
  assert.ok(code === "42501" || msg.includes("permission denied"), `${what}: expected 42501, got code=${code} msg=${error.message}`);
}

describe("rent_buddy_packages review boundary", { skip: !CREDS_AVAILABLE }, () => {
  it("owner cannot self-set admin_review_status", async () => {
    const before = await readPkg(pkgId);
    const { error } = await userClient(ownerToken).from(TABLE).update({ admin_review_status: "approved" }).eq("id", pkgId);
    assertDenied(error, "self admin_review_status");
    assert.equal((await readPkg(pkgId))?.admin_review_status, before?.admin_review_status);
  });
  it("owner cannot self-set admin_reviewed_by / admin_reviewed_at", async () => {
    const { error: e1 } = await userClient(ownerToken).from(TABLE).update({ admin_reviewed_by: ownerId }).eq("id", pkgId);
    assertDenied(e1, "admin_reviewed_by");
    const { error: e2 } = await userClient(ownerToken).from(TABLE).update({ admin_reviewed_at: new Date().toISOString() }).eq("id", pkgId);
    assertDenied(e2, "admin_reviewed_at");
    const p = await readPkg(pkgId);
    assert.equal(p?.admin_reviewed_by, null);
    assert.equal(p?.admin_reviewed_at, null);
  });
  it("a mixed content+review UPDATE fails atomically", async () => {
    const { error } = await userClient(ownerToken).from(TABLE).update({ title: "Renamed", admin_review_status: "approved" }).eq("id", pkgId);
    assertDenied(error, "mixed");
    assert.equal((await readPkg(pkgId))?.title, "Island hop", "content change must not apply either");
  });
  it("owner CAN edit package content (title, price_usd, is_active)", async () => {
    const { error } = await userClient(ownerToken).from(TABLE).update({ title: "Sunset hop", price_usd: 80, is_active: false }).eq("id", pkgId);
    assert.ifError(error);
    const p = await readPkg(pkgId);
    assert.equal(p?.title, "Sunset hop");
    assert.equal(Number(p?.price_usd), 80);
  });
  it("owner CAN create own package, but cannot forge review status", async () => {
    const uc = userClient(ownerToken);
    const { data, error } = await uc.from(TABLE).insert({ buddy_id: ownerBuddyId, title: "New pkg", category: "tour", duration_h: 2, price_usd: 40 }).select("id, admin_review_status").single();
    assert.ifError(error);
    assert.notEqual((data as any)?.admin_review_status, "approved", "a self-inserted package must not be pre-approved");
    await adminClient().from(TABLE).delete().eq("id", (data as any).id);
    const { error: fErr } = await uc.from(TABLE).insert({ buddy_id: ownerBuddyId, title: "forge", category: "tour", duration_h: 2, price_usd: 40, admin_review_status: "approved" });
    assertDenied(fErr, "insert-forge admin_review_status");
  });
  it("owner cannot review another buddy's package", async () => {
    const otherId = await seedPkg(strangerBuddyId, "theirs");
    const { error } = await userClient(ownerToken).from(TABLE).update({ admin_review_status: "approved" }).eq("id", otherId);
    if (!error) assert.notEqual((await readPkg(otherId))?.admin_review_status, "approved");
    await adminClient().from(TABLE).delete().eq("id", otherId);
  });
  it("the service role can still set the review status", async () => {
    const { error } = await adminClient().from(TABLE).update({ admin_review_status: "approved", admin_reviewed_by: ownerId, admin_reviewed_at: new Date().toISOString() }).eq("id", pkgId);
    assert.ifError(error);
    assert.equal((await readPkg(pkgId))?.admin_review_status, "approved");
  });
  it("anon cannot write", async () => {
    const { error } = await anonClient().from(TABLE).update({ admin_review_status: "approved" }).eq("id", pkgId);
    assert.ok(error, "anon must not write");
  });
});
