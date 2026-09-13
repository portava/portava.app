/**
 * mediaReportIntent — a viewer preference is not a moderation report.
 *
 * WHAT THIS SUITE IS FOR
 * ----------------------
 * `POST /api/media/:id/report` is the single endpoint behind FOUR different
 * rows of the Media options sheet (components/media/MediaMoreMenu.tsx), and for
 * a non-owner the first two of them are "Not interested" and "Hide" — above
 * "Report". Both are reachable today on WatchFeed (the default mode of the
 * shipped Media tab) and on GemsFeed.
 *
 * Before 2026-09-13 the endpoint could not tell them apart. It accepted
 * `z.string().max(100).default("spam")` and sent whatever arrived to a
 * moderation pipeline, so:
 *   • "Not interested" on a post wrote a permanent `reports` row against
 *     another user's content with reason_code='not_interested';
 *   • "Not interested" on a gem wrote `hidden_gem_reports` and incremented
 *     `hidden_gems.report_count`;
 *   • a body with NO reason filed a spam report;
 *   • a genuine `harassment` report carried no severity, so it never reached
 *     the auto-restrict / anti-retaliation path routes/reports.ts documents;
 *   • and nothing was hidden — `post_hides` (0116), which routes/pulse.ts reads
 *     to suppress a viewer's hidden posts, had no writer anywhere in the tree.
 *
 * Every `it` below fails if any one of those comes back.
 *
 * MUTATIONS SEEN RED (recorded in docs/architecture/census-media.md §9):
 *   M1 restore `.default("spam")` on the reason schema        → "refuses a body with no reason"
 *   M2 route 'not_interested' to the reports insert           → "hide writes post_hides, not reports"
 *   M3 drop `severity` from the reports insert                → "a harassment report is high severity"
 *   M4 drop the post_hides gate in mediaEligibility           → "a hidden post never reaches the feed"
 *   M5 shrink the deny-list back to rejected/flagged          → "owner_deleted media is not distributable"
 *
 * Run: node --import tsx/esm --test src/test/mediaReportIntent.test.ts
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import mediaFeedRouter from "../routes/mediaFeed.js";
import {
  classifyMediaReportReason,
  reportSeverityFor,
  REPORT_REASON_CODES,
} from "../lib/reportReasons.js";
import {
  filterEligibleMediaCandidates,
  NON_DISTRIBUTABLE_MEDIA_MODERATION_STATES,
  type MediaCandidate,
} from "../lib/mediaEligibility.js";
import {
  loadMediaSignals,
  notInterestedPenalty,
} from "../services/ranking/MediaFeedRankingService.js";

const VIEWER_ID = "aaaaaaaa-0000-4000-a000-00000000000a";
const CREATOR   = "bbbbbbbb-0000-4000-a000-00000000000b";
const POST_ID   = "11111111-0000-4000-a000-00000000001a";
const GEM_ID    = "22222222-0000-4000-a000-00000000002a";
const TOKEN     = "test-media-report-intent-token";

// ── Fake supabase client ──────────────────────────────────────────────────────

interface FakeTables {
  posts?: any[];
  hidden_gems?: any[];
  reports?: any[];
  hidden_gem_reports?: any[];
  post_hides?: any[];
  feature_flags?: any[];
}

function makeClient(tables: FakeTables = {}) {
  const inserted: Array<{ table: string; row: any }> = [];
  // `opts` is recorded, not just `row`: the conflict target IS the idempotency
  // contract that POST /posts/:postId/hide and the media hide now share, and a
  // fake that only captures the row cannot see it drift. postHide.test.ts's own
  // fake does not capture it, which is why M8 leaves that suite green.
  const upserted: Array<{ table: string; row: any; opts?: any }> = [];
  const updated: Array<{ table: string; patch: any }> = [];

  function builder(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let limitVal = 1000;

    const rows = (): any[] => {
      const src: any[] = (tables as any)[table] ?? [];
      return src.filter((r) => filters.every((f) => f(r))).slice(0, limitVal);
    };

    const b: any = {
      select() { return b; },
      insert(row: any) { inserted.push({ table, row }); return b; },
      upsert(row: any, opts?: any) { upserted.push({ table, row, opts }); return b; },
      update(patch: any) { updated.push({ table, patch }); return b; },
      delete() { return b; },
      eq(col: string, val: any) { filters.push((r) => r[col] === val); return b; },
      neq(col: string, val: any) { filters.push((r) => r[col] !== val); return b; },
      in(col: string, vals: any[]) { filters.push((r) => vals.includes(r[col])); return b; },
      is() { return b; },
      or() { return b; },
      order() { return b; },
      limit(n: number) { limitVal = n; return b; },
      maybeSingle() { return Promise.resolve({ data: rows()[0] ?? null, error: null }); },
      single() {
        const r = rows()[0];
        return Promise.resolve(r ? { data: r, error: null } : { data: null, error: { message: "No rows" } });
      },
      then(onF: any, onR: any) {
        return Promise.resolve({ data: rows(), error: null }).then(onF, onR);
      },
    };
    return b;
  }

  return {
    from: builder,
    auth: {
      getUser: async (t: string) =>
        t === TOKEN
          ? { data: { user: { id: VIEWER_ID } }, error: null }
          : { data: { user: null }, error: { message: "bad token" } },
    },
    _inserted: inserted,
    _upserted: upserted,
    _updated: updated,
  } as any;
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.log = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {} };
    next();
  });
  app.use(mediaFeedRouter);
  return app;
}

async function post(client: any, id: string, body: any): Promise<{ status: number; body: any }> {
  _setTestClient(client, true);
  const app = makeApp();
  const server = await new Promise<http.Server>((resolve) => {
    const s = http.createServer(app).listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as { port: number };
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/media/${id}/report`, {
      method: "POST",
      headers: { "Content-Type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(body),
    });
    let parsed: any = null;
    try { parsed = await resp.json(); } catch { parsed = null; }
    return { status: resp.status, body: parsed };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const POST_ROW = { id: POST_ID, status: "active", author_id: CREATOR };
const GEM_ROW  = { id: GEM_ID, status: "active" };

// ─────────────────────────────────────────────────────────────────────────────
// A. The classifier
// ─────────────────────────────────────────────────────────────────────────────

describe("classifyMediaReportReason", () => {
  it("calls the two options-sheet preference reasons preferences", () => {
    assert.equal(classifyMediaReportReason("not_interested"), "preference");
    assert.equal(classifyMediaReportReason("hide_from_feed"), "preference");
  });

  it("calls every one of the eight report codes abuse", () => {
    for (const code of REPORT_REASON_CODES) {
      assert.equal(classifyMediaReportReason(code), "abuse", `${code} should be abuse`);
    }
  });

  it("keeps the gem place-mismatch claim in its own bucket", () => {
    assert.equal(classifyMediaReportReason("media_does_not_match_place"), "gem_place_mismatch");
  });

  it("refuses anything else rather than defaulting it to a report", () => {
    for (const junk of ["", "  ", "SPAM", "spam ok", "hide", "not-interested", "../../etc"]) {
      assert.equal(classifyMediaReportReason(junk), "unknown", `${JSON.stringify(junk)} should be unknown`);
    }
  });

  it("marks exactly the three high-severity codes high", () => {
    assert.equal(reportSeverityFor("harassment"), "high");
    assert.equal(reportSeverityFor("hate_speech"), "high");
    assert.equal(reportSeverityFor("violence"), "high");
    assert.equal(reportSeverityFor("spam"), "normal");
    assert.equal(reportSeverityFor("other"), "normal");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. Preference intents never reach the moderation queue
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /media/:id/report — viewer preference", () => {
  let client: any;
  beforeEach(() => { client = makeClient({ posts: [POST_ROW], hidden_gems: [] }); });

  it("hide writes post_hides, not reports", async () => {
    const res = await post(client, POST_ID, { reason: "hide_from_feed" });
    assert.equal(res.status, 200);
    assert.equal(res.body.hidden, true);
    assert.equal(res.body.store, "post_hides");
    const hides = client._upserted.filter((r: any) => r.table === "post_hides");
    assert.equal(hides.length, 1);
    assert.deepEqual(hides[0].row, { user_id: VIEWER_ID, post_id: POST_ID });
    assert.equal(client._inserted.filter((r: any) => r.table === "reports").length, 0);
  });

  it("not interested writes post_hides, not reports", async () => {
    const res = await post(client, POST_ID, { reason: "not_interested" });
    assert.equal(res.status, 200);
    assert.equal(res.body.hidden, true);
    assert.equal(client._inserted.filter((r: any) => r.table === "reports").length, 0);
    assert.equal(client._upserted.filter((r: any) => r.table === "post_hides").length, 1);
  });

  it("writes through the SAME idempotency contract as POST /posts/:postId/hide", async () => {
    // `post_hides` was a working feature before Media touched it — one writer
    // (POST /posts/:postId/hide), three readers, a client service and a Pulse
    // card entry point. Media was bypassing it, not replacing it, so both routes
    // now go through lib/postHide. The conflict target IS the idempotency
    // contract: get it wrong on one caller and a second tap becomes a 500 on a
    // gesture whose whole point is that repeating it is harmless.
    await post(client, POST_ID, { reason: "not_interested" });
    const hide = client._upserted.find((r: any) => r.table === "post_hides");
    assert.ok(hide, "expected an upsert into post_hides");
    assert.equal(hide.opts?.onConflict, "user_id,post_id");
    assert.equal(hide.opts?.ignoreDuplicates, true);
  });

  it("a preference on a GEM files nothing and never moves report_count", async () => {
    const gemClient = makeClient({ hidden_gems: [GEM_ROW], hidden_gem_reports: [] });
    const res = await post(gemClient, GEM_ID, { reason: "not_interested" });
    assert.equal(res.status, 200);
    assert.equal(res.body.hidden, false);
    assert.equal(res.body.store, "none");
    assert.equal(gemClient._inserted.filter((r: any) => r.table === "hidden_gem_reports").length, 0);
    // report_count is bumped by an UPDATE on hidden_gems inside reportGem.
    assert.equal(gemClient._updated.filter((r: any) => r.table === "hidden_gems").length, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C. Real reports go through the real contract
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /media/:id/report — abuse", () => {
  it("a harassment report is high severity", async () => {
    const client = makeClient({ posts: [POST_ROW], reports: [] });
    const res = await post(client, POST_ID, { reason: "harassment", notes: "n" });
    assert.equal(res.status, 200);
    const reports = client._inserted.filter((r: any) => r.table === "reports");
    assert.equal(reports.length, 1);
    assert.equal(reports[0].row.reason_code, "harassment");
    assert.equal(reports[0].row.severity, "high");
    assert.equal(reports[0].row.target_type, "post");
    assert.equal(reports[0].row.reporter_id, VIEWER_ID);
  });

  it("a spam report is normal severity and still carries one", async () => {
    const client = makeClient({ posts: [POST_ROW], reports: [] });
    await post(client, POST_ID, { reason: "spam" });
    const reports = client._inserted.filter((r: any) => r.table === "reports");
    assert.equal(reports.length, 1);
    assert.equal(reports[0].row.severity, "normal");
  });

  it("a second report from the same reporter is alreadyReported, not a second row", async () => {
    const client = makeClient({
      posts: [POST_ROW],
      reports: [{ id: "r1", reporter_id: VIEWER_ID, target_type: "post", target_id: POST_ID }],
    });
    const res = await post(client, POST_ID, { reason: "spam" });
    assert.equal(res.status, 200);
    assert.equal(res.body.alreadyReported, true);
    assert.equal(client._inserted.filter((r: any) => r.table === "reports").length, 0);
  });

  it("refuses a body with no reason", async () => {
    const client = makeClient({ posts: [POST_ROW], reports: [] });
    const res = await post(client, POST_ID, {});
    assert.equal(res.status, 400);
    assert.equal(client._inserted.length, 0);
    assert.equal(client._upserted.length, 0);
  });

  it("refuses an unrecognised reason instead of writing it as a reason_code", async () => {
    const client = makeClient({ posts: [POST_ROW], reports: [] });
    const res = await post(client, POST_ID, { reason: "i_just_do_not_like_it" });
    assert.equal(res.status, 400);
    assert.equal(client._inserted.length, 0);
    assert.equal(client._upserted.length, 0);
  });

  it("refuses the gem-only place-mismatch reason on a post", async () => {
    const client = makeClient({ posts: [POST_ROW], reports: [] });
    const res = await post(client, POST_ID, { reason: "media_does_not_match_place" });
    assert.equal(res.status, 400);
    assert.equal(client._inserted.length, 0);
  });

  it("still routes a real gem report to the gem pipeline", async () => {
    const client = makeClient({ hidden_gems: [GEM_ROW], hidden_gem_reports: [] });
    const res = await post(client, GEM_ID, { reason: "media_does_not_match_place" });
    assert.equal(res.status, 200);
    assert.equal(client._inserted.filter((r: any) => r.table === "hidden_gem_reports").length, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D. The hide has to actually hide, and the moderation deny-list has to deny
// ─────────────────────────────────────────────────────────────────────────────

function eligibilityClient(opts: { hides?: Array<{ user_id: string; post_id: string }> } = {}) {
  return {
    from(table: string) {
      const filters: Array<(r: any) => boolean> = [];
      const b: any = {
        select() { return b; },
        eq(col: string, val: any) { filters.push((r: any) => r[col] === val); return b; },
        in() { return b; },
        then(onF: any) {
          const src: any[] =
            table === "blocks" ? [] :
            table === "user_mutes" ? [] :
            table === "post_hides" ? (opts.hides ?? []) :
            table === "profiles" ? [] : [];
          return Promise.resolve({ data: src.filter((r) => filters.every((f) => f(r))), error: null }).then(onF);
        },
        maybeSingle() { return Promise.resolve({ data: null, error: null }); },
      };
      return b;
    },
  } as any;
}

function candidate(overrides: Record<string, any> = {}): MediaCandidate {
  return {
    id: POST_ID,
    author_id: CREATOR,
    status: "active",
    post_status: "published",
    visibility: "public",
    moderation_status: "approved",
    created_at: "2026-01-01T00:00:00Z",
    post_media: [{ id: "m1", processing_status: "ready", moderation_status: "approved" }],
    ...overrides,
  };
}

const VIEWER_CTX = {
  viewerUserId: VIEWER_ID,
  feedType: "for_you" as const,
  followedCreatorIds: new Set<string>(),
};

describe("filterEligibleMediaCandidates — viewer hide gate", () => {
  it("a hidden post never reaches the feed", async () => {
    const sc = eligibilityClient({ hides: [{ user_id: VIEWER_ID, post_id: POST_ID }] });
    const { eligible } = await filterEligibleMediaCandidates([candidate()], VIEWER_CTX, sc, new Set());
    assert.equal(eligible.length, 0);
  });

  it("another viewer's hide does not hide it from this one", async () => {
    const sc = eligibilityClient({ hides: [{ user_id: CREATOR, post_id: POST_ID }] });
    const { eligible } = await filterEligibleMediaCandidates([candidate()], VIEWER_CTX, sc, new Set());
    assert.equal(eligible.length, 1);
  });

  it("no hides at all leaves the item eligible", async () => {
    const sc = eligibilityClient({ hides: [] });
    const { eligible } = await filterEligibleMediaCandidates([candidate()], VIEWER_CTX, sc, new Set());
    assert.equal(eligible.length, 1);
  });
});

describe("filterEligibleMediaCandidates — §36 media moderation deny-list", () => {
  it("owner_deleted media is not distributable", async () => {
    const sc = eligibilityClient();
    const c = candidate({ post_media: [{ id: "m1", processing_status: "ready", moderation_status: "owner_deleted" }] });
    const { eligible } = await filterEligibleMediaCandidates([c], VIEWER_CTX, sc, new Set());
    assert.equal(eligible.length, 0);
  });

  it("removed media is not distributable", async () => {
    const sc = eligibilityClient();
    const c = candidate({ post_media: [{ id: "m1", processing_status: "ready", moderation_status: "removed" }] });
    const { eligible } = await filterEligibleMediaCandidates([c], VIEWER_CTX, sc, new Set());
    assert.equal(eligible.length, 0);
  });

  it("limited media — the canonical spelling of flagged — is not distributable", async () => {
    const sc = eligibilityClient();
    const c = candidate({ post_media: [{ id: "m1", processing_status: "ready", moderation_status: "limited" }] });
    const { eligible } = await filterEligibleMediaCandidates([c], VIEWER_CTX, sc, new Set());
    assert.equal(eligible.length, 0);
  });

  it("the legacy pending default is still distributable, or every new upload disappears", async () => {
    const sc = eligibilityClient();
    const c = candidate({ post_media: [{ id: "m1", processing_status: "ready", moderation_status: "pending" }] });
    const { eligible } = await filterEligibleMediaCandidates([c], VIEWER_CTX, sc, new Set());
    assert.equal(eligible.length, 1);
  });

  it("names all five non-distributable states, so shrinking the set is visible here", () => {
    assert.deepEqual(
      [...NON_DISTRIBUTABLE_MEDIA_MODERATION_STATES].sort(),
      ["flagged", "limited", "owner_deleted", "rejected", "removed"],
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E. The hide has to reach the ranker, or the penalty layer stays a read with
//    no writer — which is what it was.
// ─────────────────────────────────────────────────────────────────────────────

function signalsClient(rankEvents: any[], hides: any[]) {
  return {
    from(table: string) {
      const b: any = {
        select() { return b; },
        in() { return b; },
        eq() { return b; },
        then(onF: any) {
          const src = table === "rank_events" ? rankEvents : table === "post_hides" ? hides : [];
          return Promise.resolve({ data: src, error: null }).then(onF);
        },
      };
      return b;
    },
  } as any;
}

describe("loadMediaSignals — negative feedback has a producer", () => {
  it("counts distinct hides as notInterestedCount once the item has impressions", async () => {
    const db = signalsClient(
      [
        { item_id: POST_ID, event_type: "watch_impression" },
        { item_id: POST_ID, event_type: "watch_impression" },
        { item_id: POST_ID, event_type: "watch_impression" },
        { item_id: POST_ID, event_type: "watch_impression" },
      ],
      [{ post_id: POST_ID }, { post_id: POST_ID }],
    );
    const out = await loadMediaSignals(db, [POST_ID]);
    assert.equal(out.get(POST_ID)?.totalImpressionCount, 4);
    assert.equal(out.get(POST_ID)?.notInterestedCount, 2);
  });

  it("publishes NO hide count without an impression denominator", async () => {
    // `notInterestedPenalty` divides by `totalImpressions ?? 1`, so a hide count
    // with no impressions would read as a 100% hide rate off a single tap.
    const db = signalsClient([], [{ post_id: POST_ID }]);
    const out = await loadMediaSignals(db, [POST_ID]);
    assert.equal(out.get(POST_ID)?.notInterestedCount, undefined);
  });

  it("one hide out of many impressions is a small penalty, not the maximum", () => {
    const small = notInterestedPenalty(undefined, 1, 40);
    const many  = notInterestedPenalty(undefined, 20, 40);
    assert.ok(small > 0 && small < 0.2, `expected a small penalty, got ${small}`);
    assert.ok(many > small, "more hides must penalise more");
    assert.ok(many <= 0.6, "the penalty is capped at 0.6");
  });
});
