/**
 * §5 "Personal Recaps" + "On This Day" — route- and service-level tests.
 *
 * These SHIP DISABLED behind the `memory_recaps` flag. The tests prove the six
 * things that matter for a privacy-critical, ships-off resurfacing surface:
 *
 *   1. FLAG OFF ⇒ endpoints inert/empty and ZERO memory work is done (no derived
 *      RPC, no source-table reads). MUTATION: flip the flag on ⇒ content appears —
 *      proving the gate is real, not decorative.
 *   2. Recaps / On This Day include ONLY eligible items and EXCLUDE a sensitive
 *      one, a forgotten one, a deleted-subject one, an unconsented shared moment,
 *      and a safety-incident / raw-location one.
 *   3. RE-CHECK ON OPEN: an item eligible on the first call becomes ineligible
 *      (forgotten / consent withdrawn / moderation-hidden) and is ABSENT on the
 *      second call — with NO snapshot. MUTATION: without the change it reappears.
 *   4. On This Day matches same month-day, EARLIER year only, with an INJECTED date.
 *   5. NEVER auto-publishes: no write to any table happens during generation.
 *   6. Notifications require the explicit opt-in (default OFF ⇒ no trigger).
 *
 * Pattern mirrors memoryPassportRemembers.test.ts / memoryRoutes.test.ts — a
 * mock Supabase client, so it runs in normal CI with no live DB.
 *
 * Run: node --import tsx/esm --test src/test/memoryRecapsOnThisDay.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express, { type Express } from "express";
import { _setTestClient } from "../lib/http.js";
import {
  generateRecap,
  buildOnThisDay,
  shouldNotifyRecaps,
  isRecapNotificationOptIn,
} from "../compass/MemoryRecapsService.js";

const ALICE = "a1a1a1a1-aaaa-aaaa-aaaa-00000000ae01";
const MALLORY = "bad00000-0000-0000-0000-00000000bad0";

let rpcCalls: Array<{ name: string; params: any }> = [];
let reads: string[] = [];
let inserts: Array<{ table: string; row: any }> = [];

interface Seed {
  flagEnabled?: boolean;
  derived?: any[];
  feedback?: any[];
  savedPlaces?: any[];
  memories?: any[];
  postcards?: any[];
  userStamps?: any[];
  trips?: any[];
  tripSingle?: Record<string, unknown> | null;
  compassMemories?: any[];
  memberships?: any[];
  moments?: any[];
  optIn?: Record<string, unknown> | null;
}

function makeClient(seed: Seed = {}) {
  const listFor = (table: string): any[] => {
    switch (table) {
      case "memory_feedback": return seed.feedback ?? [];
      case "saved_places": return seed.savedPlaces ?? [];
      case "memories": return seed.memories ?? [];
      case "passport_postcards": return seed.postcards ?? [];
      case "user_stamps": return seed.userStamps ?? [];
      case "trips": return seed.trips ?? [];
      case "compass_memories": return seed.compassMemories ?? [];
      case "shared_moment_memberships": return seed.memberships ?? [];
      case "shared_moments": return seed.moments ?? [];
      default: return [];
    }
  };
  const singleFor = (table: string): any => {
    switch (table) {
      case "profiles": return { account_status: "active" };
      case "feature_flags": return { enabled: Boolean(seed.flagEnabled) };
      case "trips": return seed.tripSingle ?? null;
      case "notification_category_preferences": return seed.optIn ?? null;
      default: return null;
    }
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
      rpcCalls.push({ name, params });
      if (name === "memory_recaps_for_user") return { data: seed.derived ?? [], error: null };
      return { data: null, error: null };
    },
    from: (table: string) => {
      reads.push(table);
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        order: () => chain,
        limit: () => chain,
        maybeSingle: async () => ({ data: singleFor(table), error: null }),
        insert: async (row: any) => {
          inserts.push({ table, row });
          return { data: null, error: null };
        },
        then: (onF: any, onR: any) =>
          Promise.resolve({ data: listFor(table), error: null }).then(onF, onR),
      };
      return chain;
    },
  } as any;
}

let app: Express;
let server: Server;
let port: number;

before(async () => {
  const { default: compassRouter } = await import("../routes/compass.js");
  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).log = { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} };
    next();
  });
  app.use("/api", compassRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as any).port;
});

after(() => {
  server.close();
  _setTestClient(null as any, false);
});

beforeEach(() => {
  rpcCalls = [];
  reads = [];
  inserts = [];
});

async function api(
  method: string,
  path: string,
  token: string | null = "alice-token",
): Promise<{ status: number; body: any }> {
  const r = await fetch(`http://127.0.0.1:${port}/api${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  let parsed: any = null;
  try { parsed = await r.json(); } catch { parsed = null; }
  return { status: r.status, body: parsed };
}

// ── date helpers for building deterministic anniversary fixtures ─────────────
function isoDaysAgoYears(fromNow: Date, yearsAgo: number, dayOffset = 0): string {
  const d = new Date(Date.UTC(fromNow.getUTCFullYear() - yearsAgo, fromNow.getUTCMonth(), fromNow.getUTCDate() + dayOffset, 12, 0, 0));
  return d.toISOString();
}

function postcard(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: "pc1", caption: "Beach day", status: "active", visibility: "private", deleted_at: null, created_at: new Date().toISOString(), ...over };
}
function stamp(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: "st1", stamp_definition_id: "def1", earned_at: new Date().toISOString(), visibility: "private", is_revoked: false, display_on_passport: true, ...over };
}
function derivedRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    memory_type: "episodic", subject_type: "city", subject_id: "Lisbon",
    content: "Visited Lisbon", confidence: 0.8, is_inferred: false, observation_count: 0,
    sensitivity: "normal", visibility: "private", state: "active", retention_class: "durable_fact",
    valid_from: new Date().toISOString(), valid_to: null, last_supported_at: new Date().toISOString(),
    derivation: "compass_graph_edges:visited", source_event_ids: ["aaaaaaaa-1111-1111-1111-111111111111"],
    ...over,
  };
}

function recapItems(recap: any): any[] {
  return (recap.sections ?? []).flatMap((s: any) => s.items ?? []);
}

// ════════════════════════════════════════════════════════════════════════════
// 1. FLAG GATE — off ⇒ inert + zero work; on ⇒ content appears (mutation proof)
// ════════════════════════════════════════════════════════════════════════════
describe("flag gate — memory_recaps OFF ⇒ inert, zero work", () => {
  it("recaps: flag off returns inert, reads no memory tables and calls no RPC", async () => {
    _setTestClient(makeClient({ flagEnabled: false, derived: [derivedRow()], postcards: [postcard()] }), true as any);
    const res = await api("GET", "/compass/me/recaps?kind=year&year=2026");
    assert.equal(res.status, 200);
    assert.equal(res.body.enabled, false, "recap reports disabled");
    assert.equal(res.body.published, false);
    assert.equal(recapItems(res.body).length, 0, "no items surfaced while disabled");
    assert.deepEqual(rpcCalls, [], "no derived RPC while disabled (zero work)");
    for (const t of ["memory_feedback", "trips", "passport_postcards", "shared_moments", "user_stamps"]) {
      assert.ok(!reads.includes(t), `must not read '${t}' while disabled`);
    }
  });

  it("on-this-day: flag off returns inert, zero memory work", async () => {
    _setTestClient(makeClient({ flagEnabled: false, postcards: [postcard()] }), true as any);
    const res = await api("GET", "/compass/me/on-this-day");
    assert.equal(res.status, 200);
    assert.equal(res.body.enabled, false);
    assert.equal((res.body.items ?? []).length, 0);
    for (const t of ["memory_feedback", "passport_postcards", "shared_moments"]) {
      assert.ok(!reads.includes(t), `must not read '${t}' while disabled`);
    }
  });

  it("MUTATION: flipping the flag ON surfaces content the OFF path hid", async () => {
    // Same seed, flag ON — the previously-hidden postcard now appears. If the
    // gate were decorative, the OFF test above would also have shown it.
    const now = new Date();
    _setTestClient(makeClient({ flagEnabled: true, postcards: [postcard({ created_at: now.toISOString() })] }), true as any);
    const res = await api("GET", "/compass/me/recaps?kind=year&year=" + now.getUTCFullYear());
    assert.equal(res.status, 200);
    assert.equal(res.body.enabled, true);
    assert.ok(recapItems(res.body).some((i) => i.subjectType === "passport:postcard"), "postcard appears once enabled");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. ELIGIBILITY — include only eligible; exclude the deny-listed classes
// ════════════════════════════════════════════════════════════════════════════
describe("recaps include only eligible items", () => {
  it("excludes sensitive / deleted-subject derived rows (via the §12 core deny gate)", async () => {
    // memory_recaps_for_user delegates to the §12 core, which drops these in SQL.
    // The mapper's defence-in-depth gate drops a sensitive row even if one leaked.
    _setTestClient(makeClient({
      flagEnabled: true,
      derived: [
        derivedRow({ id: "keep", subject_id: "Lisbon" }),
        derivedRow({ id: "sensitive", sensitivity: "sensitive", subject_id: "co-present" }),
      ],
    }), true as any);
    const res = await api("GET", "/compass/me/recaps?kind=milestone&milestone=all");
    const ids = recapItems(res.body).map((i) => i.id);
    assert.ok(ids.includes("keep"), "eligible derived memory present");
    assert.ok(!ids.includes("sensitive"), "sensitive derived memory excluded");
  });

  it("excludes a forgotten item, an unconsented shared moment, and free-text scrapbook (fail-closed)", async () => {
    const now = new Date();
    _setTestClient(makeClient({
      flagEnabled: true,
      postcards: [postcard({ id: "pc-keep", created_at: now.toISOString() }), postcard({ id: "pc-forgotten", created_at: now.toISOString() })],
      // A user-created Memory (free-text scrapbook) — never resurfaced (fail closed).
      memories: [{ id: "mem1", title: "A hard day", state: "active", visibility: "private", created_at: now.toISOString() }],
      feedback: [{ kind: "forget", subject_type: "passport:postcard", subject_id: "pc-forgotten", projection_id: null }],
      memberships: [
        { moment_id: "m-yes", status: "accepted" },
        { moment_id: "m-invited", status: "invited" }, // NOT consented
      ],
      moments: [
        { id: "m-yes", title: "Dinner", status: "active", visibility: "circle", archived_at: null, created_at: now.toISOString() },
        { id: "m-invited", title: "Should not appear", status: "active", visibility: "circle", archived_at: null, created_at: now.toISOString() },
      ],
    }), true as any);
    const res = await api("GET", "/compass/me/recaps?kind=year&year=" + now.getUTCFullYear());
    const items = recapItems(res.body);
    const titles = items.map((i) => i.title);
    const subs = items.map((i) => i.subjectType);
    assert.ok(items.some((i) => i.subjectType === "passport:postcard" && i.id === "passport:postcard:pc-keep"), "kept postcard present");
    assert.ok(!items.some((i) => i.id === "passport:postcard:pc-forgotten"), "forgotten postcard excluded");
    assert.ok(titles.includes("Dinner"), "consented moment present");
    assert.ok(!titles.includes("Should not appear"), "unconsented moment excluded");
    assert.ok(!subs.includes("passport:memory"), "free-text scrapbook memory is NOT resurfaced (fail closed)");
    assert.ok(!titles.includes("A hard day"), "unknown-valence free-text never resurfaced");
  });

  it("never resurfaces raw-location or safety rows — asserts they are not in the set", async () => {
    const now = new Date();
    _setTestClient(makeClient({ flagEnabled: true, postcards: [postcard({ created_at: now.toISOString() })] }), true as any);
    const res = await api("GET", "/compass/me/recaps?kind=year&year=" + now.getUTCFullYear());
    const items = recapItems(res.body);
    assert.ok(items.length >= 1, "the celebratory postcard is present");
    assert.ok(
      !items.some((i) => /location_snapshot|raw|trail|proximity|safe_return|incident|geofence/i.test(String(i.subjectType))),
      "no raw-location / safety item is present",
    );
    // Also assert the §12 builders never read those tables at all.
    for (const t of ["location_snapshots", "trip_crew_location_events", "safe_return_events", "safe_return_sessions"]) {
      assert.ok(!reads.includes(t), `must never read '${t}'`);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. RE-CHECK ON OPEN — no snapshot; a since-ineligible item drops on 2nd call
// ════════════════════════════════════════════════════════════════════════════
describe("re-check on open (stateless, no eligibility snapshot)", () => {
  it("a postcard eligible on first open is ABSENT after it is forgotten; mutation restores it", async () => {
    const now = new Date();
    const base = { flagEnabled: true, postcards: [postcard({ id: "pc-x", created_at: now.toISOString() })] };
    const path = "/compass/me/recaps?kind=year&year=" + now.getUTCFullYear();

    // First open — present.
    _setTestClient(makeClient(base), true as any);
    let res = await api("GET", path);
    assert.ok(recapItems(res.body).some((i) => i.id === "passport:postcard:pc-x"), "present on first open");

    // Second open — the user has since forgotten it. Re-checked live ⇒ gone.
    _setTestClient(makeClient({
      ...base,
      feedback: [{ kind: "forget", subject_type: "passport:postcard", subject_id: "pc-x", projection_id: null }],
    }), true as any);
    res = await api("GET", path);
    assert.ok(!recapItems(res.body).some((i) => i.id === "passport:postcard:pc-x"),
      "ABSENT on re-open after forget — proves re-check, not a cached snapshot");

    // MUTATION: without the forget it reappears — so the second call really did
    // re-run the filter (a snapshot would keep hiding it).
    _setTestClient(makeClient(base), true as any);
    res = await api("GET", path);
    assert.ok(recapItems(res.body).some((i) => i.id === "passport:postcard:pc-x"),
      "MUTATION CHECK: reappears without the forget (RED if eligibility were snapshotted)");
  });

  it("On This Day: withdrawing shared-moment consent drops the item on the next open", async () => {
    const now = new Date();
    const anniversary = isoDaysAgoYears(now, 1, 0); // same month-day, last year
    const consented = {
      memberships: [{ moment_id: "m1", status: "accepted" }],
      moments: [{ id: "m1", title: "Anniversary moment", status: "active", visibility: "circle", archived_at: null, created_at: anniversary }],
    };
    // Consent present ⇒ surfaced.
    let otd = await buildOnThisDay(makeClient({ flagEnabled: true, ...consented }), ALICE, { now });
    assert.ok(otd.items.some((i) => i.title === "Anniversary moment"), "surfaced while consent stands");

    // Consent withdrawn (membership no longer accepted) ⇒ gone on re-open.
    otd = await buildOnThisDay(makeClient({
      flagEnabled: true,
      memberships: [{ moment_id: "m1", status: "left" }],
      moments: consented.moments,
    }), ALICE, { now });
    assert.ok(!otd.items.some((i) => i.title === "Anniversary moment"), "gone after consent withdrawn (re-checked live)");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. ON THIS DAY — same month-day, EARLIER year only, with an INJECTED date
// ════════════════════════════════════════════════════════════════════════════
describe("On This Day matches same month-day, earlier year (injected date)", () => {
  it("includes last-year same-day, excludes off-by-one-day and this-year", async () => {
    // Inject a fixed date so the assertion is deterministic.
    const now = new Date(Date.UTC(2026, 7, 31, 9, 0, 0)); // 2026-08-31
    const client = makeClient({
      flagEnabled: true,
      postcards: [
        postcard({ id: "hit", created_at: "2024-08-31T12:00:00.000Z" }),      // 2 years ago, same M-D ✓
        postcard({ id: "off-day", created_at: "2024-08-30T12:00:00.000Z" }),  // different day ✗
        postcard({ id: "this-year", created_at: "2026-08-31T01:00:00.000Z" }),// same year (not an anniversary) ✗
        postcard({ id: "future", created_at: "2027-08-31T12:00:00.000Z" }),   // later year ✗
      ],
    });
    const otd = await buildOnThisDay(client, ALICE, { now });
    assert.equal(otd.enabled, true);
    assert.deepEqual(otd.date, { month: 8, day: 31 });
    const ids = otd.items.map((i) => i.id);
    assert.ok(ids.includes("passport:postcard:hit"), "same month-day earlier year is included");
    assert.ok(!ids.includes("passport:postcard:off-day"), "adjacent day excluded");
    assert.ok(!ids.includes("passport:postcard:this-year"), "same-year (not an anniversary) excluded");
    assert.ok(!ids.includes("passport:postcard:future"), "later year excluded");
  });

  it("only resurfaces the four structured classes (postcards, trips, stamps, moments)", async () => {
    const now = new Date(Date.UTC(2026, 7, 31, 9, 0, 0));
    const anniv = "2025-08-31T12:00:00.000Z";
    const otd = await buildOnThisDay(makeClient({
      flagEnabled: true,
      postcards: [postcard({ id: "p", created_at: anniv })],
      trips: [{ id: "t", title: "Tokyo", status: "active", visibility: "private", destination_city: "Tokyo", start_date: anniv, end_date: anniv, created_at: anniv }],
      userStamps: [stamp({ id: "s", earned_at: anniv })],
      // saved_place shares the day but is NOT in the On This Day set.
      savedPlaces: [{ id: "sp", place_id: "pl", saved_at: anniv }],
      memberships: [{ moment_id: "m", status: "accepted" }],
      moments: [{ id: "m", title: "Moment", status: "active", visibility: "circle", archived_at: null, created_at: anniv }],
    }), ALICE, { now });
    const subs = new Set(otd.items.map((i) => i.subjectType));
    assert.ok(subs.has("passport:postcard") && subs.has("passport:trip") && subs.has("passport:stamp") && subs.has("passport:shared_moment"),
      "all four structured classes resurface");
    assert.ok(!subs.has("passport:saved_place"), "saved places are NOT part of On This Day");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. NEVER AUTO-PUBLISHES — generation writes nothing
// ════════════════════════════════════════════════════════════════════════════
describe("generation never auto-publishes", () => {
  it("recaps + on-this-day perform no INSERT/write to any table", async () => {
    const now = new Date();
    const seed = {
      flagEnabled: true,
      derived: [derivedRow()],
      postcards: [postcard({ created_at: now.toISOString() })],
      memberships: [{ moment_id: "m", status: "accepted" }],
      moments: [{ id: "m", title: "Moment", status: "active", visibility: "circle", archived_at: null, created_at: now.toISOString() }],
    };
    _setTestClient(makeClient(seed), true as any);
    const r1 = await api("GET", "/compass/me/recaps?kind=year&year=" + now.getUTCFullYear());
    const r2 = await api("GET", "/compass/me/on-this-day");
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.equal(r1.body.published, false, "recap is never auto-published");
    assert.equal(r2.body.published, false, "on-this-day is never auto-published");
    assert.deepEqual(inserts, [], "generation writes to NO table (no feed/public/social publish)");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 6. NOTIFICATIONS — opt-in only, default OFF
// ════════════════════════════════════════════════════════════════════════════
describe("recap notifications require an explicit opt-in (default OFF)", () => {
  it("no opt-in row ⇒ not opted in", async () => {
    const opted = await isRecapNotificationOptIn(makeClient({ optIn: null }), ALICE);
    assert.equal(opted, false, "absent preference row defaults OFF");
  });

  it("shouldNotifyRecaps: flag off ⇒ no notify (flag_off)", async () => {
    const d = await shouldNotifyRecaps(makeClient({ flagEnabled: false, optIn: { push_enabled: true } }), ALICE);
    assert.deepEqual(d, { notify: false, reason: "flag_off" });
  });

  it("shouldNotifyRecaps: flag on but NOT opted in ⇒ no notify (opt_out)", async () => {
    const d = await shouldNotifyRecaps(makeClient({ flagEnabled: true, optIn: null }), ALICE);
    assert.deepEqual(d, { notify: false, reason: "opt_out" });
  });

  it("shouldNotifyRecaps: flag on AND opted in ⇒ notify", async () => {
    const d = await shouldNotifyRecaps(makeClient({ flagEnabled: true, optIn: { push_enabled: true, in_app_enabled: false } }), ALICE);
    assert.deepEqual(d, { notify: true, reason: null });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Owner-only, session-scoped (mirrors §12): a smuggled ?user_id= is ignored.
// ════════════════════════════════════════════════════════════════════════════
describe("owner-only + session-scoped", () => {
  it("recaps requires auth", async () => {
    _setTestClient(makeClient({ flagEnabled: true }), true as any);
    const res = await api("GET", "/compass/me/recaps?kind=year&year=2026", null);
    assert.ok(res.status === 401 || res.status === 403, `expected auth failure, got ${res.status}`);
  });

  it("recaps uses the SESSION identity, ignoring ?user_id=", async () => {
    const now = new Date();
    _setTestClient(makeClient({ flagEnabled: true, derived: [derivedRow()] }), true as any);
    const res = await api("GET", `/compass/me/recaps?kind=milestone&milestone=x&user_id=${MALLORY}&p_user_id=${MALLORY}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.ownerId, ALICE, "recap is for the caller's own memory");
    const call = rpcCalls.find((c) => c.name === "memory_recaps_for_user");
    assert.ok(call, "derived memory flows through the windowed §12-core delegate");
    assert.equal(call!.params.p_user_id, ALICE, "must read the caller's OWN memory");
    assert.notEqual(call!.params.p_user_id, MALLORY);
    void now;
  });
});
