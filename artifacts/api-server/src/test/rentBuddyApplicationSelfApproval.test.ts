/**
 * rentBuddyApplicationSelfApproval.test.ts — the buddy-application approval boundary.
 *
 * RED before migration 2146, GREEN after. Verified on portava-ci: pre-2146 a
 * user self-set admin_status='active' + status='approved' on their own
 * application (1 row); post-2146 it fails 42501.
 *
 * rent_buddy_applications.status/admin_status are ADJUDICATED by admin review
 * (PATCH /admin/applications/:appId, service-role). No user route edits an
 * application, and the standalone client never touches the table — so clients
 * get SELECT only (own rows via rb_apps_own). Self-approval feeds buddy
 * activation, so this is a real approval bypass on a live feature.
 *
 * Live-DB suite: kept out of the curated npm test list; run by the live-DB CI job.
 * Run: node --import tsx/esm --test src/test/rentBuddyApplicationSelfApproval.test.ts
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
if (!CREDS_AVAILABLE) {
  console.warn("\n[rentBuddyApplicationSelfApproval] SKIPPING — no live credentials.\n");
}

function adminClient(): SupabaseClient { return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } }); }
function anonClient(): SupabaseClient { return createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } }); }
function userClient(t: string): SupabaseClient {
  return createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${t}` } },
  });
}

const PREFIX = "rba_approval_test_";
const PASSWORD = "test-password-123";
const TABLE = "rent_buddy_applications";
let uId = "";
let uToken = "";

async function makeUser(tag: string): Promise<{ id: string; token: string }> {
  const sc = adminClient();
  const email = `${PREFIX}${tag}@example.com`;
  const { data: created, error: cErr } = await sc.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (cErr || !created?.user) throw new Error(`createUser(${tag}): ${cErr?.message}`);
  const id = created.user.id;
  const { error: pErr } = await sc.from("profiles").upsert({ id, handle: `${PREFIX}${tag}`, username: `${PREFIX}${tag}`, name: `rba ${tag}` }, { onConflict: "id" });
  if (pErr) throw new Error(`profile(${tag}): ${pErr.message}`);
  const { data: s, error: sErr } = await anonClient().auth.signInWithPassword({ email, password: PASSWORD });
  if (sErr || !s?.session) throw new Error(`signIn(${tag}): ${sErr?.message}`);
  return { id, token: s.session.access_token };
}
async function readApp(userId: string): Promise<any | null> {
  const { data } = await adminClient().from(TABLE).select("*").eq("user_id", userId).maybeSingle();
  return data ?? null;
}

before(async () => {
  if (!CREDS_AVAILABLE) return;
  await purgeFixtureUsers(adminClient(), [`${PREFIX}applicant@example.com`]);
  ({ id: uId, token: uToken } = await makeUser("applicant"));
  const { error } = await adminClient().from(TABLE).upsert(
    { user_id: uId, city: "Cebu", status: "pending", admin_status: "pending", motivation: "before" },
    { onConflict: "user_id" },
  );
  if (error) throw new Error(`fixture: could not seed application: ${error.message}`);
  const seeded = await readApp(uId);
  assert.ok(seeded, "fixture: application row must exist");
  assert.equal(seeded.status, "pending");
});
after(async () => {
  if (!CREDS_AVAILABLE) return;
  const sc = adminClient();
  if (uId) { await sc.from(TABLE).delete().eq("user_id", uId); await sc.from("profiles").delete().eq("id", uId); await sc.auth.admin.deleteUser(uId); }
});

function assertPermissionDenied(error: any, what: string): void {
  assert.ok(error, `${what}: expected a permission error, got success`);
  const code = String(error.code ?? ""); const msg = String(error.message ?? "").toLowerCase();
  assert.ok(code === "42501" || msg.includes("permission denied"), `${what}: expected 42501, got code=${code} msg=${error.message}`);
}

describe("buddy application self-approval boundary", { skip: !CREDS_AVAILABLE }, () => {
  it("a user cannot self-set admin_status", async () => {
    const before = await readApp(uId);
    const { error } = await userClient(uToken).from(TABLE).update({ admin_status: "active" }).eq("user_id", uId);
    assertPermissionDenied(error, "self admin_status");
    assert.equal((await readApp(uId))?.admin_status, before?.admin_status);
  });
  it("a user cannot self-approve (status)", async () => {
    const { error } = await userClient(uToken).from(TABLE).update({ status: "approved" }).eq("user_id", uId);
    assertPermissionDenied(error, "self status");
    assert.equal((await readApp(uId))?.status, "pending");
  });
  it("a user cannot smuggle approval alongside a content field (atomic refusal)", async () => {
    const { error } = await userClient(uToken).from(TABLE).update({ motivation: "smuggle", admin_status: "active" }).eq("user_id", uId);
    assertPermissionDenied(error, "smuggle");
    const after = await readApp(uId);
    assert.equal(after?.admin_status, "pending");
    assert.equal(after?.motivation, "before", "the content change must not have applied either");
  });
  it("the owner can still READ their own application", async () => {
    const { data, error } = await userClient(uToken).from(TABLE).select("id, status").eq("user_id", uId);
    assert.ifError(error);
    assert.equal((data ?? []).length, 1);
  });
  it("the service role can still run the admin review", async () => {
    const { error } = await adminClient().from(TABLE).update({ status: "approved", admin_status: "active" }).eq("user_id", uId);
    assert.ifError(error);
    assert.equal((await readApp(uId))?.status, "approved");
  });
});
