/**
 * The fixed inputs of discoveryPdeGraphReading.test.ts (census-discovery §62,
 * DV-52). Kept apart from the test so the GOLDEN values the test pins could be
 * captured from the pre-§62 engine with exactly these inputs, and so a later
 * reader can re-capture them the same way.
 */
import type { PdePlace, PdeViewer } from "../lib/discoveryPde.js";
import { inertModifiers, type DiscoveryModifiers } from "../lib/discoveryModifiers.js";

export const NOW_MS = Date.parse("2026-09-27T12:00:00Z");

export function places(): PdePlace[] {
  const cats = ["food", "nightlife", "culture", "outdoors", "cafe", "food", "culture", "nightlife"];
  return cats.map((category, i) => ({
    id: i % 3 === 0 ? `db/00000000-0000-4000-8000-00000000006${i}` : `node/62${i}`,
    category,
    distanceKm: 0.4 + i * 0.7,
    savedCount: (i * 7) % 11,
    tags: i % 2 === 0 ? [category, "local"] : [category],
    lat: 38.7 + i * 0.001,
    lng: -9.1 - i * 0.001,
    rating: i % 4 === 0 ? 4.5 : null,
    description: i % 2 === 0 ? "a place" : null,
    headerImageUrl: i % 3 === 0 ? "https://example.invalid/x.jpg" : null,
    neighborhood: i % 2 === 0 ? "Alfama" : "Baixa",
  }) as unknown as PdePlace);
}

export function viewer(): PdeViewer {
  return {
    userId: "62626262-6262-4262-8262-626262626262",
    city: "lisbon",
    followedIds: new Set<string>(),
    interestTags: new Set(["food", "culture"]),
    categoryAffinities: { food: 0.8, culture: 0.4 },
    seenIds: new Set(["node/621"]),
    placeAffinities: { "db/00000000-0000-4000-8000-000000000063": 2 },
    degraded: [],
    neighborhood: "Alfama",
  } as unknown as PdeViewer;
}

/** The modifiers-ON record: a city-confidence reading and momentum, as loadDiscoveryModifiers would assemble them. */
export function modifiersOn(): DiscoveryModifiers {
  return {
    enabled: true,
    reason: "flag_on",
    localMomentum: { "node/621": 0.35, "node/622": 0.1, "db/00000000-0000-4000-8000-000000000066": 0.2 },
    trailAffinity: {},
    trendStates: {},
    cityConfidence: {
      city: "lisbon", depthScore: 41, tier: "moderate", signals: { visitors: 3 },
      computedAt: "2026-09-26T03:00:00.000Z", source: "platform_coverage", sourceReason: "platform_coverage", platformCells: 12,
    } as DiscoveryModifiers["cityConfidence"],
    momentumScale: 0.705,
    explorationBudgetPct: 20.9,
  };
}

export function modifiersOff(): DiscoveryModifiers {
  return inertModifiers("flag_off");
}
