/**
 * Section 18 - projections and the derived-artifact registry.
 *
 * SPEC: docs/specs/Portava_Highlights_Memories_Development_Architecture_Spec_v1.txt
 *       section 18 (:512), section 10 (:320), 28.6, 28.8, 28.11, 28.12.
 * CENSUS: section 18's twelve rows - eight BUILT-BUT-WRONG, four NOT-BUILT,
 *         including "memory_derivative_registry absent; nothing records where a
 *         derivative went."
 *
 * THE REBUILD TEST IS THE POINT. "It produced something" is not a test of a
 * projection. So the central case here derives, MUTATES the canonical source
 * three different ways (an edit, an insert, a soft-delete), asserts the
 * projection notices it is stale and names the rows that moved, rebuilds, and
 * then compares the rebuilt payload against a FROM-SCRATCH derivation over the
 * same database. A projector that returned a cached first answer fails; one that
 * returned an incrementally patched answer that has drifted from a clean
 * derivation fails too.
 *
 * THE FAKE MODELS THE ONE CLIENT BEHAVIOUR THAT MATTERS. supabase-js RESOLVES
 * on a database error. The fake therefore resolves `{ data: null, error }` - it
 * never throws - because a fake that threw would exercise a catch block that
 * does not exist in production and would let an unbound `.error` pass. Writes
 * without a matching row resolve `{ data: [], error: null }`, which is what an
 * RLS-filtered upsert actually looks like.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/memoryProjectionRegistry.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DERIVATIVE_REGISTRY_TABLE,
  deriveProjection,
  projectionStaleness,
  rebuildProjection,
  revokeDerivativesForMemory,
  type ClientLike,
} from "../services/memoryProjections/derivativeRegistry.js";
// The SERVE path moved to its own module so the projection has a consumer that
// is not its own producer — see derivativeRegistryRead.ts. The assertions below
// are unchanged; only where the function is imported from moved.
import { readRegisteredPayload } from "../services/memoryProjections/derivativeRegistryRead.js";
import {
  PROJECTION_DEFINITIONS,
  getProjectionDefinition,
  listProjectionIds,
  scopeKeyOf,
  sourceVersionOf,
  type MemorySourceRow,
  type ProjectionId,
} from "../services/memoryProjections/projectionRegistry.js";
import { scoreSignificance } from "../services/memoryProjections/significance.js";

const OWNER = "33333333-3333-4333-8333-333333333333";
const FRIEND = "44444444-4444-4444-8444-444444444444";
const BLOCKED = "55555555-5555-4555-8555-555555555555";
const TRIP = "66666666-6666-4666-8666-666666666666";
const NOW = new Date("2026-06-01T00:00:00.000Z");

function memory(over: Partial<MemorySourceRow> & { id: string }): MemorySourceRow {
  return {
    owner_id: OWNER,
    title: "Untitled",
    caption: null,
    visibility: "friends_only",
    state: "published",
    trip_id: null,
    event_id: null,
    place_id: null,
    starts_at: "2026-05-01T12:00:00.000Z",
    ends_at: null,
    created_at: "2026-05-01T12:00:00.000Z",
    updated_at: "2026-05-01T12:00:00.000Z",
    location_city: "Bangkok",
    location_country: "Thailand",
    location_lat: 13.7563,
    location_lng: 100.5018,
    canonical_location_id: null,
    allowed_user_ids: [],
    hidden_user_ids: [],
    ...over,
  };
}

type Tables = Record<string, any[]>;

function fixture(): Tables {
  return {
    memories: [
      memory({ id: "m1", title: "Sushi in Tokyo", visibility: "public", place_id: "place-sushi", trip_id: TRIP, starts_at: "2026-05-01T12:00:00.000Z" }),
      memory({ id: "m2", title: "Private clinic visit", visibility: "only_me", starts_at: "2026-05-02T12:00:00.000Z" }),
      memory({ id: "m3", title: "Night market", visibility: "custom", allowed_user_ids: [FRIEND], place_id: "place-market", trip_id: TRIP, starts_at: "2026-05-03T12:00:00.000Z" }),
      memory({ id: "m4", title: "Hidden from one person", visibility: "public", hidden_user_ids: [BLOCKED], starts_at: "2026-05-04T12:00:00.000Z" }),
      memory({ id: "m5", title: "Deleted one", state: "deleted", visibility: "public", starts_at: "2026-05-05T12:00:00.000Z" }),
      memory({ id: "m6", owner_id: FRIEND, title: "Someone else's", visibility: "public", starts_at: "2026-05-06T12:00:00.000Z" }),
    ],
    memory_items: [
      { memory_id: "m1", media_url: "a.jpg", media_type: "image/jpeg", position: 0 },
      { memory_id: "m1", media_url: "b.jpg", media_type: "image/jpeg", position: 1 },
      { memory_id: "m3", media_url: "c.jpg", media_type: "image/jpeg", position: 0 },
    ],
    memory_tags: [
      { memory_id: "m1", tagged_user_id: FRIEND, status: "approved" },
      { memory_id: "m3", tagged_user_id: FRIEND, status: "pending" },
      { memory_id: "m4", tagged_user_id: BLOCKED, status: "removed" },
    ],
    [DERIVATIVE_REGISTRY_TABLE]: [],
  };
}

interface FakeOpts {
  failTables?: Set<string>;
  missingTables?: Set<string>;
  zeroRowWrite?: Set<string>;
}

function makeClient(tables: Tables, opts: FakeOpts = {}): ClientLike & { tables: Tables } {
  const fail = opts.failTables ?? new Set<string>();
  const missing = opts.missingTables ?? new Set<string>();
  const zero = opts.zeroRowWrite ?? new Set<string>();

  function chain(table: string): any {
    const filters: Array<(r: any) => boolean> = [];
    let mode: "select" | "upsert" | "update" = "select";
    let payload: any = null;
    let onConflict: string[] = [];
    let selected = false;

    const obj: any = {
      select() { selected = true; return obj; },
      eq(c: string, v: unknown) { filters.push((r) => r[c] === v); return obj; },
      neq(c: string, v: unknown) { filters.push((r) => r[c] !== v); return obj; },
      in(c: string, vs: readonly unknown[]) { const s = new Set(vs); filters.push((r) => s.has(r[c])); return obj; },
      upsert(v: any, o?: { onConflict?: string }) {
        mode = "upsert"; payload = v; onConflict = (o?.onConflict ?? "").split(",").filter(Boolean); return obj;
      },
      update(v: any) { mode = "update"; payload = v; return obj; },
      then(f: any, r: any) { return run().then(f, r); },
    };

    async function run(): Promise<{ data: any; error: any }> {
      if (missing.has(table)) {
        return { data: null, error: { code: "42P01", message: `relation "public.${table}" does not exist` } };
      }
      if (fail.has(table)) {
        return { data: null, error: { code: "57014", message: `${table} unavailable` } };
      }
      const rows: any[] = (tables[table] ??= []);
      if (mode === "upsert") {
        if (zero.has(table)) return { data: [], error: null };
        const incoming = Array.isArray(payload) ? payload : [payload];
        const written: any[] = [];
        for (const row of incoming) {
          const idx = onConflict.length > 0
            ? rows.findIndex((r) => onConflict.every((k) => r[k] === row[k]))
            : -1;
          const stored = { id: `reg-${rows.length + 1}`, ...row };
          if (idx >= 0) { rows[idx] = { ...rows[idx], ...row }; written.push(rows[idx]); }
          else { rows.push(stored); written.push(stored); }
        }
        return { data: selected ? written : null, error: null };
      }
      if (mode === "update") {
        if (zero.has(table)) return { data: [], error: null };
        const hit = rows.filter((r) => filters.every((fn) => fn(r)));
        for (const r of hit) Object.assign(r, payload);
        return { data: selected ? hit : null, error: null };
      }
      return { data: rows.filter((r) => filters.every((fn) => fn(r))), error: null };
    }

    return obj;
  }

  return { from: (t: string) => chain(t), tables };
}

const OWNER_SCOPE = { owner_id: OWNER, viewer_id: OWNER };

describe("section 18: every projection in the spec table is registered", () => {
  it("all eleven names exist, each declaring sources, destination and a builder version", () => {
    assert.deepEqual(listProjectionIds().sort(), [
      "CompassMemoryProjection", "MapTrailDerivative", "MemoryTimelineProjection", "NarrativeDerivative",
      "PassportMemoryProjection", "PeopleMemoryProjection", "PlaceMemoryProjection",
      "ProfileHighlightProjection", "PublicMemoryProjection", "SearchEmbedding", "TripMemoryProjection",
    ]);
    for (const def of PROJECTION_DEFINITIONS) {
      assert.ok(def.source_tables.length > 0, `${def.id} declares no sources - it cannot be told it is stale`);
      assert.ok(def.destination.length > 0, `${def.id} has no destination`);
      assert.ok(def.builder_version.length > 0, `${def.id} has no builder version`);
      assert.ok(def.field_whitelist.length > 0, `${def.id} has no field whitelist`);
      if (def.availability === "NOT_CONFIGURED") assert.ok(def.unavailable_reason.length > 20, `${def.id} does not say why`);
    }
  });

  it("a projection with no backend refuses; it does not report an empty derivative", async () => {
    const client = makeClient(fixture());
    for (const id of ["SearchEmbedding", "NarrativeDerivative"] as ProjectionId[]) {
      const r = await deriveProjection(client, id, OWNER_SCOPE);
      assert.equal(r.ok, false, `${id} pretended to build`);
      if (!r.ok) {
        assert.equal(r.reason, "projection_not_configured");
        assert.ok(r.detail.length > 20, "a refusal with no reason is not better than an empty list");
      }
    }
  });

  it("an unknown projection id is refused rather than defaulted", async () => {
    const client = makeClient(fixture());
    const r = await deriveProjection(client, "NotAProjection" as ProjectionId, OWNER_SCOPE);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "unknown_projection");
  });
});

describe("section 28.12: rebuild", () => {
  it("derives, notices a changed source, rebuilds, and matches a from-scratch derivation", async () => {
    const tables = fixture();
    const client = makeClient(tables);

    const first = await rebuildProjection(client, "MemoryTimelineProjection", OWNER_SCOPE, NOW);
    assert.ok(first.ok, JSON.stringify(first));
    assert.ok(first.value.rows.length > 0, "the control must actually project something");
    assert.equal(first.value.registration.revocation_state, "ACTIVE");
    assert.equal(first.value.registration.row_count, first.value.rows.length);
    assert.equal(first.value.registration.generated_at, NOW.toISOString());
    assert.deepEqual([...first.value.registration.source_tables].sort(), ["memories", "memory_items", "memory_tags"]);

    const fresh = await projectionStaleness(client, "MemoryTimelineProjection", OWNER_SCOPE);
    assert.ok(fresh.ok);
    assert.equal(fresh.value.state, "FRESH");

    // THREE MUTATIONS: an edit, an insert, and a soft-delete.
    const m1 = tables.memories.find((m) => m.id === "m1");
    m1.title = "Sushi in Tokyo, second time";
    m1.updated_at = "2026-05-20T00:00:00.000Z";
    tables.memories.push(memory({ id: "m7", title: "A later evening", starts_at: "2026-05-21T12:00:00.000Z", updated_at: "2026-05-21T12:00:00.000Z" }));
    const m3 = tables.memories.find((m) => m.id === "m3");
    m3.state = "deleted";
    m3.updated_at = "2026-05-22T00:00:00.000Z";

    const stale = await projectionStaleness(client, "MemoryTimelineProjection", OWNER_SCOPE);
    assert.ok(stale.ok);
    assert.equal(stale.value.state, "STALE");
    assert.deepEqual(stale.value.changed_memory_ids, ["m1", "m3", "m7"]);
    assert.notEqual(stale.value.registered_version, stale.value.current_version);

    const rebuilt = await rebuildProjection(client, "MemoryTimelineProjection", OWNER_SCOPE, new Date("2026-06-02T00:00:00.000Z"));
    assert.ok(rebuilt.ok, JSON.stringify(rebuilt));

    // From scratch, on a client that has never built anything.
    const scratch = await deriveProjection(makeClient(tables), "MemoryTimelineProjection", OWNER_SCOPE);
    assert.ok(scratch.ok);
    assert.deepEqual(rebuilt.value.rows, scratch.value.rows, "the rebuild has drifted from a clean derivation");
    assert.deepEqual(rebuilt.value.registration.payload_json, scratch.value.rows);
    assert.equal(rebuilt.value.registration.source_version, scratch.value.source_version);

    // And the mutations are actually visible in the result, or the comparison above is vacuous.
    const titles = rebuilt.value.rows.map((r) => r.title);
    assert.ok(titles.includes("Sushi in Tokyo, second time"), "the edit did not land");
    assert.ok(titles.includes("A later evening"), "the insert did not land");
    assert.ok(!titles.includes("Night market"), "the soft-deleted memory is still projected");

    const afterFresh = await projectionStaleness(client, "MemoryTimelineProjection", OWNER_SCOPE);
    assert.ok(afterFresh.ok);
    assert.equal(afterFresh.value.state, "FRESH");
  });

  it("a projection nobody has built reports NOT_REGISTERED, not FRESH", async () => {
    const client = makeClient(fixture());
    const r = await projectionStaleness(client, "PublicMemoryProjection", OWNER_SCOPE);
    assert.ok(r.ok);
    assert.equal(r.value.state, "NOT_REGISTERED");
    assert.equal(r.value.registered_version, null);
  });

  it("a source row that was filtered OUT still counts as an input", async () => {
    // m2 is only_me and never appears in the public projection - but if it turns
    // public, the projection must be stale. A version taken over EMITTED rows
    // would miss this entirely.
    const tables = fixture();
    const client = makeClient(tables);
    const built = await rebuildProjection(client, "PublicMemoryProjection", OWNER_SCOPE, NOW);
    assert.ok(built.ok);
    assert.ok(!built.value.rows.some((r) => r.memory_id === "m2"));

    const m2 = tables.memories.find((m) => m.id === "m2");
    m2.visibility = "public";
    m2.updated_at = "2026-05-30T00:00:00.000Z";

    const stale = await projectionStaleness(client, "PublicMemoryProjection", OWNER_SCOPE);
    assert.ok(stale.ok);
    assert.equal(stale.value.state, "STALE");
    assert.deepEqual(stale.value.changed_memory_ids, ["m2"]);
  });

  it("two derivations of an unchanged database are identical", async () => {
    const tables = fixture();
    const a = await deriveProjection(makeClient(tables), "MemoryTimelineProjection", OWNER_SCOPE);
    const b = await deriveProjection(makeClient(tables), "MemoryTimelineProjection", OWNER_SCOPE);
    assert.ok(a.ok && b.ok);
    assert.deepEqual(a.value.rows, b.value.rows);
    assert.equal(a.value.source_version, b.value.source_version);
  });

  it("the source version moves when updated_at moves, and not otherwise", () => {
    const rows = [memory({ id: "x" }), memory({ id: "y" })];
    const before = sourceVersionOf(rows);
    assert.equal(before.digest, sourceVersionOf([rows[1], rows[0]]).digest, "row order is not a change");
    const after = sourceVersionOf([{ ...rows[0], updated_at: "2026-07-01T00:00:00.000Z" }, rows[1]]);
    assert.notEqual(before.digest, after.digest);
  });
});

describe("28.11: an unreadable source is a refusal, never an empty history", () => {
  it("PAIRED CONTROL - with everything readable the timeline is not empty", async () => {
    const r = await deriveProjection(makeClient(fixture()), "MemoryTimelineProjection", OWNER_SCOPE);
    assert.ok(r.ok);
    assert.ok(r.value.rows.length >= 4, `control projected ${r.value.rows.length} rows`);
  });

  for (const table of ["memories", "memory_items", "memory_tags"]) {
    it(`an unreadable ${table} refuses with a retryable structured error`, async () => {
      const client = makeClient(fixture(), { failTables: new Set([table]) });
      const r = await deriveProjection(client, "MemoryTimelineProjection", OWNER_SCOPE);
      assert.equal(r.ok, false, `a failed ${table} read produced a projection`);
      if (!r.ok) {
        assert.equal(r.reason, "source_unavailable");
        assert.equal(r.table, table);
        assert.equal(r.retryable, true);
      }
    });

    it(`an ABSENT ${table} refuses and says a retry will not help`, async () => {
      const client = makeClient(fixture(), { missingTables: new Set([table]) });
      const r = await deriveProjection(client, "MemoryTimelineProjection", OWNER_SCOPE);
      assert.equal(r.ok, false);
      if (!r.ok) {
        assert.equal(r.reason, "source_unavailable");
        assert.equal(r.retryable, false, "a missing relation is not a transient failure");
      }
    });
  }

  it("staleness over an unreadable source refuses rather than reporting FRESH", async () => {
    const client = makeClient(fixture(), { failTables: new Set(["memories"]) });
    const r = await projectionStaleness(client, "MemoryTimelineProjection", OWNER_SCOPE);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "source_unavailable");
  });

  it("an absent registry table refuses rather than reporting a successful rebuild", async () => {
    const client = makeClient(fixture(), { missingTables: new Set([DERIVATIVE_REGISTRY_TABLE]) });
    const r = await rebuildProjection(client, "MemoryTimelineProjection", OWNER_SCOPE, NOW);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.reason, "registry_unavailable");
      assert.equal(r.retryable, false);
    }
  });

  it("a registration write that affected no rows is not reported as a rebuild", async () => {
    const client = makeClient(fixture(), { zeroRowWrite: new Set([DERIVATIVE_REGISTRY_TABLE]) });
    const r = await rebuildProjection(client, "MemoryTimelineProjection", OWNER_SCOPE, NOW);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.reason, "registry_write_unconfirmed");
      assert.equal(r.retryable, true);
    }
  });
});

describe("section 18 / 21 / 28.8: the cleanup graph", () => {
  async function buildThree() {
    const tables = fixture();
    const client = makeClient(tables);
    const timeline = await rebuildProjection(client, "MemoryTimelineProjection", OWNER_SCOPE, NOW);
    const pub = await rebuildProjection(client, "PublicMemoryProjection", OWNER_SCOPE, NOW);
    const trip = await rebuildProjection(client, "TripMemoryProjection", { ...OWNER_SCOPE, trip_id: TRIP }, NOW);
    assert.ok(timeline.ok && pub.ok && trip.ok, "fixture rebuilds must succeed");
    return { tables, client };
  }

  it("revoking a memory revokes every derivative that carries it, and no others", async () => {
    const { tables, client } = await buildThree();
    const registryRows = tables[DERIVATIVE_REGISTRY_TABLE];
    assert.equal(registryRows.length, 3);

    const r = await revokeDerivativesForMemory(client, "m4", "owner set visibility to only_me", NOW);
    assert.ok(r.ok, JSON.stringify(r));
    // m4 CONTRIBUTES to the timeline and the public projection. It is an INPUT
    // to the trip recap too - the builder read it and filtered it out - but a
    // derivative that never carried it must not be revoked when it goes.
    assert.equal(r.value.revoked, 2, JSON.stringify(r.value.scope_keys));
    assert.ok(r.value.scope_keys.some((k) => k.startsWith("MemoryTimelineProjection|")));
    assert.ok(r.value.scope_keys.some((k) => k.startsWith("PublicMemoryProjection|")));
    assert.ok(!r.value.scope_keys.some((k) => k.startsWith("TripMemoryProjection|")));

    const revoked = registryRows.filter((row: any) => row.revocation_state === "REVOKED");
    assert.equal(revoked.length, 2);
    for (const row of revoked) {
      assert.deepEqual(row.payload_json, [], "a revoked derivative must not keep its content (28.8)");
      assert.equal(row.row_count, 0);
      assert.equal(row.revocation_reason, "owner set visibility to only_me");
      assert.equal(row.revoked_at, NOW.toISOString());
    }
  });

  it("a memory nothing derived from revokes zero, reported as zero rather than as success", async () => {
    const { client } = await buildThree();
    const r = await revokeDerivativesForMemory(client, "no-such-memory", "test", NOW);
    assert.ok(r.ok);
    assert.equal(r.value.revoked, 0);
    assert.deepEqual(r.value.scope_keys, []);
  });

  it("an update that matched no rows is reported as unconfirmed, not as a revocation", async () => {
    const { tables } = await buildThree();
    const blocked = makeClient(tables, { zeroRowWrite: new Set([DERIVATIVE_REGISTRY_TABLE]) });
    const r = await revokeDerivativesForMemory(blocked, "m4", "test", NOW);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "registry_write_unconfirmed");
  });

  it("an unreadable registry refuses rather than claiming nothing needed revoking", async () => {
    const { tables } = await buildThree();
    const broken = makeClient(tables, { failTables: new Set([DERIVATIVE_REGISTRY_TABLE]) });
    const r = await revokeDerivativesForMemory(broken, "m4", "test", NOW);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "registry_unavailable");
  });

  it("a revoked derivative is unreadable, and a routine rebuild does not resurrect it", async () => {
    const { client } = await buildThree();
    await revokeDerivativesForMemory(client, "m4", "privacy change", NOW);

    const read = await readRegisteredPayload(client, "PublicMemoryProjection", OWNER_SCOPE);
    assert.equal(read.ok, false);
    if (!read.ok) assert.ok(/REVOKED/.test(read.detail));

    const again = await rebuildProjection(client, "PublicMemoryProjection", OWNER_SCOPE, NOW);
    assert.ok(again.ok);
    assert.equal(again.value.was_revoked, true);
    assert.deepEqual(again.value.rows, [], "a revoked derivative must stay revoked until deliberately restored");

    const staleness = await projectionStaleness(client, "PublicMemoryProjection", OWNER_SCOPE);
    assert.ok(staleness.ok);
    assert.equal(staleness.value.state, "REVOKED");
  });
});

describe("section 10: audience shapes the projection, not a post-filter", () => {
  it("the public derivative carries only whitelisted public fields - no coordinate, no significance", async () => {
    const sig = new Map([["m1", scoreSignificance({ user_created: true, first_time_experience: true })]]);
    const r = await deriveProjection(makeClient(fixture()), "PublicMemoryProjection", OWNER_SCOPE, { significance: sig });
    assert.ok(r.ok);
    assert.ok(r.value.rows.length > 0);
    const whitelist = getProjectionDefinition("PublicMemoryProjection")!.field_whitelist;
    for (const row of r.value.rows) {
      assert.deepEqual(Object.keys(row).sort(), [...whitelist].sort());
      assert.equal("location_lat" in row, false);
      assert.equal("location_lng" in row, false);
      assert.equal("significance_score" in row, false);
      assert.equal("hidden_user_ids" in row, false);
      assert.equal("allowed_user_ids" in row, false);
    }
    const ids = r.value.rows.map((x) => x.memory_id).sort();
    assert.deepEqual(ids, ["m1", "m4"], "only published+public rows of this owner");
  });

  it("a column nobody whitelisted cannot reach a projection, even a new one", async () => {
    // Tomorrow's migration adds a column to `memories`. Every builder reads the
    // whole row, so the ONLY thing keeping the new column out of the public
    // derivative is the field whitelist.
    const tables = fixture();
    for (const m of tables.memories) m.private_moderation_note = "internal only";
    const r = await deriveProjection(makeClient(tables), "PublicMemoryProjection", OWNER_SCOPE);
    assert.ok(r.ok);
    assert.ok(r.value.rows.length > 0);
    for (const row of r.value.rows) {
      assert.equal("private_moderation_note" in row, false, "an unwhitelisted column reached the public projection");
    }
  });

  it("the owner's timeline may carry significance; nothing else may", async () => {
    const sig = new Map([["m1", scoreSignificance({ user_created: true, first_time_experience: true })]]);
    const timeline = await deriveProjection(makeClient(fixture()), "MemoryTimelineProjection", OWNER_SCOPE, { significance: sig });
    assert.ok(timeline.ok);
    const m1 = timeline.value.rows.find((r) => r.memory_id === "m1");
    assert.ok(m1);
    assert.ok(typeof m1.significance_score === "number", "the owner sees their own score");
    assert.equal(m1.significance_tier, "SUGGESTED");
    const m4 = timeline.value.rows.find((r) => r.memory_id === "m4");
    assert.equal(m4?.significance_score, null, "an unscored memory is null, not a fabricated 0");

    for (const def of PROJECTION_DEFINITIONS) {
      if (def.id === "MemoryTimelineProjection") continue;
      assert.equal(def.emits_significance, false, `${def.id} may not carry significance`);
      assert.equal(def.field_whitelist.includes("significance_score"), false, `${def.id} whitelists a score`);
    }
  });

  it("a profile projection admits a viewer by allow-list and refuses one the owner hid", async () => {
    const forFriend = await deriveProjection(makeClient(fixture()), "ProfileHighlightProjection", { owner_id: OWNER, viewer_id: FRIEND });
    assert.ok(forFriend.ok);
    const friendIds = forFriend.value.rows.map((r) => r.memory_id).sort();
    assert.deepEqual(friendIds, ["m1", "m3", "m4"], "public rows plus the custom row they are named on");

    const forBlocked = await deriveProjection(makeClient(fixture()), "ProfileHighlightProjection", { owner_id: OWNER, viewer_id: BLOCKED });
    assert.ok(forBlocked.ok);
    const blockedIds = forBlocked.value.rows.map((r) => r.memory_id).sort();
    assert.deepEqual(blockedIds, ["m1"], "m4 hides this viewer; m3 does not name them");

    const forOwner = await deriveProjection(makeClient(fixture()), "ProfileHighlightProjection", OWNER_SCOPE);
    assert.ok(forOwner.ok);
    assert.ok(forOwner.value.rows.length > blockedIds.length, "the owner sees at least as much as any viewer");
  });

  it("the map trail gives an exact coordinate to the owner and a coarse one to anyone else", async () => {
    const owner = await deriveProjection(makeClient(fixture()), "MapTrailDerivative", OWNER_SCOPE);
    const other = await deriveProjection(makeClient(fixture()), "MapTrailDerivative", { owner_id: OWNER, viewer_id: FRIEND });
    assert.ok(owner.ok && other.ok);
    assert.equal(owner.value.rows[0].lat, 13.7563);
    assert.equal(owner.value.rows[0].precision, "EXACT");
    assert.equal(other.value.rows[0].lat, 13.8);
    assert.equal(other.value.rows[0].precision, "CITY");
  });

  it("shared history needs an APPROVED tag; pending and removed are not shared experiences", async () => {
    const r = await deriveProjection(makeClient(fixture()), "PeopleMemoryProjection", { owner_id: OWNER, person_id: FRIEND });
    assert.ok(r.ok);
    assert.deepEqual(r.value.rows.map((x) => x.memory_id), ["m1"], "m3's tag is only pending");

    const removed = await deriveProjection(makeClient(fixture()), "PeopleMemoryProjection", { owner_id: OWNER, person_id: BLOCKED });
    assert.ok(removed.ok);
    assert.deepEqual(removed.value.rows, []);
  });

  it("a place history is ordered oldest-first and numbers the owner's visits", async () => {
    const tables = fixture();
    tables.memories.push(memory({ id: "m8", place_id: "place-sushi", starts_at: "2026-05-09T12:00:00.000Z", title: "Sushi again" }));
    const r = await deriveProjection(makeClient(tables), "PlaceMemoryProjection", { owner_id: OWNER, place_id: "place-sushi" });
    assert.ok(r.ok);
    assert.deepEqual(r.value.rows.map((x) => [x.memory_id, x.visit_index]), [["m1", 1], ["m8", 2]]);
  });

  it("a trip recap holds that trip's memories in occurrence order and nothing else", async () => {
    const r = await deriveProjection(makeClient(fixture()), "TripMemoryProjection", { ...OWNER_SCOPE, trip_id: TRIP });
    assert.ok(r.ok);
    assert.deepEqual(r.value.rows.map((x) => x.memory_id), ["m1", "m3"]);
    assert.deepEqual(r.value.rows[0].people, [FRIEND]);
  });

  it("Compass gets facts and a staleness caveat, never the owner's prose", async () => {
    const r = await deriveProjection(makeClient(fixture()), "CompassMemoryProjection", OWNER_SCOPE);
    assert.ok(r.ok);
    for (const row of r.value.rows) {
      assert.equal("caption" in row, false, "Compass does not receive user prose");
      assert.equal("title" in row, false);
      assert.ok(String(row.confidence_note).includes("not evidence of current operational state"));
    }
  });

  it("scope keys distinguish artifacts, so two audiences cannot overwrite each other's registration", () => {
    const a = scopeKeyOf("ProfileHighlightProjection", { owner_id: OWNER, viewer_id: FRIEND });
    const b = scopeKeyOf("ProfileHighlightProjection", { owner_id: OWNER, viewer_id: BLOCKED });
    assert.notEqual(a, b);
    assert.equal(a, scopeKeyOf("ProfileHighlightProjection", { owner_id: OWNER, viewer_id: FRIEND }));
  });
});
