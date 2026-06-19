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
 * Availability + City events (Pulse/Discovery utility layer).
 * Deterministic filtering now; scoring fields present but NULL until a real
 * backend ranking exists. Never fabricate scores.
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
  /** user’s explicit toggle; independent of computed windows */
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
 * Travel Knowledge Layer (provisional seed). Every record carries source +
 * status + verified so the UI NEVER presents hand-seed data as truth.
 * Later: replace/validate via OSM, Wikidata, GeoNames + attribution.
 * ─────────────────────────────────────────────────────────────────────── */

export type KnowledgeSource = 'seed' | 'osm' | 'wikidata' | 'geonames';
export type KnowledgeStatus = 'provisional' | 'sourced' | 'verified';

export interface CityKnowledge {
  citySlug: string;
  city: string;
  country: string;
  knownFor: string[];      // soft, provisional — render as "Known for"
  vibeTags: string[];
  popularAreas: string[];
  categories: Interest[];   // dominant travel categories
  source: KnowledgeSource;
  status: KnowledgeStatus;
  verified: boolean;
  updatedAt: ISODate;
}

/** Visual motif for a stamp — resolved from city, else category. Level-1 art. */
export interface StampMotif {
  /** lucide icon name resolved in component; kept as key for portability */
  iconKey: string;
  accent: string;          // hex accent for this stamp
  frame: 'oval' | 'rect';  // one of two reusable frame styles
  caption?: string;        // tiny "known for" tag, e.g. "DIVING"
  provisional: boolean;    // drives "Starter city notes" label
}

/* ───────────────────────────────────────────────────────────────────────
 * Trip command center (Trip Page). Extends the base Trip with the fields the
 * spec needs. All optional/nullable so existing mock trips remain valid and
 * missing backend data degrades to honest empty states.
 * ─────────────────────────────────────────────────────────────────────── */

export type TripStatus = 'planning' | 'upcoming' | 'active' | 'completed' | 'cancelled';
export type TripVisibility = 'public' | 'buddies' | 'private' | 'invite';
export type SafetyStatus = 'ok' | 'checkin_due' | 'safe_return_active' | 'unknown';

export interface SavedIdea {
  id: ID;
  name: string;
  category: string;        // Food / Nightlife / Nature / ...
  neighborhood: string;
  imageUrl?: string;
  source: 'discovery' | 'post' | 'plan' | 'gem';
}

export type TimelineItemKind = 'plan' | 'saved' | 'free' | 'checkin';
export interface TimelineItem {
  id: ID;
  kind: TimelineItemKind;
  time?: string;           // "7:00 PM"
  title: string;
  place?: string;
  attendeeCount?: number;
}
export interface TimelineDay {
  dateLabel: string;       // "TODAY", "SAT"
  dateSub: string;         // "Jun 20"
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
  travelStyle: string;       // "Solo Traveler"
  openToMeet: boolean;
  availabilityLabel?: string; // "Evenings + Weekends"
  coverUrl: string;
  progress: number;          // 0..100
  progressSteps: TripProgressStep[];
  nextUpPlanId?: ID | null;
  timeline: TimelineDay[];
  savedIdeas: SavedIdea[];
  safetyStatus: SafetyStatus;
}

/* ───────────────────────────────────────────────────────────────────────
 * Pulse Wall — unified typed feed item. One shape renders many card types.
 * Real content populates the wall; seeded/editorial items are labeled.
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
  author?: PulseAuthor;        // absent for compass/city_note/safety
  createdAt: ISODate;
  timeAgo?: string;            // display convenience
  visibility?: 'public' | 'circle' | 'private';
  tags: string[];
  mediaUrl?: string;
  source: PulseSource;
  isProvisional?: boolean;     // seed/city_note -> show provisional label
  isEditorial?: boolean;       // editorial inspiration -> label as such

  // type-specific (all optional; renderer reads what it needs)
  caption?: string;            // post
  question?: string;           // question
  replyCount?: number;         // question
  likeCount?: number;          // post
  commentCount?: number;       // post
  title?: string;              // plan / itinerary / gem
  time?: string;               // plan
  host?: PulseAuthor;          // plan
  attendeeCount?: number;      // plan
  availabilityMatch?: boolean; // plan -> "Fits your time" badge
  steps?: string[];            // itinerary
  estimate?: string;           // itinerary ("~5 hrs")
  blurb?: string;              // hidden gem ("why special"), city note
  activityText?: string;       // circle activity
  participants?: PulseAuthor[];// circle activity avatars
  reason?: string;             // compass suggestion (explicit, no fake score)

  // future scoring — optional/null, never fabricated
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
 * Attachments — linking a source item (place/gem/post/itinerary/...) to a
 * target (trip/plan). SESSION persistence only this pass (in-memory store);
 * backend migration contract documented in src/services/attachments.ts.
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
  persistence: 'session';   // honest: not backend-persisted this pass
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
  subtitle?: string;          // dates / time / city
  group: 'active' | 'upcoming' | 'planning' | 'trip_plans' | 'open' | 'draft';
}
