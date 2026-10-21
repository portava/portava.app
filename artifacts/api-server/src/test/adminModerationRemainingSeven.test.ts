/**
 * census-trust (wave 5, 2026-10-18) — admin moderation surfaces, the remaining
 * seven: no queue item vanishes, no total is a page's length, no action stands
 * without its audit row, no resolve wins a race it lost, no filter word is
 * answered with an empty queue.
 *
 * Run: env -i PATH="$PATH" HOME=$TMPDIR TMPDIR=$TMPDIR TZ=UTC \
 *      SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/adminModerationRemainingSeven.test.ts
 * The route cases listen on 127.0.0.1 (run with loopback allowed).
 *
 * THE SEVEN (99fe25cf3 listed them, "LISTED, NOT FIXED"):
 *   1. GET /admin/venues/reported dropped a venue whose report-count embed
 *      answered without a count, applied its limit to ALL places before it knew
 *      which were reported, and answered `total` = the page's length.
 *   2. parsePagination (adminMedia) and the place-image lists' copies turned
 *      ?page=abc into NaN, which survives Math.max: `.range(NaN, NaN)`, an empty
 *      page with `page: null`. The trust review queue's limit could go negative.
 *   3. The place-image queue applied `has_reports` AFTER paging: `total` counted
 *      the unfiltered queue and pages came back short or empty.
 *   4. The Compass dashboard took totals and breakdowns from the LENGTH of
 *      unbounded reads (PostgREST's row cap silently shortens them), a 500-row
 *      sample (city demand) and a 20-row page (newUserExposure.count);
 *      GET /admin/compass/safety-filters answered `total` = its page's length.
 *   5. The event moderate route's own `event_<action>` moderation_actions insert
 *      failed OPEN (a warn and `200 { ok: true }`), its patch was unguarded and
 *      its row count unread.
 *   6. Place-mismatch resolve cleared the post's place FIRST and then wrote an
 *      unguarded status update: two resolves both "won".
 *   7. GET /admin/trust/reviews matched ?status= (and ?type=) exactly and
 *      unvalidated: a word no review carries answered an empty queue.
 *
 * THE CONVENTION, per route: each already refuses a RETURNED error with
 * db_error, so a list or count it cannot measure is refused the same way,
 * NAMING what could not be read; a filter word outside its vocabulary is a 400
 * that names the parameter; a malformed ?page / ?limit is the house default
 * (admin.ts /admin/reports: not a positive whole number -> the default, and the
 * answer names the page it served); a reversible action is CLAIMED, AUDITED, and
 * UNDONE when the audit cannot be written (lib/legacyReportClose.ts's order).
 *
 * DOUBLES. Every route runs on schemaStrictSupabase (each column checked
 * against the live schema; 42703 otherwise) with these additions, each stated
 * where it is made: `.range(lo, hi)` — and `.limit(n)` on a read that asked for
 * a count — slices the answer as PostgREST does (`count` stays the whole
 * match); an optional row CAP slices every list answer to its first N rows,
 * as PostgREST's max-rows does, with `count` still the whole match; an insert
 * answers the `id` its column default would give; and a per-table OVERRIDE may
 * replace or precede one statement's answer — after the statement was built,
 * so its schema check has already run.
 *
 * Venue cases on the code before this change: its read cannot run on this
 * double (the `.gt("discovery_place_reports.count", 0)` filter is read as a
 * column of discovery_places, 42703; whether PostgREST accepts a filter on an
 * aggregate embed was not measured). So for the OLD statement only — the one
 * whose select carries `discovery_place_reports(count)` — an override answers
 * what PostgREST would under the most charitable reading (the filter accepted,
 * every place returned, newest first, limited, each with its embedded count).
 * The new code never sends that statement.
 *
 * Each case says whether it was RED or GREEN on the code before this change
 * (99fe25cf3).
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import { makeSchemaStrictClient, type Seed, type Row, type SchemaStrictOptions } from "./helpers/schemaStrictSupabase.js";
import { liveColumns } from "./helpers/liveColumns.ts";
import { readEveryRow, parseListPage, parseVocabularyFilter, TRUST_REVIEW_STATUSES } from "../lib/moderationCounts.js";
import { applyEventModeration } from "../lib/eventModerationClaim.js";
import adminRouter from "../routes/admin.js";
import adminMediaRouter from "../routes/adminMedia.js";
import trustAdminRouter from "../routes/trust-admin.js";
import adminPlaceImagesRouter from "../routes/adminPlaceImages.js";
import adminPlaceMismatchRouter from "../routes/adminPlaceMismatch.js";
import adminCompassRouter from "../routes/adminCompass.js";

const ADMIN    = "a1111111-1111-4111-8111-1111111190a0";
const REPORTER = "a2222222-2222-4222-8222-2222222290a0";
const OWNER    = "a3333333-3333-4333-8333-3333333390a0";
const OTHER    = "a4444444-4444-4444-8444-4444444490a0";
const EVENT    = "b4444444-4444-4444-8444-4444444490a0";
const POST_A   = "b1111111-1111-4111-8111-1111111190a0";
const PLACE    = "b5555555-5555-4555-8555-5555555590a0";
const MISMATCH = "e2222222-2222-4222-8222-2222222290a0";
const TOKENS: Record<string, string> = { "admin-token": ADMIN };
const FAIL = { message: "simulated failure", code: "57014" };

const at = (n: number) => new Date(Date.UTC(2026, 9, 1, 0, 0, n)).toISOString();
const ago = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
const uid = (prefix: string, n: number) => `${prefix}-0000-4000-8000-0000000091${String(n).padStart(2, "0")}`;
const venue = (n: number) => uid("d0000000", n);
const visual = (n: number) => uid("d1000000", n);

function profile(id: string, handle: string, role = "user"): Row {
  return { id, handle, username: handle, name: `${handle} name`, display_name: `${handle} display`, role, account_status: "active", created_at: at(0) };
}

function world(): Seed {
  return {
    profiles: [profile(ADMIN, "admin", "admin"), profile(REPORTER, "reporter"), profile(OWNER, "owner"), profile(OTHER, "other")],
    admin_access_log: [], feature_flags: [], user_account_states: [], compass_settings: [], moderation_actions: [],
    reports: [], event_activity_log: [],
    discovery_places: [], discovery_place_reports: [],
    posts: [{ id: POST_A, author_id: OWNER, visibility: "public", post_status: "published", canonical_place_id: PLACE, created_at: at(1) }],
    places: [{ id: PLACE, name: "Place A", primary_category: "cafe", city: "Da Nang", country_code: "VN", latitude: 16.05, longitude: 108.2 }],
    hidden_gems: [],
    generated_visuals: [], place_image_reports: [],
    place_mismatch_reports: [
      { id: MISMATCH, post_id: POST_A, reporter_id: REPORTER, reported_place_id: PLACE, reason: "wrong_city", status: "pending", resolved_action: null, resolved_at: null, resolved_by: null, created_at: at(2) },
    ],
    trust_reviews: [
      { id: "e3333333-3333-4333-8333-3333333390a0", user_id: OWNER, review_type: "gaming_suspected", status: "open", source_event_id: null, assigned_to: null, notes: null, metadata: {}, created_at: at(11) },
      { id: "e3333333-3333-4333-8333-3333333390a1", user_id: REPORTER, review_type: "event_review", status: "open", source_event_id: null, assigned_to: null, notes: null, metadata: {}, created_at: at(12) },
      { id: "e3333333-3333-4333-8333-3333333390a2", user_id: OTHER, review_type: "gaming_suspected", status: "in_progress", source_event_id: null, assigned_to: null, notes: null, metadata: {}, created_at: at(13) },
    ],
    events: [{ id: EVENT, host_id: OWNER, title: "Reported event", state: "open", visibility: "public", featured: false, city: "Da Nang", starts_at: at(15), created_at: at(15), updated_at: at(15) }],
    compass_abuse_flags: [], compass_safety_filter_logs: [], compass_feed_cache: [], compass_active_user_scores: [],
    compass_notification_decisions: [], compass_algorithm_versions: [], compass_feedback_events: [], user_location_state: [],
    rent_buddy_profiles: [],
  };
}

type Call = [string, unknown[]];
type Answer = { data: unknown; error: unknown; count?: unknown };
/** Addition 4: replace (or precede) one statement's answer. `run` executes the real statement; not calling it means it never ran. */
type Override = (calls: Call[], run: () => Promise<Answer>) => Answer | Promise<Answer> | null | undefined;
interface InstallOptions { overrides?: Partial<Record<string, Override>>; strict?: SchemaStrictOptions; cap?: number }

let idSeq = 0;
function install(seed: Seed, o: InstallOptions = {}) {
  const strict = makeSchemaStrictClient(seed, o.strict);
  const from = (table: string) => {
    const b = strict.from(table);
    const calls: Call[] = [];
    for (const m of ["select", "eq", "neq", "in", "is", "not", "gt", "gte", "lt", "lte", "order", "update", "upsert", "delete"]) {
      const orig = b[m];
      b[m] = (...args: unknown[]) => { calls.push([m, args]); return orig(...args); };
    }
    // Addition 3: an insert answers the `id` its column default (gen_random_uuid()) would give.
    const origInsert = b.insert;
    b.insert = (rows: Row | Row[]) => {
      calls.push(["insert", [rows]]);
      const arr = (Array.isArray(rows) ? rows : [rows]).map((r) => (liveColumns(table).has("id") && r.id === undefined ? { ...r, id: `f0000000-0000-4000-8000-${String(++idSeq).padStart(12, "0")}` } : r));
      return origInsert(Array.isArray(rows) ? arr : arr[0]);
    };
    // Addition 1b: on a read that asked for a count, `.limit(n)` slices the answer instead (the double counts AFTER its limit).
    const origLimit = b.limit;
    let lim: number | null = null;
    b.limit = (n: number) => { calls.push(["limit", [n]]); if (calls.some(([m, a]) => m === "select" && (a[1] as any)?.count)) { lim = n; return b; } return origLimit(n); };
    // Addition 1: `.range(lo, hi)` slices the answer; `count` stays the whole match, as PostgREST's Content-Range.
    let rng: [number, number] | null = null;
    b.range = (lo: number, hi: number) => { calls.push(["range", [lo, hi]]); rng = [lo, hi]; return b; };
    const isWrite = () => calls.some(([m]) => m === "update" || m === "insert" || m === "delete" || m === "upsert");
    const slice = (a: Answer): Answer => {
      if (!Array.isArray(a?.data) || isWrite()) return a;
      let rows = a.data as unknown[];
      if (rng) rows = rows.slice(rng[0], rng[1] + 1);
      if (lim !== null) rows = rows.slice(0, lim);
      // Addition 2: the server's row cap (PostgREST max-rows): the first N rows, and nothing says it stopped.
      if (o.cap !== undefined) rows = rows.slice(0, o.cap);
      return { ...a, data: rows };
    };
    const ov = o.overrides?.[table];
    const gate = (run: () => Promise<Answer>): Promise<Answer> => {
      try { const r = ov?.(calls, run); return r == null ? run() : Promise.resolve(r); } catch (e) { return Promise.reject(e); }
    };
    const origThen = b.then, origMaybe = b.maybeSingle;
    b.then = (onF: any, onR: any) => gate(() => new Promise<Answer>((res, rej) => origThen(res, rej)).then(slice)).then(onF, onR);
    b.maybeSingle = () => { calls.push(["maybeSingle", []]); return gate(() => origMaybe()); };
    return b;
  };
  const client = {
    from,
    rpc: strict.rpc,
    auth: {
      getUser: async (token: string) => (TOKENS[token]
        ? { data: { user: { id: TOKENS[token] } }, error: null }
        : { data: { user: null }, error: { message: "bad token", status: 401 } }),
    },
  };
  _setTestClient(client, true);
  _setTestServiceClient(client as any);
  return { strict, seed };
}

const isListRead = (calls: Call[]) => !calls.some(([m]) => m === "update" || m === "insert" || m === "delete" || m === "maybeSingle") && !calls.some(([m, a]) => m === "select" && (a[1] as any)?.head === true);
const countless: Override = (calls, run) => (isListRead(calls) ? run().then((r) => ({ ...r, count: null })) : null);
const failed: Override = (calls) => (isListRead(calls) ? { data: null, error: FAIL, count: null } : null);
const selectOf = (calls: Call[]) => String(calls.find(([m]) => m === "select")?.[1]?.[0] ?? "");

let server: http.Server;
let base = "";
before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.log = { error() {}, warn() {}, info() {}, debug() {} }; next(); });
  app.use(adminMediaRouter);
  app.use(trustAdminRouter);
  app.use(adminPlaceImagesRouter);
  app.use(adminPlaceMismatchRouter);
  app.use(adminCompassRouter);
  app.use(adminRouter);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  _setTestClient(null, false);
  _setTestServiceClient(null);
});
beforeEach(() => { _resetRateLimit(); });

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any; raw: string }> {
  const r = await fetch(`${base}${path}`, { method, headers: { authorization: "Bearer admin-token", "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const raw = await r.text();
  let parsed: any; try { parsed = JSON.parse(raw); } catch { parsed = raw; }
  return { status: r.status, body: parsed, raw };
}
const get = (path: string) => call("GET", path);

function refused(r: { status: number; body: any; raw: string }, name: RegExp) {
  assert.equal(r.status, 500, r.raw);
  assert.equal(r.body.error, "db_error", r.raw);
  assert.match(r.body.message, name, `the refusal names what could not be read: ${r.raw}`);
}

// ── 1. GET /admin/venues/reported ────────────────────────────────────────────

function place(n: number, createdAt: string): Row {
  return { id: venue(n), name: `Venue ${n}`, place_type: "cafe", category: "food", city: "Da Nang", neighborhood: null, blurb: null, status: "active", submitted_by: OWNER, created_at: createdAt };
}
function placeReport(n: number, placeN: number, reason: string, createdAt: string): Row {
  return { id: uid("d2000000", n), place_id: venue(placeN), reporter_id: [REPORTER, OWNER, OTHER, ADMIN][n % 4], reason, notes: null, created_at: createdAt };
}
/** The OLD statement only (its select carries the aggregate embed): what PostgREST would answer, read charitably — under the same row cap. */
function oldEmbedAnswer(seed: Seed, mode: "count" | "countless", cap = Infinity): Override {
  return (calls) => {
    if (!selectOf(calls).includes("discovery_place_reports(count)")) return null;
    const lim = (calls.find(([m]) => m === "limit")?.[1]?.[0] as number | undefined) ?? Infinity;
    const rows = [...(seed.discovery_places ?? [])]
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .slice(0, Math.min(lim, cap))
      .map((p) => ({ ...p, discovery_place_reports: mode === "count" ? [{ count: (seed.discovery_place_reports ?? []).filter((r) => r.place_id === p.id).length }] : [{}] }));
    return { data: rows, error: null, count: null };
  };
}

describe("1. GET /admin/venues/reported: a reported venue never vanishes, and `total` counts the queue", () => {
  function venueWorld() {
    const s = world();
    // Venue 1 is the OLDEST place and the most reported; venues 2 and 3 are newer; venue 4 is the newest and unreported.
    s.discovery_places = [place(1, at(100)), place(2, at(200)), place(3, at(300)), place(4, at(400))];
    s.discovery_place_reports = [
      placeReport(1, 1, "unsafe", at(500)), placeReport(2, 1, "closed", at(510)), placeReport(3, 1, "spam", at(505)),
      placeReport(4, 2, "spam", at(520)),
      placeReport(5, 3, "wrong_location", at(530)), placeReport(6, 3, "closed", at(540)),
    ];
    return s;
  }

  it("RED before: a venue whose report count could not be read is never dropped — the page is refused, naming the read", async () => {
    const s = venueWorld();
    install(s, { overrides: { discovery_places: oldEmbedAnswer(s, "countless"), discovery_place_reports: countless } });
    refused(await get("/admin/venues/reported"), /venue reports could not be read \(discovery_place_reports\)/);
  });

  it("RED before: a reported venue older than the newest `limit` places is in the queue (the limit ran first)", async () => {
    const s = venueWorld();
    install(s, { overrides: { discovery_places: oldEmbedAnswer(s, "count") } });
    const r = await get("/admin/venues/reported?limit=1");
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(r.body.venues.map((v: any) => v.id), [venue(1)], "the most-reported venue, though it is the oldest place");
    assert.equal(r.body.venues[0].reportCount, 3);
  });

  it("RED before: `total` counts every reported venue, not the page's length", async () => {
    const s = venueWorld();
    install(s, { overrides: { discovery_places: oldEmbedAnswer(s, "count") } });
    const r = await get("/admin/venues/reported?limit=2");
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.venues.length, 2);
    assert.equal(r.body.total, 3, "three venues are reported; two are on this page");
  });

  it("GREEN before (CONTROL): the whole queue, most-reported first, with each venue's report count", async () => {
    const s = venueWorld();
    install(s, { overrides: { discovery_places: oldEmbedAnswer(s, "count") } });
    const r = await get("/admin/venues/reported");
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(r.body.venues.map((v: any) => [v.id, v.reportCount]), [[venue(1), 3], [venue(3), 2], [venue(2), 1]]);
  });

  it("RED before: each venue carries its newest report's reason and time — the doc promised it and nothing sent it", async () => {
    const s = venueWorld();
    install(s, { overrides: { discovery_places: oldEmbedAnswer(s, "count") } });
    const r = await get("/admin/venues/reported");
    assert.equal(r.status, 200, r.raw);
    const v1 = r.body.venues.find((v: any) => v.id === venue(1));
    assert.equal(v1.latestReason, "closed");
    assert.equal(v1.latestReportAt, at(510));
  });

  it("RED before: the read names no column the schema-strict double cannot place (the dotted aggregate filter read as a discovery_places column)", async () => {
    const { strict } = install(venueWorld());
    const r = await get("/admin/venues/reported");
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(strict.deadColumnErrors, []);
  });

  it("RED before: the queue pages past the row cap — a venue whose reports sit past the first page of reports is counted", async () => {
    const s = venueWorld();
    install(s, { cap: 2, overrides: { discovery_places: oldEmbedAnswer(s, "count", 2) } });
    const r = await get("/admin/venues/reported");
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(r.body.venues.map((v: any) => [v.id, v.reportCount]), [[venue(1), 3], [venue(3), 2], [venue(2), 1]]);
    assert.equal(r.body.total, 3);
  });

  it("RED before: a reported place gone by the time it is read is KEPT, flagged venueMissing", async () => {
    const s = venueWorld();
    install(s, { overrides: {
      discovery_places: (calls, run) => {
        if (selectOf(calls).includes("discovery_place_reports(count)")) return oldEmbedAnswer(s, "count")(calls, run);
        // The race: place 3 is removed after its reports were read, before the places read.
        s.discovery_places = s.discovery_places!.filter((p) => p.id !== venue(3));
        return run();
      },
    } });
    const r = await get("/admin/venues/reported");
    assert.equal(r.status, 200, r.raw);
    const v3 = r.body.venues.find((v: any) => v.id === venue(3));
    assert.ok(v3, `venue 3 is still in the queue: ${r.raw}`);
    assert.equal(v3.venueMissing, true);
    assert.equal(v3.reportCount, 2);
  });

  it("RED before (the refusal did not name what it could not read): a failed places read is refused naming discovery_places", async () => {
    install(venueWorld(), { overrides: { discovery_places: failed } });
    refused(await get("/admin/venues/reported"), /reported venues could not be read \(discovery_places\)/);
  });
});

// ── 2. ?page / ?limit ────────────────────────────────────────────────────────

describe("2. a malformed ?page or ?limit is the house default, and the answer names the page it served", () => {
  function pagingWorld() {
    const s = world();
    s.hidden_gems = [1, 2, 3].map((n) => ({ id: uid("d3000000", n), name: `Gem ${n}`, category: "food", city: "Da Nang", submitted_by: OWNER, status: "pending", description: null, vibe_tags: [], image_url: null, created_at: at(n), updated_at: at(n) }));
    s.generated_visuals = [1, 2].map((n) => ({ id: visual(n), entity_type: "place", entity_id: PLACE, canonical_place_id: PLACE, image_source_type: "reference_grounded_ai", accuracy_status: "unverified", source_url: `https://cdn.example.invalid/${n}.jpg`, created_at: at(10 + n) }));
    s.place_image_reports = [{ id: uid("d4000000", 1), image_url: "https://cdn.example.invalid/1.jpg", place_id: PLACE, reported_by: REPORTER, report_reason: "wrong_place", status: "pending", created_at: at(20) }];
    return s;
  }

  it("RED before: GET /admin/media/gems-pending?page=abc serves page 1 — it served `.range(NaN, NaN)`, an empty page with page null", async () => {
    install(pagingWorld());
    const r = await get("/admin/media/gems-pending?page=abc&limit=xyz");
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(r.body.pagination, { page: 1, limit: 20, total: 3, hasMore: false });
    assert.equal(r.body.items.length, 3);
  });

  it("RED before: the place-image queue and reports list serve page 1 for ?page=abc", async () => {
    install(pagingWorld());
    const q = await get("/admin/place-images/queue?page=abc");
    assert.equal(q.status, 200, q.raw);
    assert.equal(q.body.pagination.page, 1);
    assert.equal(q.body.items.length, 2);
    const rep = await get("/admin/place-images/reports?page=abc&limit=-3");
    assert.equal(rep.status, 200, rep.raw);
    assert.deepEqual([rep.body.pagination.page, rep.body.pagination.limit, rep.body.items.length], [1, 20, 1]);
  });

  it("RED before: the trust review queue's ?limit=-5 is the default page size, not a negative one", async () => {
    install(world());
    const r = await get("/admin/trust/reviews?limit=-5");
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.total, 3);
    assert.equal(r.body.reviews.length, 3, "every open and in_progress review — a negative page size answered none");
  });

  it("GREEN before (CONTROL): a well-formed ?page=2&limit=1 pages exactly as before", async () => {
    install(pagingWorld());
    const r = await get("/admin/media/gems-pending?page=2&limit=1");
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(r.body.pagination, { page: 2, limit: 1, total: 3, hasMore: true });
    assert.equal(r.body.items.length, 1);
  });

  it("RED before (a new reader): parseListPage: a positive whole number, else the default; a limit above the cap is the cap", () => {
    assert.deepEqual(parseListPage({ page: "abc", limit: "xyz" }), { page: 1, limit: 20, offset: 0 });
    assert.deepEqual(parseListPage({ page: "3", limit: "10" }), { page: 3, limit: 10, offset: 20 });
    assert.deepEqual(parseListPage({ page: "2.5", limit: "0" }, 50), { page: 1, limit: 50, offset: 0 });
    assert.deepEqual(parseListPage({ page: "-2", limit: "500" }), { page: 1, limit: 100, offset: 0 });
    assert.deepEqual(parseListPage({ page: ["2", "3"], limit: undefined }), { page: 1, limit: 20, offset: 0 });
    assert.deepEqual(parseListPage(undefined, 50, 100), { page: 1, limit: 50, offset: 0 });
  });
});

// ── 3. place-image queue: has_reports before paging ─────────────────────────

describe("3. GET /admin/place-images/queue?has_reports=: the filter chooses the page AND the total", () => {
  // Three place visuals, newest first: 3, 2, 1. Only visual 1 — the OLDEST — has a pending report on its own (url, place) pair.
  // Visual 2 shares visual 1's URL at ANOTHER place: a report keyed on (url, PLACE) must not count for it.
  const OTHER_PLACE = "b5555555-5555-4555-8555-5555555590a1";
  function filterWorld() {
    const s = world();
    s.places!.push({ id: OTHER_PLACE, name: "Place B", primary_category: "cafe", city: "Da Nang", country_code: "VN", latitude: 16.06, longitude: 108.21 });
    s.generated_visuals = [
      { id: visual(1), entity_type: "place", entity_id: PLACE, canonical_place_id: PLACE, image_source_type: "reference_grounded_ai", accuracy_status: "unverified", source_url: "https://cdn.example.invalid/shared.jpg", created_at: at(11) },
      { id: visual(2), entity_type: "place", entity_id: OTHER_PLACE, canonical_place_id: OTHER_PLACE, image_source_type: "reference_grounded_ai", accuracy_status: "unverified", source_url: "https://cdn.example.invalid/shared.jpg", created_at: at(12) },
      { id: visual(3), entity_type: "place", entity_id: PLACE, canonical_place_id: PLACE, image_source_type: "generic_ai_illustration", accuracy_status: "unverified", source_url: "https://cdn.example.invalid/3.jpg", created_at: at(13) },
      { id: visual(4), entity_type: "place", entity_id: PLACE, canonical_place_id: PLACE, image_source_type: "reference_grounded_ai", accuracy_status: "rejected", source_url: "https://cdn.example.invalid/4.jpg", created_at: at(14) },
    ];
    s.place_image_reports = [
      { id: uid("d4000000", 1), image_url: "https://cdn.example.invalid/shared.jpg", place_id: PLACE, reported_by: REPORTER, report_reason: "wrong_place", status: "pending", created_at: at(20) },
      { id: uid("d4000000", 2), image_url: "https://cdn.example.invalid/4.jpg", place_id: PLACE, reported_by: REPORTER, report_reason: "wrong_place", status: "pending", created_at: at(21) },
      { id: uid("d4000000", 3), image_url: "https://cdn.example.invalid/3.jpg", place_id: PLACE, reported_by: REPORTER, report_reason: "wrong_place", status: "reviewed_accepted", created_at: at(22) },
    ];
    return s;
  }

  it("RED before: has_reports=true&limit=1 serves the one reported image and says the queue holds one — it served an empty page of a 3-image total", async () => {
    install(filterWorld());
    const r = await get("/admin/place-images/queue?has_reports=true&limit=1");
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(r.body.items.map((i: any) => [i.id, i.reportCount]), [[visual(1), 1]]);
    assert.deepEqual(r.body.pagination, { page: 1, limit: 1, total: 1, hasMore: false });
  });

  it("RED before: has_reports=false counts only the unreported images, and paging through it reaches each exactly once", async () => {
    install(filterWorld());
    const seen: string[] = [];
    for (let page = 1; page <= 3; page++) {
      const r = await get(`/admin/place-images/queue?has_reports=false&limit=1&page=${page}`);
      assert.equal(r.status, 200, r.raw);
      assert.equal(r.body.pagination.total, 2, "visuals 3 and 2 (2 shares 1's URL at another place; 4 is rejected)");
      assert.equal(r.body.pagination.hasMore, page < 2);
      for (const i of r.body.items) { assert.equal(i.reportCount, 0); seen.push(i.id); }
    }
    assert.deepEqual(seen, [visual(3), visual(2)]);
  });

  it("GREEN before (CONTROL): with no has_reports the queue, its order and its total are unchanged", async () => {
    install(filterWorld());
    const r = await get("/admin/place-images/queue");
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(r.body.items.map((i: any) => [i.id, i.reportCount]), [[visual(3), 0], [visual(2), 0], [visual(1), 1]]);
    assert.equal(r.body.pagination.total, 3);
  });

  it("GREEN before (CONTROL): has_reports with another filter that leaves one page applies both", async () => {
    install(filterWorld());
    const r = await get("/admin/place-images/queue?has_reports=false&image_source_type=generic_ai_illustration");
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(r.body.items.map((i: any) => i.id), [visual(3)]);
    assert.equal(r.body.pagination.total, 1);
  });

  it("RED before: a pending-report read that answers no exact count refuses the filtered page — never a page filtered on a partial list", async () => {
    install(filterWorld(), { overrides: { place_image_reports: countless } });
    refused(await get("/admin/place-images/queue?has_reports=true"), /has_reports filter could not be applied \(pending reports\)/);
  });

  it("RED before: the filter pages past the row cap — the reported image past the first capped page is found", async () => {
    const s = filterWorld();
    install(s, { cap: 1 });
    const r = await get("/admin/place-images/queue?has_reports=true&limit=1");
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(r.body.items.map((i: any) => i.id), [visual(1)]);
    assert.equal(r.body.pagination.total, 1);
  });
});

// ── 4. Compass: totals measured, never a row length ────────────────────────

describe("4. the Compass dashboard and safety-filters: every total is measured past the row cap", () => {
  function compassWorld() {
    const s = world();
    s.compass_abuse_flags = [1, 2, 3, 4, 5].map((n) => ({ id: uid("d5000000", n), pattern_type: "ring", involved_users: [OWNER], severity: n <= 3 ? "high" : "low", status: "pending", evidence: {}, detected_at: ago(n) }));
    s.compass_safety_filter_logs = [1, 2, 3, 4, 5].map((n) => ({ id: uid("d6000000", n), viewer_id: REPORTER, item_id: POST_A, item_type: "post", block_reason: n <= 2 ? "blocked_author" : "muted_author", author_id: OWNER, created_at: ago(n) }));
    s.compass_notification_decisions = [1, 2, 3, 4].map((n) => ({ id: uid("d7000000", n), user_id: REPORTER, notification_type: "digest", priority_level: 5, outcome: n === 1 ? "sent" : "suppressed", suppression_reason: n === 1 ? null : "quiet_hours", created_at: ago(n) }));
    s.compass_feedback_events = [1, 2, 3, 4].map((n) => ({ id: uid("d8000000", n), user_id: REPORTER, recommendation_id: "r", item_id: POST_A, item_type: "post", action: n <= 3 ? "save" : "report", metadata: {}, created_at: ago(n) }));
    s.compass_feed_cache = [1, 2, 3].map((n) => ({ id: uid("d9000000", n), user_id: [REPORTER, OWNER, OTHER][n - 1], cache_key: `k${n}`, entry_type: "frontload", payload: {}, expires_at: new Date(Date.now() + 3_600_000).toISOString(), created_at: ago(1) }));
    s.user_location_state = [REPORTER, OWNER, OTHER, ADMIN].map((u, n) => ({ user_id: u, city: n < 3 ? "Da Nang" : "Hanoi", country: "VN" }));
    s.compass_active_user_scores = Array.from({ length: 25 }, (_, n) => ({ user_id: uid("da000000", n), active_user_score: n % 5, trust_multiplier: 1, boost_eligible: true, boost_visibility_enabled: false }));
    return s;
  }

  it("RED before: under a 2-row cap, abuse, safety-filter fires, notifications, feedback, cache and city demand are counted in full", async () => {
    install(compassWorld(), { cap: 2 });
    const r = await get("/admin/compass/dashboard");
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(r.body.abuse, { total: 5, bySeverity: { high: 3, low: 2 }, byStatus: { pending: 5 } });
    assert.deepEqual(r.body.safetyFilterFires, { total: 5, byReason: { blocked_author: 2, muted_author: 3 } });
    assert.equal(r.body.notifications.total, 4);
    assert.deepEqual(r.body.notifications.byOutcome, { sent: 1, suppressed: 3 });
    assert.equal(r.body.feedbackRates.totalEvents, 4);
    assert.equal(r.body.feedbackRates.saveRatePct, 75);
    assert.equal(r.body.cache.validEntries, 3);
    assert.equal(r.body.cache.uniqueUsers, 3);
    assert.deepEqual(r.body.citySupplyDemand, [{ city: "Da Nang", activeUsers: 3 }, { city: "Hanoi", activeUsers: 1 }]);
  });

  it("RED before: newUserExposure.count is the exact count, not the 20-row page's length", async () => {
    install(compassWorld());
    const r = await get("/admin/compass/dashboard");
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.newUserExposure.count, 25, "every score is <= 5");
    assert.equal(r.body.newUserExposure.users.length, 20);
  });

  it("RED before: a tallied section whose page answers short of its count refuses the dashboard naming it — it showed abuse.total 0", async () => {
    install(compassWorld(), { overrides: { compass_abuse_flags: (calls, run) => (isListRead(calls) ? run().then((r) => ({ ...r, data: [] })) : null) } });
    refused(await get("/admin/compass/dashboard"), /Dashboard incomplete: abuse could not be read/);
  });

  it("RED before: a newUserExposure read with no count refuses naming newUserExposure.count", async () => {
    install(compassWorld(), { overrides: { compass_active_user_scores: (calls, run) => (isListRead(calls) && calls.some(([m, a]) => m === "lte" && a[0] === "active_user_score") ? run().then((r) => ({ ...r, count: null })) : null) } });
    refused(await get("/admin/compass/dashboard"), /newUserExposure\.count could not be read/);
  });

  it("GREEN before (CONTROL): with no cap, the dashboard's abuse and safety blocks count the same", async () => {
    install(compassWorld());
    const r = await get("/admin/compass/dashboard");
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.abuse.total, 5);
    assert.equal(r.body.safetyFilterFires.total, 5);
  });

  it("RED before: GET /admin/compass/safety-filters?limit=2 answers every matching log's total and reasons, and the newest 2 logs", async () => {
    install(compassWorld());
    const r = await get("/admin/compass/safety-filters?limit=2");
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.total, 5, "five fires; two on this page");
    assert.deepEqual(r.body.byReason, { blocked_author: 2, muted_author: 3 });
    assert.equal(r.body.logs.length, 2);
  });

  it("RED before: safety-filters refuses, naming the totals, when the full count cannot be measured", async () => {
    install(compassWorld(), { overrides: { compass_safety_filter_logs: (calls, run) => (selectOf(calls) === "block_reason" ? run().then((r) => ({ ...r, count: null })) : null) } });
    refused(await get("/admin/compass/safety-filters?limit=2"), /safety-filter totals could not be measured/);
  });
});

describe("4b. lib/moderationCounts.ts readEveryRow (a new reader)", () => {
  const pages = (answers: Answer[]) => { let i = 0; const asked: Array<[number, number]> = []; return { asked, page: async (from: number, to: number) => { asked.push([from, to]); return answers[i++] ?? { data: [], error: null, count: 0 }; } }; };

  it("pages by the rows a page actually answered, so a cap smaller than the page size is paged through", async () => {
    const p = pages([{ data: [1, 2], error: null, count: 5 }, { data: [3, 4], error: null, count: 5 }, { data: [5], error: null, count: 5 }]);
    const r = await readEveryRow(p.page, { pageSize: 1000 });
    assert.deepEqual(r, { data: [1, 2, 3, 4, 5], error: null, count: 5 });
    assert.deepEqual(p.asked, [[0, 999], [2, 1001], [4, 1003]]);
  });

  it("an empty table is a measured empty list", async () => {
    assert.deepEqual(await readEveryRow(pages([{ data: [], error: null, count: 0 }]).page), { data: [], error: null, count: 0 });
  });

  it("a count that grows mid-read is read to its end; one that falls is refused (a later page may have shifted)", async () => {
    const grew = await readEveryRow(pages([{ data: [1], error: null, count: 2 }, { data: [2, 3], error: null, count: 3 }]).page);
    assert.deepEqual(grew.data, [1, 2, 3]);
    const fell = await readEveryRow(pages([{ data: [1, 2], error: null, count: 4 }, { data: [3], error: null, count: 2 }]).page);
    assert.equal(fell.data, null);
    assert.match(fell.error!.message, /answered no rows: rows were removed while they were read/); // wave 5, honesty 3: the count is read ONCE, so a fall shows as the pages running out short of it
  });

  it("refuses — never a shorter list — on an error, a throw, no list, no count, an empty page short of its count, or more than maxRows", async () => {
    const cases: Array<[() => Promise<any>, RegExp]> = [
      [async () => ({ data: null, error: FAIL, count: null }), /simulated failure/],
      [async () => { throw new Error("socket hang up"); }, /socket hang up/],
      [async () => ({ data: null, error: null, count: 3 }), /answered no rows to count/],
      [async () => ({ data: [1], error: null, count: null }), /without an exact count/],
      [async () => ({ data: [], error: null, count: 3 }), /answered no rows/],
      [async () => ({ data: [1], error: null, count: 9 }), /more than the 5/],
    ];
    for (const [page, why] of cases) {
      const r = await readEveryRow(page, { maxRows: 5 });
      assert.equal(r.data, null);
      assert.equal(r.count, null);
      assert.match(r.error!.message, why);
    }
  });
});

// ── 5. PATCH /admin/events/:eventId/moderate: the event_<action> audit row is required ──

describe("5. PATCH /admin/events/:eventId/moderate: claimed, audited, undone — never applied without its audit row", () => {
  const ev = (s: Seed) => s.events!.find((e) => e.id === EVENT)!;

  it("GREEN before (CONTROL): hide applies, with one activity row and one event_hide audit row", async () => {
    const s = world();
    install(s);
    const r = await call("PATCH", `/admin/events/${EVENT}/moderate`, { action: "hide", reason: "scam" });
    assert.equal(r.status, 200, r.raw);
    assert.equal(ev(s).visibility, "invite_only");
    assert.deepEqual(s.event_activity_log!.map((a) => a.action), ["admin_hide"]);
    assert.deepEqual(s.moderation_actions!.map((m) => m.action_type), ["event_hide"]);
  });

  it("RED before: a failed event_<action> audit row is a 500 that says so, the event reads as it did, and the activity row is gone — it was `200 { ok: true }`", async () => {
    for (const action of ["hide", "cancel", "remove", "feature"] as const) {
      const s = world();
      const before = { ...ev(s) };
      install(s, { strict: { writeError: { table: "moderation_actions", error: { message: "audit insert refused", code: "42501" } } } });
      const r = await call("PATCH", `/admin/events/${EVENT}/moderate`, { action });
      assert.equal(r.status, 500, `${action}: ${r.raw}`);
      assert.equal(r.body.error, "db_error");
      assert.match(r.body.message, /The moderation audit row could not be written \(audit insert refused\), so the event was restored to what it held when read\. Nothing was recorded\./);
      for (const c of ["state", "visibility", "featured"]) assert.equal(ev(s)[c], before[c], `${action}: events.${c}`);
      assert.deepEqual(s.event_activity_log, [], `${action}: no activity row records an action that did not stand`);
    }
  });

  it("RED before: warn_host with a failed audit row records nothing — it was 200", async () => {
    const s = world();
    install(s, { strict: { writeError: { table: "moderation_actions", error: { message: "audit insert refused" } } } });
    const r = await call("PATCH", `/admin/events/${EVENT}/moderate`, { action: "warn_host" });
    assert.equal(r.status, 500, r.raw);
    assert.match(r.body.message, /nothing was applied\. Nothing was recorded\./);
    assert.deepEqual(s.event_activity_log, []);
  });

  it("RED before: an action that lost a race is a 409 with NOTHING written — it overwrote the other admin's decision", async () => {
    const s = world();
    let raced = false;
    install(s, { overrides: { events: (calls, run) => {
      if (calls.some(([m]) => m === "update") && !raced) { raced = true; ev(s).visibility = "friends"; } // another admin changed it after this request read it
      return run();
    } } });
    const r = await call("PATCH", `/admin/events/${EVENT}/moderate`, { action: "hide" });
    assert.equal(r.status, 409, r.raw);
    assert.equal(r.body.error, "conflict");
    assert.equal(ev(s).visibility, "friends", "the other decision stands");
    assert.deepEqual(s.event_activity_log, []);
    assert.deepEqual(s.moderation_actions, []);
  });

  it("RED before: an event deleted between the read and the write is a 409, not `200 { ok: true }` with audit rows for nothing", async () => {
    const s = world();
    install(s, { overrides: { events: (calls, run) => {
      if (calls.some(([m]) => m === "update")) s.events = [];
      return run();
    } } });
    const r = await call("PATCH", `/admin/events/${EVENT}/moderate`, { action: "cancel" });
    assert.equal(r.status, 409, r.raw);
    assert.deepEqual(s.moderation_actions, []);
    assert.deepEqual(s.event_activity_log, []);
  });

  it("RED before: an audit failure whose undo ALSO fails is named — 'fix by hand' — never reported as restored", async () => {
    const s = world();
    let updates = 0;
    install(s, {
      strict: { writeError: { table: "moderation_actions", error: { message: "audit insert refused" } } },
      overrides: { events: (calls, run) => (calls.some(([m]) => m === "update") && ++updates === 2 ? { data: null, error: FAIL, count: null } : run()) },
    });
    const r = await call("PATCH", `/admin/events/${EVENT}/moderate`, { action: "hide" });
    assert.equal(r.status, 500, r.raw);
    assert.match(r.body.message, /the undo did not complete: the event still reads visibility = "invite_only" \(restore failed: simulated failure\).*Fix by hand\./);
    assert.equal(ev(s).visibility, "invite_only");
    assert.deepEqual(s.event_activity_log, [], "the activity row was still removed");
  });

  it("RED before (a new state): an undo never overwrites a change made after the claim — the event is left as the other writer left it, and named", async () => {
    const s = world();
    let updates = 0;
    install(s, {
      strict: { writeError: { table: "moderation_actions", error: { message: "audit insert refused" } } },
      overrides: { events: (calls, run) => {
        // Between this request's claim and its undo, another writer touches the row (a host's edit stamps updated_at).
        if (calls.some(([m]) => m === "update") && ++updates === 2) ev(s).updated_at = at(999);
        return run();
      } },
    });
    const r = await call("PATCH", `/admin/events/${EVENT}/moderate`, { action: "hide" });
    assert.equal(r.status, 500, r.raw);
    assert.match(r.body.message, /restore failed: no row matched/);
    assert.equal(ev(s).updated_at, at(999), "the later write stands");
  });

  it("GREEN before (CONTROL): an activity-log failure changes nothing (the event is restored; nothing is recorded)", async () => {
    const s = world();
    install(s, { strict: { writeError: { table: "event_activity_log", error: { message: "activity insert refused" } } } });
    const r = await call("PATCH", `/admin/events/${EVENT}/moderate`, { action: "remove" });
    assert.equal(r.status, 500, r.raw);
    assert.equal(ev(s).state, "open");
    assert.equal(ev(s).visibility, "public");
    assert.deepEqual(s.moderation_actions, []);
  });

  it("RED before (a new module): applyEventModeration guards a NULL column with `is`, and undoes on what it wrote", async () => {
    const s = world();
    ev(s).featured = null;
    const { strict } = install(s);
    const sc = (await import("../lib/supabase.js")).getServiceClient()!;
    const out = await applyEventModeration(sc, null, { id: EVENT, state: "open", visibility: "public", featured: null }, {
      changes: { featured: true }, now: at(900), activityAction: "admin_feature",
      writeActivity: () => sc.from("event_activity_log").insert({ event_id: EVENT, actor_id: ADMIN, action: "admin_feature", metadata: {} }).select("id"),
      writeAudit: () => Promise.resolve({ error: { message: "no audit" } }),
    });
    assert.deepEqual(out, { outcome: "failed", state: "restored", message: "The moderation audit row could not be written (no audit), so the event was restored to what it held when read. Nothing was recorded." });
    assert.equal(ev(s).featured, null);
    assert.deepEqual(strict.deadColumnErrors, []);
  });
});

// ── 6. place-mismatch resolve: claimed on the status read ──────────────────

describe("6. POST /admin/place-mismatch-reports/:id/resolve: one resolve wins; a lost race writes nothing", () => {
  const rep = (s: Seed) => s.place_mismatch_reports!.find((r) => r.id === MISMATCH)!;
  const post = (s: Seed) => s.posts!.find((p) => p.id === POST_A)!;

  it("GREEN before (CONTROL): accept clears the post's place and resolves the report", async () => {
    const s = world();
    install(s);
    const r = await call("POST", `/admin/place-mismatch-reports/${MISMATCH}/resolve`, { action: "accept" });
    assert.equal(r.status, 200, r.raw);
    assert.equal(post(s).canonical_place_id, null);
    assert.deepEqual([rep(s).status, rep(s).resolved_action, rep(s).resolved_by], ["resolved", "accept", ADMIN]);
  });

  it("RED before: an accept that lost the race to a reject is a 409 — the post keeps its place and the reject stands", async () => {
    const s = world();
    let raced = false;
    install(s, { overrides: {
      place_mismatch_reports: (calls, run) => {
        if (calls.some(([m]) => m === "maybeSingle") && !raced) {
          raced = true;
          // This request read 'pending'; another admin rejects it before this request writes.
          return run().then((a) => { Object.assign(rep(s), { status: "resolved", resolved_action: "reject", resolved_by: OTHER, resolved_at: at(800) }); return a; });
        }
        return run();
      },
    } });
    const r = await call("POST", `/admin/place-mismatch-reports/${MISMATCH}/resolve`, { action: "accept" });
    assert.equal(r.status, 409, r.raw);
    assert.equal(r.body.error, "already_resolved");
    assert.equal(post(s).canonical_place_id, PLACE, "the post was not cleared for a report the other admin rejected");
    assert.deepEqual([rep(s).resolved_action, rep(s).resolved_by], ["reject", OTHER]);
  });

  it("RED before: a report removed before the write is a 409, not `200 { ok: true }`", async () => {
    const s = world();
    install(s, { overrides: { place_mismatch_reports: (calls, run) => { if (calls.some(([m]) => m === "update")) s.place_mismatch_reports = []; return run(); } } });
    const r = await call("POST", `/admin/place-mismatch-reports/${MISMATCH}/resolve`, { action: "reject" });
    assert.equal(r.status, 409, r.raw);
  });

  it("RED before: a resolve that answers no rows to count is not called success", async () => {
    const s = world();
    install(s, { overrides: { place_mismatch_reports: (calls) => (calls.some(([m]) => m === "update") ? { data: null, error: null, count: null } : null) } });
    const r = await call("POST", `/admin/place-mismatch-reports/${MISMATCH}/resolve`, { action: "reject" });
    assert.equal(r.status, 500, r.raw);
    assert.match(r.body.message, /whether the report moved is unknown/);
  });

  it("GREEN before (CONTROL): an accept whose post cannot be cleared leaves the report pending, and says the claim was undone", async () => {
    const s = world();
    install(s, { strict: { writeError: { table: "posts", error: { message: "posts update refused" } } } });
    const r = await call("POST", `/admin/place-mismatch-reports/${MISMATCH}/resolve`, { action: "accept" });
    assert.equal(r.status, 500, r.raw);
    assert.deepEqual([rep(s).status, rep(s).resolved_action, rep(s).resolved_by], ["pending", null, null]);
  });

  it("RED before (a new state): a failed post clear whose undo also fails says the report reads resolved over an uncleared post", async () => {
    const s = world();
    let updates = 0;
    install(s, {
      strict: { writeError: { table: "posts", error: { message: "posts update refused" } } },
      overrides: { place_mismatch_reports: (calls, run) => (calls.some(([m]) => m === "update") && ++updates === 2 ? { data: null, error: FAIL, count: null } : run()) },
    });
    const r = await call("POST", `/admin/place-mismatch-reports/${MISMATCH}/resolve`, { action: "accept" });
    assert.equal(r.status, 500, r.raw);
    assert.match(r.body.message, /could NOT be restored \(simulated failure\).*Fix by hand\./);
  });
});

// ── 7. GET /admin/trust/reviews: the filter words ──────────────────────────

describe("7. GET /admin/trust/reviews: a status or type no review carries is a 400 naming it, never an empty queue", () => {
  it("RED before: ?status=pending is refused naming status and the vocabulary", async () => {
    install(world());
    const r = await get("/admin/trust/reviews?status=pending");
    assert.equal(r.status, 400, r.raw);
    assert.equal(r.body.error, "invalid_payload");
    assert.equal(r.body.message, "Unknown status 'pending'. One of: open, in_progress, resolved, dismissed");
  });

  it("RED before: ?type=gaming is refused naming type", async () => {
    install(world());
    const r = await get("/admin/trust/reviews?type=gaming");
    assert.equal(r.status, 400, r.raw);
    assert.match(r.body.message, /^Unknown type 'gaming'\. One of: event_review, gaming_suspected, admin_override, appeal$/);
  });

  it("RED before: a repeated ?status (an array) is refused, not matched as a string", async () => {
    install(world());
    const r = await get("/admin/trust/reviews?status=open&status=resolved");
    assert.equal(r.status, 400, r.raw);
  });

  it("GREEN before (CONTROL): a vocabulary word filters; no word is the unresolved queue", async () => {
    install(world());
    const inProgress = await get("/admin/trust/reviews?status=in_progress");
    assert.deepEqual([inProgress.status, inProgress.body.total], [200, 1]);
    const gaming = await get("/admin/trust/reviews?type=gaming_suspected");
    assert.deepEqual([gaming.status, gaming.body.total], [200, 2]);
    const all = await get("/admin/trust/reviews");
    assert.deepEqual([all.status, all.body.total], [200, 3]);
  });

  it("RED before (a new reader): parseVocabularyFilter — absent is no filter, a word is itself, anything else is named", () => {
    assert.deepEqual(parseVocabularyFilter(undefined, "status", TRUST_REVIEW_STATUSES), { ok: true, value: null });
    assert.deepEqual(parseVocabularyFilter("", "status", TRUST_REVIEW_STATUSES), { ok: true, value: null });
    assert.deepEqual(parseVocabularyFilter("dismissed", "status", TRUST_REVIEW_STATUSES), { ok: true, value: "dismissed" });
    assert.deepEqual(parseVocabularyFilter(["open"], "status", TRUST_REVIEW_STATUSES), { ok: false, message: 'Unknown status \'["open"]\'. One of: open, in_progress, resolved, dismissed' });
  });
});
