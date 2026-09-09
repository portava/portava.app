/**
 * The exclusion-set contract, and the four SERVICE-level sites that depend on
 * it. Companion to src/test/exclusionFailClosedRoutes.test.ts, which proves the
 * same class on the route surfaces.
 *
 * ── WHAT IS BEING GUARDED ────────────────────────────────────────────────────
 * `blocks` / `trust_caps` are exclusion tables: a ROW means DENY, so emptiness
 * means ALLOW. supabase-js RESOLVES on a database error, so `data ?? []` builds
 * the SAME empty set for "nobody is excluded" and "the table could not be read"
 * — and the exclusion silently stops applying. src/lib/exclusionSet.ts replaces
 * the nullable Set with a discriminated `ExclusionSet`, whose membership test
 * `isExcluded` answers TRUE for an unreadable set, so every plain filter
 * predicate degrades to fail-closed by construction.
 *
 * The first suite pins that contract. The rest prove the four service sites
 * whose fail-closed answer is NOT an HTTP status, and each has a healthy-path
 * case beside it: a fix that made these safe by making them always fail would
 * pass the failure case and fail its neighbour.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/exclusionSetContract.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  readBlockExclusions,
  readPairExclusion,
  readGroupBlockExclusions,
  isExcluded,
  exclusions,
  exclusionsUnavailable,
} from "../lib/exclusionSet.js";
import { enrichSpans } from "../lib/enrichSpans.js";
import { processTagging } from "../services/tagging/TaggingService.js";
import { CreatorSignalAggregator } from "../services/ranking/CreatorActivityScoreService.js";
import { computeActiveUserScore } from "../compass/CompassActiveUserRewardEngine.js";
import { executeCompassTool } from "../compass/CompassTools.js";

const ME      = "aaaaaaaa-0000-4000-a000-000000000001";
const FRIEND  = "bbbbbbbb-0000-4000-a000-000000000002";
const BLOCKED = "cccccccc-0000-4000-a000-000000000003";
const POST    = "dddddddd-0000-4000-a000-000000000004";

type Rows = Record<string, any[]>;

/**
 * The same table-driven fake the route suite uses, minus the HTTP wiring.
 * `failTables` answers `{ data: null, error }` — the RESOLVED failure
 * supabase-js really produces. It never throws, because a throw would be caught
 * by the very `catch` blocks these fixes had to stop relying on.
 */
function makeClient(rows: Rows, failTables: ReadonlySet<string> = new Set()) {
  function chain(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let wantCount = false;
    const settle = (single: boolean) => {
      if (failTables.has(table)) {
        return Promise.resolve({ data: null, error: { message: `${table} read failed` }, count: null });
      }
      const out = (rows[table] ?? []).filter((r) => filters.every((f) => f(r)));
      return Promise.resolve({ data: single ? (out[0] ?? null) : out, error: null, count: wantCount ? out.length : null });
    };
    const b: any = {
      select(_c?: string, o?: any) { if (o?.count) wantCount = true; return b; },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return b; },
      neq(c: string, v: any) { filters.push((r) => r[c] !== v); return b; },
      in(c: string, v: any[]) { filters.push((r) => v.includes(r[c])); return b; },
      is(c: string, v: any) { filters.push((r) => (r[c] ?? null) === v); return b; },
      gt() { return b; }, gte() { return b; }, lt() { return b; }, lte() { return b; },
      not() { return b; }, order() { return b; }, limit() { return b; }, range() { return b; },
      insert() { return b; }, upsert() { return b; }, update() { return b; }, delete() { return b; },
      or(expr: string) {
        const clauses = expr.split(/,(?![^(]*\))/).map((c) => c.trim()).filter(Boolean);
        filters.push((r) => clauses.some((c) => {
          const and = c.match(/^and\((.*)\)$/s);
          const parts = and ? and[1].split(/,(?![^(]*\))/) : [c];
          return parts.every((p) => {
            const m = p.trim().match(/^(\w+)\.(\w+)\.(.*)$/s);
            if (!m) return false;
            const [, col, op, raw] = m;
            if (op === "is") return (r[col] ?? null) === (raw === "null" ? null : raw);
            if (op === "gt") return String(r[col] ?? "") > raw;
            if (op === "in") return raw.replace(/^\(|\)$/g, "").split(",").includes(String(r[col]));
            return String(r[col]) === raw;
          });
        }));
        return b;
      },
      maybeSingle() { return settle(true); },
      single() { return settle(true); },
      then(f: any, j: any) { return settle(false).then(f, j); },
    };
    return b;
  }
  return { from: (t: string) => chain(t), rpc: () => Promise.resolve({ data: null, error: null }) } as any;
}

const BLOCK_ROWS = [{ id: "b1", blocker_id: ME, blocked_id: BLOCKED }];

// ══ 1. The contract ══════════════════════════════════════════════════════════

describe("ExclusionSet contract", () => {
  it("a readable table yields ok:true and the real set", async () => {
    const set = await readBlockExclusions(makeClient({ blocks: BLOCK_ROWS }), ME);
    assert.equal(set.ok, true);
    assert.ok(set.ok && set.ids.has(BLOCKED));
    assert.ok(set.ok && !set.ids.has(FRIEND));
  });

  it("an UNREADABLE table yields ok:false — not an empty set", async () => {
    const set = await readBlockExclusions(makeClient({ blocks: BLOCK_ROWS }, new Set(["blocks"])), ME);
    assert.equal(set.ok, false,
      "the whole point: 'unreadable' must not be spelled the same way as 'nobody is blocked'");
    assert.ok(!("ids" in set), "there must be no set to accidentally read as empty");
  });

  it("isExcluded answers TRUE for every id when the set is unreadable", async () => {
    const bad = await readBlockExclusions(makeClient({}, new Set(["blocks"])), ME);
    assert.equal(isExcluded(bad, FRIEND), true);
    assert.equal(isExcluded(bad, "anyone-at-all"), true);
    // …and normally for a readable one, so the default is safe but not blanket.
    const good = await readBlockExclusions(makeClient({ blocks: BLOCK_ROWS }), ME);
    assert.equal(isExcluded(good, BLOCKED), true);
    assert.equal(isExcluded(good, FRIEND), false);
  });

  it("the scoped (`among`) read fails closed on EITHER direction's error", async () => {
    const ok = await readBlockExclusions(makeClient({ blocks: BLOCK_ROWS }), ME, { among: [FRIEND, BLOCKED] });
    assert.equal(ok.ok, true);
    assert.ok(ok.ok && ok.ids.has(BLOCKED) && !ok.ids.has(FRIEND));
    const bad = await readBlockExclusions(makeClient({ blocks: BLOCK_ROWS }, new Set(["blocks"])), ME, { among: [FRIEND] });
    assert.equal(bad.ok, false);
  });

  it("readPairExclusion reports the pair, and reports failure as failure", async () => {
    const c = makeClient({ blocks: BLOCK_ROWS });
    assert.equal(isExcluded(await readPairExclusion(c, ME, BLOCKED), BLOCKED), true);
    assert.equal(isExcluded(await readPairExclusion(c, ME, FRIEND), FRIEND), false);
    const bad = await readPairExclusion(makeClient({}, new Set(["blocks"])), ME, FRIEND);
    assert.equal(bad.ok, false);
    assert.equal(isExcluded(bad, FRIEND), true);
  });

  it("readGroupBlockExclusions unions both directions and drops the members themselves", async () => {
    const set = await readGroupBlockExclusions(
      makeClient({ blocks: [{ blocker_id: ME, blocked_id: BLOCKED }] }),
      [ME, FRIEND],
    );
    assert.equal(set.ok, true);
    assert.ok(set.ok && set.ids.has(BLOCKED));
    assert.ok(set.ok && !set.ids.has(ME), "a member must not exclude themselves from their own group");
    const bad = await readGroupBlockExclusions(makeClient({}, new Set(["blocks"])), [ME]);
    assert.equal(bad.ok, false);
  });

  it("the constructors behave (empty is allow-all; unavailable excludes all)", () => {
    assert.equal(isExcluded(exclusions([]), FRIEND), false);
    assert.equal(isExcluded(exclusionsUnavailable({ message: "boom" }), FRIEND), true);
  });
});

// ══ 2. lib/enrichSpans — shape 2, mentions degrade to plain text ═════════════

describe("enrichSpans: an unreadable block list makes every @mention plain text", () => {
  const rows = (): Rows => ({
    tags: [
      { id: "t1", source_id: POST, source_type: "post", tagged_user_id: FRIEND,  status: "approved", suppressed: false },
      { id: "t2", source_id: POST, source_type: "post", tagged_user_id: BLOCKED, status: "approved", suppressed: false },
    ],
    profiles: [
      { id: FRIEND, handle: "friend" },
      { id: BLOCKED, handle: "blocked" },
    ],
    blocks: BLOCK_ROWS,
    hashtag_usage: [],
    hashtags: [],
  });

  it("healthy: the blocked mention is flagged and the unblocked one is not", async () => {
    const spans = await enrichSpans(makeClient(rows()), "post", [{ id: POST, content: "hi @friend @blocked" }], ME);
    const tags = spans[POST]?.tags ?? [];
    assert.equal(tags.length, 2, "both mentions still resolve — this is not a blanket suppression");
    assert.equal(tags.find((t: any) => t.id === FRIEND)?.isBlocked, undefined);
    assert.equal(tags.find((t: any) => t.id === BLOCKED)?.isBlocked, true);
  });

  it("blocks unreadable: EVERY mention is flagged blocked, and the content still renders", async () => {
    const spans = await enrichSpans(
      makeClient(rows(), new Set(["blocks"])),
      "post", [{ id: POST, content: "hi @friend @blocked" }], ME,
    );
    const tags = spans[POST]?.tags ?? [];
    assert.equal(tags.length, 2, "the spans are still produced — enrichSpans cannot refuse");
    assert.ok(tags.every((t: any) => t.isBlocked === true),
      "with block state unknown no handle may become a live link to a profile");
  });
});

// ══ 3. TaggingService — shape 2, tag nobody ══════════════════════════════════

describe("processTagging: an unreadable block list tags nobody", () => {
  const rows = (): Rows => ({
    profiles: [{ id: FRIEND, handle: "friend", tag_permission: "anyone" }],
    blocks: BLOCK_ROWS,
    tags: [],
    content_tags: [],
    posts: [{ id: POST, author_id: ME, visibility: "public", status: "active" }],
    user_follows: [],
    hashtags: [],
    hashtag_usage: [],
  });

  it("healthy: an unblocked mentioned user is tagged", async () => {
    const ids = await processTagging({
      db: makeClient(rows()), authorId: ME, sourceType: "post", sourceId: POST, content: "hey @friend",
    } as any);
    assert.deepEqual(ids, [FRIEND], "the normal answer must be unchanged");
  });

  it("blocks unreadable: no tag row is written and nobody is notified", async () => {
    const ids = await processTagging({
      db: makeClient(rows(), new Set(["blocks"])), authorId: ME, sourceType: "post", sourceId: POST, content: "hey @friend",
    } as any);
    assert.deepEqual(ids, [],
      "writing no tag is recoverable; notifying someone the author blocked is not");
  });
});

// ══ 4. CreatorActivityScoreService — shape 2, zero the block-scoped halves ═══

describe("CreatorSignalAggregator: an unreadable block list zeroes only the block-scoped signals", () => {
  const NOW = new Date().toISOString();
  const FRIEND_POST  = "10000000-0000-4000-a000-00000000000f";
  const BLOCKED_POST = "20000000-0000-4000-a000-00000000000b";
  const MY_POST      = "30000000-0000-4000-a000-00000000000m";

  // The fixture is built so the block filter CHANGES the numbers. ME commented
  // on one post by FRIEND and one by BLOCKED, and both FRIEND and BLOCKED saved
  // a post of ME's. A working block filter counts FRIEND and drops BLOCKED; the
  // old fail-open code counted BOTH, which is the inflation the fix prevents.
  const rows = (): Rows => ({
    blocks: BLOCK_ROWS,
    posts: [
      { id: FRIEND_POST,  author_id: FRIEND,  status: "active", created_at: NOW },
      { id: BLOCKED_POST, author_id: BLOCKED, status: "active", created_at: NOW },
      { id: MY_POST,      author_id: ME,      status: "active", created_at: NOW },
    ],
    posts_comments: [
      { post_id: FRIEND_POST,  user_id: ME, created_at: NOW, deleted_at: null },
      { post_id: BLOCKED_POST, user_id: ME, created_at: NOW, deleted_at: null },
    ],
    post_saves: [
      { post_id: MY_POST, user_id: FRIEND,  created_at: NOW },
      { post_id: MY_POST, user_id: BLOCKED, created_at: NOW },
    ],
    post_shares: [], content_stamps: [], user_follows: [], event_rsvps: [],
    events: [], trips: [], reviews: [], discovery_places: [],
    trust_profiles: [{ user_id: ME, trust_score: 80 }],
    moderation_reports: [], profile_views: [],
  });

  it("healthy: the block filter counts FRIEND and drops BLOCKED", async () => {
    const signals = await new CreatorSignalAggregator(makeClient(rows())).aggregate(ME);
    assert.equal(signals.participationEvents, 1,
      "ME commented on two posts; only the unblocked author may be counted");
    assert.equal(signals.participationDistinctUsers, 1);
    assert.equal(signals.receivedPositiveActions, 1,
      "two saves, one of them from a blocked account, must count as one");
  });

  it("blocks unreadable: participation and positive responses are 0, the rest still computed", async () => {
    const signals = await new CreatorSignalAggregator(makeClient(rows(), new Set(["blocks"]))).aggregate(ME);
    assert.equal(signals.participationEvents, 0,
      "an unreadable block list must understate, never count the blocked author");
    assert.equal(signals.participationDistinctUsers, 0);
    assert.equal(signals.receivedPositiveActions, 0);
    assert.equal(signals.receivedInteractionVolume, 0);
    // The pass is NOT abandoned — only `trust_profiles` has that privilege.
    // The non-block-scoped signals must come out IDENTICAL to the healthy run;
    // if this fix had become a refusal, they would not be produced at all.
    const healthy = await new CreatorSignalAggregator(makeClient(rows())).aggregate(ME);
    assert.equal(signals.contributions90d, healthy.contributions90d);
    assert.equal(signals.activeDays90, healthy.activeDays90);
    assert.equal(signals.safetyMultiplier, healthy.safetyMultiplier);
  });
});

// ══ 5. CompassActiveUserRewardEngine — shape 1, an unreadable cap IS a cap ═══

describe("computeActiveUserScore: an unreadable trust_caps reads as CAPPED", () => {
  const rows = (): Rows => ({
    trust_caps: [],                       // this user is NOT capped
    compass_active_user_events: [],
    compass_active_user_scores: [],
    trust_profiles: [{ user_id: ME, trust_score: 80 }],
    profiles: [{ id: ME, trust_score: 80, safety_flags_count: 0 }],
  });

  it("healthy: an uncapped user keeps the full trust multiplier", async () => {
    const r = await computeActiveUserScore(makeClient(rows()), ME);
    assert.ok(r);
    assert.equal(r!.trustMultiplier, 1.0, "an uncapped, well-trusted user is not penalised");
  });

  it("trust_caps unreadable: the capped multiplier applies, withholding the boost", async () => {
    const r = await computeActiveUserScore(makeClient(rows(), new Set(["trust_caps"])), ME);
    assert.ok(r);
    assert.equal(r!.trustMultiplier, 0.5,
      "cap state unknown must read as capped — the old code read it as 'not capped' and restored the boost");
    assert.equal(r!.boostEligible, false);
  });
});

// ══ 6. CompassTools — shape 3 in tool vocabulary: no group recommendation ════
//
// A GROUP recommendation is shared with the whole group, so a candidate any
// member blocked must not appear in it. With the block union unreadable there
// is no filtered ranking to give, and the ranked-but-unfiltered one is the
// defect. The tool already has a "cannot answer" vocabulary the assistant
// renders as a sentence — `{ candidates: [], info }` — so it says so.
//
// A snapshot profile is supplied because refreshHiddenUsers throws without one
// when `blocks` errors; that path is a different, already-correct guard, and
// passing the snapshot is what lets execution reach groupBlockUnion at all.

describe("executeCompassTool get_group_recommendation: an unreadable block union declines", () => {
  const CIRCLE_OWNER = ME;
  const snapshot = { userId: ME, blockedUserIds: [], blockerUserIds: [], mutedUserIds: [] } as any;

  const rows = (): Rows => ({
    blocks: BLOCK_ROWS,
    user_mutes: [],
    circles: [{ id: "c1", name: "Crew", owner_id: CIRCLE_OWNER }],
    circle_memberships: [
      { user_id: CIRCLE_OWNER, other_id: FRIEND, status: "accepted" },
    ],
    profiles: [
      { id: ME, interest_tags: [], category_affinities: {} },
      { id: FRIEND, interest_tags: [], category_affinities: {} },
    ],
    discovery_places: [],
    events: [],
    compass_user_preferences: [],
    memories: [],
  });

  it("healthy: the tool runs and answers with a candidates array", async () => {
    const out: any = await executeCompassTool(
      makeClient(rows()), ME, snapshot, "get_group_recommendation", { circleName: "Crew" },
    );
    assert.ok(Array.isArray(out?.candidates), `expected a candidates array, got ${JSON.stringify(out)}`);
    assert.ok(
      out.info !== "Group block state could not be read, so no group recommendation was made.",
      "the healthy path must NOT take the refusal branch",
    );
  });

  it("blocks unreadable: it declines instead of ranking an unfiltered group", async () => {
    const out: any = await executeCompassTool(
      makeClient(rows(), new Set(["blocks"])), ME, snapshot, "get_group_recommendation", { circleName: "Crew" },
    );
    assert.deepEqual(out?.candidates, []);
    assert.equal(out?.info, "Group block state could not be read, so no group recommendation was made.");
  });
});
