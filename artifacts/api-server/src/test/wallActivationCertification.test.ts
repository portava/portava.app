/**
 * Wall — ACTIVATION CERTIFICATION (owner checklist points 8-11).
 *
 * WHY THIS FILE EXISTS
 * ====================
 * The activation question the owner asked is not "does the code exist" but "with
 * the flag ON and real rows present, does the Wall serve items, and is an empty
 * answer honest?". Reading the source cannot answer that. These tests drive the
 * REAL wall router over HTTP against a seeded corpus with `wall_enabled` ON and
 * assert what the route actually serves.
 *
 * THE CLAIM THIS FILE WAS WRITTEN TO SETTLE
 * =========================================
 * The standing constraint is: "do not enable wall_live_for_you_enabled until
 * promoted scopes are actually reviewed/populated", on the stated ground that
 * `LiveForYouService` reads the intel spine through lib/liveClaimRead, whose
 * `loadPromotedScopes` fails closed on an empty allowlist — so an empty
 * `intel_live_promoted_scopes` would mean the strip "cannot produce output even
 * with every flag on".
 *
 * That is TRUE OF EXACTLY ONE OF THE SIX STRIP KINDS. `buildLiveForYou` reads
 * intel envelopes ONLY for candidates that arrive UNRESOLVED
 * (LiveForYouService.ts: "Read intel envelopes ONLY for the intel-sourced
 * (unresolved) subjects … resolved candidates carry their own fact and need no
 * read"). The five resolved kinds — trip_signal, event_state, social_presence,
 * hidden_gem, buddy — are built by their own producers from trips, events,
 * posts, hidden_gems and rent_buddy_profiles and never touch liveClaimRead. Only
 * `place_state`, the unresolved kind, goes through the promoted-scope allowlist.
 *
 * So an empty allowlist REDUCES the strip to its resolved kinds; it does not
 * silence it. Both halves are asserted below, because each is a different
 * activation decision:
 *   • empty allowlist + a resolved producer  ⇒ the strip STILL SERVES (test 3)
 *   • empty allowlist + only place_state     ⇒ the strip is empty (test 1)
 *   • promoted scope + a live snapshot       ⇒ place_state APPEARS (test 2)
 *
 * Test 2 is the load-bearing one: without it, tests 1 and 4 would also pass
 * against a strip whose place_state producer had been deleted outright, and the
 * allowlist would look like the binding constraint when nothing was bound.
 *
 * POINT 9 / POINT 7 — THE RESIDUAL GAP AFTER #459
 * ===============================================
 * #459 makes a FAILED read distinguishable from an EMPTY feed for the Post spine
 * and the Following contract, and it does wrap the live-strip ASSEMBLY in a
 * `{ items, failed }` result in routes/wall.ts. But that `failed` flag is only
 * ever set by the catch around `buildLiveForYou` — it needs a THROW. #459
 * modifies neither services/wall/LiveForYouService.ts nor lib/liveClaimRead.ts,
 * and `loadPromotedScopes` swallows its own rejection internally
 * (`if (error || !data) return new Set()`), so a REJECTED allowlist read returns
 * normally, yields fewer items, and reports `failed: false`.
 *
 * Test 4 pins that residual: the Live lane fails CLOSED on an unreadable
 * allowlist, which is right for privacy, and the result stays byte-identical to
 * an honestly empty allowlist, which is the honesty gap #459 leaves open here.
 * The assertion is written as the durable positive (fail-closed, and the
 * resolved kinds still serve, so §34 graceful degradation holds) rather than as
 * the absence of a marker, so it survives whatever shape a later fix takes.
 *
 * Run: node --import tsx/esm --test src/test/wallActivationCertification.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient, _clearTestClient } from "../lib/http.js";
import { _clearPromotedScopeCache } from "../lib/liveClaimRead.js";
import wallRouter from "../routes/wall.js";

const TOKEN = "tok";
const VIEWER = "viewer-1";

const NOW_MS = Date.now();
const at = (minutes: number) => new Date(NOW_MS + minutes * 60_000).toISOString();

// ── The corpus ───────────────────────────────────────────────────────────────
//
// DELIBERATELY STARVED of the five RESOLVED producers: no trips, no events, no
// hidden gems, no rent-buddy profiles. Priority order in assembleLiveCandidates
// is trip → event → social → gem → buddy → place_state and the strip caps at 4,
// so place_state — the ONE kind that consults the promoted-scope allowlist —
// only ever reaches a slot when the higher-priority kinds are absent. A corpus
// that produced any of them would mask exactly the effect under test.
//
// social_presence needs TWO DISTINCT followed authors at one place, so every
// post here is authored by the SAME author to keep that kind starved too.

// TWO places, and the gem below sits on place-2 ONLY. That separation is load
// bearing: `buildLiveForYou` de-duplicates by SUBJECT and prefers a candidate
// carrying a pre-resolved fact, so a gem on the same place as the place_state
// probe would hide place_state by dedup rather than by the allowlist — and the
// allowlist assertions in tests 3/4 would pass against a removed gate. place-1
// keeps NO resolved producer, so it stays a live place_state probe throughout.
const PLACES = [
  { id: "place-1", name: "An Thuong", city: "Da Nang", country_code: "VN",
    latitude: 16.05, longitude: 108.20, status: "active", merged_into_place_id: null },
  { id: "place-2", name: "My Khe", city: "Da Nang", country_code: "VN",
    latitude: 16.06, longitude: 108.24, status: "active", merged_into_place_id: null },
];

const PROFILES: Record<string, any> = {
  [VIEWER]: { id: VIEWER, display_name: "Viewer", username: "viewer", avatar_url: null,
    account_status: "active", current_city: "Da Nang", home_city: "Da Nang", interests: ["food"] },
  "author-1": { id: "author-1", display_name: "Author One", username: "author1",
    avatar_url: null, account_status: "active" },
};

const POSTS = [
  { id: "post-1", author_id: "author-1", place: "place-1", minutes: -5 },
  { id: "post-2", author_id: "author-1", place: "place-1", minutes: -10 },
  { id: "post-3", author_id: "author-1", place: "place-2", minutes: -15 },
].map((p) => ({
  id: p.id, author_id: p.author_id, trip_id: null,
  content: `Post at ${p.place}`, visibility: "public", status: "active", post_status: "published",
  created_at: at(p.minutes), published_at: at(p.minutes),
  canonical_place_id: p.place, has_video: false, media_count: 1, category: "food",
  location_city: "Da Nang", location_country: "VN",
  like_count: 1, comment_count: 0, save_count: 0,
}));

/** A gem on place-2 ONLY (see the PLACES note) — the RESOLVED kind used to prove
 *  the strip still serves while the allowlist is empty or unreadable, without
 *  masking the place_state probe that stays on place-1. */
const HIDDEN_GEMS = [{
  id: "gem-1", canonical_place_id: "place-2", sensitivity_level: "public",
  verification_level: "community", status: "active", crowd_level: "quiet",
  save_count: 0, visit_count: 0, updated_at: at(-60),
  latitude: 16.06, longitude: 108.24, approx_latitude: 16.06, approx_longitude: 108.24,
  image_url: null,
}];

/** A live, privacy-eligible, unexpired crowd.level snapshot: the row a promoted
 *  scope makes servable. zone_id null ⇒ scope key "|crowd.level". */
const SNAPSHOTS = [{
  id: "snap-1", zone_id: null, claim_type: "crowd.level", value: { level: "busy" },
  confidence: 0.8, source_count: 20, observed_at: at(-30), expires_at: at(120),
  privacy_eligible: true, conflict_state: "none", source_class: "direct_observation",
  computed_at: at(-30),
}];

const BASE_TABLES: Record<string, any[]> = {
  posts: POSTS,
  places: PLACES,
  profiles: Object.values(PROFILES),
  user_follows: [{ following_id: "author-1" }],
  trip_members: [],
  trip_saved_places: [],
  trip_plan_items: [],
  events: [],
  hidden_gems: [],
  rent_buddy_profiles: [],
  blocks: [],
  intel_live_promoted_scopes: [],
  intel_state_snapshots: SNAPSHOTS,
};

/** Wall master ON, live strip ON, and the whole intel chain the place_state kind
 *  needs. Everything else OFF so the lanes under test are isolated. */
const BASE_FLAGS: Record<string, boolean> = {
  wall_enabled: true,
  wall_live_for_you_enabled: true,
  wall_rab_integration_enabled: false,
  rent_buddy_enabled: false,
  wall_input_intelligence_enabled: false,
  wall_discovery_insertions_enabled: false,
  wall_compass_handoff_enabled: false,
  wall_context_threads_enabled: false,
  events_trust_gates_enabled: false,
  // The liveLabelsServable chain (lib/liveClaimRead.liveLabelsServable).
  intel_live_label_crowd: true,
  intel_claim_projection_crowd: true,
  intel_capture_quick_signal: true,
  intel_limited_live: true,
  disable_intel_live_labels: false, // kill switch CLEAR
};

// ── Fake client ──────────────────────────────────────────────────────────────

/**
 * Table-routed fake, same shape as wallLiveStripRoute.test.ts's: row filters are
 * accepted and ignored because every producer re-applies its own membership and
 * privacy checks in JS. `errorTables` makes a named table's read REJECT the way
 * supabase-js actually does — resolving `{ data: null, error }`, never throwing.
 */
function client(
  tables: Record<string, any[]>,
  flags: Record<string, boolean>,
  errorTables: Set<string>,
) {
  function builder(table: string) {
    const f: Record<string, any> = {};
    const rejected = errorTables.has(table);
    const result = rejected
      ? { data: null, error: { message: `${table} read rejected`, code: "42501" } }
      : { data: tables[table] ?? [], error: null };
    const b: any = {
      select: () => b, neq: () => b, in: () => b, not: () => b, is: () => b, or: () => b,
      gte: () => b, lte: () => b, gt: () => b, lt: () => b, order: () => b, limit: () => b,
      range: () => b,
      eq(col: string, val: any) { f[col] = val; return b; },
      insert: () => Promise.resolve({ error: null }),
      upsert: () => Promise.resolve({ error: null }),
      delete: () => ({ eq: () => Promise.resolve({ error: null }) }),
      maybeSingle() {
        if (table === "feature_flags") {
          return Promise.resolve({ data: { enabled: !!flags[String(f["flag"])] }, error: null });
        }
        if (table === "profiles") {
          return Promise.resolve({ data: PROFILES[String(f["id"])] ?? null, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
      then: (onF: any, onR: any) => Promise.resolve(result).then(onF, onR),
    };
    return b;
  }
  return {
    from: builder,
    auth: {
      getUser: async (token: string) =>
        token === TOKEN
          ? { data: { user: { id: VIEWER } }, error: null }
          : { data: { user: null }, error: { message: "invalid" } },
    },
  };
}

function useWorld(
  opts: {
    tables?: Record<string, any[]>;
    flags?: Record<string, boolean>;
    errorTables?: string[];
  } = {},
) {
  // The allowlist is cached module-side; clear it or a previous test's set leaks.
  _clearPromotedScopeCache();
  _setTestClient(
    client(
      { ...BASE_TABLES, ...(opts.tables ?? {}) },
      { ...BASE_FLAGS, ...(opts.flags ?? {}) },
      new Set(opts.errorTables ?? []),
    ),
    true,
  );
}

// ── HTTP harness ─────────────────────────────────────────────────────────────

let server: http.Server;
let baseUrl = "";

function get(path: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + path);
    const req = http.request(
      {
        hostname: url.hostname, port: url.port, path: url.pathname + url.search,
        method: "GET", headers: { authorization: `Bearer ${TOKEN}` },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : null });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

const kindsOf = (strip: any[]) => new Set(strip.map((i: any) => i.liveObjectType));

describe("Wall activation certification — the promoted-scope allowlist binds ONE strip kind", () => {
  before(async () => {
    const app = express();
    app.use(express.json());
    app.use("/api", wallRouter);
    await new Promise<void>((resolve) => {
      server = http.createServer(app);
      server.listen(0, "127.0.0.1", () => {
        baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        server.unref();
        resolve();
      });
    });
  });

  after(async () => {
    _clearTestClient();
    await new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  });

  beforeEach(() => useWorld());

  // ── POINT 8: real output, with the flag on and real rows ───────────────────
  it("POINT 8: wall_enabled ON with real rows serves a non-empty feed", async () => {
    const res = await get("/api/wall?mode=for_you");
    assert.equal(res.status, 200);
    assert.ok(
      Array.isArray(res.json.items) && res.json.items.length > 0,
      `expected a non-empty For You feed, got ${JSON.stringify(res.json.items)}`,
    );
  });

  // ── 1. Empty allowlist ⇒ the intel-sourced kind cannot serve ───────────────
  it("1. an EMPTY promoted-scope allowlist yields no place_state, so a place_state-only strip is empty", async () => {
    const res = await get("/api/wall/live");
    assert.equal(res.status, 200);
    const strip = res.json.liveForYou ?? [];
    assert.ok(
      !kindsOf(strip).has("place_state"),
      `place_state must not serve while the allowlist is empty; got ${JSON.stringify(strip)}`,
    );
    assert.equal(strip.length, 0, `expected an empty strip, got ${JSON.stringify(strip)}`);
  });

  // ── 2. THE CONTROL: promote the scope and place_state appears ──────────────
  //
  // Without this, tests 1 and 4 would pass just as well against a deleted
  // place_state producer — the allowlist would look binding while binding
  // nothing. This is what makes the empty-allowlist result mean what it says.
  it("2. CONTROL: promoting '|crowd.level' with a live snapshot makes place_state serve", async () => {
    useWorld({ tables: { intel_live_promoted_scopes: [{ scope_key: "|crowd.level" }] } });
    const res = await get("/api/wall/live");
    assert.equal(res.status, 200);
    const strip = res.json.liveForYou ?? [];
    assert.ok(
      kindsOf(strip).has("place_state"),
      `place_state must serve once its scope is promoted; got ${JSON.stringify(strip)}`,
    );
  });

  // ── 3. The correction: an empty allowlist does NOT silence the strip ────────
  it("3. an empty allowlist still serves the RESOLVED kinds — the strip is reduced, not silenced", async () => {
    useWorld({ tables: { hidden_gems: HIDDEN_GEMS } });
    const res = await get("/api/wall/live");
    assert.equal(res.status, 200);
    const strip = res.json.liveForYou ?? [];
    const kinds = kindsOf(strip);
    assert.ok(
      kinds.has("hidden_gem"),
      `a resolved kind must serve with an empty allowlist; got ${JSON.stringify(strip)}`,
    );
    assert.ok(
      !kinds.has("place_state"),
      `place_state must still be withheld; got ${JSON.stringify(strip)}`,
    );
  });

  // ── 4. POINT 7/9 residual: an UNREADABLE allowlist fails closed ────────────
  it("4. an UNREADABLE allowlist fails CLOSED and still degrades gracefully (§34)", async () => {
    useWorld({
      tables: {
        hidden_gems: HIDDEN_GEMS,
        intel_live_promoted_scopes: [{ scope_key: "|crowd.level" }],
      },
      errorTables: ["intel_live_promoted_scopes"],
    });
    const res = await get("/api/wall/live");
    assert.equal(res.status, 200);
    const strip = res.json.liveForYou ?? [];
    // Fail-closed: a rejected allowlist read withholds the intel kind even
    // though a scope IS promoted in the table the read could not reach.
    assert.ok(
      !kindsOf(strip).has("place_state"),
      `an unreadable allowlist must withhold place_state; got ${JSON.stringify(strip)}`,
    );
    // …and the rest of the strip still serves: the failure is contained.
    assert.ok(
      kindsOf(strip).has("hidden_gem"),
      `the resolved kinds must survive an intel-lane failure; got ${JSON.stringify(strip)}`,
    );
  });

  // ── 5. POINT 11: the feed still renders when the block read is fine, and a
  //       blocked author's content is excluded from it ────────────────────────
  it("5. POINT 11: a blocked author's post is excluded from the For You feed", async () => {
    const open = await get("/api/wall?mode=for_you");
    const openIds = new Set((open.json.items ?? []).map((i: any) => i.id));
    assert.ok(openIds.size > 0, "precondition: the unblocked feed must serve something");

    useWorld({
      tables: { blocks: [{ blocker_id: VIEWER, blocked_id: "author-1" }] },
    });
    const res = await get("/api/wall?mode=for_you");
    assert.equal(res.status, 200);
    const authors = new Set(
      (res.json.items ?? []).map((i: any) => i.author?.id ?? i.authorId).filter(Boolean),
    );
    assert.ok(
      !authors.has("author-1"),
      `a blocked author must not appear; got ${JSON.stringify(res.json.items)}`,
    );
  });
});
