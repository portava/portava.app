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
import { findUserByEmail, deleteFixtureUser, fixtureEmail, fixtureLabel } from "./liveFixtureUsers.js";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const CREDS = Boolean(SUPABASE_URL && SERVICE_ROLE_KEY);

/**
 * RUN-SCOPED fixtures — see the long note in memoryLifecycleLive.test.ts.
 *
 * This suite is the more exposed of the two, because its assertions are ABOUT
 * concurrency ("memory_events is deduped by a unique key; concurrency must not
 * defeat it", "concurrent passes must not create or drop rows", "the append-only
 * ledger must not double-write"). It creates the concurrency it means to test
 * itself, over one user id. A second CI job resolving the same stable address to
 * the same user id adds a projector it did not account for, so those assertions
 * fail on interference rather than on the invariant they guard — and the
 * assertions are right, which is why they are unchanged here.
 *
 * The scoping helper is stable within this process, so `ensureUser`'s
 * reuse-by-email behaviour is untouched; it differs only across runs.
 */
const TAG = "memproj_live_";
const EMAIL_A = fixtureEmail(`${TAG}a@portava-test.invalid`);
const EMAIL_B = fixtureEmail(`${TAG}b@portava-test.invalid`);

let sc: SupabaseClient;
let userA = "";
let userB = "";

async function ensureUser(email: string, handle: string): Promise<string> {
  const { data: created, error } = await sc.auth.admin.createUser({
    email, password: `${TAG}Pw!23456`, email_confirm: true,
  });
  let id = created?.user?.id ?? "";
  if (error || !id) {
    // Already exists from a previous run — find it. Paginated: a bare
    // listUsers() returns only the first 50 accounts, and this lookup silently
    // stopped finding its own user once the CI project grew past that.
    id = await findUserByEmail(sc, email);
  }
  if (!id) throw new Error(`could not create or find test user ${email}`);
  // The error is CHECKED, not discarded. `handle` carries a UNIQUE constraint, so
  // a leftover profile from a dead run holding this handle makes the upsert fail —
  // and swallowing that returned an id with no profile row behind it, which then
  // surfaced far away as `insert or update on table "memory_projections" violates
  // foreign key constraint "memory_projections_user_fk"`. Measured on 2026-09-05:
  // four such rows (memlife_live_a/b/c1c/c1d) stranded by run r2fa23449df took
  // main's live tier red, and the seed error named a table nothing here writes.
  const { error: pErr } = await sc
    .from("profiles")
    .upsert({ id, handle, name: handle }, { onConflict: "id" });
  if (pErr) throw new Error(`could not upsert profile ${handle} for ${email}: ${pErr.message}`);
  return id;
}

async function purge(userId: string): Promise<void> {
  if (!userId) return;
  await sc.rpc("erase_memory_for_user", { p_user_id: userId });
  await sc.from("user_follows").delete().eq("follower_id", userId);
  await sc.from("blocks").delete().eq("blocker_id", userId);
  await sc.from("compass_user_preferences").delete().eq("user_id", userId);
  await sc.from("compass_graph_edges").delete().eq("src_key", userId);
  // The PLACE-lane sources (see the M42 block below). Deleted per user, so a
  // failed run cannot leave saves behind that make a later run's anti-vacuity
  // check pass for the wrong reason.
  await sc.from("wishlist_places").delete().eq("user_id", userId);
  await sc.from("discovery_place_saves").delete().eq("user_id", userId);
}

// ── M42's PLACE lane: the three id-space bridges 2963 introduced ─────────────
//
// Fixed ids rather than random so a stranded row is identifiable by eye. The
// `discovery_places` rows are the only fixtures here that are NOT user-scoped,
// so they are deleted by id in `after` and the suite holds the shared-database
// slot while it runs, which is what keeps them from colliding with a suite
// beside this one.
const M42_PLACE_BY_ID = "a0000042-0000-4000-8000-000000000001";
const M42_PLACE_BY_OSM = "a0000042-0000-4000-8000-000000000002";
const M42_PLACE_BY_DPS = "a0000042-0000-4000-8000-000000000003";
const M42_OSM_ID = "node/9904242";
const M42_PLACE_IDS = [M42_PLACE_BY_ID, M42_PLACE_BY_OSM, M42_PLACE_BY_DPS];

async function seedUnionOnlySaves(userId: string): Promise<void> {
  await sc.from("discovery_places").upsert(
    [
      { id: M42_PLACE_BY_ID, name: "M42 bridge · db/<uuid>", place_type: "cafe" },
      { id: M42_PLACE_BY_OSM, name: "M42 bridge · osm_id", place_type: "viewpoint", osm_id: M42_OSM_ID },
      { id: M42_PLACE_BY_DPS, name: "M42 bridge · discovery_place_saves", place_type: "museum" },
    ],
    { onConflict: "id" },
  );

  // Bridge 1 + 2: wishlist_places, whose place_id is TEXT across four id-spaces.
  const { error: wErr } = await sc.from("wishlist_places").insert([
    {
      user_id: userId,
      place_id: `db/${M42_PLACE_BY_ID}`,
      place_data: {},
      saved_at: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    },
    {
      user_id: userId,
      place_id: M42_OSM_ID,
      place_data: {},
      saved_at: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    },
  ]);
  if (wErr) throw new Error(`could not seed wishlist_places: ${wErr.message}`);

  // Bridge 3: discovery_place_saves, whose place_id is already a uuid.
  const { error: dErr } = await sc.from("discovery_place_saves").insert({
    user_id: userId,
    place_id: M42_PLACE_BY_DPS,
    saved_at: new Date(Date.now() - 86_400_000).toISOString(),
  });
  if (dErr) throw new Error(`could not seed discovery_place_saves: ${dErr.message}`);
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
  userA = await ensureUser(EMAIL_A, fixtureLabel(`${TAG}a`));
  userB = await ensureUser(EMAIL_B, fixtureLabel(`${TAG}b`));
  await purge(userA); await purge(userB);
});

after(async () => {
  if (!CREDS || !sc) return;
  await purge(userA); await purge(userB);
  // Not user-scoped, so `purge` cannot reach them. Deleted AFTER the saves that
  // reference them, because discovery_place_saves.place_id is a FK.
  await sc.from("discovery_places").delete().in("id", M42_PLACE_IDS);
  for (const id of [userA, userB]) if (id) await deleteFixtureUser(sc, id);
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

/**
 * M42 — the PLACE lane, through the path that actually runs it.
 *
 * WHY THIS BLOCK EXISTS, and why it is HERE rather than anywhere cheaper.
 *
 * census-map M42 ("Gold marker = Saved / Passport / Memory") turns on two
 * things: that `project_user_memory`'s PLACE lane reads the
 * `discovery_place_saves` + `wishlist_places` union instead of the writerless
 * `saved_places`, and that a `memory_projections` row with
 * `subject_type = 'place'` EXISTS for a user whose saves are ONLY union-sourced.
 *
 * The second half was once "proven" against a local plain PostgreSQL and the
 * row was moved to C on that basis. That was wrong, and expensively so: 2963
 * shipped `DELETE FROM _canon_saves;` unqualified, which plain PostgreSQL
 * permits and this database REFUSES — `session_preload_libraries = supautils`,
 * whose safeupdate guard raises "DELETE requires a WHERE clause" for
 * PostgREST-role sessions. The statement sits mid-body, after the episodic,
 * semantic and social inserts, so every call raised and rolled back the whole
 * transaction: the projector produced NOTHING, in CI and in production, and
 * `memoryProjectionScheduler` only `logger.warn`s the rejection so it failed
 * silently. 2965 qualified the delete.
 *
 * So the test is in a LIVE suite deliberately. It calls
 * `project_user_memory_with_retraction` through PostgREST, which is the session
 * the guard is armed in — the one environment where the defect can appear. A
 * green run here means something a green run on a guard-free database does not.
 *
 * ANTI-VACUITY is structural rather than asserted in prose: `saved_places` is
 * EMPTY on this project (0 rows, whole table), so the pre-2963 body could not
 * have produced a place projection for this user or any other. The check below
 * measures it rather than trusting that.
 *
 * All THREE id-space bridges are exercised, because M42's remedy names the
 * bridge and a lane that resolved only one of them would still drop saves:
 *   db/<uuid>   -> discovery_places.id
 *   node/<id>   -> discovery_places.osm_id
 *   <uuid>      -> discovery_place_saves.place_id, already in the id-space
 */
describe("M42 — the PLACE lane projects union-sourced saves (guarded path)", () => {
  it("anti-vacuity: saved_places is empty, so the OLD body could project nothing", async (t) => {
    if (!CREDS) return t.skip("credentials absent");
    const { count, error } = await sc
      .from("saved_places")
      .select("user_id", { count: "exact", head: true });
    assert.equal(error, null, "saved_places must be readable for this check to mean anything");
    assert.equal(
      count ?? 0,
      0,
      "saved_places has rows: the pre-2963 lane could have produced a place projection " +
        "from them, and this suite's M42 result would no longer isolate the union",
    );
  });

  it("a user with ONLY union-sourced saves gets a place projection per bridge", async (t) => {
    if (!CREDS) return t.skip("credentials absent");
    await purge(userA);
    await seedUnionOnlySaves(userA);

    // The pass that matters. If the delete were still unqualified this REJECTS
    // with "DELETE requires a WHERE clause" and `pass` throws — the failure this
    // block exists to catch, arriving as an error rather than an empty result.
    await pass(userA);

    const places = (await projections(userA)).filter((p) => p.subject_type === "place");
    const ids = places.map((p) => p.subject_id).sort();

    assert.deepEqual(
      ids,
      [...M42_PLACE_IDS].sort(),
      "every bridge must resolve: db/<uuid> -> id, node/<id> -> osm_id, and the " +
        "already-resolved discovery_place_saves uuid",
    );
    for (const p of places) {
      assert.equal(p.memory_type, "place", "the PLACE lane writes place memory");
      assert.equal(p.visibility, "private", "§19: projected memory is private by default");
    }
  });

  it("the saved_place EVENTS name the union, not the writerless table", async (t) => {
    if (!CREDS) return t.skip("credentials absent");
    const rows = (await events(userA)).filter((e) => e.subject_type === "place");
    assert.equal(
      rows.length,
      M42_PLACE_IDS.length,
      "one saved_place event per resolved venue",
    );
    const { data } = await sc
      .from("memory_events")
      .select("source_ref")
      .eq("user_id", userA)
      .eq("subject_type", "place")
      .limit(1);
    const table = (data?.[0] as any)?.source_ref?.table ?? "";
    assert.equal(
      table,
      "wishlist_places+discovery_place_saves",
      "provenance must name the union the lane actually read",
    );
  });

  it("a second pass adds no duplicate place memory — the lane is idempotent too", async (t) => {
    if (!CREDS) return t.skip("credentials absent");
    const before = (await projections(userA)).filter((p) => p.subject_type === "place").length;
    await pass(userA);
    const after_ = (await projections(userA)).filter((p) => p.subject_type === "place").length;
    assert.equal(after_, before, "MIN(saved_at) dedupe holds across passes");
  });
});
