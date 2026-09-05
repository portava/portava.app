/**
 * Group decision + recovery presentation (§36 Phase 6, §23, §37).
 *
 * The properties these tests exist for:
 *
 *   - READINESS IS THE SERVER'S ANSWER. `confirmArmed` never re-derives "the
 *     crew agreed" from the counts; a tally the server calls blocked stays
 *     blocked however favourable the numbers look.
 *   - A DECLINE IS NAMED, not netted off. "2 in, 1 out" is a different sentence
 *     from "2 in", and the difference is a person who said no.
 *   - AN OPTIMISTIC VOTE NEVER ARMS THE CONFIRM. The button that adds something
 *     to a shared plan may not be armed by a vote that has not landed.
 *   - §23. Nothing here reads or invents a crew position; a member with no area
 *     label gets no line at all rather than "nearby" or a distance.
 *   - §37. A schedule-provenance recovery cannot be rendered as a report about
 *     the place — the union branch has no source to cite.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyOptimisticVote,
  confirmArmed,
  crewPresenceLine,
  myVoteState,
  orderRecovery,
  recoveryEvidenceLine,
  recoverySuggestionLine,
  recoveryTitle,
  shortlistHeaderLine,
  tallyLine,
  visibleCrew,
} from '../groupDecision.ts';
import type {
  JourneyCrewArea,
  JourneyShortlistItem,
  JourneyTally,
  RecoveryEntry,
} from '../../../../services/mapJourney.ts';

function tally(over: Partial<JourneyTally> = {}): JourneyTally {
  return {
    accepts: 0,
    declines: 0,
    pending: 0,
    myVote: null,
    readyToConfirm: false,
    blockedBy: 'too_few_accepts',
    ...over,
  };
}

function item(id: string): JourneyShortlistItem {
  return { id, title: id, category: 'dining', startsAt: null, locationName: null, tally: tally() };
}

// ── the tally ─────────────────────────────────────────────────────────────────

test('a decline is named, not netted off', () => {
  const line = tallyLine(tally({ accepts: 2, declines: 1, blockedBy: 'declined' }));
  assert.equal(line, '2 in · 1 said no');
  assert.ok(line.includes('said no'), 'the person who said no is visible in the line');
});

test('waiting on someone reads as waiting, not as a shortfall', () => {
  assert.equal(
    tallyLine(tally({ accepts: 2, pending: 1, blockedBy: 'awaiting_votes' })),
    '2 in · waiting on 1',
  );
});

test('everyone in reads as agreement', () => {
  assert.equal(
    tallyLine(tally({ accepts: 3, readyToConfirm: true, blockedBy: null })),
    "Everyone's in (3)",
  );
});

test('no votes yet is its own line', () => {
  assert.equal(tallyLine(tally()), 'No votes yet');
});

test('confirmArmed is the SERVER answer, never a majority re-derived here', () => {
  // A tally the server calls blocked, with numbers that look like a landslide.
  const blocked = tally({ accepts: 9, declines: 1, readyToConfirm: false, blockedBy: 'declined' });
  assert.equal(confirmArmed(blocked), false, 'a majority is not agreement');
  assert.equal(confirmArmed(tally({ accepts: 2, readyToConfirm: true, blockedBy: null })), true);
});

test('myVoteState reflects only the viewer', () => {
  assert.deepEqual(myVoteState(tally({ myVote: 'accept' })), { accepted: true, declined: false });
  assert.deepEqual(myVoteState(tally({ myVote: 'decline' })), { accepted: false, declined: true });
  assert.deepEqual(myVoteState(tally()), { accepted: false, declined: false });
});

// ── optimistic voting ─────────────────────────────────────────────────────────

test('an optimistic vote moves the counts and consumes a pending slot', () => {
  const next = applyOptimisticVote(tally({ accepts: 1, pending: 2 }), 'accept');
  assert.equal(next.accepts, 2);
  assert.equal(next.pending, 1);
  assert.equal(next.myVote, 'accept');
});

test('changing your mind moves the vote, it does not add one', () => {
  const next = applyOptimisticVote(
    tally({ accepts: 2, declines: 0, pending: 0, myVote: 'accept' }),
    'decline',
  );
  assert.equal(next.accepts, 1);
  assert.equal(next.declines, 1);
  assert.equal(next.pending, 0);
});

test('re-casting the same vote changes nothing', () => {
  const before = tally({ accepts: 2, myVote: 'accept' });
  assert.equal(applyOptimisticVote(before, 'accept'), before);
});

test('an optimistic vote NEVER arms the confirm', () => {
  // The last outstanding vote, cast optimistically: the counts now look ready.
  const next = applyOptimisticVote(tally({ accepts: 2, pending: 1 }), 'accept');
  assert.equal(next.accepts, 3);
  assert.equal(next.pending, 0);
  assert.equal(next.readyToConfirm, false, 'readiness is a server decision');
  assert.equal(confirmArmed(next), false);
});

// ── crew (§23) ────────────────────────────────────────────────────────────────

test('a crew member with no area label gets no line — never "nearby"', () => {
  const member: JourneyCrewArea = {
    userId: 'u1',
    name: 'Mai',
    areaLabel: null,
    statusLabel: 'in_area',
  };
  assert.equal(crewPresenceLine(member), null);
  assert.equal(crewPresenceLine({ ...member, areaLabel: '   ' }), null);
  assert.equal(crewPresenceLine({ ...member, areaLabel: 'Riverside' }), 'Riverside');
});

test('the crew list is stable and carries no coordinate', () => {
  const crew: JourneyCrewArea[] = [
    { userId: 'u2', name: 'Zoe', areaLabel: 'An Thuong', statusLabel: 'in_area' },
    { userId: 'u1', name: 'Mai', areaLabel: 'Riverside', statusLabel: 'in_area' },
  ];
  const ordered = visibleCrew(crew);
  assert.deepEqual(ordered.map((c) => c.name), ['Mai', 'Zoe']);
  assert.ok(!/"lat"|"lng"|coords/i.test(JSON.stringify(ordered)));
});

// ── recovery (§37) ────────────────────────────────────────────────────────────

const LIVE: RecoveryEntry = {
  stopId: 's1',
  stopTitle: 'Madame Lân',
  reasonCode: 'walk_in_denied',
  reason: 'Reported not accepting walk-ins right now',
  evidence: {
    kind: 'live',
    claimRef: 'ref-1',
    claimType: 'access.walk_in',
    sourceLabel: 'Traveler report',
    sourceText: 'Traveler report · several recent traveler reports',
    observedAt: '2026-09-05T10:00:00.000Z',
    validUntil: '2026-09-05T10:30:00.000Z',
  },
  alternativeId: 'alt-1',
  alternativeTitle: 'Bếp Cuốn',
  alternativeRank: 0,
};

const SCHEDULE: RecoveryEntry = {
  stopId: 's2',
  stopTitle: 'Cham Museum',
  reasonCode: 'window_missed',
  reason: 'Its planned time has passed',
  evidence: { kind: 'schedule', windowEndedAt: '2026-09-05T09:00:00.000Z' },
  alternativeId: null,
  alternativeTitle: null,
  alternativeRank: null,
};

test('a live recovery cites the source the server named', () => {
  assert.equal(recoveryEvidenceLine(LIVE), 'Traveler report · several recent traveler reports');
  assert.equal(recoveryTitle(LIVE), 'Madame Lân — Reported not accepting walk-ins right now');
  assert.equal(recoverySuggestionLine(LIVE), 'Try Bếp Cuốn instead');
});

test('a schedule recovery says it is from the plan, and has no source to cite', () => {
  const line = recoveryEvidenceLine(SCHEDULE);
  assert.equal(line, 'From your plan — not a report about the place');
  assert.ok(!/report ·|traveler report ·/i.test(line));
  // The union branch itself carries nothing that could be rendered as evidence
  // about the venue.
  assert.deepEqual(Object.keys(SCHEDULE.evidence).sort(), ['kind', 'windowEndedAt']);
});

test('a stop with no alternative gets the problem stated and no invented replacement', () => {
  assert.equal(recoverySuggestionLine(SCHEDULE), null);
});

test('live constraints are listed before missed windows', () => {
  const ordered = orderRecovery([SCHEDULE, LIVE]);
  assert.deepEqual(ordered.map((e) => e.stopId), ['s1', 's2']);
});

// ── the header ────────────────────────────────────────────────────────────────

test('the header surfaces the cap instead of swallowing it', () => {
  assert.equal(shortlistHeaderLine([], 0), 'Nothing on the shortlist yet');
  assert.equal(shortlistHeaderLine([item('a')], 0), '1 option');
  assert.equal(shortlistHeaderLine([item('a'), item('b')], 0), '2 options');
  assert.equal(shortlistHeaderLine([item('a')], 8), '1 option · 8 more not shown');
});
