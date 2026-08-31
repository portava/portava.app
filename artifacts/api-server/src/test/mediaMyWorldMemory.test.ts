/**
 * mediaMyWorldMemory — Media v2 Phase 9 (My World + Memory) backend (§30/§31/§31.1).
 *
 * Proves, with fake Supabase clients only (no DB, no network, no HTTP listen for
 * the service tests; a loopback Express server for the route session-identity
 * proof), that the My World memory integration:
 *
 *   1. DERIVES the §31 groupings from the Memory system + gem/media signals for
 *      the OWNER (memory_remembers_for_user for the derived-memory core; gem /
 *      post_saves / trip-crew / outcome tables for the source signals).
 *   2. Is OWNER-ONLY + SESSION-SCOPED: a viewer only ever sees their OWN My World.
 *      MUTATION-PROOF: the route reads the SESSION id and ignores `?user_id=`; a
 *      route that honoured the query param would surface the other user's memory
 *      and the "session identity only" assertion goes RED.
 *   3. REUSES the §12 allow/deny boundary: a forgotten/suppressed memory and a
 *      non-active/sensitive derived memory do NOT surface.
 *      MUTATION-PROOF: removing the memory_feedback 'forget' row (bypassing the
 *      suppression the code reuses) makes the same entry appear — so the
 *      "suppressed memory hidden" assertion is load-bearing, not vacuous.
 *   4. Derives the §31.1 Hidden Gem Memory lines from real gem signals.
 *   5. Exposes the §30 buckets with correct counts.
 *   6. Empty data ⇒ a well-formed empty memory surface (never throws).
 *
 * Run:
 *   node --import tsx/esm --test src/test/mediaMyWorldMemory.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express, { type Express } from "express";

import {
  buildMyWorldMemory,
  type MyWorldMemory,
  type MyWorldMemoryGroup,
} from "../services/media/MyWorldMemoryService.js";
import {
  resolveViewer,
  buildMyWorldProjection,
} from "../services/media/MediaProjectionService.js";
import { isLocationSafe } from "../lib/media/mediaLocationSafety.js";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";

// ── Identities ───────────────────────────────────────────────────────────────
const ALICE = "11111111-1111-1111-1111-111111111111";
const MALLORY = "99999999-9999-9999-9999-999999999999";
const OTHER = "22222222-2222-2222-2222-222222222222";
const GEM_1 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const GEM_2 = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const TRIP_1 = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const POST_1 = "dddddddd-dddd-dddd-dddd-dddddddddddd";

function iso(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
}

// ── A capable fake Supabase client (rpc + filtered table reads) ───────────────
interface Seed {
  derived?: any[]; // rows memory_remembers_for_user returns (already §12-shaped)
  feedback?: any[]; // memory_feedback rows (suppressions)
  hidden_gems?: any[];
  hidden_gem_visits?: any[];
  hidden_gem_contributions?: any[];
  hidden_gem_verifications?: any[];
  post_saves?: any[];
  posts?: any[];
  trip_members?: any[];
  trips?: any[];
  compass_outcome_events?: any[];
  passport_postcards?: any[];
  memories?: any[];
  media_assets?: any[];
  profiles?: any[];
  rpcCalls?: Array<{ name: string; params: any }>;
}

function makeSc(seed: Seed) {
  seed.rpcCalls = seed.rpcCalls ?? [];
  const tableData = (t: string): any[] => {
    const key = t === "memory_feedback" ? "feedback" : t;
    return (seed as any)[key] ?? [];
  };

  const resolveRows = (table: string, filters: any[]): any[] => {
    let rows = tableData(table).map((r) => ({ ...r }));
    for (const f of filters) {
      if (f.op === "eq") rows = rows.filter((r) => String(r[f.col]) === String(f.val));
      else if (f.op === "in") rows = rows.filter((r) => (f.val as any[]).map(String).includes(String(r[f.col])));
      else if (f.op === "ilike") {
        const needle = String(f.val).replace(/%/g, "").toLowerCase();
        rows = rows.filter((r) => String(r[f.col] ?? "").toLowerCase().includes(needle));
      }
    }
    return rows;
  };

  const builder = (table: string): any => {
    const filters: any[] = [];
    const b: any = {
      select() { return b; },
      eq(col: string, val: any) { filters.push({ op: "eq", col, val }); return b; },
      in(col: string, val: any) { filters.push({ op: "in", col, val }); return b; },
      ilike(col: string, val: any) { filters.push({ op: "ilike", col, val }); return b; },
      not() { return b; },
      or() { return b; },
      order() { return b; },
      limit() { return b; },
      range() { return b; },
      maybeSingle() { return Promise.resolve({ data: resolveRows(table, filters)[0] ?? null, error: null }); },
      single() { return Promise.resolve({ data: resolveRows(table, filters)[0] ?? null, error: null }); },
      then(onF: any, onR: any) {
        return Promise.resolve({ data: resolveRows(table, filters), error: null }).then(onF, onR);
      },
    };
    return b;
  };

  return {
    auth: {
      getUser: async (token: string) => {
        const map: Record<string, string> = { "alice-token": ALICE };
        const id = map[token] ?? null;
        return id
          ? { data: { user: { id } }, error: null }
          : { data: { user: null }, error: { message: "not authed" } };
      },
    },
    rpc: async (name: string, params: any) => {
      seed.rpcCalls!.push({ name, params });
      if (name === "memory_remembers_for_user") {
        const uid = params?.p_user_id;
        // Fake the §12 core: only return this user's rows (subject to their id).
        return { data: (seed.derived ?? []).filter((r) => (r.__owner ?? ALICE) === uid), error: null };
      }
      return { data: null, error: null };
    },
    from(table: string) {
      // memory_feedback is read by loadSuppressions with .eq(user_id).
      return builder(table);
    },
  } as any;
}

// A derived row exactly as memory_remembers_for_user returns it (2213 shape).
function derivedRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    __owner: ALICE, // test-only routing tag for the fake rpc
    id: "d1111111-1111-1111-1111-111111111111",
    memory_type: "episodic",
    subject_type: "city",
    subject_id: "Da Nang",
    content: "Visited Da Nang (returned)",
    confidence: 0.8,
    is_inferred: false,
    observation_count: 2,
    sensitivity: "normal",
    visibility: "private",
    state: "active",
    retention_class: "durable_fact",
    valid_from: iso(30),
    valid_to: null,
    last_supported_at: iso(2),
    derivation: "compass_graph_edges:visited",
    source_event_ids: [],
    ...over,
  };
}

function groupEntries(m: MyWorldMemory, g: MyWorldMemoryGroup) {
  return m.groups.find((b) => b.group === g)?.entries ?? [];
}

// ── 1./3. Derived-memory groups + §12 boundary ───────────────────────────────

describe("§31 derived-memory groups (reuse the §12 core)", () => {
  it("classifies an episodic 'returned' memory as Returned to Place", async () => {
    const sc = makeSc({ derived: [derivedRow()] });
    const m = await buildMyWorldMemory(sc, ALICE);
    const returned = groupEntries(m, "returned_to_place");
    assert.equal(returned.length, 1, "the returned episodic memory becomes a Returned to Place entry");
    assert.equal(returned[0].source.kind, "derived_memory");
    assert.match(returned[0].detail ?? "", /Da Nang/);
    assert.equal(isLocationSafe(m), true, "no precise location in the memory surface");
  });

  it("classifies a semantic preference memory as Favorite atmosphere", async () => {
    const sc = makeSc({
      derived: [
        derivedRow({ id: "d2", memory_type: "semantic", subject_type: "inferred_interest", subject_id: "rooftop bars", content: "Often chooses rooftop bars", is_inferred: true }),
      ],
    });
    const m = await buildMyWorldMemory(sc, ALICE);
    assert.equal(groupEntries(m, "favorite_atmosphere").length, 1, "semantic memory becomes a Favorite atmosphere entry");
  });

  it("the derived read is scoped to the OWNER id passed in (session identity)", async () => {
    const seed: Seed = { derived: [derivedRow()] };
    const sc = makeSc(seed);
    await buildMyWorldMemory(sc, ALICE);
    const call = seed.rpcCalls!.find((c) => c.name === "memory_remembers_for_user");
    assert.ok(call, "the §12 derived-memory RPC was called");
    assert.equal(call!.params.p_user_id, ALICE, "reads the caller's OWN memory, not a supplied id");
  });

  it("a suppressed (forgotten) memory does NOT surface — mutation-proof", async () => {
    const forget = {
      user_id: ALICE,
      kind: "forget",
      subject_type: "city",
      subject_id: "Da Nang",
      projection_id: null,
    };
    // WITH the forget row → the Returned to Place entry is hidden.
    const scHidden = makeSc({ derived: [derivedRow()], feedback: [forget] });
    const hidden = await buildMyWorldMemory(scHidden, ALICE);
    assert.equal(groupEntries(hidden, "returned_to_place").length, 0, "forgotten memory is suppressed");
    assert.equal(hidden.totals.suppressed, 1, "the suppression is counted");

    // MUTATION: remove the forget row (bypass the suppression the code reuses) →
    // the SAME entry appears. This proves the suppression filter is load-bearing.
    const scShown = makeSc({ derived: [derivedRow()], feedback: [] });
    const shown = await buildMyWorldMemory(scShown, ALICE);
    assert.equal(groupEntries(shown, "returned_to_place").length, 1, "without the forget row the entry surfaces — the filter is not vacuous");
  });

  it("a non-active / sensitive derived memory does NOT surface (the §12 deny gate)", async () => {
    // The reused mapDerivedRow deny gate drops these before they reach any group.
    const sc = makeSc({
      derived: [
        derivedRow({ id: "d-forgotten", state: "forgotten" }),
        derivedRow({ id: "d-sensitive", state: "active", sensitivity: "sensitive" }),
        derivedRow({ id: "d-expired", state: "active", valid_to: iso(1) }),
      ],
    });
    const m = await buildMyWorldMemory(sc, ALICE);
    assert.equal(groupEntries(m, "returned_to_place").length, 0, "non-active/sensitive/expired derived memory never reaches My World");
  });
});

// ── 4. §31.1 Hidden Gem Memory lines from real gem signals ───────────────────

describe("§31.1 Hidden Gem Memory lines derive from real gem signals", () => {
  it("You discovered / confirmed twice / early contributor / visited before popular", async () => {
    const sc = makeSc({
      hidden_gems: [
        { id: GEM_1, name: "Secret Cove", city: "Da Nang", status: "active", submitted_by: ALICE, created_at: iso(40) },
      ],
      // Alice visited twice (confirmed twice), and is the earliest visitor.
      hidden_gem_visits: [
        { gem_id: GEM_1, user_id: ALICE, is_suspicious: false, visited_at: iso(39) },
        { gem_id: GEM_1, user_id: ALICE, is_suspicious: false, visited_at: iso(10) },
        { gem_id: GEM_1, user_id: OTHER, is_suspicious: false, visited_at: iso(5) },
      ],
      hidden_gem_contributions: [
        { gem_id: GEM_1, user_id: ALICE, created_at: iso(38) },
        { gem_id: GEM_1, user_id: OTHER, created_at: iso(3) },
      ],
    });
    const m = await buildMyWorldMemory(sc, ALICE);
    const lines = m.hiddenGemMemory.filter((l) => l.gemId === GEM_1).map((l) => l.kind);
    assert.ok(lines.includes("discovered"), "discovered (submitted_by = owner)");
    assert.ok(lines.includes("confirmed_twice"), "confirmed twice (2 non-suspicious visits)");
    assert.ok(lines.includes("early_contributor"), "early contributor (1st distinct contributor)");
    assert.ok(lines.includes("visited_before_popular"), "visited before popular (1st distinct visitor)");
    // Every line is owner-only.
    for (const l of m.hiddenGemMemory) assert.equal(l.visibility, "owner_only");
    // And Visited/Discovered §31 groups are populated from the same signals.
    assert.equal(groupEntries(m, "discovered_hidden_gem").length, 1);
    assert.equal(groupEntries(m, "visited_hidden_gem").length, 1);
  });

  it("'brought Trip Crew here' needs a visit AND a crew trip to the gem's city", async () => {
    const sc = makeSc({
      hidden_gems: [{ id: GEM_2, name: "Crew Spot", city: "Bangkok", status: "active", submitted_by: OTHER }],
      hidden_gem_visits: [{ gem_id: GEM_2, user_id: ALICE, is_suspicious: false, visited_at: iso(5) }],
      // Alice is in a trip to Bangkok with a crew (2 accepted members).
      trip_members: [
        { trip_id: TRIP_1, user_id: ALICE, status: "accepted" },
        { trip_id: TRIP_1, user_id: OTHER, status: "accepted" },
      ],
      trips: [{ id: TRIP_1, destination_city: "Bangkok" }],
    });
    const m = await buildMyWorldMemory(sc, ALICE);
    const lines = m.hiddenGemMemory.filter((l) => l.gemId === GEM_2).map((l) => l.kind);
    assert.ok(lines.includes("brought_trip_crew"), "brought Trip Crew here (visit + crew trip to the same city)");
  });

  it("no crew (solo trip) ⇒ NO 'brought Trip Crew' line", async () => {
    const sc = makeSc({
      hidden_gems: [{ id: GEM_2, name: "Crew Spot", city: "Bangkok", status: "active", submitted_by: OTHER }],
      hidden_gem_visits: [{ gem_id: GEM_2, user_id: ALICE, is_suspicious: false, visited_at: iso(5) }],
      trip_members: [{ trip_id: TRIP_1, user_id: ALICE, status: "accepted" }], // only Alice → no crew
      trips: [{ id: TRIP_1, destination_city: "Bangkok" }],
    });
    const m = await buildMyWorldMemory(sc, ALICE);
    const lines = m.hiddenGemMemory.filter((l) => l.gemId === GEM_2).map((l) => l.kind);
    assert.ok(!lines.includes("brought_trip_crew"), "a solo trip is not a crew");
  });
});

// ── §31 media/trip-crew/outcome groups ───────────────────────────────────────

describe("§31 media + trip-crew + outcome groups", () => {
  it("Night out with Trip Crew needs a nightlife post tied to a crew trip", async () => {
    const sc = makeSc({
      posts: [{ id: POST_1, author_id: ALICE, trip_id: TRIP_1, category: "nightlife", location_name: "An Thuong Bar", status: "active", post_status: "published", created_at: iso(3) }],
      trip_members: [
        { trip_id: TRIP_1, user_id: ALICE, status: "accepted" },
        { trip_id: TRIP_1, user_id: OTHER, status: "accepted" },
      ],
      trips: [{ id: TRIP_1, destination_city: "Da Nang" }],
    });
    const m = await buildMyWorldMemory(sc, ALICE);
    assert.equal(groupEntries(m, "night_out_with_trip_crew").length, 1, "nightlife + crew trip ⇒ a Night out entry");
  });

  it("Saved visual inspiration from post_saves", async () => {
    const sc = makeSc({ post_saves: [{ user_id: ALICE, post_id: POST_1, created_at: iso(1) }] });
    const m = await buildMyWorldMemory(sc, ALICE);
    assert.equal(groupEntries(m, "saved_visual_inspiration").length, 1);
    assert.equal(groupEntries(m, "saved_visual_inspiration")[0].source.originTable, "post_saves");
  });

  it("Experience matched expectation only for follow-through outcome stages", async () => {
    const sc = makeSc({
      compass_outcome_events: [
        { id: "o1", user_id: ALICE, recommendation_id: "rec-1", item_id: "x", item_type: "place", stage: "went", occurred_at: iso(2) },
        { id: "o2", user_id: ALICE, recommendation_id: "rec-2", item_id: "y", item_type: "place", stage: "viewed", occurred_at: iso(2) },
      ],
    });
    const m = await buildMyWorldMemory(sc, ALICE);
    const matched = groupEntries(m, "experience_matched_expectation");
    assert.equal(matched.length, 1, "only the 'went' follow-through counts, not 'viewed'");
  });
});

// ── 6. Empty ⇒ graceful ──────────────────────────────────────────────────────

describe("empty / graceful", () => {
  it("no data ⇒ a well-formed empty memory surface with all groups present", async () => {
    const sc = makeSc({});
    const m = await buildMyWorldMemory(sc, ALICE);
    assert.equal(m.visibility, "owner_only");
    assert.equal(m.ownerId, ALICE);
    assert.equal(m.hiddenGemMemory.length, 0);
    assert.equal(m.totals.surfaced, 0);
    const groups = m.groups.map((g) => g.group);
    for (const g of ["visited_hidden_gem", "discovered_hidden_gem", "returned_to_place", "night_out_with_trip_crew", "favorite_atmosphere", "saved_visual_inspiration", "experience_matched_expectation"] as MyWorldMemoryGroup[]) {
      assert.ok(groups.includes(g), `group ${g} present even when empty`);
    }
    assert.equal(isLocationSafe(m), true);
  });

  it("no ownerId ⇒ empty, never throws", async () => {
    const sc = makeSc({ derived: [derivedRow()] });
    const m = await buildMyWorldMemory(sc, "");
    assert.equal(m.totals.surfaced, 0);
    assert.equal(m.hiddenGemMemory.length, 0);
  });
});

// ── 5. §30 buckets have correct counts ───────────────────────────────────────

describe("§30 My World buckets — correct counts", () => {
  it("postcards / memories / gems / uploads counts + owner-only flags", async () => {
    const sc = makeSc({
      profiles: [{ id: ALICE, account_status: "active", location_country: "VN", date_of_birth: "1990-01-01" }],
      passport_postcards: [
        { id: "pc1", user_id: ALICE, status: "active", deleted_at: null },
        { id: "pc2", user_id: ALICE, status: "hidden", deleted_at: null }, // excluded
        { id: "pc3", user_id: OTHER, status: "active", deleted_at: null }, // not owner
      ],
      memories: [
        { id: "mm1", owner_id: ALICE, state: "active" },
        { id: "mm2", owner_id: ALICE, state: "deleted" }, // excluded
      ],
      hidden_gems: [
        { id: GEM_1, submitted_by: ALICE, status: "active", name: "G1", city: "Da Nang", created_at: iso(5) },
        { id: GEM_2, submitted_by: ALICE, status: "rejected", name: "G2", city: "Da Nang" }, // excluded
      ],
      media_assets: [
        { id: "ma1", owner_user_id: ALICE },
        { id: "ma2", owner_user_id: ALICE },
      ],
    });
    const viewer = await resolveViewer(sc, ALICE);
    const me = await buildMyWorldProjection(sc, viewer, Date.now());
    const count = (k: string) => me.buckets.find((b) => b.key === k)?.count;
    assert.equal(count("postcards"), 1, "only Alice's active, non-tombstoned postcard");
    assert.equal(count("memories"), 1, "deleted memory excluded");
    assert.equal(count("gems"), 1, "rejected gem excluded");
    assert.equal(count("uploads"), 2, "owner's uploaded media assets");
    const uploads = me.buckets.find((b) => b.key === "uploads");
    assert.equal(uploads?.ownerOnly, true, "Uploads is an owner-only bucket");
    // The §31 memory rides on the same projection.
    assert.equal(me.memory.visibility, "owner_only");
    assert.equal(me.memory.groups.find((g) => g.group === "discovered_hidden_gem")?.entries.length, 1, "the discovered gem shows in My World memory too");
    assert.equal(isLocationSafe(me), true, "no precise location anywhere in /media/me");
  });
});

// ── 2. Route: OWNER-ONLY + SESSION-SCOPED — `?user_id=` ignored (mutation-proof) ─

describe("GET /media/me — session identity only", () => {
  let app: Express;
  let server: Server;
  let port: number;

  before(async () => {
    const { default: mediaWorldRouter } = await import("../routes/mediaWorld.js");
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).log = { info() {}, error() {}, warn() {}, debug() {} };
      next();
    });
    app.use("/api", mediaWorldRouter);
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as any).port;
  });

  after(() => {
    server.close();
    _setTestClient(null as any, false);
    _setTestServiceClient(null);
  });

  async function get(path: string, token: string | null): Promise<{ status: number; body: any }> {
    const r = await fetch(`http://127.0.0.1:${port}/api${path}`, {
      method: "GET",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    let body: any = null;
    try { body = await r.json(); } catch { body = null; }
    return { status: r.status, body };
  }

  beforeEach(() => {
    // ALICE owns a discovered gem; MALLORY owns a different one. If the route
    // honoured ?user_id=MALLORY, Mallory's gem would surface — the assertions
    // below would go RED.
    const seed: Seed = {
      profiles: [
        { id: ALICE, account_status: "active", location_country: "VN", date_of_birth: "1990-01-01" },
        { id: MALLORY, account_status: "active" },
      ],
      hidden_gems: [
        { id: GEM_1, submitted_by: ALICE, status: "active", name: "Alice Gem", city: "Da Nang", created_at: iso(5) },
        { id: GEM_2, submitted_by: MALLORY, status: "active", name: "Mallory Gem", city: "Bangkok", created_at: iso(5) },
      ],
      derived: [
        derivedRow({ __owner: ALICE, subject_id: "Da Nang", content: "Visited Da Nang (returned)" }),
        derivedRow({ __owner: MALLORY, id: "dm", subject_id: "Bangkok", content: "Visited Bangkok (returned)" }),
      ],
    };
    const sc = makeSc(seed);
    _setTestClient(sc, true as any);
    _setTestServiceClient(sc);
  });

  it("unauthenticated ⇒ rejected", async () => {
    const res = await get("/media/me", null);
    assert.ok(res.status === 401 || res.status === 403, `expected auth failure, got ${res.status}`);
  });

  it("ignores ?user_id= and returns ONLY the session user's My World memory", async () => {
    const res = await get(`/media/me?user_id=${MALLORY}&p_user_id=${MALLORY}`, "alice-token");
    assert.equal(res.status, 200);
    assert.equal(res.body.memory.ownerId, ALICE, "memory is scoped to the SESSION user");
    const discovered = res.body.memory.groups.find((g: any) => g.group === "discovered_hidden_gem")?.entries ?? [];
    const details = discovered.map((e: any) => e.detail);
    assert.ok(details.includes("Alice Gem"), "Alice's own gem shows");
    assert.ok(!details.includes("Mallory Gem"), "the smuggled ?user_id= did NOT surface Mallory's gem");
    // The gem bucket count is also the session user's.
    assert.equal(res.body.buckets.find((b: any) => b.key === "gems")?.count, 1, "only Alice's gem counted");
  });
});
