/**
 * features/media — Media v2 Phase 10 (Human Network) client types (§19/§25/§46).
 *
 * The CLIENT shapes for Request-a-View, the contributor opt-in, visual-coverage
 * freshness, and a contributor's INTELLIGENCE-TRUST reputation. These mirror the
 * merged Phase-10 backend (#295):
 *   POST /api/v1/media/view-requests
 *   PUT  /api/v1/media/view-requests/opt-in
 *   GET  /api/v1/media/places/:placeId/visual-coverage
 *   GET  /api/v1/media/contributors/:contributorId/reputation
 *
 * The whole capability is gated behind `media_request_a_view_enabled` (OFF by
 * default) — these types describe what the client renders ONLY when the server
 * has resolved a request; the client never computes truth, freshness, or trust.
 *
 * Pure type module: no runtime imports, so it is safe to import from node:test
 * pure-logic suites.
 */

// ── Visual coverage (§19) ─────────────────────────────────────────────────────
// "Last visual update 28m ago" + whether the place is stale enough to prompt a
// Request-a-View. Freshness comes only from the server (§46.2 no fake-live): the
// client renders the label it is handed and never fabricates a "live now".
export interface VisualCoverage {
  /** ISO time of the freshest visual observation, or null when none. */
  lastObservedAt: string | null;
  /** Whole minutes since the freshest visual observation, or null when none. */
  ageMinutes: number | null;
  /** "28m ago", or null when there is no recent visual update. */
  lastUpdateLabel: string | null;
  /** True when the freshest visual has aged past its TTL, or there is none. */
  stale: boolean;
  /** True when the place has NO visual observation at all (a coverage void). */
  noCoverage: boolean;
}

// ── Request-a-View outcome (§19) ──────────────────────────────────────────────
// A request is a calm PROMPT for a fresh perspective, never a demand. Every
// backend gate can refuse it; the client shows a calm reason, never an error
// toast storm.
export type ViewRequestRefusalReason =
  | 'disabled' // media_request_a_view_enabled is off (feature_disabled / 404)
  | 'rate_limited' // per-viewer or per-place throttle (429)
  | 'duplicate' // an open request for this place already exists (409)
  | 'protected_location' // restrictive Hidden Gem / protected place (403)
  | 'invalid' // malformed request (400) — defensive, should not happen from UI
  | 'server'; // db_error / transient (5xx) / network

export interface ViewRequestSuccess {
  ok: true;
  /** The media_view_requests ledger row id (may be null on older payloads). */
  requestId: string | null;
  /** The intel_mission_candidates row this request created (may be null). */
  missionCandidateId: string | null;
  /**
   * How many opted-in + eligible + un-blocked contributors were asked. Zero is a
   * normal, graceful outcome pre-launch (nobody opted in yet) — never an error.
   */
  recipientCount: number;
}

export interface ViewRequestRefused {
  ok: false;
  reason: ViewRequestRefusalReason;
  /** Calm, human message the UI can render inline. */
  message: string;
}

export type ViewRequestOutcome = ViewRequestSuccess | ViewRequestRefused;

// ── Contributor opt-in (§19) ──────────────────────────────────────────────────
export interface OptInResult {
  ok: boolean;
  /** The value the server confirmed (echoes the requested value on success). */
  optedIn: boolean;
  errorKind?: 'auth' | 'server' | 'network' | 'unknown';
}

// ── Contributor reputation (§25 Creator Popularity vs Intelligence Trust) ─────
// SEPARATE from social popularity. There is deliberately NO follower / like /
// stamp / leaderboard field here — the three dimensions are intelligence-trust
// only, and the client renders them as trust CONTEXT, never as a vanity metric.
export interface ContributorReputation {
  /** 0..1 — usefulness / historical acceptance of structured observations. */
  contributorReliability: number;
  /** 0..1 — evidence-backed experience at the place/category in scope. */
  placeExpertise: number;
  /** 0..1 — how often the contributor's current observations are corroborated. */
  liveAccuracy: number;
  /**
   * Machine-readable statement of what these numbers ARE — always
   * 'intelligence_trust'. The client refuses to render anything else as trust.
   */
  basis: 'intelligence_trust';
  /** True until any real intel signal exists (graceful pre-launch empty). */
  isEmpty: boolean;
}

/** One rendered §25 dimension: a calm label + description + 0..1 value. */
export interface ReputationDimension {
  key: 'contributorReliability' | 'placeExpertise' | 'liveAccuracy';
  label: string;
  description: string;
  /** 0..1 clamped. */
  value: number;
  /** "82%" — a calm evidence indicator, NOT a rank or a count. */
  percentLabel: string;
}
