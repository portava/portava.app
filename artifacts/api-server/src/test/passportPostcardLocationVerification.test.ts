/**
 * passportPostcardLocationVerification.test.ts — the passport-postcard location
 * verification boundary.
 *
 * RED before migration 2151, GREEN after. Verified on portava-ci: pre-2151 an
 * owner self-set location_verified=true (+ verification_method, verified_distance
 * _meters) on their own postcard (1 row); post-2151 each fails 42501, while owner
 * postcard content editing (caption/note/visibility/pinned_at) still works.
 *
 * location_verified / verification_method / verified_distance_meters / verified_at
 * are the platform's assertion that the author's GPS matched the tagged place
 * (the geotag verdict) — "the platform verified this location", not "I typed a
 * location". They plus the stamp-award/revocation columns are set by the server
 * (service-role). Postcards are created service-role from posts, so this suite
 * fixtures via the admin client and proves the direct-PostgREST UPDATE boundary.
 *
 * status is intentionally NOT protected here (the reported->active moderation
 * bypass is a separate finding); this suite does not assert on it.
 *
 * Live-DB suite. Run: node --import tsx/esm --test src/test/passportPostcardLocationVerification.test.ts
 */
import "../lib/ciSupabaseGuard.mjs";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { purgeFixtureUsers, fixtureEmail, fixtureLabel } from "./liveFixtureUsers.js";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY ?? "";
const CREDS_AVAILABLE = Boolean(SUPABASE_URL && SERVICE_ROLE_KEY && ANON_KEY);
if (!CREDS_AVAILABLE) console.warn("\n[passportPostcardLocationVerification] SKIPPING — no live credentials.\n");

function adminClient(): SupabaseClient { return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } }); }
function anonClient(): SupabaseClient { return createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } }); }
function userClient(t: string): SupabaseClient {
  return createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${t}` } } });
}

const PREFIX = "postcard_verify_test_";
const PASSWORD = "test-password-123";
const TABLE = "passport_postcards";
let ownerId = "", ownerToken = "", strangerId = "", cardId = "", ownerPostId = "";

async function makeUser(tag: string): Promise<{ id: string; token: string }> {
  const sc = adminClient();
  const email = fixtureEmail(`${PREFIX}${tag}@example.com`);
  const { data: c, error: cErr } = await sc.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (cErr || !c?.user) throw new Error(`createUser(${tag}): ${cErr?.message}`);
  const id = c.user.id;
  const { error: pErr } = await sc.from("profiles").upsert({ id, handle: fixtureLabel(`${PREFIX}${tag}`), username: fixtureLabel(`${PREFIX}${tag}`), name: `pc ${tag}` }, { onConflict: "id" });
  if (pErr) throw new Error(`profile(${tag}): ${pErr.message}`);
  const { data: s, error: sErr } = await anonClient().auth.signInWithPassword({ email, password: PASSWORD });
  if (sErr || !s?.session) throw new Error(`signIn(${tag}): ${sErr?.message}`);
  return { id, token: s.session.access_token };
}
async function makePost(userId: string): Promise<string> {
  const { data, error } = await adminClient().from("posts").insert({ author_id: userId, content: "h", status: "active" }).select("id").single();
  if (error) throw new Error(`fixture post: ${error.message}`);
  return (data as any).id;
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
  ownerPostId = await makePost(ownerId);
  const { data, error } = await adminClient().from(TABLE)
    .insert({ post_id: ownerPostId, user_id: ownerId, media_url: "https://x/y.jpg", caption: "before", location_verified: false, verification_method: "unavailable", status: "active" })
    .select("id").single();
  if (error) throw new Error(`fixture: could not seed postcard: ${error.message}`);
  cardId = (data as any).id;
  assert.equal((await readCard(cardId))?.location_verified, false);
});
after(async () => {
  if (!CREDS_AVAILABLE) return;
  const sc = adminClient();
  if (cardId) await sc.from(TABLE).delete().eq("id", cardId);
  for (const id of [ownerId, strangerId]) if (id) {
    await sc.from(TABLE).delete().eq("user_id", id);
    await sc.from("posts").delete().eq("author_id", id);
    await sc.from("profiles").delete().eq("id", id);
    await sc.auth.admin.deleteUser(id);
  }
});

function assertDenied(error: any, what: string): void {
  assert.ok(error, `${what}: expected a permission error, got success`);
  const code = String(error.code ?? ""); const msg = String(error.message ?? "").toLowerCase();
  assert.ok(code === "42501" || msg.includes("permission denied"), `${what}: expected 42501, got code=${code} msg=${error.message}`);
}

describe("passport_postcards location-verification boundary", { skip: !CREDS_AVAILABLE }, () => {
  // Each mandated location-verification column, individually.
  for (const [col, val] of [
    ["location_verified", true],
    ["verification_method", "gps_current_location"],
    ["verified_distance_meters", 0],
    ["stamp_eligible", true],
  ] as const) {
    it(`owner cannot self-set ${col}`, async () => {
      const before = await readCard(cardId);
      const { error } = await userClient(ownerToken).from(TABLE).update({ [col]: val }).eq("id", cardId);
      assertDenied(error, `self ${col}`);
      assert.deepEqual((await readCard(cardId))?.[col], before?.[col]);
    });
  }
  it("owner cannot self-set the whole verification tuple together", async () => {
    const { error } = await userClient(ownerToken).from(TABLE)
      .update({ location_verified: true, verification_method: "gps_current_location", verified_distance_meters: 0, verified_at: new Date().toISOString() }).eq("id", cardId);
    assertDenied(error, "all-verification");
    assert.equal((await readCard(cardId))?.location_verified, false);
  });
  it("owner cannot self-assign stamp_revoked_by (moderator field)", async () => {
    const { error } = await userClient(ownerToken).from(TABLE).update({ stamp_revoked: false, stamp_revoked_by: ownerId }).eq("id", cardId);
    assertDenied(error, "stamp_revoked_by");
  });
  it("a mixed content+verification UPDATE fails atomically", async () => {
    const { error } = await userClient(ownerToken).from(TABLE).update({ caption: "smuggle", location_verified: true }).eq("id", cardId);
    assertDenied(error, "mixed");
    const c = await readCard(cardId);
    assert.equal(c?.location_verified, false);
    assert.equal(c?.caption, "before", "content change must not apply either");
  });
  it("owner CAN edit postcard content (caption, note, visibility)", async () => {
    const { error } = await userClient(ownerToken).from(TABLE).update({ caption: "mine", note: "n", visibility: "public" }).eq("id", cardId);
    assert.ifError(error);
    const c = await readCard(cardId);
    assert.equal(c?.caption, "mine");
    assert.equal(c?.note, "n");
  });
  it("owner cannot mutate a stranger's postcard", async () => {
    const otherPost = await makePost(strangerId);
    const { data: other } = await adminClient().from(TABLE).insert({ post_id: otherPost, user_id: strangerId, media_url: "https://x/o.jpg", caption: "theirs" }).select("id").single();
    const otherId = (other as any).id;
    const { error } = await userClient(ownerToken).from(TABLE).update({ caption: "hijack" }).eq("id", otherId);
    if (!error) assert.equal((await readCard(otherId))?.caption, "theirs");
    await adminClient().from(TABLE).delete().eq("id", otherId);
  });
  it("the service role can still assign platform location verification + stamp eligibility", async () => {
    const { error } = await adminClient().from(TABLE).update({ location_verified: true, verification_method: "gps_current_location", stamp_eligible: true }).eq("id", cardId);
    assert.ifError(error);
    const c = await readCard(cardId);
    assert.equal(c?.location_verified, true);
    assert.equal(c?.stamp_eligible, true);
  });
  it("anon cannot write", async () => {
    const { error } = await anonClient().from(TABLE).update({ location_verified: true }).eq("id", cardId);
    assert.ok(error, "anon must not write");
  });
});
