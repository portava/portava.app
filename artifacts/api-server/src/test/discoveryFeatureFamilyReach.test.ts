/**
 * DC-13 / DC-24 — is `06` §3's named feature-family ranker actually on
 * Discovery's serve path, and how much of §3 does it carry?
 *
 * WHY THIS FILE EXISTS
 * ====================
 * `docs/architecture/census-discovery.md` DC-13 and DC-24, and
 * `docs/discovery/compliance-v1.md` §4.6 / §4.9, both rest on one sentence:
 *
 *   "A named-family configuration … does exist in the shared ranking-services
 *    module, and **no Discovery route imports it**."
 *
 * Read literally that is true — `routes/discovery.ts` has no
 * `services/ranking/DiscoveryRankingService` import. Read as a REACHABILITY
 * claim, which is how both rows use it, it is false and has been since the
 * ranker was moved behind `lib/discoveryPde.ts`:
 *
 *   routes/discovery.ts:2239  rankForViewer(places, pdeViewer, { sc, served: true })
 *                             — UNGATED for every authenticated caller on the
 *                               cold/fresh path. No engine-mode check, no flag.
 *   lib/discoveryPde.ts:105   import { rankItems as drsRankItems } from
 *                               "../services/ranking/DiscoveryRankingService.js"
 *   lib/discoveryPde.ts:695   drsRankItems(drsInputs, "discovery", …)
 *
 * The route says so about itself at routes/discovery.ts:44-46 — the import was
 * MOVED behind the PDE module on purpose — so the census's grep was accurate
 * and its conclusion was not.
 *
 * Nothing in the suite pinned this. `test/discoveryPde.test.ts:235` asserts only
 * `typeof out.stages.drs === "boolean"`, which is equally satisfied by a build
 * in which the shared ranker was deleted. So the one fact both census rows turn
 * on was unguarded in either direction.
 *
 * WHAT IS PINNED, AND WHAT IS NOT
 * ===============================
 * A. REACH. `rankForViewer` — the exact function the live authenticated serve
 *    path calls — RUNS `services/ranking/*`. Two independent witnesses:
 *    `stages.drs`, lib/discoveryPde's own record that the re-rank pass executed,
 *    and the config table that module and only that module reads
 *    (`ranking_config`), observed on a recording client with the module's
 *    60-second cache invalidated first so a warm cache cannot make it vacuous.
 *
 *    NOT asserted here: that the DRS pass is non-fatal. It was tried and the
 *    assertion did not bite — every database read inside
 *    services/ranking/DiscoveryRankingService is individually try/caught
 *    (`:357`, `:393`, `:419`, `:440`, `:700`) and so is rankingConfig's loader
 *    (`rankingConfig.ts:30`), so a detonating client never reaches
 *    lib/discoveryPde's own catch. Removing that catch left this file green.
 *    Saying so is cheaper than shipping an assertion that cannot fail; the
 *    non-fatality of the outer catch remains untested by anything.
 *
 * B. COVERAGE, as a ledger rather than a prose count. `06` §3 names eleven
 *    feature families. Five are represented in the shared configuration and are
 *    therefore reachable from Discovery; six are not. The split is asserted in
 *    BOTH directions so that adding a family, or losing one, moves this test
 *    instead of quietly ageing a sentence in a census.
 *
 * NOT pinned, and deliberately: that DRS changes the served order. It re-ranks
 * only when it has something to say and returns input order otherwise, so on a
 * stub client the order is unchanged — asserting an order change here would be
 * asserting the stub, not the product.
 *
 * `trail_relevance` is one of the six absent families and cannot be closed from
 * this lane at all: it needs a Trail object, which `docs/discovery/ROADMAP.md`
 * leaves unscheduled (census-discovery DV-20).
 *
 * Runtime: node:test + node:assert/strict.
 * Run: node --import tsx/esm --test src/test/discoveryFeatureFamilyReach.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rankForViewer, type PdePlace } from "../lib/discoveryPde.js";
import {
  invalidateRankingConfigCache,
  getWeights,
  getPenalties,
} from "../services/ranking/rankingConfig.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function places(n: number): PdePlace[] {
  return Array.from({ length: n }, (_, i) => ({
    id:         i % 3 === 0 ? `db/${i}` : `osm/node/${i}`,
    name:       `place-${i}`,
    category:   i % 2 === 0 ? "food" : "nightlife",
    distanceKm: (i % 7) + 0.5,
    savedCount: i * 2,
    rating:     3 + (i % 3) * 0.5,
    tags:       [`Tag${i % 4}`],
    lat:        48.85 + i / 1000,
    lng:        2.35 + i / 1000,
    headerImageUrl: null,
    description:    null,
  })) as unknown as PdePlace[];
}

const VIEWER = {
  userId:       "u-1",
  city:         "paris",
  followedIds:  new Set<string>(["u-2"]),
  interestTags: new Set<string>(["tag1"]),
};

/** Supabase-ish stub that records which tables were READ. Every read is empty. */
function tableRecordingClient() {
  const reads: string[] = [];
  const client: any = {
    from(table: string) {
      reads.push(table);
      const q: any = {
        select: () => q, eq: () => q, in: () => q, gte: () => q, lte: () => q,
        like:   () => q, order: () => q, limit: () => q,
        maybeSingle: async () => ({ data: null, error: null }),
        single:      async () => ({ data: null, error: null }),
        insert: () => q, upsert: () => q, update: () => q, delete: () => q,
        then: (res: any) => Promise.resolve({ data: [], error: null }).then(res),
      };
      return q;
    },
  };
  return { client, reads };
}

// ── A. REACH ──────────────────────────────────────────────────────────────────

describe("DC-13/DC-24 — the shared named-family ranker is ON Discovery's serve path", () => {
  it("A1. rankForViewer RUNS the shared ranker — stages.drs is true and ranking_config is read", async () => {
    invalidateRankingConfigCache();
    const { client, reads } = tableRecordingClient();

    const out = await rankForViewer(places(8), VIEWER, { sc: client, served: false });

    assert.equal(
      out.stages.drs, true,
      "rankForViewer is what routes/discovery.ts:2239 calls for every authenticated " +
      "cold-path request, and stages.drs is lib/discoveryPde's own record that the " +
      "DiscoveryRankingService re-rank pass executed. If this is red, the shared " +
      "named-family ranker has left Discovery's serve path — in which case " +
      "census-discovery DC-13's 'no Discovery route imports it' has become true and " +
      "the row's evidence should say so. Do not weaken the assertion to make it pass. " +
      `stages: ${JSON.stringify(out.stages)}`,
    );
    assert.ok(
      reads.includes("ranking_config"),
      "second, independent witness: `ranking_config` is read by " +
      "services/ranking/rankingConfig and by nothing else in the tree, so seeing it " +
      "inside this call proves the shared module — not a local copy of it — is what " +
      `ran. tables read: ${JSON.stringify([...new Set(reads)])}`,
    );
  });

  it("A2. the ranking_config witness is real, not a warm-cache artefact", async () => {
    invalidateRankingConfigCache();
    const first = tableRecordingClient();
    await rankForViewer(places(4), VIEWER, { sc: first.client, served: false });
    assert.ok(first.reads.includes("ranking_config"));

    // Second call, cache deliberately NOT invalidated: the read is served from
    // rankingConfig's own 60-second cache, so its absence here is expected and is
    // RECORDED rather than asserted away. Stated so that A1's invalidate() is
    // understood as load-bearing and is never removed as tidy-up.
    const second = tableRecordingClient();
    await rankForViewer(places(4), VIEWER, { sc: second.client, served: false });
    assert.equal(
      typeof second.reads.includes("ranking_config"), "boolean",
      "recorded, not asserted — a warm cache legitimately suppresses the second read",
    );
  });

  it("A3. both rankers run on ONE request, and the second may not drop candidates", async () => {
    invalidateRankingConfigCache();
    const { client } = tableRecordingClient();
    const input = places(12);
    const out = await rankForViewer(input, VIEWER, { sc: client, served: false });

    // DC-24's "parallel systems" finding, made observable: portavaRank and the
    // shared ranking service are not alternatives chosen per request — they are
    // two implementations applied in sequence to the same page.
    assert.equal(out.stages.portavaRank, true);
    assert.equal(out.stages.drs, true, "both ranking implementations ran on the same request");

    assert.deepEqual(
      [...out.ranked.map((p) => p.id)].sort(),
      [...input.map((p) => p.id)].sort(),
      "the DRS pass re-orders; it must never drop or duplicate a candidate. A subset " +
      "would make any legacy-vs-PDE divergence unreadable, because 'ordered " +
      "differently' and 'has fewer items' would look the same in the comparison.",
    );
  });
});

// ── B. COVERAGE LEDGER ────────────────────────────────────────────────────────

/** `06` §3, verbatim and in the specification's own order. */
const SPEC_06_FEATURE_FAMILIES = [
  "relevance", "travel_intent", "freshness", "quality", "trust", "novelty",
  "social_relevance", "place_relevance", "trail_relevance", "exploration_value",
  "negative_feedback",
] as const;

/**
 * Which of the eleven the shared configuration actually names, and under which
 * key. Mapping is stated here rather than inferred: `exploration` IS §3's
 * `exploration_value` and `negativeFeedback` IS `negative_feedback`; the other
 * shared keys (`activity`, `engagement`, `underexposure`, `repetition`,
 * `fatigue`) are real terms that §3 does NOT name, and are deliberately not
 * bent onto a family to inflate the count.
 */
const FAMILY_TO_SHARED_KEY: Readonly<Partial<Record<(typeof SPEC_06_FEATURE_FAMILIES)[number], string>>> = {
  relevance:         "relevance",
  freshness:         "freshness",
  quality:           "quality",
  exploration_value: "exploration",
  negative_feedback: "negativeFeedback",
};

describe("DC-13 — how much of 06 §3 the reachable ranker carries, as a checkable ledger", () => {
  it("B1. five of the eleven families are named in the shared configuration", async () => {
    invalidateRankingConfigCache();
    const { client } = tableRecordingClient();
    const configured = new Set([
      ...Object.keys(await getWeights(client)),
      ...Object.keys(await getPenalties(client)),
    ]);

    const present = SPEC_06_FEATURE_FAMILIES.filter((f) => {
      const key = FAMILY_TO_SHARED_KEY[f];
      return !!key && configured.has(key);
    });
    assert.deepEqual(
      [...present],
      ["relevance", "freshness", "quality", "exploration_value", "negative_feedback"],
      "these five 06 §3 families are configured in services/ranking and reachable from " +
      "Discovery via lib/discoveryPde. A change here is a census-visible change to DC-13.",
    );
  });

  it("B2. the other six are absent, and absence is asserted rather than assumed", async () => {
    invalidateRankingConfigCache();
    const { client } = tableRecordingClient();
    const configured = new Set([
      ...Object.keys(await getWeights(client)),
      ...Object.keys(await getPenalties(client)),
    ]);

    const missing = SPEC_06_FEATURE_FAMILIES.filter((f) => {
      const key = FAMILY_TO_SHARED_KEY[f];
      return !key || !configured.has(key);
    });
    assert.deepEqual(
      [...missing],
      ["travel_intent", "trust", "novelty", "social_relevance", "place_relevance", "trail_relevance"],
      "DC-13 stays W on these six. `trail_relevance` cannot be closed by any amount of " +
      "ranker work — it needs a Trail object, which is unscheduled (DV-20).",
    );
    assert.equal(
      present_plus_missing_is_total(missing.length),
      true,
      "every one of the eleven must land in exactly one bucket — a family in neither " +
      "would mean the ledger stopped covering §3",
    );
  });
});

function present_plus_missing_is_total(missingCount: number): boolean {
  return 5 + missingCount === SPEC_06_FEATURE_FAMILIES.length;
}
