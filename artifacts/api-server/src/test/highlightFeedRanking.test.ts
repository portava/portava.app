/**
 * §12 RANKING, ON THE SURFACE THAT SERVES IT — census H99, H100, H101.
 *
 * Highlights/Memories Development Architecture Spec v1 §12:
 *
 *     Ranking
 *       manual_pin + recency + significance + current_relevance
 *       + audience_relevance + presentation_quality + diversity_constraints
 *
 *     "Pinned/manual order always outranks automatic ordering. Diversity should
 *      prevent repetitive auto-selection across the same trip, person, venue, or
 *      activity type unless the user explicitly curates that way."
 *
 * WHAT THE CENSUS RECORDED, AND WHAT THIS SUITE IS EVIDENCE FOR
 * ------------------------------------------------------------
 * §Q.6 holds all three rows BUILT-BUT-WRONG on ONE shared blocker, stated twice
 * in the document's own words:
 *
 *   H99  "`rankHighlights` — §12's seven factors — has NO caller in
 *         `src/routes/` or `src/services/` outside its own module. Only
 *         `pinnedFirst` is wired."
 *   H101 "`DIVERSITY_DIMENSIONS` … applied inside `rankHighlights`.
 *         Unreachable."
 *   H100 "`pinnedFirst` runs on ONE of the four read surfaces, the profile.
 *         `GET /highlights/active`, `/highlights/following-feed` and
 *         `/highlights/archived` do not apply it. There is also no automatic
 *         ranking on that surface to outrank — it is `ORDER BY created_at`."
 *
 * §Q.9 then says what a caller would MEAN: "`rankHighlights` acquiring a
 * caller. H99 and H100 stop being 'unreachable' and start being 'unenforced on
 * three of four surfaces', which is a different and worse sentence." This suite
 * is written against that, not around it — case 5 asserts on the surfaces that
 * are still NOT ranked, so the new sentence is pinned rather than implied.
 *
 * THE CASE MOST WORTH HAVING is case 3. Diversity is a property of the
 * SEQUENCE, which no per-item assertion can express, and it is the one §12 rule
 * that a caller can wire, appear to satisfy, and silently not apply — because a
 * list that was already varied looks identical either way. Case 3 therefore
 * feeds a page that is maximally repetitive by `created_at` and asserts the
 * served order is NOT that order.
 *
 * Run: node --import tsx/esm --test src/test/highlightFeedRanking.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  startApp, call, fixtureTables, highlight, VIEWER, OWNER, OTHER, FUTURE,
} from "./highlightsSpecHarness.js";
import {
  DIVERSITY_DIMENSIONS,
  FEED_DIVERSITY_DIMENSIONS,
  UNRESOLVABLE_DIVERSITY_DIMENSIONS,
  HIGHLIGHT_RANKING_FACTORS,
  RANKING_FACTORS_MEASURED_ON_ROW,
  RANKING_FACTORS_UNMEASURED,
  rankableFromRow,
  rankHighlightRows,
} from "../services/highlights/highlightRanking.js";

const ids = (body: any): string[] => (body?.highlights ?? []).map((h: any) => h.id as string);

/** Three owners, interleaved so `created_at DESC` is maximally repetitive. */
const A = "50000000-0000-4000-8000-00000000000a";
const B = "50000000-0000-4000-8000-00000000000b";
const C1 = "50000000-0000-4000-8000-00000000000c";

function at(minutesAgo: number): string {
  // Anchored to a FIXED instant, never the real clock: these rows are compared
  // against each other, and the only thing that must hold is their order.
  return new Date(Date.parse("2026-09-20T12:00:00.000Z") - minutesAgo * 60_000).toISOString();
}

const D = "50000000-0000-4000-8000-00000000000d";
const E = "50000000-0000-4000-8000-00000000000e";

/**
 * A page whose `created_at DESC` order is OWNER, OWNER, OWNER, OTHER, OTHER —
 * two runs, the first of length three. Any §12 diversity pass on `person` must
 * break both.
 *
 * EVERY ROW GETS ITS OWN VENUE, deliberately. The shared fixture defaults
 * `location_name` to one string for every Highlight, which would make all five
 * "the same venue" — and `applyDiversity`, unable to satisfy that constraint
 * for any candidate, would fall back to emitting in score order and hand this
 * suite `created_at DESC` while appearing to pass. The venue axis is exercised
 * on its own in the unit cases below; here it is held CONSTANT-FREE so the
 * assertion is about `person` and nothing else.
 */
const OWNER_OF: ReadonlyArray<readonly [string, string]> = [
  [A, OWNER], [B, OWNER], [C1, OWNER], [D, OTHER], [E, OTHER],
];

function repetitiveTables() {
  const t = fixtureTables();
  t.highlights = OWNER_OF.map(([id, owner], i) =>
    highlight(id, owner, {
      visibility: "public",
      created_at: at(i + 1),
      expires_at: FUTURE,
      location_name: `venue-${i}`,
      location_city: `city-${i}`,
    }),
  );
  return t;
}

describe("§12 the ranking model reaches a route", () => {
  /* ----------------------------------------------------------------------
   * Case 1 — H99's stated blocker, asserted directly on the source.
   *
   * The row's blocker is a REACHABILITY claim, so the honest assertion is a
   * reachability one. A behavioural test alone could be satisfied by a route
   * that re-implemented §12 inline, which would leave `rankHighlights`
   * exactly as uncalled as the census found it while the suite went green.
   * -------------------------------------------------------------------- */
  it("`rankHighlights` and `DIVERSITY_DIMENSIONS` have a caller outside their own module", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const { join, dirname, resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const src = resolve(dirname(fileURLToPath(import.meta.url)), "..");

    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
      );

    const callers: string[] = [];
    for (const f of [...walk(join(src, "routes")), ...walk(join(src, "services"))]) {
      if (f.endsWith("highlightRanking.ts")) continue; // its own module does not count
      const text = readFileSync(f, "utf8");
      if (/\brankHighlightRows\s*\(|\brankHighlights\s*\(/.test(text)) callers.push(f);
    }
    assert.ok(
      callers.length > 0,
      "§12's ranking model still has no caller in src/routes or src/services — H99's blocker verbatim",
    );
  });

  /* ----------------------------------------------------------------------
   * Case 2 — H100: "pinned/manual order ALWAYS outranks automatic ordering."
   *
   * The pinned row is deliberately the OLDEST on the page, so recency-desc
   * and pin-first disagree and only one of them can produce the answer.
   * -------------------------------------------------------------------- */
  it("a pinned Highlight leads GET /highlights/active even when it is the oldest", async () => {
    const t = repetitiveTables();
    // C1 is the oldest of OWNER's three, and it is the pinned one.
    t.highlights = t.highlights.map((h: any) => (h.id === C1 ? { ...h, pinned_at: at(0) } : h));
    const app = await startApp({ tables: t });
    try {
      const r = await call(app, "GET", "/api/highlights/active", VIEWER);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const order = ids(r.body);
      assert.ok(order.length >= 2, `expected a populated page, got ${JSON.stringify(r.body)}`);
      assert.equal(
        order[0], C1,
        `§12: pinned order always outranks automatic ordering. Served: ${JSON.stringify(order)}`,
      );
    } finally { await app.close(); }
  });

  /* ----------------------------------------------------------------------
   * Case 2b — RANK THEN CUT, and the mutation that made this case necessary.
   *
   * The first version of this suite had no case that could tell ranking BEFORE
   * `.slice(0, limit)` from ranking AFTER it. Moving the cut in front of the
   * ranker left every case above green, because the fixture has five rows and
   * the default limit is fifty — so the cut never removed anything and the two
   * orders were identical.
   *
   * That is not a cosmetic difference. Ranking a page `created_at DESC` has
   * already chosen means §12's top-ranked Highlight can be discarded before the
   * ranker ever sees it: the pin is honoured only among rows that were recent
   * enough to survive a cut that knows nothing about pins. The page then LOOKS
   * considered and is not, which is the exact failure highlightRanking.ts's own
   * header warns about.
   *
   * The case that separates them: a page limit SMALLER than the candidate set,
   * and the pinned Highlight deliberately the oldest — so it is outside the
   * `created_at DESC` prefix and can only appear if the pin was applied first.
   * -------------------------------------------------------------------- */
  it("the pin survives a page cut, because §12 ranks BEFORE it cuts", async () => {
    const t = repetitiveTables();
    t.highlights = t.highlights.map((h: any) => (h.id === E ? { ...h, pinned_at: at(0) } : h));
    const app = await startApp({ tables: t });
    try {
      // E is the OLDEST of the five and the only pinned one. `created_at DESC`
      // puts it last; a cut-then-rank page of two would be [A, B].
      const r = await call(app, "GET", "/api/highlights/active?limit=2", VIEWER);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const order = ids(r.body);
      assert.equal(order.length, 2, `expected a page of 2, got ${JSON.stringify(order)}`);
      assert.equal(
        order[0], E,
        "§12's pinned Highlight was cut from the page before the ranker saw it — the cut ran first. " +
          `Served: ${JSON.stringify(order)}`,
      );
    } finally { await app.close(); }
  });

  /* ----------------------------------------------------------------------
   * Case 3 — H101. The sequence assertion, and the one that cannot be
   * satisfied by accident.
   * -------------------------------------------------------------------- */
  it("§12 diversity breaks a run of the same person on GET /highlights/active", async () => {
    const app = await startApp({ tables: repetitiveTables() });
    try {
      const r = await call(app, "GET", "/api/highlights/active", VIEWER);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const order = ids(r.body);
      assert.equal(order.length, 5, `expected every row served, got ${JSON.stringify(order)}`);

      // The page is a PERMUTATION — diversity reorders, it never drops.
      assert.deepEqual(
        [...order].sort(),
        [A, B, C1, D, E].sort(),
        "the diversity pass lost or invented a row",
      );

      // …and no two ADJACENT rows share an owner, which `created_at DESC`
      // cannot produce for this fixture.
      const ownerOf = new Map<string, string>(OWNER_OF.map(([id, o]) => [id, o]));
      for (let i = 1; i < order.length; i++) {
        assert.notEqual(
          ownerOf.get(order[i]), ownerOf.get(order[i - 1]),
          `§12 diversity: ${order[i - 1]} and ${order[i]} share an owner. Served: ${JSON.stringify(order)}`,
        );
      }
    } finally { await app.close(); }
  });

  /* ----------------------------------------------------------------------
   * Case 4 — the ceiling, on the wire.
   *
   * Two of §12's four diversity dimensions cannot be keyed on this surface
   * and five of its six factors cannot be measured. A client that rendered
   * "ranked" without that would be claiming something the server does not
   * know. This is the same posture `consentEnforcement` takes for §10, and
   * it is asserted as a PARTITION for the same reason: a dimension that fell
   * out of both lists would be constrained by nobody and reported by nobody.
   * -------------------------------------------------------------------- */
  it("the applied and unresolvable dimensions PARTITION §12's four, and the factors partition its six", () => {
    assert.deepEqual(
      [...FEED_DIVERSITY_DIMENSIONS, ...UNRESOLVABLE_DIVERSITY_DIMENSIONS].sort(),
      [...DIVERSITY_DIMENSIONS].sort(),
      "a §12 diversity dimension is in neither list — constrained by nobody, reported by nobody",
    );
    for (const d of FEED_DIVERSITY_DIMENSIONS) {
      assert.equal(UNRESOLVABLE_DIVERSITY_DIMENSIONS.includes(d), false, `${d} is in both lists`);
    }
    // `trip` is the dimension census H90 records as unkeyable on this table,
    // and `activity` has no taxonomy at all. Pinned by NAME: a future change
    // that quietly started keying `trip` on something would have to say so.
    assert.deepEqual([...UNRESOLVABLE_DIVERSITY_DIMENSIONS].sort(), ["activity", "trip"]);

    assert.deepEqual(
      [...RANKING_FACTORS_MEASURED_ON_ROW, ...RANKING_FACTORS_UNMEASURED].sort(),
      [...HIGHLIGHT_RANKING_FACTORS].sort(),
      "a §12 factor is in neither list",
    );
    assert.deepEqual([...RANKING_FACTORS_MEASURED_ON_ROW], ["recency"]);
  });

  /* ----------------------------------------------------------------------
   * Case 5 — §Q.9's "different and worse sentence", pinned.
   *
   * The census predicted that giving §12 a caller turns H99/H100 from
   * "unreachable" into "unenforced on three of four surfaces". That is now
   * the true sentence, and leaving it to prose would let the next lane read
   * this suite as a claim that §12 is applied everywhere. It is not:
   * `/highlights/following-feed` pages on a `created_at` cursor, and
   * reordering a page whose LAST row supplies the next cursor would make the
   * cursor skip rows — a correctness defect traded for an ordering one.
   * -------------------------------------------------------------------- */
  it("the following-feed is NOT ranked, and its cursor is the reason", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const route = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "..", "routes", "highlights.ts"),
      "utf8",
    );
    const feed = route.slice(route.indexOf('router.get("/highlights/following-feed"'));
    assert.ok(feed.length > 0, "the following-feed handler moved; this assertion needs repointing");
    assert.equal(
      /rankHighlightRows\s*\(/.test(feed), false,
      "the following-feed is now ranked — if that is deliberate, the created_at cursor it derives " +
        "from the LAST row of the page has to be re-derived too, or the cursor skips rows",
    );
    assert.ok(
      /nextCursor/.test(feed),
      "the following-feed no longer has a cursor; the reason this surface is unranked has changed",
    );
  });

  /* ----------------------------------------------------------------------
   * Case 6 — the adapter, unit-level. `rankableFromRow` is where §12's
   * vocabulary meets eleven columns, and every one of these is a way to get
   * it silently wrong.
   * -------------------------------------------------------------------- */
  it("`rankableFromRow` keys what the row has and NOTHING it does not", () => {
    const r = rankableFromRow({
      id: A, created_at: at(10), owner_id: OWNER,
      location_name: "Blue Bottle", location_city: "Tokyo", pinned_at: null,
    });
    assert.equal(r.pinOrder, null, "an unpinned row must not be pinned at the epoch");
    assert.equal(r.diversityKeys?.person, OWNER);
    assert.equal(r.diversityKeys?.venue, "Blue Bottle", "the venue outranks the city when both exist");
    assert.equal(r.diversityKeys?.trip, null);
    assert.equal(r.diversityKeys?.activity, null);

    const city = rankableFromRow({ id: B, created_at: at(10), owner_id: OWNER, location_city: "Tokyo" });
    assert.equal(city.diversityKeys?.venue, "Tokyo", "the city is the coarsest honest venue stand-in");

    // A blank venue keys NOTHING. Keying "" would make every location-less
    // Highlight "the same venue" and defer all but one of them.
    const blank = rankableFromRow({ id: C1, created_at: at(10), owner_id: OWNER, location_name: "   " });
    assert.equal(blank.diversityKeys?.venue, null);

    // An unparseable pin is not a pin.
    const bad = rankableFromRow({ id: A, created_at: at(10), owner_id: OWNER, pinned_at: "not-a-date" });
    assert.equal(bad.pinOrder, null);
  });

  it("`rankHighlightRows` is a permutation — it reorders and never filters", () => {
    const rows = [
      { id: A, created_at: at(1), owner_id: OWNER, location_name: "X" },
      { id: B, created_at: at(2), owner_id: OWNER, location_name: "X" },
      { id: C1, created_at: at(3), owner_id: OWNER, location_name: "X" },
    ];
    // Every candidate repeats BOTH keys, so the diversity pass can satisfy
    // nothing. §12's own rule is that it emits anyway: a diversity constraint
    // that empties a feed is worse than a repetitive feed.
    const out = rankHighlightRows(rows, new Date(Date.parse("2026-09-20T12:00:00.000Z")));
    assert.equal(out.ordered.length, 3, "rows were dropped by a function that must only reorder");
    assert.deepEqual(out.ordered.map((r) => r.id).sort(), [A, B, C1].sort());
    assert.equal(out.pinnedCount, 0);
  });

  /* ----------------------------------------------------------------------
   * The case that makes "never filters" mean something, and the mutation
   * that showed it did not.
   *
   * `rankHighlightRows` reconciles its output against its input and appends
   * anything the round trip lost. Deleting that reconciliation left the suite
   * green, because ids normally round-trip and the loop never fires — so the
   * promise was untested and the function was one duplicate id away from
   * silently dropping a row a privacy filter had already cleared.
   *
   * A duplicate id is the case that fires it: the adapter keys rows by id in a
   * Map, so two rows sharing one id collapse to a single entry and the
   * unreconciled version returns a SHORTER page than it was given. Whether
   * this surface can produce a duplicate is not the point — the function
   * promises a permutation, and an unasserted promise is a comment.
   * -------------------------------------------------------------------- */
  it("…even when two rows share an id, which is the only way the round trip can lose one", () => {
    const rows = [
      { id: A, created_at: at(1), owner_id: OWNER, location_name: "X" },
      { id: A, created_at: at(2), owner_id: OTHER, location_name: "Y" },
      { id: B, created_at: at(3), owner_id: OWNER, location_name: "Z" },
    ];
    const out = rankHighlightRows(rows, new Date(Date.parse("2026-09-20T12:00:00.000Z")));
    assert.equal(out.ordered.length, 3, "rankHighlightRows returned fewer rows than it was handed");

    // The LENGTH is not the assertion, and that is the trap the mutation set.
    // Looking each ranked id back up in the Map returns the SAME row object
    // twice, so a page that has silently replaced one row with a duplicate of
    // another is still three long. Identity is what must be preserved: every
    // row handed in must come back, and `owner_id` is what tells these two
    // same-id rows apart.
    assert.deepEqual(
      out.ordered.map((r) => `${r.id}/${r.owner_id}`).sort(),
      rows.map((r) => `${r.id}/${r.owner_id}`).sort(),
      "a row was replaced by a duplicate of another: the page is the right LENGTH and the wrong " +
        "rows, and every row handed in had already passed the blocks, canViewHighlight, §11 and §10 gates",
    );
  });
});
