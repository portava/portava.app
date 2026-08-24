/**
 * rentBuddyAddonApprovalBoundary.test.ts — the rent_buddy_addons approval boundary.
 *
 * RED before migration 2156, GREEN after. Verified on portava-ci: pre-2156 a
 * buddy self-set admin_approved=true (and cleared requires_admin_approval) on
 * their own add-on (1 row), bypassing admin review. Post-2156 those columns fail
 * 42501, while add-on CONTENT stays writable.
 *
 * admin_approved / requires_admin_approval are the platform's review gate, set by
 * the service-role client. 2156 grants authenticated column INSERT/UPDATE on the
 * content columns only. Ownership is keyed through rent_buddy_profiles.user_id.
 *
 * Live-DB suite: kept out of the curated npm test list; run by the live-DB job.
 * Run: node --import tsx/esm --test src/test/rentBuddyAddonApprovalBoundary.test.ts
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
if (!CREDS_AVAILABLE) console.warn("\n[rentBuddyAddonApprovalBoundary] SKIPPING — no live credentials.\n");

function adminClient(): SupabaseClient { return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } }); }
function anonClient(): SupabaseClient { return createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } }); }
function userClient(t: string): SupabaseClient {
  return createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${t}` } } });
}

const PREFIX = "rb_addon_test_";
const PASSWORD = "test-password-123";
const TABLE = "rent_buddy_addons";
let ownerToken = "", ownerBuddyId = "", strangerBuddyId = "", addonId = "";

async function makeBuddy(tag: string): Promise<{ id: string; token: string; buddyId: string }> {
  const sc = adminClient();
  const email = `${PREFIX}${tag}@example.com`;
  const { data: c, error: cErr } = await sc.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (cErr || !c?.user) throw new Error(`createUser(${tag}): ${cErr?.message}`);
  const id = c.user.id;
  const { error: pErr } = await sc.from("profiles").upsert({ id, handle: `${PREFIX}${tag}`, username: `${PREFIX}${tag}`, name: `rba ${tag}` }, { onConflict: "id" });
  if (pErr) throw new Error(`profile(${tag}): ${pErr.message}`);
  const { data: rb, error: rbErr } = await sc.from("rent_buddy_profiles").insert({ user_id: id, city: "Cebu" }).select("id").single();
  if (rbErr || !rb) throw new Error(`rent_buddy_profiles(${tag}): ${rbErr?.message}`);
  const { data: s, error: sErr } = await anonClient().auth.signInWithPassword({ email, password: PASSWORD });
  if (sErr || !s?.session) throw new Error(`signIn(${tag}): ${sErr?.message}`);
  return { id, token: s.session.access_token, buddyId: (rb as any).id };
}
async function readAddon(id: string): Promise<any | null> {
  const { data } = await adminClient().from(TABLE).select("*").eq("id", id).maybeSingle();
  return data ?? null;
}

before(async () => {
  if (!CREDS_AVAILABLE) return;
  await purgeFixtureUsers(adminClient(), [`${PREFIX}owner@example.com`, `${PREFIX}stranger@example.com`]);
  ({ token: ownerToken, buddyId: ownerBuddyId } = await makeBuddy("owner"));
  ({ buddyId: strangerBuddyId } = await makeBuddy("stranger"));
  const { data, error } = await adminClient().from(TABLE)
    .insert({ buddy_id: ownerBuddyId, title: "Photo pack", description: "orig", price_usd: 15, is_active: true, admin_approved: false })
    .select("id").single();
  if (error) throw new Error(`fixture: could not seed addon: ${error.message}`);
  addonId = (data as any).id;
  assert.equal((await readAddon(addonId))?.admin_approved, false);
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

describe("rent_buddy_addons approval boundary", { skip: !CREDS_AVAILABLE }, () => {
  it("owner cannot self-set admin_approved", async () => {
    const { error } = await userClient(ownerToken).from(TABLE).update({ admin_approved: true }).eq("id", addonId);
    assertDenied(error, "self admin_approved");
    assert.equal((await readAddon(addonId))?.admin_approved, false);
  });
  it("owner cannot clear requires_admin_approval", async () => {
    const before = await readAddon(addonId);
    const { error } = await userClient(ownerToken).from(TABLE).update({ requires_admin_approval: false }).eq("id", addonId);
    assertDenied(error, "requires_admin_approval");
    assert.equal((await readAddon(addonId))?.requires_admin_approval, before?.requires_admin_approval);
  });
  it("a mixed content+approval UPDATE fails atomically", async () => {
    const { error } = await userClient(ownerToken).from(TABLE).update({ title: "Renamed", admin_approved: true }).eq("id", addonId);
    assertDenied(error, "mixed");
    const a = await readAddon(addonId);
    assert.equal(a?.admin_approved, false);
    assert.equal(a?.title, "Photo pack", "content change must not apply either");
  });
  it("owner CAN edit add-on content (title, price_usd, is_active)", async () => {
    const { error } = await userClient(ownerToken).from(TABLE).update({ title: "Deluxe pack", price_usd: 25, is_active: false }).eq("id", addonId);
    assert.ifError(error);
    const a = await readAddon(addonId);
    assert.equal(a?.title, "Deluxe pack");
    assert.equal(Number(a?.price_usd), 25);
  });
  it("owner CAN create own add-on, but it cannot forge approval", async () => {
    const uc = userClient(ownerToken);
    const { data, error } = await uc.from(TABLE).insert({ buddy_id: ownerBuddyId, title: "New addon", price_usd: 10 }).select("id, admin_approved").single();
    assert.ifError(error);
    assert.notEqual((data as any)?.admin_approved, true, "a self-inserted add-on must not be approved");
    await adminClient().from(TABLE).delete().eq("id", (data as any).id);
    const { error: fErr } = await uc.from(TABLE).insert({ buddy_id: ownerBuddyId, title: "forge", price_usd: 10, admin_approved: true });
    assertDenied(fErr, "insert-forge admin_approved");
  });
  it("owner cannot approve another buddy's add-on", async () => {
    const { data: other } = await adminClient().from(TABLE).insert({ buddy_id: strangerBuddyId, title: "theirs", price_usd: 5 }).select("id").single();
    const otherId = (other as any).id;
    const { error } = await userClient(ownerToken).from(TABLE).update({ admin_approved: true }).eq("id", otherId);
    if (!error) assert.notEqual((await readAddon(otherId))?.admin_approved, true);
    await adminClient().from(TABLE).delete().eq("id", otherId);
  });
  it("the service role can still approve an add-on", async () => {
    const { error } = await adminClient().from(TABLE).update({ admin_approved: true }).eq("id", addonId);
    assert.ifError(error);
    assert.equal((await readAddon(addonId))?.admin_approved, true);
  });
  it("anon cannot write", async () => {
    const { error } = await anonClient().from(TABLE).update({ admin_approved: true }).eq("id", addonId);
    assert.ok(error, "anon must not write");
  });
});
