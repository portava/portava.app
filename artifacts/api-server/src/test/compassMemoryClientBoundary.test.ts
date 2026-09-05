/**
 * compassMemoryClientBoundary.test.ts — public.compass_memories client access boundary.
 *
 * RED before migration 2161, GREEN after. Verified on portava-ci: pre-2161
 * compass_memories had RLS OFF and anon+authenticated held the full GRANT ALL
 * bundle, so ANY caller could read every user's private Compass memories and
 * forge/alter/impersonate rows (writing a victim's user_id with attacker-chosen
 * `content` that buildMemoryPromptBlock later loads into the victim's Compass LLM
 * prompt — a stored prompt-injection vector). Post-2161 anon+authenticated hold
 * zero privileges; every legitimate read/write is service-role (routes/compass.ts
 * getServiceClient()).
 *
 * Live-DB suite: kept out of the curated npm test list; run by the live-DB job.
 * Run: node --import tsx/esm --test src/test/compassMemoryClientBoundary.test.ts
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
if (!CREDS_AVAILABLE) console.warn("\n[compassMemoryClientBoundary] SKIPPING — no live credentials.\n");

function adminClient(): SupabaseClient { return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } }); }
function anonClient(): SupabaseClient { return createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } }); }
function userClient(t: string): SupabaseClient {
  return createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${t}` } } });
}

const PREFIX = "compass_mem_test_";
const PASSWORD = "test-password-123";
const TABLE = "compass_memories";
let ownerId = "", strangerId = "", strangerToken = "", memId = "";

async function makeUser(tag: string): Promise<{ id: string; token: string }> {
  const sc = adminClient();
  const email = fixtureEmail(`${PREFIX}${tag}@example.com`);
  const { data: c, error: cErr } = await sc.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (cErr || !c?.user) throw new Error(`createUser(${tag}): ${cErr?.message}`);
  const id = c.user.id;
  const { error: pErr } = await sc.from("profiles").upsert({ id, handle: fixtureLabel(`${PREFIX}${tag}`), username: fixtureLabel(`${PREFIX}${tag}`), name: `cm ${tag}` }, { onConflict: "id" });
  if (pErr) throw new Error(`profile(${tag}): ${pErr.message}`);
  const { data: s, error: sErr } = await anonClient().auth.signInWithPassword({ email, password: PASSWORD });
  if (sErr || !s?.session) throw new Error(`signIn(${tag}): ${sErr?.message}`);
  return { id, token: s.session.access_token };
}

before(async () => {
  if (!CREDS_AVAILABLE) return;
  await purgeFixtureUsers(adminClient(), [fixtureEmail(`${PREFIX}owner@example.com`), fixtureEmail(`${PREFIX}stranger@example.com`)]);
  ({ id: ownerId } = await makeUser("owner"));
  ({ id: strangerId, token: strangerToken } = await makeUser("stranger"));
  const { data, error } = await adminClient().from(TABLE)
    .insert({ user_id: ownerId, scope: "long_term", category: "food", content: "owner secret preference", source: "taught", confidence: 0.8 })
    .select("id").single();
  if (error) throw new Error(`fixture memory: ${error.message}`);
  memId = (data as any).id;
});
after(async () => {
  if (!CREDS_AVAILABLE) return;
  const sc = adminClient();
  for (const u of [ownerId, strangerId]) if (u) await sc.from(TABLE).delete().eq("user_id", u);
  await purgeFixtureUsers(sc, [fixtureEmail(`${PREFIX}owner@example.com`), fixtureEmail(`${PREFIX}stranger@example.com`)]);
});

async function memoryConfidence(id: string): Promise<number | null> {
  const { data } = await adminClient().from(TABLE).select("confidence").eq("id", id).maybeSingle();
  return data ? Number((data as any).confidence) : null;
}

describe("compass_memories client access boundary", { skip: !CREDS_AVAILABLE }, () => {
  it("a stranger cannot READ another user's memories", async () => {
    const { data, error } = await userClient(strangerToken).from(TABLE).select("id, content, user_id").eq("id", memId);
    // No SELECT grant => either a permission error, or an empty set. Never the owner's content.
    if (!error) assert.equal((data ?? []).length, 0, "no memory rows may be visible to a stranger");
  });
  it("anon cannot READ memories", async () => {
    const { data, error } = await anonClient().from(TABLE).select("id").eq("id", memId);
    if (!error) assert.equal((data ?? []).length, 0, "anon must not read any memory");
  });
  it("a stranger cannot UPDATE another user's memory confidence", async () => {
    const before = await memoryConfidence(memId);
    const { error } = await userClient(strangerToken).from(TABLE).update({ confidence: 1 }).eq("id", memId);
    assert.ok(error, "update must be refused (no privilege)");
    assert.equal(await memoryConfidence(memId), before, "confidence must be unchanged");
  });
  it("a stranger cannot INSERT a row impersonating a victim", async () => {
    const { error } = await userClient(strangerToken).from(TABLE)
      .insert({ user_id: ownerId, scope: "long_term", category: "food", content: "injected", source: "taught", confidence: 1 });
    assert.ok(error, "insert must be refused");
    const { data } = await adminClient().from(TABLE).select("id").eq("user_id", ownerId).eq("content", "injected");
    assert.equal((data ?? []).length, 0, "no forged row may be created");
  });
  it("a stranger cannot DELETE a memory", async () => {
    const { error } = await userClient(strangerToken).from(TABLE).delete().eq("id", memId);
    assert.ok(error, "delete must be refused");
    assert.ok(await memoryConfidence(memId) !== null, "the memory must survive");
  });
  it("the service role retains full access (the legitimate mechanism)", async () => {
    const sc = adminClient();
    const { error: uErr } = await sc.from(TABLE).update({ confidence: 0.95 }).eq("id", memId);
    assert.ifError(uErr);
    assert.equal(await memoryConfidence(memId), 0.95, "service role must retain write access");
    const { data, error: iErr } = await sc.from(TABLE)
      .insert({ user_id: ownerId, scope: "long_term", category: "food", content: "svc", source: "taught", confidence: 0.5 }).select("id").single();
    assert.ifError(iErr);
    await sc.from(TABLE).delete().eq("id", (data as any).id);
  });
});
