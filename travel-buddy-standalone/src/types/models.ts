/**
 * Travel Buddy — typed data contracts.
 * Shaped like future backend JSON responses so swapping mock -> API is a
 * fetch change, not a refactor. IDs are strings, timestamps are ISO strings.
 */

export type ID = string;
export type ISODate = string;

export type TravelStyle =
  | 'solo'
  | 'couple'
  | 'group'
  | 'business';

export type Interest =
  | 'nightlife'
  | 'beach'
  | 'food'
  | 'luxury'
  | 'backpacking'
  | 'culture'
  | 'adventure'
  | 'shopping'
  | 'photography'
  | 'business'
  | 'dating'
  | 'wellness'
  | 'events';

export type PostCategory =
  | 'hotel'
  | 'food'
  | 'nightlife'
  | 'beach'
  | 'activity'
  | 'transport'
  | 'airport'
  | 'visa'
  | 'safety'
  | 'tip'
  | 'question';

/** Decides which card renders the post. */
export type PostKind =
  | 'hero' // full-bleed editorial overlay
  | 'standard' // image-first, caption below
  | 'question' // text-heavy, no overlay
  | 'itinerary'; // trip cover + meta + Add to Trip

export type CostLevel = 1 | 2 | 3 | 4; // $ .. $$$$

/** ISO 639-1 language codes supported by Telegraph auto-translation. */
export type DefaultLanguage =
  | 'en' | 'es' | 'fr' | 'de' | 'ja' | 'ko' | 'zh' | 'pt' | 'it' | 'ru'
  | 'ar' | 'th' | 'vi' | 'id' | 'tl' | 'sv' | 'nl' | 'pl' | 'tr' | 'hi';

export interface User {
  id: ID;
  handle: string;
  name: string;
  avatarUrl: string;
  homeCity: string;
  homeCountry: string;
  currentCity?: string;
  travelStyle: TravelStyle;
  interests: Interest[];
  verified: boolean;
  openToMeet: boolean;
  isPrivate: boolean;
  followers: number;
  following: number;
  bio?: string;
  defaultLanguage?: DefaultLanguage;
}

export interface Destination {
  id: ID;
  city: string;
  country: string;
  slug: string;
  coverUrl: string;
  blurb: string;
  travelerCount: number;
  trending: boolean;
}

export interface PostMedia {
  id: ID;
  url: string;
  /**
   * Feed-sized derivative (~1500px longest edge), or NULL when none exists.
   * See PostcardMediaItem.feed_url — same contract, camelCase surface.
   */
  feedUrl?: string | null;
  kind: 'image' | 'video';
  /** 0..1 estimated brightness; >0.62 triggers caption-below contrast fallback. */
  brightness?: number;
  /** Raw stamp-overlay jsonb passthrough — validate via parseStampOverlay(). */
  stampOverlay?: unknown;
}

export interface Post {
  id: ID;
  kind: PostKind;
  category: PostCategory;
  author: User;
  destination: Pick<Destination, 'id' | 'city' | 'country' | 'slug'>;
  title?: string; // hero/itinerary/question headline
  caption?: string;
  media: PostMedia[];
  rating?: number; // 1..5 for reviews
  costLevel?: CostLevel;
  bestFor?: Interest[];
  safetyNote?: boolean;
  createdAt: ISODate;
  likeCount: number;
  commentCount: number;
  saveCount: number;
  liked?: boolean;
  saved?: boolean;
  // itinerary-only
  dayCount?: number;
  // media filter metadata (optional; present on posts created after filter system shipped)
  filterId?: string;
  filterIntensity?: number;
  mediaType?: string;
  /** Saved @mention annotations from the `tags` table — positioned spans for RichText. */
  tags?: Array<{ type: 'user'; id: string; matchToken: string; startChar: number; endChar: number; isBlocked?: boolean; isDeleted?: boolean }>;
  /** Saved #hashtag annotations from `hashtag_usage` — positioned spans for RichText. */
  hashtagUsages?: Array<{ slug: string; hashtagId: string; startChar: number; endChar: number; isBlocked?: boolean }>;
}

export interface Comment {
  id: ID;
  postId: ID;
  author: User;
  body: string;
  createdAt: ISODate;
  likeCount: number;
}

export interface Trip {
  id: ID;
  title: string;
  destination: Pick<Destination, 'id' | 'city' | 'country' | 'slug'>;
  coverUrl: string;
  startDate?: ISODate;
  endDate?: ISODate;
  collaborators: User[];
  savedPostIds: ID[];
  dayCount: number;
  isPublic: boolean;
}

export interface Conversation {
  id: ID;
  participants: User[];
  lastMessage: string;
  lastAt: ISODate;
  unread: number;
}

export interface Message {
  id: ID;
  conversationId: ID;
  senderId: ID;
  body: string;
  createdAt: ISODate;
}

export type NotificationKind =
  | 'like'
  | 'comment'
  | 'follow'
  | 'message'
  | 'answer'
  | 'nearby'
  | 'trend'
  | 'tripReminder'
  | 'aiSuggestion'
  | 'meetup';

export interface AppNotification {
  id: ID;
  kind: NotificationKind;
  actor?: User;
  text: string;
  createdAt: ISODate;
  read: boolean;
}

/** AI assistant reply, social-first: best pick + why + social proof + next action. */
export interface AiRecommendation {
  id: ID;
  bestPick: string;
  why: string;
  /** Override the "Why" section label (e.g. "Day 1" for itinerary mode). */
  whyLabel?: string;
  socialProof: string;
  /** Override the "Travelers are saying" section label (e.g. "Day 2"). */
  socialProofLabel?: string;
  tradeoff?: string;
  /** Override the "Tradeoff" section label (e.g. "Day 3"). */
  tradeoffLabel?: string;
  usedPostIds: ID[];
  nextActions: AiAction[];
}

export type AiAction =
  | { label: 'Save answer'; kind: 'save' }
  | { label: 'Add to trip'; kind: 'addTrip' }
  | { label: 'Create post'; kind: 'createPost' }
  | { label: 'Ask community'; kind: 'askCommunity' }
  | { label: 'Build itinerary'; kind: 'buildItinerary' };

// ── Compass AI Buddy — Phase 1 types ─────────────────────────────────────────

export type CompassQuickActionType =
  | 'addTrip' | 'buildItinerary' | 'askCommunity' | 'explore'
  | 'viewEvent' | 'viewPlace' | 'startPoll' | 'shareTip'
  | 'openMap' | 'viewPassport' | 'findBuddy' | 'viewTrips';

export interface CompassQuickAction {
  label:      string;
  actionType: CompassQuickActionType;
  params?:    Record<string, unknown>;
}

export interface CompassAskPayload {
  type:         'recommendation' | 'itinerary';
  picks?:       Array<{ title: string; category?: string; why?: string; priceLevel?: string }>;
  primaryPick?: number;
  destination?: string;
  days?:        Array<{ label: string; highlights: string[] }>;
}

/**
 * Phase-1 Compass ask response.
 * Replaces the legacy AiRecommendation shape from the old /compass/ask endpoint.
 */
export interface CompassAskResponse {
  conversationId:  string | null;
  message:         string;
  payload:         CompassAskPayload | null;
  quickActions:    CompassQuickAction[];
  promptVersion:   string;
  intent?:         { intent: string; confidence: number };
  fallback?:       boolean;
  fallbackReason?: string;
}

export interface ChatMessage {
  id: ID;
  role: 'user' | 'assistant';
  text: string;
  recommendation?: AiRecommendation;
}

/* ───────────────────────────────────────────────────────────────────────
 * Telegraph — unified message + AI recommendation layer
 * Structured message types for user DMs, translations, AI suggestions,
 * activity invites, plan confirmations, and system notices.
 * ─────────────────────────────────────────────────────────────────────── */

export type TelegraphMessageKind =
  | 'user_message'
  | 'translated_user_message'
  | 'ai_activity_recommendation'
  | 'activity_invite'
  | 'add_to_plan_confirmation'
  | 'system_notice';

export type TranslationStatus =
  | 'not_needed'   // sender + recipient speak same language
  | 'pending'      // translation in progress
  | 'done'         // translation complete, translatedText available
  | 'failed';      // translation failed — showing originalText

export type TelegraphPriceLevel = 'free' | '$' | '$$' | '$$$' | '$$$$';

/** Minimal hashtag span used for RichText rendering (compatible with RichTextHashtag). */
export interface HashtagSpan {
  slug: string;
  hashtagId?: string;
  startChar: number;
  endChar: number;
  isBlocked?: boolean;
}

/** Minimal @mention span used for RichText rendering (compatible with RichTextTag). */
export interface TagSpan {
  type: 'user';
  id: string;
  matchToken: string;
  startChar: number;
  endChar: number;
  isBlocked?: boolean;
}

/** An AI-generated activity card surfaced inside a Telegraph thread. */
export interface TelegraphActivityRecommendation {
  id: ID;
  title: string;
  category: PostCategory;
  reason: string;            // why it matches the traveler's profile/context
  locationContext: string;   // "1.2 km from Ayala Mall"
  estimatedTime: string;     // "2–3 hours"
  priceLevel: TelegraphPriceLevel;
  imageUrl?: string | null;
  tripId?: ID;               // if "Add to Trip" should target a specific trip
  activityId?: ID;           // attached activity entity (future)
  /** Positioned #hashtag spans in the `reason` text, resolved server-side by Telegraph. */
  hashtagSpans?: HashtagSpan[];
  /** Positioned @mention spans in the `reason` text, permission-filtered server-side. */
  tagSpans?: TagSpan[];
}

/**
 * The canonical Telegraph message. All six kinds share this shape; only
 * some fields are populated depending on kind.
 */
export interface TelegraphMessage {
  id: ID;
  kind: TelegraphMessageKind;

  senderId: ID;
  recipientId: ID;

  // Text (user_message / translated_user_message)
  originalText?: string;
  translatedText?: string;
  sourceLanguage?: DefaultLanguage;
  targetLanguage?: DefaultLanguage;
  translationStatus?: TranslationStatus;

  // Context
  tripId?: ID;
  attachedActivityId?: ID;

  // ai_activity_recommendation
  recommendation?: TelegraphActivityRecommendation;
  recommendationReason?: string;

  // system_notice
  noticeText?: string;

  // activity_invite
  activityTitle?: string;
  activityTime?: ISODate;
  inviteStatus?: 'pending' | 'accepted' | 'declined';

  // add_to_plan_confirmation
  planItemTitle?: string;
  planConfirmed?: boolean;

  createdAt: ISODate;
}

/** Conversation enriched with Telegraph metadata. */
export interface TelegraphConversation {
  id: ID;
  participants: User[];
  lastMessage: string;
  lastAt: ISODate;
  unread: number;
  hasActiveRecommendation?: boolean;
  tripId?: ID;
}

/* ───────────────────────────────────────────────────────────────────────
 * Passport expansion (product-depth layer). Contracts only — mock-backed
 * until the backend lands. New surfaces (Plans, Trust, Circle) will share
 * these shapes so the UI consumes them through hooks later.
 * ─────────────────────────────────────────────────────────────────────── */

export type StampKind =
  | 'city'        // visited a city
  | 'plan'        // joined a plan
  | 'gem'         // found a hidden gem
  | 'safe'        // completed a safe meetup / Safe Return
  | 'host'        // hosted an experience
  | 'perk';       // unlocked a perk

/**
 * Provenance treatment of a stamp (spec §12 / TABLE 16).
 *   'verified'   — derived from canonical provenance (system/trip/event/partner/
 *                  admin). Only these may wear the verified treatment.
 *   'reported'   — a self-reported claim by the traveler; not verified.
 *   'decorative' — cosmetic / no provenance. Never impersonates verification.
 * §12 hard rule: reported/decorative stamps must never visually impersonate a
 * verified stamp, so the default when provenance is unknown is 'decorative'.
 */
export type StampVerification = 'decorative' | 'reported' | 'verified';

export interface PassportStamp {
  id: ID;
  kind: StampKind;
  label: string;        // "CEBU", "SAFE MEETUP", "FIRST HOST"
  sublabel?: string;    // "PH · 2026", "x3"
  earnedAt: ISODate;
  locked?: boolean;     // show as not-yet-earned (faint)
  /**
   * Provenance treatment (§12). Omitted on legacy stamps with no known
   * provenance — the UI treats an absent value as 'decorative' so an
   * unverified stamp can never accidentally read as verified.
   */
  verification?: StampVerification;
  /** AI-generated universal stamp artwork image URL (from the stamp definition). */
  universalArtworkUrl?: string;
  /**
   * Source city name for city-kind stamps (from the v2 pipeline).
   * Destination grouping matches on this when present, so display labels
   * (definition names / title overrides) can diverge from the city name.
   */
  city?: string | null;
  /**
   * Authoritative rarity from the stamp definition, when known. When set,
   * this must be used instead of deriving rarity from `kind` — the kind-based
   * guess is only a fallback for legacy stamps with no definition record.
   */
  rarity?: 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';
}

export interface TravelStats {
  citiesVisited: number;
  plansJoined: number;
  buddies: number;
  stamps: number;
  hostedPlans: number;
}

export type TrustTier = 'new' | 'rising' | 'trusted' | 'pillar';

export interface TrustValue {
  score: number;        // 0..100
  tier: TrustTier;
  verifiedId: boolean;
  completedPlans: number;
  positiveReviews: number;
  safeMeetups: number;
}

export type PlanStatus =
  | 'draft' | 'open' | 'requested' | 'joined'
  | 'full' | 'in_progress' | 'completed' | 'cancelled';

export interface Plan {
  id: ID;
  title: string;
  destination: Pick<Destination, 'id' | 'city' | 'country' | 'slug'>;
  coverUrl?: string;
  host: User;
  status: PlanStatus;
  startAt: ISODate;
  attendeeCount: number;
  capacity: number;
  category: Interest;
}

export interface Perk {
  id: ID;
  title: string;
  detail: string;
  unlocked: boolean;
  requirement?: string; // "Reach Trusted tier"
}

/** Aggregate the Passport screen consumes. usePassport() will return this. */
export interface PassportData {
  user: User;
  stats: TravelStats;
  trust: TrustValue;
  stamps: PassportStamp[];
  travelStyle: Interest[];
  plans: Plan[];
  buddies: User[];
  perks: Perk[];
}

/* ───────────────────────────────────────────────────────────────────────
 * Passport Postcard — a post on the user's passport wall.
 * Postcard rows live in `passport_postcards` table.
 * ─────────────────────────────────────────────────────────────────────── */

export type PostcardStatus = 'active' | 'removed_from_passport' | 'deleted';
export type PostcardVisibility = 'public' | 'private' | 'trip_only';

/** Media item returned by the post_media backend (snake_case keys match API response). */
export interface PostcardMediaItem {
  id: string;
  media_type: 'image' | 'video';
  url: string;
  /**
   * Feed-sized derivative (~1500px longest edge), or NULL when none exists.
   *
   * NULL is normal, not an error: every media item uploaded before migration
   * 0208, every video, and any item whose derive failed has none. Render
   * `feed_url ?? url` — never construct this path from `url`, because for those
   * items the object does not exist and the request 404s.
   */
  feed_url?: string | null;
  thumbnail_url: string | null;
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  sort_order: number;
  processing_status: 'pending' | 'ready' | 'failed';
  /**
   * Optional passport-stamp overlay metadata (raw jsonb from the server).
   * Typed as unknown on purpose — render surfaces must validate through
   * parseStampOverlay() so malformed data degrades to "no overlay".
   */
  stamp_overlay?: unknown;
}

export interface PassportPostcard {
  id: ID;
  postId: ID;
  mediaUrl: string | null;
  caption: string | null;
  locationName: string | null;
  locationCity: string | null;
  locationCountry: string | null;
  locationVerified: boolean;
  stampEligible: boolean;
  stampReason?: string | null;
  verificationMethod?: string | null;
  visibility: PostcardVisibility;
  status: PostcardStatus;
  pinnedAt: ISODate | null;
  note: string | null;
  createdAt: ISODate;
  /** Structured media items from post_media (set by Postcards backend). */
  media?: PostcardMediaItem[];
  /** True when the primary or any attached media item is a video. */
  hasVideo?: boolean;
  /** 'image' | 'video' | 'none' — derived from ready post_media rows. */
  primaryMediaType?: string;
}

/* ───────────────────────────────────────────────────────────────────────
 * Public Passport — what a public viewer sees for a user.
 * ─────────────────────────────────────────────────────────────────────── */

export interface PublicProfile {
  id: ID;
  username: string | null;
  displayName: string | null;
  bio: string | null;
  avatarUrl: string | null;
  homeCity: string | null;
  homeCountry: string | null;
  travelStyle: string | null;
  interests: string[];
  verified: boolean;
  verificationStatus: 'unverified' | 'pending' | 'verified' | 'rejected' | 'expired';
  verifiedAt: ISODate | null;
  passportVisibility: 'public' | 'private';
  createdAt: ISODate | null;
  followersCount?: number;
  followingCount?: number;
  isFollowing?: boolean;
  isOwnProfile?: boolean;
  stamps?: PassportStamp[];
  trustScore?: number | null;
  trustLabel?: string | null;
  verificationLevel?: 'none' | 'basic_verified' | 'trusted_traveler' | 'host_verified' | 'buddy_verified' | null;
  /** Owner's preferred passport tab order; null/absent = canonical order. */
  passportTabOrder?: string[] | null;
  /**
   * Whether the user is open to meeting people — surfaced in the Passport
   * header chip when the API returns it. Absent = chip hidden (safe default).
   */
  openToMeet?: boolean;
  /**
   * Active quick-availability status string (e.g. 'free_now', 'free_tonight',
   * 'open_to_plans', 'busy'). Absent = no quick-status secondary on the chip.
   */
  quickStatus?: string | null;
  /** True when this profile is an @Portava Official account. */
  isOfficial?: boolean;
  /**
   * Number of posts this creator has had featured by Portava (status = 'live').
   * Absent/0 means no featured posts — trophy row should be hidden.
   */
  featuredCount?: number | null;
}

/* ───────────────────────────────────────────────────────────────────────
 * Own full profile (returned by GET /me/profile).
 * ─────────────────────────────────────────────────────────────────────── */

/** One factor contributing to (or deducting from) the trust score. */
export interface TrustScoreFactor {
  key: string;
  label: string;
  /** Points actually awarded/deducted for this user. */
  points: number;
  /** Maximum possible contribution (positive) or maximum deduction (negative). */
  maxPoints: number;
  /** Whether this factor is currently at its maximum positive contribution. */
  maxed: boolean;
  /** Actionable improvement hint; null when maxed or a penalty. */
  hint: string | null;
}

export interface TrustScoreBreakdown {
  factors: TrustScoreFactor[];
}

export interface OwnProfile {
  id: ID;
  handle: string | null;
  name: string | null;
  displayName: string | null;
  username: string | null;
  bio: string | null;
  avatarUrl: string | null;
  homeCity: string | null;
  homeCountry: string | null;
  currentCity: string | null;
  travelStyle: string | null;
  interests: string[];
  verified: boolean;
  verificationStatus: 'unverified' | 'pending' | 'verified' | 'rejected' | 'expired';
  verifiedAt: ISODate | null;
  openToMeet: boolean;
  isPrivate: boolean;
  passportVisibility: 'public' | 'followers_only' | 'private';
  coverPhotoUrl: string | null;
  usernameUpdatedAt: ISODate | null;
  createdAt: ISODate | null;
  spokenLanguages: string[];
  defaultLanguage: string | null;
  travelStyles: string[];
  travelPace: string | null;
  budgetStyle: string | null;
  travelGroupStyle: string[];
  lookingFor: string[];
  comfortLevel: string | null;
  availabilityTags: string[];
  planningStyle: string | null;
  publicSocialLinks: Record<string, string>;
  preferredLanguage: string | null;
  dateOfBirth: string | null;
  dobVerified: boolean;
  ageGateRequired?: boolean;
  trustScore?: number | null;
  trustLabel?: string | null;
  /** Itemized breakdown of trust score factors — only present on the owner's own passport view. */
  trustScoreBreakdown?: TrustScoreBreakdown | null;
  verificationLevel?: 'none' | 'basic_verified' | 'trusted_traveler' | 'host_verified' | 'buddy_verified' | null;
  idVerifiedAt?: ISODate | null;
  selfieVerifiedAt?: ISODate | null;
  homeCountryVerifiedAt?: ISODate | null;
  safetyFlagsCount?: number | null;
  followersCount?: number | null;
  followingCount?: number | null;
  tripCount?: number | null;
  hostVerifiedAt?: ISODate | null;
  buddyVerifiedAt?: ISODate | null;
  /** Owner's preferred passport section order; null/absent = canonical order. */
  passportSectionOrder?: string[] | null;
  /** Owner's preferred passport tab order; null/absent = canonical order. */
  passportTabOrder?: string[] | null;
  /** Section keys the owner has hidden; null/absent = none hidden. */
  passportHiddenSections?: string[] | null;
  /** True when this profile is an @Portava Official account. */
  isOfficial?: boolean;
}

/* ───────────────────────────────────────────────────────────────────────
 * Availability + City events (Pulse/Discovery utility layer).
 * ─────────────────────────────────────────────────────────────────────── */

export type TimeBlock = 'morning' | 'afternoon' | 'evening' | 'late';
export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

/** Recurring weekly rhythm: which time blocks are free on which days. */
export interface WeeklyAvailability {
  days: Partial<Record<Weekday, TimeBlock[]>>;
}

/** Trip-specific window. Overrides recurring for its destination + dates. */
export interface TripWindow {
  id: ID;
  citySlug: string;        // matches Destination.slug
  startDate: ISODate;      // inclusive
  endDate: ISODate;        // inclusive
  blocks: TimeBlock[];     // free time blocks during this trip
}

/** Friendly surfaced status. Resolver computes this; never assume "available". */
export type AvailabilityStatus =
  | 'open_tonight'
  | 'usually_free'
  | 'flexible_week'
  | 'trip_active'
  | 'not_available'
  | 'open_to_meet'
  | 'not_set';

export interface Availability {
  weekly?: WeeklyAvailability;
  trips: TripWindow[];
  /** user's explicit toggle; independent of computed windows */
  openToMeet: boolean;
  /** strict mode (future): only show in-availability items in Pulse */
  strict?: boolean;
}

/** Future backend scoring. ALL optional/null now — filled only by real ranking. */
export interface RecommendationScore {
  locationScore?: number | null;
  timeScore?: number | null;
  interestScore?: number | null;
  trustScore?: number | null;
  socialScore?: number | null;
  finalRecommendationScore?: number | null;
  recommendationReason?: string | null;
}

export type EventKind = 'plan' | 'event' | 'meetup';

/** A city happening / open plan. Shared by Pulse and Discovery. */
export interface CityEvent {
  id: ID;
  kind: EventKind;
  title: string;
  citySlug: string;
  city: string;
  startAt: ISODate;
  block: TimeBlock;        // which time block it falls in
  category: Interest;
  host?: User;
  attendeeCount?: number;
  capacity?: number;
  /** present only when real ranking exists; null otherwise */
  score?: RecommendationScore | null;
}

/** Result of deterministic Pulse filtering. */
export interface PulseBuckets {
  fitsAvailability: CityEvent[];   // in city + inside availability
  openNearby: CityEvent[];         // in city, availability unknown/any
  flexible: CityEvent[];           // outside availability -> collapsed section
}

/* ───────────────────────────────────────────────────────────────────────
 * Travel Knowledge Layer (provisional seed).
 * ─────────────────────────────────────────────────────────────────────── */

export type KnowledgeSource = 'seed' | 'osm' | 'wikidata' | 'geonames';
export type KnowledgeStatus = 'provisional' | 'sourced' | 'verified';

export interface CityKnowledge {
  citySlug: string;
  city: string;
  country: string;
  knownFor: string[];
  vibeTags: string[];
  popularAreas: string[];
  categories: Interest[];
  source: KnowledgeSource;
  status: KnowledgeStatus;
  verified: boolean;
  updatedAt: ISODate;
}

/** Visual motif for a stamp — resolved from city, else category. Level-1 art. */
export interface StampMotif {
  iconKey: string;
  accent: string;
  frame: 'oval' | 'rect';
  caption?: string;
  provisional: boolean;
}

/* ───────────────────────────────────────────────────────────────────────
 * Trip command center (Trip Page).
 * ─────────────────────────────────────────────────────────────────────── */

export type TripStatus = 'planning' | 'upcoming' | 'active' | 'completed' | 'cancelled';
export type TripVisibility = 'public' | 'buddies' | 'private' | 'invite';
export type SafetyStatus = 'ok' | 'checkin_due' | 'safe_return_active' | 'unknown';

export interface SavedIdea {
  id: ID;
  name: string;
  category: string;
  neighborhood: string;
  imageUrl?: string;
  source: 'discovery' | 'post' | 'plan' | 'gem';
}

export type TimelineItemKind = 'plan' | 'saved' | 'free' | 'checkin';
export interface TimelineItem {
  id: ID;
  kind: TimelineItemKind;
  time?: string;
  title: string;
  place?: string;
  attendeeCount?: number;
}
export interface TimelineDay {
  dateLabel: string;
  dateSub: string;
  iso: ISODate;
  items: TimelineItem[];
}

export interface TripProgressStep { label: string; done: boolean; }

export interface TripDetail {
  id: ID;
  title: string;
  destinationCity: string;
  destinationCountry: string;
  neighborhoods: string[];
  startDate: ISODate;
  endDate: ISODate;
  nights: number;
  status: TripStatus;
  visibility: TripVisibility;
  travelStyle: string;
  openToMeet: boolean;
  availabilityLabel?: string;
  coverUrl: string;
  coverMediaType?: 'image' | 'video' | null;
  progress: number;
  progressSteps: TripProgressStep[];
  nextUpPlanId?: ID | null;
  timeline: TimelineDay[];
  savedIdeas: SavedIdea[];
  safetyStatus: SafetyStatus;
  tripNotes?: string | null;
}

/* ───────────────────────────────────────────────────────────────────────
 * Pulse Wall — unified typed feed item.
 * ─────────────────────────────────────────────────────────────────────── */

export type PulseItemType =
  | 'post' | 'question' | 'plan' | 'hidden_gem' | 'itinerary'
  | 'circle_activity' | 'compass_suggestion' | 'city_note' | 'safety'
  | 'rent_a_buddy' | 'place_card';

export type PulseSource = 'user' | 'circle' | 'compass' | 'seed' | 'editorial';

export interface PulseAuthor {
  id: ID;
  name: string;
  avatarUrl: string;
  username?: string | null;
  /** True when the author holds a verified traveler status. */
  verified?: boolean;
  /** True when the author is an @Portava Official account. */
  isOfficial?: boolean;
}

export interface PulseFeedItem {
  id: ID;
  type: PulseItemType;
  city?: string;
  neighborhood?: string;
  author?: PulseAuthor;
  createdAt: ISODate;
  updatedAt?: ISODate;
  timeAgo?: string;
  visibility?: 'public' | 'circle' | 'private';
  tags: string[];
  mediaUrl?: string;
  /** Structured media items from post_media (set by the new Postcards backend). */
  media?: PostcardMediaItem[];
  source: PulseSource;
  isProvisional?: boolean;
  isEditorial?: boolean;

  caption?: string;
  question?: string;
  replyCount?: number;
  likeCount?: number;
  commentCount?: number;
  shareCount?: number;
  likedByMe?: boolean;
  savedByMe?: boolean;
  canLike?: boolean;
  canComment?: boolean;
  canShare?: boolean;
  title?: string;
  time?: string;
  host?: PulseAuthor;
  attendeeCount?: number;
  availabilityMatch?: boolean;
  steps?: string[];
  estimate?: string;
  blurb?: string;
  activityText?: string;
  participants?: PulseAuthor[];
  reason?: string;

  availabilityScore?: number | null;
  recommendationReason?: string | null;
  /** Signed token from Compass that enables "Why am I seeing this?" — only set when served via Compass. */
  recommendationId?: string | null;

  relatedPlanId?: ID | null;
  relatedGemId?: ID | null;
  relatedTripId?: ID | null;

  /** Resolved from pulse_geo_tags.location_visibility — drives LocationChip variant. */
  locationVisibility?: 'city_only' | 'neighborhood' | 'venue_tagged' | 'exact_hidden' | 'no_location' | null;
  /** Venue name when location_visibility = 'venue_tagged'. */
  venueName?: string | null;
  /** District/neighborhood label when location_visibility = 'neighborhood' or 'venue_tagged'. */
  locationDistrict?: string | null;
  /** Country name for display. */
  locationCountry?: string | null;
  /** Saved @mention annotations from `tags` table — positioned spans for RichText. */
  spanTags?: Array<{ type: 'user'; id: string; matchToken: string; startChar: number; endChar: number; isBlocked?: boolean; isDeleted?: boolean }>;
  /** Saved #hashtag annotations from `hashtag_usage` — positioned spans for RichText. */
  spanHashtags?: Array<{ slug: string; hashtagId: string; startChar: number; endChar: number; isBlocked?: boolean }>;
  /**
   * True when the first entry in `tags` is the 'Travel' fallback (i.e. the post
   * has no explicit category). Used by TagRow to render it with muted styling so
   * QA and users can distinguish a real category stamp from the default.
   */
  categoryFallback?: boolean;
  /** ID of the discovery_places row — set only when type = 'place_card'. */
  placeId?: string | null;
  /** Trip name label surfaced when the post is attached to a trip — displayed as a badge on the media frame. */
  tripLabel?: string | null;
  /**
   * Non-null when this post has been featured by Portava (portava_featured.status = 'live').
   * The string value is the feature category (e.g. "best_hidden_gem").
   * Absent/null when the post has not been featured.
   */
  featuredByPortava?: string | null;
}

export const PULSE_FILTERS = [
  'All', 'Posts', 'Questions', 'Plans', 'Hidden Gems', 'Itineraries', 'Circle',
  'Food', 'Nightlife', 'Beach', 'Culture', 'Fits My Time', 'Open Now',
] as const;
export type PulseFilter = typeof PULSE_FILTERS[number];

/* ───────────────────────────────────────────────────────────────────────
 * Attachments
 * ─────────────────────────────────────────────────────────────────────── */

export type AttachSourceType =
  | 'place' | 'hidden_gem' | 'post' | 'itinerary' | 'plan' | 'experience' | 'compass_suggestion';
export type AttachTargetType = 'trip' | 'plan';

export interface Attachment {
  id: ID;
  userId: ID;
  sourceItemId: ID;
  sourceItemType: AttachSourceType;
  sourceTitle: string;
  sourceSubtitle?: string;
  sourceImageUrl?: string;
  sourceCity?: string;
  sourceCategory?: string;
  targetId: ID;
  targetType: AttachTargetType;
  targetTitle: string;
  createdAt: ISODate;
  notes?: string;
  persistence: 'session';
}

/** What a card passes to the selector — the source item being attached. */
export interface AttachSource {
  id: ID;
  type: AttachSourceType;
  title: string;
  subtitle?: string;
  imageUrl?: string;
  city?: string;
  category?: string;
}

/** Selectable target (trip or plan) shown in the sheet. */
export interface AttachTarget {
  id: ID;
  type: AttachTargetType;
  title: string;
  subtitle?: string;
  group: 'active' | 'upcoming' | 'planning' | 'trip_plans' | 'open' | 'draft';
}

/* ───────────────────────────────────────────────────────────────────────
 * Trip Plan Items — structured day-by-day itinerary per trip.
 * ─────────────────────────────────────────────────────────────────────── */

export type TripPlanCategory =
  | 'accommodation'
  | 'activity'
  | 'dining'
  | 'transport'
  | 'free_time'
  | 'meeting_point'
  | 'other';

export type TripPlanItemStatus =
  | 'confirmed'
  | 'tentative'
  | 'done'
  | 'cancelled';

export type TripPlanSourceType =
  | 'manual'
  | 'place'
  | 'meetup';

export type TripPlanLockType =
  | 'fixed'
  | 'flexible'
  | 'optional';

export type PlanItemWarning =
  | 'time_overlap'
  | 'duplicate'
  | 'outside_trip_dates'
  | 'missing_location'
  | 'unmapped_location'
  | 'cancelled_source';

export interface TripPlanItem {
  id: ID;
  tripId: ID;
  creatorId: ID;
  title: string;
  category: TripPlanCategory;
  status: TripPlanItemStatus;
  sourceType: TripPlanSourceType;
  sourceId: string | null;
  dayDate: ISODate | null;
  startsAt: ISODate | null;
  endsAt: ISODate | null;
  locationName: string | null;
  notes: string | null;
  sortOrder: number;
  visibility: 'members' | 'public';
  /** Public-safe latitude. null when locationIsPrivate=true or not set. */
  lat: number | null;
  /** Public-safe longitude. null when locationIsPrivate=true or not set. */
  lng: number | null;
  locationIsPrivate: boolean;
  /** How Autopilot may treat this item. Server default is 'flexible'. */
  lockType?: TripPlanLockType;
  /** Advisory warnings computed server-side. Does not block mutations. */
  warnings: PlanItemWarning[];
  createdAt: ISODate;
  updatedAt: ISODate;
}

/* ───────────────────────────────────────────────────────────────────────
 * Universal Share — the one shape every shareable thing is normalized into
 * ─────────────────────────────────────────────────────────────────────── */

/**
 * Everything the app can share. One member per entity adapter in
 * src/services/shareAdapters.ts.
 *
 * `postcard` and `compass_recommendation` are kept as their own types even
 * though neither has a route: a postcard resolves to its post's URL and a
 * compass recommendation unwraps to the entity it recommends. The type is
 * what preview copy and analytics key off, so it must survive the redirect.
 */
export type ShareEntityType =
  | 'postcard'
  | 'trip'
  | 'place'
  | 'profile'
  | 'event'
  | 'memory'
  | 'stamp'
  | 'shared_moment'
  | 'compass_recommendation'
  | 'buddy_profile';

/**
 * Where a share can be sent. Mirrors the `ShareTarget` union ShareSheet.tsx
 * has used since before this layer existed, minus `copy_link` — copying is an
 * action performed on the entity, not a place the entity is sent to.
 */
export type ShareDestination =
  | 'dm'
  | 'group_chat'
  | 'trip_crew'
  | 'circle'
  | 'external';

/**
 * What can be done with a shared entity.
 *
 * Five ids come verbatim from §8: add_to_trip, send_to_circle, share_to_pulse,
 * add_to_shared_moment, invite_to_trip. The rest are transcribed from the §8
 * per-entity labels using the same convention, or retained from the production
 * inventory in docs/UNIVERSAL-SHARE-AUDIT.md §1a for the five entity types §8
 * does not cover. shareActionRegistry.ts records the provenance of each one in
 * its `source` field — check there before adding or renaming.
 *
 * Note there is no single `send_in_app`: §8 names `send_to_circle` as an id,
 * so sending is modelled as one action per conversation target rather than one
 * action parameterised by target.
 */
export type ShareActionId =
  // ── Send: one per conversation target (§8 shape) ──
  | 'send_to_traveler'
  | 'send_to_circle'
  | 'send_to_trip_crew'
  // ── Publish / collect ──
  | 'share_to_pulse'
  | 'add_to_trip'
  | 'save_to_trip'
  | 'add_to_shared_moment'
  // ── Invite ──
  | 'invite_to_trip'
  | 'invite_to_plan'
  | 'invite_traveler'
  // ── Recommend ──
  | 'recommend_to_traveler'
  // ── Link / OS-level ──
  | 'copy_link'
  | 'share_external'
  | 'share_image'
  | 'share_file'
  // ── Acts on the entity ──
  | 'save'
  | 'report';

/** Who made the thing. Omitted entirely for ownerless entities (places). */
export interface ShareableEntityCreator {
  id: ID;
  /** Handle without a leading '@'. Null when the account has no handle. */
  username: string | null;
  /**
   * Already resolved for display. Adapters do NOT apply the show-real-name
   * rule themselves — they pass through what the caller's data layer already
   * decided, so this layer never becomes a second privacy authority.
   */
  displayName: string | null;
  avatarUrl: string | null;
}

/** Coarse location only — city/country. Never coordinates. */
export interface ShareableEntityLocation {
  city: string | null;
  country: string | null;
  /** Venue or place name when the entity has one. */
  name: string | null;
}

/**
 * The normalized share payload. Produced only by the adapters in
 * src/services/shareAdapters.ts, consumed by the share controller, the
 * (not yet built) sheet, and analytics.
 */
export interface ShareableEntity {
  entityType: ShareEntityType;
  /** The entity's own id, even when canonicalUrl points at another entity. */
  entityId: ID;
  /** One line. Never empty — adapters fall back rather than emit ''. */
  title: string;
  /** Second line: location, date, or author. Null when there is nothing to add. */
  subtitle: string | null;
  /** Body copy for the preview card. Null when the entity has none. */
  description: string | null;
  imageUrl: string | null;
  /** Null for ownerless entities (place) and for compass recommendations. */
  creator: ShareableEntityCreator | null;
  location: ShareableEntityLocation | null;
  /**
   * Absolute https URL, always built through canonicalUrl(). Null only when
   * the entity genuinely has no addressable destination — a compass
   * recommendation wrapping an unshareable item type, for instance.
   */
  canonicalUrl: string | null;
  /** Entity-specific extras. Free-form by design; nothing type-switches on it. */
  metadata: Record<string, unknown>;
  allowedDestinations: ShareDestination[];
  allowedActions: ShareActionId[];
}
