/**
 * postLocationVerificationBoundary.test.ts — the posts verification/authority boundary.
 *
 * RED before migration 2148, GREEN after. Verified on portava-ci: pre-2148 a
 * user, via direct PostgREST with the public anon key, self-set
 * geotag_verified=true + location_verified=true on their own post (1 row) AND
 * forged both at INSERT time (a new post created already "verified"); post-2148
 * every client write fails 42501.
 *
 * ── WHAT IS BEING GUARDED ───────────────────────────────────────────────────
 * geotag_verified / location_verified are the platform's assertion that the
 * author's GPS actually matched the tagged place (computed server-side as the
 * geotag `verdict`). They feed passport authenticity and place-day/discovery
 * trust — the line is "the platform verified this location", not "I typed a
 * location". post_status='published' is the publication state that mediaAccess
 * and every public feed gate on; like/save/comment counts are derived.
 *
 * All posts writes in the API use requireUser's client, which is the
 * SERVICE-ROLE client (src/lib/http.ts) — create, edit, delayed-publish,
 * delete, counters, verification. So no column is legitimately client-writable
 * and 2148 gives anon+authenticated SELECT only. The forge/assert vectors exist
 * ONLY on a direct PostgREST write, which never reaches the route handlers.
 *
 * ── THE TRAP AVOIDED ────────────────────────────────────────────────────────
 * PostgREST reports an UPDATE matching no row as success-with-zero-rows, so
 * every denial asserts BOTH a 42501 error AND the unchanged value read back
 * through the service client. The service-role test is the positive control.
 *
 * Live-DB suite: kept out of the curated npm test list; run by the live-DB CI job.
 * Run: node --import tsx/esm --test src/test/postLocationVerificationBoundary.test.ts
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
if (!CREDS_AVAILABLE) console.warn("\n[postLocationVerificationBoundary] SKIPPING — no live credentials.\n");

function adminClient(): SupabaseClient { return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } }); }
function anonClient(): SupabaseClient { return createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } }); }
function userClient(t: string): SupabaseClient {
  return createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${t}` } } });
}

const PREFIX = "post_verify_test_";
const PASSWORD = "test-password-123";
const TABLE = "posts";
let authorId = "";
let authorToken = "";
let strangerId = "";
let postId = "";

async function makeUser(tag: string): Promise<{ id: string; token: string }> {
  const sc = adminClient();
  const email = `${PREFIX}${tag}@example.com`;
  const { data: c, error: cErr } = await sc.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (cErr || !c?.user) throw new Error(`createUser(${tag}): ${cErr?.message}`);
  const id = c.user.id;
  const { error: pErr } = await sc.from("profiles").upsert({ id, handle: `${PREFIX}${tag}`, username: `${PREFIX}${tag}`, name: `post ${tag}` }, { onConflict: "id" });
  if (pErr) throw new Error(`profile(${tag}): ${pErr.message}`);
  const { data: s, error: sErr } = await anonClient().auth.signInWithPassword({ email, password: PASSWORD });
  if (sErr || !s?.session) throw new Error(`signIn(${tag}): ${sErr?.message}`);
  return { id, token: s.session.access_token };
}
async function readPost(id: string): Promise<any | null> {
  const { data } = await adminClient().from(TABLE).select("*").eq("id", id).maybeSingle();
  return data ?? null;
}

before(async () => {
  if (!CREDS_AVAILABLE) return;
  await purgeFixtureUsers(adminClient(), [`${PREFIX}author@example.com`, `${PREFIX}stranger@example.com`]);
  ({ id: authorId, token: authorToken } = await makeUser("author"));
  ({ id: strangerId } = await makeUser("stranger"));
  const { data, error } = await adminClient().from(TABLE)
    .insert({ author_id: authorId, content: "before", status: "active", visibility: "public",
              geotag_verified: false, location_verified: false, post_status: "pending_safety_review" })
    .select("id").single();
  if (error) throw new Error(`fixture: could not seed post: ${error.message}`);
  postId = (data as any).id;
  const p = await readPost(postId);
  assert.ok(p, "fixture post must exist");
  assert.equal(p.geotag_verified, false);
  assert.equal(p.location_verified, false);
});
after(async () => {
  if (!CREDS_AVAILABLE) return;
  const sc = adminClient();
  if (postId) await sc.from(TABLE).delete().eq("id", postId);
  await sc.from(TABLE).delete().eq("author_id", authorId);
  for (const id of [authorId, strangerId]) if (id) { await sc.from("profiles").delete().eq("id", id); await sc.auth.admin.deleteUser(id); }
});

function assertPermissionDenied(error: any, what: string): void {
  assert.ok(error, `${what}: expected a permission error, got success — the boundary is open`);
  const code = String(error.code ?? ""); const msg = String(error.message ?? "").toLowerCase();
  assert.ok(code === "42501" || msg.includes("permission denied"), `${what}: expected 42501, got code=${code} msg=${error.message}`);
}

describe("posts verification/authority boundary", { skip: !CREDS_AVAILABLE }, () => {
  // The two the requirement names explicitly, plus the state/counter authority fields.
  for (const [col, val] of [
    ["geotag_verified", true],
    ["location_verified", true],
    ["post_status", "published"],
    ["like_count", 9999],
  ] as const) {
    it(`author cannot self-set ${col} on their own post`, async () => {
      const before = await readPost(postId);
      const { error } = await userClient(authorToken).from(TABLE).update({ [col]: val }).eq("id", postId);
      assertPermissionDenied(error, `self ${col}`);
      assert.deepEqual((await readPost(postId))?.[col], before?.[col], `${col} must be unchanged`);
    });
  }

  it("author cannot forge verification at INSERT time (create an already-verified post)", async () => {
    const { error } = await userClient(authorToken).from(TABLE)
      .insert({ author_id: authorId, content: "forged", status: "active", visibility: "public",
                geotag_verified: true, location_verified: true });
    assertPermissionDenied(error, "insert-forge");
    // No forged row leaked in.
    const { data } = await adminClient().from(TABLE).select("id").eq("author_id", authorId).eq("content", "forged");
    assert.equal((data ?? []).length, 0, "a forged verified post must not have been created");
  });

  it("a mixed content+verification PATCH fails atomically", async () => {
    const { error } = await userClient(authorToken).from(TABLE)
      .update({ content: "smuggle", geotag_verified: true }).eq("id", postId);
    assertPermissionDenied(error, "mixed");
    const p = await readPost(postId);
    assert.equal(p?.geotag_verified, false);
    assert.equal(p?.content, "before", "the content change must not have applied either");
  });

  it("author cannot mutate a stranger's post", async () => {
    const { data: other, error: insErr } = await adminClient().from(TABLE)
      .insert({ author_id: strangerId, content: "theirs", status: "active", visibility: "public" }).select("id").single();
    assert.ifError(insErr);
    const otherId = (other as any).id;
    const { error } = await userClient(authorToken).from(TABLE).update({ content: "hijack" }).eq("id", otherId);
    // Either a permission denial or a zero-row no-op; the row must be untouched.
    if (!error) assert.equal((await readPost(otherId))?.content, "theirs");
    await adminClient().from(TABLE).delete().eq("id", otherId);
  });

  it("anon can read the public feed but cannot write", async () => {
    const { error: rErr } = await anonClient().from(TABLE).select("id").eq("status", "active").eq("visibility", "public").limit(1);
    assert.ifError(rErr);
    const { error: wErr } = await anonClient().from(TABLE).update({ geotag_verified: true }).eq("id", postId);
    assert.ok(wErr, "anon must not be able to write");
  });

  it("the service role — the real API path — still creates, verifies and publishes", async () => {
    const { error } = await adminClient().from(TABLE)
      .update({ content: "svc-edit", geotag_verified: true, location_verified: true, post_status: "published" }).eq("id", postId);
    assert.ifError(error);
    const p = await readPost(postId);
    assert.equal(p?.geotag_verified, true);
    assert.equal(p?.location_verified, true);
    assert.equal(p?.post_status, "published");
    assert.equal(p?.content, "svc-edit");
  });
});
