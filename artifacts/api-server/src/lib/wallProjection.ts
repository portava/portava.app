/**
 * wallProjection — the canonical Wall projection contract.
 *
 * This module owns the SHAPES the Wall serves; it owns no truth. Every concrete
 * value that lands in one of these types is derived by a Wall service
 * (WallProjectionService, WallRankingService, FollowingFeedService,
 * LiveForYouService) FROM a canonical system (Posts, Postcards, Shared Moments,
 * Media, Social Graph, Live Intelligence, Places) AFTER the canonical privacy /
 * visibility / block / moderation gates have passed (spec §23/§24).
 *
 * Nothing here is a second source of truth: a WallProjection is a read-model of
 * a canonical object, addressed by `canonicalObjectId`, and the client always
 * follows an action back into the canonical surface (post viewer, postcard
 * viewer, map, place, trip) rather than treating the projection as the object.
 *
 * The Wall feed object model (spec §6):
 *
 *   type WallFeedObject =
 *     | SocialPostProjection
 *     | VideoProjection
 *     | PostcardProjection
 *     | SharedMomentProjection
 *     | SocialUpdateProjection
 *     | DiscoveryProjection
 *     | ContextualOpportunityProjection;
 *
 * These are DISCRIMINATED by `objectType`, so the client can preserve the
 * distinct identity of each (a Postcard is never a Post with a badge — spec §10).
 */

// ── Primitive Wall-facing value shapes ───────────────────────────────────────

/**
 * Visibility state carried to the client. This is the ALREADY-RESOLVED result of
 * the canonical visibility gate — it is never a gate input. A projection only
 * reaches the client after lib/postVisibility.ts (and the block / moderation
 * gates) admitted the viewer, so the value here is always one the viewer is
 * authorized to see. `public` is the only value that appears for discovery
 * (outside-the-follow-graph) objects.
 */
export type VisibilityState =
  | "public"
  | "followers"
  | "friends"
  | "trip"
  | "circle"
  | "private";

/**
 * A public, block-and-privacy-safe reference to a person. NEVER carries exact
 * location, private handle aliases, contact info, or any field the viewer is not
 * authorized to see (spec §7/§23). The creator/person is visually primary on
 * social objects, so this is deliberately a lean identity, not a profile dump.
 */
export interface PublicActorRef {
  userId: string;
  /** Presented (visibility-resolved) display name. */
  displayName: string;
  handle?: string | null;
  avatarUrl?: string | null;
  /** True only when RAB service identity is being surfaced (spec §19); the
   *  person identity remains primary and the commercial identity is secondary. */
  isBuddy?: boolean;
  buddyRole?: string | null;
}

/**
 * A public, coarse reference to a place. Coordinates here are the PUBLIC place
 * coordinate (a venue), never an inferred person location and never a protected
 * / approximate-only Gem coordinate (spec §20/§23). May be absent — a normal
 * social post is allowed to carry no place at all (spec §7).
 */
export interface PublicPlaceRef {
  placeId: string;
  name: string;
  city?: string | null;
  country?: string | null;
  /** Public venue coordinate only. Omitted for protected / coarse-only places. */
  lat?: number | null;
  lng?: number | null;
}

/** One display-media descriptor. `processing` renders a placeholder (spec §34 /
 *  TABLE 5: media processing pending must not break the feed). */
export interface DisplayMedia {
  mediaId: string;
  kind: "image" | "video";
  url?: string | null;
  thumbnailUrl?: string | null;
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
  /**
   * Video only. An ADVISORY server note, never a command (spec §11/§36).
   *
   *   `true`             the server has verified this media is a ready, playable
   *                      video — i.e. autoplay is technically possible. It does
   *                      NOT ask for autoplay: the server never forces autoplay
   *                      on (§11).
   *   `false` / absent   NO server-side opinion. It is NOT a veto.
   *
   * AUTOPLAY IS CLIENT POLICY, FULL STOP. Viewport visibility, reduced motion
   * (§36) and the user's autoplay preference are resolved on the device and are
   * the only inputs that decide (travel-buddy-standalone
   * features/wall/services/videoAutoplayPolicy). This field used to be stamped
   * `false` on EVERY video while the client read `false` as a hard veto, which
   * made the shipped inline-Wall autoplay unreachable; the two halves of the
   * contract now say the same thing.
   */
  autoplayEligible?: boolean;
  processing?: boolean;
}

/**
 * The server's autoplay note for one media descriptor — the ONE place the value
 * is decided, so the loaders cannot drift apart (they did: four sites each
 * stamped a blanket `false`).
 *
 * A video the server is about to publish in a projection has already cleared the
 * loader's readiness/URL checks, so the honest note is "playable" — `true`. A
 * still image has no autoplay concept at all, so the field is omitted. Neither
 * value commands the client: `true` only says autoplay is possible, and the
 * client's own policy still has to allow it.
 */
export function serverAutoplayHint(kind: DisplayMedia["kind"]): true | undefined {
  return kind === "video" ? true : undefined;
}

/**
 * Freshness state of a live/contextual fact. Ordered strongest→weakest. Live
 * intelligence NEVER presents a `stale` fact as current (spec §4/§23) — a stale
 * fact degrades or disappears rather than being shown with a live label.
 */
export type FreshnessState = "live" | "recent" | "aging" | "stale" | "unknown";

// ── WallAction ───────────────────────────────────────────────────────────────

/**
 * The optional real-world actions a Wall object can lead to (spec §2/§7/§41).
 * Actions are OPTIONAL and additive — they are never forced onto every object,
 * and their absence is the common case for a plain social post.
 */
export type WallActionType =
  | "open_object" // open the canonical object (post/postcard/video/moment viewer)
  | "see_place"
  | "save"
  | "add_to_trip"
  | "join"
  | "message"
  | "open_map"
  | "ask_compass"
  | "book_buddy"
  | "see_who" // social presence disclosure ("3 people you follow were here")
  | "explore" // hidden gem / discovery
  | "follow"
  | "see_live"; // the single Live For You entry action (spec §4)

export interface WallAction {
  type: WallActionType;
  label: string;
  /** Canonical target kind the action resolves into (post/place/trip/moment/…). */
  targetType?: string;
  targetId?: string;
  /** Opaque, non-sensitive params for the client to pass into the target
   *  surface. Never carries private coordinates or protected access info. */
  params?: Record<string, unknown>;
}

// ── Context Thread (spec §8/§9) ──────────────────────────────────────────────

/**
 * The Context Thread is the primary bridge from a social object to Portava's
 * surrounding functions (spec §8). It is a compact attachment BENEATH a feed
 * object and only renders when a contextual fact or action is useful enough to
 * justify the extra UI (spec §9 — the default outcome is often false).
 *
 * Defined here so a later agent can implement ContextThreadService (spec TABLE 2)
 * against a stable shape. WallProjectionService populates `contextThread` on a
 * WallProjection ONLY when that service says the §9 gate passed; this module does
 * not implement the gate.
 */
export type ContextThreadKind =
  | "live_place"
  | "trip_relevance"
  | "hidden_gem"
  | "social_presence"
  | "buddy"
  | "map"
  | "memory"
  | "compass";

export interface ContextThread {
  kind: ContextThreadKind;
  label: string;
  freshness?: FreshnessState;
  /** 0–1 confidence in the contextual fact. Below policy.minConfidence the
   *  §9 gate suppresses the thread entirely. */
  confidence?: number;
  /** Short human-readable "why" (spec §8 examples). Never asserts inference as
   *  verified fact (spec §21). */
  reason?: string;
  action?: WallAction;
}

// ── Ranking metadata ─────────────────────────────────────────────────────────

/**
 * Per-item ranking provenance for For You. Deliberately does NOT expose the raw
 * composite score or the feature vector to the client (spec §37 — prevent
 * ranking manipulation; and the analytics privacy rule). It carries only the
 * rank session/version (so the client can reason about page continuity, spec
 * §28) and an optional non-sensitive explanation key ("followed_by", "trip_fit",
 * "missed", …) that powers the "why am I seeing this" affordance (spec §13).
 */
export interface WallRankingMetadata {
  /** Rank session token — stable across the pages of one feed session (§28). */
  session: string;
  /** Rank algorithm/config version — a change starts a new session (§28). */
  version: string;
  /** 0-based position within the ranked session (for diagnostics, not a score). */
  rank?: number;
  /** Non-sensitive discovery reason (spec §13). */
  explanation?: string;
}

// ── WallProjection + the WallFeedObject union (spec §6) ──────────────────────

/**
 * The base shape every Wall feed object shares (spec §6). Concrete object types
 * narrow `objectType` and may add their own presentation fields.
 */
export interface WallProjectionBase {
  projectionId: string;
  objectType: WallObjectType;
  /** The canonical object this projects. The client follows actions back to THIS
   *  id in the canonical surface; the projection is never the source of truth. */
  canonicalObjectId: string;
  actor?: PublicActorRef;
  /** Publication time — the Wall's chronological spine (spec §16/§28). */
  publishedAt: string;
  /** Experience time — when the thing HAPPENED, when it differs from publishedAt
   *  (a Postcard, a delayed-location post, a memory). Two clocks, spec §16. */
  experienceAt?: string;
  visibility: VisibilityState;
  media?: DisplayMedia[];
  text?: string;
  place?: PublicPlaceRef;
  /** Rendered only when the §9 gate passed (populated by ContextThreadService). */
  contextThread?: ContextThread;
  actions: WallAction[];
  ranking?: WallRankingMetadata;
}

export type WallObjectType =
  | "social_post"
  | "video"
  | "postcard"
  | "shared_moment"
  | "social_update"
  | "discovery"
  | "contextual_opportunity";

/** A normal social post (photo/text). The creator remains visually primary. */
export interface SocialPostProjection extends WallProjectionBase {
  objectType: "social_post";
}

/** Inline-playable video (spec §11). */
export interface VideoProjection extends WallProjectionBase {
  objectType: "video";
  /** Inline playback in the Wall — never a mandatory fullscreen takeover. */
  inlinePlayback: true;
}

/**
 * A Postcard (spec §10) — a first-class, travel-story social object with a
 * DISTINCT presentation. It is never a Post with a badge. `experienceAt` and
 * `place` may be prominent; the story presentation stays primary even when it
 * carries contextual actions.
 */
export interface PostcardProjection extends WallProjectionBase {
  objectType: "postcard";
  storyPresentation: true;
}

/** A Shared Moment (spec §12) — real-world overlap surfaced as a discovered
 *  social memory, not a location-tracking notification. Visibility follows the
 *  underlying consent/Shared Moment policy. */
export interface SharedMomentProjection extends WallProjectionBase {
  objectType: "shared_moment";
  /** Coarse participant labels the viewer is authorized to see (spec §12/§23);
   *  never precise co-location or private-circle leakage. */
  participants?: PublicActorRef[];
}

/** A light social text/update object (spec §7 — the feed needs light objects
 *  for rhythm, not a uniform stack of dense media cards). */
export interface SocialUpdateProjection extends WallProjectionBase {
  objectType: "social_update";
}

/**
 * A discovery insertion (spec §13) — content reaching OUTSIDE the follow graph.
 * It MUST be visually identifiable and explainable (spec §7/§13): `discoveryReason`
 * says why it is relevant (followed-by, trip relevance, interest, missed,
 * hidden-gem) rather than being a naked directory listing.
 */
export interface DiscoveryProjection extends WallProjectionBase {
  objectType: "discovery";
  discoveryReason: string;
}

/**
 * A contextual opportunity (spec §6) — a Buddy dispatch, an "I'm Around"
 * availability, an event, etc. surfaced sparingly when socially/contextually
 * relevant (spec §19). Commercial/service identity is secondary to person
 * identity; precise Buddy coordinates are never exposed (approved zone only).
 */
export interface ContextualOpportunityProjection extends WallProjectionBase {
  objectType: "contextual_opportunity";
  opportunityKind: "buddy_dispatch" | "buddy_around" | "event" | "trip_signal";
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

// ── Live For You (spec §4 / TABLE 0) ─────────────────────────────────────────

/**
 * The kinds of live object the strip may show (spec TABLE 0). Each has a required
 * condition enforced upstream (fresh + confident + user-relevant; time-valid;
 * disclosure policy; viewer-authorized granularity; service-eligible;
 * trip-scoped). The strip NEVER shows a generic city-wide firehose (spec §4).
 */
export type LiveObjectType =
  | "place_state"
  | "event_state"
  | "hidden_gem"
  | "social_presence"
  | "buddy"
  | "trip_signal";

/**
 * One item in the compact, bounded (2–4) Live For You strip (spec §4). Carries
 * only decision-exposure fields — NO contributor ids, raw coordinates, exact
 * cohort counts or private-location leakage (spec §4/§23). Derived entirely from
 * the canonical Live Intelligence read path (lib/liveClaimRead.ts).
 */
export interface LiveForYouItem {
  /** The live snapshot / claim id — the provenance the "why" surface points at. */
  id: string;
  liveObjectType: LiveObjectType;
  /** The canonical subject (place/zone) this live fact is about. */
  subjectId: string;
  subject?: PublicPlaceRef;
  label: string;
  freshness: FreshnessState;
  /** 0–1; may be null when the source class may not present a confidence badge. */
  confidence?: number | null;
  /** 'live' only when the evidence qualifies; otherwise 'emerging' (§ liveClaimRead). */
  state: "live" | "emerging";
  /**
   * IG §10 conflict state of the claim behind the item. 'material' ⇒ `state`
   * is 'emerging' (never 'live') and the client renders "Reports differ"
   * instead of an Emerging/Live label. Absent ⇒ 'none'.
   */
  conflictState?: "none" | "minor" | "material";
  observedAt: string;
  /** Freshness horizon — after this the client degrades to unknown (spec §31). */
  validUntil: string;
  action?: WallAction;
}

// ── Session intent (spec §17) ────────────────────────────────────────────────

/**
 * A structured, TEMPORARY Wall session intent parsed from typed/voice input via
 * the platform-wide Global Input Intelligence layer (spec §17). Canonical
 * entities selected from typeahead become structured FILTERS, not raw strings;
 * residual keywords stay in `keywords`. It steers For You for this session only
 * and NEVER changes a saved preference unless the user explicitly saves it.
 * Clearing the intent restores the prior Wall state.
 */
export type StructuredIntentFilterKind =
  | "place"
  | "city"
  | "category"
  | "interest"
  | "person"
  | "mode"; // 'just friends', 'random', …

export interface StructuredIntentFilter {
  kind: StructuredIntentFilterKind;
  /** Canonical entity id when the term resolved to a known entity (spec §17). */
  entityId?: string | null;
  label: string;
  value?: string | null;
}

export interface StructuredIntent {
  /** Structured canonical filters (never raw strings, spec §17). */
  filters: StructuredIntentFilter[];
  /** Residual free-text keywords that did not resolve to a canonical entity. */
  keywords: string[];
  /** Always true — this intent is session-scoped and non-persistent by default. */
  sessionScoped: true;
  createdAt: string;
}

// ── Wall API response contract (spec §27) ────────────────────────────────────

export type WallMode = "for_you" | "following";

/**
 * A Wall read lane that can fail on its own (spec §34 graceful degradation).
 *
 * §34 says a failing subsystem must cost the feed that subsystem and nothing
 * more — it does NOT say the failure may be invisible. supabase-js resolves a
 * rejected query with `{ data: null, error }` rather than throwing, so a lane
 * written as `const { data } = await q` degrades to `[]` with no log line and no
 * signal on the wire: a permission error, a dropped column or an RLS change
 * renders as a quiet feed, and in Following mode it renders as the "you're all
 * caught up" TRUST signal (an empty spine satisfies `rows < CANDIDATE_FETCH`).
 *
 * These names are what a lane reports when its canonical read FAILED, as
 * distinct from returning no rows. Empty-and-fine carries no lane at all.
 */
export type WallLane =
  /** The viewer's follow graph (`user_follows`). Unreadable ≠ follows nobody. */
  | "follow_graph"
  /** The Post spine (`posts`) — the feed's primary candidate set. */
  | "spine"
  /** Postcard candidates (§10). */
  | "postcards"
  /** Video / media candidates (§11). */
  | "media"
  /** Shared Moment candidates (§12). */
  | "moments"
  /** RAB contextual opportunities (§19). */
  | "opportunities"
  /** The eligibility / block / visibility gate + projection (§23/§24). */
  | "projection"
  /** The Live For You strip (§4). Its own route's ENTIRE answer, where an
   *  empty strip is the most ordinary honest result there is — which is
   *  precisely why a failed one has to be able to say so. */
  | "live"
  /** The Quick Media / Stories row (§18). */
  | "quick_media";

export interface WallResponse {
  mode: WallMode;
  sessionIntent?: StructuredIntent;
  liveForYou: LiveForYouItem[];
  items: WallProjection[];
  nextCursor?: string;
  /** Following only: true when the viewer has reached the end of eligible
   *  followed content (spec §27 caught-up / TABLE 6).
   *
   *  NEVER true when a lane in `degraded` could have contributed followed
   *  content: "you have seen everything" and "we could not look" are different
   *  facts and the second one must not wear the first one's badge. */
  caughtUp?: boolean;
  /**
   * Lanes whose canonical read FAILED on this request (spec §34).
   *
   * ABSENT means every lane answered. So `items: []` with no `degraded` is an
   * honestly empty feed, and `items: []` WITH `degraded` is an outage — the
   * distinction a client (or an operator reading one response) previously had
   * no way to make. Additive and optional: a client that ignores it sees
   * exactly the §34 behaviour it saw before.
   */
  degraded?: WallLane[];
  generatedAt: string;
}
