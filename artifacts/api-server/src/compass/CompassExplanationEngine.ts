/**
 * CompassExplanationEngine — Phase 5 "Why am I seeing this?" explanations.
 *
 * Maps each item's `explanationKey` (set by FeedBuilder) to a human-readable
 * string that the mobile client can display to the user.
 *
 * Privacy rule:
 *   Any explanationKey that carries a safety or moderation downrank signal
 *   NEVER reveals the real reason. Instead it returns the generic ineligible
 *   string. This prevents harassment-targeted users from learning they are
 *   being downranked for safety reasons.
 *
 * Sensitive key prefixes (never revealed):
 *   - *:harassment_downrank
 *   - *:safety_downrank
 *   - *:moderation_downrank
 *   - *:report_suppressed
 *   - *:adult_service_flag
 *   - *:unsafe_intent
 *   - *:safety_block
 *   - *:suspended
 *
 * Key format from FeedBuilder:
 *   "<section>:<itemType>"                 — base key
 *   "<section>:<itemType>:local"           — same city as viewer
 *   "<section>:<itemType>:fair_exposure"   — fair-exposure boosted
 *   "<section>:<itemType>:diversity_pick"  — diversity injection
 *
 * Recommendation tokens:
 *   Tokens are HMAC-signed with the server secret so the client cannot forge
 *   or tamper with the userId or explanationKey fields.
 *   The /why endpoint verifies the signature before trusting any token field.
 */

import { createHmac } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

// ── Explanation key constants ─────────────────────────────────────────────────
// Use these instead of raw string literals to avoid typos and enable
// find-all-references when changing key names.

/** Item is from a new creator the viewer may find interesting nearby. */
export const EXPLANATION_KEY_NEW_CREATOR_NEARBY       = "new_creator_nearby";
/** Item is from a creator who recently became active again in the viewer's city. */
export const EXPLANATION_KEY_RETURNING_CREATOR_ACTIVE = "returning_creator_active";
/** Item is gaining organic interest in the viewer's area. */
export const EXPLANATION_KEY_GAINING_INTEREST         = "gaining_interest";
/** Item is useful to travelers who share the viewer's plans. */
export const EXPLANATION_KEY_HELPFUL_TO_TRAVELERS     = "helpful_to_travelers";
/** Item was recently updated with new content. */
export const EXPLANATION_KEY_RECENTLY_UPDATED         = "recently_updated";

// ── Constants ─────────────────────────────────────────────────────────────────

export const GENERIC_INELIGIBLE =
  "This profile is not currently eligible for recommendations.";

const GENERIC_EXPLANATION =
  "Based on your travel preferences and recent activity.";

/** Key suffixes that must never be shown to the user. */
const SENSITIVE_SUFFIXES = [
  "harassment_downrank",
  "safety_downrank",
  "moderation_downrank",
  "report_suppressed",
  "adult_service_flag",
  "unsafe_intent",
  "safety_block",
  "suspended",
];

/** Section → human label for use in templates. */
const SECTION_LABELS: Record<string, string> = {
  for_you:                     "For You",
  available_now:               "Available Now",
  during_your_trip:            "During Your Trip",
  tonight:                     "Tonight",
  near_your_area:              "Near Your Area",
  compass_picks:               "Compass Picks",
  people_you_may_vibe_with:    "People You May Vibe With",
  rent_a_buddy:                "Rent a Buddy",
  hidden_gems:                 "Hidden Gems",
  city_pulse:                  "City Pulse",
  passport_stamp_opportunities:"Passport Stamp Opportunities",
  safety_recommended:          "Safety Recommended",
  your_circle_may_like:        "Your Circle May Like",
  new_in_this_city:            "New in This City",
  budget_friendly:             "Budget Friendly",
  creator_spots:               "Creator Spots",
  arrival_help:                "Arrival Help",
};

/** Item type → human label. */
const TYPE_LABELS: Record<string, string> = {
  user:       "traveler",
  buddy:      "travel buddy",
  event:      "event",
  post:       "post",
  suggestion: "place",
  stamp:      "stamp opportunity",
  guide:      "city guide",
};

// ── Built-in explanation templates ────────────────────────────────────────────

type TemplateKey = string;
const TEMPLATES: Record<TemplateKey, string> = {
  // ── Suffix modifiers ────────────────────────────────────────────────────────
  ":fair_exposure":   "This {type} is getting a boost to help new voices reach travelers like you.",
  ":local":           "This {type} is based in {city}, just like you.",
  ":diversity_pick":  "We added this {type} to bring more variety to your feed.",

  // ── New ranking-signal explanation keys ────────────────────────────────────
  // These are standalone keys (no section:type structure) used by
  // DiscoveryRankingService when a specific boost path selects an item.
  // They do NOT disclose that an item is boosted for underexposure,
  // anti-gaming, or any moderation reason.
  "new_creator_nearby:":       "A new creator you may like",
  "returning_creator_active:": "Recently active again in {city}",
  "gaining_interest:":         "Gaining interest in your area",
  "helpful_to_travelers:":     "Helpful to travelers with similar plans",
  "recently_updated:":         "Recently updated",

  // ── Section-level defaults ──────────────────────────────────────────────────
  "for_you:":             "Matched to your travel style and interests.",
  "available_now:":       "This {type} is available to connect with right now.",
  "during_your_trip:":    "Relevant to your upcoming or active trip.",
  "tonight:":             "Happening tonight — don't miss it.",
  "near_your_area:":      "Close to your current location.",
  "compass_picks:":       "Highly recommended based on your Compass profile.",
  "people_you_may_vibe_with:": "Travelers with similar interests and travel styles to yours.",
  "rent_a_buddy:":        "A verified travel buddy available in your area.",
  "hidden_gems:":         "A lesser-known spot loved by locals and experienced travelers.",
  "city_pulse:":          "Trending activity in your current city.",
  "passport_stamp_opportunities:": "A chance to earn a passport stamp for this destination.",
  "safety_recommended:":  "Recommended for travelers who prioritise safety.",
  "your_circle_may_like:":"Someone in your trusted circle may enjoy this.",
  "new_in_this_city:":    "New to your city and building a local reputation.",
  "budget_friendly:":     "A great option for budget-conscious travelers.",
  "creator_spots:":       "A content-creator-friendly location in your area.",
  "arrival_help:":        "Helpful for settling in as you've just arrived.",
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/** True if the explanationKey carries a sensitive/downrank signal. */
export function isSensitiveKey(explanationKey: string): boolean {
  const lower = explanationKey.toLowerCase();
  return SENSITIVE_SUFFIXES.some((s) => lower.includes(s));
}

function extractParts(explanationKey: string): {
  section: string;
  itemType: string;
  modifier: string;
} {
  const parts = explanationKey.split(":");
  const section  = parts[0] ?? "";
  const itemType = parts[1] ?? "";
  const modifier = parts[2] ?? "";
  return { section, itemType, modifier };
}

function fillTemplate(
  template: string,
  itemType: string,
  section: string,
  city?: string,
): string {
  return template
    .replace("{type}",    TYPE_LABELS[itemType]   ?? itemType)
    .replace("{section}", SECTION_LABELS[section] ?? section)
    .replace("{city}",    city ?? "your city");
}

// ── Main explanation resolver ─────────────────────────────────────────────────

/**
 * Resolve a human-readable "Why am I seeing this?" string from an explanationKey.
 *
 * @param explanationKey  The key attached to a FeedItem by CompassFeedBuilder.
 * @param db              Optional Supabase client for DB-override lookups.
 * @param city            Viewer's current city (used in ":local" template).
 */
export async function resolveExplanation(
  explanationKey: string,
  db:             SupabaseClient | null = null,
  city:           string | null        = null,
): Promise<string> {
  // Privacy rule — never reveal the real reason for sensitive keys
  if (isSensitiveKey(explanationKey)) {
    return GENERIC_INELIGIBLE;
  }

  // DB override lookup (non-fatal)
  if (db) {
    try {
      const { data } = await db
        .from("compass_explanation_reasons")
        .select("template, is_sensitive")
        .eq("explanation_key", explanationKey)
        .maybeSingle();

      if (data) {
        if ((data as any).is_sensitive) return GENERIC_INELIGIBLE;
        const tpl = (data as any).template as string;
        const { section, itemType } = extractParts(explanationKey);
        return fillTemplate(tpl, itemType, section, city ?? undefined);
      }
    } catch { /* non-fatal — fall through to built-in map */ }
  }

  const { section, itemType, modifier } = extractParts(explanationKey);

  // 1. Try full modifier suffix match (e.g. ":fair_exposure")
  if (modifier) {
    const suffixKey = `:${modifier}`;
    const tpl = TEMPLATES[suffixKey];
    if (tpl) return fillTemplate(tpl, itemType, section, city ?? undefined);
  }

  // 2. Try section-level prefix (e.g. "for_you:")
  const sectionPrefix = `${section}:`;
  const sectionTpl = TEMPLATES[sectionPrefix];
  if (sectionTpl) return fillTemplate(sectionTpl, itemType, section, city ?? undefined);

  // 3. Generic fallback
  return GENERIC_EXPLANATION;
}

// ── Recommendation token helpers ──────────────────────────────────────────────

export interface RecommendationToken {
  userId:         string;
  itemId:         string;
  itemType:       string;
  sectionName:    string;
  explanationKey: string;
}

/** @internal Token fields that are signed (all except sig itself). */
type SignableFields = RecommendationToken;

/** @internal Signed wire format stored in the opaque ID. */
interface SignedToken extends RecommendationToken {
  sig: string;
}

/**
 * Derive the HMAC signing secret.
 * Falls back to a fixed default so tests don't need env vars.
 */
function getSigningSecret(): string {
  return (
    process.env.SESSION_SECRET ??
    process.env.COMPASS_TOKEN_SECRET ??
    "compass-recommendation-token-fallback-v1"
  );
}

/**
 * Compute a short HMAC signature over the signable fields.
 * Keys are sorted before stringification so order doesn't matter.
 */
function computeSig(fields: SignableFields): string {
  const sorted: Record<string, string> = {};
  for (const key of (Object.keys(fields) as (keyof SignableFields)[]).sort()) {
    sorted[key] = fields[key];
  }
  return createHmac("sha256", getSigningSecret())
    .update(JSON.stringify(sorted))
    .digest("hex")
    .slice(0, 32); // 32 hex chars = 128 bits, ample for HMAC
}

/**
 * Encode a recommendation token as a base64url opaque ID.
 *
 * The token is HMAC-signed so it cannot be forged or tampered with by the
 * client.  The server can verify it without a DB lookup.
 */
export function encodeRecommendationToken(t: RecommendationToken): string {
  const signed: SignedToken = { ...t, sig: computeSig(t) };
  return Buffer.from(JSON.stringify(signed)).toString("base64url");
}

/**
 * Decode and cryptographically verify a recommendation token.
 *
 * Returns null if the token is malformed, has an invalid signature, or is
 * missing required fields.  The caller MUST NOT trust any token that returns
 * null.
 */
export function decodeRecommendationToken(
  raw: string,
): RecommendationToken | null {
  if (!raw) return null;
  try {
    const parsed: SignedToken = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    );

    // Validate required fields are present
    if (
      typeof parsed.userId         !== "string" ||
      typeof parsed.itemId         !== "string" ||
      typeof parsed.itemType       !== "string" ||
      typeof parsed.sectionName    !== "string" ||
      typeof parsed.explanationKey !== "string" ||
      typeof parsed.sig            !== "string"
    ) {
      return null;
    }

    // Cryptographically verify the signature
    const { sig, ...fields } = parsed;
    const expectedSig = computeSig(fields as SignableFields);
    if (sig !== expectedSig) return null;

    return fields as RecommendationToken;
  } catch {
    return null;
  }
}
