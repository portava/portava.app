/**
 * census-trust TV-4a — the admin moderation_reports queue: filter by
 * category, see what was reported, and ACT on a report.
 *
 * WHAT WAS WRONG (census-trust TV-4a, re-confirmed by grep before this change)
 * ============================================================================
 *  - No category filter: the axis a moderator triages on.
 *  - Only `place` reports were enriched; everything else was a bare UUID, and
 *    the place read discarded its error (an unreadable `places` showed every
 *    place report with no name).
 *  - "nothing updates moderation_reports.status, so the queue can only grow".
 *
 * WHAT THIS PINS — against a store-backed fake whose writes PERSIST, so every
 * assertion is about the state afterwards, not the response:
 *  1. category / status filters apply; an unknown value is refused by name.
 *  2. each supported subject type gets an `ok` snapshot with the content's own
 *     words; a deleted message shows no text; a missing row is `not_found`; a
 *     FAILED read is `unavailable` and is named in `snapshotsUnavailableFor`.
 *  3. POST …/review moves open → reviewing → actioned|dismissed; the closing
 *     decisions write the moderation_actions audit row FIRST and a failed audit
 *     leaves the report untouched; terminal states are 409; a non-admin is 403.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *   node --import tsx/esm --test src/test/adminModerationReportReview.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import adminRouter from "../routes/admin.js";
import { SNAPSHOT_EXCERPT_CHARS } from "../lib/moderationReportSnapshots.js";

const ADMIN = "bbbbbbbb-0000-4000-8000-000000000002";
const AUTHOR = "aaaaaaaa-0000-4000-8000-000000000001";
const REPORTER = "eeeeeeee-0000-4000-8000-000000000005";
const R = (n: number) => `cccccccc-0000-4000-8000-${String(n).padStart(12, "0")}`;
const POST = "dddddddd-0000-4000-8000-000000000001";
const MSG = "dddddddd-0000-4000-8000-000000000002";
const MSG_DELETED = "dddddddd-0000-4000-8000-000000000003";
const EVENT = "dddddddd-0000-4000-8000-000000000004";
const PLACE = "dddddddd-0000-4000-8000-000000000005";
const GONE = "dddddddd-0000-4000-8000-000000000099";

type Row = Record<string, any>;

interface Fake {
  client: any;
  store: Record<string, Row[]>;
  inserts: Array<{ table: string; row: Row }>;
}

/** A PostgREST-shaped fake whose updates and inserts persist; `errorOn` tables answer an error. */
interface FakeOpts {
  role?: string;
  errorOn?: string[];
  failInsertOn?: string[];
  /** Called before each UPDATE on a table; return an error to make that update fail. */
  onUpdate?: (table: string, store: Record<string, Row[]>, n: number) => { message: string } | void;
}

function makeFake(store: Record<string, Row[]>, opts: FakeOpts = {}): Fake {
  const updateCount: Record<string, number> = {};
  const inserts: Array<{ table: string; row: Row }> = [];
  const tbl = (t: string) => (store[t] ??= []);
  const client: any = {
    auth: { getUser: async () => ({ data: { user: { id: ADMIN } }, error: null }) },
    from(table: string) {
      const filters: Array<(r: Row) => boolean> = [];
      let pending: { verb: "update" | "insert"; payload: any } | null = null;
      const fail = (opts.errorOn ?? []).includes(table);
      const err = { message: `${table} unavailable`, code: "XX000" };
      const run = (single: boolean) => {
        if (fail) return { data: null, error: err, count: null };
        if (pending?.verb === "insert") {
          if ((opts.failInsertOn ?? []).includes(table)) { pending = null; return { data: null, error: { message: "insert refused", code: "23503" } }; }
          const row = { id: `ins-${inserts.length + 1}`, ...pending.payload };
          tbl(table).push(row); inserts.push({ table, row }); pending = null;
          return { data: single ? row : [row], error: null };
        }
        if (pending?.verb === "update") {
          const n = (updateCount[table] = (updateCount[table] ?? 0) + 1);
          const hookErr = opts.onUpdate?.(table, store, n);
          if (hookErr) { pending = null; return { data: null, error: hookErr }; }
        }
        const hit = tbl(table).filter((r) => filters.every((f) => f(r)));
        if (pending?.verb === "update") { for (const r of hit) Object.assign(r, pending.payload); pending = null; }
        return { data: single ? hit[0] ?? null : hit, error: null, count: hit.length };
      };
      const b: any = {
        select: () => b,
        eq: (c: string, v: any) => { filters.push((r) => r[c] === v); return b; },
        in: (c: string, vs: any[]) => { filters.push((r) => vs.includes(r[c])); return b; },
        is: (c: string, v: any) => { filters.push((r) => (r[c] ?? null) === v); return b; },
        neq: () => b, or: () => b, order: () => b, limit: () => b, range: () => b,
        update: (p: any) => { pending = { verb: "update", payload: p }; return b; },
        insert: (p: any) => { pending = { verb: "insert", payload: Array.isArray(p) ? p[0] : p }; return b; },
        maybeSingle: async () => run(true),
        single: async () => run(true),
        then: (ok: any, bad: any) => Promise.resolve(run(false)).then(ok, bad),
      };
      return b;
    },
  };
  tbl("profiles").push({ id: ADMIN, role: opts.role ?? "admin", name: "Admin", handle: "admin" });
  return { client, store, inserts };
}

function world(): Record<string, Row[]> {
  const now = new Date().toISOString();
  const rep = (n: number, subject_type: string, subject_id: string, category: string, status = "open") =>
    ({ id: R(n), reporter_id: REPORTER, subject_type, subject_id, subject_user_id: null, category, details: "reported", status, created_at: now, resolved_at: null, resolver_id: null, resolver_note: null });
  return {
    profiles: [{ id: AUTHOR, name: "Author", handle: "author", account_status: "active", role: "user" }],
    moderation_reports: [
      rep(1, "post", POST, "harassment"),
      rep(2, "message", MSG, "scam_fraud"),
      rep(3, "message", MSG_DELETED, "harassment"),
      rep(4, "event", EVENT, "safety_concern"),
      rep(5, "place", PLACE, "wrong_photo"),
      rep(6, "post", GONE, "spam"),
      rep(7, "user", AUTHOR, "impersonation"),
      rep(8, "post", POST, "spam", "actioned"),
    ],
    posts: [{ id: POST, author_id: AUTHOR, content: "x".repeat(SNAPSHOT_EXCERPT_CHARS + 50), created_at: now, deleted_at: null }],
    messages: [
      { id: MSG, thread_id: "t1", sender_id: AUTHOR, body: "send me your card number", created_at: now, deleted_at: null },
      { id: MSG_DELETED, thread_id: "t1", sender_id: AUTHOR, body: "something removed", created_at: now, deleted_at: now },
    ],
    events: [{ id: EVENT, host_id: AUTHOR, title: "Night walk", starts_at: now, city: "Da Nang", state: "published" }],
    places: [{ id: PLACE, name: "The Grand Café", address: "1 Main St" }],
    moderation_actions: [],
  };
}

let server: http.Server;
let base: string;

function install(f: Fake) { _setTestClient(f.client, true); _setTestServiceClient(f.client); }

function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body ? JSON.stringify(body) : undefined;
    const r = http.request({ hostname: url.hostname, port: Number(url.port), path: url.pathname + url.search, method, headers: { "content-type": "application/json", authorization: "Bearer t" } }, (res) => {
      let raw = ""; res.on("data", (c) => (raw += c));
      res.on("end", () => { let parsed: any; try { parsed = JSON.parse(raw); } catch { parsed = raw; } resolve({ status: res.statusCode ?? 0, body: parsed }); });
    });
    r.on("error", reject); if (payload) r.write(payload); r.end();
  });
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((r: any, _res: any, next: any) => { r.log = { info() {}, warn() {}, error() {}, debug() {} }; next(); });
  app.use(adminRouter);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(() => server.close());

describe("TV-4a §1 — filters", () => {
  it("category filters the queue to that category", async () => {
    install(makeFake(world()));
    const { status, body } = await call("GET", "/admin/moderation/reports?category=harassment");
    assert.equal(status, 200, JSON.stringify(body));
    assert.deepEqual(body.reports.map((r: any) => r.id).sort(), [R(1), R(3)]);
  });

  it("an UNKNOWN category or status is refused by name, not answered with an empty page", async () => {
    install(makeFake(world()));
    const c = await call("GET", "/admin/moderation/reports?category=rudeness");
    assert.equal(c.status, 400);
    assert.match(String(c.body.message), /Unknown category 'rudeness'/);
    const s = await call("GET", "/admin/moderation/reports?status=resolved");
    assert.equal(s.status, 400);
    assert.match(String(s.body.message), /Unknown status 'resolved'/);
  });
});

describe("TV-4a §2 — what was reported, not a bare UUID", () => {
  it("each supported subject carries an ok snapshot in the content's own words, truncated", async () => {
    install(makeFake(world()));
    const { body } = await call("GET", "/admin/moderation/reports?status=open");
    const by = new Map(body.reports.map((r: any) => [r.id, r.subject_snapshot]));
    const post: any = by.get(R(1));
    assert.equal(post.state, "ok");
    assert.equal(post.accountableUserId, AUTHOR);
    assert.equal(String(post.excerpt).length, SNAPSHOT_EXCERPT_CHARS);
    const msg: any = by.get(R(2));
    assert.equal(msg.state, "ok");
    assert.equal(msg.excerpt, "send me your card number");
    const ev: any = by.get(R(4));
    assert.deepEqual([ev.state, ev.title, ev.city], ["ok", "Night walk", "Da Nang"]);
    const user: any = by.get(R(7));
    assert.deepEqual([user.state, user.handle], ["ok", "author"]);
    const place = body.reports.find((r: any) => r.id === R(5));
    assert.equal(place.subject_snapshot.state, "ok");
    assert.equal(place.place_name, "The Grand Café", "existing readers keep place_name");
  });

  it("a DELETED message shows no text; a missing post is not_found", async () => {
    install(makeFake(world()));
    const { body } = await call("GET", "/admin/moderation/reports?status=open");
    const del = body.reports.find((r: any) => r.id === R(3)).subject_snapshot;
    assert.equal(del.state, "ok");
    assert.equal(del.deleted, true);
    assert.equal(del.excerpt, null, "a message its author deleted must not be re-shown");
    assert.equal(body.reports.find((r: any) => r.id === R(6)).subject_snapshot.state, "not_found");
  });

  it("a FAILED read is `unavailable` — never not_found, never a null name — and the page says so", async () => {
    install(makeFake(world(), { errorOn: ["messages", "places"] }));
    const { status, body } = await call("GET", "/admin/moderation/reports?status=open");
    assert.equal(status, 200);
    const msg = body.reports.find((r: any) => r.id === R(2));
    assert.equal(msg.subject_snapshot.state, "unavailable");
    const place = body.reports.find((r: any) => r.id === R(5));
    assert.equal(place.subject_snapshot.state, "unavailable");
    assert.deepEqual([...body.snapshotsUnavailableFor].sort(), ["message", "place"]);
    // Other types on the same page are unaffected.
    assert.equal(body.reports.find((r: any) => r.id === R(1)).subject_snapshot.state, "ok");
  });
});

describe("TV-4a §3 — a route that ACTS on a moderation_reports row", () => {
  const row = (f: Fake, id: string) => f.store.moderation_reports.find((r) => r.id === id)!;
  const audits = (f: Fake) => f.inserts.filter((i) => i.table === "moderation_actions");

  it("open → reviewing moves the row and writes neither a moderation action nor the moderator's id", async () => {
    const f = makeFake(world()); install(f);
    const r = await call("POST", `/admin/moderation/reports/${R(1)}/review`, { decision: "reviewing" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(row(f, R(1)).status, "reviewing");
    assert.equal(row(f, R(1)).resolver_id, null, "the moderator's id went on a row the reporter can read");
    assert.equal(row(f, R(1)).resolved_at, null, "a claim is not a resolution");
    assert.equal(audits(f).length, 0);
  });

  it("actioned: the audit row names the accountable author, the moderator and the note; the report row carries neither", async () => {
    const f = makeFake(world()); install(f);
    const r = await call("POST", `/admin/moderation/reports/${R(2)}/review`, { decision: "actioned", note: "scam confirmed" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.audit, "recorded");
    const a = audits(f);
    assert.equal(a.length, 1);
    assert.equal(a[0].row.target_user_id, AUTHOR);
    assert.equal(a[0].row.performed_by, ADMIN);
    assert.equal(a[0].row.action_type, "report_actioned");
    assert.equal(a[0].row.reason, "scam confirmed");
    assert.equal(a[0].row.metadata.report_id, R(2));
    assert.equal(row(f, R(2)).status, "actioned");
    assert.ok(row(f, R(2)).resolved_at, "a closing decision stamps resolved_at");
    assert.equal(row(f, R(2)).resolver_id, null, "verifier finding 6: moderator identity on a reporter-readable row");
    assert.equal(row(f, R(2)).resolver_note, null, "verifier finding 6: private note on a reporter-readable row");
  });

  it("dismissed closes it too, with its own action type", async () => {
    const f = makeFake(world()); install(f);
    const r = await call("POST", `/admin/moderation/reports/${R(4)}/review`, { decision: "dismissed" });
    assert.equal(r.status, 200);
    assert.equal(row(f, R(4)).status, "dismissed");
    assert.equal(audits(f)[0]?.row.action_type, "report_dismissed");
  });

  it("a CONCURRENT close (the claim matches no row) is a 409 and writes NO audit row", async () => {
    // Another moderator dismisses the report between this request's read and its claim.
    const f = makeFake(world(), {
      onUpdate: (table, store, n) => {
        if (table === "moderation_reports" && n === 1) store.moderation_reports.find((r) => r.id === R(2))!.status = "dismissed";
      },
    });
    install(f);
    const r = await call("POST", `/admin/moderation/reports/${R(2)}/review`, { decision: "actioned" });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(audits(f).length, 0, "verifier finding 5(a): an audit row for an action that did not happen");
    assert.equal(row(f, R(2)).status, "dismissed", "the other moderator's decision stands");
  });

  it("an UNREADABLE owner table is a retryable 503 and nothing is written (no report closed without its audit row)", async () => {
    const f = makeFake(world(), { errorOn: ["messages"] }); install(f);
    const r = await call("POST", `/admin/moderation/reports/${R(2)}/review`, { decision: "dismissed" });
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(row(f, R(2)).status, "open", "verifier finding 5(b): closed with no audit row");
    assert.equal(audits(f).length, 0);
  });

  it("the owner recorded at intake is used when the content has since gone", async () => {
    const w = world();
    w.moderation_reports.find((r) => r.id === R(6))!.subject_user_id = AUTHOR; // post GONE
    const f = makeFake(w); install(f);
    const r = await call("POST", `/admin/moderation/reports/${R(6)}/review`, { decision: "actioned" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(audits(f)[0]?.row.target_user_id, AUTHOR);
  });

  it("a subject with no accountable user (an unowned place) is refused, and nothing is written", async () => {
    const f = makeFake(world()); install(f);
    const r = await call("POST", `/admin/moderation/reports/${R(5)}/review`, { decision: "dismissed" });
    assert.equal(r.status, 409);
    assert.equal(row(f, R(5)).status, "open");
    assert.equal(audits(f).length, 0);
  });

  it("a FAILED audit write restores the report to where it was, and says so", async () => {
    const f = makeFake(world(), { failInsertOn: ["moderation_actions"] }); install(f);
    const r = await call("POST", `/admin/moderation/reports/${R(2)}/review`, { decision: "actioned" });
    assert.equal(r.status, 500);
    assert.match(String(r.body.message), /restored to 'open'/);
    assert.equal(row(f, R(2)).status, "open", "the report closed although its audit row was never written");
    assert.equal(row(f, R(2)).resolved_at, null);
  });

  it("if the audit fails AND the restore fails, the 500 says the report is closed with no audit row", async () => {
    const f = makeFake(world(), {
      failInsertOn: ["moderation_actions"],
      onUpdate: (table, _s, n) => (table === "moderation_reports" && n === 2 ? { message: "restore refused" } : undefined),
    });
    install(f);
    const r = await call("POST", `/admin/moderation/reports/${R(2)}/review`, { decision: "actioned" });
    assert.equal(r.status, 500);
    assert.match(String(r.body.message), /could not be restored/);
  });

  it("a terminal report cannot move again (409), and an unknown decision is 400", async () => {
    const f = makeFake(world()); install(f);
    const t = await call("POST", `/admin/moderation/reports/${R(8)}/review`, { decision: "dismissed" });
    assert.equal(t.status, 409);
    assert.equal(row(f, R(8)).status, "actioned");
    const bad = await call("POST", `/admin/moderation/reports/${R(1)}/review`, { decision: "deleted" });
    assert.equal(bad.status, 400);
    assert.equal(row(f, R(1)).status, "open");
  });

  it("an unreadable report is 503 and nothing is written; a missing one is 404", async () => {
    const down = makeFake(world(), { errorOn: ["moderation_reports"] }); install(down);
    const r = await call("POST", `/admin/moderation/reports/${R(1)}/review`, { decision: "dismissed" });
    assert.equal(r.status, 503);
    assert.equal(down.inserts.length, 0);
    const f = makeFake(world()); install(f);
    const m = await call("POST", `/admin/moderation/reports/${R(99)}/review`, { decision: "dismissed" });
    assert.equal(m.status, 404);
  });

  it("a non-admin is refused and nothing changes", async () => {
    const f = makeFake(world(), { role: "user" }); install(f);
    const r = await call("POST", `/admin/moderation/reports/${R(1)}/review`, { decision: "dismissed" });
    assert.equal(r.status, 403);
    assert.equal(row(f, R(1)).status, "open");
    assert.equal(f.inserts.length, 0);
  });
});
