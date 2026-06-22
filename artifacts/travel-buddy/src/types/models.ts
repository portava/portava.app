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
  kind: 'image' | 'video';
  /** 0..1 estimated brightness; >0.62 triggers caption-below contrast fallback. */
  brightness?: number;
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
  socialProof: string;
  tradeoff?: string;
  usedPostIds: ID[];
  nextActions: AiAction[];
}

export type AiAction =
  | { label: 'Save answer'; kind: 'save' }
  | { label: 'Add to trip'; kind: 'addTrip' }
  | { label: 'Create post'; kind: 'createPost' }
  | { label: 'Ask community'; kind: 'askCommunity' }
  | { label: 'Build itinerary'; kind: 'buildItinerary' };

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

export interface PassportStamp {
  id: ID;
  kind: StampKind;
  label: string;        // "CEBU", "SAFE MEETUP", "FIRST HOST"
  sublabel?: string;    // "PH · 2026", "x3"
  earnedAt: ISODate;
  locked?: boolean;     // show as not-yet-earned (faint)
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
  passportVisibility: 'public' | 'private';
  createdAt: ISODate | null;
  followersCount?: number;
  followingCount?: number;
  isFollowing?: boolean;
  isOwnProfile?: boolean;
}

/* ───────────────────────────────────────────────────────────────────────
 * Own full profile (returned by GET /me/profile).
 * ─────────────────────────────────────────────────────────────────────── */

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
  progress: number;
  progressSteps: TripProgressStep[];
  nextUpPlanId?: ID | null;
  timeline: TimelineDay[];
  savedIdeas: SavedIdea[];
  safetyStatus: SafetyStatus;
}

/* ───────────────────────────────────────────────────────────────────────
 * Pulse Wall — unified typed feed item.
 * ─────────────────────────────────────────────────────────────────────── */

export type PulseItemType =
  | 'post' | 'question' | 'plan' | 'hidden_gem' | 'itinerary'
  | 'circle_activity' | 'compass_suggestion' | 'city_note' | 'safety';

export type PulseSource = 'user' | 'circle' | 'compass' | 'seed' | 'editorial';

export interface PulseAuthor {
  id: ID;
  name: string;
  avatarUrl: string;
}

export interface PulseFeedItem {
  id: ID;
  type: PulseItemType;
  city: string;
  neighborhood?: string;
  author?: PulseAuthor;
  createdAt: ISODate;
  timeAgo?: string;
  visibility?: 'public' | 'circle' | 'private';
  tags: string[];
  mediaUrl?: string;
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

  relatedPlanId?: ID | null;
  relatedGemId?: ID | null;
  relatedTripId?: ID | null;
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

export type PlanItemWarning =
  | 'time_overlap'
  | 'duplicate'
  | 'outside_trip_dates'
  | 'missing_location'
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
  /** Advisory warnings computed server-side. Does not block mutations. */
  warnings: PlanItemWarning[];
  createdAt: ISODate;
  updatedAt: ISODate;
}
