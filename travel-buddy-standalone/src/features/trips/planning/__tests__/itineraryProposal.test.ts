/**
 * census G160 — a pasted itinerary becomes a PROPOSAL of timed stops; each READY
 * stop is the structure composer's own ADD_COMMITMENT with its `starts_at`.
 * Run: node --import tsx/esm --test src/features/trips/planning/__tests__/itineraryProposal.test.ts
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import type { PasteReviewItem } from '../../../../platform/input-assistance/paste/pasteReview.ts';
import type { InputSuggestion } from '../../../../platform/input-assistance/types/inputSuggestion.ts';
import type { TripCommandRequest, TripCommandResult } from '../../../../services/tripCommands.ts';
import { proposeStops, stopState, initiallyTicked, commitmentInputFor, blockWords, type ProposalContext } from '../itineraryProposal.ts';
import { commitmentCommand, isInstant } from '../tripStructurePayloads.ts';

const CITY = '33333333-3333-4333-8333-333333333333';
const VENUE = '44444444-4444-4444-8444-444444444444';

function cityCandidate(over: Partial<InputSuggestion> = {}, timezone: string | null = 'Asia/Ho_Chi_Minh'): InputSuggestion {
  return {
    id: `trip_stop_place:city:${CITY}`, type: 'entity', context: 'trip_stop_place', label: 'Da Nang', subtitle: 'Vietnam',
    entityType: 'city', entityId: CITY, source: 'canonical', policyVersion: 'v',
    structuredValue: { entityType: 'city', cityId: CITY, city: 'Da Nang', country: 'Vietnam', countryCode: 'VN', lat: 16.05, lng: 108.2, timezone },
    ...over,
  };
}
function venueCandidate(timezone: string | null = 'Asia/Ho_Chi_Minh', label = 'Sky36'): InputSuggestion {
  return {
    id: `trip_stop_place:places:${VENUE}`, type: 'entity', context: 'trip_stop_place', label, subtitle: 'Da Nang',
    entityType: 'place', entityId: VENUE, source: 'canonical', policyVersion: 'v',
    action: { type: 'open_entity', entityType: 'place', entityId: VENUE },
    structuredValue: { entityType: 'venue', venueId: VENUE, venue: label, cityId: CITY, city: 'Da Nang', country: 'Vietnam', countryCode: 'VN', lat: 16.07, lng: 108.22, timezone },
  };
}
function item(index: number, over: Partial<PasteReviewItem> = {}): PasteReviewItem {
  return {
    index, raw: 'Sky36 at 9pm', source: 'text', query: 'Sky36', lat: null, lng: null, timeHint: '9pm', dayLabel: 'Friday',
    status: 'resolved', reason: null, partial: false, candidates: [venueCandidate()], ...over,
  };
}
const ctx = (over: Partial<ProposalContext> = {}): ProposalContext => ({
  tripTimezone: null, trip: { start: '2026-10-20', end: '2026-10-27' }, now: new Date('2026-10-22T03:00:00Z'), deviceZone: 'Europe/Berlin', ...over,
});

describe('a stop is READY only when its instant is unambiguous', () => {
  it('a venue with a time, under a day the trip pins down, in the venue\'s own zone', () => {
    assert.deepEqual(stopState(item(0), ctx()), {
      kind: 'ready', startsAt: '2026-10-23T21:00:00+07:00', date: '2026-10-23', time: { hour: 21, minute: 0 }, zone: 'Asia/Ho_Chi_Minh', zoneFrom: 'place',
    });
    // a CITY row's bound zone is the place's zone too
    assert.equal((stopState(item(1, { candidates: [cityCandidate()] }), ctx()) as { zone: string }).zone, 'Asia/Ho_Chi_Minh');
  });

  it('"Dinner at 7": morning or evening is HELD for the person, and their answer is used', () => {
    const at7 = item(0, { timeHint: '7' });
    assert.deepEqual(stopState(at7, ctx()), { kind: 'hold', need: 'meridiem', am: { hour: 7, minute: 0 }, pm: { hour: 19, minute: 0 } });
    assert.equal((stopState(at7, ctx(), { meridiem: 'pm' }) as { startsAt: string }).startsAt, '2026-10-23T19:00:00+07:00');
    assert.equal((stopState(at7, ctx(), { meridiem: 'am' }) as { startsAt: string }).startsAt, '2026-10-23T07:00:00+07:00');
  });

  it('the ZONE RULE is the composer\'s: the place\'s, else the trip\'s, else the phone\'s ONLY on a tap', () => {
    const noZone = item(0, { candidates: [venueCandidate(null)] });
    const viaTrip = stopState(noZone, ctx({ tripTimezone: 'Asia/Bangkok' }));
    assert.equal(viaTrip.kind === 'ready' && `${viaTrip.zone}|${viaTrip.zoneFrom}|${viaTrip.startsAt}`, 'Asia/Bangkok|trip|2026-10-23T21:00:00+07:00');
    assert.deepEqual(stopState(noZone, ctx()), { kind: 'hold', need: 'zone', deviceZone: 'Europe/Berlin' });
    const taken = stopState(noZone, ctx(), { deviceZone: 'Europe/Berlin' });
    assert.equal(taken.kind === 'ready' && `${taken.zoneFrom}|${taken.startsAt}`, 'device|2026-10-23T21:00:00+02:00');
    // a place's zone wins over the trip's; a malformed zone is no zone
    assert.equal((stopState(item(0), ctx({ tripTimezone: 'Asia/Bangkok' })) as { zoneFrom: string }).zoneFrom, 'place');
    assert.deepEqual(stopState(item(0, { candidates: [venueCandidate('Mars/Olympus_Mons')] }), ctx({ deviceZone: null })), { kind: 'hold', need: 'zone', deviceZone: null });
  });

  it('a day the trip does not pin down is HELD with the days to choose from; the choice is used', () => {
    const tue = item(0, { dayLabel: 'Tuesday' });
    assert.deepEqual(stopState(tue, ctx()), { kind: 'hold', need: 'date', why: 'weekday_many', options: ['2026-10-20', '2026-10-27'], zone: 'Asia/Ho_Chi_Minh' });
    assert.equal((stopState(tue, ctx(), { date: '2026-10-27' }) as { startsAt: string }).startsAt, '2026-10-27T21:00:00+07:00');
    // "tonight" is today IN THE STOP'S ZONE (03:00Z on the 22nd is 10:00 on the 22nd in Da Nang)
    assert.equal((stopState(item(0, { dayLabel: 'Tonight' }), ctx()) as { date: string }).date, '2026-10-22');
  });

  it('a wall time that happens twice is held for the person to pick which', () => {
    const lisbon = item(0, { timeHint: '1:30am', dayLabel: '2026-10-25', candidates: [venueCandidate('Europe/Lisbon')] });
    assert.deepEqual(stopState(lisbon, ctx()), {
      kind: 'hold', need: 'occurrence', earlier: '2026-10-25T01:30:00+01:00', later: '2026-10-25T01:30:00+00:00', date: '2026-10-25', zone: 'Europe/Lisbon',
    });
    assert.equal((stopState(lisbon, ctx(), { occurrence: 'later' }) as { startsAt: string }).startsAt, '2026-10-25T01:30:00+00:00');
  });

  it('BLOCKED, with the reason, when it cannot be added here at all', () => {
    const why = (it: PasteReviewItem, c = ctx()) => { const st = stopState(it, c); return st.kind === 'blocked' ? st.why : st.kind; };
    assert.equal(why(item(0, { timeHint: null })), 'no_time');
    assert.equal(why(item(0, { timeHint: '25:00' })), 'unreadable_time');
    assert.equal(why(item(0, { timeHint: '1:30am', dayLabel: '2026-03-29', candidates: [venueCandidate('Europe/Lisbon')] })), 'skipped_time');
    assert.equal(why(item(0, { status: 'failed', reason: 'We couldn’t check this one — the place lookup failed.', candidates: [] })), 'server');
    assert.equal(why(item(0, { candidates: [{ ...venueCandidate(), locationPrecision: 'hidden' }] })), 'no_place');
    assert.equal(why(item(0, { dayLabel: 'Friday' }), ctx({ trip: { start: null, end: null } })), 'no_days');
    const unreadable = stopState(item(0), ctx({ trip: null, tripUnreadable: true }));
    assert.equal(unreadable.kind === 'blocked' && blockWords(unreadable), 'Which day? This trip’s dates couldn’t be read.');
    const none = stopState(item(0), ctx({ trip: { start: null, end: null } }));
    assert.equal(none.kind === 'blocked' && blockWords(none), 'Which day? This trip has no dates to choose from.');
  });
});

describe('the proposal: every line that came back, in paste order; only complete READY ones pre-ticked', () => {
  it('ready + complete is ticked; a partial answer, a held and a blocked line are not', () => {
    const stops = proposeStops([
      item(0),
      item(2, { partial: true }),
      item(3, { timeHint: '7' }),
      item(5, { timeHint: null }),
    ], ctx());
    assert.deepEqual(stops.map((s) => [s.index, s.title, s.subtitle, s.state.kind]), [
      [0, 'Sky36', 'Da Nang', 'ready'], [2, 'Sky36', 'Da Nang', 'ready'], [3, 'Sky36', 'Da Nang', 'hold'], [5, 'Sky36', 'Da Nang', 'blocked'],
    ]);
    assert.deepEqual(initiallyTicked(stops), { 0: true });
    assert.deepEqual([stops[0]!.pastedDay, stops[0]!.pastedTime], ['Friday', '9pm']);
  });
});

describe('a READY stop is the composer\'s ADD_COMMITMENT with its starts_at — the one payload format', () => {
  it('commitmentInputFor → commitmentCommand: starts_at is the stop\'s instant; no type chosen → nothing', () => {
    const [stop] = proposeStops([item(0)], ctx());
    assert.equal(commitmentInputFor(stop!, { type: null, flexibility: 'flexible', stageId: null }), null);
    const input = commitmentInputFor(stop!, { type: 'event', flexibility: 'fixed', stageId: null })!;
    assert.deepEqual(commitmentCommand(input), {
      ok: true, type: 'ADD_COMMITMENT', payload: { type: 'event', flexibility: 'fixed', starts_at: '2026-10-23T21:00:00+07:00' },
    });
    const [held] = proposeStops([item(0, { timeHint: '7' })], ctx());
    assert.equal(commitmentInputFor(held!, { type: 'event', flexibility: 'fixed', stageId: null }), null);
  });

  it('the builder\'s additive change: an instant must carry its offset; omitted means no starts_at (the composer\'s payload is unchanged)', () => {
    assert.deepEqual(commitmentCommand({ type: 'lodging', flexibility: 'flexible', stageId: null }),
      { ok: true, type: 'ADD_COMMITMENT', payload: { type: 'lodging', flexibility: 'flexible' } });
    assert.deepEqual(commitmentCommand({ type: 'event', flexibility: 'fixed', stageId: null, startsAt: '2026-10-23T19:00:00' }), { ok: false, reason: 'LOCAL_INVALID' });
    assert.deepEqual(commitmentCommand({ type: 'event', flexibility: 'fixed', stageId: null, startsAt: 'Friday 7' }), { ok: false, reason: 'LOCAL_INVALID' });
    assert.equal(isInstant('2026-10-23T19:00:00+07:00'), true);
    assert.equal(isInstant('2026-10-23T12:00:00Z'), true);
    assert.equal(isInstant('2026-13-23T19:00:00+07:00'), false);
    assert.equal(isInstant('2026-10-23 19:00'), false);
  });
});

describe('through the real entry point: addCommitment issues exactly the built command', () => {
  type Mod = typeof import('../tripStructureEntries.ts');
  let mod: Mod;
  let issued: Array<{ tripId: string; cmd: TripCommandRequest }> = [];
  const ok = (): TripCommandResult => ({ ok: true, duplicate: false, version: 3, eventId: 'e1', sequence: 3, result: { id: 'c1' }, contractVersion: 2 });
  before(async () => {
    mod = await import('../tripStructureEntries.ts');
    mod._setTestIssuer(async (tripId, cmd) => { issued.push({ tripId, cmd }); return ok(); });
  });
  after(() => mod._setTestIssuer(null));
  beforeEach(() => { issued = []; });

  it('one ADD_COMMITMENT with starts_at, the caller\'s key, nothing else', async () => {
    const [stop] = proposeStops([item(0)], ctx());
    const r = await mod.addCommitment('t1', commitmentInputFor(stop!, { type: 'booking', flexibility: 'shiftable', stageId: CITY })!, 'k-1');
    assert.deepEqual(r, { state: 'recorded', duplicate: false, id: 'c1' });
    assert.deepEqual(issued, [{ tripId: 't1', cmd: { type: 'ADD_COMMITMENT', payload: { type: 'booking', flexibility: 'shiftable', stage_id: CITY, starts_at: '2026-10-23T21:00:00+07:00' }, idempotencyKey: 'k-1' } }]);
  });
});
