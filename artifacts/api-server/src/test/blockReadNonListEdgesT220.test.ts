/**
 * census-telegraph T220 part 2 — FIX FIRST: four modules read a `blocks` answer
 * that was NOT a row list (and carried no error) as "nobody is blocked".
 *
 * node:test + node:assert. In-process fakes, no database, no network, no listen.
 *
 * supabase-js answers `{ data, error }`; every one of these sites checked
 * `error` and then wrote `data ?? []` (or `Array.isArray(rows) && …`), so an
 * answer with no error and no row list — `data: null`, a string, an object — or
 * a row that does not name its counter-party built the SAME empty exclusion set
 * as a healthy "nobody is blocked". Each site already refused on a RETURNED
 * error; the fix makes the malformed answer take that same refusal:
 *
 *   CompassProfileService.buildProfile   throws "block/mute safety-list load failed — failing closed"
 *   CompassTools.refreshHiddenUsers      keeps the ask-time snapshot; with none, throws (the tool refuses)
 *   CompassFallbackFeedBuilder           degrades to the static safety tools, "+block_list_unavailable"
 *   shareables.readBlockBetween          "unreadable" → the card is unavailable "unknown"
 *   coalescedReads (the share batcher)   a batch that answers no row list answers every caller with an
 *                                        error, never with `[]` — the loaders' own refusal then applies
 *
 * Every FAIL case was red on the code before the fix (50e21e506); every CONTROL
 * pins that the world reaches the code under test, so a fix that refused
 * everything would fail its control.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { getCompassProfile, clearCompassProfileCache } from "../compass/CompassProfileService.js";
import { executeCompassTool } from "../compass/CompassTools.js";
import { buildFallbackFeed } from "../compass/CompassFallbackFeedBuilder.js";
import { invalidateFlagsCache } from "../compass/flags.js";
import { resolveShareProjections } from "../services/telegraph/shareables.js";
import { coalescingClient } from "../services/telegraph/coalescedReads.js";

const VIEWER = "ab000000-0000-4000-a000-000000000220";
const BLOCKED = "b0000000-0000-4000-a000-0000000002b1";
const BLOCKER = "c0000000-0000-4000-a000-0000000002c1";
const POST = "d0000000-0000-4000-a000-0000000002d1";
const EVENT = "e0000000-0000-4000-a000-0000000002e1";
const THREAD = "f0000000-0000-4000-a000-0000000002f1";

type Call = [string, unknown[]];
type Answer = { data: unknown; error: unknown; count?: number | null };

/**
 * How the `blocks` table answers. `healthy` serves `rows`; the other modes
 * answer the named direction (or every read) with no error and no usable list.
 */
type BlocksMode =
  | { kind: "healthy"; rows: Array<{ blocker_id: string; blocked_id: string }> }
  | { kind: "malformed"; direction: "outgoing" | "incoming" | "any"; answer: "null" | "string" | "object" | "rowWithoutId" };

const MALFORMED: Record<Exclude<BlocksMode, { kind: "healthy" }>["answer"], () => Answer> = {
  null: () => ({ data: null, error: null }),
  string: () => ({ data: "not rows", error: null }),
  object: () => ({ data: { rows: [] }, error: null }),
  rowWithoutId: () => ({ data: [{}], error: null }),
};

function blocksAnswer(mode: BlocksMode, calls: Call[]): Answer {
  const eqArg = (col: string) => calls.find(([k, a]) => k === "eq" && a[0] === col)?.[1][1];
  const inArg = (col: string) => calls.find(([k, a]) => k === "in" && a[0] === col)?.[1][1] as unknown[] | undefined;
  const direction = eqArg("blocker_id") === VIEWER ? "outgoing" : eqArg("blocked_id") === VIEWER ? "incoming" : "other";
  if (mode.kind === "malformed" && (mode.direction === "any" || mode.direction === direction)) return MALFORMED[mode.answer]();
  const rows = mode.kind === "healthy" ? mode.rows : [];
  const out = rows.filter((r) =>
    (eqArg("blocker_id") === undefined || r.blocker_id === eqArg("blocker_id")) &&
    (eqArg("blocked_id") === undefined || r.blocked_id === eqArg("blocked_id")) &&
    (inArg("blocker_id") === undefined || inArg("blocker_id")!.includes(r.blocker_id)) &&
    (inArg("blocked_id") === undefined || inArg("blocked_id")!.includes(r.blocked_id)));
  return { data: out, error: null, count: out.length };
}

/** A permissive world: every other table answers empty, with the few rows each case needs. */
function world(mode: BlocksMode, extra: (table: string, calls: Call[], single: boolean) => Answer | undefined = () => undefined) {
  function builder(table: string) {
    const calls: Call[] = [];
    const answer = (single: boolean): Answer => {
      if (table === "blocks") return blocksAnswer(mode, calls);
      const x = extra(table, calls, single);
      if (x) return x;
      return { data: single ? null : [], error: null };
    };
    const b: any = new Proxy({}, {
      get(_t, prop: string) {
        if (prop === "then") return (f: any, r: any) => Promise.resolve(answer(false)).then(f, r);
        if (prop === "maybeSingle" || prop === "single") return () => Promise.resolve(answer(true));
        return (...args: unknown[]) => { calls.push([prop, args]); return b; };
      },
    });
    return b;
  }
  return { from: (table: string) => builder(table), rpc: () => Promise.resolve({ data: null, error: null }) } as any;
}

const EVERY_MALFORMED = ["null", "string", "object", "rowWithoutId"] as const;

// ── 1. CompassProfileService ────────────────────────────────────────────────

describe("T220 edge — CompassProfileService: a malformed blocks answer refuses the profile, as an error does", () => {
  beforeEach(() => clearCompassProfileCache());

  it("CONTROL: healthy reads build a profile that keeps the two directions apart", async () => {
    const p = await getCompassProfile(world({ kind: "healthy", rows: [
      { blocker_id: VIEWER, blocked_id: BLOCKED }, { blocker_id: BLOCKER, blocked_id: VIEWER },
    ] }), VIEWER, true);
    assert.deepEqual(p.blockedUserIds, [BLOCKED]);
    assert.deepEqual(p.blockerUserIds, [BLOCKER]);
    assert.equal(p.blockCount, 1);
  });

  for (const direction of ["outgoing", "incoming"] as const) {
    for (const answer of EVERY_MALFORMED) {
      it(`the ${direction} read answers ${answer} with no error → buildProfile throws (fail closed), never an empty list`, async () => {
        await assert.rejects(
          getCompassProfile(world({ kind: "malformed", direction, answer }), VIEWER, true),
          /safety-list load failed/,
        );
      });
    }
  }
});

// ── 2. CompassTools.refreshHiddenUsers (through search_events) ──────────────

function eventsWorld(mode: BlocksMode) {
  return world(mode, (table) => {
    if (table === "events") {
      return { data: [{ id: EVENT, title: "BLOCKED-HOST-EVENT", description: null, city: "Paris", country: "FR", starts_at: "2099-01-01T00:00:00.000Z", category: "music", host_id: BLOCKED, state: "open", visibility: "public" }], error: null };
    }
    return undefined;
  });
}
const SNAPSHOT = { userId: VIEWER, blockedUserIds: [BLOCKED], blockerUserIds: [], mutedUserIds: [] } as any;

describe("T220 edge — CompassTools.refreshHiddenUsers: a malformed blocks answer keeps the snapshot (or refuses), as an error does", () => {
  it("CONTROL: a healthy read that names nobody (the user unblocked mid-conversation) serves the host's event", async () => {
    const out = JSON.stringify(await executeCompassTool(eventsWorld({ kind: "healthy", rows: [] }), VIEWER, SNAPSHOT, "search_events", {}));
    assert.ok(out.includes("BLOCKED-HOST-EVENT"), out);
  });
  it("CONTROL: a healthy read naming the block hides the host's event", async () => {
    const out = JSON.stringify(await executeCompassTool(eventsWorld({ kind: "healthy", rows: [{ blocker_id: VIEWER, blocked_id: BLOCKED }] }), VIEWER, SNAPSHOT, "search_events", {}));
    assert.ok(!out.includes("BLOCKED-HOST-EVENT"), out);
  });
  for (const answer of EVERY_MALFORMED) {
    it(`WITH a snapshot: the outgoing read answers ${answer} → the snapshot's block still hides the host`, async () => {
      const out = JSON.stringify(await executeCompassTool(eventsWorld({ kind: "malformed", direction: "outgoing", answer }), VIEWER, SNAPSHOT, "search_events", {}));
      assert.ok(!out.includes("BLOCKED-HOST-EVENT"), `a malformed blocks answer un-hid the blocked host: ${out}`);
    });
    it(`WITHOUT a snapshot: the incoming read answers ${answer} → the tool refuses rather than read "nobody blocked"`, async () => {
      const out = JSON.stringify(await executeCompassTool(eventsWorld({ kind: "malformed", direction: "incoming", answer }), VIEWER, null, "search_events", {}));
      assert.ok(!out.includes("BLOCKED-HOST-EVENT"), out);
      assert.match(out, /error/i, `the tool must refuse, got ${out}`);
    });
  }
  it("CONTROL: WITHOUT a snapshot, healthy reads naming nobody serve the event (the refusal above is the malformed answer's)", async () => {
    const out = JSON.stringify(await executeCompassTool(eventsWorld({ kind: "healthy", rows: [] }), VIEWER, null, "search_events", {}));
    assert.ok(out.includes("BLOCKED-HOST-EVENT"), out);
  });
});

// ── 3. CompassFallbackFeedBuilder.loadBlockedIds ────────────────────────────

function feedWorld(mode: BlocksMode) {
  return world(mode, (table, calls) => {
    const has = (m: string) => calls.some(([k]) => k === m);
    if (table === "feature_flags") {
      if (has("like")) return { data: [{ flag: "COMPASS_ENABLED", enabled: true }, { flag: "COMPASS_V1_RULE_BASED_ENABLED", enabled: true }], error: null };
      return { data: null, error: null };
    }
    if (table === "posts") {
      return { data: [
        { id: POST, author_id: BLOCKED, content: "BLOCKED-AUTHOR-POST", like_count: 99, comment_count: 1, post_status: "published", publish_eligible_at: null, visibility: "public", status: "active", created_at: "2026-09-29T00:00:00.000Z", city: "Paris" },
      ], error: null };
    }
    return undefined;
  });
}

describe("T220 edge — CompassFallbackFeedBuilder: a malformed blocks answer degrades to the safety tools, as an error does", () => {
  beforeEach(() => invalidateFlagsCache());

  it("CONTROL: healthy reads, nobody blocked → the post is served (the world reaches the fallback)", async () => {
    const r = await buildFallbackFeed(feedWorld({ kind: "healthy", rows: [] }), VIEWER, null, "build_error");
    assert.ok(JSON.stringify(r).includes("BLOCKED-AUTHOR-POST"), JSON.stringify(r).slice(0, 600));
  });
  it("CONTROL: healthy reads, the author blocked the viewer → the post is not served", async () => {
    const r = await buildFallbackFeed(feedWorld({ kind: "healthy", rows: [{ blocker_id: BLOCKED, blocked_id: VIEWER }] }), VIEWER, null, "build_error");
    assert.ok(!JSON.stringify(r).includes("BLOCKED-AUTHOR-POST"), JSON.stringify(r).slice(0, 600));
    assert.equal(r.fallbackReason, "build_error");
  });
  for (const direction of ["outgoing", "incoming"] as const) {
    for (const answer of EVERY_MALFORMED) {
      it(`the ${direction} read answers ${answer} → safety tools only, reason block_list_unavailable`, async () => {
        const r = await buildFallbackFeed(feedWorld({ kind: "malformed", direction, answer }), VIEWER, null, "build_error");
        assert.ok(!JSON.stringify(r).includes("BLOCKED-AUTHOR-POST"), `a malformed blocks answer served user content: ${JSON.stringify(r).slice(0, 600)}`);
        assert.equal(r.fallbackReason, "build_error+block_list_unavailable");
        assert.deepEqual(r.sections.map((s) => s.name), ["safety_tools"]);
        assert.deepEqual(r.safeItems, []);
      });
    }
  }
});

// ── 4. shareables.readBlockBetween, alone and through the coalescer ─────────

const POST_ROW = {
  id: POST, author_id: BLOCKED, content: "SHARED-POST-BODY", visibility: "public", status: "active", post_status: "published",
  deleted_at: null, media_urls: [], location_privacy_mode: null, created_at: "2026-09-29T00:00:00.000Z", updated_at: "2026-09-29T00:00:00.000Z",
};

function shareWorld(mode: BlocksMode) {
  return world(mode, (table, calls, single) => {
    if (table === "posts") return single ? { data: POST_ROW, error: null } : { data: [POST_ROW], error: null };
    if (table === "profiles") {
      const row = { id: BLOCKED, handle: "postauthor", account_status: "active" };
      return single ? { data: row, error: null } : { data: [row], error: null };
    }
    return undefined;
  });
}

async function postCard(client: any) {
  const [r] = await resolveShareProjections(client, VIEWER, THREAD, [{ objectType: "POST" as any, objectId: POST }]);
  return r;
}

describe("T220 edge — share cards: a malformed blocks answer is unknown, never a card", () => {
  it("CONTROL: healthy, nobody blocked → the post card resolves", async () => {
    const r = await postCard(shareWorld({ kind: "healthy", rows: [] }));
    assert.equal(r.available, true, JSON.stringify(r));
  });
  it("CONTROL: healthy, the author blocked the viewer → unauthorized", async () => {
    const r = await postCard(shareWorld({ kind: "healthy", rows: [{ blocker_id: BLOCKED, blocked_id: VIEWER }] }));
    assert.equal(r.available, false);
    assert.equal(!r.available && r.reason, "unauthorized");
  });
  for (const answer of ["null", "string", "object"] as const) {
    for (const direction of ["outgoing", "incoming"] as const) {
      it(`the viewer's ${direction} pair read answers ${answer} → unavailable "unknown"`, async () => {
        const r = await postCard(shareWorld({ kind: "malformed", direction, answer }));
        assert.equal(r.available, false, `a malformed blocks answer resolved the card: ${JSON.stringify(r)}`);
        assert.equal(!r.available && r.reason, "unknown");
      });
    }
  }

  it("CONTROL (coalesced): healthy, nobody blocked → the card resolves through the batcher", async () => {
    const r = await postCard(coalescingClient(shareWorld({ kind: "healthy", rows: [] })));
    assert.equal(r.available, true, JSON.stringify(r));
  });
  it("CONTROL (coalesced): healthy, the viewer blocked the author → unauthorized through the batcher", async () => {
    const r = await postCard(coalescingClient(shareWorld({ kind: "healthy", rows: [{ blocker_id: VIEWER, blocked_id: BLOCKED }] })));
    assert.equal(!r.available && r.reason, "unauthorized");
  });
  for (const answer of ["null", "string", "object"] as const) {
    it(`(coalesced) the batched blocks read answers ${answer} with no error → every caller is told the read failed: "unknown"`, async () => {
      const r = await postCard(coalescingClient(shareWorld({ kind: "malformed", direction: "any", answer })));
      assert.equal(r.available, false, `a malformed batch answer resolved the card: ${JSON.stringify(r)}`);
      assert.equal(!r.available && r.reason, "unknown");
    });
  }
});
