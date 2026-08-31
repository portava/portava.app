/**
 * mediaViewRequest — Media v2 Phase 10 (Human Network), Request-a-View (§19).
 *
 * PURE decision functions for the four required controls. No clock, no IO — the
 * service (services/media/MediaViewRequestService) supplies the DB reads and the
 * current time; these decide. Kept pure so every control is unit-testable and
 * mutation-provable against literal inputs (the same shape lib/intelThrottle and
 * lib/mediaLocationVisibility use).
 *
 * A Request-a-View is a PROMPT for a fresh observation, never a demand, and it
 * NEVER surfaces to a contributor who did not opt in. Every gate below fails
 * CLOSED: a missing/ambiguous input excludes a contributor or refuses a request,
 * never the reverse.
 */

// ── Throttle / anti-spam windows (§19 "throttling and anti-spam controls") ─────
//
// Two independent fixed windows enforced by the service against lib/rateLimit:
//   • per VIEWER   — one person cannot flood the whole system with requests.
//   • per PLACE    — one place cannot be spammed with requests by many viewers.
// Defaults are deliberately low; env overrides let ops tune without a deploy.

const intFromEnv = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** Max view-requests one viewer may open per rolling window. */
export const VIEW_REQUEST_PER_VIEWER_LIMIT = intFromEnv("MEDIA_VIEW_REQUEST_PER_VIEWER_PER_HOUR", 5);
/** Max view-requests any viewers may open against one place per rolling window. */
export const VIEW_REQUEST_PER_PLACE_LIMIT = intFromEnv("MEDIA_VIEW_REQUEST_PER_PLACE_PER_HOUR", 8);
/** The window both limits use. */
export const VIEW_REQUEST_WINDOW_MS = 60 * 60 * 1000; // 1 hour

// ── Opt-in + eligibility recipient selection (the OPT-IN-ONLY control) ─────────

/**
 * One contributor's opt-in registry row, as read from media_view_request_optins.
 * Every field is a fact; a MISSING row is represented by the contributor simply
 * not appearing in the input array (⇒ never asked).
 */
export interface ContributorOptIn {
  contributorId: string;
  /** The contributor's OWN choice to receive view requests. */
  optedIn: boolean;
  /** Service-owned eligibility (trust / verification). NEVER self-set. */
  eligible: boolean;
}

export interface SelectRecipientsInput {
  /** Candidate contributors (already scoped to the place/city by the service). */
  candidates: readonly ContributorOptIn[];
  /** The viewer making the request — never asked to fulfil their own request. */
  requesterId: string;
  /**
   * Bidirectional blocked set for the requester (lib/blocks.fetchBlockedSet).
   * MUST be null when block state could not be read — that is fail-closed to
   * "ask nobody", never "ask everybody".
   */
  blocked: ReadonlySet<string> | null;
}

/**
 * The OPT-IN-ONLY gate. Returns ONLY contributors who
 *   • opted in (optedIn === true), AND
 *   • are eligible (eligible === true), AND
 *   • are not the requester, AND
 *   • are not blocked in either direction.
 *
 * FAIL CLOSED: if the block set is null (unreadable), NOBODY is asked. A
 * contributor with either boolean false — or any non-boolean-true value — is
 * excluded. Dropping the `optedIn && eligible` predicate is the mutation the
 * test drives to prove a non-opted-in / ineligible contributor is never asked.
 */
export function selectEligibleRecipients(input: SelectRecipientsInput): string[] {
  // Fail-closed: block state unknown ⇒ ask no one.
  if (input.blocked === null) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const c of input.candidates) {
    if (!c || typeof c.contributorId !== "string" || c.contributorId.length === 0) continue;
    if (c.optedIn !== true) continue;      // opt-in required
    if (c.eligible !== true) continue;     // eligibility required
    if (c.contributorId === input.requesterId) continue;
    if (input.blocked.has(c.contributorId)) continue;
    if (seen.has(c.contributorId)) continue;
    seen.add(c.contributorId);
    out.push(c.contributorId);
  }
  return out;
}

// ── Dedupe of near-duplicate open requests (anti-spam) ─────────────────────────

export interface OpenRequestRow {
  subjectId: string;
  claimFamily: string;
  status: string;
}

/**
 * A near-duplicate is an already-OPEN request for the same (place, claim family):
 * a second one adds no new signal, so the service refuses it. Case-normalised on
 * claim family so "Crowd" and "crowd" collapse.
 */
export function isDuplicateOpenRequest(
  open: readonly OpenRequestRow[],
  target: { subjectId: string; claimFamily: string },
): boolean {
  const fam = target.claimFamily.trim().toLowerCase();
  return open.some(
    (r) => r.status === "open" && r.subjectId === target.subjectId && r.claimFamily.trim().toLowerCase() === fam,
  );
}

// ── Safety: refuse a request that would pinpoint a protected/sensitive place ────

export interface RequestSafetyInput {
  /**
   * The strictest Hidden-Gem ceiling that applies to the target place, from
   * lib/mediaLocationVisibility.gemCeilingForItem. NON-null means a restrictive
   * (protected / approximate / reveal-gated) gem shares this place — a
   * "show what's happening HERE right now" request would pinpoint it.
   */
  gemCeiling: string | null;
  /**
   * Whether the gem cross-check actually ran. false ⇒ the lookup could not be
   * determined (e.g. it threw); we refuse rather than guess (fail-closed).
   */
  gemDetermined: boolean;
}

export type RequestSafetyReason = "ok" | "protected_location" | "undetermined";

/**
 * A request is SAFE only when the gem cross-check ran AND found no restrictive
 * gem at the place. An undetermined lookup or any restrictive ceiling refuses
 * the request — a view request must never disclose or pinpoint a protected gem
 * or a private location.
 */
export function requestSafetyDecision(input: RequestSafetyInput): { safe: boolean; reason: RequestSafetyReason } {
  if (input.gemDetermined !== true) return { safe: false, reason: "undetermined" };
  if (input.gemCeiling !== null) return { safe: false, reason: "protected_location" };
  return { safe: true, reason: "ok" };
}
