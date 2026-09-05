/**
 * groupDecision — presentation for §36 Phase 6's group decision and recovery.
 *
 * WHAT IT MAY DECIDE: how a tally READS, and whether the confirm affordance is
 * armed. Both are restatements of `tally.readyToConfirm` / `tally.blockedBy`,
 * which the SERVER computed — this module never re-derives readiness from the
 * counts, because two definitions of "the crew agreed" is exactly one too many.
 *
 * WHAT IT MAY NOT DECIDE: anything about who is where. §23's coarse-area rule
 * is enforced by the shape of `JourneyCrewArea`, which has no coordinate field;
 * nothing here reaches for one, and `crewPresenceLine` renders the label the
 * server sent or says nothing at all.
 *
 * §37. `recoveryEvidenceLine` renders a `live` entry's source text and a
 * `schedule` entry's plain "planned time has passed". It CANNOT dress the
 * second as the first: the schedule branch of the union carries no source, no
 * claim reference and no observation time, so there is nothing to render that
 * would look like a report from the world.
 *
 * Pure: no React, no network, no storage.
 */
import type {
  JourneyCrewArea,
  JourneyShortlistItem,
  JourneyTally,
  RecoveryEntry,
} from '../../../services/mapJourney.ts';

// ── The tally ─────────────────────────────────────────────────────────────────

/**
 * The status line under a shortlist candidate.
 *
 * A DECLINE IS NAMED, not netted off. "2 in, 1 out" is a different sentence
 * from "2 in" and the difference is a person who said no.
 */
export function tallyLine(tally: JourneyTally): string {
  if (tally.readyToConfirm) return `Everyone's in (${tally.accepts})`;
  switch (tally.blockedBy) {
    case 'declined':
      return tally.accepts > 0
        ? `${tally.accepts} in · ${tally.declines} said no`
        : `${tally.declines} said no`;
    case 'awaiting_votes':
      return `${tally.accepts} in · waiting on ${tally.pending}`;
    case 'too_few_accepts':
      return tally.accepts === 0 ? 'No votes yet' : `${tally.accepts} in · needs one more`;
    default:
      return `${tally.accepts} in`;
  }
}

/**
 * May the UI offer "Add it to the plan"?
 *
 * The server's answer, passed through. Never `accepts > declines`: a majority
 * is not agreement, and re-deriving it here would let the sheet arm a confirm
 * the server considers blocked.
 */
export function confirmArmed(tally: JourneyTally): boolean {
  return tally.readyToConfirm === true;
}

/** The viewer's own vote, for the pressed state of the two buttons. */
export function myVoteState(tally: JourneyTally): {
  accepted: boolean;
  declined: boolean;
} {
  return { accepted: tally.myVote === 'accept', declined: tally.myVote === 'decline' };
}

/**
 * Optimistically apply the viewer's own vote to a tally, for the moment between
 * the tap and the server's echo.
 *
 * `readyToConfirm` is FORCED FALSE on every optimistic result, whatever the
 * counts look like. Readiness is a server decision, and an optimistic UI that
 * armed the confirm button would let a member add something to the plan on the
 * strength of a vote that had not landed yet.
 */
export function applyOptimisticVote(
  tally: JourneyTally,
  vote: 'accept' | 'decline',
): JourneyTally {
  const had = tally.myVote;
  if (had === vote) return tally;

  let { accepts, declines, pending } = tally;
  if (had === 'accept') accepts = Math.max(0, accepts - 1);
  if (had === 'decline') declines = Math.max(0, declines - 1);
  if (had === null) pending = Math.max(0, pending - 1);
  if (vote === 'accept') accepts += 1;
  else declines += 1;

  return {
    accepts,
    declines,
    pending,
    myVote: vote,
    readyToConfirm: false,
    blockedBy: 'awaiting_votes',
  };
}

// ── Crew ──────────────────────────────────────────────────────────────────────

/**
 * How a crew member's presence reads on the sheet: their coarse area label, or
 * nothing.
 *
 * There is no fallback that reveals more. A member with no `areaLabel` is not
 * sharing an area, and "nearby" or a distance would both be inventions.
 */
export function crewPresenceLine(member: JourneyCrewArea): string | null {
  const label = member.areaLabel?.trim();
  return label ? label : null;
}

/** Crew members with something to show, in a stable order. */
export function visibleCrew(crew: readonly JourneyCrewArea[]): JourneyCrewArea[] {
  return [...crew].sort((a, b) => {
    const an = a.name ?? a.userId;
    const bn = b.name ?? b.userId;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
}

// ── Recovery ──────────────────────────────────────────────────────────────────

/**
 * The evidence line under a recovery entry.
 *
 * The `live` branch cites the source the server named. The `schedule` branch
 * says what it is — a planned time that has passed — and has no source to cite
 * because there is no observation behind it (§37).
 */
export function recoveryEvidenceLine(entry: RecoveryEntry): string {
  if (entry.evidence.kind === 'live') return entry.evidence.sourceText;
  return 'From your plan — not a report about the place';
}

/** The headline: what happened, in the server's own words. */
export function recoveryTitle(entry: RecoveryEntry): string {
  return `${entry.stopTitle} — ${entry.reason}`;
}

/**
 * The suggestion line, or null when there is nothing to suggest.
 *
 * Null is a real answer: a stop with no same-category alternative gets the
 * problem stated and no invented replacement.
 */
export function recoverySuggestionLine(entry: RecoveryEntry): string | null {
  return entry.alternativeTitle ? `Try ${entry.alternativeTitle} instead` : null;
}

/**
 * Order recovery entries: live constraints (something changed in the world)
 * before missed windows (something changed in the plan), then by stop title so
 * the list is stable between polls.
 */
export function orderRecovery(entries: readonly RecoveryEntry[]): RecoveryEntry[] {
  return [...entries].sort((a, b) => {
    const ak = a.evidence.kind === 'live' ? 0 : 1;
    const bk = b.evidence.kind === 'live' ? 0 : 1;
    if (ak !== bk) return ak - bk;
    return a.stopTitle < b.stopTitle ? -1 : a.stopTitle > b.stopTitle ? 1 : 0;
  });
}

// ── The shortlist as a whole ──────────────────────────────────────────────────

/**
 * The sheet's header line.
 *
 * `truncated` is SURFACED rather than swallowed: a crew that suggested twenty
 * places and sees twelve needs to know the list is capped, or the eight they
 * cannot see look like suggestions nobody made.
 */
export function shortlistHeaderLine(
  items: readonly JourneyShortlistItem[],
  truncated: number,
): string {
  if (items.length === 0) return 'Nothing on the shortlist yet';
  const base = items.length === 1 ? '1 option' : `${items.length} options`;
  return truncated > 0 ? `${base} · ${truncated} more not shown` : base;
}
