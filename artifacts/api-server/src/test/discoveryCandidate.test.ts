/**
 * discoveryCandidate — the server-built DiscoveryCandidate projection
 * (Sensing §8:135, §5.1; census-discovery A03 / A25).
 *
 * What is pinned, and why each one is a defect if it fails:
 *   A. whyNow is null, always — a manufactured why-now is the §5.1 rendering
 *      of prediction as observation.
 *   B. truth class is derived from the row's own facts and nothing else.
 *   C. confidence is the class prior and moves for no other reason.
 *   D. freshness is the serve point plus the entry's age; unknown stays unknown.
 *   E. whyForUser is the ranker's own positive features, capped, and EMPTY when
 *      no ranker ran — never inferred from anything else.
 *   F. Flag OFF ⇒ the route helper returns the SAME array reference (byte-
 *      identical serve); flag ON ⇒ a new array carrying `candidate`.
 *   G. The Map-facing reader ranks with served:false and reports the writes it
 *      suppressed; an anonymous viewer gets no per-user ranking.
 *   H. Source guard: all four GET /discovery serialisation sites pass through
 *      withDiscoveryCandidates, and the projection is never written to a cache.
 *
 * Run: node --import tsx/esm --test src/test/discoveryCandidate.test.ts
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  projectDiscoveryCandidate,
  classifyTruth,
  classifyFreshness,
  whyForUserFromFeatures,
  withDiscoveryCandidates,
  readDiscoveryCandidatesForViewer,
  invalidateCandidateProjectionFlagCache,
  CONFIDENCE_PRIOR,
  DISCOVERY_CANDIDATE_PROJECTION_FLAG,
  type CandidateServeContext,
} from "../lib/discoveryCandidate.js";
import type { ScoredCandidate, RankCandidate } from "../lib/portavaRank.js";

const NOW = 1_800_000_000_000;

function scored(id: string, features: Record<string, number>): ScoredCandidate<RankCandidate> {
  return { candidate: { id, kind: "place" } as RankCandidate, score: 1, features };
}

function ctx(over: Partial<CandidateServeContext> = {}): CandidateServeContext {
  return { cacheLevel: "L1", cachedAt: NOW - 60_000, scoredById: null, rankedBy: "none", nowMs: NOW, ...over };
}

/** A flag client that answers one flag and, optionally, errors on every read. */
function flagClient(flags: Record<string, boolean>, opts: { error?: boolean } = {}) {
  const reads: string[] = [];
  const sc: any = {
    from: (_t: string) => ({
      select: () => ({
        eq: (_c: string, flag: string) => ({
          maybeSingle: async () => {
            reads.push(flag);
            if (opts.error) return { data: null, error: { message: "simulated DB error" } };
            return { data: flag in flags ? { enabled: flags[flag] } : null, error: null };
          },
        }),
      }),
    }),
  };
  return { sc, reads };
}

describe("A. whyNow", () => {
  it("is null for every row, on every serve point, ranked or not", () => {
    for (const cacheLevel of ["L1", "L2_fresh", "L2_stale", "miss", "compass_candidate_hit", "compass_fresh_rank"]) {
      for (const row of [{ id: "node/1" }, { id: "db/x" }, { id: "db/y", canonicalPlaceId: "p" }, { id: "???" }]) {
        const c = projectDiscoveryCandidate(row, ctx({ cacheLevel, scoredById: new Map([[row.id, scored(row.id, { recency: 0.9 })]]), rankedBy: "pde" }));
        assert.equal(c.whyNow, null, `${cacheLevel} ${row.id}`);
      }
    }
  });
});

describe("B. truth class", () => {
  it("canonical public.places row → corroborated", () => {
    assert.equal(classifyTruth({ id: "db/1", canonicalPlaceId: "uuid" }, "L1"), "corroborated");
  });
  it("community discovery_places row → observed", () => {
    assert.equal(classifyTruth({ id: "db/1" }, "L1"), "observed");
  });
  it("OSM row → observed; with a Wikidata id → corroborated (second source)", () => {
    assert.equal(classifyTruth({ id: "node/4089438971" }, "miss"), "observed");
    assert.equal(classifyTruth({ id: "way/12" }, "miss"), "observed");
    assert.equal(classifyTruth({ id: "relation/7", wikidataId: "Q42" }, "miss"), "corroborated");
  });
  it("a stale cache serve is STALE whatever the row is — the observation is real, its age is the claim", () => {
    assert.equal(classifyTruth({ id: "db/1", canonicalPlaceId: "uuid", wikidataId: "Q1" }, "L2_stale"), "stale");
  });
  it("an unrecognised id shape → unknown, never guessed upward", () => {
    assert.equal(classifyTruth({ id: "fsq:abc" }, "L1"), "unknown");
    assert.equal(classifyTruth({ id: "" }, "L1"), "unknown");
  });
  it("never emits inferred / predicted / conflicting — there is no producer for them", () => {
    const seen = new Set<string>();
    for (const cacheLevel of ["L1", "L2_fresh", "L2_stale", "miss", "x"]) {
      for (const row of [{ id: "node/1" }, { id: "node/1", wikidataId: "Q1" }, { id: "db/1" }, { id: "db/1", canonicalPlaceId: "c" }, { id: "zzz" }]) {
        seen.add(classifyTruth(row, cacheLevel));
      }
    }
    for (const forbidden of ["inferred", "predicted", "conflicting"]) assert.ok(!seen.has(forbidden), forbidden);
  });
});

describe("C. confidence", () => {
  it("is exactly the class prior", () => {
    assert.equal(projectDiscoveryCandidate({ id: "db/1", canonicalPlaceId: "c" }, ctx()).confidence, CONFIDENCE_PRIOR.corroborated);
    assert.equal(projectDiscoveryCandidate({ id: "db/1" }, ctx()).confidence, CONFIDENCE_PRIOR.observed);
    assert.equal(projectDiscoveryCandidate({ id: "db/1" }, ctx({ cacheLevel: "L2_stale" })).confidence, CONFIDENCE_PRIOR.stale);
    assert.equal(projectDiscoveryCandidate({ id: "??" }, ctx()).confidence, CONFIDENCE_PRIOR.unknown);
  });
  it("does not move with ranking — a ranker score is relevance, not truth", () => {
    const a = projectDiscoveryCandidate({ id: "db/1" }, ctx());
    const b = projectDiscoveryCandidate({ id: "db/1" }, ctx({ scoredById: new Map([["db/1", scored("db/1", { categoryAffinity: 5 })]]), rankedBy: "pde" }));
    assert.equal(a.confidence, b.confidence);
  });
  it("priors are monotone in evidence and inside [0,1]", () => {
    const { corroborated, observed, stale, unknown } = CONFIDENCE_PRIOR;
    assert.ok(corroborated > observed && observed > stale && stale > unknown);
    for (const v of Object.values(CONFIDENCE_PRIOR)) assert.ok(v >= 0 && v <= 1);
  });
});

describe("D. freshness", () => {
  it("L1 / L2_fresh / miss / compass_fresh_rank are fresh; L2_stale is stale; anything else is unknown", () => {
    assert.equal(classifyFreshness("L1", NOW, NOW).state, "fresh");
    assert.equal(classifyFreshness("L2_fresh", NOW, NOW).state, "fresh");
    assert.equal(classifyFreshness("miss", NOW, NOW).state, "fresh");
    assert.equal(classifyFreshness("compass_fresh_rank", NOW, NOW).state, "fresh");
    assert.equal(classifyFreshness("L2_stale", NOW, NOW).state, "stale");
    assert.equal(classifyFreshness("compass_candidate_hit", null, NOW).state, "unknown");
  });
  it("ageMs is the entry's age, floored at zero, and null when the serve point does not know", () => {
    assert.equal(classifyFreshness("L1", NOW - 5_000, NOW).ageMs, 5_000);
    assert.equal(classifyFreshness("L1", NOW + 5_000, NOW).ageMs, 0);
    assert.equal(classifyFreshness("compass_candidate_hit", null, NOW).ageMs, null);
  });
  it("servedFrom is the route's label verbatim", () => {
    assert.equal(classifyFreshness("L2_stale", NOW, NOW).servedFrom, "L2_stale");
  });
});

describe("E. whyForUser", () => {
  it("is the ranker's positive features, strongest first, at most three", () => {
    assert.deepEqual(
      whyForUserFromFeatures({ distance: 0.2, categoryAffinity: 0.9, seenPenalty: -0.5, followedAuthor: 0.4, recency: 0.3, kindPrior: 0 }),
      ["categoryAffinity", "followedAuthor", "recency"],
    );
  });
  it("omits zero and negative contributions rather than sign-flipping them into a different claim", () => {
    assert.deepEqual(whyForUserFromFeatures({ seenPenalty: -1, kindPrior: 0 }), []);
  });
  it("ties break by name so the list is deterministic", () => {
    assert.deepEqual(whyForUserFromFeatures({ b: 1, a: 1, c: 1, d: 1 }), ["a", "b", "c"]);
  });
  it("is EMPTY with rankedBy none or compass even when a score map is present — the list is only ever PDE's own vocabulary", () => {
    const m = new Map([["db/1", scored("db/1", { categoryAffinity: 1 })]]);
    assert.deepEqual(projectDiscoveryCandidate({ id: "db/1" }, ctx({ scoredById: m, rankedBy: "none" })).whyForUser, []);
    assert.deepEqual(projectDiscoveryCandidate({ id: "db/1" }, ctx({ scoredById: m, rankedBy: "compass" })).whyForUser, []);
    assert.deepEqual(projectDiscoveryCandidate({ id: "db/1" }, ctx({ scoredById: m, rankedBy: "pde" })).whyForUser, ["categoryAffinity"]);
  });
  it("is EMPTY for a row the ranker did not score", () => {
    const m = new Map([["db/other", scored("db/other", { categoryAffinity: 1 })]]);
    const c = projectDiscoveryCandidate({ id: "db/1" }, ctx({ scoredById: m, rankedBy: "pde" }));
    assert.deepEqual(c.whyForUser, []);
    assert.equal(c.rankedBy, "pde");
  });
});

describe("F. withDiscoveryCandidates — inert until seeded ON", () => {
  beforeEach(() => invalidateCandidateProjectionFlagCache());
  const places = [{ id: "node/1", name: "A" }, { id: "db/2", name: "B" }];

  it("flag ABSENT: returns the very same array — nothing copied, nothing added", async () => {
    const { sc } = flagClient({});
    const out = await withDiscoveryCandidates(sc, places, ctx());
    assert.equal(out, places, "must be the same reference, not an equal copy");
    assert.ok(!("candidate" in out[0]));
  });
  it("flag FALSE: same", async () => {
    const { sc } = flagClient({ [DISCOVERY_CANDIDATE_PROJECTION_FLAG]: false });
    assert.equal(await withDiscoveryCandidates(sc, places, ctx()), places);
  });
  it("flag UNREADABLE: same (capability polarity — an unreadable flag is OFF)", async () => {
    const { sc } = flagClient({ [DISCOVERY_CANDIDATE_PROJECTION_FLAG]: true }, { error: true });
    assert.equal(await withDiscoveryCandidates(sc, places, ctx()), places);
  });
  it("a client that THROWS: same, and nothing propagates into the feed", async () => {
    const sc: any = { from: () => { throw new Error("boom"); } };
    assert.equal(await withDiscoveryCandidates(sc, places, ctx()), places);
  });
  it("flag ON: a NEW array whose rows carry `candidate`, input untouched", async () => {
    const { sc } = flagClient({ [DISCOVERY_CANDIDATE_PROJECTION_FLAG]: true });
    const out = await withDiscoveryCandidates(sc, places, ctx({ cacheLevel: "L2_stale" }));
    assert.notEqual(out, places);
    assert.equal(out[0].candidate?.truthClass, "stale");
    assert.equal(out[0].candidate?.id, "node/1");
    assert.equal(out[0].name, "A");
    assert.ok(!("candidate" in places[0]), "the caller's array must not be mutated");
  });
  it("the flag read is cached — two calls, one read", async () => {
    const { sc, reads } = flagClient({ [DISCOVERY_CANDIDATE_PROJECTION_FLAG]: true });
    await withDiscoveryCandidates(sc, places, ctx());
    await withDiscoveryCandidates(sc, places, ctx());
    assert.deepEqual(reads, [DISCOVERY_CANDIDATE_PROJECTION_FLAG]);
  });
});

describe("G. the Map-facing reader", () => {
  const rows = [
    { id: "node/1", name: "One", category: "food", lat: 1, lng: 1, tags: [] },
    { id: "db/2",   name: "Two", category: "food", lat: 1, lng: 1, tags: [] },
  ] as any[];

  it("anonymous viewer: no per-user ranking, rankedBy none, every whyForUser empty, no client touched", async () => {
    const sc: any = { from: () => { throw new Error("must not be called"); } };
    const out = await readDiscoveryCandidatesForViewer(sc, rows, null, "manila");
    assert.equal(out.rankedBy, "none");
    assert.equal(out.candidates.length, 2);
    for (const c of out.candidates) assert.deepEqual(c.candidate.whyForUser, []);
    assert.equal(out.suppressedWrites, 0);
  });
  it("empty input: empty output, nothing read", async () => {
    const sc: any = { from: () => { throw new Error("must not be called"); } };
    const out = await readDiscoveryCandidatesForViewer(sc, [], "u1", "manila");
    assert.deepEqual(out.candidates, []);
  });
  it("authenticated viewer: ranks with served:false — a permutation of the input, and any write the ranker attempted is intercepted, not executed", async () => {
    const attempted: string[] = [];
    // A client whose reads are empty and whose writes RECORD the attempt: if a
    // write ever reaches it, the no-write guard has failed.
    const b: any = {};
    for (const fn of ["select", "eq", "neq", "in", "not", "is", "ilike", "or", "gte", "lte", "gt", "lt", "order", "limit", "range", "contains", "overlaps"]) b[fn] = () => b;
    b.maybeSingle = async () => ({ data: null, error: null });
    b.single = async () => ({ data: null, error: null });
    b.then = (res: any, rej?: any) => Promise.resolve({ data: [], error: null }).then(res, rej);
    for (const w of ["insert", "upsert", "update", "delete"]) b[w] = () => { attempted.push(w); return b; };
    const sc: any = { from: () => b, rpc: () => { attempted.push("rpc"); return Promise.resolve({ data: null, error: null }); } };

    const out = await readDiscoveryCandidatesForViewer(sc, rows, "11111111-1111-4111-8111-111111111111", "manila");
    assert.equal(out.rankedBy, "pde");
    assert.deepEqual(out.candidates.map((c) => c.place.id).sort(), ["db/2", "node/1"]);
    assert.deepEqual(attempted, [], "served:false must hand the ranker a client that cannot write");
    for (const c of out.candidates) {
      assert.equal(c.candidate.whyNow, null);
      assert.equal(c.candidate.freshness.servedFrom, "map_read");
      assert.equal(c.candidate.freshness.state, "unknown");
    }
  });
});

describe("H. source guards", () => {
  it("every GET /discovery serialisation site passes its places through withDiscoveryCandidates", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../routes/discovery.ts", import.meta.url), "utf8");
    // The route handler spans from its declaration to the next top-level route.
    const start = src.indexOf('router.get("/discovery", async');
    const end   = src.indexOf('router.post("/discovery/already-known"');
    assert.ok(start > 0 && end > start);
    const handler = src.slice(start, end);
    const jsonSites = handler.match(/res\.json\(\{\s*\n?\s*places: [A-Za-z]+/g) ?? [];
    const populated = jsonSites.filter((m) => !/places: \[\]/.test(m));
    assert.equal(populated.length, 4, `expected the four populated serve sites, saw ${populated.length}: ${JSON.stringify(jsonSites)}`);
    for (const m of populated) {
      const varName = m.replace(/[\s\S]*places: /, "");
      assert.match(handler, new RegExp(`const ${varName} = await withDiscoveryCandidates\\(`),
        `${varName} must come from withDiscoveryCandidates`);
    }
  });
  it("the cold path reports rankedBy from the score map's SIZE — it is always a Map there, empty when no ranker ran", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../routes/discovery.ts", import.meta.url), "utf8");
    assert.match(src, /scoredById: scoredByPlaceId\.size > 0 \? scoredByPlaceId : null/);
    assert.match(src, /rankedBy:\s+scoredByPlaceId\.size > 0 \? "pde" : "none"/);
    assert.ok(!/rankedBy: scoredByPlaceId \? "pde"/.test(src), "a truthy-Map check would report pde for an anonymous cold fetch");
  });

  it("the projection is attached after the cache write, never inside it — setCacheA/writePlacesToDb never see a `candidate`", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../routes/discovery.ts", import.meta.url), "utf8");
    const start = src.indexOf('router.get("/discovery", async');
    const end   = src.indexOf('router.post("/discovery/already-known"');
    const handler = src.slice(start, end);
    for (const m of handler.matchAll(/(setCacheA|writePlacesToDb)\(([^;]*)\)/g)) {
      assert.ok(!/Candidates?\b/.test(m[2]), `${m[1]} receives a candidate-bearing array: ${m[0]}`);
    }
  });
});

// ── I. `01` §11 Explainability — the reason vocabulary (census DV-18) ─────────
//
// REQUIREMENT
// ===========
// docs/specs/discovery-v1/01_Portava_Discovery_Engine.md §11 (:242):
//   "Every served recommendation must have internal reasons such as:
//    trail_affinity, trip_match, nearby_now, trending_local, creator_affinity,
//    exploration, saved_similar, social_context, season_match."
//   "User-facing explanations should be plain language, e.g. 'Popular with solo
//    travelers this week.' …"
//
// THE GAP THIS COVERS
// ===================
// Before this module, `grep -rn "trail_affinity\|trip_match\|nearby_now\|
// trending_local\|creator_affinity\|saved_similar\|social_context\|
// season_match" artifacts/api-server/src` returned NO Discovery hit, and no
// plain-language string was produced anywhere on this surface. What existed was
// adjacent and is not this: the PDE projection carried the ranker's own
// FEATURE KEYS (`categoryAffinity`, `followedAuthor`, …) — internal variable
// names, not a reason vocabulary.
//
// WHAT MUST NOT HAPPEN
// ====================
// A code with no producer must never be emitted. Three of the nine have none on
// this surface today (no Trail object exists — DV-20; no trip-fit term reaches
// the recommendation ranker; no seasonality signal exists), and emitting them
// anyway would be inventing evidence — the same defect `05` §1.1 names for
// why-now. The test pins the absence as deliberately as it pins the presence.
import {
  DISCOVERY_REASON_CODES,
  REASON_CODES_WITHOUT_PRODUCER,
  reasonCodeForSignal,
  reasonCodesFromSignals,
  explainReasonCode,
  explainReasons,
  UNMAPPED_SIGNALS,
} from "../lib/discoveryReasonCodes.js";

describe("I. 01 §11 reason vocabulary", () => {
  it("I1. defines all nine codes, in the specification's own wording", () => {
    assert.deepEqual(
      [...DISCOVERY_REASON_CODES],
      [
        "trail_affinity", "trip_match", "nearby_now", "trending_local",
        "creator_affinity", "exploration", "saved_similar", "social_context",
        "season_match",
      ],
      "01 §11 lists nine internal reason codes; the vocabulary must be that list, not a paraphrase of it",
    );
  });

  it("I2. maps the Compass pipeline's own factor keys onto codes", () => {
    assert.equal(reasonCodeForSignal("distance"), "nearby_now");
    assert.equal(reasonCodeForSignal("open_now"), "nearby_now");
    assert.equal(reasonCodeForSignal("history"), "saved_similar");
    assert.equal(reasonCodeForSignal("memory_preference"), "saved_similar");
    assert.equal(reasonCodeForSignal("circle_memory_preference"), "social_context");
  });

  it("I3. maps the PDE ranker's own feature keys onto codes", () => {
    assert.equal(reasonCodeForSignal("followedAuthor"), "creator_affinity");
    assert.equal(reasonCodeForSignal("categoryAffinity"), "saved_similar");
    assert.equal(reasonCodeForSignal("localMomentum"), "trending_local");
    assert.equal(reasonCodeForSignal("socialProof"), "social_context");
    assert.equal(reasonCodeForSignal("governorSlot"), "exploration");
    assert.equal(
      reasonCodeForSignal("governor_new_creator"), "exploration",
      "the exploration governor stamps governor_<reason> keys; each is still the exploration reason",
    );
  });

  it("I4. emits NO code that has no producer on this surface", () => {
    for (const code of REASON_CODES_WITHOUT_PRODUCER) {
      const producers = [...Object.keys(UNMAPPED_SIGNALS), "distance", "open_now", "history", "followedAuthor",
        "localMomentum", "socialProof", "governorSlot", "categoryAffinity", "interest_match"]
        .filter((sig) => reasonCodeForSignal(sig) === code);
      assert.deepEqual(
        producers, [],
        `${code} has no producer in Discovery today; emitting it would be inventing evidence`,
      );
    }
    assert.deepEqual(
      [...REASON_CODES_WITHOUT_PRODUCER].sort(),
      ["season_match", "trail_affinity", "trip_match"],
      "the three unproducible codes must be named, so the absence is checkable rather than silent",
    );
  });

  it("I5. GUARDRAIL 01 §10: no safety, moderation or block signal becomes a user-facing reason", () => {
    for (const sig of ["safety_fit", "risk", "reports", "spam", "blocked", "trust", "seenPenalty"]) {
      assert.equal(
        reasonCodeForSignal(sig), null,
        `${sig} must not become a public explanation — 01 §10 forbids exposing block/unfollow reasons and making safety events into public signals`,
      );
    }
  });

  it("I6. dedupes and keeps the ranker's strength order", () => {
    assert.deepEqual(
      reasonCodesFromSignals(["distance", "open_now", "followedAuthor", "city_match"]),
      ["nearby_now", "creator_affinity"],
      "four signals collapsing to two codes must yield each code once, first-seen order (the ranker sorted by strength)",
    );
    assert.deepEqual(reasonCodesFromSignals([]), []);
    assert.deepEqual(reasonCodesFromSignals(["language_match"]), [],
      "an unmapped signal contributes nothing rather than a fabricated code");
  });

  it("I7. every emittable code has a plain-language string, and none leaks private context", () => {
    for (const code of DISCOVERY_REASON_CODES) {
      const text = explainReasonCode(code);
      if (REASON_CODES_WITHOUT_PRODUCER.includes(code)) {
        assert.equal(text, null, `${code} has no producer, so it must have no user-facing claim either`);
        continue;
      }
      assert.equal(typeof text, "string", `${code} must have a plain-language explanation (01 §11)`);
      assert.ok(text!.length > 0, `${code}'s explanation must not be blank`);
      assert.ok(
        /^[A-Z]/.test(text!) && /[.!]$/.test(text!),
        `${code}'s explanation must read as a sentence, not a key: got ${JSON.stringify(text)}`,
      );
      assert.ok(
        !/block|unfollow|report|@|\buser\b|\bid\b/i.test(text!),
        `${code}'s explanation must not disclose private social context or moderation state: got ${JSON.stringify(text)}`,
      );
    }
  });

  it("I8. explainReasons pairs each code with its text and drops what cannot be explained", () => {
    const out = explainReasons(["distance", "trust", "followedAuthor"]);
    assert.deepEqual(
      out.map((r) => r.code), ["nearby_now", "creator_affinity"],
      "a guardrailed signal contributes no reason at all",
    );
    assert.ok(out.every((r) => typeof r.text === "string" && r.text.length > 0));
  });
});

describe("I9. the projection carries reasons, and says nothing when nothing ranked", () => {
  it("a Compass-ranked row carries codes and plain language", () => {
    const c = projectDiscoveryCandidate({ id: "db/x" }, ctx({
      rankedBy: "compass",
      cacheLevel: "compass_fresh_rank",
      provenanceById: new Map([["db/x", {
        modelVersion: "m", featureVersion: "f", candidateSource: "curated_db" as const,
        reasons: ["distance", "open_now", "followedAuthor"],
        features: { factor_distance: 1 }, scores: { finalScore: 1 }, rankedAt: NOW,
      }]]),
    }));
    assert.deepEqual(c.reasons.map((r) => r.code), ["nearby_now", "creator_affinity"]);
    assert.ok(c.reasons.every((r) => r.text.length > 0), "01 §11 requires a plain-language explanation per reason");
  });

  it("a PDE-ranked row carries codes derived from its own positive features", () => {
    const c = projectDiscoveryCandidate({ id: "db/y" }, ctx({
      rankedBy: "pde",
      scoredById: new Map([["db/y", scored("db/y", { followedAuthor: 0.9, distance: 0.4, trust: 0.8 })]]),
    }));
    assert.deepEqual(
      c.reasons.map((r) => r.code), ["creator_affinity", "nearby_now"],
      "strongest first, and the guardrailed `trust` feature contributes no public reason",
    );
  });

  it("an unranked serve carries NO reasons — an empty list is 'nothing was computed'", () => {
    const c = projectDiscoveryCandidate({ id: "node/1" }, ctx({ rankedBy: "none" }));
    assert.deepEqual(c.reasons, [], "no ranker ran, so there is nothing to explain and nothing is claimed");
  });
});
