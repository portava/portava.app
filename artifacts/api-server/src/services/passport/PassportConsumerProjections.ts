/**
 * PassportConsumerProjections — §21 (TABLE 22), §33, §8.
 *
 * ONE Passport projection system, many consumers (§33 canonical rule: "Other
 * surfaces request the appropriate Passport projection instead of rebuilding
 * identity, availability, trust and social context independently").
 *
 * Before this module, Compass, Rent-a-Buddy, the Telegraph conversation header
 * and Discovery each read `profiles` / `trust_profiles` directly and
 * re-implemented privacy per surface. This module gives each consumer a
 * server-side VARIANT of the single §29 aggregate:
 *
 *   • It calls the ONE assembler (`buildPassportProjection`) — so blocking /
 *     unavailable propagation (§24), the TABLE 24 location opt-outs, per-plan
 *     and per-memory visibility, and the server-projected capabilities (§30)
 *     all apply UNIFORMLY, computed once.
 *   • It then strips the aggregate to that consumer's TABLE 22 field
 *     allow-list by CONSTRUCTING a fresh, narrow object (never by deleting keys
 *     off the full projection) — a field a variant does not list can never leak,
 *     because it is never copied across.
 *
 * The four variants map to the TABLE 22 consumers:
 *   discovery_card → Discovery cards AND Compass person cards (§8 pairs them:
 *                    identity, verification, availability, Open to Plans, current
 *                    intent, permitted trust summary + capabilities, shared
 *                    context). Compass and Discovery share the person-card view.
 *   telegraph      → conversation header (identity + relevant shared context).
 *   buddy          → buddy card identity + Buddy verification + availability +
 *                    reputation summary (services / service-area / completion
 *                    stay buddy-domain and are merged by the route).
 *   safety         → restricted, purpose-specific context only.
 *
 * §8 (Open to Plans and Intent): the discovery_card variant's `intent` is the
 * traveler's EXPLICIT current intent, read from the §8 availability-window
 * domain (`OpenToPlansService`, explicit-only, expiry re-evaluated on read) —
 * not a generic long-term interest list. `explicitIntentBoost` /
 * `genericInterestWeight` give Compass a documented, bounded weight that ranks
 * explicit current intent ABOVE generic interests, and — because the boost is
 * zero unless an explicit window is active — ordering changes ONLY when an
 * explicit window exists.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildPassportProjection,
  type BuildProjectionOptions,
  type PassportProjection,
  type PassportViewerContext,
  type PassportPositiveCapabilities,
  type PassportViewerActions,
  type TravelStats,
  type TravelerStateKind,
} from "./PassportProjectionService.js";
import type { SharedContextProjection } from "./SharedContextService.js";
import {
  getActiveWindows,
  projectPublicWindows,
  effectiveExpiry,
  type AvailabilityWindow,
  type ViewerRelationship,
} from "./OpenToPlansService.js";

// ─────────────────────────────────────────────────────────────────────────────
// Variant kinds
// ─────────────────────────────────────────────────────────────────────────────

export type PassportConsumerVariant = "discovery_card" | "telegraph" | "buddy" | "safety";

type SocialAvailability = "open" | "maybe" | "crew_only" | "following_only" | "not_open";

// ─────────────────────────────────────────────────────────────────────────────
// Variant shapes (each lists ONLY the fields that consumer may receive)
// ─────────────────────────────────────────────────────────────────────────────

/** Discovery + Compass person card (TABLE 22 union of the two rows). */
export interface DiscoveryCardIdentity {
  userId: string;
  name: string | null;
  handle: string | null;
  avatarUrl: string | null;
  verified: boolean;
  verificationLevel: string | null;
  /** Coarse home country only — never home base (§22/§23). */
  homeCountry: string | null;
  isOfficial: boolean;
}

export interface DiscoveryCardTravelerState {
  state: TravelerStateKind;
  label: string;
  /** Broad city context only — already location-gated by the assembler (§5/§23). */
  city: string | null;
  expiresAt: string | null;
}

export interface DiscoveryCardAvailability {
  openToPlans: boolean;
  socialAvailability: SocialAvailability;
  currentWindow: { status: string; expiresAt: string | null } | null;
  expiresAt: string | null;
}

export interface DiscoveryCardIntent {
  /** Explicit current intent (§8) or, when no window is active, generic tags. */
  current: string[];
  ttlExpiresAt: string | null;
  source: "explicit" | "inferred";
  /** True when `current` came from an ACTIVE explicit availability window (§8). */
  explicit: boolean;
}

export interface DiscoveryCardTrust {
  label: string;
  publicLevel: string;
  confidence: "low" | "medium" | "high";
  strengths: string[];
}

export interface DiscoveryCardProjection {
  variant: "discovery_card";
  userId: string;
  viewerContext: PassportViewerContext;
  identity: DiscoveryCardIdentity;
  travelerState?: DiscoveryCardTravelerState;
  availability?: DiscoveryCardAvailability;
  intent?: DiscoveryCardIntent;
  trust?: DiscoveryCardTrust;
  /** Trust capabilities (Compass) + per-viewer action eligibility (§30). */
  capabilities: { owner: PassportPositiveCapabilities; actions: PassportViewerActions };
  stats: TravelStats;
  sharedContext?: SharedContextProjection;
  /** True whenever an active explicit availability window backs `intent` (§8). */
  hasExplicitWindow: boolean;
  restricted?: { reason: string };
}

/** Telegraph conversation header (TABLE 22: identity + relevant shared context). */
export interface TelegraphHeaderIdentity {
  userId: string;
  name: string | null;
  handle: string | null;
  avatarUrl: string | null;
  verified: boolean;
}

export interface TelegraphHeaderProjection {
  variant: "telegraph";
  userId: string;
  viewerContext: PassportViewerContext;
  identity: TelegraphHeaderIdentity;
  sharedContext?: SharedContextProjection;
  /** Server-projected header actions (§30) — never re-derived on the client. */
  actions: Pick<PassportViewerActions, "can_message" | "can_make_plan" | "can_follow">;
  restricted?: { reason: string };
}

/** Buddy card identity + verification + availability + reputation summary. */
export interface BuddyProjectionIdentity {
  userId: string;
  name: string | null;
  handle: string | null;
  avatarUrl: string | null;
  verified: boolean;
  verificationLevel: string | null;
}

export interface BuddyProjection {
  variant: "buddy";
  userId: string;
  viewerContext: PassportViewerContext;
  identity: BuddyProjectionIdentity;
  /** Reputation summary — label/level only, never a numeric score to a viewer. */
  trust?: DiscoveryCardTrust;
  credentials: Array<{ key: string; label: string; detail: string | null; tier: "verified" | "positive" }>;
  availability?: DiscoveryCardAvailability;
  stats: TravelStats;
  capabilities: { owner: PassportPositiveCapabilities; actions: PassportViewerActions };
  restricted?: { reason: string };
}

/** Safety: restricted, purpose-specific context only (TABLE 22). */
export interface SafetyProjection {
  variant: "safety";
  userId: string;
  viewerContext: PassportViewerContext;
  handle: string | null;
  verified: boolean;
  /** Safety propagation (§24): whether this relationship is blocked/unavailable. */
  blocked: boolean;
  restricted?: { reason: string };
}

// ─────────────────────────────────────────────────────────────────────────────
// §8 — explicit-intent weighting (pure, documented, bounded)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A shared EXPLICIT current intent is worth this many points. Chosen strictly
 * greater than GENERIC_WEIGHT_PER_MATCH so one explicit-intent match always
 * outweighs one generic-interest match (§8: "weight explicit current intent
 * more heavily than generic interests").
 */
export const INTENT_WEIGHT_PER_MATCH = 12;
/** Explicit-intent contribution is capped so it can never dominate the score. */
export const MAX_INTENT_WEIGHT = 36;
/** A shared generic (long-term) interest is worth this many points. */
export const GENERIC_WEIGHT_PER_MATCH = 4;
/** Generic-interest contribution cap. */
export const MAX_GENERIC_WEIGHT = 16;

function normSet(list: readonly string[]): Set<string> {
  return new Set(list.map((x) => String(x).trim().toLowerCase()).filter(Boolean));
}

/** Case-insensitive overlap count between two string lists. */
export function sharedCount(a: readonly string[], b: readonly string[]): number {
  const sb = normSet(b);
  let n = 0;
  for (const x of normSet(a)) if (sb.has(x)) n++;
  return n;
}

/**
 * Case-insensitive overlap LABELS between two string lists, taken (and
 * de-duplicated) from `b` so the returned casing is the owner's canonical form.
 * `sharedItems(a, b).length === sharedCount(a, b)`.
 */
export function sharedItems(a: readonly string[], b: readonly string[]): string[] {
  const sa = normSet(a);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of b) {
    const key = String(raw).trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (sa.has(key)) out.push(String(raw).trim());
  }
  return out;
}

/**
 * Bounded weight for EXPLICIT current-intent overlap. Returns 0 unless an
 * explicit window is active, so applying this boost changes ordering ONLY when
 * an explicit availability window exists (§8).
 */
export function explicitIntentBoost(sharedExplicitIntents: number, hasExplicitWindow: boolean): number {
  if (!hasExplicitWindow || sharedExplicitIntents <= 0) return 0;
  return Math.min(MAX_INTENT_WEIGHT, sharedExplicitIntents * INTENT_WEIGHT_PER_MATCH);
}

/** Bounded weight for generic (long-term) interest overlap. */
export function genericInterestWeight(sharedInterests: number): number {
  if (sharedInterests <= 0) return 0;
  return Math.min(MAX_GENERIC_WEIGHT, sharedInterests * GENERIC_WEIGHT_PER_MATCH);
}

// ─────────────────────────────────────────────────────────────────────────────
// Explicit-intent read (§8: OpenToPlansService, explicit-only, expiry-on-read)
// ─────────────────────────────────────────────────────────────────────────────

/** Map a TABLE-5 viewer context onto the window visibility relationship set. */
export function viewerContextToWindowRelationship(context: PassportViewerContext): ViewerRelationship {
  switch (context) {
    case "self":
      return "self";
    case "follower":
      return "follower";
    case "following":
      return "following";
    case "trip_crew":
    case "trip_host":
      return "crew";
    default:
      // public / buddy_customer / buddy_provider / event_group → public windows only.
      return "public";
  }
}

/**
 * The traveler's ACTIVE explicit availability windows the viewer may see (§7/§8/
 * §31). Self reads all active windows; anyone else gets only explicit,
 * non-expired windows whose visibility admits them (`projectPublicWindows`
 * already enforces §7 + §31). Never throws — a degraded read yields no windows.
 */
async function loadVisibleActiveWindows(
  sc: SupabaseClient,
  ownerId: string,
  context: PassportViewerContext,
  nowMs: number,
): Promise<AvailabilityWindow[]> {
  try {
    if (context === "self") {
      return await getActiveWindows(sc, ownerId, nowMs);
    }
    const rel = viewerContextToWindowRelationship(context);
    const windows = await projectPublicWindows(sc, ownerId, rel, nowMs);
    // projectPublicWindows applies visibility + non-expiry; also require the
    // window to have actually started (active), matching getActiveWindows.
    return windows.filter((w) => Date.parse(w.startAt) <= nowMs);
  } catch {
    return [];
  }
}

/** Explicit current-intent read (§8): the intents a viewer may see + whether an
 *  active, open-to-plans explicit window backs them. `hasActiveWindow` gates the
 *  §8 weighting so ordering changes ONLY when an explicit window exists. */
export interface ExplicitIntentRead {
  intents: string[];
  ttlExpiresAt: string | null;
  hasActiveWindow: boolean;
}

/**
 * Read `ownerId`'s EXPLICIT current intent as visible to `context` (§7/§8/§31).
 * Reuses the same visibility-scoped, expiry-on-read window projection the
 * discovery_card variant uses, so a consumer weighting on explicit intent reads
 * exactly what that consumer would display. Never throws.
 */
export async function readVisibleExplicitIntent(
  sc: SupabaseClient,
  ownerId: string,
  context: PassportViewerContext,
  nowMs: number = Date.now(),
): Promise<ExplicitIntentRead> {
  const windows = await loadVisibleActiveWindows(sc, ownerId, context, nowMs);
  const openWindows = windows.filter((w) => w.openToPlans);
  const { intents, ttlExpiresAt } = intentFromWindows(windows);
  return { intents, ttlExpiresAt, hasActiveWindow: openWindows.length > 0 };
}

/** Union of intents across active windows, and the soonest expiry among them. */
function intentFromWindows(windows: AvailabilityWindow[]): { intents: string[]; ttlExpiresAt: string | null } {
  const seen = new Set<string>();
  const intents: string[] = [];
  let soonest = Number.POSITIVE_INFINITY;
  let soonestIso: string | null = null;
  for (const w of windows) {
    if (!w.openToPlans) continue; // §8: intent is a "want social invitations" signal
    for (const i of w.intents) {
      const key = String(i);
      if (!seen.has(key)) {
        seen.add(key);
        intents.push(key);
      }
    }
    const exp = effectiveExpiry(w);
    if (Number.isFinite(exp) && exp < soonest) {
      soonest = exp;
      soonestIso = new Date(exp).toISOString();
    }
  }
  return { intents: intents.slice(0, 8), ttlExpiresAt: soonestIso };
}

// ─────────────────────────────────────────────────────────────────────────────
// Variant builders (fresh objects — never spread the full projection)
// ─────────────────────────────────────────────────────────────────────────────

function toDiscoveryCard(
  full: PassportProjection,
  windowIntent: { intents: string[]; ttlExpiresAt: string | null } | null,
): DiscoveryCardProjection {
  const card: DiscoveryCardProjection = {
    variant: "discovery_card",
    userId: full.userId,
    viewerContext: full.viewerContext,
    identity: {
      userId: full.identity.userId,
      name: full.identity.name,
      handle: full.identity.handle,
      avatarUrl: full.identity.avatarUrl,
      verified: full.identity.verified,
      verificationLevel: full.identity.verificationLevel,
      homeCountry: full.identity.homeCountry, // home base deliberately omitted
      isOfficial: full.identity.isOfficial,
    },
    capabilities: { owner: full.capabilities.owner, actions: full.capabilities.actions },
    stats: full.stats,
    hasExplicitWindow: false,
  };

  if (full.restricted) {
    card.restricted = full.restricted;
    return card; // a restricted card carries identity + capabilities only
  }

  if (full.travelerState) {
    card.travelerState = {
      state: full.travelerState.state,
      label: full.travelerState.label,
      city: full.travelerState.city,
      expiresAt: full.travelerState.expiresAt,
    };
  }
  if (full.availability) {
    card.availability = {
      openToPlans: full.availability.openToPlans,
      socialAvailability: full.availability.socialAvailability,
      currentWindow: full.availability.currentWindow,
      expiresAt: full.availability.expiresAt,
      // weekly grid deliberately omitted from a person card
    };
  }

  // §8: explicit current intent wins over the assembler's generic tag intent.
  if (windowIntent && windowIntent.intents.length > 0) {
    card.intent = {
      current: windowIntent.intents,
      ttlExpiresAt: windowIntent.ttlExpiresAt,
      source: "explicit",
      explicit: true,
    };
    card.hasExplicitWindow = true;
  } else if (full.intent) {
    card.intent = {
      current: full.intent.current,
      ttlExpiresAt: full.intent.ttlExpiresAt,
      source: full.intent.source,
      explicit: false,
    };
  }

  if (full.trust) {
    card.trust = {
      label: full.trust.label,
      publicLevel: full.trust.publicLevel,
      confidence: full.trust.confidence,
      strengths: full.trust.strengths,
      // numeric score deliberately omitted from a person card (§9)
    };
  }
  if (full.sharedContext) card.sharedContext = full.sharedContext;
  return card;
}

function toTelegraphHeader(full: PassportProjection): TelegraphHeaderProjection {
  const header: TelegraphHeaderProjection = {
    variant: "telegraph",
    userId: full.userId,
    viewerContext: full.viewerContext,
    identity: {
      userId: full.identity.userId,
      name: full.identity.name,
      handle: full.identity.handle,
      avatarUrl: full.identity.avatarUrl,
      verified: full.identity.verified,
    },
    actions: {
      can_message: full.capabilities.actions.can_message,
      can_make_plan: full.capabilities.actions.can_make_plan,
      can_follow: full.capabilities.actions.can_follow,
    },
  };
  if (full.restricted) header.restricted = full.restricted;
  // Shared context only for a permitted, non-restricted relationship.
  if (!full.restricted && full.sharedContext) header.sharedContext = full.sharedContext;
  return header;
}

function toBuddyProjection(full: PassportProjection): BuddyProjection {
  const buddy: BuddyProjection = {
    variant: "buddy",
    userId: full.userId,
    viewerContext: full.viewerContext,
    identity: {
      userId: full.identity.userId,
      name: full.identity.name,
      handle: full.identity.handle,
      avatarUrl: full.identity.avatarUrl,
      verified: full.identity.verified,
      verificationLevel: full.identity.verificationLevel,
    },
    credentials: full.credentials.map((c) => ({ key: c.key, label: c.label, detail: c.detail, tier: c.tier })),
    stats: full.stats,
    capabilities: { owner: full.capabilities.owner, actions: full.capabilities.actions },
  };
  if (full.restricted) {
    buddy.restricted = full.restricted;
    buddy.credentials = [];
    return buddy;
  }
  if (full.trust) {
    buddy.trust = {
      label: full.trust.label,
      publicLevel: full.trust.publicLevel,
      confidence: full.trust.confidence,
      strengths: full.trust.strengths,
    };
  }
  if (full.availability) {
    buddy.availability = {
      openToPlans: full.availability.openToPlans,
      socialAvailability: full.availability.socialAvailability,
      currentWindow: full.availability.currentWindow,
      expiresAt: full.availability.expiresAt,
    };
  }
  return buddy;
}

function toSafetyProjection(full: PassportProjection): SafetyProjection {
  const safety: SafetyProjection = {
    variant: "safety",
    userId: full.userId,
    viewerContext: full.viewerContext,
    handle: full.identity.handle,
    verified: full.identity.verified,
    blocked: Boolean(full.restricted),
  };
  if (full.restricted) safety.restricted = full.restricted;
  return safety;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export interface ConsumerProjectionOptions extends BuildProjectionOptions {
  /** Injectable clock (tests) for window expiry evaluation. */
  nowMs?: number;
}

export type ConsumerProjectionFor<V extends PassportConsumerVariant> =
  V extends "discovery_card" ? DiscoveryCardProjection :
  V extends "telegraph" ? TelegraphHeaderProjection :
  V extends "buddy" ? BuddyProjection :
  V extends "safety" ? SafetyProjection :
  never;

/**
 * Build the consumer VARIANT of `ownerId`'s Passport as seen by `viewerId`
 * (null = public / unauthenticated). Returns null only when the owner has no
 * Passport at all (the assembler returned null); a blocked / unavailable viewer
 * still receives the variant's minimal restricted shape, never null.
 *
 * All privacy is applied by the single assembler; this function only narrows
 * the result to the consumer's TABLE 22 allow-list, and — for the
 * discovery_card variant — enriches `intent` from the §8 explicit-window domain.
 */
export async function buildConsumerProjection<V extends PassportConsumerVariant>(
  sc: SupabaseClient,
  variant: V,
  ownerId: string,
  viewerId: string | null,
  opts: ConsumerProjectionOptions = {},
): Promise<ConsumerProjectionFor<V> | null> {
  const full = await buildPassportProjection(sc, ownerId, viewerId, opts);
  if (!full) return null;

  if (variant === "discovery_card") {
    let windowIntent: { intents: string[]; ttlExpiresAt: string | null } | null = null;
    if (!full.restricted) {
      const windows = await loadVisibleActiveWindows(sc, ownerId, full.viewerContext, opts.nowMs ?? Date.now());
      windowIntent = intentFromWindows(windows);
    }
    return toDiscoveryCard(full, windowIntent) as ConsumerProjectionFor<V>;
  }
  if (variant === "telegraph") return toTelegraphHeader(full) as ConsumerProjectionFor<V>;
  if (variant === "buddy") return toBuddyProjection(full) as ConsumerProjectionFor<V>;
  return toSafetyProjection(full) as ConsumerProjectionFor<V>;
}
