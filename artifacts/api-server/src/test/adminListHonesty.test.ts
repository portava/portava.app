/**
 * census-trust (wave 5, 2026-10-18) — admin moderation surfaces: no zero or
 * empty list from a failed read.
 *
 * Run: env -i PATH="$PATH" HOME=$TMPDIR TMPDIR=$TMPDIR TZ=UTC \
 *      SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/adminListHonesty.test.ts
 * The route cases listen on 127.0.0.1 (run with loopback allowed).
 *
 * THE CLASS. c9c7933db and 4140b5ad8 closed it for the user detail's
 * openReports and the two legacy report lists, and listed the rest of it. An
 * admin surface rendered a read it could not make, or a read that answered no
 * list or no count, as an empty queue or a zero:
 *   - adminMedia's five lists, the trust review queue, the place-image queue and
 *     reports list, the place-mismatch list and GET /me/reports answered
 *     `total: count ?? 0`; gaming-flags answered `total: (data ?? []).length`;
 *   - adminMedia's Reported and Wrong Place tabs matched `status` EXACTLY,
 *     defaulting to 'open', so every in_review report was in no tab, and a word
 *     no report carries answered an empty page;
 *   - enrichment reads were unchecked: a failed thumbnail read showed no media,
 *     a failed pending-report read showed reportCount 0, a failed user-report
 *     read showed no reports, a failed place-mismatch cursor read served page 1
 *     again as the next page;
 *   - the Compass dashboard folded every Promise.allSettled element to `[]` /
 *     `0`, so a failed read showed zero abuse flags and zero safety-filter fires;
 *   - failedModerationReads (user detail, summary, moderation-summary) refused a
 *     RETURNED error only, so a no-error answer with no list rendered a clean
 *     record; the profile read's error answered 404 "User not found";
 *   - the reported-trips and reported-events queues DROPPED a report whose
 *     trip/event no longer exists, and the trips queue read with no limit.
 *
 * THE CONVENTION, per route. Every one of these routes already refuses a
 * RETURNED error with db_error, and none of them has an explicit "unknown"
 * field, so a list or count it cannot measure is refused the same way, NAMING
 * what could not be read. A status filter outside the vocabulary is a 400 that
 * names it. Nothing here falls open on moderation or safety data.
 *
 * DOUBLES. Every route runs on schemaStrictSupabase (each column checked
 * against the live schema; 42703 otherwise) with four additions, each stated
 * where it is made: `.range(lo, hi)` — and `.limit(n)` on a read that asked
 * for a count — slices the answer as PostgREST does (`count` stays the whole
 * match); `.ilike` matches exactly; `.or` is a no-op
 * (only the summary's block count uses it, over an empty table); and a
 * per-table OVERRIDE may replace one statement's answer — after the statement
 * was built, so its schema check has already run — to stage a failed, thrown or
 * count-less read. Each case says whether it was RED or GREEN on the code
 * before this change (4140b5ad8).
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import { makeSchemaStrictClient, type Seed, type Row, type SchemaStrictOptions } from "./helpers/schemaStrictSupabase.js";
import adminRouter from "../routes/admin.js";
import adminMediaRouter from "../routes/adminMedia.js";
import trustAdminRouter from "../routes/trust-admin.js";
import adminPlaceImagesRouter from "../routes/adminPlaceImages.js";
import adminPlaceMismatchRouter from "../routes/adminPlaceMismatch.js";
import adminCompassRouter from "../routes/adminCompass.js";
import reportsRouter from "../routes/reports.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dir, "../../../..");

const ADMIN    = "a1111111-1111-4111-8111-1111111170a0";
const REPORTER = "a2222222-2222-4222-8222-2222222270a0";
const OWNER    = "a3333333-3333-4333-8333-3333333370a0";
const POST_A   = "b1111111-1111-4111-8111-1111111170a0";
const POST_B   = "b1111111-1111-4111-8111-1111111170a1";
const GEM      = "b2222222-2222-4222-8222-2222222270a0";
const TRIP     = "b3333333-3333-4333-8333-3333333370a0";
const GONE_TRIP  = "b3333333-3333-4333-8333-3333333370ff";
const EVENT    = "b4444444-4444-4444-8444-4444444470a0";
const GONE_EVENT = "b4444444-4444-4444-8444-4444444470ff";
const PLACE    = "b5555555-5555-4555-8555-5555555570a0";
const VISUAL   = "b6666666-6666-4666-8666-6666666670a0";
const IMG_URL  = "https://cdn.example.invalid/place-a.jpg";
const TOKENS: Record<string, string> = { "admin-token": ADMIN, "reporter-token": REPORTER };
const FAIL = { message: "simulated read failure", code: "57014" };

const at = (n: number) => new Date(Date.UTC(2026, 9, 1, 0, 0, n)).toISOString();

function profile(id: string, handle: string, role = "user"): Row {
  return { id, handle, username: handle, name: `${handle} name`, display_name: `${handle} display`, bio: null, avatar_url: null, role, verified: false, verification_status: "unverified", account_status: "active", created_at: at(0) };
}
function report(id: string, target_type: string, target_id: string, status: string, n: number): Row {
  return { id, reporter_id: REPORTER, target_type, target_id, reason_code: "spam", reason_detail: null, severity: "normal", status, moderation_notes: null, reviewed_by: null, reviewed_at: null, created_at: at(n), updated_at: at(n) };
}
const rid = (n: number) => `c0000000-0000-4000-8000-0000000070${String(n).padStart(2, "0")}`;

function world(): Seed {
  return {
    profiles: [profile(ADMIN, "admin", "admin"), profile(REPORTER, "reporter"), profile(OWNER, "owner")],
    admin_access_log: [], feature_flags: [], user_account_states: [], compass_settings: [], moderation_actions: [],
    blocks: [], user_mutes: [], user_restrictions: [], trust_restrictions: [], event_activity_log: [],
    reports: [],
    posts: [
      { id: POST_A, author_id: OWNER, has_video: false, visibility: "public", post_status: "published", created_at: at(1) },
      { id: POST_B, author_id: OWNER, has_video: false, visibility: "public", post_status: "published", created_at: at(2) },
    ],
    post_media: [
      { id: "d1111111-1111-4111-8111-1111111170a0", post_id: POST_A, media_type: "image", processing_status: "failed", moderation_status: "approved", public_url: "https://cdn.example.invalid/a.jpg", thumbnail_url: null, storage_path: "a.jpg", storage_bucket: "post-media", sort_order: 0, created_at: at(3), updated_at: at(3) },
    ],
    hidden_gems: [{ id: GEM, name: "Gem", category: "food", city: "Da Nang", submitted_by: OWNER, status: "pending", description: null, vibe_tags: [], image_url: null, created_at: at(4), updated_at: at(4) }],
    generated_visuals: [
      { id: VISUAL, entity_type: "place", entity_id: PLACE, canonical_place_id: PLACE, image_source_type: "reference_grounded_ai", accuracy_status: "unverified", source_url: IMG_URL, generated_with_ai: true, disclaimer_required: true, verified_by: null, verified_at: null, created_at: at(5) },
      { id: "b6666666-6666-4666-8666-6666666670a1", entity_type: "post", entity_id: POST_A, image_source_type: "generic_ai_illustration", accuracy_status: "unverified", source_url: null, generated_with_ai: true, disclaimer_required: true, created_at: at(6) },
    ],
    places: [{ id: PLACE, name: "Place A", primary_category: "cafe", city: "Da Nang", country_code: "VN", latitude: 16.05, longitude: 108.2 }],
    place_image_reports: [
      { id: "e1111111-1111-4111-8111-1111111170a0", image_url: IMG_URL, place_id: PLACE, reported_by: REPORTER, report_reason: "wrong_place", status: "pending", created_at: at(7) },
      { id: "e1111111-1111-4111-8111-1111111170a1", image_url: IMG_URL, place_id: PLACE, reported_by: OWNER, report_reason: "wrong_place", status: "pending", created_at: at(8) },
    ],
    place_mismatch_reports: [
      { id: "e2222222-2222-4222-8222-2222222270a0", post_id: POST_A, reporter_id: REPORTER, reported_place_id: PLACE, reason: "wrong_city", status: "pending", resolved_action: null, resolved_at: null, created_at: at(9) },
      { id: "e2222222-2222-4222-8222-2222222270a1", post_id: POST_B, reporter_id: REPORTER, reported_place_id: PLACE, reason: "wrong_city", status: "pending", resolved_action: null, resolved_at: null, created_at: at(10) },
    ],
    trust_reviews: [
      { id: "e3333333-3333-4333-8333-3333333370a0", user_id: OWNER, review_type: "gaming_suspected", status: "open", source_event_id: null, assigned_to: null, notes: null, metadata: {}, created_at: at(11) },
      { id: "e3333333-3333-4333-8333-3333333370a1", user_id: REPORTER, review_type: "gaming_suspected", status: "open", source_event_id: null, assigned_to: null, notes: null, metadata: {}, created_at: at(12) },
      { id: "e3333333-3333-4333-8333-3333333370a2", user_id: ADMIN, review_type: "gaming_suspected", status: "in_progress", source_event_id: null, assigned_to: null, notes: null, metadata: {}, created_at: at(13) },
    ],
    trips: [{ id: TRIP, owner_id: OWNER, title: "Reported trip", visibility: "public", status: "planning", created_at: at(14) }],
    events: [{ id: EVENT, host_id: OWNER, title: "Reported event", state: "open", visibility: "public", city: "Da Nang", starts_at: at(15), created_at: at(15), featured: false }],
    compass_abuse_flags: [
      { id: "e4444444-4444-4444-8444-4444444470a0", pattern_type: "ring", involved_users: [OWNER], severity: "high", status: "open", evidence: {}, detected_at: new Date().toISOString() },
      { id: "e4444444-4444-4444-8444-4444444470a1", pattern_type: "ring", involved_users: [REPORTER], severity: "low", status: "open", evidence: {}, detected_at: new Date().toISOString() },
    ],
    compass_safety_filter_logs: [{ id: "e5555555-5555-4555-8555-5555555570a0", viewer_id: REPORTER, item_id: POST_A, item_type: "post", block_reason: "blocked_author", author_id: OWNER, created_at: new Date().toISOString() }],
    compass_feed_cache: [], compass_active_user_scores: [], compass_notification_decisions: [], compass_algorithm_versions: [],
    compass_feedback_events: [], user_location_state: [], rent_buddy_profiles: [],
  };
}

type Call = [string, unknown[]];
type Answer = { data: unknown; error: unknown; count?: unknown };
/** Addition 4: replace one statement's answer. `run` executes the real statement; not calling it means it never ran. */
type Override = (calls: Call[], run: () => Promise<Answer>) => Answer | Promise<Answer> | null | undefined;
interface InstallOptions { overrides?: Partial<Record<string, Override>>; strict?: SchemaStrictOptions; listUsers?: () => Promise<unknown> }

function install(seed: Seed, o: InstallOptions = {}) {
  const strict = makeSchemaStrictClient(seed, o.strict);
  const statements: Array<{ table: string; calls: Call[] }> = [];
  const from = (table: string) => {
    const b = strict.from(table);
    const calls: Call[] = [];
    statements.push({ table, calls });
    for (const m of ["select", "eq", "neq", "in", "is", "not", "gt", "gte", "lt", "lte", "order", "update", "insert", "upsert", "delete"]) {
      const orig = b[m];
      b[m] = (...args: unknown[]) => { calls.push([m, args]); return orig(...args); };
    }
    // Addition 1b: on a read that asked for a count, `.limit(n)` also slices the answer instead (the double counts
    // AFTER its limit; PostgREST's Content-Range counts the whole match). Any other `.limit` is the double's own.
    const origLimit = b.limit;
    let lim: number | null = null;
    b.limit = (n: number) => { calls.push(["limit", [n]]); if (calls.some(([m, a]) => m === "select" && (a[1] as any)?.count)) { lim = n; return b; } return origLimit(n); };
    // Addition 2: `.ilike` as an exact match (the handles here are lower-case); addition 3: `.or` a no-op.
    b.ilike = (col: string, v: unknown) => b.eq(col, v);
    b.or = (f: string) => { calls.push(["or", [f]]); return b; };
    // Addition 1: `.range(lo, hi)` slices the answer; `count` stays the whole match, as PostgREST's Content-Range.
    let rng: [number, number] | null = null;
    b.range = (lo: number, hi: number) => { calls.push(["range", [lo, hi]]); rng = [lo, hi]; return b; };
    const slice = (a: Answer): Answer => {
      if (!Array.isArray(a?.data)) return a;
      let rows = a.data as unknown[];
      if (rng) rows = rows.slice(rng[0], rng[1] + 1);
      if (lim !== null) rows = rows.slice(0, lim);
      return { ...a, data: rows };
    };
    const ov = o.overrides?.[table];
    const gate = (run: () => Promise<Answer>): Promise<Answer> => {
      try { const r = ov?.(calls, run); return r == null ? run() : Promise.resolve(r); } catch (e) { return Promise.reject(e); }
    };
    const origThen = b.then, origMaybe = b.maybeSingle, origSingle = b.single;
    b.then = (onF: any, onR: any) => gate(() => new Promise<Answer>((res, rej) => origThen(res, rej)).then(slice)).then(onF, onR);
    b.maybeSingle = () => { calls.push(["maybeSingle", []]); return gate(() => origMaybe()); };
    b.single = () => { calls.push(["single", []]); return gate(() => origSingle()); };
    return b;
  };
  const client = {
    from,
    rpc: strict.rpc,
    auth: {
      getUser: async (token: string) => (TOKENS[token]
        ? { data: { user: { id: TOKENS[token] } }, error: null }
        : { data: { user: null }, error: { message: "bad token", status: 401 } }),
      admin: {
        listUsers: o.listUsers ?? (async () => ({ data: { users: [{ id: ADMIN, email: "admin@example.invalid" }, { id: OWNER, email: "owner@example.invalid" }] }, error: null })),
      },
    },
  };
  _setTestClient(client, true);
  _setTestServiceClient(client as any);
  return { strict, seed, statements };
}

/** A statement that is a list read (not a HEAD count, not a write, not maybeSingle). */
const isListRead = (calls: Call[]) => !calls.some(([m]) => m === "update" || m === "insert" || m === "maybeSingle") && !calls.some(([m, a]) => m === "select" && (a[1] as any)?.head === true);
/** The real answer with its count removed: rows came back, nobody measured how many there are. */
const countless: Override = (calls, run) => (isListRead(calls) ? run().then((r) => ({ ...r, count: null })) : null);
/** A no-error answer that is not a list. */
const listless: Override = (calls, run) => (isListRead(calls) ? { data: null, error: null, count: null } : null);
const failed: Override = (calls) => (isListRead(calls) ? { data: null, error: FAIL, count: null } : null);

let server: http.Server;
let base = "";
before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.log = { error() {}, warn() {}, info() {}, debug() {} }; next(); });
  app.use(reportsRouter);
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

async function call(method: string, path: string, token = "admin-token", body?: unknown): Promise<{ status: number; body: any; raw: string }> {
  const r = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const raw = await r.text();
  let parsed: any; try { parsed = JSON.parse(raw); } catch { parsed = raw; }
  return { status: r.status, body: parsed, raw };
}
const get = (path: string, token?: string) => call("GET", path, token);

function refused(r: { status: number; body: any; raw: string }, name: RegExp) {
  assert.equal(r.status, 500, r.raw);
  assert.equal(r.body.error, "db_error", r.raw);
  assert.match(r.body.message, name, `the refusal names what could not be read: ${r.raw}`);
}

// ── 1. adminMedia: the Reported and Wrong Place tabs ─────────────────────────

describe("adminMedia: the Reported and Wrong Place tabs list every UNRESOLVED report, and refuse a word no report carries", () => {
  function mediaWorld() {
    const s = world();
    s.reports = [
      report(rid(1), "post", POST_A, "open", 20), report(rid(2), "post", POST_B, "in_review", 21), report(rid(3), "post", POST_A, "resolved", 22),
      report(rid(4), "hidden_gem", GEM, "open", 23), report(rid(5), "hidden_gem", GEM, "in_review", 24), report(rid(6), "hidden_gem", GEM, "dismissed", 25),
    ];
    return s;
  }

  it("RED before: GET /admin/media/reported with no status lists the open AND the in_review report, not the resolved one", async () => {
    const { strict } = install(mediaWorld());
    const r = await get("/admin/media/reported");
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(strict.deadColumnErrors, []);
    assert.deepEqual(r.body.items.map((i: any) => i.id).sort(), [rid(1), rid(2)]);
    assert.deepEqual(r.body.pagination, { page: 1, limit: 20, total: 2, hasMore: false });
  });

  it("RED before: GET /admin/media/wrong-place with no status lists the open AND the in_review gem report", async () => {
    install(mediaWorld());
    const r = await get("/admin/media/wrong-place");
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(r.body.items.map((i: any) => i.id).sort(), [rid(4), rid(5)]);
    assert.equal(r.body.pagination.total, 2);
  });

  it("RED before: a status no report carries is a 400 that names it — never an empty tab", async () => {
    install(mediaWorld());
    for (const path of ["/admin/media/reported?status=pending", "/admin/media/wrong-place?status=reviewed"]) {
      const r = await get(path);
      assert.equal(r.status, 400, `${path}: ${r.raw}`);
      assert.equal(r.body.error, "invalid_payload");
      assert.match(r.body.message, /Unknown status '(pending|reviewed)'. One of: unresolved, all, open, in_review, resolved, dismissed/);
    }
  });

  it("GREEN before (CONTROL): status=all lists every report, and a vocabulary word filters to it", async () => {
    install(mediaWorld());
    const all = await get("/admin/media/reported?status=all");
    assert.deepEqual(all.body.items.map((i: any) => i.id).sort(), [rid(1), rid(2), rid(3)]);
    const resolvedOnly = await get("/admin/media/reported?status=resolved");
    assert.deepEqual(resolvedOnly.body.items.map((i: any) => i.id), [rid(3)]);
    const open = await get("/admin/media/wrong-place?status=open");
    assert.deepEqual(open.body.items.map((i: any) => i.id), [rid(4)]);
  });

  it("RED before: the admin client's two tabs no longer ask for 'open' alone", () => {
    const screen = readFileSync(join(REPO, "travel-buddy-standalone/app/admin/media/index.tsx"), "utf8");
    const calls = [...screen.matchAll(/await (getMediaReported|getMediaWrongPlace)\(([^)]*)\)/g)];
    assert.equal(calls.length, 2, "both tab loaders were found");
    for (const c of calls) assert.doesNotMatch(c[2]!, /status/, `${c[1]} asks for the server's default, every unresolved report: ${c[0]}`);
  });
});

// ── 2. adminMedia: totals and enrichment reads ──────────────────────────────

describe("adminMedia: a list total is measured, and an enrichment read that fails is named — never 0, null or []", () => {
  const LISTS: Array<[string, string, RegExp]> = [
    ["/admin/media/processing-failures", "post_media", /processing-failures list answered without an exact total/],
    ["/admin/media/reported", "reports", /reported posts list answered without an exact total/],
    ["/admin/media/wrong-place", "reports", /wrong-place reports list answered without an exact total/],
    ["/admin/media/gems-pending", "hidden_gems", /pending gems list answered without an exact total/],
    ["/admin/media/ai-provenance", "generated_visuals", /AI-provenance list answered without an exact total/],
  ];
  const seeded = () => { const s = world(); s.reports = [report(rid(1), "post", POST_A, "open", 20), report(rid(4), "hidden_gem", GEM, "open", 23)]; return s; };

  for (const [path, table, message] of LISTS) {
    it(`RED before: ${path} — rows with no count is refused, not \`total: 0, hasMore: false\``, async () => {
      install(seeded(), { overrides: { [table]: countless } });
      refused(await get(path), message);
    });
    it(`RED before: ${path} — a count smaller than the page it came with is refused`, async () => {
      install(seeded(), { overrides: { [table]: (calls, run) => (isListRead(calls) ? run().then((r) => ({ ...r, count: 0 })) : null) } });
      refused(await get(path), message);
    });
  }

  it("GREEN before (CONTROL): a healthy page reports its exact total and hasMore across pages", async () => {
    const s = world();
    s.reports = [20, 21, 22].map((n, i) => report(rid(i + 1), "post", POST_A, "open", n));
    install(s);
    const p1 = await get("/admin/media/reported?limit=2&page=1");
    assert.deepEqual(p1.body.pagination, { page: 1, limit: 2, total: 3, hasMore: true }, p1.raw);
    const p2 = await get("/admin/media/reported?limit=2&page=2");
    assert.equal(p2.status, 200, p2.raw);
    assert.deepEqual(p2.body.pagination, { page: 2, limit: 2, total: 3, hasMore: false });
    assert.equal(p2.body.items.length, 1);
  });

  it("RED before: a failed thumbnail read is refused naming primaryMedia — not a reported post with no media", async () => {
    install(seeded(), { overrides: { post_media: failed } });
    refused(await get("/admin/media/reported"), /\(primaryMedia\)/);
  });

  it("RED before: a failed posts read on processing-failures is refused naming post — not an item with no post", async () => {
    install(world(), { overrides: { posts: failed } });
    refused(await get("/admin/media/processing-failures"), /\(post\)/);
  });

  it("GREEN before (CONTROL): the thumbnail and post enrichments render when their reads succeed", async () => {
    install(seeded());
    const rep = await get("/admin/media/reported");
    assert.equal(rep.body.items[0].primaryMedia.public_url, "https://cdn.example.invalid/a.jpg", rep.raw);
    const pf = await get("/admin/media/processing-failures");
    assert.equal(pf.body.items[0].post.author_id, OWNER, pf.raw);
  });
});

// ── 3. trust-admin ───────────────────────────────────────────────────────────

describe("trust-admin: the review queue and gaming flags answer a measured total", () => {
  it("RED before: GET /admin/trust/reviews with no count is refused, not `total: 0`", async () => {
    install(world(), { overrides: { trust_reviews: countless } });
    refused(await get("/admin/trust/reviews"), /trust review queue list answered without an exact total/);
  });

  it("GREEN before (CONTROL): GET /admin/trust/reviews answers the queue's exact total", async () => {
    const { strict } = install(world());
    const r = await get("/admin/trust/reviews?limit=2");
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(strict.deadColumnErrors, []);
    assert.equal(r.body.total, 3);
    assert.equal(r.body.reviews.length, 2);
  });

  it("RED before: GET /admin/trust/gaming-flags answers the queue's size, not the page's length", async () => {
    install(world());
    const r = await get("/admin/trust/gaming-flags?limit=2");
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.flags.length, 2);
    assert.equal(r.body.total, 3, "three suspected accounts, two on this page");
  });

  it("RED before: a no-error answer with no list is refused — not `flags: [], total: 0`", async () => {
    install(world(), { overrides: { trust_reviews: listless } });
    refused(await get("/admin/trust/gaming-flags"), /gaming-flag list answered without an exact total/);
  });
});

// ── 4. place images ──────────────────────────────────────────────────────────

describe("adminPlaceImages: totals are measured; the report counts, review history, place and user reports are never assumed", () => {
  it("RED before: the review queue with no count is refused", async () => {
    install(world(), { overrides: { generated_visuals: countless } });
    refused(await get("/admin/place-images/queue"), /place-image review queue list answered without an exact total/);
  });

  it("RED before: a failed pending-report read is refused naming reportCount — not reportCount 0", async () => {
    install(world(), { overrides: { place_image_reports: failed } });
    refused(await get("/admin/place-images/queue"), /\(reportCount\)/);
  });

  it("GREEN before (CONTROL): the queue counts the image's two pending reports", async () => {
    const { strict } = install(world());
    const r = await get("/admin/place-images/queue");
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(strict.deadColumnErrors, []);
    assert.equal(r.body.items.find((i: any) => i.id === VISUAL).reportCount, 2);
    assert.equal(r.body.pagination.total, 1);
  });

  it("RED before: the reports list with no count is refused", async () => {
    install(world(), { overrides: { place_image_reports: countless } });
    refused(await get("/admin/place-images/reports"), /place-image report list answered without an exact total/);
  });

  it("RED before: a failed review-history read is refused naming priorReviewActions — not 'never reviewed'", async () => {
    install(world(), { overrides: { generated_visuals: failed } });
    refused(await get("/admin/place-images/reports"), /\(priorReviewActions\)/);
  });

  it("RED before: the detail refuses a failed user-report read naming userReports — not 'nobody reported it'", async () => {
    install(world(), { overrides: { place_image_reports: failed } });
    refused(await get(`/admin/place-images/${VISUAL}`), /\(userReports\)/);
  });

  it("RED before: the detail refuses a failed place read naming place — not 'no such place'", async () => {
    install(world(), { overrides: { places: (calls) => (calls.some(([m]) => m === "maybeSingle") ? { data: null, error: FAIL } : null) } });
    refused(await get(`/admin/place-images/${VISUAL}`), /\(place\)/);
  });

  it("GREEN before (CONTROL): the detail renders its place and both user reports", async () => {
    install(world());
    const r = await get(`/admin/place-images/${VISUAL}`);
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.place.id, PLACE);
    assert.equal(r.body.userReports.length, 2);
  });
});

// ── 5. place mismatch ────────────────────────────────────────────────────────

describe("adminPlaceMismatch: the total is measured and the page cursor is read, not assumed", () => {
  const OLDER = "e2222222-2222-4222-8222-2222222270a0";
  const NEWER = "e2222222-2222-4222-8222-2222222270a1";

  it("RED before: the list with no count is refused, not `total: 0`", async () => {
    install(world(), { overrides: { place_mismatch_reports: countless } });
    refused(await get("/admin/place-mismatch-reports"), /place-mismatch report list answered without an exact total/);
  });

  it("GREEN before (CONTROL): `before` pages past the cursor", async () => {
    const { strict } = install(world());
    const r = await get(`/admin/place-mismatch-reports?before=${NEWER}`);
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(strict.deadColumnErrors, []);
    assert.deepEqual(r.body.reports.map((x: any) => x.id), [OLDER]);
    assert.equal(r.body.total, 1);
  });

  it("RED before: a failed cursor read is refused — it served page 1 again as if it were the next page", async () => {
    install(world(), { overrides: { place_mismatch_reports: (calls) => (calls.some(([m]) => m === "maybeSingle") ? { data: null, error: FAIL } : null) } });
    refused(await get(`/admin/place-mismatch-reports?before=${NEWER}`), /page cursor could not be read/);
  });

  it("RED before: a cursor that names no report is a 400 — not page 1 again", async () => {
    install(world());
    const r = await get("/admin/place-mismatch-reports?before=e2222222-2222-4222-8222-2222222270ff");
    assert.equal(r.status, 400, r.raw);
    assert.match(r.body.message, /`before` names no report/);
  });

  it("RED before: resolve answers a failed report read with db_error, not 404", async () => {
    install(world(), { overrides: { place_mismatch_reports: (calls) => (calls.some(([m]) => m === "maybeSingle") ? { data: null, error: FAIL } : null) } });
    const r = await call("POST", `/admin/place-mismatch-reports/${OLDER}/resolve`, "admin-token", { action: "reject" });
    assert.equal(r.status, 500, r.raw);
    assert.equal(r.body.error, "db_error");
  });
});

// ── 6. Compass dashboard and observability ──────────────────────────────────

describe("adminCompass: a failed, thrown or count-less section is NAMED and the dashboard refused — never zero abuse flags", () => {
  it("GREEN before (CONTROL): a healthy dashboard counts the abuse flags and safety-filter fires", async () => {
    const { strict } = install(world());
    const r = await get("/admin/compass/dashboard");
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(strict.deadColumnErrors, []);
    assert.equal(r.body.abuse.total, 2);
    assert.deepEqual(r.body.abuse.bySeverity, { high: 1, low: 1 });
    assert.equal(r.body.safetyFilterFires.total, 1);
    assert.equal(r.body.delayedPosts.pendingCount, 0, "a measured zero still renders");
  });

  it("RED before: a failed abuse-flag read refuses the dashboard naming `abuse` — it showed abuse.total 0", async () => {
    install(world(), { overrides: { compass_abuse_flags: failed } });
    refused(await get("/admin/compass/dashboard"), /Dashboard incomplete: abuse could not be read/);
  });

  it("RED before: a THROWN safety-filter read refuses naming `safetyFilterFires`", async () => {
    install(world(), { overrides: { compass_safety_filter_logs: () => { throw new Error("simulated thrown read"); } } });
    refused(await get("/admin/compass/dashboard"), /Dashboard incomplete: safetyFilterFires could not be read/);
  });

  it("RED before: a count-less metric refuses naming it — delayedPosts.pendingCount was 0", async () => {
    install(world(), { overrides: { posts: (calls, run) => (calls.some(([m, a]) => m === "in" && a[0] === "post_status") ? run().then((r) => ({ ...r, count: null })) : null) } });
    refused(await get("/admin/compass/dashboard"), /Dashboard incomplete: delayedPosts\.pendingCount could not be read/);
  });

  it("RED before: GET /admin/compass/abuse-flags refuses a no-error answer with no list — not `flags: []`", async () => {
    install(world(), { overrides: { compass_abuse_flags: listless } });
    refused(await get("/admin/compass/abuse-flags"), /abuse flags could not be read/);
  });

  it("RED before: GET /admin/compass/safety-filters refuses a no-error answer with no list — not `total: 0`", async () => {
    install(world(), { overrides: { compass_safety_filter_logs: listless } });
    refused(await get("/admin/compass/safety-filters"), /safety-filter logs could not be read/);
  });
});

// ── 7. GET /me/reports ───────────────────────────────────────────────────────

describe("GET /me/reports answers a measured total", () => {
  const mine = () => { const s = world(); s.reports = [report(rid(1), "post", POST_A, "open", 20), report(rid(2), "post", POST_B, "resolved", 21)]; return s; };

  it("GREEN before (CONTROL): the reporter's two reports and their exact total", async () => {
    install(mine());
    const r = await get("/me/reports", "reporter-token");
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.total, 2);
    assert.equal(r.body.reports.length, 2);
    assert.equal("reporter_id" in r.body.reports[0], false);
  });

  it("RED before: rows with no count are refused — not `total: 0`", async () => {
    install(mine(), { overrides: { reports: countless } });
    const r = await get("/me/reports", "reporter-token");
    assert.equal(r.status, 500, r.raw);
    assert.equal(r.body.error, "db_error");
  });
});

// ── 8. the moderation dossier: failedModerationReads ────────────────────────

describe("the admin user record refuses a no-error answer with no list — never a clean record", () => {
  /** The list read of `table` answers no error and no list; every other read is untouched. */
  const listlessOn = (pred: (calls: Call[]) => boolean): Override => (calls) => (pred(calls) && isListRead(calls) ? { data: null, error: null } : null);

  it("RED before: user detail — accountStates answering no list refuses the record naming accountStates", async () => {
    install(world(), { overrides: { user_account_states: listlessOn((c) => c.some(([m, a]) => m === "eq" && a[0] === "user_id")) } });
    const r = await get(`/admin/users?email=${encodeURIComponent("owner@example.invalid")}`);
    refused(r, /Moderation record incomplete: accountStates could not be read/);
  });

  it("RED before: summary — moderationActions and reportsReceived answering no list are both named", async () => {
    install(world(), {
      overrides: {
        moderation_actions: listlessOn(() => true),
        reports: listlessOn((c) => c.some(([m, a]) => m === "eq" && a[0] === "target_id")),
      },
    });
    refused(await get(`/admin/users/${OWNER}/summary`), /Moderation record incomplete: moderationActions, reportsReceived could not be read/);
  });

  it("RED before: moderation-summary — reportsFiled answering no list is named", async () => {
    install(world(), { overrides: { reports: listlessOn((c) => c.some(([m, a]) => m === "eq" && a[0] === "reporter_id")) } });
    refused(await get(`/admin/users/${OWNER}/moderation-summary`), /Moderation record incomplete: reportsFiled could not be read/);
  });

  it("GREEN before (CONTROL): a healthy summary and moderation-summary render", async () => {
    const { strict } = install(world());
    const s = await get(`/admin/users/${OWNER}/summary`);
    assert.equal(s.status, 200, s.raw);
    assert.deepEqual(strict.deadColumnErrors, []);
    assert.deepEqual([s.body.accountStates, s.body.moderationActions, s.body.reportsReceived, s.body.blockCount], [[], [], [], 0]);
    const m = await get(`/admin/users/${OWNER}/moderation-summary`);
    assert.equal(m.status, 200, m.raw);
  });

  it("RED before: a failed profile read is db_error on summary and moderation-summary — it answered 404 'User not found'", async () => {
    const profileFails: Override = (calls) => (calls.some(([m]) => m === "maybeSingle") && calls.some(([m, a]) => m === "eq" && a[0] === "id" && a[1] === OWNER) ? { data: null, error: FAIL } : null);
    install(world(), { overrides: { profiles: profileFails } });
    for (const path of [`/admin/users/${OWNER}/summary`, `/admin/users/${OWNER}/moderation-summary`]) {
      const r = await get(path);
      refused(r, /The profile could not be read/);
    }
  });

  it("RED before: user detail by email — a failed account lookup is db_error, not 'User not found'", async () => {
    install(world(), { listUsers: async () => ({ data: null, error: { message: "auth admin unavailable" } }) });
    refused(await get(`/admin/users?email=${encodeURIComponent("owner@example.invalid")}`), /account lookup by email could not run/);
  });
});

// ── 9. the reported-trips and reported-events queues ────────────────────────

describe("the trip and event report queues: a report whose parent is gone is SHOWN, and the queue pages with a measured total", () => {
  const queueWorld = () => {
    const s = world();
    s.reports = [
      report(rid(1), "trip", TRIP, "open", 30), report(rid(2), "trip", GONE_TRIP, "open", 31), report(rid(3), "trip", TRIP, "resolved", 32),
      report(rid(4), "event", EVENT, "in_review", 33), report(rid(5), "event", GONE_EVENT, "open", 34),
    ];
    return s;
  };

  it("RED before: GET /admin/trips shows the report against a deleted trip, marked missing — it was dropped", async () => {
    const { strict } = install(queueWorld());
    const r = await get("/admin/trips");
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(strict.deadColumnErrors, []);
    const gone = r.body.trips.find((t: any) => t.tripId === GONE_TRIP);
    assert.ok(gone, `the safety report stays in the queue: ${r.raw}`);
    assert.deepEqual([gone.trip, gone.tripMissing, gone.pendingReports, gone.reports.map((x: any) => x.id)], [null, true, 1, [rid(2)]]);
    const live = r.body.trips.find((t: any) => t.tripId === TRIP);
    assert.deepEqual([live.trip.id, live.tripMissing], [TRIP, false]);
    assert.equal(r.body.total, 2);
  });

  it("RED before: GET /admin/events?reported=true shows the report against a deleted event, marked missing", async () => {
    install(queueWorld());
    const r = await get("/admin/events?reported=true");
    assert.equal(r.status, 200, r.raw);
    const gone = r.body.events.find((e: any) => e.eventId === GONE_EVENT);
    assert.ok(gone, r.raw);
    assert.deepEqual([gone.event, gone.eventMissing, gone.pendingReports], [null, true, 1]);
    assert.equal(r.body.events.find((e: any) => e.eventId === EVENT).event.id, EVENT);
    assert.equal(r.body.total, 2);
  });

  it("RED before: the trips queue pages (?page, ?limit) and answers the whole queue's total — it read every report with no limit", async () => {
    const { statements } = install(queueWorld());
    const r = await get("/admin/trips?limit=1&page=2");
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual([r.body.total, r.body.page, r.body.trips.length], [2, 2, 1]);
    assert.equal(r.body.trips[0].tripId, TRIP, "newest first: page 2 holds the older report");
    const read = statements.find((s) => s.table === "reports")!;
    assert.deepEqual(read.calls.find(([m]) => m === "range"), ["range", [1, 1]]);
  });

  it("GREEN before (CONTROL): the events queue limit still bounds its reports read", async () => {
    const s = world();
    s.reports = [report(rid(4), "event", EVENT, "open", 33), report(rid(6), "event", EVENT, "in_review", 35)];
    install(s);
    const r = await get("/admin/events?reported=true&limit=1");
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.events.length, 1);
    assert.deepEqual(r.body.events[0].reports.map((x: any) => x.id), [rid(6)], "the newest report, one per page");
  });

  it("RED before: a queue page with no count is refused (trips and events)", async () => {
    install(queueWorld(), { overrides: { reports: countless } });
    refused(await get("/admin/trips"), /reported-trips queue answered without an exact total/);
    refused(await get("/admin/events?reported=true"), /reported-events queue answered without an exact total/);
  });

  it("RED before: a no-error trips answer with no list is refused — not a queue of missing trips", async () => {
    install(queueWorld(), { overrides: { trips: listless } });
    refused(await get("/admin/trips"), /reported trips could not be read/);
  });
});

// ── 10. the shared readers, as units ────────────────────────────────────────

describe("lib/moderationCounts.ts: the status filter, page totals and settled answers", () => {
  it("RED before (a new reader): parseLegacyReportStatusFilter: unresolved by default, all, a vocabulary word; anything else refused by name", async () => {
    const { parseLegacyReportStatusFilter } = await import("../lib/moderationCounts.js") as any;
    assert.deepEqual(parseLegacyReportStatusFilter(undefined), { ok: true, statuses: ["open", "in_review"] });
    assert.deepEqual(parseLegacyReportStatusFilter(""), { ok: true, statuses: ["open", "in_review"] });
    assert.deepEqual(parseLegacyReportStatusFilter("unresolved"), { ok: true, statuses: ["open", "in_review"] });
    assert.deepEqual(parseLegacyReportStatusFilter("all"), { ok: true, statuses: null });
    assert.deepEqual(parseLegacyReportStatusFilter("dismissed"), { ok: true, statuses: ["dismissed"] });
    for (const bad of ["pending", "reviewed", "OPEN", ["open", "in_review"], 1]) {
      const r = parseLegacyReportStatusFilter(bad);
      assert.equal(r.ok, false, String(bad));
    }
  });

  it("RED before (a new reader): exactListCount: a page past the first needs offset + rows; an empty page past the end proves nothing more", async () => {
    const { exactListCount } = await import("../lib/moderationCounts.js") as any;
    assert.equal(exactListCount(5, [1, 2], 2), 5);
    assert.equal(exactListCount(3, [1, 2], 2), null, "page 2 holds rows 3-4: a total of 3 cannot be");
    assert.equal(exactListCount(3, [], 10), 3);
    assert.equal(exactListCount(null, [], 0), null);
    assert.equal(exactListCount(2, null, 0), null);
  });

  it("RED before (a new reader): settledRows / settledCount: rejected, errored, list-less and count-less are null — never [] or 0", async () => {
    const { settledRows, settledCount } = await import("../lib/moderationCounts.js") as any;
    const ok = (value: unknown) => ({ status: "fulfilled", value });
    assert.deepEqual(settledRows(ok({ data: [1], error: null })), [1]);
    assert.deepEqual(settledRows(ok({ data: [], error: null })), []);
    for (const r of [{ status: "rejected", reason: new Error("x") }, ok({ data: [1], error: FAIL }), ok({ data: null, error: null }), ok(undefined)]) assert.equal(settledRows(r), null);
    assert.equal(settledCount(ok({ count: 0, error: null })), 0);
    assert.equal(settledCount(ok({ count: 7, error: null })), 7);
    for (const r of [{ status: "rejected", reason: 1 }, ok({ count: 3, error: FAIL }), ok({ count: null, error: null }), ok({ count: -1 }), ok({ count: 1.5 }), ok({ count: "3" })]) assert.equal(settledCount(r), null);
  });
});
