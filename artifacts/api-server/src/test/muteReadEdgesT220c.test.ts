/**
 * census-telegraph T220c — `user_mutes`, the OTHER exclusion table: an answer
 * that was not an answer read as "nobody is muted".
 *
 * node:test + node:assert. In-process fakes; the two route cases listen on
 * 127.0.0.1 (run with loopback allowed).
 *
 * A `user_mutes` row HIDES; emptiness SHOWS. Every list reader of it checked a
 * RETURNED error and then wrote `data ?? []` (or skipped a row it could not
 * read), so an answer with no error that is not a row list — `data: null`, a
 * string, an object — or a row that does not name who was muted built the
 * SAME empty mute set as a healthy "nobody is muted": the edge T220 part 2
 * closed for `blocks`. The list readers now go through lib/exclusionSet.ts
 * readMuteExclusions (whole, by key; never rejects; every failure `ok: false`)
 * and each answers `!ok` with the branch it ALREADY took for a returned error:
 *
 *   CompassProfileService.buildProfile   throws "block/mute safety-list load failed — failing closed"
 *   CompassTools.refreshHiddenUsers      keeps the ask-time snapshot's mutes; with none, throws (the tool refuses)
 *   CompassFallbackFeedBuilder           degrades to the static safety tools, "+mute_list_unavailable"
 *   discoveryCacheEligibility            withMutedAuthors answers null (every authored row withheld)
 *     .withMutedAuthors
 *   mediaEligibility (step 2)            the mute gate is OFF for the call and NAMED in softFailedSources
 *
 * and the two that are not list-into-exclusion reads, the same way:
 *
 *   routes/admin.ts dossier muteCount    a count-less HEAD answer refuses the record, naming muteCount
 *                                        (it rendered 0) — countMuteRows, as countBlockRows does for blockCount
 *   routes/mutes.ts GET /me/mutes        a non-list answer or a row naming nobody is the route's db_error
 *                                        (it rendered "you muted nobody")
 *
 * Each case says whether it was RED on the code before T220c (a85d2eb78) or
 * GREEN there too (a behaviour the change had to keep). Every refusal has a
 * healthy CONTROL beside it that serves, so a fix that refused everything
 * would fail its control.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { getCompassProfile, clearCompassProfileCache } from "../compass/CompassProfileService.js";
import { executeCompassTool } from "../compass/CompassTools.js";
import { buildFallbackFeed } from "../compass/CompassFallbackFeedBuilder.js";
import { invalidateFlagsCache } from "../compass/flags.js";
import { withMutedAuthors } from "../lib/discoveryCacheEligibility.js";
import { filterEligibleMediaCandidates, type MediaCandidate, type ViewerCtx } from "../lib/mediaEligibility.js";
import { readMuteExclusions, countMuteRows, isExcluded } from "../lib/exclusionSet.js";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import adminRouter from "../routes/admin.js";
import mutesRouter from "../routes/mutes.js";

const VIEWER = "ab000000-0000-4000-a000-0000000220c0";
const MUTED = "a0000000-0000-4000-a000-0000000220a1";
const OTHER = "c0000000-0000-4000-a000-0000000220c1";
const POST = "d0000000-0000-4000-a000-0000000220d1";
const EVENT = "e0000000-0000-4000-a000-0000000220e1";
const ERR = { message: "simulated user_mutes failure", code: "57014" };

type Call = [string, unknown[]];
type Answer = { data: unknown; error: unknown; count?: unknown };

/**
 * How `user_mutes` answers. `healthy` serves VIEWER's mutes of `muted`; the
 * others answer every mute read with a failure that carries no error (or an
 * error, or a rejected await).
 */
type MutesMode =
  | { kind: "healthy"; muted: string[] }
  | { kind: "error" }
  | { kind: "throw" }
  | { kind: "malformed"; answer: Malformed };
type Malformed = "null" | "string" | "object" | "rowWithoutId" | "emptyId";

const MALFORMED: Record<Malformed, () => Answer> = {
  null: () => ({ data: null, error: null }),
  string: () => ({ data: "not rows", error: null }),
  object: () => ({ data: { rows: [] }, error: null }),
  rowWithoutId: () => ({ data: [{}], error: null, count: 1 }),
  emptyId: () => ({ data: [{ muted_id: "" }], error: null, count: 1 }),
};
const NOT_A_LIST: Malformed[] = ["null", "string", "object"];
const ROW_NAMING_NOBODY: Malformed[] = ["rowWithoutId", "emptyId"];
const EVERY_MALFORMED: Malformed[] = [...NOT_A_LIST, ...ROW_NAMING_NOBODY];

function mutesAnswer(mode: MutesMode, calls: Call[]): Answer {
  if (mode.kind === "error") return { data: null, error: ERR, count: null };
  if (mode.kind === "throw") throw new Error("simulated thrown user_mutes read");
  if (mode.kind === "malformed") return MALFORMED[mode.answer]();
  const opts = (calls.find(([m]) => m === "select")?.[1][1] ?? {}) as { count?: string; head?: boolean };
  const muter = calls.find(([m, a]) => m === "eq" && a[0] === "muter_id")?.[1][1];
  const rows = muter === VIEWER ? mode.muted.map((m) => ({ muted_id: m })) : [];
  if (opts.head) return { data: null, error: null, count: rows.length };
  return { data: rows, error: null, count: opts.count === "exact" ? rows.length : null };
}

/** A permissive world: `user_mutes` per `mode`, `blocks` healthy and empty, `extra` for what a case needs, every other read empty. */
function world(mode: MutesMode, extra: (table: string, calls: Call[], single: boolean) => Answer | undefined = () => undefined, userId = VIEWER, muteReads?: Call[][]) {
  function builder(table: string) {
    const calls: Call[] = [];
    const answer = (single: boolean): Answer => {
      if (table === "user_mutes") { muteReads?.push(calls); return mutesAnswer(mode, calls); }
      const x = extra(table, calls, single);
      if (x) return x;
      if (table === "blocks") return { data: [], error: null, count: 0 };
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
    auth: { getUser: () => Promise.resolve({ data: { user: { id: userId } }, error: null }) },
  } as any;
}

// ── 0. the reader itself ────────────────────────────────────────────────────

describe("T220c — readMuteExclusions: the mute list's definition of record", () => {
  it("CONTROL: a healthy read is the set of everyone the viewer muted — one request, the plain read plus its count", async () => {
    const reads: Call[][] = [];
    const c = world({ kind: "healthy", muted: [MUTED, OTHER] }, undefined, VIEWER, reads);
    const r = await readMuteExclusions(c, VIEWER);
    assert.ok(r.ok, JSON.stringify(r));
    assert.deepEqual(reads, [[["select", ["muted_id", { count: "exact" }]], ["eq", ["muter_id", VIEWER]]]]);
    assert.deepEqual([...r.ids].sort(), [MUTED, OTHER].sort());
    assert.equal(isExcluded(r, MUTED), true);
    assert.equal(isExcluded(r, POST), false);
  });

  it("CONTROL: nobody muted is a readable EMPTY set", async () => {
    const r = await readMuteExclusions(world({ kind: "healthy", muted: [] }), VIEWER);
    assert.ok(r.ok);
    assert.equal(r.ids.size, 0);
  });

  for (const mode of [{ kind: "error" }, { kind: "throw" }, ...EVERY_MALFORMED.map((answer) => ({ kind: "malformed", answer }))] as MutesMode[]) {
    it(`${JSON.stringify(mode)} → ok:false, and isExcluded answers true for everybody (never rejects)`, async () => {
      const r = await readMuteExclusions(world(mode), VIEWER);
      assert.equal(r.ok, false, JSON.stringify(r));
      assert.equal(isExcluded(r, POST), true);
    });
  }

  it("no client or no viewer → ok:false", async () => {
    assert.equal((await readMuteExclusions(null, VIEWER)).ok, false);
    assert.equal((await readMuteExclusions(world({ kind: "healthy", muted: [] }), "")).ok, false);
  });
});

// ── 1. CompassProfileService ────────────────────────────────────────────────

describe("T220c — CompassProfileService: a malformed mutes answer refuses the profile, as an error does", () => {
  beforeEach(() => clearCompassProfileCache());

  it("GREEN before (CONTROL): a healthy read builds a profile naming the muted user", async () => {
    const p = await getCompassProfile(world({ kind: "healthy", muted: [MUTED] }), VIEWER, true);
    assert.deepEqual(p.mutedUserIds, [MUTED]);
  });
  it("GREEN before: a returned error refuses the profile", async () => {
    await assert.rejects(getCompassProfile(world({ kind: "error" }), VIEWER, true), /safety-list load failed/);
  });
  it("GREEN before: a thrown read refuses the profile", async () => {
    await assert.rejects(getCompassProfile(world({ kind: "throw" }), VIEWER, true), /safety-list load failed/);
  });
  for (const answer of EVERY_MALFORMED) {
    it(`RED before: the mutes read answers ${answer} with no error → buildProfile throws "safety-list load failed", never an empty or garbled mute list`, async () => {
      await assert.rejects(getCompassProfile(world({ kind: "malformed", answer }), VIEWER, true), /safety-list load failed/);
    });
  }
});

// ── 2. CompassTools.refreshHiddenUsers (through search_events) ──────────────

function eventsWorld(mode: MutesMode) {
  return world(mode, (table) => {
    if (table === "events") {
      return { data: [{ id: EVENT, title: "MUTED-HOST-EVENT", description: null, city: "Paris", country: "FR", starts_at: "2099-01-01T00:00:00.000Z", category: "music", host_id: MUTED, state: "open", visibility: "public" }], error: null };
    }
    return undefined;
  });
}
const SNAPSHOT = { userId: VIEWER, blockedUserIds: [], blockerUserIds: [], mutedUserIds: [MUTED] } as any;
const searchEvents = async (mode: MutesMode, profile: any) => JSON.stringify(await executeCompassTool(eventsWorld(mode), VIEWER, profile, "search_events", {}));

describe("T220c — CompassTools.refreshHiddenUsers: a malformed mutes answer keeps the snapshot (or refuses), as an error does", () => {
  it("GREEN before (CONTROL): a healthy read naming nobody (unmuted mid-conversation) serves the host's event", async () => {
    assert.ok((await searchEvents({ kind: "healthy", muted: [] }, SNAPSHOT)).includes("MUTED-HOST-EVENT"));
  });
  it("GREEN before (CONTROL): a healthy read naming the mute hides the host's event", async () => {
    assert.ok(!(await searchEvents({ kind: "healthy", muted: [MUTED] }, SNAPSHOT)).includes("MUTED-HOST-EVENT"));
  });
  it("GREEN before: a returned error keeps the snapshot's mute", async () => {
    assert.ok(!(await searchEvents({ kind: "error" }, SNAPSHOT)).includes("MUTED-HOST-EVENT"));
  });
  it("GREEN before: a thrown read keeps the snapshot's mute", async () => {
    assert.ok(!(await searchEvents({ kind: "throw" }, SNAPSHOT)).includes("MUTED-HOST-EVENT"));
  });
  for (const answer of EVERY_MALFORMED) {
    const red = answer === "null" || ROW_NAMING_NOBODY.includes(answer) ? "RED before" : "GREEN before (a TypeError reached the catch)";
    it(`${red}: WITH a snapshot, the mutes read answers ${answer} → the snapshot's mute still hides the host`, async () => {
      const out = await searchEvents({ kind: "malformed", answer }, SNAPSHOT);
      assert.ok(!out.includes("MUTED-HOST-EVENT"), `a malformed mutes answer un-hid the muted host: ${out}`);
    });
    it(`${red}: WITHOUT a snapshot, the mutes read answers ${answer} → the tool refuses rather than read "nobody muted"`, async () => {
      const out = await searchEvents({ kind: "malformed", answer }, null);
      assert.ok(!out.includes("MUTED-HOST-EVENT"), out);
      assert.match(out, /error/i, `the tool must refuse, got ${out}`);
    });
  }
  it("GREEN before (CONTROL): WITHOUT a snapshot, a healthy read naming nobody serves the event", async () => {
    assert.ok((await searchEvents({ kind: "healthy", muted: [] }, null)).includes("MUTED-HOST-EVENT"));
  });
});

// ── 3. CompassFallbackFeedBuilder.loadMutedIds ──────────────────────────────

function feedWorld(mode: MutesMode) {
  return world(mode, (table, calls) => {
    const has = (m: string) => calls.some(([k]) => k === m);
    if (table === "feature_flags") {
      if (has("like")) return { data: [{ flag: "COMPASS_ENABLED", enabled: true }, { flag: "COMPASS_V1_RULE_BASED_ENABLED", enabled: true }], error: null };
      return { data: null, error: null };
    }
    if (table === "posts") {
      return { data: [
        { id: POST, author_id: MUTED, content: "MUTED-AUTHOR-POST", like_count: 99, comment_count: 1, post_status: "published", publish_eligible_at: null, visibility: "public", status: "active", created_at: "2026-09-29T00:00:00.000Z", city: "Paris" },
      ], error: null };
    }
    return undefined;
  });
}

describe("T220c — CompassFallbackFeedBuilder: a malformed mutes answer degrades to the safety tools, as an error does", () => {
  beforeEach(() => invalidateFlagsCache());

  it("GREEN before (CONTROL): nobody muted → the post is served (the world reaches the fallback)", async () => {
    const r = await buildFallbackFeed(feedWorld({ kind: "healthy", muted: [] }), VIEWER, null, "build_error");
    assert.ok(JSON.stringify(r).includes("MUTED-AUTHOR-POST"), JSON.stringify(r).slice(0, 600));
    assert.equal(r.fallbackReason, "build_error");
  });
  it("GREEN before (CONTROL): the author is muted → the post is not served", async () => {
    const r = await buildFallbackFeed(feedWorld({ kind: "healthy", muted: [MUTED] }), VIEWER, null, "build_error");
    assert.ok(!JSON.stringify(r).includes("MUTED-AUTHOR-POST"), JSON.stringify(r).slice(0, 600));
  });
  it("GREEN before: a returned error → safety tools only, reason mute_list_unavailable", async () => {
    const r = await buildFallbackFeed(feedWorld({ kind: "error" }), VIEWER, null, "build_error");
    assert.equal(r.fallbackReason, "build_error+mute_list_unavailable");
    assert.deepEqual(r.sections.map((s) => s.name), ["safety_tools"]);
  });
  it("RED before: a THROWN mutes read was named block_list_unavailable — it is the mute list that could not be read", async () => {
    const r = await buildFallbackFeed(feedWorld({ kind: "throw" }), VIEWER, null, "build_error");
    assert.equal(r.fallbackReason, "build_error+mute_list_unavailable");
    assert.deepEqual(r.sections.map((s) => s.name), ["safety_tools"]);
  });
  for (const answer of EVERY_MALFORMED) {
    it(`RED before: the mutes read answers ${answer} → safety tools only, reason mute_list_unavailable`, async () => {
      const r = await buildFallbackFeed(feedWorld({ kind: "malformed", answer }), VIEWER, null, "build_error");
      assert.ok(!JSON.stringify(r).includes("MUTED-AUTHOR-POST"), `a malformed mutes answer served the muted author: ${JSON.stringify(r).slice(0, 600)}`);
      assert.equal(r.fallbackReason, "build_error+mute_list_unavailable");
      assert.deepEqual(r.sections.map((s) => s.name), ["safety_tools"]);
      assert.deepEqual(r.safeItems, []);
    });
  }
});

// ── 4. discoveryCacheEligibility.withMutedAuthors ───────────────────────────

describe("T220c — withMutedAuthors: a row naming nobody is unreadable (null), as an error is", () => {
  const BLOCKED = "b0000000-0000-4000-a000-0000000220b1";

  it("GREEN before (CONTROL): blocks ∪ mutes", async () => {
    const out = await withMutedAuthors(world({ kind: "healthy", muted: [MUTED] }), VIEWER, new Set([BLOCKED]));
    assert.deepEqual([...out!].sort(), [MUTED, BLOCKED].sort());
  });
  it("GREEN before (CONTROL): nobody muted → the block set itself", async () => {
    const blocked = new Set([BLOCKED]);
    assert.equal(await withMutedAuthors(world({ kind: "healthy", muted: [] }), VIEWER, blocked), blocked);
  });
  for (const mode of [{ kind: "error" }, { kind: "throw" }, ...NOT_A_LIST.map((answer) => ({ kind: "malformed", answer }))] as MutesMode[]) {
    it(`GREEN before: ${JSON.stringify(mode)} → null`, async () => {
      assert.equal(await withMutedAuthors(world(mode), VIEWER, new Set([BLOCKED])), null);
    });
  }
  for (const answer of ROW_NAMING_NOBODY) {
    it(`RED before: a row that ${answer === "emptyId" ? "names an empty id" : "names nobody"} → null — it was skipped, a mute dropped as if absent`, async () => {
      assert.equal(await withMutedAuthors(world({ kind: "malformed", answer }), VIEWER, new Set([BLOCKED])), null);
    });
  }
});

// ── 5. mediaEligibility step 2 (fail-soft, NAMED) ───────────────────────────

describe("T220c — mediaEligibility: a row naming nobody turns the mute gate off AND names it, as an error does", () => {
  const viewer: ViewerCtx = { viewerUserId: VIEWER, feedType: "for_you", followedCreatorIds: new Set<string>() };
  const cand = (id: string, author: string): MediaCandidate => ({
    id, author_id: author, status: "active", visibility: "public", moderation_status: "approved",
    created_at: "2026-09-29T00:00:00.000Z", post_media: [{ processing_status: "ready", moderation_status: "approved" }],
  });
  const run = (mode: MutesMode) => filterEligibleMediaCandidates([cand("m1", MUTED), cand("o1", OTHER)], viewer, world(mode), null);

  it("GREEN before (CONTROL): a healthy read drops the muted creator's item and names nothing", async () => {
    const r = await run({ kind: "healthy", muted: [MUTED] });
    assert.deepEqual(r.eligible.map((c) => c.id), ["o1"]);
    assert.ok(!(r.softFailedSources ?? []).includes("user_mutes"), JSON.stringify(r.softFailedSources));
  });
  for (const mode of [{ kind: "error" }, { kind: "throw" }, ...NOT_A_LIST.map((answer) => ({ kind: "malformed", answer }))] as MutesMode[]) {
    it(`GREEN before: ${JSON.stringify(mode)} → the page is served with the mute gate NAMED as off`, async () => {
      const r = await run(mode);
      assert.equal(r.blockFetchFailed, false);
      assert.ok((r.softFailedSources ?? []).includes("user_mutes"), JSON.stringify(r));
    });
  }
  for (const answer of ROW_NAMING_NOBODY) {
    it(`RED before: a row that ${answer === "emptyId" ? "names an empty id" : "names nobody"} → the mute gate is NAMED as off (it was read as a mute of nobody, silently)`, async () => {
      const r = await run({ kind: "malformed", answer });
      assert.ok((r.softFailedSources ?? []).includes("user_mutes"), JSON.stringify(r));
    });
  }
});

// ── a tiny loopback harness for the two route cases ─────────────────────────

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

// ── 6. routes/admin.ts — the moderation dossier's muteCount ─────────────────

const ADMIN = "a1111111-1111-4111-8111-1111111220c0";

function adminWorld(mode: MutesMode | { kind: "count"; count: unknown }) {
  const m: MutesMode = mode.kind === "count" ? { kind: "healthy", muted: [] } : mode;
  const c = world(m, (table, _calls, single) => {
    if (table === "user_mutes" && mode.kind === "count") return { data: null, error: null, count: mode.count };
    if (table === "profiles") return { data: single ? { id: VIEWER, role: "admin", handle: "target", account_status: "active" } : [], error: null };
    return undefined;
  }, ADMIN);
  const inner = c.from;
  // `user_mutes` with a stated count answers it before the mode does.
  c.from = (t: string) => (t === "user_mutes" && mode.kind === "count" ? countOnly(mode.count) : inner(t));
  return c;
}
function countOnly(count: unknown) {
  const b: any = new Proxy({}, {
    get(_t, prop: string) {
      if (prop === "then") return (f: any, r: any) => Promise.resolve({ data: null, error: null, count }).then(f, r);
      return () => b;
    },
  });
  return b;
}

describe("T220c — the moderation dossier's muteCount (countMuteRows)", () => {
  const get = serve(adminRouter);
  const summary = (c: any) => get(`/admin/users/${VIEWER}/summary`, c);

  it("GREEN before (CONTROL): counts the user's mutes and renders the record", async () => {
    const r = await summary(adminWorld({ kind: "healthy", muted: [MUTED, OTHER] }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.muteCount, 2);
  });
  it("GREEN before (CONTROL): nobody muted → muteCount 0", async () => {
    const r = await summary(adminWorld({ kind: "healthy", muted: [] }));
    assert.equal(r.status, 200);
    assert.equal(r.body.muteCount, 0);
  });
  it("GREEN before: a returned error refuses the record and names muteCount", async () => {
    const r = await summary(adminWorld({ kind: "error" }));
    assert.equal(r.body.error, "db_error", JSON.stringify(r.body));
    assert.match(JSON.stringify(r.body), /muteCount/);
  });
  for (const count of [null, undefined, -1, 1.5, "3", Number.NaN]) {
    it(`RED before: a HEAD answer with count ${String(count)} and no error refuses the record, naming muteCount — it rendered a count`, async () => {
      const r = await summary(adminWorld({ kind: "count", count }));
      assert.notEqual(r.status, 200, `a count-less mutes answer rendered a record: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.error, "db_error");
      assert.match(JSON.stringify(r.body), /muteCount/);
    });
  }
  it("RED before: a THROWN mutes count crashed the whole dossier — now it is the same named refusal", async () => {
    const r = await summary(adminWorld({ kind: "throw" }));
    assert.equal(r.body?.error, "db_error", JSON.stringify(r.body));
    assert.match(JSON.stringify(r.body), /muteCount/);
  });
});

describe("T220c — countMuteRows: the count's definition of record", () => {
  it("a HEAD exact count of the user's mutes; every failure ok:false, never 0", async () => {
    const ok = await countMuteRows(world({ kind: "healthy", muted: [MUTED] }), VIEWER);
    assert.deepEqual(ok, { ok: true, count: 1 });
    for (const mode of [{ kind: "error" }, { kind: "throw" }] as MutesMode[]) assert.equal((await countMuteRows(world(mode), VIEWER)).ok, false, JSON.stringify(mode));
    assert.equal((await countMuteRows(null, VIEWER)).ok, false);
  });
});

// ── 7. routes/mutes.ts — GET /me/mutes ──────────────────────────────────────

function listWorld(mode: MutesMode) {
  return world(mode, (table, _calls, single) => {
    if (table === "profiles") {
      return single
        ? { data: { id: VIEWER, account_status: "active" }, error: null }
        : { data: [{ id: MUTED, handle: "muted", name: "Muted Person", avatar_url: null }], error: null };
    }
    return undefined;
  });
}

describe("T220c — GET /me/mutes: an answer that is not a row list is the route's db_error, not 'you muted nobody'", () => {
  const get = serve(mutesRouter);

  it("GREEN before (CONTROL): lists the viewer's mutes", async () => {
    const r = await get("/me/mutes", listWorld({ kind: "healthy", muted: [MUTED] }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.muted.map((m: any) => m.id), [MUTED]);
  });
  it("GREEN before (CONTROL): nobody muted → an empty list", async () => {
    const r = await get("/me/mutes", listWorld({ kind: "healthy", muted: [] }));
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.muted, []);
  });
  it("GREEN before: a returned error is db_error", async () => {
    const r = await get("/me/mutes", listWorld({ kind: "error" }));
    assert.equal(r.body?.error, "db_error", JSON.stringify(r.body));
  });
  for (const answer of EVERY_MALFORMED) {
    it(`RED before: the list read answers ${answer} with no error → db_error, never a list`, async () => {
      const r = await get("/me/mutes", listWorld({ kind: "malformed", answer }));
      assert.equal(r.body?.error, "db_error", `answered ${JSON.stringify(r.body)}`);
      assert.equal(r.body?.muted, undefined);
    });
  }
});
