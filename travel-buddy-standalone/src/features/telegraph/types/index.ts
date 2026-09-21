/**
 * Telegraph client types — the shapes the server actually returns.
 *
 * These mirror the server contracts one-for-one and are kept in
 * `src/features/telegraph/` per the feature-layout convention (see
 * `src/features/wall/types/`). They are NOT a second source of truth: every
 * field here exists because a server module puts it on the wire, and each one
 * names the spec section it answers.
 */

/* ── §22 travel scam signals (server: domain/telegraph/policies/travelScamSignals.ts) ── */

export type ScamFamily =
  | 'OFF_PLATFORM_PAYMENT'
  | 'FAKE_TAXI'
  | 'VISA_HELP'
  | 'TICKET_RESALE'
  | 'FAKE_HOTEL'
  | 'URGENT_MONEY_REQUEST';

export type SignalSeverity = 'notice' | 'caution' | 'warning';

export interface ScamSignal {
  family: ScamFamily;
  severity: SignalSeverity;
  matched: string;
}

export type LinkFinding =
  | 'NON_HTTPS'
  | 'SHORTENER'
  | 'IP_LITERAL_HOST'
  | 'PUNYCODE_HOST'
  | 'MIXED_SCRIPT_HOST'
  | 'LOOKALIKE_OFFICIAL_HOST'
  | 'CREDENTIALS_IN_URL'
  | 'UNKNOWN_HOST';

export interface ScannedLink {
  raw: string;
  host: string | null;
  findings: LinkFinding[];
  suspicious: boolean;
}

export interface MessageSafetySignals {
  scam: ScamSignal[];
  links: ScannedLink[];
  severity: SignalSeverity | null;
}

/* ── §21 search (server: server/telegraph/searchRoute.ts) ── */

export type SearchBucket = 'MESSAGES' | 'PLACES' | 'MEDIA' | 'PLANS' | 'MEMORIES';

export const SEARCH_BUCKETS: readonly SearchBucket[] = [
  'MESSAGES', 'PLACES', 'MEDIA', 'PLANS', 'MEMORIES',
];

export interface SearchHit {
  messageId: string;
  conversationId: string;
  bucket: SearchBucket;
  senderId: string;
  createdAt: string;
  snippet: string;
  objectTitle: string | null;
  subtype: string | null;
  msgType: string;
  hasMedia: boolean;
}

export interface SearchResult {
  query: string;
  counts: Record<SearchBucket, number>;
  hits: SearchHit[];
  conversationsSearched: number;
  conversationsBounded: number;
  degraded: boolean;
}

/* ── §14.1 capabilities (server: server/telegraph/capabilityRoute.ts) ── */

export interface ConversationCapabilities {
  canSendMessage: boolean;
  canCall: boolean;
  canCreatePlan: boolean;
  canShareExactLocation: boolean;
  canInvite: boolean;
  canRequestPayment: boolean;
  canCreateBooking: boolean;
  canBroadcast: boolean;
  canViewPreMembershipHistory: boolean;
  canSeeGroupReadReceipts: boolean;
}

export interface CapabilityResponse {
  conversationId: string;
  conversationType: string;
  capabilities: ConversationCapabilities;
  reasons: Record<keyof ConversationCapabilities, string | null>;
  inputsRead: string[];
  degraded: boolean;
  degradedReasons: string[];
}
