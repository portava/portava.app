/**
 * portavaFeaturedWriteBoundary.test.ts — the portava_featured client-write boundary.
 *
 * RED before migration 2160, GREEN after. Verified on portava-ci: pre-2160
 * public.portava_featured (the platform "Featured" table) had RLS OFF and
 * anon+authenticated table-level INSERT/UPDATE. A stranger (neither the post
 * author nor an admin) could INSERT a featured row jumped straight to
 * status='approved' with approved_by=self, or UPDATE a pending row to approved —
 * self-featuring arbitrary content, bypassing the creator-permission gate and
 * admin approval. Post-2160 every client INSERT/UPDATE/DELETE fails 42501 while
 * the public read and the service-role approval path still work.
 *
 * Every legitimate write (nomination, permission request/grant, admin approval)
 * runs through the API as service-role. 2160 makes anon+authenticated SELECT-only.
 * NOTE: RLS is OFF on this table; the grant removal is what closes the exploit
 * (PostgREST denies a write with no privilege). Enabling RLS is a deferred
 * defense-in-depth follow-up.
 *
 * Live-DB suite: kept out of the curated npm test list; run by the live-DB job.
 * Run: node --import tsx/esm --test src/test/portavaFeaturedWriteBoundary.test.ts
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
if (!CREDS_AVAILABLE) console.warn("\n[portavaFeaturedWriteBoundary] SKIPPING — no live credentials.\n");

function adminClient(): SupabaseClient { return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } }); }
function anonClient(): SupabaseClient { return createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } }); }
function userClient(t: string): SupabaseClient {
  return createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${t}` } } });
}

const PREFIX = "pf_test_";
const PASSWORD = "test-password-123";
const TABLE = "portava_featured";
let authorId = "", strangerId = "", strangerToken = "", postId = "", featuredId = "";

async function makeUser(tag: string): Promise<{ id: string; token: string }> {
  const sc = adminClient();
  const email = `${PREFIX}${tag}@example.com`;
  const { data: c, error: cErr } = await sc.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (cErr || !c?.user) throw new Error(`createUser(${tag}): ${cErr?.message}`);
  const id = c.user.id;
  const { error: pErr } = await sc.from("profiles").upsert({ id, handle: `${PREFIX}${tag}`, username: `${PREFIX}${tag}`, name: `pf ${tag}` }, { onConflict: "id" });
  if (pErr) throw new Error(`profile(${tag}): ${pErr.message}`);
  const { data: s, error: sErr } = await anonClient().auth.signInWithPassword({ email, password: PASSWORD });
  if (sErr || !s?.session) throw new Error(`signIn(${tag}): ${sErr?.message}`);
  return { id, token: s.session.access_token };
}
async function readFeatured(id: string): Promise<any | null> {
  const { data } = await adminClient().from(TABLE).select("*").eq("id", id).maybeSingle();
  return data ?? null;
}

before(async () => {
  if (!CREDS_AVAILABLE) return;
  await purgeFixtureUsers(adminClient(), [`${PREFIX}author@example.com`, `${PREFIX}stranger@example.com`]);
  ({ id: authorId } = await makeUser("author"));
  ({ id: strangerId, token: strangerToken } = await makeUser("stranger"));
  const sc = adminClient();
  const { data: post, error: postErr } = await sc.from("posts").insert({ author_id: authorId, status: "active", visibility: "public" }).select("id").single();
  if (postErr) throw new Error(`fixture post: ${postErr.message}`);
  postId = (post as any).id;
  const { data, error } = await sc.from(TABLE).insert({ post_id: postId, category: "best_video", status: "pending_permission" }).select("id").single();
  if (error) throw new Error(`fixture featured: ${error.message}`);
  featuredId = (data as any).id;
});
after(async () => {
  if (!CREDS_AVAILABLE) return;
  const sc = adminClient();
  if (postId) await sc.from(TABLE).delete().eq("post_id", postId);
  if (postId) await sc.from("posts").delete().eq("id", postId);
  await purgeFixtureUsers(sc, [`${PREFIX}author@example.com`, `${PREFIX}stranger@example.com`]);
});

function assertDenied(error: any, what: string): void {
  assert.ok(error, `${what}: expected a permission error, got success — the boundary is open`);
  const code = String(error.code ?? ""); const msg = String(error.message ?? "").toLowerCase();
  assert.ok(code === "42501" || msg.includes("permission denied"), `${what}: expected 42501, got code=${code} msg=${error.message}`);
}

describe("portava_featured client-write boundary", { skip: !CREDS_AVAILABLE }, () => {
  it("a stranger cannot self-INSERT an approved featured row", async () => {
    const { error } = await userClient(strangerToken).from(TABLE)
      .insert({ post_id: postId, category: "best_hidden_gem", status: "approved", approved_by: strangerId });
    assertDenied(error, "self-insert-approved");
    const { data } = await adminClient().from(TABLE).select("id").eq("post_id", postId).eq("category", "best_hidden_gem");
    assert.equal((data ?? []).length, 0, "no self-featured row must be created");
  });
  it("a stranger cannot approve a pending featured row", async () => {
    const { error } = await userClient(strangerToken).from(TABLE).update({ status: "approved", approved_by: strangerId }).eq("id", featuredId);
    assertDenied(error, "self-approve");
    const f = await readFeatured(featuredId);
    assert.equal(f?.status, "pending_permission");
    assert.equal(f?.approved_by, null);
  });
  it("a stranger cannot DELETE a featured row", async () => {
    const { error } = await userClient(strangerToken).from(TABLE).delete().eq("id", featuredId);
    assertDenied(error, "delete");
    assert.ok(await readFeatured(featuredId), "featured row must survive");
  });
  it("an upsert (alternate form) does not bypass the boundary", async () => {
    const { error } = await userClient(strangerToken).from(TABLE)
      .upsert({ post_id: postId, category: "best_photo", status: "approved", approved_by: strangerId });
    assertDenied(error, "upsert");
  });
  it("anon cannot write, but the public read still works", async () => {
    const { error: wErr } = await anonClient().from(TABLE).update({ status: "approved" }).eq("id", featuredId);
    assertDenied(wErr, "anon-update");
    const { data, error: rErr } = await anonClient().from(TABLE).select("id").eq("id", featuredId);
    assert.ifError(rErr);
    assert.equal((data ?? []).length, 1, "anon must still read featured rows");
  });
  it("the service role can still approve a featured row", async () => {
    const { error } = await adminClient().from(TABLE).update({ status: "approved", approved_by: authorId }).eq("id", featuredId);
    assert.ifError(error);
    assert.equal((await readFeatured(featuredId))?.status, "approved");
  });
});
