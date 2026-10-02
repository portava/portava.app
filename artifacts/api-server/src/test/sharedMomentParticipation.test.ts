/**
 * Testing-mode lane WP-07 — Shared Moment participation, reachable (HM-F17, HM-F18).
 *
 * The write routes existed (respond / request / requests-respond /
 * contributions / approve) and the client had a function for each, but four
 * READS were missing, so no person could get to a write:
 *
 *   - an invited person could not open the Moment (`GET /shared-moments/:id`
 *     is members-only and answers `not_member`), so there was nowhere to show
 *     Accept / Decline;
 *   - the owner had no list of join requests or of pending contributions, so
 *     there was nothing to approve;
 *   - a member had no list of their own posts to contribute (the route only
 *     accepts a source the contributor owns);
 *   - an invitation told nobody.
 *
 * This suite pins the reads added at the foot of routes/sharedMoments.ts, the
 * two notifications, and the suggestion dismissal. Privacy is the point of most
 * of the assertions: the preview is refused to anyone with no invitation, no
 * request and no open door; a block hides a Moment in both directions and fails
 * CLOSED; a private author's post never reaches the owner's review list as
 * media.
 *
 * RED BEFORE GREEN: at 18518e982 every new route answers 400 invalid_payload
 * (`/shared-moments/:id` with a non-uuid id) or 404, and the invite / request
 * write no notification row.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import sharedMomentsRouter from "../routes/sharedMoments.js";

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const INVITEE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const REQUESTER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const STRANGER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const BLOCKED = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const PRIVATE_MEMBER = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const M_INVITE = "11111111-1111-4111-8111-000000000001";
const M_OPEN = "11111111-1111-4111-8111-000000000002";
const PLACE = "22222222-2222-4222-8222-222222222222";
const POST_PUBLIC = "33333333-3333-4333-8333-000000000001";
const POST_PRIVATE_AUTHOR = "33333333-3333-4333-8333-000000000002";
const POST_MINE_ELSEWHERE = "33333333-3333-4333-8333-000000000003";
const SUGGESTION = "44444444-4444-4444-8444-000000000001";
const OTHERS_SUGGESTION = "44444444-4444-4444-8444-000000000002";

type Row = Record<string, any>;
interface FakeState { [t: string]: Row[] }

const FLAGS = ["external_places_enabled", "live_places_enabled", "place_days_enabled", "shared_moments_enabled"];

function baseState(): FakeState {
  return {
    feature_flags: FLAGS.map((flag) => ({ flag, enabled: true })),
    shared_moments: [
      { id: M_INVITE, owner_id: OWNER, title: "Sunset at the pier", description: null, place_day_id: null, place_id: PLACE, trip_id: null, join_policy: "invite_only", status: "active", created_at: "2026-09-01", updated_at: "2026-09-01" },
      { id: M_OPEN, owner_id: OWNER, title: "Market morning", description: "Bring coffee", place_day_id: null, place_id: PLACE, trip_id: null, join_policy: "approval_required", status: "active", created_at: "2026-09-02", updated_at: "2026-09-02" },
    ],
    shared_moment_memberships: [
      { moment_id: M_INVITE, user_id: OWNER, role: "owner", status: "accepted" },
      { moment_id: M_INVITE, user_id: INVITEE, role: "member", status: "invited", invited_by: OWNER, updated_at: "2026-09-03" },
      { moment_id: M_OPEN, user_id: OWNER, role: "owner", status: "accepted" },
      { moment_id: M_OPEN, user_id: REQUESTER, role: "member", status: "requested", updated_at: "2026-09-04" },
      { moment_id: M_OPEN, user_id: BLOCKED, role: "member", status: "requested", updated_at: "2026-09-04" },
      { moment_id: M_OPEN, user_id: INVITEE, role: "member", status: "accepted" },
      { moment_id: M_OPEN, user_id: PRIVATE_MEMBER, role: "member", status: "accepted" },
    ],
    shared_moment_contributions: [
      { id: "c1", moment_id: M_OPEN, contributor_id: INVITEE, post_id: POST_PUBLIC, media_asset_id: null, caption: null, status: "pending", created_at: "2026-09-05" },
      { id: "c2", moment_id: M_OPEN, contributor_id: PRIVATE_MEMBER, post_id: POST_PRIVATE_AUTHOR, media_asset_id: null, caption: "from a private account", status: "pending", created_at: "2026-09-06" },
      { id: "c3", moment_id: M_OPEN, contributor_id: INVITEE, post_id: null, media_asset_id: null, caption: "already in", status: "approved", created_at: "2026-09-04" },
    ],
    shared_moment_suggestions: [
      { id: SUGGESTION, moment_id: M_INVITE, recipient_id: STRANGER, kind: "compass", reason: "You were both here", status: "offered", created_at: "2026-09-07" },
      { id: OTHERS_SUGGESTION, moment_id: M_INVITE, recipient_id: REQUESTER, kind: "compass", reason: "x", status: "offered", created_at: "2026-09-07" },
    ],
    shared_moment_audit_events: [],
    posts: [
      { id: POST_PUBLIC, author_id: INVITEE, content: "Golden light", media_urls: ["https://cdn/p1.jpg"], media_thumbnail_url: null, visibility: "public", status: "active", post_status: "published", publish_at: null, canonical_place_id: PLACE, created_at: "2026-09-05" },
      { id: POST_PRIVATE_AUTHOR, author_id: PRIVATE_MEMBER, content: "hidden words", media_urls: ["https://cdn/p2.jpg"], media_thumbnail_url: null, visibility: "public", status: "active", post_status: "published", publish_at: null, canonical_place_id: PLACE, created_at: "2026-09-06" },
      { id: POST_MINE_ELSEWHERE, author_id: INVITEE, content: "Another city", media_urls: [], media_thumbnail_url: null, visibility: "public", status: "active", post_status: "published", publish_at: null, canonical_place_id: "99999999-9999-4999-8999-999999999999", created_at: "2026-09-02" },
    ],
    profiles: [
      { id: OWNER, handle: "olive", name: "Olive", avatar_url: null, is_private: false },
      { id: INVITEE, handle: "ivy", name: "Ivy", avatar_url: null, is_private: false },
      { id: REQUESTER, handle: "rex", name: "Rex", avatar_url: null, is_private: false },
      { id: BLOCKED, handle: "bea", name: "Bea", avatar_url: null, is_private: false },
      { id: PRIVATE_MEMBER, handle: "pam", name: "Pam", avatar_url: null, is_private: true },
    ],
    profile_privacy_settings: [],
    blocks: [{ blocker_id: OWNER, blocked_id: BLOCKED }],
    notifications: [],
    media_attachments: [],
  };
}

function makeClient(state: FakeState, failTables = new Set<string>()) {
  function from(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let limitN: number | null = null;
    let op: "select" | "insert" | "update" = "select";
    let patch: Row | null = null;
    let inserted: Row[] = [];
    const fail = failTables.has(table) ? { message: `${table} unreadable` } : null;
    const rows = () => (state[table] ?? []).filter((r) => filters.every((f) => f(r)));
    const run = () => {
      if (fail) return { data: null, error: fail };
      if (op === "insert") return { data: inserted, error: null };
      if (op === "update") {
        const hit = rows();
        for (const r of hit) Object.assign(r, patch);
        return { data: hit, error: null };
      }
      const all = rows();
      return { data: limitN == null ? all : all.slice(0, limitN), error: null };
    };
    const b: any = {
      select() { return b; },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return b; },
      neq(c: string, v: any) { filters.push((r) => r[c] !== v); return b; },
      in(c: string, vs: any[]) { filters.push((r) => vs.includes(r[c])); return b; },
      is(c: string, v: any) { filters.push((r) => (r[c] ?? null) === v); return b; },
      gt(c: string, v: any) { filters.push((r) => r[c] > v); return b; },
      gte(c: string, v: any) { filters.push((r) => r[c] >= v); return b; },
      lt(c: string, v: any) { filters.push((r) => r[c] < v); return b; },
      or(expr: string) {
        const terms = expr.split(",").map((t) => /^([a-z_]+)\.eq\.(.+)$/.exec(t.trim())!).map((m) => ({ c: m[1], v: m[2] }));
        filters.push((r) => terms.some((t) => String(r[t.c]) === t.v));
        return b;
      },
      order() { return b; },
      limit(n: number) { limitN = n; return b; },
      insert(input: Row | Row[]) {
        op = "insert";
        inserted = (Array.isArray(input) ? input : [input]).map((r) => ({ ...r }));
        if (!fail) (state[table] ??= []).push(...inserted);
        return b;
      },
      upsert(input: Row) { return b.insert(input); },
      update(p: Row) { op = "update"; patch = p; return b; },
      maybeSingle: async () => { const r = run(); return { ...r, data: Array.isArray(r.data) ? r.data[0] ?? null : r.data }; },
      single: async () => { const r = run(); return { ...r, data: Array.isArray(r.data) ? r.data[0] ?? null : r.data }; },
      then(onF: any, onR: any) { return Promise.resolve(run()).then(onF, onR); },
    };
    return b;
  }
  return {
    from,
    auth: {
      getUser: async (tok: string) => {
        const map: Record<string, string> = { owner: OWNER, invitee: INVITEE, requester: REQUESTER, stranger: STRANGER, blocked: BLOCKED, pam: PRIVATE_MEMBER };
        const id = map[tok];
        return id ? { data: { user: { id } }, error: null } : { data: { user: null }, error: { message: "invalid" } };
      },
    },
  };
}

async function startApp(state: FakeState, failTables = new Set<string>()) {
  _setTestClient(makeClient(state, failTables) as any, true);
  const app = express();
  app.use(express.json());
  app.use((req: any, _r: any, next: any) => { req.log = { error: () => {}, info: () => {}, warn: () => {} }; next(); });
  app.use("/api", sharedMomentsRouter);
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

async function call(base: string, method: string, path: string, tok?: string, body?: unknown) {
  const h: Record<string, string> = { connection: "close" };
  if (tok) h.Authorization = `Bearer ${tok}`;
  if (body !== undefined) h["Content-Type"] = "application/json";
  const res = await fetch(`${base}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const json: any = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

async function withApp(fn: (base: string, state: FakeState) => Promise<void>, state = baseState(), fail = new Set<string>()) {
  const app = await startApp(state, fail);
  try { await fn(app.baseUrl, state); } finally { await app.close(); }
}

describe("GET /shared-moments/:id/preview — the door an invitation or a request needs", () => {
  it("an invited person sees the Moment and their own status", () => withApp(async (base) => {
    const { status, body } = await call(base, "GET", `/api/shared-moments/${M_INVITE}/preview`, "invitee");
    assert.equal(status, 200);
    assert.equal(body.moment.title, "Sunset at the pier");
    assert.equal(body.myStatus, "invited");
  }));

  it("an approval-required Moment is previewable by anyone not blocked, so they can ask to join", () => withApp(async (base) => {
    const { status, body } = await call(base, "GET", `/api/shared-moments/${M_OPEN}/preview`, "stranger");
    assert.equal(status, 200);
    assert.equal(body.myStatus, null);
    assert.equal(body.moment.joinPolicy, "approval_required");
  }));

  it("an offered suggestion opens the preview of an invite-only Moment", () => withApp(async (base) => {
    // REQUESTER holds an offered suggestion for M_INVITE in the fixture.
    const { status } = await call(base, "GET", `/api/shared-moments/${M_INVITE}/preview`, "requester");
    assert.equal(status, 200);
  }));

  it("an invite-only Moment with no invitation and no suggestion is not_found", () => withApp(async (base, state) => {
    state.shared_moment_suggestions = [];
    const { status } = await call(base, "GET", `/api/shared-moments/${M_INVITE}/preview`, "requester");
    assert.equal(status, 404);
  }));

  it("a block hides the Moment even when the door is open", () => withApp(async (base) => {
    const { status } = await call(base, "GET", `/api/shared-moments/${M_OPEN}/preview`, "blocked");
    assert.equal(status, 404);
  }));

  it("an unreadable blocks table fails CLOSED", () => withApp(async (base) => {
    const { status } = await call(base, "GET", `/api/shared-moments/${M_OPEN}/preview`, "stranger");
    assert.equal(status, 503);
  }, baseState(), new Set(["blocks"])));
});

describe("GET /me/shared-moment-invites — where an invitation is found", () => {
  it("lists the caller's pending invitations only", () => withApp(async (base) => {
    const { status, body } = await call(base, "GET", "/api/me/shared-moment-invites", "invitee");
    assert.equal(status, 200);
    assert.deepEqual(body.invites.map((i: any) => i.moment.id), [M_INVITE]);
  }));

  it("an unreadable memberships table is a 503, not 'no invitations'", () => withApp(async (base) => {
    const { status } = await call(base, "GET", "/api/me/shared-moment-invites", "invitee");
    assert.equal(status, 503);
  }, baseState(), new Set(["shared_moment_memberships"])));
});

describe("GET /shared-moments/:id/requests — the owner's join-request queue", () => {
  it("the owner sees pending requests, minus anyone blocked", () => withApp(async (base) => {
    const { status, body } = await call(base, "GET", `/api/shared-moments/${M_OPEN}/requests`, "owner");
    assert.equal(status, 200);
    assert.deepEqual(body.requests.map((r: any) => r.userId), [REQUESTER]);
    assert.equal(body.requests[0].handle, "rex");
  }));

  it("a plain member may not read the queue", () => withApp(async (base) => {
    const { status } = await call(base, "GET", `/api/shared-moments/${M_OPEN}/requests`, "invitee");
    assert.equal(status, 403);
  }));
});

describe("GET /shared-moments/:id/contributions — pending review", () => {
  it("the owner sees every pending contribution; a private author's post is withheld as media", () => withApp(async (base) => {
    const { status, body } = await call(base, "GET", `/api/shared-moments/${M_OPEN}/contributions`, "owner");
    assert.equal(status, 200);
    const byId = Object.fromEntries(body.contributions.map((c: any) => [c.id, c]));
    assert.deepEqual(Object.keys(byId).sort(), ["c1", "c2"]);
    assert.equal(byId.c1.mediaUrl, "https://cdn/p1.jpg");
    assert.equal(byId.c1.caption, "Golden light");
    assert.equal(byId.c2.mediaUrl, null);
    assert.equal(byId.c2.caption, "from a private account");
    assert.notEqual(byId.c2.caption, "hidden words");
  }));

  it("a member sees only their own pending contributions", () => withApp(async (base) => {
    const { status, body } = await call(base, "GET", `/api/shared-moments/${M_OPEN}/contributions`, "invitee");
    assert.equal(status, 200);
    assert.deepEqual(body.contributions.map((c: any) => c.id), ["c1"]);
  }));

  it("a non-member is refused", () => withApp(async (base) => {
    const { status } = await call(base, "GET", `/api/shared-moments/${M_OPEN}/contributions`, "stranger");
    assert.equal(status, 403);
  }));
});

describe("GET /shared-moments/:id/contributable-posts — the member's own sources", () => {
  it("offers only the caller's own posts at the Moment's place", () => withApp(async (base) => {
    const { status, body } = await call(base, "GET", `/api/shared-moments/${M_OPEN}/contributable-posts`, "invitee");
    assert.equal(status, 200);
    assert.deepEqual(body.posts.map((p: any) => p.id), [POST_PUBLIC]);
    assert.equal(body.posts[0].contributed, true);
  }));

  it("a non-member is refused", () => withApp(async (base) => {
    const { status } = await call(base, "GET", `/api/shared-moments/${M_OPEN}/contributable-posts`, "stranger");
    assert.equal(status, 403);
  }));
});

describe("notifications — an invitation and a join request each tell the person who must act", () => {
  it("inviting someone notifies them with a link to the Moment", () => withApp(async (base, state) => {
    const { status } = await call(base, "POST", `/api/shared-moments/${M_INVITE}/invites`, "owner", { userId: REQUESTER });
    assert.equal(status, 201);
    await new Promise((r) => setTimeout(r, 20));
    const note = state.notifications.find((n) => n.user_id === REQUESTER);
    assert.ok(note, "the invitee is notified");
    assert.equal(note!.action_url, `/shared-moments/${M_INVITE}`);
    assert.equal(note!.actor_id, OWNER);
  }));

  it("asking to join notifies the owner", () => withApp(async (base, state) => {
    const { status } = await call(base, "POST", `/api/shared-moments/${M_OPEN}/request`, "stranger");
    assert.equal(status, 201);
    await new Promise((r) => setTimeout(r, 20));
    const note = state.notifications.find((n) => n.user_id === OWNER);
    assert.ok(note, "the owner is notified");
    assert.equal(note!.action_url, `/shared-moments/${M_OPEN}`);
  }));
});

describe("POST /shared-moments/suggestions/:id/dismiss", () => {
  it("the recipient dismisses their suggestion", () => withApp(async (base, state) => {
    const { status } = await call(base, "POST", `/api/shared-moments/suggestions/${SUGGESTION}/dismiss`, "stranger");
    assert.equal(status, 200);
    assert.equal(state.shared_moment_suggestions.find((s) => s.id === SUGGESTION)!.status, "dismissed");
  }));

  it("nobody else can dismiss it", () => withApp(async (base, state) => {
    const { status } = await call(base, "POST", `/api/shared-moments/suggestions/${OTHERS_SUGGESTION}/dismiss`, "stranger");
    assert.equal(status, 404);
    assert.equal(state.shared_moment_suggestions.find((s) => s.id === OTHERS_SUGGESTION)!.status, "offered");
  }));
});
