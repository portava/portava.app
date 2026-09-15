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
import {
  diversify, scoreCandidate, DEFAULT_WEIGHTS,
  type RankCandidate, type ViewerContext, type ScoredCandidate,
} from "../lib/portavaRank.js";
import { rankForViewer, type PdePlace } from "../lib/discoveryPde.js";

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

// ── G. The key that is withheld, in lib/discoveryPde.ts ─────────────────────

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

describe("discoveryPde — the geography key is WITHHELD, and the score feature stays dead", () => {
  // `neighborhood` is not on `PdePlace` — this change does not add it — so the
  // fixture carries it as an extra upstream property, which is exactly the
  // shape routes/discovery.ts hands this module for an OSM place with an
  // `addr:suburb` tag. The point of both tests is that it goes nowhere.
  const withHood = (id: string, hood: string): PdePlace =>
    ({ ...place(id), neighborhood: hood } as PdePlace & { neighborhood: string });

  it("G1. a labelled place reaches the ranker with NO neighborhood key", async () => {
    const input = [withHood("osm/node/1", "Le Marais"), place("osm/node/2")];
    const out = await rankForViewer(input, VIEWER, { sc: quietClient(), served: false });

    assert.equal(out.scoredById.get("osm/node/1")?.candidate.neighborhood, undefined,
      "threading this key is an owner decision, not a lane — see the note at " +
      "the end of lib/discoveryPde.ts before changing this assertion");
    assert.equal(out.scoredById.get("osm/node/2")?.candidate.neighborhood, undefined);
  });

  it("G2. and so the neighborhoodMatch weight stays a constant 0 on this surface", async () => {
    // This is the assertion that makes the decision enforceable rather than a
    // comment. `DEFAULT_WEIGHTS.neighborhoodMatch` is 0.2 and `cityHit` is true
    // for every candidate here (the module sets `city: viewer.city` on all of
    // them), so the ONLY thing keeping this feature at 0 is the absent key.
    const input = [withHood("osm/node/1", "Le Marais"), place("db/abc"), place("osm/node/2")];
    const out = await rankForViewer(input, VIEWER, { sc: quietClient(), served: false });

    assert.ok(DEFAULT_WEIGHTS.neighborhoodMatch > 0,
      "guard on the guard: if the weight were 0 this test would pass vacuously");
    for (const id of ["osm/node/1", "db/abc", "osm/node/2"]) {
      assert.equal(out.scoredById.get(id)?.features.neighborhoodMatch, 0,
        `${id} must earn nothing from neighborhoodMatch — a non-zero here means ` +
        "someone threaded the key and changed Discovery scoring, not just its diversity");
    }
  });
});
