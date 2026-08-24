/**
 * postMediaModerationBoundary.test.ts — the post_media moderation boundary.
 *
 * RED before migration 2158, GREEN after. Verified on portava-ci: pre-2158 an
 * owner self-set moderation_status / processing_status on their own media row (1
 * row) — self-clearing moderation and forcing a row to 'ready' (post_media_public
 * _select surfaces ready, non-rejected/flagged media into the public feed).
 * Post-2158 the moderation/processing/provenance columns fail 42501, while the
 * media DESCRIPTOR columns (urls, dimensions, sort_order) stay writable.
 *
 * moderation_status, processing_status, phash, dedup_processed, canonical_place_id,
 * feed_storage_path, feed_url and stamp_overlay are all server-derived (the media
 * pipeline + moderation run as service-role). 2158 grants authenticated column
 * INSERT/UPDATE on the descriptor columns only. Ownership: user_id = auth.uid()
 * AND the parent post is owned by the caller.
 *
 * Live-DB suite: kept out of the curated npm test list; run by the live-DB job.
 * Run: node --import tsx/esm --test src/test/postMediaModerationBoundary.test.ts
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
if (!CREDS_AVAILABLE) console.warn("\n[postMediaModerationBoundary] SKIPPING — no live credentials.\n");

function adminClient(): SupabaseClient { return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } }); }
function anonClient(): SupabaseClient { return createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } }); }
function userClient(t: string): SupabaseClient {
  return createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${t}` } } });
}

const PREFIX = "post_media_test_";
const PASSWORD = "test-password-123";
const TABLE = "post_media";
let ownerId = "", ownerToken = "", strangerId = "", postId = "", strangerPostId = "", mediaId = "";

async function makeUser(tag: string): Promise<{ id: string; token: string }> {
  const sc = adminClient();
  const email = `${PREFIX}${tag}@example.com`;
  const { data: c, error: cErr } = await sc.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (cErr || !c?.user) throw new Error(`createUser(${tag}): ${cErr?.message}`);
  const id = c.user.id;
  const { error: pErr } = await sc.from("profiles").upsert({ id, handle: `${PREFIX}${tag}`, username: `${PREFIX}${tag}`, name: `pm ${tag}` }, { onConflict: "id" });
  if (pErr) throw new Error(`profile(${tag}): ${pErr.message}`);
  const { data: s, error: sErr } = await anonClient().auth.signInWithPassword({ email, password: PASSWORD });
  if (sErr || !s?.session) throw new Error(`signIn(${tag}): ${sErr?.message}`);
  return { id, token: s.session.access_token };
}
async function seedPost(author: string): Promise<string> {
  const { data, error } = await adminClient().from("posts").insert({ author_id: author, status: "active", visibility: "public" }).select("id").single();
  if (error) throw new Error(`seed post: ${error.message}`);
  return (data as any).id;
}
async function readMedia(id: string): Promise<any | null> {
  const { data } = await adminClient().from(TABLE).select("*").eq("id", id).maybeSingle();
  return data ?? null;
}

before(async () => {
  if (!CREDS_AVAILABLE) return;
  await purgeFixtureUsers(adminClient(), [`${PREFIX}owner@example.com`, `${PREFIX}stranger@example.com`]);
  ({ id: ownerId, token: ownerToken } = await makeUser("owner"));
  ({ id: strangerId } = await makeUser("stranger"));
  postId = await seedPost(ownerId);
  strangerPostId = await seedPost(strangerId);
  const { data, error } = await adminClient().from(TABLE)
    .insert({ post_id: postId, user_id: ownerId, media_type: "image", mime_type: "image/jpeg", public_url: "orig", moderation_status: "pending", processing_status: "pending" })
    .select("id").single();
  if (error) throw new Error(`fixture: could not seed media: ${error.message}`);
  mediaId = (data as any).id;
});
after(async () => {
  if (!CREDS_AVAILABLE) return;
  const sc = adminClient();
  for (const u of [ownerId, strangerId]) if (u) await sc.from(TABLE).delete().eq("user_id", u);
  for (const p of [postId, strangerPostId]) if (p) await sc.from("posts").delete().eq("id", p);
  await purgeFixtureUsers(sc, [`${PREFIX}owner@example.com`, `${PREFIX}stranger@example.com`]);
});

function assertDenied(error: any, what: string): void {
  assert.ok(error, `${what}: expected a permission error, got success — the boundary is open`);
  const code = String(error.code ?? ""); const msg = String(error.message ?? "").toLowerCase();
  assert.ok(code === "42501" || msg.includes("permission denied"), `${what}: expected 42501, got code=${code} msg=${error.message}`);
}

describe("post_media moderation boundary", { skip: !CREDS_AVAILABLE }, () => {
  for (const [col, val] of [["moderation_status", "approved"], ["processing_status", "ready"], ["feed_url", "https://evil/f"], ["canonical_place_id", "00000000-0000-4000-a000-0000000000ff"]] as const) {
    it(`owner cannot self-set ${col}`, async () => {
      const before = await readMedia(mediaId);
      const { error } = await userClient(ownerToken).from(TABLE).update({ [col]: val }).eq("id", mediaId);
      assertDenied(error, `self ${col}`);
      assert.equal((await readMedia(mediaId))?.[col], before?.[col]);
    });
  }
  it("a mixed descriptor+moderation UPDATE fails atomically", async () => {
    const { error } = await userClient(ownerToken).from(TABLE).update({ public_url: "changed", moderation_status: "approved" }).eq("id", mediaId);
    assertDenied(error, "mixed");
    const m = await readMedia(mediaId);
    assert.equal(m?.moderation_status, "pending");
    assert.equal(m?.public_url, "orig", "descriptor change must not apply either");
  });
  it("owner CAN edit media descriptor (public_url, sort_order, width)", async () => {
    const { error } = await userClient(ownerToken).from(TABLE).update({ public_url: "edited", sort_order: 3, width: 640 }).eq("id", mediaId);
    assert.ifError(error);
    const m = await readMedia(mediaId);
    assert.equal(m?.public_url, "edited");
    assert.equal(m?.sort_order, 3);
  });
  it("owner CAN insert own media, but cannot forge moderation/processing", async () => {
    const uc = userClient(ownerToken);
    const { data, error } = await uc.from(TABLE).insert({ post_id: postId, user_id: ownerId, media_type: "image", mime_type: "image/png", public_url: "u2" }).select("id, moderation_status, processing_status").single();
    assert.ifError(error);
    assert.notEqual((data as any)?.moderation_status, "approved", "self-inserted media must not be pre-approved");
    assert.notEqual((data as any)?.processing_status, "ready", "self-inserted media must not be pre-ready");
    await adminClient().from(TABLE).delete().eq("id", (data as any).id);
    const { error: fErr } = await uc.from(TABLE).insert({ post_id: postId, user_id: ownerId, media_type: "image", mime_type: "image/png", moderation_status: "approved" });
    assertDenied(fErr, "insert-forge moderation_status");
  });
  it("owner cannot attach media to another user's post (impersonation)", async () => {
    const { error } = await userClient(ownerToken).from(TABLE).insert({ post_id: strangerPostId, user_id: ownerId, media_type: "image", mime_type: "image/png" });
    assert.ok(error, "must not attach media to a post the caller does not own");
  });
  it("the service role can still moderate and mark media ready", async () => {
    const { error } = await adminClient().from(TABLE).update({ moderation_status: "approved", processing_status: "ready" }).eq("id", mediaId);
    assert.ifError(error);
    const m = await readMedia(mediaId);
    assert.equal(m?.moderation_status, "approved");
    assert.equal(m?.processing_status, "ready");
  });
  it("anon cannot write", async () => {
    const { error } = await anonClient().from(TABLE).update({ moderation_status: "approved" }).eq("id", mediaId);
    assert.ok(error, "anon must not write");
  });
});
