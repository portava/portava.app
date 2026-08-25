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

/** The normalised claim the chips render — assembled from the place DTO. */
export interface LiveIntelClaim {
  /** Provenance reference (snapshot id) for the "why" surface / corroboration. */
  id?: string | null;
  claimType: string;
  /** Canonical value_json, e.g. { level: 'busy' } or { minMinutes, maxMinutes }. */
  value: unknown;
  band: ConfidenceBand;
  confidence: number | null;
  sourceClass: SourceClass;
  sourceCount: number;
  /** ISO observation time (or generation time for a pattern/prediction). */
  observedAt: string | null;
  /** ISO expiry, when the claim stops being live. */
  validUntil: string | null;
}

export type LiveState = 'live' | 'typical' | 'unknown';

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
 *  - typical  — a real claim but below the live band (a pattern-level answer).
 *  - live     — a first-hand observation at/above the live band and not expired.
 */
export function liveState(claim: LiveIntelClaim | null | undefined, now: Date = new Date()): LiveState {
  if (!claim) return 'unknown';
  if (!mayRenderAsLive(claim.sourceClass)) return 'typical';
  if (claim.validUntil && new Date(claim.validUntil).getTime() <= now.getTime()) return 'unknown';
  const floor = CONFIDENCE_BAND_FLOOR[claim.band];
  if (floor >= CONFIDENCE_BAND_FLOOR[MIN_BAND_FOR_LIVE_STATE]) return 'live';
  return 'typical';
}

export function liveStateLabel(state: LiveState): string {
  return state === 'live' ? 'Live' : state === 'typical' ? 'Typical' : 'Unknown';
}

/** Colour for a state — vermilion signal is reserved for genuinely live. */
export function liveStateColor(state: LiveState): string {
  return state === 'live' ? color.signal : state === 'typical' ? color.warn : color.faint;
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
export function sourceLabel(cls: SourceClass): string {
  return SOURCE_CLASS_LABELS[cls] ?? cls;
}

/**
 * The one-line "why" behind a live claim — plain language, no jargon. Built from
 * the source class + how many independent reports back it + the band.
 */
export function whyExplanation(claim: LiveIntelClaim): string {
  const n = claim.sourceCount;
  const reports = n <= 0 ? 'a traveler report' : n === 1 ? '1 traveler on the ground' : `${n} independent travelers on the ground`;
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
export function observedVerb(cls: SourceClass): string {
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
