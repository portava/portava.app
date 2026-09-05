/**
 * passportPostcardStatusModeration.test.ts — the passport-postcard moderation-state boundary.
 *
 * RED before migration 2152, GREEN after. Verified on portava-ci: post-2151 an
 * owner could self-set status='active' on their own REPORTED postcard (1 row),
 * re-exposing moderated content in the public passport feed (which selects
 * status='active'); post-2152 every client status write fails 42501 while the
 * reported row stays reported and out of the feed.
 *
 * status (post_status: active/hidden/reported/deleted) is a moderation state set
 * only by the server (create='active', /remove, moderation — all service-role).
 * The owner edit route writes note/visibility/pinned_at, never status. 2152
 * revokes authenticated INSERT+UPDATE on status; the DB default 'active' means a
 * normal client INSERT that omits status still creates a valid active postcard.
 *
 * Live-DB suite. Run: node --import tsx/esm --test src/test/passportPostcardStatusModeration.test.ts
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
if (!CREDS_AVAILABLE) console.warn("\n[passportPostcardStatusModeration] SKIPPING — no live credentials.\n");

function adminClient(): SupabaseClient { return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } }); }
function anonClient(): SupabaseClient { return createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } }); }
function userClient(t: string): SupabaseClient {
  return createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${t}` } } });
}

const PREFIX = "postcard_status_test_";
const PASSWORD = "test-password-123";
const TABLE = "passport_postcards";
let ownerId = "", ownerToken = "", strangerId = "", cardId = "";
const createdPosts: string[] = [];

async function makeUser(tag: string): Promise<{ id: string; token: string }> {
  const sc = adminClient();
  const email = fixtureEmail(`${PREFIX}${tag}@example.com`);
  const { data: c, error: cErr } = await sc.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (cErr || !c?.user) throw new Error(`createUser(${tag}): ${cErr?.message}`);
  const id = c.user.id;
  const { error: pErr } = await sc.from("profiles").upsert({ id, handle: `${PREFIX}${tag}`, username: `${PREFIX}${tag}`, name: `st ${tag}` }, { onConflict: "id" });
  if (pErr) throw new Error(`profile(${tag}): ${pErr.message}`);
  const { data: s, error: sErr } = await anonClient().auth.signInWithPassword({ email, password: PASSWORD });
  if (sErr || !s?.session) throw new Error(`signIn(${tag}): ${sErr?.message}`);
  return { id, token: s.session.access_token };
}
// passport_postcards has a UNIQUE(post_id), so every postcard needs a fresh post.
async function makePost(userId: string): Promise<string> {
  const { data, error } = await adminClient().from("posts").insert({ author_id: userId, content: "h", status: "active" }).select("id").single();
  if (error) throw new Error(`fixture post: ${error.message}`);
  const id = (data as any).id; createdPosts.push(id); return id;
}
async function readCard(id: string): Promise<any | null> {
  const { data } = await adminClient().from(TABLE).select("*").eq("id", id).maybeSingle();
  return data ?? null;
}

before(async () => {
  if (!CREDS_AVAILABLE) return;
  await purgeFixtureUsers(adminClient(), [fixtureEmail(`${PREFIX}owner@example.com`), fixtureEmail(`${PREFIX}stranger@example.com`)]);
  ({ id: ownerId, token: ownerToken } = await makeUser("owner"));
  ({ id: strangerId } = await makeUser("stranger"));
  const postId = await makePost(ownerId);
  // A REPORTED (moderated), public postcard.
  const { data, error } = await adminClient().from(TABLE)
    .insert({ post_id: postId, user_id: ownerId, media_url: "https://x/y.jpg", caption: "before", status: "reported", visibility: "public" })
    .select("id").single();
  if (error) throw new Error(`fixture: could not seed postcard: ${error.message}`);
  cardId = (data as any).id;
  assert.equal((await readCard(cardId))?.status, "reported");
});
after(async () => {
  if (!CREDS_AVAILABLE) return;
  const sc = adminClient();
  if (cardId) await sc.from(TABLE).delete().eq("id", cardId);
  for (const id of [ownerId, strangerId]) if (id) await sc.from(TABLE).delete().eq("user_id", id);
  for (const p of createdPosts) await sc.from("posts").delete().eq("id", p);
  for (const id of [ownerId, strangerId]) if (id) { await sc.from("profiles").delete().eq("id", id); await sc.auth.admin.deleteUser(id); }
});

function assertDenied(error: any, what: string): void {
  assert.ok(error, `${what}: expected a permission error, got success`);
  const code = String(error.code ?? ""); const msg = String(error.message ?? "").toLowerCase();
  assert.ok(code === "42501" || msg.includes("permission denied"), `${what}: expected 42501, got code=${code} msg=${error.message}`);
}

describe("passport_postcards moderation-status boundary", { skip: !CREDS_AVAILABLE }, () => {
  it("owner cannot restore a reported postcard to active (moderation bypass closed)", async () => {
    const { error } = await userClient(ownerToken).from(TABLE).update({ status: "active" }).eq("id", cardId);
    assertDenied(error, "reported->active");
    assert.equal((await readCard(cardId))?.status, "reported", "the row must remain reported");
  });
  it("owner cannot set status to any value", async () => {
    for (const s of ["deleted", "hidden"]) {
      const { error } = await userClient(ownerToken).from(TABLE).update({ status: s }).eq("id", cardId);
      assertDenied(error, `status->${s}`);
    }
    assert.equal((await readCard(cardId))?.status, "reported");
  });
  it("a reported postcard cannot be made public-feed-eligible by a client mutation", async () => {
    await userClient(ownerToken).from(TABLE).update({ status: "active" }).eq("id", cardId);
    // The public passport feed selects status='active' AND visibility='public'.
    const { data } = await adminClient().from(TABLE).select("id").eq("id", cardId).eq("status", "active").eq("visibility", "public");
    assert.equal((data ?? []).length, 0, "the reported postcard must not be feed-eligible");
  });
  it("a mixed content+status PATCH fails atomically", async () => {
    const { error } = await userClient(ownerToken).from(TABLE).update({ caption: "smuggle", status: "active" }).eq("id", cardId);
    assertDenied(error, "mixed");
    const c = await readCard(cardId);
    assert.equal(c?.status, "reported");
    assert.equal(c?.caption, "before", "content change must not apply either");
  });
  it("owner CAN still edit content (note, visibility, pinned_at, caption)", async () => {
    const { error } = await userClient(ownerToken).from(TABLE).update({ note: "n", visibility: "private", caption: "mine" }).eq("id", cardId);
    assert.ifError(error);
    const c = await readCard(cardId);
    assert.equal(c?.note, "n");
    assert.equal(c?.caption, "mine");
  });
  it("normal postcard creation still works (client omits status -> default active)", async () => {
    const postId = await makePost(ownerId);
    // Insert WITHOUT .select() so PostgREST uses return=minimal (the can_see_postcard SELECT policy is stricter on a brand-new row).
    const { error } = await userClient(ownerToken).from(TABLE).insert({ post_id: postId, user_id: ownerId, media_url: "https://x/new.jpg", caption: "c" });
    assert.ifError(error);
    const { data } = await adminClient().from(TABLE).select("status").eq("post_id", postId).single();
    assert.equal((data as any)?.status, "active", "the created postcard must get the safe default status");
  });
  it("owner cannot forge status at INSERT time", async () => {
    const postId = await makePost(ownerId);
    const { error } = await userClient(ownerToken).from(TABLE).insert({ post_id: postId, user_id: ownerId, media_url: "https://x/f.jpg", status: "active" });
    assertDenied(error, "insert-forge status");
  });
  it("owner cannot mutate a stranger's postcard status", async () => {
    const otherPost = await makePost(strangerId);
    const { data: other } = await adminClient().from(TABLE).insert({ post_id: otherPost, user_id: strangerId, media_url: "https://x/o.jpg", status: "reported" }).select("id").single();
    const otherId = (other as any).id;
    const { error } = await userClient(ownerToken).from(TABLE).update({ status: "active" }).eq("id", otherId);
    if (!error) assert.equal((await readCard(otherId))?.status, "reported");
    await adminClient().from(TABLE).delete().eq("id", otherId);
  });
  it("the service role can still transition moderation status", async () => {
    const { error } = await adminClient().from(TABLE).update({ status: "active" }).eq("id", cardId);
    assert.ifError(error);
    assert.equal((await readCard(cardId))?.status, "active");
  });
});
