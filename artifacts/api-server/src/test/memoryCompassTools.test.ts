/**
 * Highlights/Memories §16 — the eight Compass Memory accessors, and §14's
 * fusion boundary, against the real tools through the real dispatcher.
 *
 * SPEC: Portava Highlights / Memories Development Architecture Specification v1
 *   §16 names eight accessors — getMemory, searchMemories, getSharedMemories,
 *       getPlaceHistory, getTripMemories, getMemoryEvidence, createMemoryDraft,
 *       suggestMemoryCorrection — then the LLM boundary: "May not invent
 *       emotional states, participants, place identity, attendance, preference,
 *       or historical outcomes. May not bypass privacy/visibility policy. May
 *       not use stale historical facts as current operational truth."
 *   §14 "'You visited X in 2026' is a historical claim. 'X is open tonight'
 *       requires fresh world data. Never derive the latter from the former."
 *   §23 `canReadMemory(userId, memoryId, surface)`.
 *
 * CENSUS: H115–H128 were NOT-BUILT ×14 on one piece of evidence — no Compass
 *         tool is memory-facing. H5 and H109 were NOT-BUILT because nothing
 *         encoded the historical/current boundary.
 *
 * WHAT WOULD TURN THIS RED — the list is the point of the file
 * ============================================================
 *   - Dropping the block check from `canCompassReadMemory`: "a blocked viewer
 *     is refused a PUBLIC Memory" fails. This is the one that matters most,
 *     because the Memory in that test is public and every other gate lets it
 *     through.
 *   - Treating an unreadable `blocks` table as "not blocked": the fail-closed
 *     test fails.
 *   - Using the public-feed rule on the Compass surface: the allow-listed
 *     `custom` Memory stops being readable and that test fails.
 *   - Counting a PENDING memory_tag as attendance: the shared-memories test
 *     fails, because the pending row would appear under `memories` instead of
 *     `unconfirmed_participation`.
 *   - Letting `currentWorldReading` accept a `historical` or `ai_inference`
 *     source class: the §14 refusal test fails.
 *   - Deriving `may_state_current_status` from anything but the current half:
 *     the fusion test fails with a recent Memory and no live source.
 *   - Renaming `fusion_note` back to `note`: the sanitizer test fails, because
 *     `sanitizeToolResult` deletes the key `note`.
 *   - Making any of the eight write: the no-write test fails — the fake client
 *     records every insert/update/delete/upsert and the assertion is zero.
 *   - Asking more than one clarifying question: the "minimum" test fails.
 *   - Widening CORRECTABLE_FIELDS to visibility/audience/state: the correction
 *     test fails on the refused-fields assertion.
 *
 * Runtime: node:test + node:assert/strict. Run:
 *   node --import tsx/esm --test src/test/memoryCompassTools.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  MEMORY_COMPASS_TOOL_DEFINITIONS,
  MEMORY_COMPASS_TOOL_NAMES,
  MEMORY_TOOL_SPEC_NAMES,
  CORRECTABLE_FIELDS,
  DRAFTABLE_FIELDS,
  executeMemoryCompassTool,
} from "../compass/MemoryCompassTools.js";
import { COMPASS_TOOL_DEFINITIONS, COMPASS_TOOLS_PROMPT_ADDENDUM, executeCompassTool, sanitizeToolResult } from "../compass/CompassTools.js";
import {
  CURRENT_WORLD_SOURCE_CLASSES,
  asHistoricalFact,
  currentWorldReading,
  currentWorldUnknown,
  fuseHistoricalWithCurrent,
} from "../services/memory/historicalTruth.js";
import { canReadMemory, canCompassReadMemory } from "../services/memory/memoryReadPolicy.js";

const ALICE = "aaaaaaaa-0000-4000-8000-000000000001";
const BOB = "bbbbbbbb-0000-4000-8000-000000000002";
const CARL = "cccccccc-0000-4000-8000-000000000003";
const MALLORY = "dddddddd-0000-4000-8000-000000000004";

const TRIP_ID = "11111111-0000-4000-8000-000000000001";
const OTHER_TRIP = "11111111-0000-4000-8000-000000000002";
const PLACE_ID = "22222222-0000-4000-8000-000000000001";

const M_OWN_PUBLIC = "33333333-0000-4000-8000-000000000001";
const M_OWN_ONLYME = "33333333-0000-4000-8000-000000000002";
const M_OWN_WITH_CARL = "33333333-0000-4000-8000-000000000003";
const M_OWN_CARL_PENDING = "33333333-0000-4000-8000-000000000004";
const M_BOB_TAGGED = "33333333-0000-4000-8000-000000000005";
const M_BOB_ONLYME = "33333333-0000-4000-8000-000000000006";
const M_BOB_CUSTOM = "33333333-0000-4000-8000-000000000007";
const M_MALLORY_PUBLIC = "33333333-0000-4000-8000-000000000008";
const M_TRIP_CREW = "33333333-0000-4000-8000-000000000009";

interface State {
  blocksError?: boolean;
  tagsError?: boolean;
  crewError?: boolean;
}

function memory(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "", owner_id: ALICE, title: null, caption: null, visibility: "public",
    allowed_user_ids: [], hidden_user_ids: [], state: "published",
    trip_id: null, event_id: null, place_id: null, canonical_location_id: null,
    starts_at: null, ends_at: null,
    created_at: "2026-03-01T00:00:00.000Z", updated_at: "2026-03-01T00:00:00.000Z",
    location_city: null, location_country: null,
    // Present in the row and NEVER in a result — the payload builder picks
    // fields explicitly, so a leak here would show up as a failed assertion.
    location_lat: 16.0544, location_lng: 108.2022,
    ...over,
  };
}

function fixture() {
  return {
    memories: [
      memory({ id: M_OWN_PUBLIC, title: "Dragon Bridge at night", caption: "fire show",
        location_city: "Da Nang", location_country: "Vietnam", place_id: PLACE_ID,
        starts_at: "2026-03-04T13:00:00.000Z" }),
      memory({ id: M_OWN_ONLYME, visibility: "only_me", title: "Private note", location_city: "Hanoi",
        starts_at: "2026-02-01T00:00:00.000Z" }),
      memory({ id: M_OWN_WITH_CARL, title: "Phuket boat day", location_city: "Phuket",
        starts_at: "2026-01-10T00:00:00.000Z" }),
      memory({ id: M_OWN_CARL_PENDING, title: "Phuket night market", location_city: "Phuket",
        starts_at: "2026-01-11T00:00:00.000Z" }),
      memory({ id: M_BOB_TAGGED, owner_id: BOB, title: "Bob's Da Nang dinner",
        location_city: "Da Nang", starts_at: "2026-03-05T00:00:00.000Z" }),
      memory({ id: M_BOB_ONLYME, owner_id: BOB, visibility: "only_me", title: "Bob alone" }),
      memory({ id: M_BOB_CUSTOM, owner_id: BOB, visibility: "custom", allowed_user_ids: [ALICE],
        title: "Bob's close-friends memory" }),
      memory({ id: M_MALLORY_PUBLIC, owner_id: MALLORY, title: "Mallory in public" }),
      memory({ id: M_TRIP_CREW, owner_id: BOB, visibility: "trip_crew", trip_id: TRIP_ID,
        title: "Crew dinner", starts_at: "2026-03-06T00:00:00.000Z" }),
    ],
    memory_tags: [
      { memory_id: M_BOB_TAGGED, tagged_user_id: ALICE, status: "approved" },
      { memory_id: M_OWN_WITH_CARL, tagged_user_id: CARL, status: "approved" },
      { memory_id: M_OWN_CARL_PENDING, tagged_user_id: CARL, status: "pending" },
      { memory_id: M_OWN_PUBLIC, tagged_user_id: MALLORY, status: "removed" },
    ],
    memory_items: [
      { id: "item-1", memory_id: M_OWN_PUBLIC, media_url: "https://x/1.jpg", media_type: "image/jpeg",
        caption: "bridge", position: 0, created_at: "2026-03-04T14:00:00.000Z" },
    ],
    profiles: [
      { id: ALICE, handle: "alice", name: "Alice" },
      { id: BOB, handle: "bob", name: "Bob" },
      { id: CARL, handle: "carl", name: "Carl" },
      { id: MALLORY, handle: "mallory", name: "Mallory" },
    ],
    blocks: [{ blocker_id: MALLORY, blocked_id: ALICE }],
    trips: [
      { id: TRIP_ID, owner_id: BOB },
      { id: OTHER_TRIP, owner_id: CARL },
    ],
    trip_members: [
      { trip_id: TRIP_ID, user_id: BOB, role: "owner", status: "accepted" },
      { trip_id: TRIP_ID, user_id: ALICE, role: "member", status: "accepted" },
      { trip_id: OTHER_TRIP, user_id: CARL, role: "owner", status: "accepted" },
    ],
    user_follows: [],
    circle_memberships: [],
    discovery_places: [{ id: PLACE_ID, name: "Dragon Bridge", city: "Da Nang" }],
  } as Record<string, any[]>;
}

interface Client { client: any; writes: Array<{ table: string; op: string }> }

function makeClient(state: State = {}): Client {
  const db = fixture();
  const writes: Array<{ table: string; op: string }> = [];

  function from(table: string) {
    const preds: Array<(r: any) => boolean> = [];
    let _limit: number | null = null;

    const rowsNow = () => {
      const rows = (db[table] ?? []).filter((r) => preds.every((f) => f(r)));
      return _limit !== null ? rows.slice(0, _limit) : rows;
    };
    const injected = () => {
      if (table === "blocks" && state.blocksError) return { message: "blocks read blew up" };
      if (table === "memory_tags" && state.tagsError) return { message: "tags read blew up" };
      if (table === "trip_members" && state.crewError) return { message: "crew read blew up" };
      return null;
    };

    const target: any = {
      select() { return proxy; },
      eq(col: string, val: any) { preds.push((r) => String(r[col]) === String(val)); return proxy; },
      neq(col: string, val: any) { preds.push((r) => String(r[col]) !== String(val)); return proxy; },
      in(col: string, vals: any[]) { preds.push((r) => vals.map(String).includes(String(r[col]))); return proxy; },
      /**
       * PostgREST semantics, not "contains". `.ilike(col, "carl")` sends
       * `ilike.carl`, which has no wildcard and is therefore an EXACT
       * case-insensitive match; only a pattern carrying `%` matches a
       * substring. The first version of this fake did `includes()` for both,
       * which is LOOSER than production — and a fake looser than production
       * cannot fail a test about identity resolution, which is the one thing
       * §28.5 asks these tools not to get wrong.
       */
      ilike(col: string, pattern: string) {
        const p = String(pattern);
        const v = (r: any) => String(r[col] ?? "").toLowerCase();
        if (p.includes("%")) {
          const needle = p.replace(/%/g, "").toLowerCase();
          preds.push((r) => v(r).includes(needle));
        } else {
          preds.push((r) => v(r) === p.toLowerCase());
        }
        return proxy;
      },
      order() { return proxy; },
      limit(n: number) { _limit = n; return proxy; },
      insert() { writes.push({ table, op: "insert" }); return proxy; },
      update() { writes.push({ table, op: "update" }); return proxy; },
      upsert() { writes.push({ table, op: "upsert" }); return proxy; },
      delete() { writes.push({ table, op: "delete" }); return proxy; },
      maybeSingle() {
        const err = injected();
        if (err) return Promise.resolve({ data: null, error: err });
        return Promise.resolve({ data: rowsNow()[0] ?? null, error: null });
      },
      then(resolve: (v: any) => void, reject?: (e: any) => void) {
        const err = injected();
        if (err) return Promise.resolve({ data: null, error: err, count: null }).then(resolve, reject);
        const rows = rowsNow();
        return Promise.resolve({ data: rows, error: null, count: rows.length }).then(resolve, reject);
      },
    };
    const proxy: any = new Proxy(target, {
      get(t, prop) {
        if (prop in t) return t[prop as string];
        if (prop === "catch" || prop === "finally") return undefined;
        return () => proxy;
      },
    });
    return proxy;
  }

  return {
    client: { from, rpc: async () => ({ data: null, error: { message: "rpc not modelled" } }) } as any,
    writes,
  };
}

/* ─────────────────── the eight exist, and are reachable ───────────────────── */

describe("§16 — the eight accessors exist and the model is offered them", () => {
  it("names all eight of §16's accessors", () => {
    assert.equal(Object.keys(MEMORY_TOOL_SPEC_NAMES).length, 8);
    for (const toolName of Object.values(MEMORY_TOOL_SPEC_NAMES)) {
      assert.ok(MEMORY_COMPASS_TOOL_NAMES.has(toolName), `§16 accessor missing: ${toolName}`);
    }
    assert.equal(MEMORY_COMPASS_TOOL_DEFINITIONS.length, 8);
  });

  it("all eight are registered in the definition list handed to the model", () => {
    const registered = new Set(COMPASS_TOOL_DEFINITIONS.map((t: any) => t.function.name));
    for (const toolName of MEMORY_COMPASS_TOOL_NAMES) {
      assert.ok(registered.has(toolName), `not offered to the model: ${toolName}`);
    }
  });

  /**
   * census-highlights-memories §B.7 recorded two greps as the mechanical reason
   * §16's rows could not move: no tool NAME contains `memor`, and no tool
   * implementation reads a Memory table. This asserts the first of them has
   * flipped, in the definition list itself rather than by re-running a grep.
   */
  it("falsifies §B.7's 'not one of the tool names contains memory' grep", () => {
    const memoryFacing = COMPASS_TOOL_DEFINITIONS
      .map((t: any) => t.function.name as string)
      .filter((n) => /memor/.test(n));
    assert.equal(memoryFacing.length, 8, `expected 8 memory-facing tool names, got ${memoryFacing.join(", ")}`);
  });

  it("every declared tool is dispatchable — no definition without an implementation", async () => {
    const { client } = makeClient();
    for (const def of MEMORY_COMPASS_TOOL_DEFINITIONS) {
      const out = await executeMemoryCompassTool(client, ALICE, def.function.name, {
        memoryId: M_OWN_PUBLIC, tripId: TRIP_ID, personHandle: "carl", placeId: PLACE_ID,
        query: "bridge", patch: { title: "x" },
      });
      assert.notEqual(out, undefined, `declared but not dispatched: ${def.function.name}`);
      assert.notDeepEqual(out, { authorized: false, reason: `Unknown Memory tool: ${def.function.name}` });
    }
  });

  it("reaches them through executeCompassTool, not only through their own dispatcher", async () => {
    const { client } = makeClient();
    const out: any = await executeCompassTool(client, ALICE, null, "memory_get", { memoryId: M_OWN_PUBLIC });
    assert.equal(out.memory.memory_id, M_OWN_PUBLIC);
  });

  it("the §16 boundary reaches the model as prompt text as well as as refusals", () => {
    assert.match(COMPASS_TOOLS_PROMPT_ADDENDUM, /MEMORY RULES \(Highlights\/Memories §16\)/);
    assert.match(COMPASS_TOOLS_PROMPT_ADDENDUM, /establishes_current_status: false/);
  });
});

/* ───────────────── §16: may not bypass privacy policy (H127) ──────────────── */

describe("§16 — Compass may not bypass privacy/visibility policy", () => {
  it("refuses another user's only_me Memory", async () => {
    const { client } = makeClient();
    const out: any = await executeMemoryCompassTool(client, ALICE, "memory_get", { memoryId: M_BOB_ONLYME });
    assert.equal(out.authorized, false);
  });

  it("gives the SAME refusal for a Memory that does not exist — no existence oracle", async () => {
    const { client } = makeClient();
    const missing: any = await executeMemoryCompassTool(client, ALICE, "memory_get", { memoryId: "99999999-0000-4000-8000-000000000000" });
    const forbidden: any = await executeMemoryCompassTool(client, ALICE, "memory_get", { memoryId: M_BOB_ONLYME });
    assert.deepEqual(missing, forbidden);
  });

  it("ADMITS an allow-listed `custom` Memory — the compass surface is addressed, not the feed", async () => {
    const { client } = makeClient();
    const out: any = await executeMemoryCompassTool(client, ALICE, "memory_get", { memoryId: M_BOB_CUSTOM });
    assert.equal(out.memory.memory_id, M_BOB_CUSTOM);
    // …and the SAME row on the public feed surface is refused, which is what
    // makes the surface parameter load-bearing rather than decorative.
    const row = fixture().memories.find((m) => m.id === M_BOB_CUSTOM)!;
    assert.equal(await canReadMemory(client, row, ALICE, "public_feed"), false);
    assert.equal(await canReadMemory(client, row, ALICE, "compass"), true);
  });

  it("refuses a blocked viewer a PUBLIC Memory — the block check is inside the gate", async () => {
    const { client } = makeClient();
    const out: any = await executeMemoryCompassTool(client, ALICE, "memory_get", { memoryId: M_MALLORY_PUBLIC });
    assert.equal(out.authorized, false);
    // Without the block, the same row reads. This is the control: if the test
    // above ever passes for the wrong reason (the row simply being unreadable),
    // this line fails and says so.
    const row = fixture().memories.find((m) => m.id === M_MALLORY_PUBLIC)!;
    assert.equal(await canReadMemory(client, row, ALICE, "compass"), true);
    assert.equal(await canCompassReadMemory(client, row, ALICE), false);
  });

  it("fails CLOSED when the blocks table cannot be read", async () => {
    const { client } = makeClient({ blocksError: true });
    const out: any = await executeMemoryCompassTool(client, ALICE, "memory_get", { memoryId: M_BOB_CUSTOM });
    assert.equal(out.authorized, false);
  });

  it("refuses rather than answering from a partial history when memory_tags is unreadable", async () => {
    const { client } = makeClient({ tagsError: true });
    const out: any = await executeMemoryCompassTool(client, ALICE, "memory_search", { query: "bridge" });
    assert.equal(out.authorized, false);
    assert.match(out.reason, /incomplete/i);
  });

  it("search returns only the viewer's own history, never a stranger's public Memory", async () => {
    const { client } = makeClient();
    const out: any = await executeMemoryCompassTool(client, ALICE, "memory_search", { query: "public" });
    const ids = out.memories.map((m: any) => m.memory_id);
    assert.ok(!ids.includes(M_MALLORY_PUBLIC), "a stranger's Memory reached the assistant");
  });

  it("never emits a coordinate, an owner id or an audience list", async () => {
    const { client } = makeClient();
    const raw: any = await executeMemoryCompassTool(client, ALICE, "memory_get", { memoryId: M_OWN_PUBLIC });
    const text = JSON.stringify(raw);
    assert.ok(!/location_lat|location_lng|16\.0544|108\.2022/.test(text), "a coordinate reached the model");
    assert.ok(!/owner_id|allowed_user_ids|hidden_user_ids/.test(text), "an internal authorization field reached the model");
  });

  it("refuses trip Memories to a non-member, and fails closed when membership is unreadable", async () => {
    const { client } = makeClient();
    const notMember: any = await executeMemoryCompassTool(client, ALICE, "memory_get_trip_memories", { tripId: OTHER_TRIP });
    assert.equal(notMember.authorized, false);

    const member: any = await executeMemoryCompassTool(client, ALICE, "memory_get_trip_memories", { tripId: TRIP_ID });
    assert.deepEqual(member.memories.map((m: any) => m.memory_id), [M_TRIP_CREW]);

    const broken = makeClient({ crewError: true });
    const degraded: any = await executeMemoryCompassTool(broken.client, ALICE, "memory_get_trip_memories", { tripId: TRIP_ID });
    assert.equal(degraded.authorized, false);
    assert.match(degraded.reason, /withheld/i);
  });
});

/* ──────── §16: may not invent participants or attendance (H126) ──────────── */

describe("§16 — an unconfirmed tag is not attendance", () => {
  it("separates approved participation from tagged-but-unconfirmed", async () => {
    const { client } = makeClient();
    const out: any = await executeMemoryCompassTool(client, ALICE, "memory_get_shared", { personHandle: "carl" });
    assert.deepEqual(out.memories.map((m: any) => m.memory_id), [M_OWN_WITH_CARL]);
    assert.deepEqual(out.unconfirmed_participation.map((m: any) => m.memory_id), [M_OWN_CARL_PENDING]);
    assert.match(out.participation_rule, /never that the person was there/);
  });

  it("a REMOVED tag is reported in neither list", async () => {
    const { client } = makeClient();
    const out: any = await executeMemoryCompassTool(client, ALICE, "memory_get_shared", { personHandle: "mallory" });
    // Mallory's tag on M_OWN_PUBLIC is `removed`; she also blocks Alice, so the
    // only honest answer is nothing at all.
    const all = [...out.memories, ...(out.unconfirmed_participation ?? [])];
    assert.equal(all.length, 0);
  });

  it("a draft naming a handle that does not exist is REFUSED, not silently trimmed", async () => {
    const { client, writes } = makeClient();
    const out: any = await executeMemoryCompassTool(client, ALICE, "memory_create_draft", {
      title: "Dinner", startsAt: "2026-04-01", locationCity: "Hanoi", participantHandles: ["carl", "nobodyatall"],
    });
    assert.equal(out.authorized, false);
    assert.match(out.reason, /@nobodyatall/);
    assert.equal(writes.length, 0);
  });
});

/* ───────────── §14: historical truth and current truth are separate ──────── */

describe("§14 — a historical fact never becomes a current claim", () => {
  it("stamps every Memory fact as historical and non-current", async () => {
    const { client } = makeClient();
    const out: any = await executeMemoryCompassTool(client, ALICE, "memory_get", { memoryId: M_OWN_PUBLIC });
    assert.equal(out.memory.historical.truth_class, "historical");
    assert.equal(out.memory.historical.establishes_current_status, false);
    assert.equal(out.memory.historical.as_of, "2026-03-04T13:00:00.000Z");
    assert.equal(out.memory.historical.confidence.sourceClass, "historical");
  });

  it("place history with no live source may state NOTHING about now", async () => {
    const { client } = makeClient();
    const out: any = await executeMemoryCompassTool(client, ALICE, "memory_get_place_history", { placeId: PLACE_ID });
    assert.equal(out.visits.length, 1);
    assert.equal(out.current_world.available, false);
    assert.equal(out.fusion.merged, false);
    assert.equal(out.fusion.may_state_current_status, false);
    // The visit is recent and the flag is still false. That is the invariant:
    // recency of the historical half moves nothing.
    assert.ok(out.fusion.historical.as_of);
  });

  it("REFUSES a current-world claim built from a historical or inferred source", () => {
    for (const bad of ["historical", "ai_inference"] as const) {
      const reading = currentWorldReading("Dragon Bridge is open right now.", bad);
      assert.equal(reading.available, false, `${bad} was accepted as a current-world source`);
      if (!reading.available) assert.match(reading.reason, /§14/);
    }
    for (const good of CURRENT_WORLD_SOURCE_CLASSES) {
      assert.equal(currentWorldReading("It is open.", good).available, true);
    }
  });

  it("fusion is a juxtaposition: both halves survive and neither is derived from the other", () => {
    const h = asHistoricalFact({ subject: "Dragon Bridge", claim: "visited", asOf: "2026-03-04T00:00:00.000Z", nowMs: Date.parse("2026-03-14T00:00:00.000Z") });
    assert.equal(h.age_days, 10);
    const withLive = fuseHistoricalWithCurrent(h, currentWorldReading("It is open.", "verified_live"));
    assert.equal(withLive.merged, false);
    assert.equal(withLive.may_state_current_status, true);
    assert.equal(withLive.historical.establishes_current_status, false);
    const withoutLive = fuseHistoricalWithCurrent(h, currentWorldUnknown("source down"));
    assert.equal(withoutLive.may_state_current_status, false);
    assert.match(withoutLive.fusion_note, /no current claim may be made/);
  });

  /**
   * The §14 caveat travels in a field, and `sanitizeToolResult` deletes fields
   * by NAME. A field called `note` would be deleted — silently, on every result.
   */
  it("the sanitizer does not eat the §14 caveat", () => {
    const fused = fuseHistoricalWithCurrent(
      asHistoricalFact({ subject: "x", claim: "y", asOf: null }),
      currentWorldUnknown("no source"),
    );
    const cleaned: any = sanitizeToolResult({ fusion: fused });
    assert.equal(typeof cleaned.fusion.fusion_note, "string");
    assert.equal(cleaned.fusion.merged, false);
    assert.equal(cleaned.fusion.historical.establishes_current_status, false);
  });
});

/* ─────────────── §16: the two write-shaped tools write nothing ───────────── */

describe("§16 — Compass proposes; it does not mutate canonical Memory facts", () => {
  it("no accessor issues a write, of any kind, to any table", async () => {
    const { client, writes } = makeClient();
    for (const def of MEMORY_COMPASS_TOOL_DEFINITIONS) {
      await executeMemoryCompassTool(client, ALICE, def.function.name, {
        memoryId: M_OWN_PUBLIC, tripId: TRIP_ID, personHandle: "carl", placeId: PLACE_ID,
        query: "bridge", title: "New", startsAt: "2026-05-01", locationCity: "Hue",
        patch: { title: "Corrected title" },
      });
    }
    assert.deepEqual(writes, []);
  });

  it("a draft comes back requiring confirmation through the authenticated route", async () => {
    const { client } = makeClient();
    const out: any = await executeMemoryCompassTool(client, ALICE, "memory_create_draft", {
      title: "Boat day", startsAt: "2026-05-01", locationCity: "Phuket", participantHandles: ["carl"],
    });
    assert.equal(out.draft.requires_confirmation, true);
    assert.equal(out.draft.confirm_via, "POST /memories");
    assert.equal(out.writes_nothing, true);
    assert.deepEqual(out.draft.participants, [{ handle: "carl", user_id: CARL }]);
    assert.equal(out.clarifying_question, null);
  });

  it("asks the MINIMUM clarifying question — exactly one, even with three facts missing", async () => {
    const { client } = makeClient();
    const out: any = await executeMemoryCompassTool(client, ALICE, "memory_create_draft", {});
    assert.equal(typeof out.clarifying_question, "string");
    assert.match(out.clarifying_question, /When did this happen/);
    // One question, not a list: no separator that would make it two.
    assert.ok(!/\?\s+\S+.*\?/.test(out.clarifying_question), "more than one question was asked");
  });

  it("drops fields no draft may name, and says which", async () => {
    const { client } = makeClient();
    const out: any = await executeMemoryCompassTool(client, ALICE, "memory_create_draft", {
      title: "x", startsAt: "2026-05-01", locationCity: "Hue", allowedUserIds: [BOB], state: "published",
    });
    assert.deepEqual(new Set(out.ignored_fields), new Set(["allowedUserIds", "state"]));
    assert.ok(!DRAFTABLE_FIELDS.includes("allowedUserIds"));
    assert.ok(!DRAFTABLE_FIELDS.includes("state"));
  });

  it("a correction is refused to anyone but the owner", async () => {
    const { client } = makeClient();
    const out: any = await executeMemoryCompassTool(client, ALICE, "memory_suggest_correction", {
      memoryId: M_BOB_CUSTOM, patch: { title: "Not yours" },
    });
    assert.equal(out.authorized, false);
    assert.match(out.reason, /Only the owner/);
  });

  it("a correction proposes the patch beside the current value and refuses audience changes", async () => {
    const { client, writes } = makeClient();
    const out: any = await executeMemoryCompassTool(client, ALICE, "memory_suggest_correction", {
      memoryId: M_OWN_PUBLIC,
      patch: { title: "Dragon Bridge fire show", visibility: "public", allowedUserIds: [BOB] },
    });
    assert.deepEqual(out.proposed_patch, { title: "Dragon Bridge fire show" });
    assert.equal(out.current_values.title, "Dragon Bridge at night");
    assert.deepEqual(new Set(out.refused_fields), new Set(["visibility", "allowedUserIds"]));
    assert.equal(out.requires_confirmation, true);
    assert.equal(writes.length, 0);
    assert.ok(!CORRECTABLE_FIELDS.includes("visibility"));
  });
});

/* ────────────────────── §16 getMemoryEvidence, honestly ──────────────────── */

describe("§16 — getMemoryEvidence says there is no evidence store", () => {
  it("reports the absence first and does not dress attachments as proof", async () => {
    const { client } = makeClient();
    const out: any = await executeMemoryCompassTool(client, ALICE, "memory_get_evidence", { memoryId: M_OWN_PUBLIC });
    assert.equal(out.evidence_store, "absent");
    assert.match(out.evidence_store_reason, /memory_evidence/);
    assert.equal(out.attached_artifacts.length, 1);
    assert.match(out.caveat, /NOT §6-normalized evidence/);
    assert.equal(out.confirmed_participants, 0);
    assert.equal(out.unconfirmed_participants, 0);
  });

  it("refuses evidence for a Memory the viewer may not read", async () => {
    const { client } = makeClient();
    const out: any = await executeMemoryCompassTool(client, ALICE, "memory_get_evidence", { memoryId: M_BOB_ONLYME });
    assert.equal(out.authorized, false);
  });
});

/* ───────── §9 / §28.5: identity is resolved, never guessed (H74) ─────────── */

describe("§16/§9 — a participant is resolved by exact handle, never by resemblance", () => {
  it("a handle that merely RESEMBLES a real one does not resolve", async () => {
    const { client } = makeClient();
    const out: any = await executeMemoryCompassTool(client, ALICE, "memory_create_draft", {
      title: "Boat day", startsAt: "2026-05-01", locationCity: "Phuket", participantHandles: ["car"],
    });
    assert.equal(out.authorized, false, "'car' resolved to somebody — identity was inferred from similarity");
    assert.match(out.reason, /@car\b/);
    // Control: the exact handle DOES resolve, so the refusal above is about
    // similarity and not about the lookup being broken.
    const ok: any = await executeMemoryCompassTool(client, ALICE, "memory_create_draft", {
      title: "Boat day", startsAt: "2026-05-01", locationCity: "Phuket", participantHandles: ["carl"],
    });
    assert.deepEqual(ok.draft.participants, [{ handle: "carl", user_id: CARL }]);
  });

  it("getSharedMemories does not resolve a near-miss handle either", async () => {
    const { client } = makeClient();
    const out: any = await executeMemoryCompassTool(client, ALICE, "memory_get_shared", { personHandle: "car" });
    assert.equal(out.authorized, false);
    const ok: any = await executeMemoryCompassTool(client, ALICE, "memory_get_shared", { personHandle: "carl" });
    assert.equal(ok.person, "carl");
  });
});

/* ───────── §9 H70: a closure now does not unmake a visit then ────────────── */

describe("§9 — place closure does not invalidate a historical visit", () => {
  it("a live 'closed' reading leaves the historical claim byte-identical", () => {
    const visit = asHistoricalFact({
      subject: "Dragon Bridge", claim: "Recorded: visited on 2026-03-04.",
      asOf: "2026-03-04T00:00:00.000Z", nowMs: Date.parse("2026-06-04T00:00:00.000Z"),
    });
    const snapshot = JSON.parse(JSON.stringify(visit));
    const closed = fuseHistoricalWithCurrent(visit, currentWorldReading("Dragon Bridge is closed right now.", "verified_live"));
    assert.deepEqual(closed.historical, snapshot, "a current-world closure rewrote the historical fact");
    assert.equal(closed.merged, false);
    // The closure is reportable — it is just reported as its own claim.
    assert.equal(closed.current.available, true);
  });

  it("place history returns the visits whatever the current world says", async () => {
    const { client } = makeClient();
    const out: any = await executeMemoryCompassTool(client, ALICE, "memory_get_place_history", { placeId: PLACE_ID });
    assert.equal(out.visit_count, 1);
    assert.equal(out.current_world.available, false);
    assert.equal(out.visits[0].historical.claim.includes("2026-03-04"), true);
  });
});
