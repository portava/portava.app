/**
 * CompassTestingSandbox — Phase 6 testing and preview.
 *
 * Runs the full Compass pipeline against synthetic fixture data WITHOUT
 * touching any production tables. No DB reads or writes occur inside this
 * module — the `db` parameter is intentionally ignored everywhere.
 *
 * Returned result includes:
 *   feed            — full feed page as the pipeline would return it
 *   rankingReasons  — per-item explanation keys + score summary
 *   hiddenReasons   — items blocked by safety filter + reason
 *   safetyFilters   — alias of hiddenReasons (safety-blocked items)
 *   diversityMix    — type → count breakdown of passed items
 *   activeRewards   — empty array (skip DB-read reward computations)
 *   frontLoadPlan   — ordered list of sections to preload
 *   estimatedLoadMs — wall-clock ms the sandbox run took
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CompassItem, CompassProfile } from "./types.js";
import { buildFeed } from "./CompassFeedBuilder.js";
import { runSafetyFilter } from "./CompassSafetyFilter.js";
import { defaultSignals, buildCompassContext } from "./CompassContextEngine.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type TestUserType = "traveler" | "buddy" | "new_user" | "creator";

export interface TestScenario {
  userType:   TestUserType;
  city:       string;
  intentMode: string;
}

export interface SandboxRankingReason {
  itemId:  string;
  reasons: string[];
}

export interface SandboxHiddenItem {
  itemId: string;
  reason: string;
}

export interface SandboxResult {
  feed:            object;
  rankingReasons:  SandboxRankingReason[];
  hiddenReasons:   SandboxHiddenItem[];
  safetyFilters:   SandboxHiddenItem[];
  diversityMix:    Record<string, number>;
  activeRewards:   Array<{ userId: string; boost: number }>;
  frontLoadPlan:   string[];
  estimatedLoadMs: number;
}

// ── Synthetic fixture data ─────────────────────────────────────────────────────

/** Build a small but representative set of CompassItems for a city. */
function buildSyntheticItems(city: string): CompassItem[] {
  const now     = new Date();
  const tonight = new Date(now.getTime() + 6 * 60 * 60 * 1_000).toISOString();
  const tomorrow = new Date(now.getTime() + 26 * 60 * 60 * 1_000).toISOString();
  const recentJoin = new Date(now.getTime() - 20 * 24 * 60 * 60 * 1_000).toISOString();

  return [
    // ── Events ──────────────────────────────────────────────────────────────
    {
      id: "fixture-event-1",
      type: "event" as const,
      authorId: "fixture-author-1",
      city,
      visibilityScope: "public" as const,
      safetyTier: "standard",
      eventStartsAt: tonight,
      capacity: 50,
      currentAttendees: 12,
      interestTags: ["food", "social"],
      isVerified: true,
      country: "US",
      createdAt: now.toISOString(),
    },
    {
      id: "fixture-event-2",
      type: "event" as const,
      authorId: "fixture-author-2",
      city,
      visibilityScope: "public" as const,
      safetyTier: "relaxed",
      eventStartsAt: tomorrow,
      capacity: 100,
      currentAttendees: 30,
      interestTags: ["outdoors", "free"],
      country: "US",
      createdAt: now.toISOString(),
    },
    // ── Buddies ──────────────────────────────────────────────────────────────
    {
      id: "fixture-buddy-1",
      type: "buddy" as const,
      authorId: "fixture-author-3",
      targetUserId: "fixture-author-3",
      city,
      buddyStatus: "active",
      visibilityScope: "public" as const,
      safetyTier: "standard",
      isVerified: true,
      requiresVerification: true,
      interestTags: ["photography", "food"],
      authorJoinedAt: recentJoin,
      country: "US",
    },
    // ── Users ────────────────────────────────────────────────────────────────
    {
      id: "fixture-user-1",
      type: "user" as const,
      authorId: "fixture-author-4",
      targetUserId: "fixture-author-4",
      city,
      visibilityScope: "public" as const,
      safetyTier: "standard",
      interestTags: ["hiking", "culture"],
      country: "US",
    },
    {
      id: "fixture-user-2",
      type: "user" as const,
      authorId: "fixture-author-5",
      targetUserId: "fixture-author-5",
      city,
      visibilityScope: "public" as const,
      safetyTier: "standard",
      interestTags: ["nightlife"],
      authorJoinedAt: recentJoin,
      country: "US",
    },
    // ── Posts ────────────────────────────────────────────────────────────────
    {
      id: "fixture-post-1",
      type: "post" as const,
      authorId: "fixture-author-6",
      city,
      visibilityScope: "public" as const,
      safetyTier: "standard",
      interestTags: ["tips", "local"],
      country: "US",
      createdAt: now.toISOString(),
    },
    {
      id: "fixture-post-2",
      type: "post" as const,
      authorId: "fixture-author-7",
      city,
      visibilityScope: "public" as const,
      safetyTier: "standard",
      interestTags: ["food", "culture"],
      country: "US",
      createdAt: now.toISOString(),
    },
    // ── Suggestions ──────────────────────────────────────────────────────────
    {
      id: "fixture-suggestion-1",
      type: "suggestion" as const,
      authorId: "fixture-author-8",
      city,
      visibilityScope: "public" as const,
      safetyTier: "standard",
      interestTags: ["hidden_gem", "local"],
      country: "US",
    },
    {
      id: "fixture-suggestion-2",
      type: "suggestion" as const,
      authorId: "fixture-author-9",
      city,
      visibilityScope: "public" as const,
      safetyTier: "relaxed",
      interestTags: ["budget", "free"],
      country: "US",
    },
    // ── Stamps ──────────────────────────────────────────────────────────────
    {
      id: "fixture-stamp-1",
      type: "stamp" as const,
      authorId: "fixture-author-10",
      city,
      visibilityScope: "public" as const,
      safetyTier: "standard",
      interestTags: ["passport"],
      country: "US",
    },
    // ── SAFETY TEST — one item with adult-service flag ─────────────────────
    // This item MUST be blocked by runSafetyFilter so the sandbox proves the
    // safety filter is still enforced even in testing mode.
    {
      id: "fixture-unsafe-1",
      type: "user" as const,
      authorId: "fixture-unsafe-author",
      targetUserId: "fixture-unsafe-author",
      city,
      visibilityScope: "public" as const,
      safetyTier: "standard",
      hasAdultServiceFlag: true,
      country: "US",
    },
  ];
}

/** Build a synthetic CompassProfile for the given user type. */
function buildSyntheticProfile(scenario: TestScenario): CompassProfile {
  const base: CompassProfile = {
    userId:                "fixture-viewer",
    preferredCities:       [scenario.city],
    preferredLanguages:    ["en"],
    budgetStyle:           null,
    travelStyles:          [],
    socialStyle:           null,
    safetyPreference:      "standard",
    visibilityPreference:  "semi_private",
    blockedUserIds:        [],
    blockerUserIds:        [],
    blockCount:            0,
    blockerCount:          0,
    trustScore:            null,
    trustLevel:            null,
    activeUserScore:       null,
    hasActiveTrip:         false,
    hasActiveBooking:      false,
    upcomingTripWithin48h: false,
    hasFutureTripScheduled: false,
    currentCity:           scenario.city,
    currentCountry:        null,
    safeReturnActive:      false,
    categoryWeights:       {},
    ignoredItemIds:        [],
    mutedHashtags:         [],
    computedAt:            new Date().toISOString(),
  };

  switch (scenario.userType) {
    case "traveler":
      return { ...base, travelStyles: ["adventure", "social"], hasActiveTrip: true };
    case "buddy":
      return { ...base, hasActiveBooking: true, trustLevel: "trusted" };
    case "new_user":
      return { ...base, travelStyles: [], categoryWeights: {} };
    case "creator":
      return { ...base, travelStyles: ["creative"], categoryWeights: { suggestion: 0.5, post: 0.3 } };
    default:
      return base;
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Run the Compass pipeline against synthetic fixture data for a given scenario.
 *
 * @param _db       Intentionally ignored — no production reads or writes.
 * @param scenario  Test scenario to simulate.
 */
export async function runSandbox(
  _db:      SupabaseClient | null,
  scenario: TestScenario,
): Promise<SandboxResult> {
  const startMs = Date.now();

  const profile  = buildSyntheticProfile(scenario);
  // Use real context/signal engines — they are pure functions with no DB calls
  const signals  = defaultSignals(profile);
  const context  = buildCompassContext(profile, signals);
  const allItems = buildSyntheticItems(scenario.city);

  // ── Run safety filter explicitly (always enforced, even in sandbox) ────────
  const hiddenReasons: SandboxHiddenItem[] = [];
  const safeItems: CompassItem[]           = [];

  for (const item of allItems) {
    const result = runSafetyFilter(item, profile, null);
    if (!result.allowed) {
      hiddenReasons.push({ itemId: String(item.id), reason: result.reason ?? "blocked" });
    } else {
      safeItems.push(item);
    }
  }

  // ── Build feed with null db (zero production reads/writes) ────────────────
  let feed: object;
  try {
    feed = await buildFeed(safeItems, profile, context, null, null, {
      skipFairExposure:  false,
      skipActiveRewards: true, // skip DB-read author score fetches
    });
  } catch {
    feed = { sections: [], nextCursor: null, fallback: true };
  }

  // ── Collect ranking reasons from feed sections ─────────────────────────────
  const rankingReasons: SandboxRankingReason[] = [];
  const diversityMix: Record<string, number>   = {};

  const feedPage = feed as any;
  for (const section of (feedPage.sections ?? [])) {
    for (const item of (section.items ?? [])) {
      rankingReasons.push({
        itemId:  String(item.item?.id ?? item.id ?? ""),
        reasons: [
          String(item.explanationKey ?? section.name),
          `score:${Math.round(item.finalScore ?? 0)}`,
          `section:${section.name}`,
        ],
      });
      const type = String(item.item?.type ?? "unknown");
      diversityMix[type] = (diversityMix[type] ?? 0) + 1;
    }
  }

  return {
    feed,
    rankingReasons,
    hiddenReasons,
    safetyFilters:   hiddenReasons,      // same data, alias for API clarity
    diversityMix,
    activeRewards:   [],                 // skipped — no DB in sandbox
    frontLoadPlan:   ["for_you", "tonight", "near_your_area", "available_now", "compass_picks"],
    estimatedLoadMs: Date.now() - startMs,
  };
}
