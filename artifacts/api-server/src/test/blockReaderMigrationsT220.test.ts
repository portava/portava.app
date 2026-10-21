/**
 * census-telegraph T220 part 2 — the sites moved off their private `blocks`
 * reads onto lib/exclusionSet.ts's directional, whole, batched and count
 * readers, pinned where no existing suite reached them.
 *
 * node:test + node:assert. In-process fakes; the route cases listen on
 * 127.0.0.1 (run with loopback allowed).
 *
 * Each describe names the site, and each case says whether it was GREEN on the
 * private read too (a behaviour the move had to keep — directions, ids,
 * refusals) or RED on it (an edge the private read left open, closed by the
 * shared reader's contract). Every block case has a no-block CONTROL beside it.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import adminRouter from "../routes/admin.js";
import followsRouter from "../routes/follows.js";
import { resolveShareProjections } from "../services/telegraph/shareables.js";
import { coalescingClient } from "../services/telegraph/coalescedReads.js";
import compassRouter from "../routes/compass.js";
import pulseRouter from "../routes/pulse.js";
import highlightsRouter from "../routes/highlights.js";
import { RESURFACING_TABLE } from "../services/highlights/highlightResurfacing.js";
import { PROJECTION_POLICY_TABLE } from "../services/highlights/highlightProjectionPolicy.js";
import { makeClient as makeHighlightClient } from "./highlightRouteHarness.js";
import { invalidateFlagsCache } from "../compass/flags.js";
import { clearCompassProfileCache, getCompassProfile } from "../compass/CompassProfileService.js";
import { resolveInteractionPermissions } from "../services/interactionPermissions.js";

const ADMIN = "a1111111-1111-4111-8111-111111111111";
const UID = "a2222222-2222-4222-8222-222222222222";
const OTHER = "a3333333-3333-4333-8333-333333333333";
const THIRD = "a4444444-4444-4444-8444-444444444444";
const ERR = { message: "simulated blocks failure", code: "57014" };

type Call = [string, unknown[]];
type Answer = { data: unknown; error: unknown; count?: number | null };
type BlockRow = { blocker_id: string; blocked_id: string };

/** The rows a recorded `blocks` chain selects (eq / in / or over blocker_id, blocked_id). */
function filterBlocks(rows: BlockRow[], calls: Call[]): BlockRow[] {
  return rows.filter((r) => calls.every(([m, a]) => {
    const [c, v] = a as [keyof BlockRow, any];
    if (m === "eq") return r[c] === v;
    if (m === "in") return (v as string[]).includes(r[c]);
    if (m === "gt") return String(r[c]) > String(v);
    if (m === "or") return orMatches(r, String(a[0]));
    return true;
  }));
}

/** PostgREST `.or()`: top-level clauses joined by commas, each `col.eq.val` or `and(col.eq.val,…)`. */
function orMatches(r: BlockRow, expr: string): boolean {
  const top = expr.split(/,(?![^(]*\))/).map((t) => t.trim());
  const atom = (t: string) => { const [col, op, ...rest] = t.split("."); assert.equal(op, "eq", `fake: or(${t})`); return (r as any)[col] === rest.join("."); };
  return top.some((t) => (t.startsWith("and(") ? t.slice(4, -1).split(",").every(atom) : atom(t)));
}

/** A healthy `blocks` answer to a recorded chain, honouring head counts and `{ count: "exact" }`. */
function blocksAnswer(rows: BlockRow[], calls: Call[]): Answer {
  const sel = calls.find(([m]) => m === "select");
  const opts = (sel?.[1][1] ?? {}) as { count?: string; head?: boolean };
  let out = filterBlocks(rows, calls);
  const total = out.length;
  const lim = calls.find(([m]) => m === "limit");
  if (lim) out = out.slice(0, lim[1][0] as number);
  const count = opts.count === "exact" ? total : null;
  if (opts.head) return { data: null, error: null, count };
  return { data: out.map((r) => ({ ...r })), error: null, count };
}

/**
 * A permissive world: `blocks` from `blockRows` (or `blocks(calls)` when given),
 * `extra` for anything a case needs, every other read empty.
 */
function world(o: {
  blockRows?: BlockRow[];
  blocks?: (calls: Call[]) => Answer | "throw" | undefined;
  extra?: (table: string, calls: Call[], single: boolean) => Answer | undefined;
  /** Who the bearer token belongs to (default: ADMIN). */
  userId?: string;
}) {
  function builder(table: string) {
    const calls: Call[] = [];
    const answer = (single: boolean): Answer => {
      if (table === "blocks") {
        const over = o.blocks?.(calls);
        if (over === "throw") throw new Error("simulated thrown blocks read");
        if (over) return over;
        return blocksAnswer(o.blockRows ?? [], calls);
      }
      const x = o.extra?.(table, calls, single);
      if (x) return x;
      return { data: single ? null : [], error: null, count: single ? null : 0 };
    };
    const b: any = new Proxy({}, {
      get(_t, prop: string) {
        if (prop === "then") return (f: any, r: any) => Promise.resolve().then(() => answer(false)).then(f, r);
        if (prop === "maybeSingle" || prop === "single") return () => Promise.resolve().then(() => answer(true));
        return (...args: unknown[]) => { calls.push([prop, args]); return b; };
      },
    });
    return b;
  }
  return {
    from: (table: string) => builder(table),
    rpc: () => Promise.resolve({ data: null, error: null }),
    auth: { getUser: () => Promise.resolve({ data: { user: { id: o.userId ?? ADMIN } }, error: null }) },
  } as any;
}

// ── a tiny loopback harness ──────────────────────────────────────────────────

function serve(router: express.Router) {
  let server: http.Server;
  let base = "";
  before(async () => {
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => { req.log = { error() {}, warn() {}, info() {}, debug() {} }; next(); });
    app.use(router);
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as any).port}`;
  });
  after(() => server.close());
  return async (path: string, client: any): Promise<{ status: number; body: any }> => {
    _setTestClient(client, true);
    _setTestServiceClient(client);
    const r = await fetch(`${base}${path}`, { headers: { authorization: "Bearer fake.jwt.token" } });
    const text = await r.text();
    let body: any; try { body = JSON.parse(text); } catch { body = text; }
    return { status: r.status, body };
  };
}

// ══ routes/admin.ts — GET /admin/users/:userId/summary blockCount (countBlockRows) ══

function adminWorld(o: Parameters<typeof world>[0]) {
  return world({
    ...o,
    extra: (table, _calls, single) => {
      if (table === "profiles") return { data: single ? { id: UID, role: "admin", handle: "target", account_status: "active" } : [], error: null };
      return undefined;
    },
  });
}

describe("T220 migration — the moderation dossier's blockCount (countBlockRows, either direction)", () => {
  const get = serve(adminRouter);
  const summary = (c: any) => get(`/admin/users/${UID}/summary`, c);

  it("GREEN before and after: counts block ROWS touching the user — a mutual block is two, a stranger's block none", async () => {
    const r = await summary(adminWorld({ blockRows: [
      { blocker_id: UID, blocked_id: OTHER }, { blocker_id: OTHER, blocked_id: UID },
      { blocker_id: THIRD, blocked_id: UID }, { blocker_id: OTHER, blocked_id: THIRD },
    ] }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.blockCount, 3);
  });

  it("GREEN before and after (CONTROL): nobody blocked → blockCount 0 and the record renders", async () => {
    const r = await summary(adminWorld({ blockRows: [] }));
    assert.equal(r.status, 200);
    assert.equal(r.body.blockCount, 0);
  });

  it("GREEN before and after: a returned error refuses the record and names blockCount", async () => {
    const r = await summary(adminWorld({ blocks: () => ({ data: null, error: ERR, count: null }) }));
    assert.equal(r.status, 500);
    assert.equal(r.body.error, "db_error");
    assert.match(JSON.stringify(r.body), /blockCount/);
  });

  it("RED before: a count-less answer with no error rendered blockCount 0 — now it refuses, naming blockCount", async () => {
    const r = await summary(adminWorld({ blocks: () => ({ data: null, error: null, count: null }) }));
    assert.notEqual(r.status, 200, `a count-less blocks answer rendered a clean record: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, "db_error");
    assert.match(JSON.stringify(r.body), /blockCount/);
  });

  it("RED before: a THROWN blocks read crashed the whole dossier — now it is the same named refusal", async () => {
    const r = await summary(adminWorld({ blocks: () => "throw" }));
    assert.equal(r.body?.error, "db_error", JSON.stringify(r.body));
    assert.match(JSON.stringify(r.body), /blockCount/);
  });
});

// ══ services/interactionPermissions.ts — PRIORITY 2 block check (readPairDirections) ══

describe("T220 migration — interaction permissions' block check keeps the DIRECTION (readPairDirections)", () => {
  const resolve = (o: Parameters<typeof world>[0]) => resolveInteractionPermissions(world(o), UID, OTHER);

  it("GREEN before and after: the viewer blocked the target → 'blocked', canUnblock, not canBlock", async () => {
    const p = await resolve({ blockRows: [{ blocker_id: UID, blocked_id: OTHER }] });
    assert.equal(p.relationshipLabel, "blocked");
    assert.equal(p.canUnblock, true); assert.equal(p.canBlock, false);
  });
  it("GREEN before and after: the target blocked the viewer → 'blocks_you', canBlock, not canUnblock", async () => {
    const p = await resolve({ blockRows: [{ blocker_id: OTHER, blocked_id: UID }] });
    assert.equal(p.relationshipLabel, "blocks_you");
    assert.equal(p.canUnblock, false); assert.equal(p.canBlock, true);
  });
  it("GREEN before and after: a mutual block → 'mutual_block', canUnblock", async () => {
    const p = await resolve({ blockRows: [{ blocker_id: UID, blocked_id: OTHER }, { blocker_id: OTHER, blocked_id: UID }] });
    assert.equal(p.relationshipLabel, "mutual_block");
    assert.equal(p.canUnblock, true);
  });
  it("GREEN before and after (CONTROL): a stranger's block is not this pair's — the label is not a block", async () => {
    const p = await resolve({ blockRows: [{ blocker_id: THIRD, blocked_id: UID }, { blocker_id: OTHER, blocked_id: THIRD }] });
    assert.ok(!["blocked", "blocks_you", "mutual_block"].includes(p.relationshipLabel), p.relationshipLabel);
  });
  it("GREEN before and after: a returned error throws the critical-safety refusal", async () => {
    await assert.rejects(resolve({ blocks: () => ({ data: null, error: ERR }) }), /Critical safety query failed/);
  });
  for (const [name, ans] of [["data: null", { data: null, error: null }], ["a string", { data: "rows", error: null }]] as const) {
    it(`RED before: an answer that is ${name} with no error (null read as "no block"; a string threw a TypeError) — now the same critical-safety refusal`, async () => {
      await assert.rejects(resolve({ blocks: () => ans }), /Critical safety query failed/);
    });
  }
  it("RED before: a THROWN read escaped with its own message — now it is the same critical-safety refusal", async () => {
    await assert.rejects(resolve({ blocks: () => "throw" }), /Critical safety query failed/);
  });
});

// ══ routes/follows.ts — the two passport handlers' block gate (readPairDirections) ══

const TARGET_PROFILE = {
  id: OTHER, handle: "targetuser", name: "Target Person", avatar_url: null, bio: "bio", home_city: "Lisbon", home_country: "PT",
  current_city: "Porto", interests: [], verified: false, is_private: false, passport_visibility: "public", created_at: "2026-01-01T00:00:00Z",
  account_status: "active", is_official: false,
};

function passportWorld(o: Parameters<typeof world>[0]) {
  return world({
    userId: UID,
    ...o,
    extra: (table, calls, single) => {
      if (table === "profiles" && single) {
        const eq = (c: string) => calls.find(([m, a]) => m === "eq" && a[0] === c)?.[1][1];
        const ilike = calls.find(([m, a]) => (m === "ilike" || m === "eq") && a[0] === "handle")?.[1][1];
        if (eq("id") === OTHER || (typeof ilike === "string" && ilike.toLowerCase() === "targetuser")) return { data: TARGET_PROFILE, error: null };
        if (eq("id") === UID) return { data: { id: UID, account_status: "active" }, error: null };
      }
      return undefined;
    },
  });
}

describe("T220 migration — the passport's block gate, both handlers (readPairDirections)", () => {
  const get = serve(followsRouter);
  for (const [name, path] of [["GET /users/:userId", `/users/${OTHER}`], ["GET /users/by-handle/:handle", "/users/by-handle/targetuser"]] as const) {
    it(`${name} — GREEN before and after (CONTROL): no block → the passport is served`, async () => {
      const r = await get(path, passportWorld({ blockRows: [] }));
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.unavailable, undefined, JSON.stringify(r.body));
    });
    it(`${name} — GREEN before and after: the caller blocked the target → the stub, isBlocker: true`, async () => {
      const r = await get(path, passportWorld({ blockRows: [{ blocker_id: UID, blocked_id: OTHER }] }));
      assert.deepEqual([r.status, r.body], [200, { unavailable: true, reason: "blocked", isBlocker: true }]);
    });
    it(`${name} — GREEN before and after: a MUTUAL block answers as the target's block — isBlocker: false`, async () => {
      const r = await get(path, passportWorld({ blockRows: [{ blocker_id: UID, blocked_id: OTHER }, { blocker_id: OTHER, blocked_id: UID }] }));
      assert.deepEqual([r.status, r.body], [200, { unavailable: true, reason: "blocked", isBlocker: false }]);
    });
    it(`${name} — GREEN before and after (CONTROL): another pair's block is not this one's`, async () => {
      const r = await get(path, passportWorld({ blockRows: [{ blocker_id: THIRD, blocked_id: UID }, { blocker_id: OTHER, blocked_id: THIRD }] }));
      assert.equal(r.status, 200);
      assert.equal(r.body.unavailable, undefined);
    });
    it(`${name} — RED before: an answer with no rows, no count and no error read as "not blocked" (\`count ?? 0\`) and served the passport — now 503`, async () => {
      const r = await get(path, passportWorld({ blocks: () => ({ data: null, error: null, count: null }) }));
      assert.equal(r.status, 503, `a malformed blocks answer served: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.error, "degraded_unavailable");
      assert.ok(!JSON.stringify(r.body).includes("targetuser"), "no profile field in the refusal");
    });
    it(`${name} — RED before: a THROWN blocks read crashed the handler (500) — now the gate's own 503`, async () => {
      const r = await get(path, passportWorld({ blocks: () => "throw" }));
      assert.equal(r.status, 503, JSON.stringify(r.body));
      assert.equal(r.body.error, "degraded_unavailable");
    });
  }
});

// ══ services/telegraph/shareables.ts — readBlockBetween (readPairDirections) ══

const SHARED_POST = {
  id: "a5555555-5555-4555-8555-555555555555", author_id: OTHER, content: "SHARED-POST-BODY", visibility: "public", status: "active", post_status: "published",
  deleted_at: null, media_urls: [], location_privacy_mode: null, created_at: "2026-09-29T00:00:00.000Z", updated_at: "2026-09-29T00:00:00.000Z",
};
function shareWorld(o: Parameters<typeof world>[0]) {
  return world({
    ...o,
    extra: (table, _calls, single) => {
      if (table === "posts") return single ? { data: SHARED_POST, error: null } : { data: [SHARED_POST], error: null };
      if (table === "profiles") { const row = { id: OTHER, handle: "postauthor", account_status: "active" }; return single ? { data: row, error: null } : { data: [row], error: null }; }
      return undefined;
    },
  });
}
const postCard = async (client: any) => (await resolveShareProjections(client, UID, "a6666666-6666-4666-8666-666666666666", [{ objectType: "POST" as any, objectId: SHARED_POST.id }]))[0];

describe("T220 migration — share cards' block read (readPairDirections, still coalesced)", () => {
  for (const [label, wrap] of [["direct", (c: any) => c], ["coalesced", (c: any) => coalescingClient(c)]] as const) {
    it(`${label} — GREEN before and after (CONTROL): no block → the card resolves`, async () => {
      assert.equal((await postCard(wrap(shareWorld({ blockRows: [] })))).available, true);
    });
    it(`${label} — GREEN before and after: the author blocked the viewer → unauthorized`, async () => {
      const r = await postCard(wrap(shareWorld({ blockRows: [{ blocker_id: OTHER, blocked_id: UID }] })));
      assert.equal(!r.available && r.reason, "unauthorized");
    });
    it(`${label} — GREEN before and after: the viewer blocked the author → unauthorized`, async () => {
      const r = await postCard(wrap(shareWorld({ blockRows: [{ blocker_id: UID, blocked_id: OTHER }] })));
      assert.equal(!r.available && r.reason, "unauthorized");
    });
    it(`${label} — GREEN before and after: a returned error → unknown`, async () => {
      const r = await postCard(wrap(shareWorld({ blocks: () => ({ data: null, error: ERR }) })));
      assert.equal(!r.available && r.reason, "unknown");
    });
  }
  it("direct — RED before: a THROWN block read escaped the loader and rejected the whole batch — now that card is `unknown`", async () => {
    const r = await postCard(shareWorld({ blocks: () => "throw" }));
    assert.equal(r.available, false, JSON.stringify(r));
    assert.equal(!r.available && r.reason, "unknown");
  });
});

// ══ routes/compass.ts — surface=passport's one-direction read (readBlockDirection "outgoing") ══
//
// The passport surface runs the full pipeline first, whose CompassProfile already
// excludes both directions; its own read is a SECOND, one-direction filter. To
// see that read at all, these cases answer the profile's block reads (the ones
// before the events read) with nothing and only the passport's own read (every
// blocks read after the events read) with the case's answer. Without that, the
// suite's old passport case passed whether the passport filter worked or not.

const FUTURE = new Date(Date.now() + 7 * 86_400_000).toISOString();
const EVENT_ID = "a7777777-7777-4777-8777-777777777777";

function compassWorld(passportRead: (calls: Call[]) => Answer | "throw" | undefined) {
  let eventsRead = false;
  const tablesOf: Record<string, any[]> = {
    feature_flags: [{ flag: "COMPASS_ENABLED", enabled: true }],
    profiles: [{ id: UID, spoken_languages: ["en"], account_status: "active", is_private: false, city: "Cebu" }],
    user_location_state: [{ user_id: UID, city: "Cebu", updated_at: new Date().toISOString() }],
    events: [{ id: EVENT_ID, host_id: OTHER, title: "OTHER-HOSTED-RUN", category: "Sports", starts_at: FUTURE, ends_at: FUTURE, city: "Cebu", max_attendees: 50, going_count: 5, visibility: "public", state: "open" }],
  };
  return world({
    userId: UID,
    blocks: (calls) => (eventsRead ? passportRead(calls) ?? blocksAnswer([], calls) : blocksAnswer([], calls)),
    extra: (table, calls, single) => {
      if (table === "events") eventsRead = true;
      const rows = (tablesOf[table] ?? []).filter((r) => calls.every(([m, a]) => (m === "eq" ? r[a[0] as string] === a[1] : m === "in" ? (a[1] as unknown[]).includes(r[a[0] as string]) : true)));
      return { data: single ? rows[0] ?? null : rows, error: null, count: rows.length };
    },
  });
}

describe("T220 migration — compass surface=passport, the viewer's own blocks (readBlockDirection outgoing)", () => {
  const get = serve(compassRouter);
  const passport = async (c: any) => {
    invalidateFlagsCache(); clearCompassProfileCache();
    return get("/compass/recommendations?surface=passport", c);
  };
  const served = (r: { body: any }) => JSON.stringify(r.body).includes("OTHER-HOSTED-RUN");

  it("GREEN before and after (CONTROL): the passport read names nobody → the event is served", async () => {
    const r = await passport(compassWorld(() => undefined));
    assert.equal(r.status, 200);
    assert.ok(served(r), JSON.stringify(r.body).slice(0, 400));
  });
  it("GREEN before and after: the passport read names the host the viewer blocked → the event is not served", async () => {
    const r = await passport(compassWorld((calls) => blocksAnswer([{ blocker_id: UID, blocked_id: OTHER }], calls)));
    assert.equal(r.status, 200);
    assert.ok(!served(r), JSON.stringify(r.body).slice(0, 400));
  });
  it("GREEN before and after: a returned error → an empty list", async () => {
    const r = await passport(compassWorld(() => ({ data: null, error: ERR })));
    assert.deepEqual([r.status, r.body.recommendations], [200, []]);
  });
  it("GREEN before and after: a thrown read → an empty list", async () => {
    const r = await passport(compassWorld(() => "throw"));
    assert.deepEqual([r.status, r.body.recommendations], [200, []]);
  });
  for (const [name, ans] of [["data: null", { data: null, error: null }], ["a row naming nobody", { data: [{}], error: null }]] as const) {
    it(`RED before: an answer that is ${name} with no error read as "blocked nobody" and served everyone — now an empty list`, async () => {
      const r = await passport(compassWorld(() => ans));
      assert.deepEqual([r.status, r.body.recommendations], [200, []], JSON.stringify(r.body).slice(0, 400));
    });
  }
});

// ══ compass/CompassProfileService.ts — buildProfile's block lists (readBlockDirections) ══
// (The malformed answers are pinned in blockReadNonListEdgesT220.test.ts; these are the failures every version refused.)

describe("T220 migration — the Compass profile's block lists (readBlockDirections)", () => {
  it("GREEN before and after: a returned error on either direction throws the fail-closed refusal", async () => {
    for (const col of ["blocker_id", "blocked_id"]) {
      clearCompassProfileCache();
      await assert.rejects(getCompassProfile(world({ blocks: (c) => (c.some(([m, a]) => m === "eq" && a[0] === col) ? { data: null, error: ERR } : undefined) }), UID, true), /safety-list load failed/);
    }
  });
  it("GREEN before and after: a THROWN block read refuses the same way (it was a rejected allSettled slot; it is now one ok:false)", async () => {
    clearCompassProfileCache();
    await assert.rejects(getCompassProfile(world({ blocks: () => "throw" }), UID, true), /safety-list load failed/);
  });
  it("GREEN before and after (CONTROL): directions kept apart, a stranger's block in neither", async () => {
    clearCompassProfileCache();
    const p = await getCompassProfile(world({ blockRows: [{ blocker_id: UID, blocked_id: OTHER }, { blocker_id: THIRD, blocked_id: UID }, { blocker_id: OTHER, blocked_id: THIRD }] }), UID, true);
    assert.deepEqual([p.blockedUserIds, p.blockerUserIds, p.blockCount, p.blockerCount], [[OTHER], [THIRD], 1, 1]);
  });
});

// ══ routes/pulse.ts — GET /pulse and GET /pulse/live (readBlockDirections) ══

const PULSE_POST = {
  id: "a8888888-8888-4888-8888-888888888888", author_id: OTHER, content: "OTHER-PULSE-POST", created_at: new Date().toISOString(),
  visibility: "public", status: "active", post_status: "published", location_city: null, location_country: null, location_name: null,
  location_source: null, venue_name: null, media_urls: [], trip_id: null, pulse_geo_tags: null, post_media: [],
  profiles: { id: OTHER, username: "otheruser", full_name: "Other User", avatar_url: null },
};
function pulseWorld(o: Parameters<typeof world>[0]) {
  return world({
    userId: UID,
    ...o,
    extra: (table, _calls, single) => {
      if (table === "posts") return single ? { data: PULSE_POST, error: null } : { data: [PULSE_POST], error: null, count: 1 };
      if (table === "feature_flags") return { data: single ? { enabled: true } : [{ flag: "COMPASS_ENABLED", enabled: true }], error: null };
      return undefined;
    },
  });
}

describe("T220 migration — GET /pulse's block filter (readBlockDirections)", () => {
  const get = serve(pulseRouter);
  const pulse = (c: any) => get("/pulse", c);
  const served = (r: { body: any }) => JSON.stringify(r.body).includes("OTHER-PULSE-POST");

  it("GREEN before and after (CONTROL): nobody blocked → the post is served", async () => {
    const r = await pulse(pulseWorld({ blockRows: [] }));
    assert.equal(r.status, 200);
    assert.ok(served(r), JSON.stringify(r.body).slice(0, 400));
  });
  it("GREEN before and after: the author blocked the viewer → not served", async () => {
    const r = await pulse(pulseWorld({ blockRows: [{ blocker_id: OTHER, blocked_id: UID }] }));
    assert.ok(!served(r), JSON.stringify(r.body).slice(0, 400));
  });
  for (const [name, ans] of [["data: null", { data: null, error: null }], ["a row naming nobody", { data: [{}], error: null }]] as const) {
    it(`RED before: an answer that is ${name} with no error read as "blocked nobody" — now the empty, fail-closed feed`, async () => {
      const r = await pulse(pulseWorld({ blocks: () => ans }));
      assert.deepEqual([r.status, r.body.posts, r.body.total], [200, [], 0], JSON.stringify(r.body).slice(0, 400));
    });
  }
});

// ══ routes/highlights.ts — GET /highlights/active (readBlockDirections) ══
// No suite pinned that /active drops a blocked owner (an "ignore the block" mutant survived all 39 that reach it).

const HL_ID = "a9999999-9999-4999-8999-999999999999";
function highlightSeed(blocks: BlockRow[]): Record<string, any[]> {
  return {
    feature_flags: [],
    profiles: [
      { id: OTHER, handle: "owner", name: "Owner", avatar_url: null, show_name_publicly: true, account_status: "active" },
      { id: UID, handle: "viewer", name: "Viewer", avatar_url: null, show_name_publicly: true, account_status: "active" },
    ],
    blocks,
    highlights: [{
      id: HL_ID, owner_id: OTHER, media_url: `post-media/${OTHER}/highlights/${HL_ID}.jpg`, media_type: "image",
      caption: "hl", visibility: "public", location_name: null, location_city: null, location_country: null,
      created_at: "2026-09-10T00:00:00.000Z", expires_at: "2099-01-01T00:00:00.000Z", deleted_at: null, archived_at: null, pinned_at: null,
    }],
    highlight_views: [], highlight_likes: [], circle_memberships: [], trip_members: [],
    user_follows: [{ follower_id: UID, following_id: OTHER }],
    [RESURFACING_TABLE]: [],
    [PROJECTION_POLICY_TABLE]: [],
  };
}
/** The table-backed harness, with `blocks` answered by `blocks(calls)` when it returns something. */
function highlightWorld(rows: BlockRow[], blocks?: (calls: Call[]) => Answer | "throw" | undefined) {
  const inner: any = makeHighlightClient(highlightSeed(rows));
  if (!blocks) return inner;
  return new Proxy(inner, {
    get(t, prop) {
      if (prop !== "from") return Reflect.get(t, prop);
      return (table: string) => {
        if (table !== "blocks") return t.from(table);
        return world({ blocks }).from("blocks");
      };
    },
  });
}

describe("T220 migration — GET /highlights/active drops a blocked owner, either way (readBlockDirections)", () => {
  let server: http.Server; let base = "";
  before(async () => {
    const app = express(); app.use(express.json());
    app.use((rq: any, _res, next) => { rq.log = { error() {}, warn() {}, info() {}, debug() {} }; next(); });
    app.use("/api", highlightsRouter);
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as any).port}`;
  });
  after(() => server.close());
  const active = async (client: any) => {
    _setTestClient(client, true);
    const r = await fetch(`${base}/api/highlights/active`, { headers: { authorization: `Bearer ${UID}` } });
    return { status: r.status, body: (await r.json().catch(() => null)) as any };
  };
  const ids = (body: any): string[] => JSON.stringify(body ?? {}).includes(HL_ID) ? [HL_ID] : [];

  it("GREEN before and after (CONTROL): no block → the owner's Highlight is served", async () => {
    const r = await active(highlightWorld([]));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(ids(r.body), [HL_ID]);
  });
  for (const [label, row] of [["the owner blocked the viewer", { blocker_id: OTHER, blocked_id: UID }], ["the viewer blocked the owner", { blocker_id: UID, blocked_id: OTHER }]] as const) {
    it(`GREEN before and after: ${label} → not served`, async () => {
      const r = await active(highlightWorld([row]));
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(ids(r.body), []);
    });
  }
  it("GREEN before and after: a returned error → db_error, nothing served", async () => {
    const r = await active(highlightWorld([], () => ({ data: null, error: ERR })));
    assert.equal(r.body?.error, "db_error");
  });
  for (const [name, ans] of [["data: null", { data: null, error: null }], ["a row naming nobody", { data: [{}], error: null }]] as const) {
    it(`RED before: an answer that is ${name} with no error read as "blocked nobody" and served the feed — now db_error`, async () => {
      const r = await active(highlightWorld([], () => ans));
      assert.equal(r.body?.error, "db_error", JSON.stringify(r.body));
      assert.deepEqual(ids(r.body), []);
    });
  }
  it("RED before: a THROWN read crashed the handler — now the same db_error refusal", async () => {
    const r = await active(highlightWorld([], () => "throw"));
    assert.equal(r.body?.error, "db_error", JSON.stringify(r.body));
  });
});
