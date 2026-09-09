/**
 * wallProjection (client mirror) — the Wall projection contract as consumed by
 * the mobile client.
 *
 * These shapes MIRROR the canonical server contract at
 * artifacts/api-server/src/lib/wallProjection.ts (Wall spec §6/§27). They are
 * deliberately duplicated here rather than imported: the client must never
 * reach across the api-server package boundary. Keep the two in sync by shape,
 * not by import.
 *
 * Nothing here is a source of truth. A WallProjection is a read-model of a
 * canonical object addressed by `canonicalObjectId`; the client always follows
 * an action back into the canonical surface (post viewer, postcard viewer, map,
 * place, trip) rather than treating the projection as the object.
 */

import type { ContextThread } from './contextThread.ts';
import type { LiveForYouItem } from './liveForYou.ts';

// ── Primitive Wall-facing value shapes ───────────────────────────────────────

/** Already-resolved visibility label (never a gate input on the client). */
export type VisibilityState =
  | 'public'
  | 'followers'
  | 'friends'
  | 'trip'
  | 'circle'
  | 'private';

/** A public, block-and-privacy-safe reference to a person. */
export interface PublicActorRef {
  userId: string;
  displayName: string;
  handle?: string | null;
  avatarUrl?: string | null;
  /** True only when RAB service identity is being surfaced (spec §19). */
  isBuddy?: boolean;
  buddyRole?: string | null;
}

/** A public, coarse reference to a place (public venue coordinate only). */
export interface PublicPlaceRef {
  placeId: string;
  name: string;
  city?: string | null;
  country?: string | null;
  lat?: number | null;
  lng?: number | null;
}

/** One display-media descriptor. `processing` renders a placeholder (spec §34). */
export interface DisplayMedia {
  mediaId: string;
  kind: 'image' | 'video';
  url?: string | null;
  thumbnailUrl?: string | null;
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
  /**
   * Video only. Advisory server note, never a command (§11/§36): `true` = the
   * media is a ready, playable video; `false`/absent = NO server opinion, which
   * is NOT a veto. Autoplay is decided entirely by client policy
   * (services/videoAutoplayPolicy — viewport, reduced motion, user setting).
   */
  autoplayEligible?: boolean;
  processing?: boolean;
}

/** Freshness state of a live/contextual fact. Ordered strongest→weakest. */
export type FreshnessState = 'live' | 'recent' | 'aging' | 'stale' | 'unknown';

// ── Truth metadata (Sensing §108 / §5.1) ─────────────────────────────────────

/**
 * The epistemic class of a SERVER-BUILT state the Wall renders. Mirrors
 * artifacts/api-server/src/lib/wallProjection.ts `WallTruthClass`.
 *
 * The client NEVER derives this — it is carried on the wire precisely so the
 * device does not have to reason about world truth (Sensing §6: "feature clients
 * and React components must not independently calculate crowd, vibe, safety,
 * opportunity, experience value or world-change state"). The client's only job
 * is to render a prediction differently from an observation (§108).
 */
export type WallTruthClass =
  | 'observed'
  | 'corroborated'
  | 'inferred'
  | 'predicted'
  | 'conflicting'
  | 'stale'
  | 'unknown';

/** Coarse independent-evidence bucket. `unknown` is NOT "none" (§108). */
export type WallCoverage = 'few' | 'several' | 'many' | 'unknown';

/**
 * Truth classes that may be rendered as a current observation. A `predicted`,
 * `inferred`, `stale` or `unknown` state must be visibly distinguishable from an
 * observed one — that is the whole point of §108, and it is a pure function of
 * the carried value, not a re-derivation of the truth behind it.
 */
export function truthClassMayRenderAsObservation(cls: WallTruthClass | undefined): boolean {
  return cls === 'observed' || cls === 'corroborated' || cls === 'conflicting';
}

/**
 * The short, non-colour-dependent qualifier the UI puts next to a state that is
 * NOT an observation (spec §36: live state must not rely on colour alone; §108:
 * prediction must never render indistinguishably from observation). Returns null
 * for an observed/corroborated state, which needs no qualifier.
 */
export function truthQualifierLabel(cls: WallTruthClass | undefined): string | null {
  switch (cls) {
    case 'predicted':
      return 'Scheduled';
    case 'inferred':
      return 'Inferred';
    case 'stale':
      return 'Out of date';
    case 'unknown':
      return 'Unconfirmed';
    default:
      return null;
  }
}

// ── WallAction ───────────────────────────────────────────────────────────────

export type WallActionType =
  | 'open_object'
  | 'see_place'
  | 'save'
  | 'add_to_trip'
  | 'join'
  | 'message'
  | 'open_map'
  | 'ask_compass'
  | 'book_buddy'
  | 'see_who'
  | 'explore'
  | 'follow'
  | 'see_live';

export interface WallAction {
  type: WallActionType;
  label: string;
  targetType?: string;
  targetId?: string;
  params?: Record<string, unknown>;
}

// ── Ranking metadata ─────────────────────────────────────────────────────────

export interface WallRankingMetadata {
  /** Rank session token — stable across the pages of one feed session (§28). */
  session: string;
  /** Rank algorithm/config version — a change starts a new session (§28). */
  version: string;
  rank?: number;
  /** Non-sensitive discovery reason (spec §13). */
  explanation?: string;
}

// ── WallProjection + the WallFeedObject union (spec §6) ──────────────────────

export type WallObjectType =
  | 'social_post'
  | 'video'
  | 'postcard'
  | 'shared_moment'
  | 'social_update'
  | 'discovery'
  | 'contextual_opportunity';

export interface WallProjectionBase {
  projectionId: string;
  objectType: WallObjectType;
  canonicalObjectId: string;
  actor?: PublicActorRef;
  /** Publication time — the Wall's chronological spine (spec §16/§28). */
  publishedAt: string;
  /** Experience time — when the thing HAPPENED, when it differs from publishedAt. */
  experienceAt?: string;
  visibility: VisibilityState;
  media?: DisplayMedia[];
  text?: string;
  place?: PublicPlaceRef;
  /** Rendered only when the §9 gate passed (populated server-side). */
  contextThread?: ContextThread;
  /**
   * Server-resolved save state for this viewer (spec §2 "save"). The Wall shows
   * this value; it never keeps the bookmark in component state, so a save
   * survives a remount and a scroll out of the render window.
   */
  viewerSaved?: boolean;
  actions: WallAction[];
  ranking?: WallRankingMetadata;
}

export interface SocialPostProjection extends WallProjectionBase {
  objectType: 'social_post';
}

export interface VideoProjection extends WallProjectionBase {
  objectType: 'video';
  inlinePlayback: true;
}

export interface PostcardProjection extends WallProjectionBase {
  objectType: 'postcard';
  storyPresentation: true;
}

export interface SharedMomentProjection extends WallProjectionBase {
  objectType: 'shared_moment';
  participants?: PublicActorRef[];
}

export interface SocialUpdateProjection extends WallProjectionBase {
  objectType: 'social_update';
}

export interface DiscoveryProjection extends WallProjectionBase {
  objectType: 'discovery';
  discoveryReason: string;
}

export interface ContextualOpportunityProjection extends WallProjectionBase {
  objectType: 'contextual_opportunity';
  opportunityKind: 'buddy_dispatch' | 'buddy_around' | 'event' | 'trip_signal';
}

export type WallProjection =
  | SocialPostProjection
  | VideoProjection
  | PostcardProjection
  | SharedMomentProjection
  | SocialUpdateProjection
  | DiscoveryProjection
  | ContextualOpportunityProjection;

/** Alias matching the spec §6 name. */
export type WallFeedObject = WallProjection;

// ── Session intent (spec §17) ────────────────────────────────────────────────

export type StructuredIntentFilterKind =
  | 'place'
  | 'city'
  | 'category'
  | 'interest'
  | 'person'
  | 'mode';

export interface StructuredIntentFilter {
  kind: StructuredIntentFilterKind;
  entityId?: string | null;
  label: string;
  value?: string | null;
}

export interface StructuredIntent {
  filters: StructuredIntentFilter[];
  keywords: string[];
  sessionScoped: true;
  createdAt: string;
}

// ── Wall API response contract (spec §27) ────────────────────────────────────

export type WallMode = 'for_you' | 'following';

export interface WallResponse {
  mode: WallMode;
  sessionIntent?: StructuredIntent;
  liveForYou: LiveForYouItem[];
  items: WallProjection[];
  nextCursor?: string;
  /** Following only: true when the viewer has reached the end of eligible content. */
  caughtUp?: boolean;
  generatedAt: string;
}

// ── Stories / Quick Media (spec §18) ─────────────────────────────────────────

/**
 * One short-lived media item from a followed person (GET /wall/quick-media).
 * `media.url` is the STORED storage reference — private-bucket bytes are
 * signed by the existing hydration path (CachedImage → useHydratedMedia), so
 * the row never binds it to a bare image. `postId` is the canonical post the
 * item opens into (the projection is never the object, spec §24).
 */
export interface QuickMediaItem {
  id: string;
  ownerUserId: string;
  actor: PublicActorRef;
  media: DisplayMedia;
  postId: string;
  createdAt: string;
  /** Past this instant the item is gone (24 h from createdAt, §18). */
  expiresAt: string;
}

export interface QuickMediaResponse {
  items: QuickMediaItem[];
  generatedAt: string;
}
