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
