/**
 * mediaEventLink — census-media §21, MD103: post_event_links gets its writer.
 *
 * The table had four readers (View Event, the §24 availability term, the event
 * experience's hero media, Discovery "Live from events") and no writer. Proved:
 *   - WHO may link: the post's author only, to a PUBLIC, open event they host,
 *     co-host or RSVP'd going to, near the post's own time;
 *   - the offer and the write use ONE predicate (§47): the resolver offers
 *     `link_event` exactly when POST /media/:id/event-link would accept;
 *   - dark behind MEDIA_WORLD_SHELL_ENABLED, like the rail that offers it;
 *   - an unreadable participation read refuses, never guesses;
 *   - once linked, View Event appears and the link offer goes away.
 *
 * Run:
 *   SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *   node --import tsx/esm --test src/test/mediaEventLink.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import {
  listLinkableEvents,
  linkPostToEvent,
  unlinkPostFromEvent,
  withinLinkWindow,
  LINK_WINDOW_AFTER_END_MS,
  LINK_WINDOW_BEFORE_START_MS,
} from "../lib/mediaEventLinks.js";
import { makeFailClosedClient } from "./helpers/failClosedSupabase.js";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import mediaActionsRouter from "../routes/mediaActions.js";

const AUTHOR = "10000000-0000-4000-a000-000000000001";
const STRANGER = "10000000-0000-4000-a000-000000000002";
const POST = "30000000-0000-4000-a000-000000000001";
const EV_HOSTED = "40000000-0000-4000-a000-000000000001";
const EV_GOING = "40000000-0000-4000-a000-000000000002";
const EV_COHOST = "40000000-0000-4000-a000-000000000003";
const EV_PRIVATE = "40000000-0000-4000-a000-000000000004";
const EV_CANCELLED = "40000000-0000-4000-a000-000000000005";
const EV_FAR = "40000000-0000-4000-a000-000000000006";
const EV_OTHERS = "40000000-0000-4000-a000-000000000007";
const OTHER_HOST = "10000000-0000-4000-a000-000000000003";
const TOKEN = "event-link-token";
const STRANGER_TOKEN = "event-link-stranger";

const POSTED = Date.parse("2026-09-20T22:00:00.000Z");
const iso = (dh: number) => new Date(POSTED + dh * 3_600_000).toISOString();

function ev(id: string, o: Record<string, unknown> = {}) {
  return { id, title: `Event ${id.slice(-1)}`, starts_at: iso(-3), ends_at: iso(1), visibility: "public", state: "published", host_id: OTHER_HOST, ...o };
}

function rows(extra: Record<string, any[]> = {}) {
  return {
    posts: [{ id: POST, author_id: AUTHOR, status: "active", created_at: iso(0) }],
    events: [
      ev(EV_HOSTED, { host_id: AUTHOR }),
      ev(EV_GOING),
      ev(EV_COHOST),
      ev(EV_PRIVATE, { host_id: AUTHOR, visibility: "private" }),
      ev(EV_CANCELLED, { host_id: AUTHOR, state: "cancelled" }),
      ev(EV_FAR, { host_id: AUTHOR, starts_at: iso(-24 * 10), ends_at: iso(-24 * 10 + 3) }),
      ev(EV_OTHERS),
    ],
    event_roles: [{ event_id: EV_COHOST, user_id: AUTHOR, role: "co_host" }],
    event_rsvps: [
      { event_id: EV_GOING, user_id: AUTHOR, status: "going" },
      { event_id: EV_OTHERS, user_id: AUTHOR, status: "not_going" },
    ],
    feature_flags: [{ flag: "MEDIA_WORLD_SHELL_ENABLED", enabled: true }],
    ...extra,
  };
}

/** Records deletes on post_event_links (the shared double records inserts/upserts only). */
function withDeleteLog(db: any) {
  const deletes: Array<Record<string, unknown>> = [];
  const from = db.from.bind(db);
  db.from = (table: string) => {
    const b = from(table);
    if (table !== "post_event_links") return b;
    const del = b.delete.bind(b);
    b.delete = (...args: any[]) => {
      const rec: Record<string, unknown> = {};
      deletes.push(rec);
      const inner = del(...args);
      const eq = inner.eq.bind(inner);
      inner.eq = (c: string, v: unknown) => { rec[c] = v; return eq(c, v); };
      return inner;
    };
    return b;
  };
  return deletes;
}

describe("withinLinkWindow — a link describes the post, not an unrelated event", () => {
  it("during, just before and shortly after the event: yes; far away: no; no start: no", () => {
    const start = POSTED;
    assert.equal(withinLinkWindow(POSTED + 3_600_000, start, start + 3 * 3_600_000), true);
    assert.equal(withinLinkWindow(start - LINK_WINDOW_BEFORE_START_MS, start, null), true);
    assert.equal(withinLinkWindow(start - LINK_WINDOW_BEFORE_START_MS - 1, start, null), false);
    assert.equal(withinLinkWindow(start + 3 * 3_600_000 + LINK_WINDOW_AFTER_END_MS + 1, start, start + 3 * 3_600_000), false);
    assert.equal(withinLinkWindow(POSTED, null, null), false);
  });
});

describe("listLinkableEvents — the one predicate for offer and write", () => {
  it("hosted, co-hosted and going events that are public, open and near the post — nothing else", async () => {
    const got = await listLinkableEvents(makeFailClosedClient({ rows: rows() }), AUTHOR, iso(0));
    assert.deepEqual(new Set(got?.map((e) => e.eventId)), new Set([EV_HOSTED, EV_GOING, EV_COHOST]));
  });

  it("a stranger to every event can link to none", async () => {
    assert.deepEqual(await listLinkableEvents(makeFailClosedClient({ rows: rows() }), STRANGER, iso(0)), []);
  });

  it("an unreadable participation read is null (undecided), never []", async () => {
    for (const table of ["event_roles", "event_rsvps", "events"]) {
      const db = makeFailClosedClient({ rows: rows(), failOn: (c) => (c.table === table ? { message: "down" } : null) });
      assert.equal(await listLinkableEvents(db, AUTHOR, iso(0)), null, table);
    }
  });
});

describe("linkPostToEvent / unlinkPostFromEvent", () => {
  it("links the author's own post to an eligible event — one upsert, nothing else", async () => {
    const inserted: Record<string, any[]> = {};
    const r = await linkPostToEvent(makeFailClosedClient({ rows: rows(), inserted }), AUTHOR, POST, EV_GOING);
    assert.deepEqual(r, { ok: true, eventId: EV_GOING });
    assert.deepEqual(inserted.post_event_links, [{ post_id: POST, event_id: EV_GOING }]);
  });

  it("refuses: someone else's post (probe-safe not_found), an ineligible event, an inactive post", async () => {
    const inserted: Record<string, any[]> = {};
    assert.deepEqual(await linkPostToEvent(makeFailClosedClient({ rows: rows(), inserted }), STRANGER, POST, EV_OTHERS), { ok: false, error: "not_found" });
    for (const evId of [EV_PRIVATE, EV_CANCELLED, EV_FAR, EV_OTHERS]) {
      assert.deepEqual(await linkPostToEvent(makeFailClosedClient({ rows: rows(), inserted }), AUTHOR, POST, evId), { ok: false, error: "not_linkable" }, evId);
    }
    const archived = rows({ posts: [{ id: POST, author_id: AUTHOR, status: "archived", created_at: iso(0) }] });
    assert.deepEqual(await linkPostToEvent(makeFailClosedClient({ rows: archived, inserted }), AUTHOR, POST, EV_GOING), { ok: false, error: "not_found" });
    assert.equal(inserted.post_event_links, undefined, "no refused link was written");
  });

  it("an unreadable participation read or a refused write is db_error, never a link", async () => {
    const inserted: Record<string, any[]> = {};
    const unreadable = makeFailClosedClient({ rows: rows(), inserted, failOn: (c) => (c.table === "event_rsvps" ? { message: "down" } : null) });
    assert.deepEqual(await linkPostToEvent(unreadable, AUTHOR, POST, EV_GOING), { ok: false, error: "db_error" });
    const refused = makeFailClosedClient({ rows: rows(), failWritesOn: (t) => (t === "post_event_links" ? { message: "denied", code: "42501" } : null) });
    assert.deepEqual(await linkPostToEvent(refused, AUTHOR, POST, EV_GOING), { ok: false, error: "db_error" });
    assert.equal(inserted.post_event_links, undefined);
  });

  it("unlink: only the author, scoped to that post and event", async () => {
    const db = makeFailClosedClient({ rows: rows() });
    const deletes = withDeleteLog(db);
    assert.deepEqual(await unlinkPostFromEvent(db, AUTHOR, POST, EV_GOING), { ok: true, eventId: EV_GOING });
    assert.deepEqual(deletes, [{ post_id: POST, event_id: EV_GOING }]);
    assert.deepEqual(await unlinkPostFromEvent(db, STRANGER, POST, EV_GOING), { ok: false, error: "not_found" });
    assert.equal(deletes.length, 1);
  });
});

// ── Route ────────────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

function call(method: string, path: string, token: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request(
      { hostname: url.hostname, port: Number(url.port), path: url.pathname, method, headers: { "content-type": "application/json", authorization: `Bearer ${token}` } },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let parsed: any;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    const noop = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => noop };
    req.log = noop;
    next();
  });
  app.use("/api", mediaActionsRouter);
  await new Promise<void>((resolve, reject) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });
  const addr = server.address();
  assert.ok(addr !== null && typeof addr === "object");
  base = `http://127.0.0.1:${addr.port}`;
});

after(() => {
  server.close();
  _setTestClient(null, false);
  _setTestServiceClient(null);
});

function install(spec: Record<string, any>) {
  const db = makeFailClosedClient({ users: { [TOKEN]: AUTHOR, [STRANGER_TOKEN]: STRANGER }, ...spec });
  _setTestClient(db, true);
  _setTestServiceClient(db);
  return db;
}

describe("POST/DELETE /api/media/:id/event-link", () => {
  it("the author links; the row is written", async () => {
    const inserted: Record<string, any[]> = {};
    install({ rows: rows(), inserted });
    const r = await call("POST", `/api/media/${POST}/event-link`, TOKEN, { eventId: EV_HOSTED });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(inserted.post_event_links, [{ post_id: POST, event_id: EV_HOSTED }]);
  });

  it("dark while MEDIA_WORLD_SHELL_ENABLED is off — nothing is written", async () => {
    const inserted: Record<string, any[]> = {};
    install({ rows: rows({ feature_flags: [{ flag: "MEDIA_WORLD_SHELL_ENABLED", enabled: false }] }), inserted });
    const r = await call("POST", `/api/media/${POST}/event-link`, TOKEN, { eventId: EV_HOSTED });
    assert.equal(r.body?.error, "feature_disabled", JSON.stringify(r.body));
    assert.equal(inserted.post_event_links, undefined);
  });

  it("a stranger gets not_found; an ineligible event gets forbidden; neither writes", async () => {
    const inserted: Record<string, any[]> = {};
    install({ rows: rows(), inserted });
    assert.equal((await call("POST", `/api/media/${POST}/event-link`, STRANGER_TOKEN, { eventId: EV_OTHERS })).status, 404);
    assert.equal((await call("POST", `/api/media/${POST}/event-link`, TOKEN, { eventId: EV_PRIVATE })).status, 403);
    assert.equal((await call("POST", `/api/media/${POST}/event-link`, TOKEN, { eventId: "nope" })).status, 400);
    assert.equal(inserted.post_event_links, undefined);
  });

  it("DELETE unlinks for the author", async () => {
    const db = install({ rows: rows() });
    const deletes = withDeleteLog(db);
    const r = await call("DELETE", `/api/media/${POST}/event-link/${EV_GOING}`, TOKEN);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(deletes, [{ post_id: POST, event_id: EV_GOING }]);
  });
});
