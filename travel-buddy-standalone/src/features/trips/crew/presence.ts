/**
 * src/features/trips/crew/presence — §10.2 on the client, in one place.
 *
 * The server judges a crew member's position on its own clock and sends the
 * verdict (`freshnessClass`) with the instant it is about (`observedAt`).
 * Three surfaces render that verdict — the crew tab's member card, the crew
 * tab's density map and the Trip Map's pin — and each used to decide "live"
 * for itself from `statusLabel === 'live_sharing_active'`, which is a fact
 * about the GRANT, not about the position. A grant over a three-hour-old fix
 * was drawn as live on every one of them (census-trips TR166).
 *
 * WHAT THIS MODULE WILL NOT DO. It does not recompute freshness from
 * `observedAt`: a device clock a few minutes fast would make a stale position
 * look live, which is exactly the failure §10.2 names. The class is the
 * server's; the age label is the only thing derived here, and it is a label.
 *
 * FAIL CLOSED. A card with no `freshnessClass` (an older server) is not
 * current: nothing here says "Live" without the server having said so.
 */
import type { CrewMemberCard } from '../../../services/tripCrewLocation.ts';

export type CrewPresenceClass = NonNullable<CrewMemberCard['freshnessClass']>;

/** The two §10.2 classes a position may be drawn as current under. */
export const CURRENT_PRESENCE_CLASSES: readonly CrewPresenceClass[] = ['LIVE', 'RECENT'];

type PresenceFields = Pick<CrewMemberCard, 'freshnessClass' | 'observedAt' | 'liveShareActive' | 'exactCoords'>;

/** May this member's position be drawn as current? Only on the server's word. */
export function presenceIsCurrent(card: Pick<CrewMemberCard, 'freshnessClass'>): boolean {
  return card.freshnessClass != null && CURRENT_PRESENCE_CLASSES.includes(card.freshnessClass);
}

/** The Map's freshness vocabulary for this card — for a pin's treatment. */
export function presenceFreshnessState(card: Pick<CrewMemberCard, 'freshnessClass'>): 'live' | 'recent' | 'stale' | 'unknown' {
  switch (card.freshnessClass) {
    case 'LIVE': return 'live';
    case 'RECENT': return 'recent';
    case 'LAST_KNOWN':
    case 'OFFLINE': return 'stale';
    default: return 'unknown';
  }
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "2m ago" / "3h ago" / "2d ago"; null when there is no instant to age. */
export function presenceAgeLabel(observedAt: string | null | undefined, now: number = Date.now()): string | null {
  if (!observedAt) return null;
  const t = Date.parse(observedAt);
  if (!Number.isFinite(t)) return null;
  const age = Math.max(0, now - t);
  if (age < HOUR) return `${Math.max(1, Math.floor(age / MINUTE))}m ago`;
  if (age < DAY) return `${Math.floor(age / HOUR)}h ago`;
  return `${Math.floor(age / DAY)}d ago`;
}

/**
 * The line a surface shows for the position: the server's class in words,
 * with its age. null when the server sent no class — say nothing rather than
 * guess.
 */
export function presenceLine(card: PresenceFields, now: number = Date.now()): string | null {
  const age = presenceAgeLabel(card.observedAt, now);
  switch (card.freshnessClass) {
    case 'LIVE': return age ? `Live · ${age}` : 'Live';
    case 'RECENT': return age ? `Recent · ${age}` : 'Recent';
    case 'LAST_KNOWN': return age ? `Last known · ${age}` : 'Last known';
    case 'OFFLINE': return 'Offline';
    default: return null;
  }
}

/**
 * Accessible text for a pin or a row: who, whether the position is current,
 * and how old it is. A grant over a stale position says "last known", never
 * "live" — the grant is the choice to share, not a claim about age.
 */
export function presenceAccessibleLabel(name: string, card: PresenceFields, now: number = Date.now()): string {
  const line = presenceLine(card, now);
  if (line) return `${name}, ${line}`;
  return card.liveShareActive ? `${name}, sharing location, position age unknown` : name;
}

/**
 * The crew tab's density buckets. `live` is a member sharing with this viewer
 * over a position the server judged current; `lastKnown` is a member sharing
 * over one it did not — shown, in its own bucket, never as live.
 */
export function crewPresenceBuckets<T extends Pick<CrewMemberCard, 'statusLabel' | 'liveShareActive' | 'freshnessClass'>>(members: readonly T[]): {
  active: T[]; arrived: T[]; live: T[]; lastKnown: T[];
} {
  const active = members.filter((m) => m.statusLabel !== 'not_shared' && m.statusLabel !== 'location_hidden');
  const arrived = members.filter((m) => m.statusLabel === 'arrived');
  const sharing = members.filter((m) => m.statusLabel === 'live_sharing_active' && m.liveShareActive);
  const live = sharing.filter((m) => presenceIsCurrent(m));
  const lastKnown = sharing.filter((m) => !presenceIsCurrent(m));
  return { active, arrived, live, lastKnown };
}
