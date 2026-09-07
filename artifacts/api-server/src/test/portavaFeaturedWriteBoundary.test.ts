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
 * the service-role approval path still works.
 *
 * Every legitimate write (nomination, permission request/grant, admin approval)
 * runs through the API as service-role, and so does every READ — the client
 * calls GET /api/featured and never touches PostgREST for this table.
 *
 * UPDATED FOR MIGRATION 2332 (2332_money_grant_boundary.sql). 2160 left
 * anon+authenticated with SELECT; 2332 revokes that too, and revokes from
 * service_role before granting it back the four DML verbs — the step 2160
 * omitted, which is why service_role still carried TRUNCATE. So the expectation
 * here is now "no write AND no direct read" for anon; see the case below for
 * why the old "public read still works" assertion was never a product read path
 * and was already false in production.
 *
 * NOTE on RLS: it is OFF on this table in portava-ci and ON (with zero policies)
 * in production — an environment divergence 2332 deliberately does not touch.
 * The grant removal is what closes the boundary on both, because PostgREST
 * denies a role with no privilege before RLS is ever consulted.
 *
 * Live-DB suite: kept out of the curated npm test list; run by the live-DB job.
 * Run: node --import tsx/esm --test src/test/portavaFeaturedWriteBoundary.test.ts
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
  const email = fixtureEmail(`${PREFIX}${tag}@example.com`);
  const { data: c, error: cErr } = await sc.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (cErr || !c?.user) throw new Error(`createUser(${tag}): ${cErr?.message}`);
  const id = c.user.id;
  const { error: pErr } = await sc.from("profiles").upsert({ id, handle: fixtureLabel(`${PREFIX}${tag}`), username: fixtureLabel(`${PREFIX}${tag}`), name: `pf ${tag}` }, { onConflict: "id" });
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
  await purgeFixtureUsers(adminClient(), [fixtureEmail(`${PREFIX}author@example.com`), fixtureEmail(`${PREFIX}stranger@example.com`)]);
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
  await purgeFixtureUsers(sc, [fixtureEmail(`${PREFIX}author@example.com`), fixtureEmail(`${PREFIX}stranger@example.com`)]);
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
  // CHANGED BY MIGRATION 2332 (2332_money_grant_boundary.sql). This case used
  // to read "anon cannot write, but the public read still works" and asserted
  // that anon got exactly one row back over PostgREST.
  //
  // That assertion encoded 2160's reasoning — "Featured is public, so grant
  // SELECT back to anon and authenticated". Public it is, but through the API,
  // not through PostgREST: `from('portava_featured')` appears nowhere in
  // travel-buddy-standalone, the Featured Hub calls GET /api/featured
  // (src/services/featured.ts), and that route serves the table from the
  // service client (routes/featured.ts:113). The anon SELECT grant backed no
  // read path in the product.
  //
  // It was also already false in production before 2332: RLS is ENABLED there
  // with ZERO policies, which denies every non-BYPASSRLS role regardless of the
  // grant. The old assertion passed on portava-ci only because the two
  // environments had diverged — 2160 was applied to CI and never to production,
  // and production had RLS switched on out of band instead.
  //
  // 2332 removes every anon and authenticated privilege on this table, so the
  // boundary is now the grant on both sides: no write AND no direct read.
  it("anon can neither write nor read this table directly", async () => {
    const { error: wErr } = await anonClient().from(TABLE).update({ status: "approved" }).eq("id", featuredId);
    assertDenied(wErr, "anon-update");
    const { error: rErr } = await anonClient().from(TABLE).select("id").eq("id", featuredId);
    assertDenied(rErr, "anon-select");
  });
  it("the service role can still approve a featured row", async () => {
    const { error } = await adminClient().from(TABLE).update({ status: "approved", approved_by: authorId }).eq("id", featuredId);
    assert.ifError(error);
    assert.equal((await readFeatured(featuredId))?.status, "approved");
  });
});
