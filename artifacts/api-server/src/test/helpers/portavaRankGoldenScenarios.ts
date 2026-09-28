/**
 * portavaRank golden scenarios — census-discovery §78 (lane W10-R2).
 *
 * Every scenario here runs `lib/portavaRank.ts` with ONLY the inputs that
 * existed before §78: no design input (intent, trip, negative feedback,
 * engagement integrity, Trail key, serve history, objective) is ever set. The
 * output — order, score and the full feature record of every row — is
 * serialised with JSON's shortest round-trip number form, so two runs are equal
 * as STRINGS exactly when every double is bit-identical.
 *
 * The golden at `src/test/fixtures/portavaRankGolden.json` was captured from
 * this helper at `debd5ad4f`, BEFORE any §78 edit to portavaRank.ts, by
 * `node --import tsx/esm -e` over `runPortavaRankGoldenScenarios()` (the command
 * is in census-discovery §78.7). `src/test/portavaRankDesignGolden.test.ts`
 * replays it. A §78 flag that is off must leave that string unchanged.
 *
 * RE-CAPTURED ONCE, by census-discovery §93 (lane W11-X1, D-W11X1-1), and only
 * because A11's dead free-time arms were deleted (D-W10S2-7): the `full`,
 * `layover` and `noNeighbourhood` viewers set the two deleted fields, which no
 * production caller ever set. The file was re-captured with the BASE ranker
 * (3cc027a06) over viewers without those fields, and the deleted-arms ranker
 * reproduces it byte for byte, from both the stripped viewers and the original
 * ones (sha256 665bb6a6…; the transcript is in §93). The ten `empty` hashes did
 * not move.
 *
 * The fixture is deliberately wide rather than realistic: every feature kernel
 * fires somewhere (recency, the three author terms, interest, category
 * affinity, city and neighbourhood, distance, actionability, both availability
 * modes, social proof with and without a trust score, trust, verified,
 * capacity, seen, kind prior, local momentum at and above its cap, Trail
 * affinity at and above its cap, the publisher boost and the place-engagement
 * boost), and every re-rank path runs (default diversity, diversity off,
 * explicit penalties including place and geography, exploration on and off,
 * a custom exploration cadence, and a weight override).
 */
import { createHash } from "node:crypto";
import {
  rankCandidates, scoreCandidate, diversify, injectExploration, DEFAULT_WEIGHTS,
  type RankCandidate, type ViewerContext, type ScoredCandidate, type RankOptions,
} from "../../lib/portavaRank.js";

export const GOLDEN_NOW_MS = Date.UTC(2026, 8, 28, 18, 0, 0);
const H = 3_600_000;
const iso = (offsetMs: number): string => new Date(GOLDEN_NOW_MS + offsetMs).toISOString();

/** Thirty candidates spanning every kind, feature and key the ranker reads. */
export function goldenCandidates(): RankCandidate[] {
  const out: RankCandidate[] = [];
  const kinds: RankCandidate["kind"][] = ["place", "gem", "event", "plan", "post", "place", "gem", "buddy", "place", "trip"];
  const categories = ["food", "nightlife", "culture", "beaches", "activities", null, "food", "nightlife"];
  const neighbourhoods = ["Alfama", "Baixa", "alfama", "Bairro Alto", null, "Belém", "BAIXA ", null];
  for (let i = 0; i < 30; i++) {
    const kind = kinds[i % kinds.length];
    out.push({
      id: i % 4 === 0 ? `db/0000000${i.toString().padStart(2, "0")}-aaaa-4000-8000-000000000000` : `node/${1000 + i}`,
      kind,
      createdAt: i % 5 === 4 ? null : iso(-(i * 7 + 1) * H),
      startsAt: kind === "event" || kind === "plan" ? iso(((i % 6) - 1) * 5 * H) : null,
      city: i % 7 === 6 ? "Porto" : "Lisbon",
      neighborhood: neighbourhoods[i % neighbourhoods.length],
      authorId: i % 3 === 0 ? "author-a" : i % 3 === 1 ? `author-${i % 5}` : null,
      tags: i % 2 === 0 ? ["rooftop", "sunset"] : i % 3 === 0 ? ["fado"] : [],
      category: categories[i % categories.length],
      likeCount: i % 4 === 3 ? null : i * 13,
      joinCount: kind === "event" ? i : null,
      authorTrustScore: i % 6 === 0 ? 85 : i % 6 === 3 ? 10 : null,
      verified: i % 4 === 0 ? true : null,
      distanceKm: i % 5 === 2 ? null : (i % 9) * 1.7,
      hasCapacity: kind === "event" ? i % 2 === 0 : null,
      isOfficialPublisher: i === 5 || i === 17,
      placeId: i % 8 === 7 ? null : `place-${i % 12}`,
    });
  }
  return out;
}

/** Viewer contexts, from empty to every input set. */
export function goldenViewers(): Record<string, ViewerContext> {
  const full: ViewerContext = {
    userId: "viewer-full",
    city: "lisbon",
    neighborhood: "Alfama",
    followedIds: new Set(["author-a", "author-2"]),
    mutualIds: new Set(["author-a"]),
    interestTags: new Set(["rooftop"]),
    categoryAffinities: { food: 0.8, nightlife: 0.3, culture: 1.4, beaches: -0.2 },
    engagedAuthorIds: new Set(["author-4"]),
    seenIds: new Set(["node/1001", "node/1005", "db/0000000008-aaaa-4000-8000-000000000000"]),
    nowMs: GOLDEN_NOW_MS,
    placeAffinities: { "place-1": 3, "place-2": 1, "place-5": 2 },
    localMomentum: { "node/1002": 0.4, "node/1003": 3, "node/1006": Number.NaN },
    trailAffinity: { "node/1007": 0.5, "node/1009": 2, "node/1010": -1 },
  };
  return {
    empty: { userId: "viewer-empty", nowMs: GOLDEN_NOW_MS },
    full,
    layover: { ...full, userId: "viewer-layover" },  // census-discovery §93 (W11-X1): its two free-time inputs were A11's dead arms, deleted (D-W10S2-7, D-W11X1-1)
    noNeighbourhood: { ...full, userId: "viewer-nonbhd", neighborhood: null },
  };
}

type Row = { id: string; score: number; features: Record<string, number> }; /* census-discovery §90: every number is hashed at 10 significant digits, because V8 changed Math.pow/Math.exp between Node 22 and 24 in the last bit (recency 0.044194173824159216 vs …22); the order and every value above 1e-10 relative are what the golden pins */ const canon = (n: number): number => Number(n.toPrecision(10)); export const goldenRow = (id: string, score: number, features: Record<string, number>): Row => ({ id, score: canon(score), features: Object.fromEntries(Object.entries(features).map(([k, v]) => [k, canon(v)])) });
const rows = <T extends RankCandidate>(s: ScoredCandidate<T>[]): Row[] =>
  s.map((x) => goldenRow(x.candidate.id, x.score, x.features));

/** The rank-option variants every viewer is ranked under. */
export function goldenRankOptions(): Record<string, RankOptions> {
  return {
    default: {},
    noExploration: { exploration: false },
    noDiversity: { diversity: false, exploration: false },
    placeAndGeo: { diversity: { placePenalty: 0.3, geoPenalty: 0.2, window: 4 }, exploration: false },
    tightAuthor: { diversity: { authorPenalty: 0.9, kindPenalty: 0 }, exploration: { everyN: 4, poolStart: 5 } },
    publisher: { publisherBoost: true },
    weights: {
      weights: { ...DEFAULT_WEIGHTS, recency: 0.2, distance: 1.1, localMomentum: 5, trailAffinity: 5, kindPrior: { place: 0.3 } },
      exploration: false,
    },
  };
}

/** Run every scenario; the result is what the golden stores. */
export function runPortavaRankGoldenScenarios(): Record<string, Row[]> {
  const out: Record<string, Row[]> = {};
  const cands = goldenCandidates();
  const viewers = goldenViewers();
  const options = goldenRankOptions();
  for (const [vName, ctx] of Object.entries(viewers)) {
    for (const [oName, opts] of Object.entries(options)) {
      out[`rank:${vName}:${oName}`] = rows(rankCandidates(cands.map((c) => ({ ...c })), ctx, opts));
    }
    out[`score:${vName}`] = cands.map((c) => {
      const s = scoreCandidate(c, ctx, DEFAULT_WEIGHTS, true);
      return goldenRow(c.id, s.score, s.features);
    });
    const scored = cands.map((c) => scoreCandidate(c, ctx));
    out[`diversify:${vName}`] = rows(diversify(scored, { placePenalty: 0.25, geoPenalty: 0.1 }));
    out[`explore:${vName}`] = rows(injectExploration(diversify(scored), ctx, { everyN: 5 }));
  }
  return out;
}

/**
 * The serialised form the golden file holds: per scenario, the sha256 of the
 * scenario's rows as JSON (shortest round-trip doubles, so equal hashes mean
 * bit-identical scores and features in the same order under the same keys),
 * plus ONE scenario in full so a reader can see what is being hashed. The full
 * rows of all forty scenarios were 530 KB; the hashes pin exactly the same
 * bytes, and a failing scenario is named by its key.
 */
export const GOLDEN_FULL_SCENARIO = "rank:full:default";

export function portavaRankGoldenDigest(): { hashes: Record<string, string>; sample: Record<string, unknown> } {
  const all = runPortavaRankGoldenScenarios();
  const hashes: Record<string, string> = {};
  for (const k of Object.keys(all)) hashes[k] = createHash("sha256").update(JSON.stringify(all[k])).digest("hex");
  return { hashes, sample: { [GOLDEN_FULL_SCENARIO]: all[GOLDEN_FULL_SCENARIO] } };
}

export async function serialisePortavaRankGolden(): Promise<string> {
  return JSON.stringify({ ...portavaRankGoldenDigest(), drs: await drsGoldenDigest() }, null, 1) + "\n";
}

// ── DiscoveryRankingService on the `discovery` surface (§78 DC-13 leg) ───────
//
// §78 makes DRS's negative-feedback inputs real on the discovery surface behind
// `discovery_feature_families_enabled`. With that flag absent or false, DRS's
// output must be what it was: this runs `rankItems` over a fake world in both
// DRS modes (shadow, and ACTIVITY_DISCOVERY_BOOST_ENABLED on) and the golden
// stores the sha256 of its outputs, captured at `debd5ad4f` before the edit.
import { rankItems, type RankingInput, type RankingViewerContext } from "../../services/ranking/DiscoveryRankingService.js";
import { newWorld, worldClient, flag } from "./fakeDiscoveryWorld.js";

export const DRS_GOLDEN_VIEWER = "cccc0000-0000-4000-8000-00000000000c";

export function drsGoldenInputs(): RankingInput[] {
  return Array.from({ length: 12 }, (_, i) => ({
    itemId: i % 3 === 0 ? `db/00000000-0000-4000-8000-0000000000${(10 + i).toString()}` : `node/${2000 + i}`,
    itemType: "place", creatorId: null, createdAt: null,
    city: i % 3 === 0 ? "lisbon" : null, country: null,
    tags: i % 2 === 0 ? ["rooftop"] : ["fado", "music"],
    category: ["food", "nightlife", "culture", "beaches"][i % 4] ?? null,
    languageCode: null, hasMedia: i % 2 === 0, completeness: i % 2 === 0 ? 0.9 : 0.5,
    positiveReviewRate: i % 5 === 0 ? null : (i % 5) / 5, flagCount: 0,
    saveCount: i * 3, shareCount: 0, commentCount: 0, impressionCount: Math.max(1, i * 3),
    uniqueViewerCount: i * 3, lat: 38.7 + i / 100, lng: -9.1, distanceKm: i % 4 === 1 ? null : i * 0.8,
    isDeleted: false, isExpired: false, isSuspended: false, isModerated: false, isPrivate: false,
    isAgeRestricted: false, minAgeRequired: null, isGeoRestricted: false, geoRestrictionCountries: null,
    authorIsBlockedByViewer: false, authorBlocksViewer: false, authorIsMutedByViewer: false,
    viewerHasReportedItem: false, viewerHasHiddenItem: false, viewerHasHiddenCreator: false,
    repeatCount: null, expiresAt: null, accountAgeDays: null, isUnfamiliarCategory: false, isFirstImpression: false,
  }));
}

export function drsGoldenViewer(): RankingViewerContext {
  return {
    viewerId: DRS_GOLDEN_VIEWER, travelStyles: ["rooftop"], preferredLanguages: [], preferredCities: ["lisbon"],
    currentCity: "lisbon", currentCountry: null, lat: null, lng: null, viewerAge: null,
    followedCreatorIds: new Set(), mutedCreatorIds: new Set(), blockedCreatorIds: new Set(),
    seenItemIds: new Set(), sessionId: null, lastActiveAt: null,
  };
}

/** Dismissals the §78 flag would read — present in the world in EVERY mode, so flag-off proves they are ignored. */
export function drsGoldenDismissals(): any[] {
  return [
    { user_id: DRS_GOLDEN_VIEWER, surface: "discovery", outcome: "dismiss", item_id: "node/2001", served_at: new Date(GOLDEN_NOW_MS - 3_600_000).toISOString() },
    { user_id: DRS_GOLDEN_VIEWER, surface: "discovery", outcome: "dismiss", item_id: "node/2005", served_at: new Date(GOLDEN_NOW_MS - 7_200_000).toISOString() },
  ];
}

export async function runDrsGoldenScenarios(extraFlags: any[] = []): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [mode, flags] of [
    ["shadow", [] as any[]],
    ["active", [flag("ACTIVITY_DISCOVERY_BOOST_ENABLED", true)]],
  ] as const) {
    const world = newWorld({ tables: { feature_flags: [...flags, ...extraFlags], rank_events: drsGoldenDismissals() } });
    const res = await rankItems(drsGoldenInputs(), "discovery", drsGoldenViewer(), worldClient(world), {},
      { emitPerCandidateAnalytics: false, nowMs: GOLDEN_NOW_MS });
    out[mode] = res;
  }
  return out;
}

export async function drsGoldenDigest(extraFlags: any[] = []): Promise<Record<string, string>> {
  const all = await runDrsGoldenScenarios(extraFlags);
  const hashes: Record<string, string> = {};
  for (const k of Object.keys(all)) hashes[k] = createHash("sha256").update(JSON.stringify(all[k])).digest("hex");
  return hashes;
}
