/**
 * census-trust (wave 5, honesty 3, 2026-10-18) — the three items the previous
 * pass listed and left, on the admin moderation lists:
 *
 *   2. GET /admin/place-images/reports matched `?status=` exactly and
 *      unvalidated (`(req.query.status as string) ?? "pending"`): a word no
 *      report carries answered `{ items: [], total: 0 }` — "no reports" — and a
 *      repeated `?status` went to the filter as an array. Now: the column's
 *      CHECK vocabulary plus the route's `all`, else a 400 naming `status`.
 *   3. The place-image queue's reportCount read was ONE unpaged read of every
 *      pending report on the page's images. The page bounds the images (<=100),
 *      not their reports: place_image_reports has no unique (reporter, image)
 *      key and POST /places/:id/image-report never dedups, so an image's
 *      reports are unbounded, and past PostgREST's db-max-rows (1000 hosted)
 *      the read was silently cut and reportCount undercounted. Now it is paged
 *      (readEveryRow).
 *   4. readEveryRow (lib/moderationCounts.ts) asked for count=exact on EVERY
 *      page — an O(pages x rows) count. Now the first page asks, the count is
 *      passed through, and no later page asks or is read for one. The cut
 *      detection (refuse, never shorten) holds, and is STRONGER for one case: a
 *      row removed before the read position shifted a later page past a row the
 *      old per-page count could not see (the count fell by exactly what the
 *      page lost); measured against the count read once, the pages run out
 *      short of it and the read is refused.
 *
 * Run: env -i PATH="$PATH" HOME=$TMPDIR TMPDIR=$TMPDIR TZ=UTC \
 *      SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/adminModerationListsCountOnce.test.ts
 * The route cases listen on 127.0.0.1 (run with loopback allowed).
 *
 * DOUBLES: helpers/adminModerationDouble.ts. Each case says whether it was RED
 * or GREEN on the code before this change (929b2599b).
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import { readEveryRow } from "../lib/moderationCounts.js";
import adminRouter from "../routes/admin.js";
import adminPlaceImagesRouter from "../routes/adminPlaceImages.js";
import adminCompassRouter from "../routes/adminCompass.js";
import { installModerationDouble, isListRead, countAsked, type Statement } from "./helpers/adminModerationDouble.js";
import type { Seed, Row } from "./helpers/schemaStrictSupabase.js";

const ADMIN    = "a1111111-1111-4111-8111-11111111c0a0";
const REPORTER = "a2222222-2222-4222-8222-22222222c0a0";
const OWNER    = "a3333333-3333-4333-8333-33333333c0a0";
const PLACE    = "b5555555-5555-4555-8555-55555555c0a0";
const POST_A   = "b1111111-1111-4111-8111-11111111c0a0";
const TOKENS: Record<string, string> = { "admin-token": ADMIN };
const FAIL = { message: "simulated failure", code: "57014" };

const at = (n: number) => new Date(Date.UTC(2026, 9, 1, 0, 0, n)).toISOString();
const ago = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
const uid = (prefix: string, n: number) => `${prefix}-0000-4000-8000-0000000092${String(n).padStart(2, "0")}`;
const URL_A = "https://cdn.example.invalid/a.jpg";
const URL_B = "https://cdn.example.invalid/b.jpg";

function profile(id: string, handle: string, role = "user"): Row {
  return { id, handle, username: handle, name: `${handle} name`, display_name: `${handle} display`, role, account_status: "active", created_at: at(0) };
}
function world(): Seed {
  return {
    profiles: [profile(ADMIN, "admin", "admin"), profile(REPORTER, "reporter"), profile(OWNER, "owner")],
    admin_access_log: [], feature_flags: [], user_account_states: [], compass_settings: [], moderation_actions: [], reports: [],
    discovery_places: [], discovery_place_reports: [],
    generated_visuals: [
      { id: uid("d1000000", 1), entity_type: "place", entity_id: PLACE, canonical_place_id: PLACE, image_source_type: "generic_ai_illustration", accuracy_status: "unverified", source_url: URL_A, created_at: at(11) },
      { id: uid("d1000000", 2), entity_type: "place", entity_id: PLACE, canonical_place_id: PLACE, image_source_type: "generic_ai_illustration", accuracy_status: "unverified", source_url: URL_B, created_at: at(12) },
    ],
    place_image_reports: [],
    posts: [{ id: POST_A, author_id: OWNER, visibility: "public", post_status: "published", created_at: at(1) }],
    compass_abuse_flags: [], compass_safety_filter_logs: [], compass_feed_cache: [], compass_active_user_scores: [],
    compass_notification_decisions: [], compass_algorithm_versions: [], compass_feedback_events: [], user_location_state: [],
    rent_buddy_profiles: [],
  };
}
function report(n: number, url: string, status = "pending"): Row {
  return { id: uid("d4000000", n), image_url: url, place_id: PLACE, reported_by: REPORTER, report_reason: "wrong_place", status, created_at: at(20 + n) };
}
const install = (s: Seed, o: Parameters<typeof installModerationDouble>[1] = {}) => installModerationDouble(s, { tokens: TOKENS, ...o });

let server: http.Server;
let base = "";
before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.log = { error() {}, warn() {}, info() {}, debug() {} }; next(); });
  app.use(adminPlaceImagesRouter);
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

async function get(path: string) {
  const r = await fetch(`${base}${path}`, { headers: { authorization: "Bearer admin-token" } });
  const raw = await r.text();
  let parsed: any; try { parsed = JSON.parse(raw); } catch { parsed = raw; }
  return { status: r.status, body: parsed, raw };
}
/** The list reads of `table`, in order, and the count each asked for. */
const reads = (st: Statement[], table: string) => st.filter((x) => x.table === table && isListRead(x.calls)).map((x) => countAsked(x.calls));

// ── 2. GET /admin/place-images/reports ?status= ─────────────────────────────

describe("2. GET /admin/place-images/reports: a status no report carries is a 400 naming it, never an empty list", () => {
  function reportsWorld() {
    const s = world();
    s.place_image_reports = [report(1, URL_A), report(2, URL_A, "reviewed_accepted"), report(3, URL_B, "reviewed_rejected")];
    return s;
  }

  it("RED before: ?status=open is refused naming status and the vocabulary — it answered an empty list", async () => {
    install(reportsWorld());
    const r = await get("/admin/place-images/reports?status=open");
    assert.equal(r.status, 400, r.raw);
    assert.equal(r.body.error, "invalid_payload");
    assert.equal(r.body.message, "Unknown status 'open'. One of: pending, reviewed_accepted, reviewed_rejected, all");
  });

  it("RED before: ?status=resolved (the legacy reports' word) is refused", async () => {
    install(reportsWorld());
    const r = await get("/admin/place-images/reports?status=resolved");
    assert.equal(r.status, 400, r.raw);
    assert.match(r.body.message, /^Unknown status 'resolved'\./);
  });

  it("RED before: a repeated ?status (an array) is refused, not handed to the filter", async () => {
    install(reportsWorld());
    const r = await get("/admin/place-images/reports?status=pending&status=all");
    assert.equal(r.status, 400, r.raw);
    assert.match(r.body.message, /^Unknown status '\["pending","all"\]'\./);
  });

  it("RED before: an empty ?status= is the default (pending) — it matched the empty string and answered nothing", async () => {
    install(reportsWorld());
    const r = await get("/admin/place-images/reports?status=");
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(r.body.items.map((i: any) => i.id), [uid("d4000000", 1)]);
  });

  it("GREEN before (CONTROL): no status is pending; each vocabulary word filters; `all` is every report", async () => {
    install(reportsWorld());
    const ids = async (q: string) => (await get(`/admin/place-images/reports${q}`)).body.items.map((i: any) => i.id).sort();
    assert.deepEqual(await ids(""), [uid("d4000000", 1)]);
    assert.deepEqual(await ids("?status=pending"), [uid("d4000000", 1)]);
    assert.deepEqual(await ids("?status=reviewed_accepted"), [uid("d4000000", 2)]);
    assert.deepEqual(await ids("?status=reviewed_rejected"), [uid("d4000000", 3)]);
    assert.deepEqual(await ids("?status=all"), [1, 2, 3].map((n) => uid("d4000000", n)).sort());
  });
});

// ── 3. The place-image queue's reportCount read is paged ────────────────────

describe("3. GET /admin/place-images/queue: reportCount counts every pending report, past the row cap", () => {
  function queueWorld() {
    const s = world();
    // Image A: five pending reports (and one reviewed); image B: two pending. Seven pending rows in all.
    s.place_image_reports = [1, 2, 3, 4, 5].map((n) => report(n, URL_A)).concat([report(6, URL_A, "reviewed_rejected"), report(7, URL_B), report(8, URL_B)]);
    return s;
  }

  it("RED before: under a 2-row cap, image A reads reportCount 5 and image B 2 — the unpaged read was cut at the cap and undercounted", async () => {
    install(queueWorld(), { cap: 2 });
    const r = await get("/admin/place-images/queue");
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(r.body.items.map((i: any) => [i.source_url, i.reportCount]), [[URL_B, 2], [URL_A, 5]]);
  });

  it("RED before: a reportCount read whose first page answers no exact count is refused naming reportCount — a count it cannot measure is not a count", async () => {
    install(queueWorld(), { overrides: { place_image_reports: (calls, run) => (isListRead(calls) ? run().then((r) => ({ ...r, count: null })) : null) } });
    const r = await get("/admin/place-images/queue");
    assert.equal(r.status, 500, r.raw);
    assert.equal(r.body.error, "db_error");
    assert.match(r.body.message, /pending reports could not be read \(reportCount\): .*without an exact count/);
  });

  it("GREEN before (CONTROL): a failed reportCount read is refused naming reportCount, never \"nobody reported this image\"", async () => {
    install(queueWorld(), { overrides: { place_image_reports: (calls) => (isListRead(calls) ? { data: null, error: FAIL, count: null } : null) } });
    const r = await get("/admin/place-images/queue");
    assert.equal(r.status, 500, r.raw);
    assert.match(r.body.message, /pending reports could not be read \(reportCount\): simulated failure/);
  });

  it("GREEN before (CONTROL): with no cap the counts are the same", async () => {
    install(queueWorld());
    const r = await get("/admin/place-images/queue");
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(r.body.items.map((i: any) => [i.source_url, i.reportCount]), [[URL_B, 2], [URL_A, 5]]);
  });
});

// ── 4. readEveryRow counts ONCE ──────────────────────────────────────────────

describe("4. lib/moderationCounts.ts readEveryRow: the exact count is asked for once and passed through", () => {
  /**
   * Pages answered from a live array a test may mutate between pages, as PostgREST answers `.range()` under a cap.
   * Every page answers the whole match as `count`, as the old callers' `{ count: "exact" }` on every page made it —
   * so the code before this change is exercised on its own contract, and the new code is seen NOT to read it.
   */
  function table(rows: number[], cap = 2) {
    const asked: Array<[number, number, unknown]> = [];
    const page = async (from: number, to: number, count?: unknown) => {
      asked.push([from, to, count]);
      return { data: rows.slice(from, Math.min(to + 1, from + cap)), error: null, count: rows.length };
    };
    return { asked, page };
  }

  it("RED before: the first page asks for the exact count; no later page does", async () => {
    const t = table([1, 2, 3, 4, 5]);
    const r = await readEveryRow(t.page as any, { pageSize: 1000 });
    assert.deepEqual(r, { data: [1, 2, 3, 4, 5], error: null, count: 5 });
    assert.deepEqual(t.asked, [[0, 999, "exact"], [2, 1001, undefined], [4, 1003, undefined]]);
  });

  it("RED before: a later page's count is not read — a count it volunteers (here a stale 1) neither refuses nor shortens the read", async () => {
    const answers = [{ data: [1, 2], error: null, count: 4 }, { data: [3, 4], error: null, count: 1 }];
    let i = 0;
    const r = await readEveryRow(async () => answers[i++] ?? { data: [], error: null, count: 0 });
    assert.deepEqual(r.data, [1, 2, 3, 4]);
  });

  it("RED before: a row removed before the read position shifts a later page past a row — refused, never a set missing that row", async () => {
    const rows = [10, 11, 12, 13, 14];
    const t = table(rows);
    let pageNo = 0;
    const r = await readEveryRow(async (from, to, count) => {
      if (pageNo++ === 1) rows.splice(0, 1); // row 10 is deleted after the first page was read: row 12 slides to offset 1, behind the read
      return t.page(from, to, count);
    });
    // The old per-page count fell to 4, exactly the rows it then held ([10, 11, 13, 14]) — so it answered a set without 12.
    assert.equal(r.data, null, `answered ${JSON.stringify(r.data)}`);
    assert.match(r.error!.message, /answered no rows: rows were removed while they were read, or the read was cut/);
  });

  it("GREEN before (CONTROL): rows added after the first page that a later page answers are kept", async () => {
    const rows = [1, 2, 3];
    const t = table(rows);
    let pageNo = 0;
    const r = await readEveryRow(async (from, to, count) => { if (pageNo++ === 1) rows.push(4); return t.page(from, to, count); });
    assert.deepEqual(r.data, [1, 2, 3, 4]);
  });

  it("GREEN before (CONTROL): a first page whose count is below its own rows is refused", async () => {
    const r = await readEveryRow(async () => ({ data: [1, 2, 3], error: null, count: 2 }));
    assert.equal(r.data, null);
    assert.match(r.error!.message, /below/);
  });

  it("GREEN before (CONTROL): a first page with no exact count is refused, never read as the list", async () => {
    const r = await readEveryRow(async () => ({ data: [1], error: null, count: null }));
    assert.equal(r.data, null);
    assert.match(r.error!.message, /without an exact count/);
  });
});

describe("4b. the callers pass the count through: each paged read asks for it on its first page only", () => {
  it("RED before: GET /admin/venues/reported under a 2-row cap — 5 reports in 3 pages, one exact count", async () => {
    const s = world();
    s.discovery_places = [{ id: "d0000000-0000-4000-8000-000000009201", name: "Venue", place_type: "cafe", category: "food", city: "Da Nang", neighborhood: null, blurb: null, status: "active", submitted_by: OWNER, created_at: at(100) }];
    s.discovery_place_reports = [1, 2, 3, 4, 5].map((n) => ({ id: uid("d2000000", n), place_id: "d0000000-0000-4000-8000-000000009201", reporter_id: REPORTER, reason: "spam", notes: null, created_at: at(500 + n) }));
    const { statements } = install(s, { cap: 2 });
    const r = await get("/admin/venues/reported");
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.venues[0].reportCount, 5);
    assert.deepEqual(reads(statements, "discovery_place_reports"), ["exact", null, null]);
  });

  it("RED before: the place-image reportCount read under a 2-row cap — 7 pending reports in 4 pages, one exact count", async () => {
    const s = world();
    s.place_image_reports = [1, 2, 3, 4, 5].map((n) => report(n, URL_A)).concat([report(7, URL_B), report(8, URL_B)]);
    const { statements } = install(s, { cap: 2 });
    const r = await get("/admin/place-images/queue");
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(reads(statements, "place_image_reports"), ["exact", null, null, null]);
  });

  it("RED before: the Compass dashboard under a 2-row cap — each tallied section asks for its count once", async () => {
    const s = world();
    s.compass_abuse_flags = [1, 2, 3, 4, 5].map((n) => ({ id: uid("d5000000", n), pattern_type: "ring", involved_users: [OWNER], severity: "high", status: "pending", evidence: {}, detected_at: ago(n) }));
    s.compass_safety_filter_logs = [1, 2, 3].map((n) => ({ id: uid("d6000000", n), viewer_id: REPORTER, item_id: POST_A, item_type: "post", block_reason: "blocked_author", author_id: OWNER, created_at: ago(n) }));
    s.compass_notification_decisions = [1, 2, 3].map((n) => ({ id: uid("d7000000", n), user_id: REPORTER, notification_type: "digest", priority_level: 5, outcome: "sent", suppression_reason: null, created_at: ago(n) }));
    s.compass_feedback_events = [1, 2, 3].map((n) => ({ id: uid("d8000000", n), user_id: REPORTER, recommendation_id: "r", item_id: POST_A, item_type: "post", action: "save", metadata: {}, created_at: ago(n) }));
    s.user_location_state = [REPORTER, OWNER, ADMIN].map((u) => ({ user_id: u, city: "Da Nang", country: "VN" }));
    const { statements } = install(s, { cap: 2 });
    const r = await get("/admin/compass/dashboard");
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.abuse.total, 5);
    assert.deepEqual(reads(statements, "compass_abuse_flags"), ["exact", null, null]);
    assert.deepEqual(reads(statements, "compass_safety_filter_logs"), ["exact", null]);
    assert.deepEqual(reads(statements, "compass_notification_decisions"), ["exact", null]);
    assert.deepEqual(reads(statements, "compass_feedback_events"), ["exact", null]);
    assert.deepEqual(reads(statements, "user_location_state"), ["exact", null]);
  });

  it("RED before: GET /admin/compass/safety-filters under a 2-row cap — the totals read asks for its count once", async () => {
    const s = world();
    s.compass_safety_filter_logs = [1, 2, 3, 4, 5].map((n) => ({ id: uid("d6000000", n), viewer_id: REPORTER, item_id: POST_A, item_type: "post", block_reason: "muted_author", author_id: OWNER, created_at: ago(n) }));
    const { statements } = install(s, { cap: 2 });
    const r = await get("/admin/compass/safety-filters?limit=2");
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.total, 5);
    const totals = statements.filter((x) => x.table === "compass_safety_filter_logs" && isListRead(x.calls) && x.calls.some(([m]) => m === "range"));
    assert.deepEqual(totals.map((x) => countAsked(x.calls)), ["exact", null, null]);
  });
});
