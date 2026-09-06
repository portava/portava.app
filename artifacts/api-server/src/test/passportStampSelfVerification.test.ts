/**
 * passportStampSelfVerification.test.ts — the passport-stamp verification boundary.
 *
 * RED before migration 2149, GREEN after. Verified on portava-ci: pre-2149 an
 * owner self-set verification_level='verified' on their own stamp (1 row);
 * post-2149 it fails 42501, while owner stamp content stays writable.
 *
 * verification_level is the platform's trust assertion on a stamp (ranked by
 * PassportMapService.verificationRank, feeds trustScore + booking gates). The
 * award/verification engine sets it via the service-role client; a direct
 * PostgREST write with the public anon key must not. source_type (award
 * provenance), catalog_id (canonical identity) and artwork_override are
 * likewise platform-set. 2149 grants authenticated column INSERT/UPDATE on the
 * user content columns only.
 *
 * Live-DB suite: kept out of the curated npm test list; run by the live-DB job.
 * Run: node --import tsx/esm --test src/test/passportStampSelfVerification.test.ts
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
if (!CREDS_AVAILABLE) console.warn("\n[passportStampSelfVerification] SKIPPING — no live credentials.\n");

function adminClient(): SupabaseClient { return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } }); }
function anonClient(): SupabaseClient { return createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } }); }
function userClient(t: string): SupabaseClient {
  return createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${t}` } } });
}

const PREFIX = "stamp_verify_test_";
const PASSWORD = "test-password-123";
const TABLE = "passport_stamps";
let ownerId = "", ownerToken = "", strangerId = "", stampId = "";

async function makeUser(tag: string): Promise<{ id: string; token: string }> {
  const sc = adminClient();
  const email = fixtureEmail(`${PREFIX}${tag}@example.com`);
  const { data: c, error: cErr } = await sc.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (cErr || !c?.user) throw new Error(`createUser(${tag}): ${cErr?.message}`);
  const id = c.user.id;
  const { error: pErr } = await sc.from("profiles").upsert({ id, handle: fixtureLabel(`${PREFIX}${tag}`), username: fixtureLabel(`${PREFIX}${tag}`), name: `st ${tag}` }, { onConflict: "id" });
  if (pErr) throw new Error(`profile(${tag}): ${pErr.message}`);
  const { data: s, error: sErr } = await anonClient().auth.signInWithPassword({ email, password: PASSWORD });
  if (sErr || !s?.session) throw new Error(`signIn(${tag}): ${sErr?.message}`);
  return { id, token: s.session.access_token };
}
async function readStamp(id: string): Promise<any | null> {
  const { data } = await adminClient().from(TABLE).select("*").eq("id", id).maybeSingle();
  return data ?? null;
}

before(async () => {
  if (!CREDS_AVAILABLE) return;
  await purgeFixtureUsers(adminClient(), [fixtureEmail(`${PREFIX}owner@example.com`), fixtureEmail(`${PREFIX}stranger@example.com`)]);
  ({ id: ownerId, token: ownerToken } = await makeUser("owner"));
  ({ id: strangerId } = await makeUser("stranger"));
  const { data, error } = await adminClient().from(TABLE)
    .insert({ user_id: ownerId, stamp_type: "destination", verification_level: "unverified", visibility: "private", city: "Cebu" })
    .select("id").single();
  if (error) throw new Error(`fixture: could not seed stamp: ${error.message}`);
  stampId = (data as any).id;
  assert.equal((await readStamp(stampId))?.verification_level, "unverified");
});
after(async () => {
  if (!CREDS_AVAILABLE) return;
  const sc = adminClient();
  if (stampId) await sc.from(TABLE).delete().eq("id", stampId);
  for (const id of [ownerId, strangerId]) if (id) { await sc.from(TABLE).delete().eq("user_id", id); await sc.from("profiles").delete().eq("id", id); await sc.auth.admin.deleteUser(id); }
});

function assertDenied(error: any, what: string): void {
  assert.ok(error, `${what}: expected a permission error, got success`);
  const code = String(error.code ?? ""); const msg = String(error.message ?? "").toLowerCase();
  assert.ok(code === "42501" || msg.includes("permission denied"), `${what}: expected 42501, got code=${code} msg=${error.message}`);
}

describe("passport_stamps verification boundary", { skip: !CREDS_AVAILABLE }, () => {
  for (const [col, val] of [["verification_level", "verified"], ["source_type", "admin"]] as const) {
    it(`owner cannot self-set ${col}`, async () => {
      const before = await readStamp(stampId);
      const { error } = await userClient(ownerToken).from(TABLE).update({ [col]: val }).eq("id", stampId);
      assertDenied(error, `self ${col}`);
      assert.equal((await readStamp(stampId))?.[col], before?.[col]);
    });
  }
  it("owner cannot self-set artwork_override", async () => {
    const { error } = await userClient(ownerToken).from(TABLE).update({ artwork_override: { x: 1 } }).eq("id", stampId);
    assertDenied(error, "artwork_override");
    assert.equal((await readStamp(stampId))?.artwork_override, null);
  });
  it("a mixed content+verification UPDATE fails atomically", async () => {
    const { error } = await userClient(ownerToken).from(TABLE).update({ city: "Davao", verification_level: "verified" }).eq("id", stampId);
    assertDenied(error, "mixed");
    const s = await readStamp(stampId);
    assert.equal(s?.verification_level, "unverified");
    assert.equal(s?.city, "Cebu", "content change must not apply either");
  });
  it("owner CAN edit stamp content (visibility, city)", async () => {
    const { error } = await userClient(ownerToken).from(TABLE).update({ visibility: "public", city: "Manila" }).eq("id", stampId);
    assert.ifError(error);
    const s = await readStamp(stampId);
    assert.equal(s?.visibility, "public");
    assert.equal(s?.city, "Manila");
  });
  it("owner CAN create own stamp content, but it is unverified and cannot forge verification", async () => {
    const uc = userClient(ownerToken);
    const { data, error } = await uc.from(TABLE).insert({ user_id: ownerId, stamp_type: "event", city: "Baguio", visibility: "private" }).select("id, verification_level").single();
    assert.ifError(error);
    assert.equal((data as any)?.verification_level, "unverified", "a self-inserted stamp must be unverified");
    await adminClient().from(TABLE).delete().eq("id", (data as any).id);
    // forging verification at insert is denied
    const { error: fErr } = await uc.from(TABLE).insert({ user_id: ownerId, stamp_type: "event", verification_level: "verified" });
    assertDenied(fErr, "insert-forge verification_level");
  });
  it("owner cannot mutate a stranger's stamp", async () => {
    const { data: other } = await adminClient().from(TABLE).insert({ user_id: strangerId, stamp_type: "destination", city: "theirs" }).select("id").single();
    const otherId = (other as any).id;
    const { error } = await userClient(ownerToken).from(TABLE).update({ city: "hijack" }).eq("id", otherId);
    if (!error) assert.equal((await readStamp(otherId))?.city, "theirs");
    await adminClient().from(TABLE).delete().eq("id", otherId);
  });
  it("the service role can still assign platform verification", async () => {
    const { error } = await adminClient().from(TABLE).update({ verification_level: "verified", source_type: "admin" }).eq("id", stampId);
    assert.ifError(error);
    const s = await readStamp(stampId);
    assert.equal(s?.verification_level, "verified");
  });
  it("anon can read public stamps but cannot write", async () => {
    const { error: rErr } = await anonClient().from(TABLE).select("id").eq("visibility", "public").limit(1);
    assert.ifError(rErr);
    const { error: wErr } = await anonClient().from(TABLE).update({ verification_level: "verified" }).eq("id", stampId);
    assert.ok(wErr, "anon must not write");
  });
});
