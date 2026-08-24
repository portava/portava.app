/**
 * hiddenGemSelfPublish.test.ts — the hidden_gems publication/verification boundary.
 *
 * RED before migration 2147, GREEN after. Verified on portava-ci: pre-2147 a
 * user self-set status='active' on their own gem (1 row); post-2147 it fails 42501.
 *
 * hidden_gems.status (publication), verification_level, moderation_status and
 * guide_verified_by are set by verification/moderation (service-role). The public
 * Discovery feed and Compass read gems where status='active', so self-publish
 * injects unmoderated, self-"verified" content into Discovery. 2147 grants
 * authenticated column-UPDATE only on the 10 owner-edit content fields
 * (updateSchema) and revokes the rest.
 *
 * Live-DB suite. Run: node --import tsx/esm --test src/test/hiddenGemSelfPublish.test.ts
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
if (!CREDS_AVAILABLE) console.warn("\n[hiddenGemSelfPublish] SKIPPING — no live credentials.\n");

function adminClient(): SupabaseClient { return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } }); }
function anonClient(): SupabaseClient { return createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } }); }
function userClient(t: string): SupabaseClient {
  return createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${t}` } } });
}

const PREFIX = "gem_publish_test_";
const PASSWORD = "test-password-123";
const TABLE = "hidden_gems";
let ownerId = "";
let ownerToken = "";
let gemId = "";

async function makeUser(tag: string): Promise<{ id: string; token: string }> {
  const sc = adminClient();
  const email = `${PREFIX}${tag}@example.com`;
  const { data: c, error: cErr } = await sc.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (cErr || !c?.user) throw new Error(`createUser(${tag}): ${cErr?.message}`);
  const id = c.user.id;
  const { error: pErr } = await sc.from("profiles").upsert({ id, handle: `${PREFIX}${tag}`, username: `${PREFIX}${tag}`, name: `gem ${tag}` }, { onConflict: "id" });
  if (pErr) throw new Error(`profile(${tag}): ${pErr.message}`);
  const { data: s, error: sErr } = await anonClient().auth.signInWithPassword({ email, password: PASSWORD });
  if (sErr || !s?.session) throw new Error(`signIn(${tag}): ${sErr?.message}`);
  return { id, token: s.session.access_token };
}
async function readGem(id: string): Promise<any | null> {
  const { data } = await adminClient().from(TABLE).select("*").eq("id", id).maybeSingle();
  return data ?? null;
}

before(async () => {
  if (!CREDS_AVAILABLE) return;
  await purgeFixtureUsers(adminClient(), [`${PREFIX}owner@example.com`]);
  ({ id: ownerId, token: ownerToken } = await makeUser("owner"));
  const { data, error } = await adminClient().from(TABLE)
    .insert({ name: "probe gem", category: "food", city: "Cebu", submitted_by: ownerId, status: "pending", description: "before", verification_level: "unverified", moderation_status: "pending" })
    .select("id").single();
  if (error) throw new Error(`fixture: could not seed gem: ${error.message}`);
  gemId = (data as any).id;
  const g = await readGem(gemId);
  assert.ok(g, "fixture gem must exist");
  assert.equal(g.status, "pending");
});
after(async () => {
  if (!CREDS_AVAILABLE) return;
  const sc = adminClient();
  if (gemId) await sc.from(TABLE).delete().eq("id", gemId);
  if (ownerId) { await sc.from("profiles").delete().eq("id", ownerId); await sc.auth.admin.deleteUser(ownerId); }
});

function assertPermissionDenied(error: any, what: string): void {
  assert.ok(error, `${what}: expected a permission error, got success`);
  const code = String(error.code ?? ""); const msg = String(error.message ?? "").toLowerCase();
  assert.ok(code === "42501" || msg.includes("permission denied"), `${what}: expected 42501, got code=${code} msg=${error.message}`);
}

describe("hidden_gems publication/verification boundary", { skip: !CREDS_AVAILABLE }, () => {
  for (const [col, val] of [["status", "active"], ["verification_level", "guide"], ["moderation_status", "approved"]] as const) {
    it(`owner cannot self-set ${col}`, async () => {
      const before = await readGem(gemId);
      const { error } = await userClient(ownerToken).from(TABLE).update({ [col]: val }).eq("id", gemId);
      assertPermissionDenied(error, `self ${col}`);
      assert.equal((await readGem(gemId))?.[col], before?.[col]);
    });
  }
  it("owner cannot self-assign guide_verified_by", async () => {
    const { error } = await userClient(ownerToken).from(TABLE).update({ guide_verified_by: ownerId }).eq("id", gemId);
    assertPermissionDenied(error, "guide_verified_by");
    assert.equal((await readGem(gemId))?.guide_verified_by, null);
  });
  it("a mixed content+publish PATCH fails atomically", async () => {
    const { error } = await userClient(ownerToken).from(TABLE).update({ description: "smuggle", status: "active" }).eq("id", gemId);
    assertPermissionDenied(error, "mixed");
    const g = await readGem(gemId);
    assert.equal(g?.status, "pending");
    assert.equal(g?.description, "before", "content change must not apply either");
  });
  it("owner CAN edit the 10 content fields", async () => {
    const { error } = await userClient(ownerToken).from(TABLE)
      .update({ description: "a real edit", safety_notes: "mind the steps", vibe_tags: ["chill"], layover_safe: true }).eq("id", gemId);
    assert.ifError(error);
    const g = await readGem(gemId);
    assert.equal(g?.description, "a real edit");
    assert.equal(g?.safety_notes, "mind the steps");
    assert.equal(g?.layover_safe, true);
  });
  it("Discovery promotion requires the service role — a client cannot reach it", async () => {
    // A client-only mutation can never set status='active', so a gem cannot be
    // promoted into the public Discovery/Compass feed without server verification.
    await userClient(ownerToken).from(TABLE).update({ status: "active" }).eq("id", gemId);
    assert.equal((await readGem(gemId))?.status, "pending", "gem must remain unpublished");
    // Service role (the verification path) can publish.
    const { error } = await adminClient().from(TABLE).update({ status: "active", verification_level: "guide" }).eq("id", gemId);
    assert.ifError(error);
    assert.equal((await readGem(gemId))?.status, "active");
  });
  it("anon can read the public feed but cannot publish", async () => {
    const { error: rErr } = await anonClient().from(TABLE).select("id, name").eq("status", "active").limit(1);
    assert.ifError(rErr);
    const { error: wErr } = await anonClient().from(TABLE).update({ status: "active" }).eq("id", gemId);
    assert.ok(wErr, "anon must not be able to write");
  });
});
