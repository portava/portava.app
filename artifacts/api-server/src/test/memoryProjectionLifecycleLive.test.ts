/**
 * Memory PROJECTION lifecycle — the invariants the scheduler depends on.
 *
 * WHY THIS EXISTS (2026-08-29)
 * ----------------------------
 * memoryLifecycleLive covers what happens to memory once it exists: retrieval
 * scoping, hide/forget durability, expiry, reset, export, erasure. It seeds rows
 * directly. Nothing exercised the PROJECTOR itself against a live database, so
 * the properties the 6-hourly scheduler leans on were unproven:
 *
 *   - repeated passes are idempotent (the scheduler's whole safety argument:
 *     "cadence only affects freshness, never correctness")
 *   - a restart, which re-runs a pass over the same inputs, does not duplicate
 *   - two app instances projecting the same user concurrently cannot corrupt
 *   - ineligible input produces NO memory in the first place
 *   - everything produced is private by default (§19)
 *
 * SCOPE NOTE. These call `project_user_memory_with_retraction`, which is exactly
 * what `project_all_memory` invokes per user — the same code path the scheduler
 * drives — but scoped to one user. Calling the fan-out here would project every
 * fixture user on the CI database and could disturb suites running beside this
 * one. The concurrency hazard is per-user retraction anyway, so the scoped call
 * is the sharper test, not a weaker one.
 *
 * Run: node --import tsx/esm --env-file-if-exists=.env --test src/test/memoryProjectionLifecycleLive.test.ts
 */
import "../lib/ciSupabaseGuard.mjs";

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const CREDS = Boolean(SUPABASE_URL && SERVICE_ROLE_KEY);

const TAG = "memproj_live_";
const EMAIL_A = `${TAG}a@portava-test.invalid`;
const EMAIL_B = `${TAG}b@portava-test.invalid`;

let sc: SupabaseClient;
let userA = "";
let userB = "";

async function ensureUser(email: string, handle: string): Promise<string> {
  const { data: created, error } = await sc.auth.admin.createUser({
    email, password: `${TAG}Pw!23456`, email_confirm: true,
  });
  let id = created?.user?.id ?? "";
  if (error || !id) {
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

/** One pass for one user — the unit `project_all_memory` fans out to. */
async function pass(userId: string) {
  const { data, error } = await sc.rpc("project_user_memory_with_retraction", {
    p_user_id: userId, p_enforce_flag: false,
  });
  if (error) throw new Error(`projection pass failed: ${error.message}`);
  return Array.isArray(data) ? data[0] : data;
}

async function projections(userId: string) {
  const { data } = await sc.from("memory_projections")
    .select("id, memory_type, subject_type, subject_id, state, visibility, content")
    .eq("user_id", userId).order("subject_id");
  return (data ?? []) as any[];
}

async function events(userId: string) {
  const { data } = await sc.from("memory_events").select("id, subject_type, subject_id")
    .eq("user_id", userId);
  return (data ?? []) as any[];
}

/** Give userA one city visit and one follow of userB. */
async function seedSources() {
  await sc.from("compass_graph_edges").insert({
    src_type: "person", src_key: userA, dst_type: "city", dst_key: "Lisbon",
    edge_type: "visited", observed_count: 3,
    first_seen: new Date(Date.now() - 86_400_000).toISOString(),
    last_seen: new Date().toISOString(),
  });
  await sc.from("user_follows").insert({ follower_id: userA, following_id: userB });
}

before(async () => {
  if (!CREDS) return;
  sc = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  userA = await ensureUser(EMAIL_A, `${TAG}a`);
  userB = await ensureUser(EMAIL_B, `${TAG}b`);
  await purge(userA); await purge(userB);
});

after(async () => {
  if (!CREDS || !sc) return;
  await purge(userA); await purge(userB);
  for (const id of [userA, userB]) if (id) await sc.auth.admin.deleteUser(id).catch(() => {});
});

describe("repeated scheduler passes are idempotent", () => {
  it("a second pass over identical inputs changes nothing", async (t) => {
    if (!CREDS) return t.skip("credentials absent");
    await purge(userA); await seedSources();

    await pass(userA);
    const first = await projections(userA);
    const firstEvents = await events(userA);
    assert.ok(first.length > 0, "the first pass must actually project something");

    await pass(userA);
    const second = await projections(userA);
    const secondEvents = await events(userA);

    assert.equal(second.length, first.length, "row COUNT must not grow");
    assert.deepEqual(
      second.map((r) => r.id).sort(),
      first.map((r) => r.id).sort(),
      "the same rows must be UPDATED, never duplicated — ids must be stable",
    );
    assert.equal(secondEvents.length, firstEvents.length, "the append-only ledger must not double-write");
  });

  it("a THIRD and FOURTH pass still change nothing — this is the cadence argument", async (t) => {
    if (!CREDS) return t.skip("credentials absent");
    // The scheduler's safety claim is "cadence only affects freshness, never
    // correctness". That is only true if passes converge.
    const before = (await projections(userA)).length;
    await pass(userA); await pass(userA);
    assert.equal((await projections(userA)).length, before);
  });

  it("a process RESTART re-running the pass does not duplicate state", async (t) => {
    if (!CREDS) return t.skip("credentials absent");
    // A restart carries no in-process memory: the new process simply runs a pass
    // over the same inputs after its startup delay. That must be a no-op, which
    // is what makes restarts and redeploys safe.
    const before = await projections(userA);
    await pass(userA);
    const after = await projections(userA);
    assert.deepEqual(after.map((r) => r.id).sort(), before.map((r) => r.id).sort());
  });
});

describe("two app instances projecting the same user concurrently", () => {
  it("cannot duplicate rows or falsely retract supported memory", async (t) => {
    if (!CREDS) return t.skip("credentials absent");
    // The real multi-instance hazard is not the upsert — that is protected by
    // the unique keys. It is RETRACTION: each pass stamps last_projected_at and
    // then retracts anything older than its own start, so a slow pass finishing
    // beside a fast one could in principle bury still-supported memory.
    await purge(userA); await seedSources();
    await pass(userA);
    const baseline = await projections(userA);
    assert.ok(baseline.length > 0);

    // Fire two full passes at once, as two app instances would.
    await Promise.all([pass(userA), pass(userA), pass(userA)]);

    const after = await projections(userA);
    assert.deepEqual(
      after.map((r) => r.id).sort(), baseline.map((r) => r.id).sort(),
      "concurrent passes must not create or drop rows",
    );
    const retracted = after.filter((r) => r.state === "retracted");
    assert.deepEqual(retracted, [],
      "no supported memory may be retracted by a concurrent pass — a false retraction " +
      "would hide real memory from the user until the next pass re-affirmed it",
    );
    assert.ok(after.every((r) => r.state === "active"), "every row stays active");
  });

  it("concurrent passes do not duplicate ledger events either", async (t) => {
    if (!CREDS) return t.skip("credentials absent");
    const before = (await events(userA)).length;
    await Promise.all([pass(userA), pass(userA)]);
    assert.equal((await events(userA)).length, before,
      "memory_events is deduped by a unique key; concurrency must not defeat it");
  });
});

describe("ineligible input produces NO memory", () => {
  it("a BLOCKED author yields no social memory at all", async (t) => {
    if (!CREDS) return t.skip("credentials absent");
    await purge(userA); await purge(userB);
    await sc.from("user_follows").insert({ follower_id: userA, following_id: userB });
    await sc.from("blocks").insert({ blocker_id: userA, blocked_id: userB });

    await pass(userA);
    const social = (await projections(userA)).filter((r) => r.memory_type === "social");
    assert.deepEqual(social, [],
      "a blocked relationship must never become memory in the first place — " +
      "not merely be filtered out at read time",
    );
    const socialEvents = (await events(userA)).filter((r) => r.subject_type === "user");
    assert.deepEqual(socialEvents, [], "and no ledger event either");
  });

  it("the reverse block direction is equally excluded", async (t) => {
    if (!CREDS) return t.skip("credentials absent");
    await purge(userA); await purge(userB);
    await sc.from("user_follows").insert({ follower_id: userA, following_id: userB });
    await sc.from("blocks").insert({ blocker_id: userB, blocked_id: userA });

    await pass(userA);
    const social = (await projections(userA)).filter((r) => r.memory_type === "social");
    assert.deepEqual(social, [], "being blocked BY someone must also prevent the memory");
  });

  it("a user with no sources at all projects nothing", async (t) => {
    if (!CREDS) return t.skip("credentials absent");
    await purge(userB);
    await pass(userB);
    assert.deepEqual(await projections(userB), [], "no input, no memory — no fabrication");
  });
});

describe("everything projected is private by default (§19)", () => {
  it("every projected row carries visibility='private'", async (t) => {
    if (!CREDS) return t.skip("credentials absent");
    await purge(userA); await seedSources();
    await pass(userA);

    const rows = await projections(userA);
    assert.ok(rows.length > 0);
    const leaked = rows.filter((r) => r.visibility !== "private");
    assert.deepEqual(leaked, [],
      "derived memory is an INFERENCE, not the source — it must never inherit a " +
      "broader visibility than private, whatever the source was",
    );
  });

  it("social memory is additionally marked sensitive", async (t) => {
    if (!CREDS) return t.skip("credentials absent");
    const { data } = await sc.from("memory_projections")
      .select("sensitivity").eq("user_id", userA).eq("memory_type", "social");
    for (const r of (data ?? []) as any[]) {
      assert.equal(r.sensitivity, "sensitive", "social co-presence is sensitive per §19");
    }
  });
});

describe("a failing pass leaves no partial state", () => {
  it("an invalid user id is a clean no-op, not a half-written projection", async (t) => {
    if (!CREDS) return t.skip("credentials absent");
    const before = (await projections(userA)).length;
    // A user id with no profile: the fan-out's EXISTS guard and the FK both
    // reject it. Either way nothing may be left behind.
    const orphan = "00000000-0000-0000-0000-0000000000ff";
    try { await pass(orphan); } catch { /* rejection is an acceptable outcome */ }

    const { count } = await sc.from("memory_projections")
      .select("id", { count: "exact", head: true }).eq("user_id", orphan);
    assert.equal(count ?? 0, 0, "no rows for a user that cannot own them");
    assert.equal((await projections(userA)).length, before, "and other users are untouched");
  });
});
