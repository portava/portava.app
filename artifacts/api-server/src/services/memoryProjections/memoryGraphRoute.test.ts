/**
 * §13 — the compression hierarchy and Life Chapters, reached by a caller.
 *
 * CENSUS H104 / H105. Section D.1 filed both in group (b), "logic right,
 * nothing reaches it": "the compression hierarchy and Life Chapters are pure
 * functions over `memories`; nothing calls them". Wiring is the whole gap, and
 * these tests are the reachability proof — every one of them goes through
 * `GET /api/memories/graph` rather than calling `buildCompressionHierarchy`
 * directly.
 *
 * RED BEFORE GREEN: at `7d1f2d498` the route does not exist and every request
 * here returns 404 with `{error:"not_found"}` from the `/memories/:id` handler,
 * or nothing at all.
 *
 * The one assertion that is NOT about wiring is §28.8's: a chapter must carry
 * ids and counts and no copied prose. That is H105's actual requirement, and it
 * is asserted on the HTTP payload, because a projection that leaks a caption to
 * a client has leaked it whatever the pure function returned.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../../lib/http.js";
import memoriesRouter from "../../routes/memories.js";
import { deriveChapterThemes, buildLifeChapters, type GraphMoment } from "./memoryGraph.js";

const OWNER = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const FRIEND = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const TRIP_A = "11111111-1111-1111-1111-11111111aaaa";
const TRIP_B = "11111111-1111-1111-1111-11111111bbbb";
const PLACE = "place-kyoto";

interface FakeState { [t: string]: any[] }

function mem(id: string, over: Record<string, any> = {}) {
  return {
    id, owner_id: OWNER, title: "t", caption: "a private caption nobody may project",
    visibility: "only_me", allowed_user_ids: [], hidden_user_ids: [],
    trip_id: null, event_id: null, place_id: null, canonical_location_id: null,
    location_city: null, location_country: null, location_lat: null, location_lng: null,
    starts_at: null, ends_at: null, state: "published",
    created_at: "2024-01-01T00:00:00.000Z", updated_at: "2024-01-01T00:00:00.000Z",
    ...over,
  };
}

function baseState(): FakeState {
  return {
    memories: [
      mem("m1", { trip_id: TRIP_A, place_id: PLACE, starts_at: "2024-03-01T10:00:00.000Z" }),
      mem("m2", { trip_id: TRIP_A, place_id: PLACE, starts_at: "2024-03-01T22:00:00.000Z" }),
      // The midnight case §7 forbids splitting: 30 minutes later, next UTC day.
      mem("m3", { trip_id: TRIP_A, place_id: null, starts_at: "2024-03-02T00:30:00.000Z" }),
      mem("m4", { trip_id: TRIP_B, place_id: PLACE, starts_at: "2024-08-11T09:00:00.000Z" }),
      // Not the owner's — must never appear.
      mem("m9", { owner_id: OTHER, starts_at: "2024-03-01T11:00:00.000Z" }),
      // Deleted — must never appear.
      mem("m8", { state: "deleted", starts_at: "2024-03-01T12:00:00.000Z" }),
    ],
    memory_tags: [
      { memory_id: "m1", tagged_user_id: FRIEND, status: "approved" },
      { memory_id: "m2", tagged_user_id: FRIEND, status: "approved" },
      { memory_id: "m4", tagged_user_id: FRIEND, status: "pending" },
    ],
    memory_items: [], memory_likes: [], memory_saves: [],
    user_follows: [], circle_memberships: [], trips: [], trip_members: [],
    profiles: [], blocks: [], feature_flags: [],
    compass_feed_cache: [], compass_cache_invalidations: [],
  };
}

const inWidths: number[] = [];

interface ReadResult { data: unknown; error: unknown; count: unknown }
interface ReadCall { table: string; columns: string; count: unknown }
interface ReadOptions {
  caps?: Record<string, number>;
  calls?: ReadCall[];
  transform?: (table: string, result: ReadResult, occurrence: number) => ReadResult;
}

function makeClient(state: FakeState, failTables = new Set<string>(), options: ReadOptions = {}) {
  const occurrences = new Map<string, number>();
  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    const orders: Array<{ column: string; ascending: boolean }> = [];
    let limitN: number | null = null;
    let columns = "*";
    let count: unknown;
    const fail = failTables.has(table) ? { message: `${table} unreadable` } : null;
    const builder: any = {
      select(selected = "*", selection?: { count?: unknown }) { columns = selected; count = selection?.count; return builder; },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return builder; },
      neq(c: string, v: any) { filters.push((r) => r[c] !== v); return builder; },
      is(c: string, v: any) { filters.push((r) => (r[c] ?? null) === v); return builder; },
      in(c: string, vs: any[]) { if (table === "memory_tags") inWidths.push(vs.length); filters.push((r) => vs.includes(r[c])); return builder; },
      gt(c: string, v: any) { filters.push((r) => r[c] > v); return builder; },
      lt(c: string, v: any) { filters.push((r) => r[c] < v); return builder; },
      gte(c: string, v: any) { filters.push((r) => r[c] >= v); return builder; },
      lte(c: string, v: any) { filters.push((r) => r[c] <= v); return builder; },
      not(c: string, _op: string, v: any) { filters.push((r) => r[c] !== v); return builder; },
      order(column: string, ordering?: { ascending?: boolean }) { orders.push({ column, ascending: ordering?.ascending !== false }); return builder; },
      limit(n: number) { limitN = n; return builder; },
      maybeSingle: async () => (fail ? { data: null, error: fail } : { data: rows()[0] ?? null, error: null }),
      single: async () => (fail ? { data: null, error: fail } : { data: rows()[0] ?? null, error: null }),
      then(onF: any, onR: any) {
        const p = Promise.resolve().then(() => {
          const occurrence = (occurrences.get(table) ?? 0) + 1;
          occurrences.set(table, occurrence);
          options.calls?.push({ table, columns, count });
          const all = rows();
          const selected = all.slice(0, Math.min(limitN ?? Infinity, options.caps?.[table] ?? Infinity));
          const result: ReadResult = fail ? { data: null, error: fail, count: null } : {
            data: selected.map((row) => columns === "*" ? { ...row } : Object.fromEntries(columns.split(",").map((column) => [column.trim(), row[column.trim()]]))),
            error: null,
            count: count === "exact" ? all.length : null,
          };
          return options.transform?.(table, result, occurrence) ?? result;
        });
        return p.then(onF, onR);
      },
    };
    function rows() {
      return (state[table] ?? []).filter((row) => filters.every((filter) => filter(row))).sort((left, right) => {
        for (const order of orders) {
          const compared = String(left[order.column] ?? "").localeCompare(String(right[order.column] ?? ""));
          if (compared !== 0) return order.ascending ? compared : -compared;
        }
        return 0;
      });
    }
    return builder;
  }
  return {
    from,
    auth: {
      getUser: async (tok: string) => {
        const map: Record<string, { id: string }> = { "owner-tok": { id: OWNER }, "other-tok": { id: OTHER } };
        const u = map[tok];
        return u ? { data: { user: u }, error: null } : { data: { user: null }, error: { message: "invalid" } };
      },
    },
  };
}

async function startApp(state: FakeState, failTables = new Set<string>(), options: ReadOptions = {}) {
  _setTestClient(makeClient(state, failTables, options) as any, true);
  const app = express();
  app.use(express.json());
  app.use((req: any, _r: any, next: any) => { req.log = { error: () => {}, info: () => {}, warn: () => {} }; next(); });
  app.use("/api", memoriesRouter);
  app.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(500).json({ error: "unexpected_error" }); });
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
  return { status: res.status, body, cacheControl: res.headers.get("cache-control") };
}

describe("GET /api/memories/graph — §13 compression hierarchy, reached", () => {
  it("requires authentication", async () => {
    const app = await startApp(baseState());
    try {
      const { status } = await get(app.baseUrl, "/api/memories/graph");
      assert.equal(status, 401);
    } finally { await app.close(); }
  });

  it("returns §13's ladder with the owner's Memories rolled up", async () => {
    const app = await startApp(baseState());
    try {
      const { status, body } = await get(app.baseUrl, "/api/memories/graph", "owner-tok");
      assert.equal(status, 200);
      const levels = body?.graph?.levels;
      assert.ok(levels, "levels must be present");
      assert.equal(body.graph.engineVersion, "memory-compression@1");
      const tripKeys = levels.TRIP.map((n: any) => n.key).sort();
      assert.deepEqual(tripKeys, [TRIP_A, TRIP_B].sort());
      const tripA = levels.TRIP.find((n: any) => n.key === TRIP_A);
      assert.deepEqual(tripA.memberMemoryIds.sort(), ["m1", "m2", "m3"]);
      assert.equal(tripA.memoryCount, 3);
      // DAY is a LOCAL-CALENDAR bucket, deliberately (src/test/memoryProjection
      // Graph.test.ts asserts the same shape): the 22:00 and the 00:30 moment
      // are two different days. §7's "midnight must not force a split" binds
      // EPISODE detection, and no moment here carries an episode_id because
      // `memory_episodes` is not deployed — which is why the EPISODE level is
      // empty rather than guessed at.
      const days = levels.DAY.map((n: any) => n.key).sort();
      assert.deepEqual(days, ["2024-03-01", "2024-03-02", "2024-08-11"]);
      const march1 = levels.DAY.find((n: any) => n.key === "2024-03-01");
      assert.deepEqual(march1.memberMemoryIds.sort(), ["m1", "m2"]);
      assert.deepEqual(levels.EPISODE, []);
      // The TRIP node still contains all three: a trip is not cut at midnight.
      assert.equal(tripA.childNodeIds.length, 2, "TRIP links down to both of its DAY nodes");
    } finally { await app.close(); }
  });

  it("never projects another owner's Memory, and never a deleted one", async () => {
    const app = await startApp(baseState());
    try {
      const { body } = await get(app.baseUrl, "/api/memories/graph", "owner-tok");
      const everyId = new Set<string>(
        Object.values(body.graph.levels).flatMap((nodes: any) =>
          (nodes as any[]).flatMap((n) => n.memberMemoryIds as string[])),
      );
      assert.equal(everyId.has("m9"), false, "another owner's Memory must not be in my graph");
      assert.equal(everyId.has("m8"), false, "a deleted Memory must not be in the graph");
    } finally { await app.close(); }
  });

  it("§28.8 — a projected node carries ids and counts and NO copied prose", async () => {
    const app = await startApp(baseState());
    try {
      const { body } = await get(app.baseUrl, "/api/memories/graph", "owner-tok");
      const serialized = JSON.stringify(body);
      assert.equal(
        serialized.includes("a private caption nobody may project"), false,
        "a Life Chapter that copies a caption is a second source of truth (§28.8)",
      );
      assert.equal(serialized.includes('"title"'), false, "no Memory title may ride on a compression node");
    } finally { await app.close(); }
  });

  it("builds cross-trip Life Chapters, which is what makes them chapters", async () => {
    const app = await startApp(baseState());
    try {
      const { body } = await get(app.baseUrl, "/api/memories/graph", "owner-tok");
      const chapters = body.graph.levels.LIFE_CHAPTER as any[];
      const placeChapter = chapters.find((c) => c.key === `place:${PLACE}`);
      assert.ok(placeChapter, `expected a recurring-place chapter, saw ${chapters.map((c) => c.key).join(",") || "none"}`);
      // m1 and m2 are on TRIP_A, m4 on TRIP_B — the chapter spans both.
      assert.deepEqual(placeChapter.memberMemoryIds.sort(), ["m1", "m2", "m4"]);
    } finally { await app.close(); }
  });

  it("chunks the companion read — PostgREST puts `.in()` in the URL, and 2000 uuids is not a URL", async () => {
    const state = baseState();
    state.memories = [];
    state.memory_tags = [];
    for (let i = 0; i < 450; i++) {
      const id = `g${String(i).padStart(4, "0")}`;
      state.memories.push(mem(id, { trip_id: TRIP_A, starts_at: `2024-03-01T10:00:0${i % 10}.000Z` }));
      state.memory_tags.push({ memory_id: id, tagged_user_id: FRIEND, status: "approved" });
    }
    inWidths.length = 0;
    const app = await startApp(state);
    try {
      const { status, body } = await get(app.baseUrl, "/api/memories/graph", "owner-tok");
      assert.equal(status, 200);
      assert.equal(body.graph.momentCount, 450);
      assert.ok(inWidths.length >= 3, `expected the 450 ids to be split, saw ${inWidths.length} batch(es)`);
      assert.ok(Math.max(...inWidths) <= 200, `no batch may exceed 200 ids, widest was ${Math.max(...inWidths)}`);
      assert.equal(inWidths.reduce((a, b) => a + b, 0), 450, "every id must still be asked about");
      // And the companions survive the chunking rather than only the first batch.
      const trip = body.graph.levels.TRIP.find((n: any) => n.key === TRIP_A);
      assert.equal(trip.memoryCount, 450);
      const chapter = body.graph.levels.LIFE_CHAPTER.find((c: any) => c.key === `person:${FRIEND}`);
      assert.equal(chapter, undefined, "450 moments on ONE trip is one trip, not a chapter");
    } finally { await app.close(); }
  });

  it("an unreadable memory_tags refuses rather than reporting a companion-free life", async () => {
    const app = await startApp(baseState(), new Set(["memory_tags"]));
    try {
      const { status, body } = await get(app.baseUrl, "/api/memories/graph", "owner-tok");
      assert.equal(status, 503);
      assert.equal(body?.error, "degraded_unavailable");
    } finally { await app.close(); }
  });

  it("reports how many moments were placed on RECORDED rather than occurrence time", async () => {
    const state = baseState();
    state.memories.push(mem("m5", { starts_at: null, created_at: "2024-05-05T05:00:00.000Z" }));
    const app = await startApp(state);
    try {
      const { body } = await get(app.baseUrl, "/api/memories/graph", "owner-tok");
      assert.equal(body.graph.momentsOnRecordedTime, 1);
      assert.equal(body.graph.momentCount, 5);
    } finally { await app.close(); }
  });
});

describe("H105 — complete, owner-scoped, privacy-filtered chapter projections", () => {
  function sharedState() {
    const state = baseState();
    state.memory_tags.find((tag) => tag.memory_id === "m4")!.status = "approved";
    return state;
  }

  async function expectUnavailable(state: FakeState, options: ReadOptions) {
    const app = await startApp(state, new Set(), options);
    try {
      const { status, body } = await get(app.baseUrl, "/api/memories/graph", "owner-tok");
      assert.equal(status, 503);
      assert.equal(body.error, "degraded_unavailable");
      assert.equal(body.graph, undefined);
    } finally { await app.close(); }
  }

  it("discloses a database cap below the 2000-memory application window", async () => {
    const app = await startApp(baseState(), new Set(), { caps: { memories: 2 } });
    try {
      const { status, body } = await get(app.baseUrl, "/api/memories/graph", "owner-tok");
      assert.equal(status, 200);
      assert.equal(body.graph.momentCount, 2);
      assert.equal(body.graph.truncated, true);
    } finally { await app.close(); }
  });

  it("does not label exactly 2000 complete memories as truncated", async () => {
    const state = baseState();
    state.memories = Array.from({ length: 2000 }, (_, index) => mem(`complete-${index}`, { trip_id: TRIP_A }));
    state.memory_tags = [];
    const app = await startApp(state);
    try {
      const { status, body } = await get(app.baseUrl, "/api/memories/graph", "owner-tok");
      assert.equal(status, 200);
      assert.equal(body.graph.momentCount, 2000);
      assert.equal(body.graph.truncated, false);
    } finally { await app.close(); }
  });

  it("refuses capped approved tags instead of silently losing a cross-trip person chapter", async () => {
    await expectUnavailable(sharedState(), { caps: { memory_tags: 2 } });
  });

  it("refuses capped block reads rather than treating unseen participants as unblocked", async () => {
    const state = sharedState();
    state.memory_tags.push({ memory_id: "m1", tagged_user_id: OTHER, status: "approved" });
    state.blocks = [{ blocker_id: OWNER, blocked_id: FRIEND }, { blocker_id: OWNER, blocked_id: OTHER }];
    await expectUnavailable(state, { caps: { blocks: 1 } });
  });

  it("serves a genuinely empty graph with complete counts", async () => {
    const state = baseState();
    state.memories = [];
    const app = await startApp(state);
    try {
      const { status, body } = await get(app.baseUrl, "/api/memories/graph", "owner-tok");
      assert.equal(status, 200);
      assert.equal(body.graph.momentCount, 0);
      assert.equal(body.graph.truncated, false);
      assert.deepEqual(body.graph.chapters, []);
    } finally { await app.close(); }
  });

  it("retains the bounded response when more than 2000 memories exist", async () => {
    const state = baseState();
    state.memories = Array.from({ length: 2001 }, (_, index) => mem(`bounded-${index}`));
    state.memory_tags = [];
    const app = await startApp(state);
    try {
      const { status, body } = await get(app.baseUrl, "/api/memories/graph", "owner-tok");
      assert.equal(status, 200);
      assert.equal(body.graph.momentCount, 2000);
      assert.equal(body.graph.truncated, true);
    } finally { await app.close(); }
  });

  for (const direction of ["outgoing", "incoming"] as const) {
    it(`withholds ${direction} blocked participants from every chapter key, id and label`, async () => {
      const state = sharedState();
      state.blocks = [direction === "outgoing"
        ? { blocker_id: OWNER, blocked_id: FRIEND }
        : { blocker_id: FRIEND, blocked_id: OWNER }];
      const app = await startApp(state);
      try {
        const { status, body } = await get(app.baseUrl, "/api/memories/graph", "owner-tok");
        assert.equal(status, 200);
        assert.equal(JSON.stringify(body).includes(FRIEND), false);
        assert.ok(body.graph.chapters.some((chapter: any) => chapter.key === `place:${PLACE}`));
      } finally { await app.close(); }
    });
  }

  for (const table of ["memories", "memory_tags", "blocks"]) {
    for (const data of [null, {}]) {
      it(`refuses ${table} ${data === null ? "null" : "non-array"} data instead of projecting empty history`, async () => {
        await expectUnavailable(sharedState(), { transform: (source, result) => source === table ? { ...result, data } : result });
      });
    }
    for (const count of [null, -1, 1.5, "3", Number.NaN]) {
      it(`refuses ${table} invalid exact count ${String(count)}`, async () => {
        await expectUnavailable(sharedState(), { transform: (source, result) => source === table ? { ...result, count } : result });
      });
    }
    it(`refuses a thrown ${table} read`, async () => {
      await expectUnavailable(sharedState(), { transform: (source, result) => {
        if (source === table) throw new Error("local read refused");
        return result;
      } });
    });
    it(`refuses ${table} counts smaller than the returned rows`, async () => {
      const state = sharedState();
      state.blocks = [{ blocker_id: OWNER, blocked_id: FRIEND }];
      await expectUnavailable(state, { transform: (source, result) => source === table && Array.isArray(result.data) && result.data.length > 0
        ? { ...result, count: result.data.length - 1 } : result });
    });
  }

  const invalidRows: Array<{ name: string; table: string; alter: (rows: any[]) => any[] }> = [
    { name: "wrong-owner Memory", table: "memories", alter: (rows) => rows.map((row, index) => index === 0 ? { ...row, owner_id: OTHER } : row) },
    { name: "duplicate Memory", table: "memories", alter: (rows) => [rows[0], rows[0], ...rows.slice(2)] },
    { name: "malformed Memory", table: "memories", alter: (rows) => [null, ...rows.slice(1)] },
    { name: "deleted Memory returned by active query", table: "memories", alter: (rows) => rows.map((row, index) => index === 0 ? { ...row, state: "deleted" } : row) },
    { name: "invalid occurrence date", table: "memories", alter: (rows) => rows.map((row, index) => index === 0 ? { ...row, starts_at: "not-a-date" } : row) },
    { name: "out-of-scope tag", table: "memory_tags", alter: (rows) => rows.map((row, index) => index === 0 ? { ...row, memory_id: "m9" } : row) },
    { name: "withdrawn tag returned by approved query", table: "memory_tags", alter: (rows) => rows.map((row, index) => index === 0 ? { ...row, status: "removed" } : row) },
    { name: "malformed participant", table: "memory_tags", alter: (rows) => rows.map((row, index) => index === 0 ? { ...row, tagged_user_id: null } : row) },
    { name: "duplicate participant row", table: "memory_tags", alter: (rows) => [rows[0], rows[0], ...rows.slice(2)] },
    { name: "out-of-scope block", table: "blocks", alter: () => [{ blocker_id: OTHER, blocked_id: FRIEND }] },
  ];
  for (const fault of invalidRows) {
    it(`refuses ${fault.name}`, async () => {
      await expectUnavailable(sharedState(), { transform: (table, result) => {
        if (table !== fault.table) return result;
        const data = fault.alter(result.data as any[]);
        return { ...result, data, count: data.length };
      } });
    });
  }

  it("refuses an unreadable block relation rather than disclosing a participant", async () => {
    const app = await startApp(sharedState(), new Set(["blocks"]));
    try {
      const { status, body } = await get(app.baseUrl, "/api/memories/graph", "owner-tok");
      assert.equal(status, 503);
      assert.equal(body.graph, undefined);
    } finally { await app.close(); }
  });

  it("refuses a later companion chunk failure, not a graph over earlier chunks", async () => {
    const state = baseState();
    state.memories = Array.from({ length: 201 }, (_, index) => mem(`chunk-${index}`, { trip_id: TRIP_A }));
    state.memory_tags = [];
    await expectUnavailable(state, { transform: (table, result, occurrence) => table === "memory_tags" && occurrence === 2
      ? { data: null, count: null, error: { message: "later chunk unavailable" } } : result });
  });

  for (const restriction of ["blocked", "withdrawn", "unapproved"] as const) {
    it(`graph cutover cannot reintroduce ${restriction} companions through graph edges`, async () => {
      const state = sharedState();
      state.feature_flags = [{ flag: "memory_graph_read_cutover_enabled", enabled: true }];
      const now = new Date();
      state.memory_graph_shadow_daily = Array.from({ length: 7 }, (_, index) => ({
        surface: "memories_graph", compared: 100, mismatched: 0, graph_read_failures: 0,
        day: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - index - 1)).toISOString().slice(0, 10),
      }));
      state.memory_entity_links = ["m1", "m4"].flatMap((memoryId, index) => [
        { memory_id: memoryId, owner_id: OWNER, entity_type: "TRIP", entity_id: index === 0 ? TRIP_A : TRIP_B, relation_type: "RELATED" },
        { memory_id: memoryId, owner_id: OWNER, entity_type: "PERSON", entity_id: FRIEND, relation_type: "RELATED" },
      ]);
      if (restriction === "blocked") state.blocks = [{ blocker_id: FRIEND, blocked_id: OWNER }];
      else state.memory_tags.forEach((tag) => { tag.status = restriction === "withdrawn" ? "removed" : "pending"; });
      const app = await startApp(state);
      try {
        const { status, body } = await get(app.baseUrl, "/api/memories/graph", "owner-tok");
        assert.equal(status, 200);
        assert.equal(body.graph.linkSource, "graph");
        assert.equal(JSON.stringify(body).includes(FRIEND), false);
      } finally { await app.close(); }
    });
  }

  for (const deletion of ["soft", "hard"] as const) {
    it(`rebuilds chapter membership after ${deletion} deletion without persisting duplicated content`, async () => {
      const state = sharedState();
      state.memory_items = [{ memory_id: "m4", media_url: "https://private.invalid/never-copy.jpg", caption: "private photo words" }];
      const app = await startApp(state);
      try {
        const before = structuredClone(state);
        const first = await get(app.baseUrl, "/api/memories/graph", "owner-tok");
        assert.ok(first.body.graph.levels.LIFE_CHAPTER.some((chapter: any) => chapter.memberMemoryIds.includes("m4")));
        assert.deepEqual(state, before, "a projection must not write a canonical or derived copy");
        if (deletion === "soft") state.memories.find((row) => row.id === "m4")!.state = "deleted";
        else state.memories = state.memories.filter((row) => row.id !== "m4");
        const afterDelete = structuredClone(state);
        const rebuilt = await get(app.baseUrl, "/api/memories/graph", "owner-tok");
        assert.equal(rebuilt.status, 200);
        assert.deepEqual(rebuilt.body.graph.levels.LIFE_CHAPTER, []);
        assert.equal(JSON.stringify(rebuilt.body).includes('"m4"'), false);
        assert.deepEqual(state, afterDelete);
      } finally { await app.close(); }
    });
  }

  it("rebuilds after consent withdrawal and after a block without cached person membership", async () => {
    const state = sharedState();
    const app = await startApp(state);
    try {
      const first = await get(app.baseUrl, "/api/memories/graph", "owner-tok");
      assert.ok(JSON.stringify(first.body).includes(`person:${FRIEND}`));
      state.memory_tags.find((tag) => tag.memory_id === "m4")!.status = "removed";
      const withdrawn = await get(app.baseUrl, "/api/memories/graph", "owner-tok");
      assert.equal(JSON.stringify(withdrawn.body).includes(FRIEND), false);
      state.memory_tags.find((tag) => tag.memory_id === "m4")!.status = "approved";
      state.blocks = [{ blocker_id: FRIEND, blocked_id: OWNER }];
      const blocked = await get(app.baseUrl, "/api/memories/graph", "owner-tok");
      assert.equal(JSON.stringify(blocked.body).includes(FRIEND), false);
    } finally { await app.close(); }
  });

  it("keeps the owner and no-content contract on the wire, regardless of query impersonation", async () => {
    const state = sharedState();
    const calls: ReadCall[] = [];
    const before = structuredClone(state);
    const app = await startApp(state, new Set(), { calls });
    try {
      const own = await get(app.baseUrl, `/api/memories/graph?userId=${OTHER}`, "owner-tok");
      assert.equal(own.status, 200);
      assert.equal(own.cacheControl, "private, no-store");
      assert.equal(own.body.graph.momentCount, 4);
      for (const chapter of own.body.graph.levels.LIFE_CHAPTER) {
        assert.deepEqual(Object.keys(chapter).sort(), ["childNodeIds", "endedAt", "id", "key", "level", "memberMemoryIds", "memoryCount", "startedAt"]);
      }
      for (const chapter of own.body.graph.chapters) assert.deepEqual(Object.keys(chapter).sort(), ["id", "key", "label", "memoryCount"]);
      assert.doesNotMatch(JSON.stringify(own.body), /private caption|media_url|caption|"title"/);
      const other = await get(app.baseUrl, `/api/memories/graph?userId=${OWNER}`, "other-tok");
      assert.equal(other.body.graph.momentCount, 1);
      assert.deepEqual(other.body.graph.chapters, []);
      assert.deepEqual(state, before);
      for (const read of calls.filter((read) => ["memories", "memory_tags", "blocks"].includes(read.table))) {
        assert.equal(read.count, "exact");
        assert.doesNotMatch(read.columns, /title|caption|media_url/);
      }
    } finally { await app.close(); }
  });
});

describe("deriveChapterThemes — §13 themes from structure alone", () => {
  const moment = (id: string, over: Partial<GraphMoment> = {}): GraphMoment => ({
    memory_id: id, owner_id: OWNER, occurred_at: "2024-03-01T10:00:00.000Z",
    utc_offset_minutes: 0, episode_id: null, trip_id: null, place_id: null,
    people: [], significance_score: null, ...over,
  });

  it("needs a repeat across DIFFERENT trips — one trip is a trip, not a chapter", () => {
    const sameTrip = [
      moment("a", { place_id: PLACE, trip_id: TRIP_A }),
      moment("b", { place_id: PLACE, trip_id: TRIP_A }),
      moment("c", { place_id: PLACE, trip_id: TRIP_A }),
    ];
    assert.deepEqual(deriveChapterThemes(sameTrip).map((t) => t.key), []);
    const twoTrips = [
      moment("a", { place_id: PLACE, trip_id: TRIP_A }),
      moment("b", { place_id: PLACE, trip_id: TRIP_B }),
    ];
    assert.deepEqual(deriveChapterThemes(twoTrips).map((t) => t.key), [`place:${PLACE}`]);
  });

  it("is deterministic in key order and produces no chapter from an empty set", () => {
    assert.deepEqual(deriveChapterThemes([]), []);
    const ms = [
      moment("a", { place_id: "z", trip_id: TRIP_A, people: [FRIEND] }),
      moment("b", { place_id: "z", trip_id: TRIP_B, people: [FRIEND] }),
    ];
    const keys = deriveChapterThemes(ms).map((t) => t.key);
    assert.deepEqual(keys, [...keys].sort(), "themes must come back in sorted key order");
    assert.deepEqual(keys, [`person:${FRIEND}`, "place:z"]);
  });

  it("a chapter's label is fixed by the theme and carries no user prose", () => {
    const ms = [
      moment("a", { place_id: "z", trip_id: TRIP_A }),
      moment("b", { place_id: "z", trip_id: TRIP_B }),
    ];
    const chapters = buildLifeChapters(ms, deriveChapterThemes(ms));
    assert.equal(chapters.length, 1);
    assert.deepEqual(Object.keys(chapters[0]).sort(), [
      "child_node_ids", "ended_at", "engine_version", "id", "key", "level",
      "member_memory_ids", "memory_count", "owner_id", "started_at",
    ].sort());
    assert.equal(chapters[0].key, "place:z");
  });
});
