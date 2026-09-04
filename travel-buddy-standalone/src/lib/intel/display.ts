/**
 * Intelligence Gathering — display helpers for the decision-exposure chips and
 * the capture surfaces (client mirror of the api-server confidence/label logic).
 *
 * The spec's "decision-exposure" requirement is that a live claim is never shown
 * as a bare value: the reader always sees the value, a confidence band, the
 * source-class label, when it was observed, and a one-line "why". This module
 * turns a normalised `LiveIntelClaim` into exactly those display strings, and
 * derives the honest Live / Typical / Unknown state.
 *
 * Degradation is fail-closed and never invents confidence: an unknown claim
 * type, a non-observation source presented as live, or a value below the live
 * band all degrade toward "typical"/"unknown" rather than up.
 *
 * RUNTIME EFFECT: NONE — pure functions.
 */
import { color } from '../../theme/tokens.ts';
import {
  CONFIDENCE_BAND_FLOOR,
  MIN_BAND_FOR_LIVE_STATE,
  SOURCE_CLASS_LABELS,
  mayRenderAsLive,
  isSpecialistOnlyCrowd,
  type ConfidenceBand,
  type SourceClass,
} from './contracts.ts';
import { CONFLICT_LABEL, normalizeConflictState, type ConflictState } from './conflict.ts';

/**
 * Coarse cohort-size bucket (mirror of api-server `SourceCountBucket`). The EXACT
 * distinct-actor count is a privacy parameter the server withholds, so the client
 * only ever receives a bucket. Every published aggregate is already ≥ the k=15
 * floor, so even `few` means "more than a dozen".
 */
export type SourceCountBucket = 'few' | 'several' | 'many';

/** Mirror of api-server `sourceCountBucket(n)` — for a legacy numeric fallback only. */
export function sourceCountBucketFromCount(n: number): SourceCountBucket {
  if (n < 25) return 'few';
  if (n < 100) return 'several';
  return 'many';
}

/** The normalised claim the chips render — assembled from the place DTO. */
export interface LiveIntelClaim {
  /** Provenance reference (snapshot id) for the "why" surface / corroboration. */
  id?: string | null;
  claimType: string;
  /** Canonical value_json, e.g. { level: 'busy' } or { minMinutes, maxMinutes }. */
  value: unknown;
  band: ConfidenceBand;
  confidence: number | null;
  /**
   * Who is speaking. NULL when the wire carried no class, or one this build
   * does not recognise — deliberately nullable rather than defaulted, because
   * every default is an assertion and the tempting one (firsthand_unverified)
   * is the §37 violation: an unattributed or paid claim borrowing a traveller's
   * credibility. Render it via sourceLabel, which says "Source not attributed".
   */
  sourceClass: SourceClass | null;
  /** Coarse cohort bucket; null when the source carries no cohort (synthesised). */
  sourceCountBucket: SourceCountBucket | null;
  /**
   * The server's authoritative live/emerging state when the envelope carries it.
   * Preferred over the band-derived state so the client never over-labels; null
   * for a synthesised claim, which then falls back to band derivation.
   */
  serverState?: LiveState | null;
  /** ISO observation time (or generation time for a pattern/prediction). */
  observedAt: string | null;
  /** ISO expiry, when the claim stops being live. */
  validUntil: string | null;
  /**
   * §10 conflict state from the wire. 'material' ⇒ never rendered as Live
   * (liveState caps it) and labelled "Reports differ". Absent/null ⇒ none.
   */
  conflictState?: ConflictState | null;
}

/**
 * `emerging` mirrors the api-server's narrower state (#156): a fresh first-hand
 * observation that cleared the serve floor (likely_current) but is NOT yet
 * Live-qualified (band live/strong). It renders distinctly from `live` so the
 * client never overstates evidence as Live before it qualifies.
 */
export type LiveState = 'live' | 'emerging' | 'typical' | 'unknown';

// ── Confidence band (mirror of api-server confidenceBand) ────────────────────
export function confidenceBand(score: number | null | undefined): ConfidenceBand {
  if (typeof score !== 'number' || !Number.isFinite(score) || score < 0) return 'unverified';
  if (score >= CONFIDENCE_BAND_FLOOR.strong) return 'strong';
  if (score >= CONFIDENCE_BAND_FLOOR.live) return 'live';
  if (score >= CONFIDENCE_BAND_FLOOR.likely_current) return 'likely_current';
  if (score >= CONFIDENCE_BAND_FLOOR.provisional) return 'provisional';
  return 'unverified';
}

export const BAND_LABEL: Record<ConfidenceBand, string> = {
  unverified: 'Unverified',
  provisional: 'Provisional',
  likely_current: 'Likely current',
  live: 'Live',
  strong: 'Confirmed',
};

/**
 * Honest state for a claim:
 *  - unknown  — nothing usable, or a non-observation source, or expired.
 *  - typical  — a real claim but below the serve floor (a pattern-level answer).
 *  - emerging — a fresh first-hand observation at/above the serve floor
 *               (likely_current) but below the live band; real and current, not
 *               yet Live-qualified.
 *  - live     — a first-hand observation at/above the live band and not expired.
 *
 * Mirrors the api-server's live/emerging split (#156): `live` is reserved for band
 * live/strong. When the envelope carries the server's own state we trust it (it is
 * authoritative and derived the same way); otherwise we derive from the band, so a
 * synthesised claim degrades honestly too. Expiry and non-observation sources are
 * enforced first — an expired or historical claim is never live, whatever the
 * server said.
 */
export function liveState(claim: LiveIntelClaim | null | undefined, now: Date = new Date()): LiveState {
  if (!claim) return 'unknown';
  // An unattributed claim is not live. "Live" asserts someone observed this
  // just now; with no source class we cannot say who, so we cannot say that.
  // Fails toward 'typical' — the same direction a forecast or a historical
  // pattern falls, and the direction §37 requires.
  if (claim.sourceClass === null) return 'typical';
  if (!mayRenderAsLive(claim.sourceClass)) return 'typical';
  if (claim.validUntil && new Date(claim.validUntil).getTime() <= now.getTime()) return 'unknown';
  // §10: a MATERIAL conflict is never Live, whatever the server state or band
  // said — the server already caps both, this is the client's own guard so a
  // stale payload or a hand-built claim cannot overstate a disputed fact. It
  // degrades to 'emerging' (real, current, not Live-qualified), never lower:
  // the value is shown WITH "Reports differ", not hidden.
  const material = normalizeConflictState(claim.conflictState) === 'material';
  if (claim.serverState === 'live' || claim.serverState === 'emerging') {
    return material ? 'emerging' : claim.serverState;
  }
  const floor = CONFIDENCE_BAND_FLOOR[claim.band];
  if (floor >= CONFIDENCE_BAND_FLOOR.live) return material ? 'emerging' : 'live';
  if (floor >= CONFIDENCE_BAND_FLOOR[MIN_BAND_FOR_LIVE_STATE]) return 'emerging';
  return 'typical';
}

/**
 * The state label. Under a MATERIAL conflict the label is "Reports differ"
 * wherever a Live/Observed label would have rendered (§10) — the state itself
 * is still 'emerging' (see liveState), so nothing else changes.
 */
export function liveStateLabel(state: LiveState, conflictState?: ConflictState | null): string {
  if ((state === 'live' || state === 'emerging') && normalizeConflictState(conflictState) === 'material') {
    return CONFLICT_LABEL;
  }
  return state === 'live'
    ? 'Live'
    : state === 'emerging'
      ? 'Observed'
      : state === 'typical'
        ? 'Typical'
        : 'Unknown';
}

/** Colour for a state — vermilion signal is reserved for genuinely live; emerging
 *  gets its own teal accent so it never borrows the Live vermilion. A material
 *  conflict takes the warn colour: neither Live's vermilion nor emerging's teal. */
export function liveStateColor(state: LiveState, conflictState?: ConflictState | null): string {
  if ((state === 'live' || state === 'emerging') && normalizeConflictState(conflictState) === 'material') {
    return color.warn;
  }
  return state === 'live'
    ? color.signal
    : state === 'emerging'
      ? color.deep
      : state === 'typical'
        ? color.warn
        : color.faint;
}

// ── Claim value formatting ───────────────────────────────────────────────────
const CROWD_LABEL: Record<string, string> = {
  dead: 'Dead', quiet: 'Quiet', moderate: 'Moderate', busy: 'Busy', packed: 'Packed',
};
const TRAJECTORY_LABEL: Record<string, string> = {
  emerging: 'Emerging', building: 'Building', peaking: 'Peaking', stable: 'Holding steady',
  fragmenting: 'Fragmenting', relocating: 'Moving on', declining: 'Winding down', ending: 'Ending',
};

/** A short human title for a claim type (e.g. the chip's leading label). */
export function claimTypeLabel(claimType: string): string {
  switch (claimType) {
    case 'crowd.level': return 'Crowd';
    case 'crowd.trajectory': return 'Trend';
    case 'queue.wait': return 'Queue';
    case 'access.walk_in': return 'Walk-in';
    case 'crowd.mix': return 'Crowd mix';
    case 'music.current': return 'Music';
    case 'price.cover': return 'Cover';
    case 'inventory.status': return 'Availability';
    case 'service.wait': return 'Service';
    case 'transit.condition': return 'Route';
    default: return claimType;
  }
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Render a canonical value_json into a display string, fail-closed to '—'. */
export function formatClaimValue(claimType: string, value: unknown): string {
  // crowd.level can arrive as a bare string (today's read path) or { level }.
  if (claimType === 'crowd.level') {
    const level = typeof value === 'string' ? value : asRecord(value)?.level;
    if (typeof level === 'string' && !isSpecialistOnlyCrowd(level)) return CROWD_LABEL[level] ?? capitalize(level);
    return '—';
  }
  if (claimType === 'crowd.trajectory') {
    const traj = asRecord(value)?.trajectory;
    return typeof traj === 'string' ? (TRAJECTORY_LABEL[traj] ?? capitalize(traj)) : '—';
  }
  if (claimType === 'queue.wait') {
    const r = asRecord(value);
    const min = typeof r?.minMinutes === 'number' ? r.minMinutes : null;
    const max = r?.maxMinutes;
    if (min == null) return '—';
    if (max == null) return `${min}+ min`;
    if (typeof max === 'number') return min === 0 && max === 0 ? 'No wait' : `${min}–${max} min`;
    return `${min} min`;
  }
  if (claimType === 'access.walk_in') {
    const accepted = asRecord(value)?.accepted;
    if (accepted === true) return 'Walk-ins OK';
    if (accepted === false) return 'Turned away';
    return '—';
  }
  const r = asRecord(value);
  if (r && typeof r.level === 'string') return capitalize(r.level);
  if (typeof value === 'string') return capitalize(value);
  return '—';
}

// ── Source label + "why" explanation ─────────────────────────────────────────
export function sourceLabel(cls: SourceClass | null): string {
  // null means the wire carried no source class, or one this build does not
  // recognise. It must NOT read as a traveller report: §37 forbids letting a
  // paid or unattributed assertion borrow firsthand credibility, and an
  // unlabelled claim reads as the map's own finding — the same borrowing by a
  // quieter route. Matches the server's describeClaim for the same case.
  if (cls === null) return 'Source not attributed';
  return SOURCE_CLASS_LABELS[cls] ?? 'Source not attributed';
}

/**
 * The one-line "why" behind a live claim — plain language, no jargon. Built from
 * the source class + how many independent reports back it + the band.
 */
export function whyExplanation(claim: LiveIntelClaim): string {
  // The exact contributor count is withheld (privacy); render the coarse bucket
  // honestly. Every published bucket is ≥ the k=15 floor, so none understates.
  const bucket = claim.sourceCountBucket;
  const reports =
    bucket === 'many'
      ? 'over a hundred travelers on the ground'
      : bucket === 'several'
        ? 'dozens of travelers on the ground'
        : bucket === 'few'
          ? 'more than a dozen travelers on the ground'
          : 'travelers on the ground';
  switch (claim.sourceClass) {
    case 'verified_firsthand':
      return `Confirmed by ${reports} whose presence was verified. Fades as it ages.`;
    case 'firsthand_unverified':
      return `Reported by ${reports}. Not presence-verified, so treat it as a fresh tip.`;
    case 'official_signed':
      return 'Posted by the venue or an official source — not independent traveler consensus.';
    case 'historical_pattern':
      return 'A typical pattern for this time, not a live observation.';
    case 'portava_prediction':
      return 'A Portava estimate, not something anyone reported right now.';
    default:
      return `Based on ${reports}.`;
  }
}

// ── Time formatting ──────────────────────────────────────────────────────────
/** "Checked" for observations, "As of" generically. */
export function observedVerb(cls: SourceClass | null): string {
  // An unattributed claim gets the neutral verb. "Checked" asserts somebody
  // went and looked, which is exactly the claim we cannot support here.
  if (cls === null) return 'As of';
  return mayRenderAsLive(cls) ? 'Checked' : 'As of';
}

/** A relative "how fresh" string, e.g. "just now", "6 min ago", "2h ago". */
export function relativeTime(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const secs = Math.max(0, Math.round((now.getTime() - then) / 1000));
  if (secs < 45) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

function capitalize(s: string): string {
  return s.length ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
