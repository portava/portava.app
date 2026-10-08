/**
 * Telegraph §11.2 — the Shared Context Rail's five behaviours, as pure
 * functions so they can be asserted without a renderer.
 *
 * Spec §11.2, verbatim:
 *   Active plan        -> Expanded "NOW" card at top.
 *   Upcoming only      -> Compact horizontal cards.
 *   No active/upcoming -> Collapsed summary such as "3 shared plans · 1 past trip".
 *   User scrolls down  -> Rail collapses/sticks minimally; messages get priority.
 *   Critical plan change -> Temporary promoted change card until acknowledged.
 *
 * And §11.1's rail rule, which decides how many cards a horizontal rail may
 * carry: "Use horizontal rails only for short, high-value context sets;
 * provide 'See all' for expansion."
 */
import type {
  RailMode,
  SharedContextItem,
  TelegraphSharedContextProjection,
} from './types.ts';

/** §11.1: a horizontal rail is SHORT. Beyond this, the rest lives behind See all. */
export const RAIL_MAX_CARDS = 4;

/** Scroll distance past which §11.2 says messages get priority. */
export const RAIL_COLLAPSE_SCROLL_PX = 48;

/** §11.2 row 4 — a pure predicate over the message list's scroll offset. */
export function shouldCollapseOnScroll(offsetY: number): boolean {
  return Number.isFinite(offsetY) && offsetY > RAIL_COLLAPSE_SCROLL_PX;
}

/**
 * Statuses that make a change CRITICAL rather than routine. A plan that moved
 * or was called off is the case §11.2's last row exists for; a title edit is
 * not.
 */
export const CRITICAL_STATUSES: readonly string[] = [
  'cancelled',
  'declined',
  'disrupted',
  'rescheduled',
];

export interface CriticalChange {
  objectId: string;
  title: string;
  /** A stable identity for the change, so an acknowledgement survives a refetch. */
  changeKey: string;
  reason: 'CANCELLED' | 'TIME_CHANGED';
  startsAt?: string;
}

function flatten(p: TelegraphSharedContextProjection): SharedContextItem[] {
  return [...p.now, ...p.upcoming, ...p.unresolved, ...p.past];
}

/**
 * §11.2 row 5 — what changed between the projection the user has already seen
 * and the one just fetched.
 *
 * `previous` being null means this is the first load: there is nothing the
 * user has already seen, so nothing is a CHANGE, and the rail must not open
 * with a promoted alarm about a plan that has been cancelled for a week.
 */
export function detectCriticalChanges(
  previous: TelegraphSharedContextProjection | null,
  current: TelegraphSharedContextProjection,
): CriticalChange[] {
  if (!previous) return [];
  const before = new Map(flatten(previous).map((i) => [i.objectId, i]));
  const out: CriticalChange[] = [];
  for (const item of flatten(current)) {
    const prev = before.get(item.objectId);
    if (!prev) continue;
    const statusNow = (item.status ?? '').toLowerCase();
    const statusBefore = (prev.status ?? '').toLowerCase();
    if (statusNow !== statusBefore && CRITICAL_STATUSES.includes(statusNow)) {
      out.push({
        objectId: item.objectId,
        title: item.title,
        changeKey: `${item.objectId}:status:${statusNow}`,
        reason: 'CANCELLED',
        startsAt: item.startsAt,
      });
      continue;
    }
    if (item.startsAt && prev.startsAt && item.startsAt !== prev.startsAt) {
      out.push({
        objectId: item.objectId,
        title: item.title,
        changeKey: `${item.objectId}:startsAt:${item.startsAt}`,
        reason: 'TIME_CHANGED',
        startsAt: item.startsAt,
      });
    }
  }
  return out;
}

export interface RailPresentation {
  /** What §11.2's condition table says to render. */
  mode: RailMode | 'MINIMIZED';
  /** The cards the rail shows right now (never more than RAIL_MAX_CARDS). */
  cards: SharedContextItem[];
  /** How many further items exist behind "See all"; 0 hides the affordance. */
  seeAllCount: number;
  /** §11.2 row 3's string, when the rail is collapsed to a summary. */
  summary: string;
  /** §11.2 row 5: the promoted change card, or null once acknowledged. */
  promotedChange: CriticalChange | null;
  /** True when the rail could not be fully resolved (a server read failed). */
  incomplete: boolean;
}

export interface RailPresentationInput {
  projection: TelegraphSharedContextProjection;
  /** The server's own §11.2 verdict, so client and server cannot disagree. */
  railMode: RailMode;
  collapsedSummary: string;
  incomplete?: boolean;
  /** §11.2 row 4. */
  scrolled?: boolean;
  /** §11.2 row 5 — change keys the user has dismissed. */
  acknowledgedChangeKeys?: readonly string[];
  criticalChanges?: readonly CriticalChange[];
}

/**
 * The one function the rail renders from.
 *
 * ORDER OF PRECEDENCE, and why: a critical change outranks the scroll rule.
 * §11.2 calls the change card "temporary promoted ... until acknowledged", and
 * a promotion that a scroll can silently suppress is not a promotion — the
 * user would never learn the plan was cancelled.
 */
export function resolveRailPresentation(input: RailPresentationInput): RailPresentation {
  const acknowledged = new Set(input.acknowledgedChangeKeys ?? []);
  const promotedChange =
    (input.criticalChanges ?? []).find((c) => !acknowledged.has(c.changeKey)) ?? null;

  const p = input.projection;
  const ordered: SharedContextItem[] =
    input.railMode === 'EXPANDED_NOW'
      ? [...p.now, ...p.upcoming, ...p.unresolved]
      : input.railMode === 'COMPACT_UPCOMING'
        ? [...p.upcoming, ...p.unresolved]
        : [];

  const cards = ordered.slice(0, RAIL_MAX_CARDS);
  const totalBehind = flatten(p).length;
  const seeAllCount = Math.max(0, totalBehind - cards.length);

  if (promotedChange) {
    return {
      mode: input.railMode === 'EMPTY' ? 'COLLAPSED_SUMMARY' : input.railMode,
      cards,
      seeAllCount,
      summary: input.collapsedSummary,
      promotedChange,
      incomplete: Boolean(input.incomplete),
    };
  }

  if (input.scrolled && input.railMode !== 'EMPTY') {
    // §11.2 row 4 — collapse to a single minimal line; the messages win.
    return {
      mode: 'MINIMIZED',
      cards: [],
      seeAllCount: totalBehind,
      summary: input.collapsedSummary,
      promotedChange: null,
      incomplete: Boolean(input.incomplete),
    };
  }

  return {
    mode: input.railMode,
    cards,
    seeAllCount,
    summary: input.collapsedSummary,
    promotedChange: null,
    incomplete: Boolean(input.incomplete),
  };
}

// ── §11.2 row 5 across an absence (census-telegraph T264) ────────────────────
//
// `detectCriticalChanges` compares two fetches of ONE mounted rail, and returns
// nothing on a first load — so a plan moved or called off while the member was
// away was never shown: when they came back the rail mounted fresh and had no
// "before". What the member last SAW is therefore kept per (account, thread) on
// the device (railSeenStore.ts) as a SeenSnapshot — per object, only the two
// fields a critical change is read from — and a first load compares against it.
//
// A change stays promoted across reloads until it is ACKNOWLEDGED: the snapshot
// keeps the old value of an object whose change is still pending, and takes the
// new value only once the change card is dismissed. With no snapshot at all (the
// member has never opened this conversation on this device) there is nothing
// they saw, so nothing is a change — the same rule as a first load.

/** Per object id: the status and start the member last saw. */
export type SeenSnapshot = Record<string, { status: string | null; startsAt: string | null }>;

/** The snapshot of a projection, as it was shown. */
export function seenSnapshotFrom(p: TelegraphSharedContextProjection): SeenSnapshot {
  const out: SeenSnapshot = {};
  for (const i of flatten(p)) out[i.objectId] = { status: i.status ?? null, startsAt: i.startsAt ?? null };
  return out;
}

/** §11.2 row 5 against what the member last saw — the same rule as detectCriticalChanges. */
export function detectChangesSinceSeen(
  seen: SeenSnapshot | null,
  current: TelegraphSharedContextProjection,
): CriticalChange[] {
  if (!seen) return [];
  const past = Object.entries(seen).map(
    ([objectId, s]) => ({ objectId, status: s.status ?? '', startsAt: s.startsAt ?? undefined }) as SharedContextItem,
  );
  return detectCriticalChanges(
    { conversationId: current.conversationId, generatedAt: current.generatedAt, now: [], upcoming: [], unresolved: [], past },
    current,
  );
}

/**
 * The snapshot to keep after showing `current`: every object as shown, except
 * one whose change is still pending (not acknowledged), which keeps the value
 * the member last saw so the change is found again on the next load. Objects no
 * longer in the projection are dropped, so the record never outgrows the rail.
 */
export function nextSeenSnapshot(
  seen: SeenSnapshot | null,
  current: TelegraphSharedContextProjection,
  pending: readonly CriticalChange[],
  acknowledgedChangeKeys: readonly string[],
): SeenSnapshot {
  const shown = seenSnapshotFrom(current);
  const ack = new Set(acknowledgedChangeKeys);
  for (const c of pending) {
    if (ack.has(c.changeKey)) continue;
    const before = seen?.[c.objectId];
    if (before) shown[c.objectId] = before;
  }
  return shown;
}
