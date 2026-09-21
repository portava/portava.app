/**
 * §18 owner-scoped projections, reached by a caller — and §8's score published
 * on the one surface §18 says may carry it.
 *
 * CENSUS H163 (MemoryTimelineProjection), H167 (PlaceMemoryProjection),
 * H168 (PeopleMemoryProjection), H63 (significance scored from the listed
 * inputs), H64 (internal, never a public social score), H66 (explicit user
 * intent outranks inferred significance; never demote a user-created Memory).
 *
 * The §18 block's blanket reason for BBW was "defined in the registry and
 * unreachable". Section J answered that for TripMemoryProjection with a NEW
 * route rather than by changing a shipped response shape, and stated the
 * pattern: the projection is not the permission, so the §23 ladder runs first
 * and the builder's own owner filter runs on top. These three projections are
 * OWNER_PRIVATE / SHARED_HISTORY and the reader is always the scope owner, so
 * the ladder is an identity check — which is why the assertions below are about
 * what a NON-owner cannot reach and about what the field whitelist keeps off
 * the wire.
 *
 * RED BEFORE GREEN: at 9a9ce60f0 none of the three routes exists and every
 * request below comes back 404 (the `/memories/:id` catch-all answers
 * `/memories/timeline` with `invalid_payload`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../../lib/http.js";
import memoriesRouter from "../../routes/memories.js";
import { getProjectionDefinition } from "./projectionRegistry.js";
import {
  UNAVAILABLE_SIGNIFICANCE_INPUTS,
  deriveSignificance,
  significanceAudienceFor,
  discloseProjectionRows,
} from "../memory/memorySignificanceDisclosure.js";

const OWNER = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const FRIEND = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const STRANGER = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const BLOCKED = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const PLACE = "11111111-1111-1111-1111-111111111111";
const TRIP = "22222222-2222-2222-2222-222222222222";

interface FakeState { [t: string]: any[] }

function mem(id: string, over: Record<string, any> = {}) {
  return {
    id, owner_id: OWNER, title: "A day", caption: "",
    visibility: "only_me", allowed_user_ids: [], hidden_user_ids: [],
    trip_id: TRIP, event_id: null, place_id: PLACE, canonical_location_id: null,
    location_city: "Kyoto", location_country: "Japan",
    location_lat: 35.01, location_lng: 135.76,
    starts_at: "2024-03-01T10:00:00.000Z", ends_at: null, state: "published",
    created_at: "2024-03-01T10:00:00.000Z", updated_at: "2024-03-01T10:00:00.000Z",
    ...over,
  };
}

function baseState(): FakeState {
  return {
    trips: [{ id: TRIP, owner_id: OWNER }],
    trip_members: [{ trip_id: TRIP, user_id: OWNER, role: "owner", status: "accepted" }],
    memories: [
      // Three visits to the same place, so repeat_visit_count is a real figure
      // derived from the owner's own history rather than a constant.
      mem("m1", { starts_at: "2024-03-01T10:00:00.000Z", title: "First visit" }),
      mem("m2", { starts_at: "2024-03-05T10:00:00.000Z", title: "Second visit" }),
      mem("m3", { starts_at: "2024-03-09T10:00:00.000Z", title: "Third visit", caption: "the rain stopped" }),
      // A different place, no companions, no caption: the low-significance row
      // §8's never-demote rule must still keep on the owner's own timeline.
      mem("m4", { starts_at: "2024-02-01T10:00:00.000Z", title: "Quiet morning", place_id: null, canonical_location_id: null, trip_id: null }),
      // Deleted — never projected.
      mem("md", { state: "deleted", title: "Deleted" }),
      // Another owner's Memory at the same place. The route is owner-scoped;
      // this must not reach the timeline, the place history or the repeat count.
      mem("mx", { owner_id: STRANGER, title: "Someone else's" }),
    ],
    memory_items: [
      { id: "i1", memory_id: "m1", media_url: "u1", media_type: "image/jpeg", position: 0 },
    ],
    memory_tags: [
      { memory_id: "m3", tagged_user_id: FRIEND, status: "approved" },
      { memory_id: "m3", tagged_user_id: BLOCKED, status: "approved" },
      // PENDING — not a shared experience, whatever the person ladder says.
      { memory_id: "m2", tagged_user_id: FRIEND, status: "pending" },
    ],
    memory_likes: [], memory_saves: [], user_follows: [], circle_memberships: [],
    profiles: [
      { id: OWNER, name: "Alice", handle: "alice", avatar_url: null },
      { id: FRIEND, name: "Bob", handle: "bob", avatar_url: null },
      { id: BLOCKED, name: "Dave", handle: "dave", avatar_url: null },
    ],
    profile_privacy_settings: [],
    blocks: [{ blocker_id: BLOCKED, blocked_id: OWNER }],
    feature_flags: [],
    compass_feed_cache: [], compass_cache_invalidations: [],
  };
}

function makeClient(state: FakeState, failTables = new Set<string>()) {
  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let limitN: number | null = null;
    let countMode = false;
    const fail = failTables.has(table) ? { message: `${table} unreadable` } : null;
    const builder: any = {
      select(_c?: string, opts?: any) { if (opts?.count === "exact" && opts?.head) countMode = true; return builder; },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return builder; },
      neq(c: string, v: any) { filters.push((r) => r[c] !== v); return builder; },
      is(c: string, v: any) { filters.push((r) => (r[c] ?? null) === v); return builder; },
      in(c: string, vs: any[]) {
        // §J item 5: `.in()` rides in the QUERY STRING. A route that does not
        // chunk would name every id at once, and PostgREST rejects the request
        // before the database sees it. The fake records the widest list it was
        // given so a test can assert the chunking is real.
        (state.__inWidths ??= []).push(vs.length);
        filters.push((r) => vs.includes(r[c]));
        return builder;
      },
      gt(c: string, v: any) { filters.push((r) => r[c] > v); return builder; },
      lt(c: string, v: any) { filters.push((r) => r[c] < v); return builder; },
      not(c: string, _o: string, v: any) { filters.push((r) => r[c] !== v); return builder; },
      // PostgREST's OR filter, as the place-history read uses it:
      // `place_id.eq.<uuid>,canonical_location_id.eq.<uuid>`. Parsed rather
      // than ignored, so a route that sent a malformed OR would not quietly
      // pass here and fail against the real database.
      or(expr: string) {
        const terms = expr.split(",").map((t) => {
          const m = /^([a-z_]+)\.eq\.(.+)$/.exec(t.trim());
          if (!m) throw new Error(`fake client: unsupported or() term ${t}`);
          return { col: m[1], val: m[2] };
        });
        filters.push((r) => terms.some((t) => String(r[t.col] ?? "") === t.val));
        return builder;
      },
      order() { return builder; },
      limit(n: number) { limitN = n; return builder; },
      maybeSingle: async () => (fail ? { data: null, error: fail } : { data: rows()[0] ?? null, error: null, count: null }),
      single: async () => (fail ? { data: null, error: fail } : { data: rows()[0] ?? null, error: null, count: null }),
      then(onF: any, onR: any) {
        const p = fail
          ? Promise.resolve({ data: null, error: fail, count: null })
          : Promise.resolve(countMode
            ? { data: null, error: null, count: rows().length }
            : { data: limitN == null ? rows() : rows().slice(0, limitN), error: null, count: rows().length });
        return p.then(onF, onR);
      },
    };
    function rows() { return (state[table] ?? []).filter((r) => filters.every((f) => f(r))); }
    return builder;
  }
  return {
    from,
    auth: {
      getUser: async (tok: string) => {
        const map: Record<string, { id: string }> = {
          "owner-tok": { id: OWNER }, "friend-tok": { id: FRIEND }, "stranger-tok": { id: STRANGER },
        };
        const u = map[tok];
        return u ? { data: { user: u }, error: null } : { data: { user: null }, error: { message: "invalid" } };
      },
    },
  };
}

async function startApp(state: FakeState, failTables = new Set<string>()) {
  _setTestClient(makeClient(state, failTables) as any, true);
  const app = express();
  app.use(express.json());
  app.use((req: any, _r: any, next: any) => { req.log = { error: () => {}, info: () => {}, warn: () => {} }; next(); });
  app.use("/api", memoriesRouter);
  return new Promise<{ baseUrl: string; close: () => Promise<void> }>((resolve, reject) => {
    const srv = http.createServer(app);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.unref();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((res, rej) => { srv.closeAllConnections(); srv.close((e) => (e ? rej(e) : res())); }),
      });
    });
    srv.on("error", reject);
  });
}

async function get(base: string, path: string, tok?: string) {
  const h: Record<string, string> = { connection: "close" };
  if (tok) h.Authorization = `Bearer ${tok}`;
  const res = await fetch(`${base}${path}`, { headers: h });
  const body: any = await res.json().catch(() => null);
  return { status: res.status, body };
}

const TIMELINE = "/api/memories/timeline";
const PLACE_HISTORY = `/api/memories/places/${PLACE}`;
const SHARED = `/api/memories/people/${FRIEND}`;

describe("GET /memories/timeline — §18 MemoryTimelineProjection, consumed (H163)", () => {
  it("requires authentication", async () => {
    const app = await startApp(baseState());
    try { assert.equal((await get(app.baseUrl, TIMELINE)).status, 401); } finally { await app.close(); }
  });

  it("serves the owner's own Memories, newest first, and nobody else's", async () => {
    const app = await startApp(baseState());
    try {
      const { status, body } = await get(app.baseUrl, TIMELINE, "owner-tok");
      assert.equal(status, 200);
      assert.equal(body.timeline.projectionId, "MemoryTimelineProjection");
      assert.equal(body.timeline.builderVersion, "timeline@1");
      assert.equal(body.timeline.destination, "owner.private.timeline");
      assert.equal(body.timeline.audience, "OWNER_PRIVATE");
      assert.deepEqual(body.timeline.rows.map((r: any) => r.memory_id), ["m3", "m2", "m1", "m4"]);
      assert.ok(typeof body.timeline.sourceVersion === "string" && body.timeline.sourceVersion.startsWith("v1:"));
    } finally { await app.close(); }
  });

  it("carries exactly the projection's field whitelist", async () => {
    const app = await startApp(baseState());
    try {
      const { body } = await get(app.baseUrl, TIMELINE, "owner-tok");
      const whitelist = [...getProjectionDefinition("MemoryTimelineProjection")!.field_whitelist].sort();
      for (const row of body.timeline.rows) assert.deepEqual(Object.keys(row).sort(), whitelist);
      // No coordinate may ride on this response, whitelist or no whitelist.
      const s = JSON.stringify(body);
      assert.ok(!s.includes("135.76"), "the exact coordinate must not be serialized");
    } finally { await app.close(); }
  });

  it("another user's timeline is not addressable: the route has no userId", async () => {
    const app = await startApp(baseState());
    try {
      const { body } = await get(app.baseUrl, `${TIMELINE}?userId=${STRANGER}`, "owner-tok");
      assert.deepEqual(body.timeline.rows.map((r: any) => r.memory_id).sort(), ["m1", "m2", "m3", "m4"]);
    } finally { await app.close(); }
  });

  it("the source version is a digest of the OWNER'S rows: a stranger writing does not move it", async () => {
    // MUT-1 killer. The builder's own `ownerVisible` already drops another
    // owner's row from the projected list, so an unscoped READ would be
    // invisible in `rows` — but `sourceVersion` is computed over what was read,
    // and a digest that moves when a stranger writes is both wrong and a
    // disclosure of activity that is not the owner's.
    const app = await startApp(baseState());
    let mine: string;
    try {
      mine = (await get(app.baseUrl, TIMELINE, "owner-tok")).body.timeline.sourceVersion;
    } finally { await app.close(); }
    const state = baseState();
    state.memories.push(mem("mx2", { owner_id: STRANGER, title: "Another of theirs", starts_at: "2024-06-01T10:00:00.000Z" }));
    const app2 = await startApp(state);
    try {
      const after = (await get(app2.baseUrl, TIMELINE, "owner-tok")).body.timeline.sourceVersion;
      assert.equal(after, mine, "the owner's timeline version must not depend on anyone else's Memories");
    } finally { await app2.close(); }
  });

  it("refuses rather than serving an empty life when memories are unreadable", async () => {
    const app = await startApp(baseState(), new Set(["memories"]));
    try {
      const { status, body } = await get(app.baseUrl, TIMELINE, "owner-tok");
      assert.equal(status, 503);
      assert.equal(body.error, "degraded_unavailable");
    } finally { await app.close(); }
  });

  it("refuses rather than reporting a companion-free life when tags are unreadable", async () => {
    const app = await startApp(baseState(), new Set(["memory_tags"]));
    try {
      const { status, body } = await get(app.baseUrl, TIMELINE, "owner-tok");
      assert.equal(status, 503);
      assert.equal(body.error, "degraded_unavailable");
    } finally { await app.close(); }
  });

  it("refuses rather than reporting a photograph-free life when items are unreadable", async () => {
    const app = await startApp(baseState(), new Set(["memory_items"]));
    try {
      const { status } = await get(app.baseUrl, TIMELINE, "owner-tok");
      assert.equal(status, 503);
    } finally { await app.close(); }
  });

  it("chunks its id lists: no `.in()` is given more than IN_LIST_CHUNK ids", async () => {
    const state = baseState();
    const many = Array.from({ length: 450 }, (_, i) =>
      mem(`b${String(i).padStart(4, "0")}`, { starts_at: `2023-01-01T00:00:${String(i % 60).padStart(2, "0")}.000Z` }));
    state.memories.push(...many);
    const app = await startApp(state);
    try {
      const { status } = await get(app.baseUrl, TIMELINE, "owner-tok");
      assert.equal(status, 200);
      const widths = (state.__inWidths ?? []) as unknown as number[];
      assert.ok(widths.length > 0, "the route must read tags and items by id list");
      assert.ok(Math.max(...widths) <= 200, `an .in() named ${Math.max(...widths)} ids at once`);
    } finally { await app.close(); }
  });
});

describe("§8 significance on the owner's own timeline (H63, H64, H66)", () => {
  it("scores from the inputs this schema can produce, and names the ones it cannot", async () => {
    const app = await startApp(baseState());
    try {
      const { body } = await get(app.baseUrl, TIMELINE, "owner-tok");
      const rows = body.timeline.rows as any[];
      const m3 = rows.find((r) => r.memory_id === "m3");
      const m2 = rows.find((r) => r.memory_id === "m2");
      const m1 = rows.find((r) => r.memory_id === "m1");
      // m3 and m2 are both returns to the same place; m3 alone has a caption
      // and a companion. (m1 is NOT the comparison: it is a first visit, and
      // FIRST_TIME_EXPERIENCE is weighted above a caption plus one companion
      // by design — §8 weights user-originated novelty over decoration.)
      assert.ok(typeof m3.significance_score === "number");
      assert.ok(m3.significance_score > m2.significance_score,
        `expected the captioned, companioned visit to score above the bare one (${m3.significance_score} vs ${m2.significance_score})`);
      assert.ok(m1.significance_score > 0, "a first visit scores on its own inputs");
      assert.equal(body.timeline.significance.policyVersion, "memory-significance@1");
      // The declared list is what keeps a partial score from reading as a
      // complete one: every input §8 lists that this schema cannot produce.
      assert.deepEqual(
        body.timeline.significance.inputsUnavailable.map((u: any) => u.input).sort(),
        [...UNAVAILABLE_SIGNIFICANCE_INPUTS].map((u) => u.input).sort(),
      );
      assert.ok(body.timeline.significance.inputsUnavailable.every((u: any) => typeof u.reason === "string" && u.reason.length > 0));
    } finally { await app.close(); }
  });

  it("first_time_experience is a fact about the owner's history, not about the fetch", async () => {
    const app = await startApp(baseState());
    try {
      const { body } = await get(app.baseUrl, TIMELINE, "owner-tok");
      const explain = body.timeline.significance.explanations;
      const codes = (id: string) => explain[id].contributions.map((c: any) => c.code);
      assert.ok(codes("m1").includes("FIRST_TIME_EXPERIENCE"), "the first visit to a place is a first time");
      assert.ok(!codes("m3").includes("FIRST_TIME_EXPERIENCE"), "the third visit is not");
      assert.ok(codes("m3").includes("REPEAT_VISIT"), "the third visit is a return");
      // m4 has no place at all: an unknown place is not a first time.
      assert.ok(!codes("m4").includes("FIRST_TIME_EXPERIENCE"), "a Memory with no place cannot be a first visit to it");
    } finally { await app.close(); }
  });

  it("a stranger's Memory at the same place does not count toward the owner's repeat visits", async () => {
    const app = await startApp(baseState());
    try {
      const { body } = await get(app.baseUrl, TIMELINE, "owner-tok");
      const c = body.timeline.significance.explanations["m3"].contributions.find((x: any) => x.code === "REPEAT_VISIT");
      assert.equal(c.input, 2, "two prior visits of the owner's own, not three");
    } finally { await app.close(); }
  });

  it("§8's never-demote rule: a low-scoring user-created Memory is still on the timeline", async () => {
    const app = await startApp(baseState());
    try {
      const { body } = await get(app.baseUrl, TIMELINE, "owner-tok");
      const m4 = (body.timeline.rows as any[]).find((r) => r.memory_id === "m4");
      assert.ok(m4, "the quiet morning must not be dropped for scoring low");
      const e = body.timeline.significance.explanations["m4"];
      assert.equal(e.never_discard, true);
      assert.ok(e.applied_rules.includes("USER_CREATED_NEVER_DISCARDED"));
      assert.notEqual(m4.significance_tier, "NO_CANDIDATE", "explicit user intent outranks the arithmetic");
      assert.ok(e.applied_rules.includes("USER_INTENT_FLOOR_APPLIED"));
    } finally { await app.close(); }
  });

  it("H64: the disclosure gate strips score AND tier for any audience that is not the owner", () => {
    const def = getProjectionDefinition("MemoryTimelineProjection")!;
    assert.equal(significanceAudienceFor(def, { owner_id: OWNER, viewer_id: OWNER }), "OWNER");
    assert.equal(significanceAudienceFor(def, { owner_id: OWNER, viewer_id: FRIEND }), "NON_OWNER");
    const row = { memory_id: "m1", significance_score: 0.9, significance_tier: "SUGGESTED", title: "A day" };
    const kept = discloseProjectionRows(def, { owner_id: OWNER, viewer_id: OWNER }, [row]);
    assert.equal((kept[0] as any).significance_score, 0.9);
    const stripped = discloseProjectionRows(def, { owner_id: OWNER, viewer_id: FRIEND }, [row]);
    assert.ok(!("significance_score" in stripped[0]), "a coarse public score is still a public score");
    assert.ok(!("significance_tier" in stripped[0]));
    assert.equal((stripped[0] as any).title, "A day");
  });

  it("H64: a projection that does not emit significance never carries one", () => {
    const people = getProjectionDefinition("PeopleMemoryProjection")!;
    assert.equal(people.emits_significance, false);
    const row = { memory_id: "m1", significance_score: 0.9, significance_tier: "SUGGESTED" };
    const out = discloseProjectionRows(people, { owner_id: OWNER, viewer_id: OWNER }, [row]);
    assert.ok(!("significance_score" in out[0]), "emits_significance:false is a refusal, not a default");
  });

  it("deriveSignificance counts only the OWNER'S own prior visits, whatever it is handed", () => {
    // MUT-4 killer, at the module boundary. The route happens to pre-filter by
    // owner, so this property is invisible from HTTP — and a later caller that
    // does not pre-filter would silently make one person's significance depend
    // on another's travel.
    const row = (id: string, owner: string, when: string) => ({
      id, owner_id: owner, caption: null, place_id: PLACE, canonical_location_id: null,
      starts_at: when, created_at: when,
    });
    const mixed = [
      row("s1", STRANGER, "2024-01-01T00:00:00.000Z"),
      row("s2", STRANGER, "2024-01-02T00:00:00.000Z"),
      row("o1", OWNER, "2024-01-03T00:00:00.000Z"),
    ] as any[];
    const out = deriveSignificance(OWNER, mixed, []);
    assert.equal(out.size, 1, "a stranger's Memory is not scored here");
    const codes = out.get("o1")!.contributions.map((c) => c.code);
    assert.ok(codes.includes("FIRST_TIME_EXPERIENCE"), "the owner's first visit stays a first visit");
    assert.ok(!codes.includes("REPEAT_VISIT"), "two strangers at the same place are not the owner's returns");
  });

  it("deriveSignificance is deterministic over the same rows", () => {
    const rows = [
      { id: "a", owner_id: OWNER, caption: "hi", place_id: PLACE, canonical_location_id: null, starts_at: "2024-01-01T00:00:00.000Z", created_at: "2024-01-01T00:00:00.000Z" },
      { id: "b", owner_id: OWNER, caption: null, place_id: PLACE, canonical_location_id: null, starts_at: "2024-02-01T00:00:00.000Z", created_at: "2024-02-01T00:00:00.000Z" },
    ] as any[];
    const tags = [{ memory_id: "a", tagged_user_id: FRIEND, status: "approved" }] as any[];
    const one = deriveSignificance(OWNER, rows, tags);
    const two = deriveSignificance(OWNER, rows, tags);
    assert.deepEqual(JSON.parse(JSON.stringify([...one])), JSON.parse(JSON.stringify([...two])));
  });
});

describe("GET /memories/places/:placeId — §18 PlaceMemoryProjection, consumed (H167)", () => {
  it("numbers the owner's visits from one, oldest first", async () => {
    const app = await startApp(baseState());
    try {
      const { status, body } = await get(app.baseUrl, PLACE_HISTORY, "owner-tok");
      assert.equal(status, 200);
      assert.equal(body.history.projectionId, "PlaceMemoryProjection");
      assert.deepEqual(body.history.rows.map((r: any) => [r.memory_id, r.visit_index]), [["m1", 1], ["m2", 2], ["m3", 3]]);
    } finally { await app.close(); }
  });

  it("is the owner's own history: a stranger's Memory at the same place is absent", async () => {
    const app = await startApp(baseState());
    try {
      const { body } = await get(app.baseUrl, PLACE_HISTORY, "stranger-tok");
      assert.deepEqual(body.history.rows.map((r: any) => r.memory_id), ["mx"]);
    } finally { await app.close(); }
  });

  it("carries exactly the projection's field whitelist — no caption, no coordinate", async () => {
    const app = await startApp(baseState());
    try {
      const { body } = await get(app.baseUrl, PLACE_HISTORY, "owner-tok");
      const whitelist = [...getProjectionDefinition("PlaceMemoryProjection")!.field_whitelist].sort();
      for (const row of body.history.rows) assert.deepEqual(Object.keys(row).sort(), whitelist);
      assert.ok(!JSON.stringify(body).includes("the rain stopped"), "a caption is not in PLACE_FIELDS");
    } finally { await app.close(); }
  });

  it("rejects an id that is not a uuid", async () => {
    const app = await startApp(baseState());
    try {
      const { status, body } = await get(app.baseUrl, "/api/memories/places/not-a-uuid", "owner-tok");
      assert.equal(status, 400);
      assert.equal(body.error, "invalid_payload");
    } finally { await app.close(); }
  });

  it("refuses rather than reporting no history when memories are unreadable", async () => {
    const app = await startApp(baseState(), new Set(["memories"]));
    try {
      assert.equal((await get(app.baseUrl, PLACE_HISTORY, "owner-tok")).status, 503);
    } finally { await app.close(); }
  });
});

describe("GET /memories/people/:personId — §18 PeopleMemoryProjection, consumed (H168)", () => {
  it("serves only Memories the person is APPROVED on", async () => {
    const app = await startApp(baseState());
    try {
      const { status, body } = await get(app.baseUrl, SHARED, "owner-tok");
      assert.equal(status, 200);
      assert.equal(body.sharedHistory.projectionId, "PeopleMemoryProjection");
      assert.deepEqual(body.sharedHistory.rows.map((r: any) => r.memory_id), ["m3"]);
      assert.equal(body.sharedHistory.rows[0].person_id, FRIEND);
    } finally { await app.close(); }
  });

  it("a pending tag is not a shared experience", async () => {
    const app = await startApp(baseState());
    try {
      const { body } = await get(app.baseUrl, SHARED, "owner-tok");
      assert.ok(!body.sharedHistory.rows.some((r: any) => r.memory_id === "m2"));
    } finally { await app.close(); }
  });

  it("a blocked person has no shared history at all", async () => {
    const app = await startApp(baseState());
    try {
      const { status, body } = await get(app.baseUrl, `/api/memories/people/${BLOCKED}`, "owner-tok");
      assert.equal(status, 404);
      assert.equal(body.error, "not_found");
    } finally { await app.close(); }
  });

  it("fails closed when the block table is unreadable", async () => {
    const app = await startApp(baseState(), new Set(["blocks"]));
    try {
      assert.equal((await get(app.baseUrl, SHARED, "owner-tok")).status, 404);
    } finally { await app.close(); }
  });

  it("carries exactly the projection's field whitelist", async () => {
    const app = await startApp(baseState());
    try {
      const { body } = await get(app.baseUrl, SHARED, "owner-tok");
      const whitelist = [...getProjectionDefinition("PeopleMemoryProjection")!.field_whitelist].sort();
      for (const row of body.sharedHistory.rows) assert.deepEqual(Object.keys(row).sort(), whitelist);
    } finally { await app.close(); }
  });

  it("refuses rather than reporting no shared history when tags are unreadable", async () => {
    const app = await startApp(baseState(), new Set(["memory_tags"]));
    try {
      assert.equal((await get(app.baseUrl, SHARED, "owner-tok")).status, 503);
    } finally { await app.close(); }
  });

  it("asking about yourself is refused rather than answered with your whole life", async () => {
    const app = await startApp(baseState());
    try {
      const { status, body } = await get(app.baseUrl, `/api/memories/people/${OWNER}`, "owner-tok");
      assert.equal(status, 400);
      assert.equal(body.error, "invalid_payload");
    } finally { await app.close(); }
  });
});
