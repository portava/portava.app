/**
 * §41 — the end-to-end Wall loop, and the leg that was open.
 *
 *   OPEN → LIVE FOR YOU → FOR YOU/FOLLOWING → SOCIAL OBJECT → ENJOY/ENGAGE →
 *   OPTIONAL CONTEXT → PLACE/MAP/TRIP/COMPASS/BUDDY/GEM → REAL-WORLD ACTION →
 *   POST/VIDEO/POSTCARD/MOMENT → SOCIAL GRAPH + MEMORY + INTELLIGENCE →
 *   *** FUTURE WALL RELEVANCE ***
 *
 * Every hop existed as code EXCEPT the return: nothing read an outcome back so
 * that it changed what the Wall later shows. `POST /wall/action { hide }` had
 * written `rank_events` (surface='wall', event_type=ranking_item_hidden) since
 * the Wall shipped; a repo-wide search found no reader anywhere. So "not
 * interested" lived in a `useRef` on the client and came back on the next
 * launch — the loop was open at exactly the point it is supposed to close.
 *
 * IT CLOSES ON THE DEPLOYED STORE. The Wall's own telemetry table
 * (`wall_telemetry_events`, migration 2308) is NOT applied in production, so a
 * loop closed through it would be closed on paper. `rank_events` is the table
 * the Wall already writes, and it exists.
 *
 * IT IS A VISIBILITY FILTER, NOT A RANKING TERM. The object is removed for this
 * viewer rather than scored down — which is why it holds identically in
 * Following, where TABLE 1 forbids relevance reordering outright, and why it
 * touches no part of the ranker (which is on owner hold).
 *
 * MUTATION PROOF (each verified: revert → RED, restore → GREEN)
 *   • drop the `!suppressed?.has(...)` term from `projectObjects` → the
 *     suppression tests RED.
 *   • drop `.eq("surface", "wall")` from `loadViewerSuppressions` → the
 *     other-surface test RED.
 *   • drop `.eq("event_type", ...)` → the impression-is-not-a-hide test RED.
 *   • drop `.gte("served_at", since)` → the expiry test RED.
 *   • make the read throw instead of returning an empty set → the fail-soft
 *     test RED (the feed would collapse instead of losing a preference).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadViewerSuppressions, SUPPRESSION_WINDOW_MS } from "../routes/wall.js";
import { RankingEvent } from "../services/ranking/rankingAnalytics.js";
import {
  projectObjects,
  type ProjectViewerContext,
  type WallCandidate,
} from "../services/wall/WallProjectionService.js";

const VIEWER = "viewer-1";
const NOW = new Date("2026-09-07T12:00:00.000Z");

interface HideRow {
  item_id: string;
  user_id: string;
  surface: string;
  event_type: string;
  served_at: string;
}

function hideRow(over: Partial<HideRow> = {}): HideRow {
  return {
    item_id: "post-1",
    user_id: VIEWER,
    surface: "wall",
    event_type: RankingEvent.ITEM_HIDDEN,
    served_at: new Date(NOW.getTime() - 1000).toISOString(),
    ...over,
  };
}

/** A fake that APPLIES the eq/gte filters, so a missing filter in the product
 *  code changes the answer instead of being silently ignored. */
function rankEventsClient(rows: HideRow[], opts: { fail?: boolean; throws?: boolean } = {}) {
  function builder(table: string) {
    const eqs: Record<string, unknown> = {};
    let gteField: string | null = null;
    let gteValue: string | null = null;
    const resolve = () => {
      if (opts.throws) throw new Error("boom");
      if (opts.fail) return { data: null, error: { message: "boom" } };
      if (table !== "rank_events") return { data: [], error: null };
      const filtered = rows.filter((r) => {
        for (const [k, v] of Object.entries(eqs)) {
          if ((r as any)[k] !== v) return false;
        }
        if (gteField && gteValue && String((r as any)[gteField]) < gteValue) return false;
        return true;
      });
      return { data: filtered, error: null };
    };
    const b: any = {
      select: () => b,
      eq: (c: string, v: unknown) => {
        eqs[c] = v;
        return b;
      },
      in: () => b,
      or: () => b,
      gte: (c: string, v: string) => {
        gteField = c;
        gteValue = v;
        return b;
      },
      lte: () => b,
      order: () => b,
      limit: () => b,
      maybeSingle: () => Promise.resolve().then(resolve),
      then: (onF: any, onR: any) => Promise.resolve().then(resolve).then(onF, onR),
    };
    return b;
  }
  return { from: builder };
}

describe("§41 return leg — a hide is read BACK, on the deployed store", () => {
  it("reads the viewer's own wall hides", async () => {
    const set = await loadViewerSuppressions(
      rankEventsClient([hideRow(), hideRow({ item_id: "post-2" })]) as any,
      VIEWER,
      { now: NOW },
    );
    assert.deepEqual([...set].sort(), ["post-1", "post-2"]);
  });

  it("another viewer's hide is not this viewer's", async () => {
    const set = await loadViewerSuppressions(
      rankEventsClient([hideRow({ user_id: "someone-else" })]) as any,
      VIEWER,
      { now: NOW },
    );
    assert.equal(set.size, 0);
  });

  it("a hide on another SURFACE does not suppress on the Wall", async () => {
    const set = await loadViewerSuppressions(
      rankEventsClient([hideRow({ surface: "discovery" })]) as any,
      VIEWER,
      { now: NOW },
    );
    assert.equal(set.size, 0);
  });

  it("an impression is not a hide", async () => {
    const set = await loadViewerSuppressions(
      rankEventsClient([hideRow({ event_type: RankingEvent.ITEM_IMPRESSION })]) as any,
      VIEWER,
      { now: NOW },
    );
    assert.equal(set.size, 0);
  });

  it("a hide older than the window expires — one tap is not a permanent verdict", async () => {
    const old = new Date(NOW.getTime() - SUPPRESSION_WINDOW_MS - 60_000).toISOString();
    const set = await loadViewerSuppressions(
      rankEventsClient([hideRow({ served_at: old })]) as any,
      VIEWER,
      { now: NOW },
    );
    assert.equal(set.size, 0);
    // Positive control: the same row inside the window IS read.
    const inside = new Date(NOW.getTime() - SUPPRESSION_WINDOW_MS + 60_000).toISOString();
    const set2 = await loadViewerSuppressions(
      rankEventsClient([hideRow({ served_at: inside })]) as any,
      VIEWER,
      { now: NOW },
    );
    assert.deepEqual([...set2], ["post-1"]);
  });

  it("an unreadable engagement store costs a preference, never the feed", async () => {
    for (const opts of [{ fail: true }, { throws: true }]) {
      const set = await loadViewerSuppressions(rankEventsClient([], opts) as any, VIEWER, {
        now: NOW,
      });
      assert.equal(set.size, 0, "degrades to no suppressions rather than throwing");
    }
    assert.equal((await loadViewerSuppressions(null as any, VIEWER)).size, 0);
  });
});

// ── …and the read-back actually changes what the Wall shows ──────────────────

function noBlocksClient() {
  const b: any = {
    select: () => b, eq: () => b, in: () => b, or: () => b,
    gte: () => b, lte: () => b, order: () => b, limit: () => b,
    maybeSingle: () => Promise.resolve({ data: null, error: null }),
    then: (onF: any, onR: any) => Promise.resolve({ data: [], error: null }).then(onF, onR),
  };
  return { from: () => b };
}

function candidate(id: string): WallCandidate {
  return {
    objectType: "social_post",
    canonicalObjectId: id,
    authorId: "author-1",
    visibility: "public",
    publishedAt: "2026-09-01T00:00:00.000Z",
    authorAccountStatus: "active",
  };
}

const VIEWER_CTX: ProjectViewerContext = {
  viewerId: VIEWER,
  viewerTripIds: new Set<string>(),
  followedCreatorIds: new Set<string>(["author-1"]),
};

describe("§41 return leg — the suppression reaches the projection gate", () => {
  it("a hidden object is DROPPED, not merely demoted", async () => {
    const items = await projectObjects(
      noBlocksClient() as any,
      [candidate("post-1"), candidate("post-2")],
      { ...VIEWER_CTX, suppressedObjectIds: new Set(["post-1"]) },
    );
    assert.deepEqual(items.map((i) => i.canonicalObjectId), ["post-2"]);
  });

  it("without the read-back the same object is shown (positive control)", async () => {
    const items = await projectObjects(noBlocksClient() as any, [candidate("post-1")], VIEWER_CTX);
    assert.deepEqual(items.map((i) => i.canonicalObjectId), ["post-1"]);
  });

  it("suppressing everything yields a safe empty feed, never an error", async () => {
    const items = await projectObjects(noBlocksClient() as any, [candidate("post-1")], {
      ...VIEWER_CTX,
      suppressedObjectIds: new Set(["post-1"]),
    });
    assert.deepEqual(items, []);
  });
});
