/**
 * Memory lifecycle — LIVE DATABASE regression suite.
 *
 * WHY THIS EXISTS
 * ---------------
 * An audit of the memory system (migrations 2183-2191) found four blocking
 * defects, and correctly criticised the test coverage: every existing memory
 * test mocks the Supabase client, so none of them exercises the SQL where the
 * defects actually lived. Mocking a projector proves nothing about a projector.
 *
 * These tests run against the sanctioned CI database and pin the properties that
 * broke, so they cannot silently regress:
 *
 *   1. anon cannot read memory at all (no enumeration of derived personal data)
 *   2. retrieval is user-scoped — one user never sees another's memory
 *   3. hide/forget actually suppresses, via the id retrieval now returns
 *   4. a forget SURVIVES re-projection (it used to be cascade-deleted by it)
 *   5. expired memory is excluded from retrieval and removed by the sweep
 *   6. retraction removes memory whose supporting evidence disappeared
 *   7. account-deletion erasure purges everything, is idempotent, and does not
 *      touch other users
 *
 * NOTE ON SKIPPING: `.github/scripts/run-live-suite.sh` scores this suite on its
 * OUTPUT (pass > 0 AND skipped == 0), not its exit code, so a run without
 * credentials fails the job rather than passing vacuously.
 *
 * Run: node --import tsx/esm --env-file-if-exists=.env --test src/test/memoryLifecycleLive.test.ts
 */
// FIRST import, deliberately: refuses to let this process reach an unsanctioned
// database before the Supabase client library is even loaded.
import "../lib/ciSupabaseGuard.mjs";

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const ANON_KEY =
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY ?? "";
const CREDS = Boolean(SUPABASE_URL && SERVICE_ROLE_KEY && ANON_KEY);

const admin = (): SupabaseClient =>
  createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const anon = (): SupabaseClient =>
  createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });

/** Deterministic fixtures so cleanup is reliable even after a crashed run. */
const TAG = "memlife_live_";
const EMAIL_A = `${TAG}a@portava-test.invalid`;
const EMAIL_B = `${TAG}b@portava-test.invalid`;

let sc: SupabaseClient;
let userA = "";
let userB = "";

/** Create (or reuse) an auth user + profile, returning its id. */
async function ensureUser(email: string, handle: string): Promise<string> {
  const { data: created, error } = await sc.auth.admin.createUser({
    email, password: `${TAG}Pw!23456`, email_confirm: true,
  });
  let id = created?.user?.id ?? "";
  if (error || !id) {
    // Already exists from a previous run — find it.
    const { data: list } = await sc.auth.admin.listUsers();
    id = (list?.users ?? []).find((u: any) => u.email === email)?.id ?? "";
  }
  if (!id) throw new Error(`could not create or find test user ${email}`);
  await sc.from("profiles").upsert({ id, handle, name: handle }, { onConflict: "id" });
  return id;
}

async function purge(userId: string): Promise<void> {
  if (!userId) return;
  await sc.rpc("erase_memory_for_user", { p_user_id: userId });
  await sc.from("user_follows").delete().eq("follower_id", userId);
  await sc.from("blocks").delete().eq("blocker_id", userId);
  await sc.from("compass_user_preferences").delete().eq("user_id", userId);
  await sc.from("compass_graph_edges").delete().eq("src_key", userId);
}

before(async () => {
  if (!CREDS) return;
  sc = admin();
  userA = await ensureUser(EMAIL_A, `${TAG}a`);
  userB = await ensureUser(EMAIL_B, `${TAG}b`);
  await purge(userA);
  await purge(userB);
});

after(async () => {
  if (!CREDS || !sc) return;
  await purge(userA);
  await purge(userB);
  for (const id of [userA, userB]) {
    if (id) await sc.auth.admin.deleteUser(id).catch(() => {});
  }
});

/** Seed one projection directly (service_role bypasses RLS). */
async function seed(userId: string, over: Record<string, unknown> = {}) {
  const row = {
    user_id: userId, memory_type: "episodic", subject_type: "city",
    subject_id: "Lisbon", content: "Visited Lisbon", confidence: 0.9,
    retention_class: "durable_fact", ...over,
  };
  const { error } = await sc.from("memory_projections").upsert(row, {
    onConflict: "user_id,memory_type,subject_type,subject_id",
  });
  if (error) throw new Error(`seed failed: ${error.message}`);
}

describe("memory lifecycle (live DB)", () => {
  it("anon cannot enumerate derived memory — no coordinates, no facts, nothing", async (t) => {
    if (!CREDS) return t.skip("credentials absent");
    const client = anon();
    for (const table of ["memory_projections", "memory_events", "memory_feedback"]) {
      const { data, error } = await client.from(table).select("*").limit(5);
      const blocked = Boolean(error) || (Array.isArray(data) && data.length === 0);
      assert.ok(blocked, `anon must not read ${table} (got ${JSON.stringify(data)})`);
    }
  });

  it("anon cannot execute the memory functions", async (t) => {
    if (!CREDS) return t.skip("credentials absent");
    const client = anon();
    const { error } = await client.rpc("memory_retrieve", {
      p_user_id: userA, p_surface: "compass", p_limit: 5,
    });
    assert.ok(error, "anon must not be able to execute memory_retrieve");
  });

  it("retrieval is user-scoped — B's memory never appears for A", async (t) => {
    if (!CREDS) return t.skip("credentials absent");
    await seed(userA, { subject_id: "Lisbon", content: "A visited Lisbon" });
    await seed(userB, { subject_id: "Porto", content: "B visited Porto" });

    const { data, error } = await sc.rpc("memory_retrieve", {
      p_user_id: userA, p_surface: "compass", p_limit: 50,
    });
    assert.equal(error, null);
    const subjects = (data ?? []).map((r: any) => r.subject_id);
    assert.ok(subjects.includes("Lisbon"), "A must see their own memory");
    assert.ok(!subjects.includes("Porto"), "A must NOT see B's memory");
  });

  it("retrieval returns an id, and hide via that id suppresses the memory", async (t) => {
    if (!CREDS) return t.skip("credentials absent");
    await seed(userA, { subject_id: "Madrid", content: "A visited Madrid" });

    const { data: before } = await sc.rpc("memory_retrieve", { p_user_id: userA, p_surface: "compass", p_limit: 50 });
    const target = (before ?? []).find((r: any) => r.subject_id === "Madrid");
    assert.ok(target, "the seeded memory should be retrievable");
    assert.ok(target.id, "retrieval MUST return an id or hide/forget is unaddressable");

    await sc.from("memory_feedback").insert({
      user_id: userA, projection_id: target.id, memory_type: target.memory_type,
      subject_type: target.subject_type, subject_id: target.subject_id, kind: "hide",
    });

    const { data: after } = await sc.rpc("memory_retrieve", { p_user_id: userA, p_surface: "compass", p_limit: 50 });
    assert.ok(!(after ?? []).some((r: any) => r.subject_id === "Madrid"), "hidden memory must not be returned");
  });

  it("a forget SURVIVES the projection being deleted and re-created", async (t) => {
    if (!CREDS) return t.skip("credentials absent");
    await seed(userA, { subject_id: "Seville", content: "A visited Seville" });
    const { data: rows } = await sc.rpc("memory_retrieve", { p_user_id: userA, p_surface: "compass", p_limit: 50 });
    const row = (rows ?? []).find((r: any) => r.subject_id === "Seville");
    assert.ok(row);

    await sc.from("memory_feedback").insert({
      user_id: userA, projection_id: row.id, memory_type: row.memory_type,
      subject_type: row.subject_type, subject_id: row.subject_id, kind: "forget",
    });
    // Simulate re-projection replacing the row entirely.
    await sc.from("memory_projections").delete().eq("id", row.id);
    await seed(userA, { subject_id: "Seville", content: "A visited Seville" });

    const { data: after } = await sc.rpc("memory_retrieve", { p_user_id: userA, p_surface: "compass", p_limit: 50 });
    assert.ok(
      !(after ?? []).some((r: any) => r.subject_id === "Seville"),
      "a forgotten memory must stay forgotten across re-projection",
    );
  });

  it("expired memory is excluded from retrieval and removed by the sweep", async (t) => {
    if (!CREDS) return t.skip("credentials absent");
    // Controlled time: set valid_to in the past rather than waiting.
    await seed(userA, {
      subject_id: "ephemeral-topic", memory_type: "intent", subject_type: "intent",
      content: "wants nightlife", retention_class: "ephemeral",
      valid_to: new Date(Date.now() - 60_000).toISOString(),
    });

    const { data: retrieved } = await sc.rpc("memory_retrieve", { p_user_id: userA, p_surface: "compass", p_limit: 50 });
    assert.ok(!(retrieved ?? []).some((r: any) => r.subject_id === "ephemeral-topic"),
      "expired memory must not be retrievable");

    const { error: sweepErr } = await sc.rpc("memory_sweep_expired", { p_enforce_flag: false });
    assert.equal(sweepErr, null);

    const { data: left } = await sc.from("memory_projections").select("id")
      .eq("user_id", userA).eq("subject_id", "ephemeral-topic");
    assert.equal((left ?? []).length, 0, "ephemeral memory must be deleted by the sweep");
  });

  it("retraction removes memory whose supporting evidence disappeared", async (t) => {
    if (!CREDS) return t.skip("credentials absent");
    // Give A a real, re-projectable source: a follow of B.
    await sc.from("user_follows").upsert(
      { follower_id: userA, following_id: userB }, { onConflict: "follower_id,following_id" },
    );
    await sc.rpc("project_user_memory_with_retraction", { p_user_id: userA, p_enforce_flag: false });

    const { data: withFollow } = await sc.from("memory_projections")
      .select("id").eq("user_id", userA).eq("memory_type", "social").eq("state", "active");
    assert.ok((withFollow ?? []).length > 0, "following B should project social memory");

    // Remove the evidence, re-project: the memory must lose support.
    await sc.from("user_follows").delete().eq("follower_id", userA).eq("following_id", userB);
    await sc.rpc("project_user_memory_with_retraction", { p_user_id: userA, p_enforce_flag: false });

    const { data: afterUnfollow } = await sc.from("memory_projections")
      .select("id").eq("user_id", userA).eq("memory_type", "social").eq("state", "active");
    assert.equal((afterUnfollow ?? []).length, 0, "unfollow must retract the derived social memory");
  });

  it("erasure purges everything for the user, is idempotent, and spares other users", async (t) => {
    if (!CREDS) return t.skip("credentials absent");
    await seed(userA, { subject_id: "Granada", content: "A visited Granada" });
    await seed(userB, { subject_id: "Bilbao", content: "B visited Bilbao" });

    const { error } = await sc.rpc("erase_memory_for_user", { p_user_id: userA });
    assert.equal(error, null);

    const { data: aLeft } = await sc.from("memory_projections").select("id").eq("user_id", userA);
    assert.equal((aLeft ?? []).length, 0, "no memory may survive erasure");

    const { data: aFeedback } = await sc.from("memory_feedback").select("id").eq("user_id", userA);
    assert.equal((aFeedback ?? []).length, 0, "feedback must be erased too");

    // Idempotent: a second run is safe.
    const { error: second } = await sc.rpc("erase_memory_for_user", { p_user_id: userA });
    assert.equal(second, null, "re-running erasure must be safe");

    const { data: bLeft } = await sc.from("memory_projections").select("id").eq("user_id", userB);
    assert.ok((bLeft ?? []).length > 0, "another user's memory must be untouched");
  });
});
