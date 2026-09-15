/**
 * Discovery diversity axes — the place and geography legs of DV-54.
 *
 * WHAT THESE TESTS ARE FOR
 * ========================
 * `diversify()` in lib/portavaRank.ts is a greedy MMR re-rank that, before this
 * file existed, compared exactly two keys across its sliding window:
 * `authorId` and `kind`. A page could therefore be twenty items about the SAME
 * PLACE, or twenty items from one neighbourhood, and the re-rank had nothing to
 * say about it — the creator and content-type axes passed while the place and
 * geography axes had no key at all.
 *
 * Two distinct failures are pinned here, and they rot in opposite directions:
 *
 *   1. The MECHANISM. `placePenalty` / `geoPenalty` must actually reorder when
 *      a value is supplied, must be guarded on the candidate's own key being
 *      present (so a page of candidates with no place id does not penalise
 *      itself for all sharing `null`), and must contribute NOTHING when no
 *      value is supplied. That last one is what makes this change safe to land
 *      ahead of the ruling on magnitudes: every existing surface keeps its
 *      exact ordering.
 *
 *   2. The KEY, and the one that is deliberately still MISSING. A penalty is
 *      inert without something to compare. `placeId` is already set on every
 *      Discovery candidate, so the place axis needs only a ruled magnitude.
 *      The geography axis needs a key as well: `neighborhood` is declared on
 *      `RankCandidate` and produced upstream by `osmNeighborhood()`, but
 *      lib/discoveryPde.ts does not carry it onto the candidate and this change
 *      does not make it.
 *
 * THAT OMISSION IS THE OWNER DECISION IN THIS CHANGE, and tests G1/G2 are what
 * hold it. Threading `neighborhood` is a one-line change, but it is not only a
 * diversity change: `scoreCandidate` computes
 * `f.neighborhoodMatch = cityHit && c.neighborhood ? w.neighborhoodMatch : 0`
 * at weight 0.2, and no call site in the tree sets `neighborhood`, so that
 * feature is a constant 0 on every surface. Discovery sets `city` on every
 * candidate, so `cityHit` is true for all of them and the feature would reduce
 * to "does this candidate carry a neighbourhood label at all" — a
 * data-completeness bonus rather than the geo-relevance match its name claims —
 * and it is not evenly available, because routes/discovery.ts maps a DB-backed
 * place's `neighborhood` column onto `address`. Threading the key would hand a
 * silent +0.2 to labelled OSM places over curated ones under the heading of a
 * diversity change. G1 pins that Discovery ordering is byte-identical to before
 * DV-54; G2 pins WHY the shortcut is refused, so whoever takes it later fails a
 * test that explains what else they just turned on.
 *
 * NOT PINNED HERE, and deliberately: `loadPdeViewer` in the same module holds
 * three supabase-js reads that destructure `data` and discard `error`. The
 * client RESOLVES on a database error, so the surrounding `try/catch` never
 * fires and a failed read is byte-identical to "no rows" — a viewer whose
 * follow graph 500s is ranked as following nobody and nothing in the returned
 * value says so. It is not fixed in this commit because the fix necessarily
 * rewrites the text of the follows read, and that text is quoted verbatim as
 * the evidence of a census row; repointing it is a census pass, not this lane.
 * The report for this change carries the finding and the shape of the fix.
 *
 * Runtime: node:test + node:assert/strict.
 * Run: node --import tsx/esm --test src/test/discoveryDiversityAxes.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  diversify, scoreCandidate, rankCandidates, DEFAULT_WEIGHTS,
  normaliseGeoLabel, neighborhoodMatches,
  type RankCandidate, type ViewerContext, type ScoredCandidate,
} from "../lib/portavaRank.js";
import { loadPdeViewer, rankForViewer, type PdePlace } from "../lib/discoveryPde.js";

const NOW = new Date("2026-09-15T12:00:00Z").getTime();
const ctx = (over: Partial<ViewerContext> = {}): ViewerContext => ({
  userId: "viewer-1", nowMs: NOW, ...over,
});

/**
 * A scored candidate with the score PINNED rather than computed.
 *
 * The subject here is the re-rank, not the scorer: pinning the score is what
 * makes "the penalty moved this item" a readable assertion instead of an
 * arithmetic coincidence of whatever DEFAULT_WEIGHTS happens to be today.
 */
function pinned(
  id: string, score: number, over: Partial<RankCandidate> = {},
): ScoredCandidate<RankCandidate> {
  const c: RankCandidate = { id, kind: "place", ...over };
  return { ...scoreCandidate(c, ctx()), score };
}

const ids = (out: ScoredCandidate<RankCandidate>[]) => out.map((s) => s.candidate.id);

/** Only the two new axes are under test — the two old ones are silenced. */
const ONLY_NEW = { authorPenalty: 0, kindPenalty: 0, window: 3 } as const;

// ── A–D. The mechanism, in lib/portavaRank.ts ────────────────────────────────

describe("diversify — place axis", () => {
  it("A. a supplied placePenalty breaks a same-place streak", () => {
    const scored = [
      pinned("hot-1", 1.00, { placeId: "p-hot" }),
      pinned("hot-2", 0.90, { placeId: "p-hot" }),
      pinned("cold",  0.80, { placeId: "p-cold" }),
    ];
    // 0.5 is chosen BY THIS TEST to exceed the 0.10 score gap it must overcome;
    // it is not a proposed production default. See the note on DiversityOptions.
    const out = diversify(scored, { ...ONLY_NEW, placePenalty: 0.5 });
    assert.deepEqual(ids(out), ["hot-1", "cold", "hot-2"],
      "the second item about the same place must yield to a different place");
  });

  it("B. candidates with NO place id do not penalise each other", () => {
    // Without a guard on the candidate's own key, `null === null` would make
    // every place-less candidate a repeat of every other one, and a penalty
    // applied uniformly to a whole page is not diversity — it is noise.
    const scored = [
      pinned("n-1", 1.00, { placeId: null }),
      pinned("n-2", 0.90, { placeId: null }),
      pinned("n-3", 0.80),
    ];
    const out = diversify(scored, { ...ONLY_NEW, placePenalty: 5 });
    assert.deepEqual(ids(out), ["n-1", "n-2", "n-3"],
      "an absent place key is not a shared place key");
  });
});

describe("diversify — geography axis", () => {
  it("C. a supplied geoPenalty breaks a same-neighbourhood streak", () => {
    const scored = [
      pinned("marais-1", 1.00, { neighborhood: "Le Marais" }),
      pinned("marais-2", 0.90, { neighborhood: "Le Marais" }),
      pinned("belleville", 0.80, { neighborhood: "Belleville" }),
    ];
    const out = diversify(scored, { ...ONLY_NEW, geoPenalty: 0.5 });
    assert.deepEqual(ids(out), ["marais-1", "belleville", "marais-2"],
      "the second item from the same neighbourhood must yield to another one");
  });

  it("D. candidates with NO neighbourhood do not penalise each other", () => {
    const scored = [
      pinned("u-1", 1.00, { neighborhood: null }),
      pinned("u-2", 0.90, { neighborhood: null }),
      pinned("u-3", 0.80),
    ];
    const out = diversify(scored, { ...ONLY_NEW, geoPenalty: 5 });
    assert.deepEqual(ids(out), ["u-1", "u-2", "u-3"],
      "an absent geography key is not a shared geography key");
  });
});

describe("diversify — the two PRE-EXISTING axes, now sharing one code path", () => {
  // These pin behaviour that already worked, and they are here because nothing
  // else pinned it. Deleting the creator comparison outright, or zeroing either
  // inherited default, left `portavaRank.test.ts`, `discoveryPde.test.ts` and
  // the rest of this file entirely green — the existing author-streak test
  // asserts only that the quiet author appears somewhere in the first three,
  // which a four-candidate fixture satisfies on recency alone. DV-54 records
  // creator and content type as PASS, and until now that was a reading of the
  // source rather than of a test.
  //
  // That gap matters more after this change than before it: both axes moved
  // into the shared `repetitionPenalty`, so a mistake there now silently
  // degrades two axes the census already counts as passing.
  it("H. the creator axis breaks an author streak on its INHERITED default", () => {
    const scored = [
      pinned("loud-1", 1.00, { authorId: "loud" }),
      pinned("loud-2", 0.90, { authorId: "loud" }),
      pinned("quiet",  0.80, { authorId: "quiet" }),
    ];
    // authorPenalty deliberately NOT passed: 0.35 is the value under test.
    const out = diversify(scored, { kindPenalty: 0 });
    assert.deepEqual(ids(out), ["loud-1", "quiet", "loud-2"],
      "the inherited authorPenalty must still displace a second same-author pick");
  });

  it("I. the content-type axis breaks a kind streak on its INHERITED default", () => {
    const scored = [
      pinned("place-1", 1.00),
      pinned("place-2", 0.90),
      pinned("post-1",  0.80, { kind: "post" }),
    ];
    // kindPenalty deliberately NOT passed: 0.15 is the value under test.
    const out = diversify(scored, { authorPenalty: 0 });
    assert.deepEqual(ids(out), ["place-1", "post-1", "place-2"],
      "the inherited kindPenalty must still displace a second same-kind pick");
  });

  it("J. candidates with NO authorId do not penalise each other", () => {
    // The creator counterpart of B and D, and likewise previously unpinned:
    // deleting `c.authorId &&` from the creator clause left every suite green.
    // The fixture is deliberately MIXED — two authorless candidates and one
    // with an author — because a penalty every candidate incurs equally cannot
    // reorder anything, so a uniformly authorless fixture would pass with the
    // guard gone and prove nothing.
    const scored = [
      pinned("anon-1", 1.00),
      pinned("anon-2", 0.90),
      pinned("named",  0.80, { authorId: "x" }),
    ];
    const out = diversify(scored, { authorPenalty: 5, kindPenalty: 0 });
    assert.deepEqual(ids(out), ["anon-1", "anon-2", "named"],
      "an absent author key is not a shared author key");
  });
});

describe("diversify — the new axes are inert until a value is supplied", () => {
  // The fixtures below deliberately do NOT share the key across every
  // candidate. A penalty that every candidate incurs equally cannot reorder
  // anything, so a uniform fixture would pass against ANY default and prove
  // nothing — it would report a green that a fabricated 0.35 survives.
  it("E1. omitting placePenalty leaves the order untouched", () => {
    // This is the property that lets the mechanism land before the magnitudes
    // are ruled: every caller in the tree passes neither option today, so every
    // caller in the tree must get byte-identical ordering. If a default is ever
    // introduced, this test is the thing that must be argued with first.
    const scored = [
      pinned("hot-1", 1.00, { placeId: "p-hot" }),
      pinned("hot-2", 0.90, { placeId: "p-hot" }),
      pinned("cold",  0.80, { placeId: "p-cold" }),
    ];
    const out = diversify(scored, { authorPenalty: 0, kindPenalty: 0 });
    assert.deepEqual(ids(out), ["hot-1", "hot-2", "cold"],
      "an unsupplied placePenalty must contribute exactly zero");
  });

  it("E2. omitting geoPenalty leaves the order untouched", () => {
    const scored = [
      pinned("marais-1", 1.00, { neighborhood: "Le Marais" }),
      pinned("marais-2", 0.90, { neighborhood: "Le Marais" }),
      pinned("belleville", 0.80, { neighborhood: "Belleville" }),
    ];
    const out = diversify(scored, { authorPenalty: 0, kindPenalty: 0 });
    assert.deepEqual(ids(out), ["marais-1", "marais-2", "belleville"],
      "an unsupplied geoPenalty must contribute exactly zero");
  });
});


// ── N. The geography KEY, and what threading it turned on ────────────────────
//
// These replace the two tests (G1/G2) that used to pin the key as WITHHELD.
// They are the anti-regression for the defect that withholding was protecting
// against, and they must BITE: re-introduce
//
//     f.neighborhoodMatch = cityHit && c.neighborhood ? w.neighborhoodMatch : 0
//
// and N2, N3, N5 and N8 fail. That mutation was run against this file before it
// was committed; the commit message records the result.

const VIEWER = {
  userId:       "u-1",
  city:         "paris",
  followedIds:  new Set<string>(),
  interestTags: new Set<string>(),
};

/** Reads resolve with rows and no error; writes are swallowed. */
function quietClient(): any {
  const q: any = {
    select: () => q, eq: () => q, in: () => q, gte: () => q, lte: () => q,
    neq: () => q, order: () => q, limit: () => q,
    maybeSingle: async () => ({ data: null, error: null }),
    single: async () => ({ data: null, error: null }),
    insert: () => q, upsert: () => q, update: () => q, delete: () => q,
    then: (res: any) => Promise.resolve({ data: [], error: null }).then(res),
  };
  return { from: () => q };
}

const place = (id: string, over: Partial<PdePlace> = {}): PdePlace => ({
  id, category: "food", distanceKm: 1, savedCount: 3, tags: [],
  rating: 4, lat: 48.85, lng: 2.35, ...over,
});

/** The feature value one candidate earns from neighborhoodMatch, nothing else. */
const hoodFeature = (c: Partial<RankCandidate>, viewer: Partial<ViewerContext>): number =>
  scoreCandidate({ id: "x", kind: "place", ...c }, ctx(viewer)).features.neighborhoodMatch;

describe("scoreCandidate — neighborhoodMatch is a COMPARISON, not a label", () => {
  it("N1. a candidate whose neighbourhood matches the viewer's earns the credit", () => {
    assert.equal(
      hoodFeature({ city: "paris", neighborhood: "Le Marais" },
                  { city: "paris", neighborhood: "Le Marais" }),
      DEFAULT_WEIGHTS.neighborhoodMatch,
    );
  });

  it("N2. a candidate with a DIFFERENT neighbourhood earns ZERO", () => {
    // THE ANTI-REGRESSION FOR THE ORIGINAL DEFECT. Under the old expression
    // this candidate scored the full 0.2: `cityHit` was true and the label was
    // truthy, and nothing ever compared the two strings.
    assert.equal(
      hoodFeature({ city: "paris", neighborhood: "Belleville" },
                  { city: "paris", neighborhood: "Le Marais" }),
      0,
    );
  });

  it("N3. a candidate with a label and NO viewer neighbourhood earns ZERO", () => {
    // The other half of the same defect, and the one that describes production
    // today: no viewer had a neighbourhood at all, so every labelled candidate
    // was collecting a data-completeness bonus.
    assert.equal(hoodFeature({ city: "paris", neighborhood: "Le Marais" }, { city: "paris" }), 0);
    assert.equal(
      hoodFeature({ city: "paris", neighborhood: "Le Marais" },
                  { city: "paris", neighborhood: null }),
      0,
    );
  });

  it("N4. comparison is normalised — case, whitespace and diacritics", () => {
    const w = DEFAULT_WEIGHTS.neighborhoodMatch;
    // The two sides come from different producers (an OSM mapper's `addr:suburb`
    // tag and a curator's `places.neighborhood` column), so exact equality is a
    // comparison that quietly never fires.
    assert.equal(hoodFeature({ city: "paris", neighborhood: "le marais" },
                             { city: "paris", neighborhood: "Le Marais" }), w);
    assert.equal(hoodFeature({ city: "paris", neighborhood: "  LE   MARAIS " },
                             { city: "paris", neighborhood: "Le Marais" }), w);
    assert.equal(hoodFeature({ city: "paris", neighborhood: "Quartier Latin" },
                             { city: "paris", neighborhood: "Quartier Latín" }), w);
    // …and normalising must not collapse two genuinely different labels.
    assert.equal(hoodFeature({ city: "paris", neighborhood: "Le Marais" },
                             { city: "paris", neighborhood: "Les Halles" }), 0);
  });

  it("N5. the cityMatch guard is kept — a homonym in another city earns ZERO", () => {
    // "Chinatown", "Old Town" and "Centro" name a different place in every city
    // that has one. Without the city term a San Francisco viewer would collect
    // this credit in Bangkok.
    assert.equal(
      hoodFeature({ city: "bangkok", neighborhood: "Chinatown" },
                  { city: "san francisco", neighborhood: "Chinatown" }),
      0,
    );
    assert.equal(
      hoodFeature({ city: "san francisco", neighborhood: "Chinatown" },
                  { city: "san francisco", neighborhood: "Chinatown" }),
      DEFAULT_WEIGHTS.neighborhoodMatch,
    );
  });

  it("N6. an EMPTY label is not a key — two blank labels do not match", () => {
    assert.equal(hoodFeature({ city: "paris", neighborhood: "   " },
                             { city: "paris", neighborhood: "   " }), 0);
    assert.equal(hoodFeature({ city: "paris", neighborhood: null },
                             { city: "paris", neighborhood: null }), 0);
  });

  it("N7. the weight is non-zero — the guard on every assertion above", () => {
    // Without this, zeroing `neighborhoodMatch` would turn the whole section
    // green by killing the feature, which is the vacuous pass this file exists
    // to refuse.
    assert.ok(DEFAULT_WEIGHTS.neighborhoodMatch > 0,
      "neighborhoodMatch must carry a positive weight or this suite proves nothing");
  });
});

describe("the 0.2 weight VERIFIED — it reorders, and it is sized where the comment says", () => {
  // The chosen magnitude is documented at the end of lib/portavaRank.ts: below
  // cityMatch 0.45 and the taste terms, ABOVE verifiedBonus 0.15. This pair of
  // assertions is the check on that claim rather than a restatement of it: the
  // fixture is rigged so that ONLY a contribution strictly between 0.15 and
  // 0.45 produces both orderings.
  const marais = (): RankCandidate =>
    ({ id: "marais", kind: "place", city: "paris", neighborhood: "Le Marais" });
  const belleville = (): RankCandidate =>
    ({ id: "belleville", kind: "place", city: "paris", neighborhood: "Belleville", verified: true });
  const order = (viewer: Partial<ViewerContext>) =>
    rankCandidates([marais(), belleville()], ctx({ city: "paris", ...viewer }),
      { diversity: false, exploration: false }).map((s) => s.candidate.id);

  it("N8. a matching candidate overtakes a better-scoring non-matching one", () => {
    // belleville carries verifiedBonus 0.15 and marais carries nothing else, so
    // marais can only lead if neighborhoodMatch is worth MORE than 0.15.
    assert.deepEqual(order({ neighborhood: "Le Marais" }), ["marais", "belleville"]);
  });

  it("N9. …and the SAME fixture orders the other way when nothing matches", () => {
    // The control that makes N8 an effect rather than a coincidence: strip the
    // viewer's neighbourhood and the 0.15 verified bonus decides again.
    assert.deepEqual(order({}), ["belleville", "marais"]);
    assert.deepEqual(order({ neighborhood: "Belleville" }), ["belleville", "marais"]);
  });
});

describe("normaliseGeoLabel / neighborhoodMatches", () => {
  it("N10. absent is never a key, and never a match", () => {
    assert.equal(normaliseGeoLabel(null), "");
    assert.equal(normaliseGeoLabel(undefined), "");
    assert.equal(normaliseGeoLabel("  \u00a0 "), "");
    assert.equal(normaliseGeoLabel(123 as any), "");
    assert.equal(neighborhoodMatches(null, null), false);
    assert.equal(neighborhoodMatches("", ""), false);
    assert.equal(neighborhoodMatches("Le Marais", null), false);
    assert.equal(neighborhoodMatches("Le Marais", "le  marais"), true);
  });
});

// ── P. Cross-source comparability, in lib/discoveryPde.ts ───────────────────

describe("discoveryPde — the key is threaded, and BOTH sources can earn it", () => {
  const withHood = (id: string, hood: string): PdePlace => ({ ...place(id), neighborhood: hood });

  it("P1. a DB-backed place earns EXACTLY what an OSM place earns", async () => {
    // THE CROSS-SOURCE ASSERTION. routes/discovery.ts used to map a DB-backed
    // place's `neighborhood` column onto `address` and nowhere else, so a
    // curated place could not earn this credit at any weight while a labelled
    // OSM place always could. That asymmetry is the reason the key was withheld
    // rather than threaded, and this is the test that says it is gone.
    const viewer = { ...VIEWER, neighborhood: "Le Marais" };
    const out = await rankForViewer(
      [withHood("osm/node/1", "Le Marais"), withHood("db/abc", "le marais"),
       withHood("osm/node/2", "Belleville"), place("db/def")],
      viewer, { sc: quietClient(), served: false },
    );

    const f = (id: string) => out.scoredById.get(id)?.features.neighborhoodMatch;
    assert.equal(f("osm/node/1"), DEFAULT_WEIGHTS.neighborhoodMatch);
    assert.equal(f("db/abc"), DEFAULT_WEIGHTS.neighborhoodMatch,
      "a curated place with the same neighbourhood must earn the same credit as an OSM one");
    assert.equal(f("osm/node/1"), f("db/abc"), "the two sources must be comparable inputs");
    assert.equal(f("osm/node/2"), 0, "a label that does not match the viewer earns nothing");
    assert.equal(f("db/def"), 0, "no label, no credit");
  });

  it("P2. with no viewer neighbourhood, a labelled page earns nothing at all", async () => {
    // This is the pre-DV-54 ordering, and it is what every viewer with no
    // curated place-view history still gets: threading the key did not hand a
    // silent bonus to labelled rows.
    const out = await rankForViewer(
      [withHood("osm/node/1", "Le Marais"), withHood("db/abc", "Belleville"), place("osm/node/2")],
      VIEWER, { sc: quietClient(), served: false },
    );
    assert.ok(DEFAULT_WEIGHTS.neighborhoodMatch > 0,
      "guard on the guard: if the weight were 0 this test would pass vacuously");
    for (const id of ["osm/node/1", "db/abc", "osm/node/2"]) {
      assert.equal(out.scoredById.get(id)?.features.neighborhoodMatch, 0, id);
    }
  });

  it("P3. the label reaches the candidate, so the geography diversity axis has a key", async () => {
    const out = await rankForViewer(
      [withHood("osm/node/1", "Le Marais"), place("osm/node/2")],
      VIEWER, { sc: quietClient(), served: false },
    );
    assert.equal(out.scoredById.get("osm/node/1")?.candidate.neighborhood, "Le Marais");
    assert.equal(out.scoredById.get("osm/node/2")?.candidate.neighborhood, null);
  });
});

describe("routes/discovery.ts — the DB-backed mappings carry the key, not just `address`", () => {
  // P1 proves the RANKER treats the two sources alike once both carry a label.
  // It cannot prove that a curated row still carries one, because it feeds
  // `PdePlace` fixtures straight to the engine — and the original defect lived
  // upstream of the engine, in the route that built those objects. Deleting
  // `neighborhood:` from both DB mappings leaves every assertion in P1 green.
  //
  // So this reads the route. A shape assertion over source text is a blunt
  // instrument and is used here for the one thing it is right for: the mapping
  // is an object literal inside a `.map()` with no seam to call, and the defect
  // it guards is precisely "the column went to `address` and nowhere else".
  const SRC = readFileSync(
    new URL("../routes/discovery.ts", import.meta.url), "utf8",
  );

  it("P4. every mapping that writes row.neighborhood onto `address` also writes it onto `neighborhood`", () => {
    const addressLines = SRC.split("\n")
      .map((l, i) => [i + 1, l] as const)
      .filter(([, l]) => /^\s*address:\s*\(row\.neighborhood/.test(l));

    assert.ok(addressLines.length >= 2,
      "expected both DB-backed mappings (queryDbPlaces and the canonical-places query); " +
      `found ${addressLines.length} — if a mapping moved, this test must follow it, not be deleted`);

    for (const [lineNo, line] of addressLines) {
      assert.match(line, /neighborhood:\s*\(row\.neighborhood\s*\?\?\s*null\)/,
        `routes/discovery.ts:${lineNo} maps the places.neighborhood column onto \`address\` ` +
        "without also carrying it as the ranker's geography key, which is the asymmetry " +
        "DV-54 closed: a curated place could never earn neighborhoodMatch while a labelled " +
        "OSM place always could. See the note at the end of lib/discoveryPde.ts.");
    }
  });

  it("P5. the OSM mapping still produces one, so the two sources stay comparable", () => {
    assert.match(SRC, /neighborhood:\s*osmNeighborhood\(tags\)/,
      "the OSM half of the comparison is the other input P4 is about");
  });
});

// ── Q. The viewer half, and the reads that used to fail silently ────────────

/**
 * A client whose per-table behaviour is scripted.
 *
 * `plan` is consulted with the table name and the `.eq()` filters the caller
 * stacked, because `loadPdeViewer` reads `rank_events` twice with different
 * filters (the 24h discovery-surface seen set, and the 30d place_view set) and
 * a mock that cannot tell them apart would prove nothing about either.
 */
function scriptedClient(
  plan: (table: string, eqs: Record<string, unknown>) => { data: any; error: any },
): any {
  const make = (table: string) => {
    const eqs: Record<string, unknown> = {};
    const q: any = {
      select: () => q, in: () => q, gte: () => q, lte: () => q, neq: () => q,
      order: () => q, limit: () => q,
      eq: (k: string, v: unknown) => { eqs[k] = v; return q; },
      maybeSingle: async () => plan(table, eqs),
      single: async () => plan(table, eqs),
      insert: () => q, upsert: () => q, update: () => q, delete: () => q,
      then: (res: any) => Promise.resolve(plan(table, eqs)).then(res),
    };
    return q;
  };
  return { from: (table: string) => make(table) };
}

const EMPTY = { data: [], error: null };

describe("loadPdeViewer — the viewer neighbourhood is DERIVED from place-view history", () => {
  it("Q1. the most-viewed neighbourhood wins, weighted by views", async () => {
    const viewer = await loadPdeViewer(scriptedClient((table, eqs) => {
      if (table === "rank_events" && eqs.event_type === "place_view") {
        return { data: [
          { item_id: "db/p1" }, { item_id: "db/p2" }, { item_id: "db/p2" },
          { item_id: "db/p3" }, { item_id: "osm/node/9" },
        ], error: null };
      }
      if (table === "places") {
        return { data: [
          { id: "p1", neighborhood: "Le Marais" },
          { id: "p2", neighborhood: "Belleville" },
          { id: "p3", neighborhood: "belleville" },   // same key, different spelling
        ], error: null };
      }
      if (table === "compass_user_preferences") return { data: null, error: null };
      return EMPTY;
    }), "u-1", "paris");

    // Belleville: 2 views of p2 + 1 of p3 = 3. Le Marais: 1. Case-folded to one key.
    assert.equal(normaliseGeoLabel(viewer.neighborhood), "belleville");
    assert.deepEqual(viewer.degraded, []);
  });

  it("Q2. no curated place-view history ⇒ null, and NO extra round trip", async () => {
    let placesReads = 0;
    const viewer = await loadPdeViewer(scriptedClient((table) => {
      if (table === "places") { placesReads += 1; return EMPTY; }
      if (table === "compass_user_preferences") return { data: null, error: null };
      return EMPTY;
    }), "u-1", "paris");
    assert.equal(viewer.neighborhood, null);
    assert.equal(placesReads, 0, "a viewer with no db/ place-view history must not be looked up");
  });
});

describe("loadPdeViewer — a failed read is no longer spelled 'no rows'", () => {
  // THE DEFECT: supabase-js RESOLVES on a database error. The three reads below
  // destructured `data` and discarded `error`, so the surrounding try/catch
  // never fired on the case it was written for and a 500 was byte-identical to
  // an empty table — a viewer whose follow graph failed was ranked as following
  // nobody and nothing said so.
  const boom = { data: null, error: { message: "boom", code: "500" } };

  it("Q3. a failed follows read is REPORTED, and still non-fatal", async () => {
    const viewer = await loadPdeViewer(scriptedClient((table) =>
      table === "user_follows" ? boom
        : table === "compass_user_preferences" ? { data: null, error: null } : EMPTY,
    ), "u-1", "paris");
    assert.deepEqual([...viewer.followedIds], [], "degraded, not broken");
    assert.ok(viewer.degraded?.includes("follows"),
      "a viewer ranked as following nobody because the read FAILED must be distinguishable " +
      "from one who follows nobody");
  });

  it("Q4. a failed preferences read is REPORTED, and does not fabricate a taste profile", async () => {
    const viewer = await loadPdeViewer(scriptedClient((table) =>
      table === "compass_user_preferences" ? boom : EMPTY,
    ), "u-1", "paris");
    assert.deepEqual([...viewer.interestTags], []);
    assert.equal(viewer.categoryAffinities, undefined);
    assert.ok(viewer.degraded?.includes("preferences"));
    assert.equal(viewer.degraded?.filter((d) => d === "preferences").length, 1,
      "the preferences error is consulted twice and must be reported once");
  });

  it("Q5. a failed seen-history read is REPORTED", async () => {
    const viewer = await loadPdeViewer(scriptedClient((table, eqs) =>
      table === "rank_events" && eqs.surface === "discovery" ? boom
        : table === "compass_user_preferences" ? { data: null, error: null } : EMPTY,
    ), "u-1", "paris");
    assert.deepEqual([...(viewer.seenIds ?? [])], []);
    assert.ok(viewer.degraded?.includes("seen"));
  });

  it("Q6. a failed neighbourhood lookup is REPORTED rather than read as 'no neighbourhood'", async () => {
    const viewer = await loadPdeViewer(scriptedClient((table, eqs) => {
      if (table === "rank_events" && eqs.event_type === "place_view") {
        return { data: [{ item_id: "db/p1" }], error: null };
      }
      if (table === "places") return boom;
      if (table === "compass_user_preferences") return { data: null, error: null };
      return EMPTY;
    }), "u-1", "paris");
    assert.equal(viewer.neighborhood, null);
    assert.ok(viewer.degraded?.includes("viewer_neighborhood"));
  });

  it("Q7. every read succeeding reports NOTHING — the guard on Q3–Q6", async () => {
    // Without this, a `degraded` array that was unconditionally populated would
    // satisfy all four tests above and mean nothing.
    const viewer = await loadPdeViewer(scriptedClient((table) =>
      table === "compass_user_preferences" ? { data: null, error: null } : EMPTY,
    ), "u-1", "paris");
    assert.deepEqual(viewer.degraded, []);
  });
});
