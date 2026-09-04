/**
 * ContextThreadService — the §9 eligibility gate, candidate selection, and the
 * canonical readers' disclosure / authorization behavior (spec §8/§9/§20/§23).
 *
 * The gate returns false BY DEFAULT and every one of its eight conditions must
 * hold; these tests prove each condition independently flips a passing input to
 * false, that a protected Hidden Gem is suppressed for an unauthorized viewer,
 * that "people you follow were here" needs a k-anonymity floor, and that a live
 * fact already in the strip is de-duplicated.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  shouldAttachContextThread,
  selectContextThread,
  buildContextThread,
  DEFAULT_CONTEXT_THREAD_POLICY,
  _internal,
  type ContextThreadGateInput,
  type ContextThreadCandidate,
  type ContextThreadViewerContext,
} from "../services/wall/ContextThreadService.js";
import type { WallProjection } from "../lib/wallProjection.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PASS: ContextThreadGateInput = {
  viewerAuthorized: true,
  contextRelevant: true,
  confidence: 0.8,
  freshnessAgeMs: 60_000,
  sensitiveDisclosure: false,
  duplicatesLiveStrip: false,
  visualOverload: false,
  expectedUtility: 0.7,
};

function projectionWithPlace(placeId = "place-1", city = "Bangkok"): WallProjection {
  return {
    projectionId: "wall_social_post_p1",
    objectType: "social_post",
    canonicalObjectId: "p1",
    publishedAt: "2026-09-01T00:00:00.000Z",
    visibility: "public",
    actions: [],
    place: { placeId, name: "An Thuong", city, country: "TH" },
  };
}

/**
 * The columns `hidden_gems` actually has in the live schema, for the names this
 * suite's readers put in a select list. Verified against project
 * hwokxgbmezheskbzskfr on 2026-09-03.
 *
 * This list exists because the fixtures below used to hand the fake rows
 * carrying `confirmation_count` and `days_since_last_confirmation` — two
 * columns that have never existed. The fake ignored the select list, so the
 * tests were green while the production read failed with PGRST100 on every
 * call and the whole hidden-gem branch returned null. Pass this to
 * `columnsByTable` and the fake rejects an unknown column the way PostgREST
 * does, which is what makes that class of fiction fail here instead of in
 * production.
 */
const LIVE_HIDDEN_GEM_COLUMNS = [
  "id",
  "sensitivity_level",
  "verification_level",
  "status",
  "crowd_level",
  "save_count",
  "visit_count",
  "updated_at",
  "canonical_place_id",
  "latitude",
  "longitude",
  "approx_latitude",
  "approx_longitude",
  "image_url",
] as const;

/** Minimal per-table fake: awaiting a builder resolves to { data, error }, and
 *  maybeSingle resolves to the first row. Filters are captured but not applied
 *  (each reader queries one table with a fixed shape, so returning the configured
 *  rows is sufficient).
 *
 *  `columnsByTable` opts a table into select-list validation: any name in the
 *  select that the table does not have fails the WHOLE query with PGRST100,
 *  which is PostgREST's real behaviour and the one this fake used to lack.
 *  Only plain comma-separated column lists are parsed — no embedded-resource
 *  syntax — which is all any reader in this service uses. */
function tableClient(
  rowsByTable: Record<string, any[]>,
  opts: { errorTables?: string[]; columnsByTable?: Record<string, readonly string[]> } = {},
) {
  const errorTables = new Set(opts.errorTables ?? []);
  const columnsByTable = opts.columnsByTable ?? {};
  function builder(table: string) {
    let unknownColumn: string | null = null;
    const b: any = {
      select: (list?: string) => {
        const known = columnsByTable[table];
        if (known && typeof list === "string") {
          for (const raw of list.split(",")) {
            const name = raw.trim();
            if (name && name !== "*" && !known.includes(name)) {
              unknownColumn = name;
              break;
            }
          }
        }
        return b;
      },
      eq: () => b,
      in: () => b,
      gte: () => b,
      lte: () => b,
      gt: () => b,
      order: () => b,
      limit: () => b,
      maybeSingle: () =>
        unknownColumn
          ? Promise.resolve({ data: null, error: pgrst100(table, unknownColumn) })
          : errorTables.has(table)
            ? Promise.resolve({ data: null, error: { message: "boom" } })
            : Promise.resolve({ data: (rowsByTable[table] ?? [])[0] ?? null, error: null }),
      then: (onF: any, onR: any) => {
        const res = unknownColumn
          ? { data: null, error: pgrst100(table, unknownColumn) }
          : errorTables.has(table)
            ? { data: null, error: { message: "boom" } }
            : { data: rowsByTable[table] ?? [], error: null };
        return Promise.resolve(res).then(onF, onR);
      },
    };
    return b;
  }
  return { from: builder };
}

function pgrst100(table: string, column: string) {
  return {
    code: "PGRST100",
    message: `column ${table}.${column} does not exist`,
  };
}

const VIEWER: ContextThreadViewerContext = { viewerId: "viewer-1", now: new Date("2026-09-01T12:00:00.000Z") };

// ── The §9 gate ────────────────────────────────────────────────────────────────

describe("shouldAttachContextThread — the §9 eligibility gate", () => {
  it("returns true only when every condition holds", () => {
    assert.equal(shouldAttachContextThread(PASS), true);
  });

  it("defaults to false — each condition independently suppresses the thread", () => {
    const flips: Array<Partial<ContextThreadGateInput>> = [
      { viewerAuthorized: false },
      { contextRelevant: false },
      { confidence: DEFAULT_CONTEXT_THREAD_POLICY.minConfidence - 0.01 },
      { freshnessAgeMs: DEFAULT_CONTEXT_THREAD_POLICY.maxAgeMs + 1 },
      { sensitiveDisclosure: true },
      { duplicatesLiveStrip: true },
      { visualOverload: true },
      { expectedUtility: DEFAULT_CONTEXT_THREAD_POLICY.minUtility - 0.01 },
    ];
    for (const flip of flips) {
      assert.equal(
        shouldAttachContextThread({ ...PASS, ...flip }),
        false,
        `expected false when ${JSON.stringify(flip)}`,
      );
    }
  });

  it("honors the boundary values (>= and <=)", () => {
    assert.equal(
      shouldAttachContextThread({
        ...PASS,
        confidence: DEFAULT_CONTEXT_THREAD_POLICY.minConfidence,
        freshnessAgeMs: DEFAULT_CONTEXT_THREAD_POLICY.maxAgeMs,
        expectedUtility: DEFAULT_CONTEXT_THREAD_POLICY.minUtility,
      }),
      true,
    );
  });
});

// ── Selection ───────────────────────────────────────────────────────────────

function candidate(kind: any, expectedUtility: number, gateOver: Partial<ContextThreadGateInput> = {}): ContextThreadCandidate {
  return {
    thread: { kind, label: `${kind} thread`, confidence: 0.8 },
    gate: { ...PASS, expectedUtility, ...gateOver },
  };
}

describe("selectContextThread — at most one, highest utility", () => {
  it("returns undefined with no candidates", () => {
    assert.equal(selectContextThread([]), undefined);
  });

  it("picks the highest expected-utility survivor", () => {
    const chosen = selectContextThread([
      candidate("live_place", 0.6),
      candidate("trip_relevance", 0.85),
      candidate("hidden_gem", 0.55),
    ]);
    assert.equal(chosen?.kind, "trip_relevance");
  });

  it("suppresses a candidate that fails the gate (sensitive disclosure)", () => {
    const chosen = selectContextThread([
      candidate("hidden_gem", 0.9, { sensitiveDisclosure: true, viewerAuthorized: false }),
      candidate("live_place", 0.6),
    ]);
    assert.equal(chosen?.kind, "live_place", "the protected gem is dropped, the live fact wins");
  });

  it("windowSaturated suppresses ALL candidates (spec §15 visualOverload)", () => {
    const chosen = selectContextThread([candidate("live_place", 0.9)], DEFAULT_CONTEXT_THREAD_POLICY, {
      windowSaturated: true,
    });
    assert.equal(chosen, undefined);
  });

  it("de-duplicates a live fact already in the strip", () => {
    const chosen = selectContextThread([candidate("live_place", 0.9, { duplicatesLiveStrip: true })]);
    assert.equal(chosen, undefined);
  });
});

// ── Canonical readers ─────────────────────────────────────────────────────────

describe("readHiddenGemCandidate — disclosure policy (spec §20)", () => {
  it("a public gem yields a non-sensitive, authorized candidate", async () => {
    const sc = tableClient(
      {
        hidden_gems: [
          {
            id: "g1",
            sensitivity_level: "public",
            verification_level: "community",
            status: "active",
            crowd_level: "low",
            save_count: 2,
            visit_count: 4,
            canonical_place_id: "place-1",
            updated_at: "2026-09-01T09:00:00.000Z",
          },
        ],
      },
      { columnsByTable: { hidden_gems: LIVE_HIDDEN_GEM_COLUMNS } },
    );
    const cand = await _internal.readHiddenGemCandidate(sc, projectionWithPlace(), VIEWER);
    assert.ok(cand);
    assert.equal(cand!.thread.kind, "hidden_gem");
    assert.equal(cand!.gate.sensitiveDisclosure, false);
    assert.equal(cand!.gate.viewerAuthorized, true);
  });

  it("a protected gem is marked sensitive + unauthorized (so the gate suppresses it)", async () => {
    const sc = tableClient(
      {
        hidden_gems: [
          {
            id: "g2",
            sensitivity_level: "protected",
            verification_level: "guide",
            status: "active",
            crowd_level: "low",
            save_count: 1,
            visit_count: 3,
            canonical_place_id: "place-1",
            updated_at: "2026-09-01T09:00:00.000Z",
          },
        ],
      },
      { columnsByTable: { hidden_gems: LIVE_HIDDEN_GEM_COLUMNS } },
    );
    const cand = await _internal.readHiddenGemCandidate(sc, projectionWithPlace(), VIEWER);
    assert.ok(cand);
    assert.equal(cand!.gate.sensitiveDisclosure, true);
    assert.equal(cand!.gate.viewerAuthorized, false);
    // And the gate refuses it.
    assert.equal(shouldAttachContextThread(cand!.gate), false);
  });

  it("names only columns hidden_gems actually has — an invented one kills the whole read", async () => {
    // The guard, stated as a test rather than left to a CI script: this fake
    // answers a select naming an unknown column exactly as PostgREST does, so a
    // reader that reaches for a column the live schema lacks produces NO
    // candidate here. Before 2026-09-03 the select carried confirmation_count
    // and days_since_last_confirmation; both are absent from hidden_gems, so
    // this reader returned null on every call in production while these tests
    // stayed green.
    const row = {
      id: "g3",
      sensitivity_level: "public",
      verification_level: "community",
      status: "active",
      crowd_level: "low",
      save_count: 0,
      visit_count: 0,
      canonical_place_id: "place-1",
      updated_at: "2026-09-01T09:00:00.000Z",
    };
    const strict = tableClient(
      { hidden_gems: [row] },
      { columnsByTable: { hidden_gems: LIVE_HIDDEN_GEM_COLUMNS } },
    );
    const cand = await _internal.readHiddenGemCandidate(strict, projectionWithPlace(), VIEWER);
    assert.ok(
      cand,
      "the gem select named a column hidden_gems does not have; PostgREST fails the whole read with PGRST100 and this branch can never produce a candidate",
    );

    // And the fake really does reject — otherwise the assertion above proves
    // nothing. Same row, same reader, one invented column in the allowed set's
    // place.
    const withoutInvented = LIVE_HIDDEN_GEM_COLUMNS.filter((c) => c !== "crowd_level");
    const rejecting = tableClient(
      { hidden_gems: [row] },
      { columnsByTable: { hidden_gems: withoutInvented } },
    );
    assert.equal(
      await _internal.readHiddenGemCandidate(rejecting, projectionWithPlace(), VIEWER),
      null,
      "the fake must fail a select that names an unknown column, or the assertion above is vacuous",
    );
  });

  it("returns null (fail-soft) when the gem read errors", async () => {
    const sc = tableClient({}, { errorTables: ["hidden_gems"] });
    const cand = await _internal.readHiddenGemCandidate(sc, projectionWithPlace(), VIEWER);
    assert.equal(cand, null);
  });
});

describe("readTripRelevanceCandidate — the viewer's own trip", () => {
  it("builds a Save-to-Trip thread for a matching upcoming trip", async () => {
    const sc = tableClient({
      trips: [
        { id: "trip-9", destination_city: "Bangkok", destination_country: "TH", start_date: "2026-09-13", status: "upcoming" },
      ],
    });
    const cand = await _internal.readTripRelevanceCandidate(sc, projectionWithPlace("place-1", "Bangkok"), VIEWER);
    assert.ok(cand);
    assert.equal(cand!.thread.kind, "trip_relevance");
    assert.equal(cand!.thread.action?.type, "add_to_trip");
    assert.equal(cand!.thread.action?.targetId, "trip-9");
    assert.match(cand!.thread.label, /going to Bangkok in 12 days/);
    assert.equal(shouldAttachContextThread(cand!.gate), true);
  });

  it("no candidate when no trip matches the place city", async () => {
    const sc = tableClient({
      trips: [{ id: "t", destination_city: "Tokyo", start_date: "2026-09-13", status: "upcoming" }],
    });
    const cand = await _internal.readTripRelevanceCandidate(sc, projectionWithPlace("place-1", "Bangkok"), VIEWER);
    assert.equal(cand, null);
  });
});

describe("readSocialPresenceCandidate — k-anonymity floor, public-content only", () => {
  const viewerWithFollows: ContextThreadViewerContext = {
    ...VIEWER,
    followedCreatorIds: new Set(["f1", "f2", "f3"]),
  };

  it("surfaces 'N people you follow were here' at/above the floor", async () => {
    const sc = tableClient({
      posts: [
        { author_id: "f1", created_at: "2026-08-30T00:00:00.000Z" },
        { author_id: "f2", created_at: "2026-08-31T00:00:00.000Z" },
        { author_id: "f2", created_at: "2026-08-29T00:00:00.000Z" }, // duplicate author
      ],
    });
    const cand = await _internal.readSocialPresenceCandidate(sc, projectionWithPlace(), viewerWithFollows);
    assert.ok(cand);
    assert.equal(cand!.thread.kind, "social_presence");
    assert.match(cand!.thread.label, /2 people you follow were here/);
    assert.equal(cand!.thread.action?.type, "see_who");
  });

  it("suppressed below the k-anonymity floor (a single person's movement)", async () => {
    const sc = tableClient({ posts: [{ author_id: "f1", created_at: "2026-08-31T00:00:00.000Z" }] });
    const cand = await _internal.readSocialPresenceCandidate(sc, projectionWithPlace(), viewerWithFollows);
    assert.equal(cand, null);
  });

  it("no candidate when the viewer follows nobody", async () => {
    const sc = tableClient({ posts: [] });
    const cand = await _internal.readSocialPresenceCandidate(sc, projectionWithPlace(), VIEWER);
    assert.equal(cand, null);
  });

  it("counts only PUBLISHED public posts — a pending delayed-geotag post must not reveal presence (D1)", async () => {
    // A delayed_until_exit post is status='active' with post_status pending so
    // the author's presence at the place stays hidden until they have left.
    // The presence count must carry the delayed-publish predicate on the query.
    const eqs: Record<string, any> = {};
    const sc: any = {
      from() {
        const b: any = {
          select: () => b,
          eq: (c: string, v: any) => { eqs[c] = v; return b; },
          in: () => b, gte: () => b, lte: () => b, gt: () => b, order: () => b, limit: () => b,
          then: (onF: any, onR: any) =>
            Promise.resolve({
              data: [
                { author_id: "f1", created_at: "2026-08-30T00:00:00.000Z" },
                { author_id: "f2", created_at: "2026-08-31T00:00:00.000Z" },
              ],
              error: null,
            }).then(onF, onR),
        };
        return b;
      },
    };
    await _internal.readSocialPresenceCandidate(sc, projectionWithPlace(), viewerWithFollows);
    assert.equal(eqs.visibility, "public");
    assert.equal(eqs.status, "active");
    assert.equal(eqs.post_status, "published", "presence is built from published posts only");
  });
});

// ── Orchestrator flag gate ────────────────────────────────────────────────────

describe("buildContextThread — behind wall_context_threads_enabled", () => {
  function flagClient(enabled: boolean, extra: Record<string, any[]> = {}) {
    return tableClient({ feature_flags: [{ enabled }], ...extra });
  }

  it("returns undefined when the flag is OFF (fail-closed)", async () => {
    const sc = flagClient(false, { trips: [{ id: "t", destination_city: "Bangkok", start_date: "2026-09-13", status: "upcoming" }] });
    const out = await buildContextThread(sc, projectionWithPlace("place-1", "Bangkok"), VIEWER);
    assert.equal(out, undefined);
  });

  it("returns undefined for an object with no place before any read", async () => {
    const sc = flagClient(true);
    const noPlace: WallProjection = { ...projectionWithPlace(), place: undefined };
    const out = await buildContextThread(sc, noPlace, VIEWER);
    assert.equal(out, undefined);
  });
});

// ── map / memory / compass bridge producers (spec §8/§21/§22/§24) ────────────

describe("map Context Thread (spec §22)", () => {
  it("offers a map bridge only when the place is in the viewer's current city", async () => {
    const inCity: ContextThreadViewerContext = { viewerId: "viewer-1", currentCity: "Bangkok", now: VIEWER.now };
    const cand = await _internal.readMapCandidate(tableClient({}), projectionWithPlace("place-1", "Bangkok"), inCity);
    assert.ok(cand, "a place in the viewer's city earns a map bridge");
    assert.equal(cand!.thread.kind, "map");
    assert.equal(cand!.thread.action?.type, "open_map");
  });

  it("no map bridge when the place is in a different city (spatial frame not relevant)", async () => {
    const elsewhere: ContextThreadViewerContext = { viewerId: "viewer-1", currentCity: "Tokyo", now: VIEWER.now };
    assert.equal(await _internal.readMapCandidate(tableClient({}), projectionWithPlace("place-1", "Bangkok"), elsewhere), null);
  });

  it("no map bridge when the viewer has no current city", async () => {
    assert.equal(await _internal.readMapCandidate(tableClient({}), projectionWithPlace("place-1", "Bangkok"), VIEWER), null);
  });
});

describe("memory Context Thread (spec §8/§24 — Memory as a canonical input)", () => {
  it("surfaces 'you've been here' from the viewer's OWN passport_memories for the place", async () => {
    const sc = tableClient({ passport_memories: [{ id: "mem-1", title: "Sunset here", earned_at: "2026-06-01T00:00:00Z", created_at: "2026-06-01T00:00:00Z" }] });
    const cand = await _internal.readMemoryCandidate(sc, projectionWithPlace("place-1"), VIEWER);
    assert.ok(cand, "an existing memory for this place earns a memory thread");
    assert.equal(cand!.thread.kind, "memory");
    assert.equal(cand!.thread.action?.type, "open_object");
    assert.equal(cand!.thread.action?.targetType, "memory");
    assert.equal(cand!.thread.action?.targetId, "mem-1");
  });

  it("no memory thread when the viewer has no memory at the place", async () => {
    assert.equal(await _internal.readMemoryCandidate(tableClient({ passport_memories: [] }), projectionWithPlace("place-1"), VIEWER), null);
  });

  it("fail-soft: a memory read error yields no candidate, never throws", async () => {
    const sc = tableClient({ passport_memories: [{ id: "mem-1" }] }, { errorTables: ["passport_memories"] });
    assert.equal(await _internal.readMemoryCandidate(sc, projectionWithPlace("place-1"), VIEWER), null);
  });
});

describe("compass Context Thread (spec §21 — opt-in per object)", () => {
  it("offers Ask Compass only when the handoff flag is on", async () => {
    const on: ContextThreadViewerContext = { viewerId: "viewer-1", compassHandoffEnabled: true, now: VIEWER.now };
    const cand = await _internal.readCompassCandidate(tableClient({}), projectionWithPlace("place-1"), on);
    assert.ok(cand, "the flag on + a real place earns a compass bridge");
    assert.equal(cand!.thread.kind, "compass");
    assert.equal(cand!.thread.action?.type, "ask_compass");
  });

  it("no compass thread when the handoff flag is off (Compass is never a permanent panel)", async () => {
    assert.equal(await _internal.readCompassCandidate(tableClient({}), projectionWithPlace("place-1"), VIEWER), null);
  });
});

describe("selection priority — the new bridges never outrank a live/social fact", () => {
  it("a live_place fact beats a memory bridge for the single slot", () => {
    const memory: ContextThreadCandidate = {
      thread: { kind: "memory", label: "You've been here before" },
      gate: { ...PASS, expectedUtility: 0.65 },
    };
    const live: ContextThreadCandidate = {
      thread: { kind: "live_place", label: "Busy right now" },
      gate: { ...PASS, expectedUtility: 0.85 },
    };
    const chosen = selectContextThread([memory, live]);
    assert.equal(chosen?.kind, "live_place", "the higher-utility live fact wins the compact slot");
  });

  it("a compass bridge is the lowest-priority survivor (loses a tie on kind priority)", () => {
    const compass: ContextThreadCandidate = {
      thread: { kind: "compass", label: "Ask Compass" },
      gate: { ...PASS, expectedUtility: 0.6 },
    };
    const map: ContextThreadCandidate = {
      thread: { kind: "map", label: "See it on the map" },
      gate: { ...PASS, expectedUtility: 0.6 },
    };
    assert.equal(selectContextThread([compass, map])?.kind, "map", "map outranks compass on a utility tie");
  });
});
