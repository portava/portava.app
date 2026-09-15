/**
 * DV-79 — Phase 9's SIXTH dimension: estimated travel intent.
 *
 * WHAT THE CENSUS ROW ASKED FOR
 * =============================
 * `12` Phase 9 lists six comparison axes; five are computed. The sixth,
 * "estimated travel intent", was graded FAIL with the evidence *"needs a
 * per-item trip-add / itinerary-add signal, which needs DV-40's recommendation
 * object"*. DV-40 records that `recommendations` / `recommendation_items` have
 * no `CREATE TABLE` anywhere, so that route was closed. Migration 2894 opened
 * the other one: `rank_events.outcome` now admits `trip_add`, which IS a
 * per-item trip-add signal, on the store `04` §2 says the surface must use.
 *
 * THE FOUR STATES, REUSED FROM THE CREATOR AXIS ON PURPOSE
 * =======================================================
 * `measured` · `not_joinable` · `unreadable` · `no_client` — the same shape
 * `ShadowCreatorConcentration` already carries, because the failure modes are
 * the same failure modes and a second spelling of them would be a second thing
 * to keep in sync.
 *
 * THE ONE THAT MATTERS MOST HERE
 * ==============================
 * Nothing writes `trip_add` yet: `POST /api/places/:placeId/add-to-trip-plan`
 * (routes/plan.ts) is the production trip-add site and it reports no outcome.
 * So EVERY page in production will read ZERO trip adds — from a read that RAN.
 *
 * A corpus of zero and a read that failed are DIFFERENT FACTS, and this is the
 * first axis where the zero is the expected everyday answer rather than an edge
 * case. If they collapse, the row says "travellers add nothing from Discovery"
 * when the truth is "nobody has ever recorded whether they do". Every test
 * below that says MUTATION GUARD is pinning exactly that separation.
 *
 * Run: node --import tsx/esm --test src/test/discoveryShadowTravelIntent.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  pageTravelIntent,
  resolvePageTripAdds,
  tripAddWriterNote,
  unmeasuredPhase9Axes,
  compareShadowPagesWithCreators,
  UNMEASURED_PHASE9_AXES,
  TRIP_ADD_WRITERS,
  type ShadowPageItem,
} from "../lib/discoveryShadow.js";
import {
  aggregateTravelIntent,
  formatTravelIntent,
  aggregatePhase9,
  formatPhase9,
  type ShadowPhase9Blob,
  type ShadowServeRow,
} from "../lib/discoveryDivergenceReport.js";

const P1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const P2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const item = (id: string): ShadowPageItem => ({ id, category: "food" });

/** A client whose `rank_events` read answers with `rows`, or fails, PostgREST-shaped. */
function tripAddClient(opts: { rows?: any[]; error?: unknown; throws?: boolean } = {}) {
  const calls: any[] = [];
  const client: any = {
    from(table: string) {
      if (table !== "rank_events") return { insert: async () => ({ error: null }) };
      const q: any = {
        select(cols: string) { calls.push({ table, cols, filters: [] as any[], ids: [] as string[] }); return q; },
        eq(col: string, val: any) { calls[calls.length - 1].filters.push([col, val]); return q; },
        limit() { return q; },
        in: async (col: string, ids: string[]) => {
          calls[calls.length - 1].col = col;
          calls[calls.length - 1].ids = ids;
          if (opts.throws) throw new Error("connection reset");
          return { data: opts.rows ?? null, error: opts.error ?? null };
        },
      };
      return q;
    },
  };
  return { client, calls };
}

// ── A. pageTravelIntent — the pure per-page count ────────────────────────────

describe("DV-79 — pageTravelIntent: a rate that carries its own denominator", () => {
  it("counts items with intent and rows of intent separately", () => {
    const t = pageTravelIntent(
      [item(`db/${P1}`), item(`db/${P2}`), item("node/9")],
      new Map([[`db/${P1}`, 3], [`db/${P2}`, 1]]),
    );
    assert.equal(t.n, 3);
    assert.equal(t.itemsWithTripAdd, 2, "two of the three items were added to a trip by somebody");
    assert.equal(t.tripAdds, 4, "and four separate trip adds were recorded across them");
    assert.equal(t.tripAddRate, 2 / 3, "the rate is per ITEM, not per row — one item added twice is one item");
  });

  it("a page nobody added anything from is a real zero, with a real rate", () => {
    const t = pageTravelIntent([item("node/1"), item("node/2")], new Map());
    assert.equal(t.itemsWithTripAdd, 0);
    assert.equal(t.tripAdds, 0);
    assert.equal(t.tripAddRate, 0, "0 of 2 is a rate; this page was read and nobody added from it");
  });

  it("an EMPTY page has no rate at all — 0/0 is not a zero rate", () => {
    const t = pageTravelIntent([], new Map());
    assert.equal(t.n, 0);
    assert.equal(t.tripAddRate, null, "a rate over no items is not 0, it is undefined");
  });
});

// ── B. resolvePageTripAdds — the four states ────────────────────────────────

describe("DV-79 — resolvePageTripAdds: the read the shadow writer does for itself", () => {
  it("reads rank_events for outcome='trip_add' over the page's ids, and nothing else", async () => {
    const { client, calls } = tripAddClient({
      rows: [{ item_id: `db/${P1}` }, { item_id: `db/${P1}` }, { item_id: `db/${P2}` }],
    });
    const out = await resolvePageTripAdds(client, [`db/${P1}`, `db/${P2}`, `db/${P1}`]);
    assert.equal(out.reason, "measured");
    assert.equal(calls.length, 1, "one read, not one per item");
    assert.equal(calls[0].col, "item_id");
    assert.deepEqual(calls[0].ids.slice().sort(), [`db/${P1}`, `db/${P2}`], "ids are de-duplicated before the read");
    assert.deepEqual(calls[0].filters, [["outcome", "trip_add"]], "only the trip-add rows; every other outcome is somebody else's axis");
    assert.equal(out.tripAdds.get(`db/${P1}`), 2);
    assert.equal(out.tripAdds.get(`db/${P2}`), 1);
  });

  it("MUTATION GUARD: a read that RAN and found nothing is `measured` with an EMPTY map — not `unreadable`", async () => {
    const { client, calls } = tripAddClient({ rows: [] });
    const out = await resolvePageTripAdds(client, [`db/${P1}`]);
    assert.equal(
      out.reason, "measured",
      "this is the state production is in today, and calling it unreadable would hide that the read works",
    );
    assert.equal(out.tripAdds.size, 0);
    assert.equal(calls.length, 1, "the read was actually issued");
  });

  it("FAIL CLOSED: a rejected read is `unreadable` with NO counts", async () => {
    const { client } = tripAddClient({ error: { message: "permission denied" } });
    const out = await resolvePageTripAdds(client, [`db/${P1}`]);
    assert.equal(out.reason, "unreadable");
    assert.equal(out.tripAdds.size, 0);
  });

  it("FAIL CLOSED: a throwing read is `unreadable`, and never escapes", async () => {
    const { client } = tripAddClient({ throws: true });
    const out = await resolvePageTripAdds(client, [`db/${P1}`]);
    assert.equal(out.reason, "unreadable");
  });

  it("no client is `no_client` — the same amount of knowledge, a different cause", async () => {
    const out = await resolvePageTripAdds(null, [`db/${P1}`]);
    assert.equal(out.reason, "no_client");
  });

  it("an EMPTY page is `not_joinable`: there was nothing to ask, and no read was issued", async () => {
    const { client, calls } = tripAddClient({ rows: [] });
    const out = await resolvePageTripAdds(client, []);
    assert.equal(out.reason, "not_joinable");
    assert.equal(calls.length, 0);
  });
});

// ── C. The axis on the comparison, and the writerless label ─────────────────

describe("DV-79 — the axis on the shadow comparison", () => {
  const legacy = [item(`db/${P1}`)];
  const pde    = [item(`db/${P2}`)];

  it("a measured read removes estimated_travel_intent from `unmeasured`", async () => {
    const { client } = tripAddClient({ rows: [{ item_id: `db/${P1}` }] });
    const dims = await compareShadowPagesWithCreators(client, legacy, pde);
    assert.equal(dims.estimatedTravelIntent!.reason, "measured");
    assert.equal(dims.estimatedTravelIntent!.legacy!.tripAdds, 1);
    assert.equal(dims.estimatedTravelIntent!.pde!.tripAdds, 0, "the PDE page's item had none — a real zero");
    assert.equal(
      dims.unmeasured.includes("estimated_travel_intent"), false,
      "the axis was measured and must not still be named as unmeasured",
    );
  });

  it("MUTATION GUARD: a measured-zero page and an unreadable page are not the same row", async () => {
    const zero = await compareShadowPagesWithCreators(tripAddClient({ rows: [] }).client, legacy, pde);
    const dead = await compareShadowPagesWithCreators(tripAddClient({ error: { message: "boom" } }).client, legacy, pde);

    assert.equal(zero.estimatedTravelIntent!.reason, "measured");
    assert.equal(dead.estimatedTravelIntent!.reason, "unreadable");

    // The figures, which is where a collapse would actually do its damage.
    assert.equal(zero.estimatedTravelIntent!.legacy!.tripAdds, 0, "read, found none");
    assert.equal(dead.estimatedTravelIntent!.legacy, null, "not read — and a 0 here would read as 'nobody wanted to go'");
    assert.notDeepEqual(
      zero.estimatedTravelIntent, dead.estimatedTravelIntent,
      "a corpus of zero and a failed read must not serialise to the same thing",
    );

    // And the named-axis list, which is what a reader of the report sees.
    assert.equal(zero.unmeasured.includes("estimated_travel_intent"), false);
    assert.equal(dead.unmeasured.includes("estimated_travel_intent"), true);
  });

  it("names the missing writer on the row, so a zero is never read as a finding", async () => {
    const { client } = tripAddClient({ rows: [] });
    const dims = await compareShadowPagesWithCreators(client, legacy, pde);
    assert.deepEqual(TRIP_ADD_WRITERS, [], "the writer list is empty today; adding one retires the note below");
    assert.equal(dims.estimatedTravelIntent!.writerless, tripAddWriterNote());
    assert.match(String(dims.estimatedTravelIntent!.writerless), /add-to-trip-plan/);
    assert.match(String(dims.estimatedTravelIntent!.writerless), /2894/);
  });
});

describe("DV-79 — unmeasuredPhase9Axes covers both axes", () => {
  const measuredCreators = { reason: "measured" as const, legacy: null, pde: null };
  const measuredIntent   = { reason: "measured" as const, writerless: null, legacy: null, pde: null };

  it("names both when neither was read — the seed answer, unchanged", () => {
    assert.deepEqual(unmeasuredPhase9Axes(null), UNMEASURED_PHASE9_AXES);
    assert.deepEqual(unmeasuredPhase9Axes(null, null), UNMEASURED_PHASE9_AXES);
  });

  it("drops each axis independently, and only when its own read ran", () => {
    assert.deepEqual(unmeasuredPhase9Axes(measuredCreators, null), ["estimated_travel_intent"]);
    assert.deepEqual(unmeasuredPhase9Axes(null, measuredIntent), ["creator_concentration"]);
    assert.deepEqual(unmeasuredPhase9Axes(measuredCreators, measuredIntent), []);
  });

  it("an unreadable intent keeps the axis NAMED", () => {
    const dead = { reason: "unreadable" as const, writerless: null, legacy: null, pde: null };
    assert.deepEqual(unmeasuredPhase9Axes(measuredCreators, dead), ["estimated_travel_intent"]);
  });
});

// ── D. The reader ───────────────────────────────────────────────────────────

const dims = { n: 1, categoryDistinct: 1, categoryEntropy: 0, placeDistinct: 1, neighborhoodDistinct: 0, geoCellDistinct: 0, meanSavedCount: null, savedCountCoverage: 0 };

function blob(intent: any): ShadowPhase9Blob {
  return {
    legacy: dims, pde: dims,
    creatorConcentration: null,
    estimatedTravelIntent: intent,
    unmeasured: intent && intent.reason === "measured" ? ["creator_concentration"] : ["creator_concentration", "estimated_travel_intent"],
  } as ShadowPhase9Blob;
}

const page = (tripAdds: number, itemsWith: number, n = 2) =>
  ({ n, itemsWithTripAdd: itemsWith, tripAdds, tripAddRate: n === 0 ? null : itemsWith / n });

const measured = (l: any, p: any) => ({ reason: "measured", writerless: "no writer", legacy: l, pde: p });

function row(b: ShadowPhase9Blob): ShadowServeRow {
  return {
    serve_point: 1, sort_by: null, cohort_reason: "percent_in", page_size: 20,
    legacy_total: 20, pde_total: 20, overlap_count: 20, displaced_count: 0,
    top_changed: false, legacy_ms: 10, pde_ms: 20, pde_suppressed_writes: 0,
    pde_stages: { phase9: b },
  };
}

describe("DV-79 — aggregateTravelIntent keeps zero and unreadable apart", () => {
  it("averages only the rows whose read RAN, and counts the rest separately", () => {
    const agg = aggregateTravelIntent([
      blob(measured(page(4, 2), page(0, 0))),
      blob(measured(page(0, 0), page(2, 1))),
      blob({ reason: "unreadable", writerless: null, legacy: null, pde: null }),
      blob(null),   // a row written before the axis existed — invisible here
    ]);
    assert.ok(agg);
    assert.equal(agg!.n, 2, "two rows measured");
    assert.equal(agg!.unreadable, 1, "one carried the axis and could not read it");
    assert.equal(agg!.meanTripAddsLegacy, 2, "(4 + 0) / 2");
    assert.equal(agg!.meanTripAddRatePde, 0.25, "(0 + 0.5) / 2");
  });

  it("MUTATION GUARD: a group of measured ZEROS is not a group that could not read", () => {
    const zeros = aggregateTravelIntent([blob(measured(page(0, 0), page(0, 0)))]);
    const dead  = aggregateTravelIntent([blob({ reason: "unreadable", writerless: null, legacy: null, pde: null })]);

    assert.ok(zeros, "a page that read zero HAS an aggregate — it was measured");
    assert.equal(zeros!.n, 1);
    assert.equal(zeros!.zeroCorpus, 1, "and it says so: every measured row found nothing");
    assert.equal(zeros!.meanTripAddsLegacy, 0);

    assert.equal(dead, null, "a group where NO row could read has no aggregate — null, never a mean of 0");
    assert.notDeepEqual(zeros, dead);
  });

  it("zeroCorpus counts only the measured rows that found nothing", () => {
    const agg = aggregateTravelIntent([
      blob(measured(page(0, 0), page(0, 0))),
      blob(measured(page(1, 1), page(0, 0))),
    ]);
    assert.equal(agg!.n, 2);
    assert.equal(agg!.zeroCorpus, 1, "the second row found a trip add on the legacy page");
  });
});

describe("DV-79 — the report prints the difference", () => {
  it("prints prose, not a number, when no row in the group could read the axis", () => {
    const line = formatTravelIntent(null).join("\n");
    assert.match(line, /travel intent/i);
    assert.doesNotMatch(line, /\b0\.00\b/, "an unread axis must never print a quotable zero");
  });

  it("prints the zero AND the reason it is zero when the read ran", () => {
    const agg = aggregateTravelIntent([blob(measured(page(0, 0), page(0, 0)))]);
    const line = formatTravelIntent(agg).join("\n");
    assert.match(line, /0\.00/, "a measured zero is a number and is printed as one");
    assert.match(line, /read on 1 row/, "beside the count of rows that actually read");
    assert.match(line, /no writer/i, "and beside the reason every one of them found nothing");
  });

  it("formatPhase9 carries the travel-intent lines beside the others", () => {
    const agg = aggregatePhase9([row(blob(measured(page(1, 1), page(0, 0))))]);
    const out = formatPhase9(agg).join("\n");
    assert.match(out, /travel intent/i);
    assert.match(out, /NOT measured   creator_concentration/, "the row's own unmeasured list still prints");
  });
});
