/**
 * Telegraph §3.4's projection contract, client side.
 *
 * These types mirror `artifacts/api-server/src/services/telegraph/sharedContext.ts`
 * field for field. They are declared (not imported) because the client and the
 * server are separate TypeScript projects with no shared package; the
 * `railBehavior` tests pin the enum values so a server-side rename that this
 * file does not follow turns a test red rather than rendering an empty rail.
 */

export type TelegraphObjectType =
  | 'TRIP'
  | 'TRIP_STAGE'
  | 'PLAN'
  | 'EVENT'
  | 'MEETUP'
  | 'ROUTE'
  | 'BOOKING'
  | 'PLACE'
  | 'HIDDEN_GEM'
  | 'MAP_PIN'
  | 'NEIGHBORHOOD'
  | 'MEETUP_POINT'
  | 'PROFILE'
  | 'POST'
  | 'HIGHLIGHT'
  | 'MEMORY'
  | 'MEMORY_NOTE'
  | 'STAMP'
  | 'BUDDY_SERVICE'
  | 'VISA_CARD'
  | 'WANT_TO_DO';

export type SharedRelationship =
  | 'CREATED_BY_ME_JOINED_BY_THEM'
  | 'CREATED_BY_THEM_JOINED_BY_ME'
  | 'BOTH_PARTICIPANTS'
  | 'BOTH_PROMOTED';

export type TelegraphAction =
  | 'ADD_TO_TRIP'
  | 'CREATE_PLAN'
  | 'JOIN_PLAN'
  | 'LEAVE_PLAN'
  | 'MEET_HERE'
  | 'SHARE_PLACE'
  | 'SHARE_ROUTE'
  | 'VOTE'
  | 'SHARE_AVAILABILITY'
  | 'SHARE_LOCATION'
  | 'SPLIT_RIDE'
  | 'CHECK_IN_SAFE'
  | 'RETURN_TO_GROUP'
  | 'DO_THIS_NOW';

export type SharedContextBand =
  | 'HAPPENING_NOW'
  | 'STARTING_SOON'
  | 'TODAY'
  | 'UPCOMING'
  | 'ACTIVE_TRIP'
  | 'UNRESOLVED'
  | 'PAST';

export interface SharedContextItem {
  objectType: TelegraphObjectType;
  objectId: string;
  currentVersion?: string;
  title: string;
  startsAt?: string;
  endsAt?: string;
  relationship: SharedRelationship;
  status: string;
  availableActions: TelegraphAction[];
  orderBand: SharedContextBand;
}

export interface TelegraphSharedContextProjection {
  conversationId: string;
  generatedAt: string;
  now: SharedContextItem[];
  upcoming: SharedContextItem[];
  unresolved: SharedContextItem[];
  past: SharedContextItem[];
}

export type RailMode = 'EXPANDED_NOW' | 'COMPACT_UPCOMING' | 'COLLAPSED_SUMMARY' | 'EMPTY';

export interface SharedContextResponse {
  sharedContext: TelegraphSharedContextProjection;
  railMode: RailMode;
  collapsedSummary: string;
  /** True when a resolver read failed: the rail is unknown, not empty. */
  incomplete: boolean;
  refusedCount: number;
}

export interface ConversationHeaderParticipant {
  userId: string;
  availability: {
    enabled: boolean;
    state: string | null;
    intents: string[];
    expiresAt: string | null;
  };
  safePresence: {
    label: string | null;
    venue: string | null;
    checkedIn: boolean;
    stale: boolean;
  } | null;
}

export interface ConversationHeaderResponse {
  threadId: string;
  threadType: string;
  participants: ConversationHeaderParticipant[];
  availabilityEnabled: boolean;
}
