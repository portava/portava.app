/**
 * passportMemorySelfVerification.test.ts — the passport-memory verification boundary.
 *
 * RED before migration 2150, GREEN after. Verified on portava-ci: pre-2150 an
 * owner self-set verification_level='verified' on their own memory (1 row);
 * post-2150 it fails 42501 — while the owner's SELF-SERVICE state machine
 * (accept/dismiss a suggested memory via status, and visibility changes) still
 * works. This test deliberately proves status + visibility are NOT locked down.
 *
 * verification_level is the platform trust assertion; the system provenance
 * columns (source_type, source_id, suggestion_reason, plan_id, trip_id,
 * place_id, metadata) are set by the memory service (service-role). 2150 grants
 * authenticated column INSERT/UPDATE on user content + status + visibility only.
 *
 * Live-DB suite. Run: node --import tsx/esm --test src/test/passportMemorySelfVerification.test.ts
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
if (!CREDS_AVAILABLE) console.warn("\n[passportMemorySelfVerification] SKIPPING — no live credentials.\n");

function adminClient(): SupabaseClient { return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } }); }
function anonClient(): SupabaseClient { return createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } }); }
function userClient(t: string): SupabaseClient {
  return createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${t}` } } });
}

const PREFIX = "memory_verify_test_";
const PASSWORD = "test-password-123";
const TABLE = "passport_memories";
let ownerId = "", ownerToken = "", strangerId = "", memId = "";

async function makeUser(tag: string): Promise<{ id: string; token: string }> {
  const sc = adminClient();
  const email = fixtureEmail(`${PREFIX}${tag}@example.com`);
  const { data: c, error: cErr } = await sc.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (cErr || !c?.user) throw new Error(`createUser(${tag}): ${cErr?.message}`);
  const id = c.user.id;
  const { error: pErr } = await sc.from("profiles").upsert({ id, handle: `${PREFIX}${tag}`, username: `${PREFIX}${tag}`, name: `mm ${tag}` }, { onConflict: "id" });
  if (pErr) throw new Error(`profile(${tag}): ${pErr.message}`);
  const { data: s, error: sErr } = await anonClient().auth.signInWithPassword({ email, password: PASSWORD });
  if (sErr || !s?.session) throw new Error(`signIn(${tag}): ${sErr?.message}`);
  return { id, token: s.session.access_token };
}
async function readMem(id: string): Promise<any | null> {
  const { data } = await adminClient().from(TABLE).select("*").eq("id", id).maybeSingle();
  return data ?? null;
}

before(async () => {
  if (!CREDS_AVAILABLE) return;
  await purgeFixtureUsers(adminClient(), [fixtureEmail(`${PREFIX}owner@example.com`), fixtureEmail(`${PREFIX}stranger@example.com`)]);
  ({ id: ownerId, token: ownerToken } = await makeUser("owner"));
  ({ id: strangerId } = await makeUser("stranger"));
  const { data, error } = await adminClient().from(TABLE)
    .insert({ user_id: ownerId, title: "before", status: "suggested", visibility: "private", verification_level: "unverified", suggestion_reason: "sys-reason" })
    .select("id").single();
  if (error) throw new Error(`fixture: could not seed memory: ${error.message}`);
  memId = (data as any).id;
  assert.equal((await readMem(memId))?.verification_level, "unverified");
});
after(async () => {
  if (!CREDS_AVAILABLE) return;
  const sc = adminClient();
  if (memId) await sc.from(TABLE).delete().eq("id", memId);
  for (const id of [ownerId, strangerId]) if (id) { await sc.from(TABLE).delete().eq("user_id", id); await sc.from("profiles").delete().eq("id", id); await sc.auth.admin.deleteUser(id); }
});

function assertDenied(error: any, what: string): void {
  assert.ok(error, `${what}: expected a permission error, got success`);
  const code = String(error.code ?? ""); const msg = String(error.message ?? "").toLowerCase();
  assert.ok(code === "42501" || msg.includes("permission denied"), `${what}: expected 42501, got code=${code} msg=${error.message}`);
}

describe("passport_memories verification boundary", { skip: !CREDS_AVAILABLE }, () => {
  it("owner cannot self-set verification_level", async () => {
    const { error } = await userClient(ownerToken).from(TABLE).update({ verification_level: "verified" }).eq("id", memId);
    assertDenied(error, "verification_level");
    assert.equal((await readMem(memId))?.verification_level, "unverified");
  });
  it("owner cannot self-set suggestion_reason (system provenance)", async () => {
    const { error } = await userClient(ownerToken).from(TABLE).update({ suggestion_reason: "forged" }).eq("id", memId);
    assertDenied(error, "suggestion_reason");
    assert.equal((await readMem(memId))?.suggestion_reason, "sys-reason");
  });

  // The self-service semantics the owner requires to STAY OPEN.
  it("owner CAN accept a suggested memory (status -> active)", async () => {
    const { error } = await userClient(ownerToken).from(TABLE).update({ status: "active" }).eq("id", memId);
    assert.ifError(error);
    assert.equal((await readMem(memId))?.status, "active");
  });
  it("owner CAN dismiss a suggested memory (status -> dismissed)", async () => {
    const { error } = await userClient(ownerToken).from(TABLE).update({ status: "dismissed" }).eq("id", memId);
    assert.ifError(error);
    assert.equal((await readMem(memId))?.status, "dismissed");
  });
  it("owner CAN change visibility", async () => {
    const { error } = await userClient(ownerToken).from(TABLE).update({ visibility: "public" }).eq("id", memId);
    assert.ifError(error);
    assert.equal((await readMem(memId))?.visibility, "public");
  });
  it("owner CAN edit memory content", async () => {
    const { error } = await userClient(ownerToken).from(TABLE).update({ title: "mine", description: "d", city: "Cebu" }).eq("id", memId);
    assert.ifError(error);
    assert.equal((await readMem(memId))?.title, "mine");
  });

  it("a mixed content+verification UPDATE fails atomically", async () => {
    const before = await readMem(memId);
    const { error } = await userClient(ownerToken).from(TABLE).update({ title: "smuggle", verification_level: "verified" }).eq("id", memId);
    assertDenied(error, "mixed");
    const m = await readMem(memId);
    assert.equal(m?.verification_level, "unverified");
    assert.equal(m?.title, before?.title, "content change must not apply either");
  });
  it("owner CAN create own memory, but it is unverified", async () => {
    const { data, error } = await userClient(ownerToken).from(TABLE).insert({ user_id: ownerId, title: "new", status: "active", visibility: "public" }).select("id, verification_level").single();
    assert.ifError(error);
    assert.equal((data as any)?.verification_level, "unverified");
    await adminClient().from(TABLE).delete().eq("id", (data as any).id);
  });
  it("owner cannot mutate a stranger's memory", async () => {
    const { data: other } = await adminClient().from(TABLE).insert({ user_id: strangerId, title: "theirs" }).select("id").single();
    const otherId = (other as any).id;
    const { error } = await userClient(ownerToken).from(TABLE).update({ title: "hijack" }).eq("id", otherId);
    if (!error) assert.equal((await readMem(otherId))?.title, "theirs");
    await adminClient().from(TABLE).delete().eq("id", otherId);
  });
  it("the service role can still assign platform verification", async () => {
    const { error } = await adminClient().from(TABLE).update({ verification_level: "verified" }).eq("id", memId);
    assert.ifError(error);
    assert.equal((await readMem(memId))?.verification_level, "verified");
  });
});
