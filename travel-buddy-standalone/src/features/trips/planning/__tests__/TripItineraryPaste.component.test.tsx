/**
 * census G160 — §24's "Create 3 Trip stops from this text [Review]", end to end
 * on the client, through the REAL trip structure composer (which mounts it),
 * the REAL extract client and answer parser, the REAL proposal and time reader,
 * and the REAL `addCommitment` → `commitmentCommand`. Faked: `fetch` (the
 * extract route), the token helper, the trip read, and the kernel issuer below
 * `addCommitment` (`_setTestIssuer`, the seam the composer's own suites use).
 *
 *   C1  the composer mounts it — behind the policy gate; gate off → nothing shown
 *   C2  the proposal is shown, and NOTHING is written until the confirm tap
 *   C3  confirm issues exactly N commands, with the right payloads and keys
 *   C4  partial failure is stated ("1 of 3 added"); a retry re-sends the SAME command
 *   C5  an ambiguous time / zone / day is held back for the person, never guessed
 *   C6  a failed read is an error with retry, never an empty review; nothing matched is said
 *
 * RNTL v14: always await render() and fireEvent.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react-native';

import { TripStructureComposer } from '../TripStructureComposer.tsx';
import { _setTestIssuer } from '../tripStructureEntries.ts';
import type { StructureRead, TripStructure } from '../tripDecisions.ts';
import type { TripCommandRequest, TripCommandResult } from '../../../../services/tripCommands.ts';
import { _seedPolicyForTests, sharedPolicyStore } from '../../../../platform/input-assistance/services/policyStore.ts';

// NOTE: exhaustive — the real token helper reaches the Supabase client.
jest.mock('../../../../services/apiToken.ts', () => ({ freshToken: async () => 'tok' }));
// NOTE: exhaustive — the trip read reaches the Supabase client; only its dates are used here.
jest.mock('../../../../services/trips.ts', () => ({ getTrip: jest.fn() }));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const tripsMock = require('../../../../services/trips.ts') as { getTrip: jest.Mock };

const TRIP = '11111111-1111-4111-8111-111111111111';
const STAGE = '22222222-2222-4222-8222-222222222222';
const CITY = '33333333-3333-4333-8333-333333333333';
const ORIGIN = 'https://portava.test';

let venueN = 0;
function venue(label: string, timezone: string | null = 'Asia/Ho_Chi_Minh') {
  const id = `4444444${venueN++}-4444-4444-8444-444444444444`;
  return {
    id: `trip_stop_place:places:${id}`, type: 'entity', context: 'trip_stop_place', label, subtitle: 'Da Nang',
    entityType: 'place', entityId: id, source: 'canonical', policyVersion: 'v',
    action: { type: 'open_entity', entityType: 'place', entityId: id },
    structuredValue: { entityType: 'venue', venueId: id, venue: label, cityId: CITY, city: 'Da Nang', country: 'Vietnam', countryCode: 'VN', lat: 16.07, lng: 108.22, timezone },
  };
}
function item(index: number, query: string, timeHint: string | null, dayLabel: string | null, candidates: unknown[], over: Record<string, unknown> = {}) {
  return { index, raw: `${query} at ${timeHint}`, source: 'text', provider: null, query, lat: null, lng: null, timeHint, dayLabel, unsupported: null, status: 'resolved', reason: null, partial: false, candidates, ...over };
}
const extraction = (items: unknown[]) => ({
  requestId: 'req-1', policyVersion: 'v', context: 'trip_stop_place', fieldId: 'trip.stop.place', shape: 'itinerary', truncated: false, mutated: false, items,
});
/** §24's own example, with places that match: Friday — dinner at 7pm, a rooftop at 9pm, a club at 11pm. */
const THREE = extraction([
  item(0, 'Madame Lan', '7pm', 'Friday', [venue('Madame Lan')]),
  item(1, 'Sky36', '9pm', 'Friday', [venue('Sky36')]),
  item(2, 'Club Ozone', '11pm', 'Friday', [venue('Club Ozone')]),
]);

let extractAnswer: () => { status: number; body: unknown };
let fetchCalls: Array<{ url: string; method: string; body: unknown }>;
let issued: Array<{ tripId: string; cmd: TripCommandRequest }>;
let answers: Array<() => TripCommandResult>;
const ok = (): TripCommandResult => ({ ok: true, duplicate: false, version: 4, eventId: 'e', sequence: 4, result: { id: 'c' }, contractVersion: 2 });
const unreachable = (): TripCommandResult => ({ ok: false, kind: 'unavailable', detail: 'network error' });
const notCrew = (): TripCommandResult => ({ ok: false, kind: 'refused', status: 403, reason: 'TRIP_AUTH_NOT_CREW', detail: null, currentVersion: null, expectedVersion: null });

function structureOf(stages: TripStructure['stages']): StructureRead {
  return { state: 'ok', structure: { tripId: TRIP, stages, legs: [], commitments: [], planAttendance: [], outcomes: [], orphanedLegs: [], orphanedCommitments: [], orphanedAttendance: [] } };
}
const ONE_STAGE = structureOf([{ id: STAGE, stageType: 'city', placeId: null, cityId: CITY, timezone: 'Asia/Ho_Chi_Minh', startsAt: null, endsAt: null, state: 'planned', sequence: 1, legsFrom: [], legsTo: [], commitmentIds: [] }]);

beforeEach(() => {
  process.env.EXPO_PUBLIC_API_BASE_URL = ORIGIN;
  _seedPolicyForTests(['trip_stop_place']);
  fetchCalls = []; issued = []; answers = []; venueN = 0;
  extractAnswer = () => ({ status: 200, body: THREE });
  tripsMock.getTrip.mockReset();
  tripsMock.getTrip.mockResolvedValue({ startDate: '2026-10-20', endDate: '2026-10-27' }); // Tue → Tue: one Friday, two Tuesdays
  (global as unknown as { fetch: unknown }).fetch = jest.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    fetchCalls.push({ url: String(url), method, body: init.body ? JSON.parse(String(init.body)) : null });
    if (method === 'POST' && url === `${ORIGIN}/api/input-assistance/extract`) {
      const { status, body } = extractAnswer();
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }
    return new Response('not found', { status: 404 });
  });
  _setTestIssuer(async (tripId, cmd) => { issued.push({ tripId, cmd }); return (answers.shift() ?? ok)(); });
});
afterEach(() => {
  cleanup();
  _setTestIssuer(null);
  sharedPolicyStore.setActiveAccount(null);
});

async function openAndRead(text: string, onAdded = jest.fn()) {
  await render(<TripStructureComposer tripId={TRIP} loadStructure={jest.fn().mockResolvedValue(ONE_STAGE)} deviceTimezone={() => 'Europe/Berlin'} onAdded={onAdded} />);
  await fireEvent.press(screen.getByTestId('itinerary-paste-open'));
  await fireEvent.changeText(screen.getByTestId('itinerary-paste-input'), text);
  await fireEvent.press(screen.getByTestId('itinerary-paste-read'));
  await waitFor(() => screen.getByTestId('itinerary-unmatched-note'));
  return onAdded;
}
const when = (i: number) => screen.getByTestId(`itinerary-stop-when-${i}`).props.children.join('');
const confirmLabel = () => screen.getByTestId('itinerary-paste-confirm');

it('C1 the trip screen\'s composer mounts it behind the policy gate: gate off → nothing shown, nothing read', async () => {
  const { unmount } = await render(<TripStructureComposer tripId={TRIP} loadStructure={jest.fn().mockResolvedValue(ONE_STAGE)} />);
  expect(screen.getByTestId('itinerary-paste-open')).toBeTruthy();
  expect(screen.getByLabelText('Paste an itinerary with times')).toBeTruthy();
  await unmount();

  // The authority has not answered (signed out / never fetched): every context is no_assistance.
  sharedPolicyStore.setActiveAccount(null);
  const second = await render(<TripStructureComposer tripId={TRIP} loadStructure={jest.fn().mockResolvedValue(ONE_STAGE)} />);
  expect(screen.queryByTestId('itinerary-paste')).toBeNull();
  await second.unmount();

  // The authority says this field may not be assisted.
  _seedPolicyForTests(['trip_stop_place'], { trip_stop_place: { mode: 'no_assistance' } });
  await render(<TripStructureComposer tripId={TRIP} loadStructure={jest.fn().mockResolvedValue(ONE_STAGE)} />);
  expect(screen.queryByTestId('itinerary-paste')).toBeNull();
  expect(screen.getByTestId('trip-structure-composer')).toBeTruthy(); // the composer itself is unaffected
  expect(fetchCalls).toEqual([]);
  expect(issued).toEqual([]);
});

it('C2 the proposal is shown with the instant each line was read as — and NOTHING is written until the confirm tap', async () => {
  await openAndRead('Friday:\nDinner at Madame Lan at 7pm\nSky36 at 9pm\nClub Ozone at 11pm');
  // the paste went to the §24 extract route under the trip-stop field, and nowhere else
  expect(fetchCalls.map((c) => `${c.method} ${c.url}`)).toEqual([`POST ${ORIGIN}/api/input-assistance/extract`]);
  expect(fetchCalls[0]!.body).toEqual({ context: 'trip_stop_place', fieldId: 'trip.stop.place', text: 'Friday:\nDinner at Madame Lan at 7pm\nSky36 at 9pm\nClub Ozone at 11pm' });
  expect(tripsMock.getTrip).toHaveBeenCalledWith(TRIP);

  expect(when(0)).toBe('Fri 23 Oct · 19:00 · Asia/Ho_Chi_Minh');
  expect(when(1)).toBe('Fri 23 Oct · 21:00 · Asia/Ho_Chi_Minh');
  expect(when(2)).toBe('Fri 23 Oct · 23:00 · Asia/Ho_Chi_Minh');
  expect(screen.getByTestId('itinerary-stop-pasted-0').props.children).toBe('Friday · 7pm');
  for (const i of [0, 1, 2]) expect(screen.getByTestId(`itinerary-stop-tick-${i}`).props.accessibilityState.checked).toBe(true);
  expect(screen.getByTestId('itinerary-what-is-saved')).toBeTruthy();

  // no type chosen → the confirm is disabled and says why
  expect(confirmLabel().props.accessibilityState.disabled).toBe(true);
  expect(screen.getByText('Choose what these are')).toBeTruthy();
  await fireEvent.press(confirmLabel());
  await fireEvent.press(screen.getByTestId('itinerary-type-event'));
  await fireEvent.press(screen.getByTestId('itinerary-stop-tick-1')); // untick, retick
  await fireEvent.press(screen.getByTestId('itinerary-stop-tick-1'));
  expect(screen.getByText('Add 3 stops')).toBeTruthy();
  expect(issued).toEqual([]);

  await fireEvent.press(screen.getByTestId('itinerary-paste-close'));
  expect(screen.queryByTestId('itinerary-paste-sheet')).toBeNull();
  expect(issued).toEqual([]);
});

it('C3 confirm issues EXACTLY one ADD_COMMITMENT per ticked stop, through the composer\'s builder, with starts_at and a fresh key each', async () => {
  const onAdded = await openAndRead('Friday: Madame Lan at 7pm; Sky36 at 9pm; Club Ozone at 11pm');
  await fireEvent.press(screen.getByTestId('itinerary-stop-tick-2')); // the person drops the club
  await fireEvent.press(screen.getByTestId('itinerary-type-booking'));
  await fireEvent.press(screen.getByTestId('itinerary-flex-fixed'));
  await fireEvent.press(screen.getByTestId(`itinerary-stage-${STAGE}`));
  await fireEvent.press(confirmLabel());
  await waitFor(() => screen.getByTestId('itinerary-outcome'));

  expect(issued.map((i) => [i.tripId, i.cmd.type, i.cmd.payload])).toEqual([
    [TRIP, 'ADD_COMMITMENT', { type: 'booking', flexibility: 'fixed', stage_id: STAGE, starts_at: '2026-10-23T19:00:00+07:00' }],
    [TRIP, 'ADD_COMMITMENT', { type: 'booking', flexibility: 'fixed', stage_id: STAGE, starts_at: '2026-10-23T21:00:00+07:00' }],
  ]);
  const keys = issued.map((i) => i.cmd.idempotencyKey);
  for (const k of keys) expect(k).toMatch(/^structure-entry:commitment:/);
  expect(new Set(keys).size).toBe(2);
  expect(screen.getByTestId('itinerary-outcome').props.children.join('')).toBe('2 of 2 added.');
  expect(screen.getByTestId('itinerary-stop-added-0')).toBeTruthy();
  expect(screen.getByTestId('itinerary-stop-added-1')).toBeTruthy();
  expect(screen.queryByTestId('itinerary-stop-added-2')).toBeNull();
  expect(onAdded).toHaveBeenCalledTimes(1);
  expect(onAdded).toHaveBeenCalledWith('commitment'); // the trip screen re-reads its stage spine on this

  // an added stop cannot be sent again from this review
  expect(screen.getByTestId('itinerary-stop-tick-0').props.accessibilityState.disabled).toBe(true);
  expect(screen.getByText('Nothing left to add')).toBeTruthy();
});

it('C4 partial failure is STATED, per stop; a retry re-sends the SAME command for the unreachable one only', async () => {
  answers = [ok, unreachable, notCrew];
  const onAdded = await openAndRead('Friday:\nMadame Lan at 7pm\nSky36 at 9pm\nClub Ozone at 11pm');
  await fireEvent.press(screen.getByTestId('itinerary-type-event'));
  await fireEvent.press(confirmLabel());
  await waitFor(() => screen.getByTestId('itinerary-outcome'));

  expect(issued).toHaveLength(3);
  expect(screen.getByTestId('itinerary-outcome').props.children.join('')).toBe('1 of 3 added. 2 not added — see below.');
  expect(screen.getByTestId('itinerary-stop-added-0')).toBeTruthy();
  expect(screen.getByTestId('itinerary-stop-unavailable-1')).toBeTruthy();
  expect(screen.getByTestId('itinerary-stop-refused-2').props.children.join('')).toBe('Not added — only the trip crew can add to this trip');
  expect(onAdded).toHaveBeenCalledTimes(1);

  // only the unreachable one is retried; the type can no longer change under it
  expect(screen.getByText('Try again (1)')).toBeTruthy();
  expect(screen.getByTestId('itinerary-type-meeting').props.accessibilityState.disabled).toBe(true);
  const first = issued[1]!.cmd;
  await fireEvent.press(confirmLabel());
  await waitFor(() => expect(screen.getByTestId('itinerary-outcome').props.children.join('')).toBe('2 of 3 added. 1 not added — see below.'));
  expect(issued).toHaveLength(4);
  expect(issued[3]!.cmd).toEqual(first); // same key, same payload — it can never land twice
  expect(screen.getByTestId('itinerary-stop-added-1')).toBeTruthy();
  expect(screen.getByText('Nothing left to add')).toBeTruthy();
  expect(onAdded).toHaveBeenCalledTimes(2);
});

it('C5 an ambiguous time, an unknown zone and an unpinned day are HELD for the person — never guessed, never sent until fixed', async () => {
  extractAnswer = () => ({ status: 200, body: extraction([
    item(0, 'Madame Lan', '7', 'Friday', [venue('Madame Lan')]),          // "Dinner at 7": morning or evening?
    item(1, 'Sky36', '9pm', 'Friday', [venue('Sky36', null)]),            // no zone for the place, none for the trip
    item(2, 'Club Ozone', '11pm', 'Tuesday', [venue('Club Ozone')]),       // two Tuesdays in this trip
    item(3, 'My Khe Beach', null, 'Friday', [venue('My Khe Beach')]),     // no time at all
    item(5, 'Marble Mountains', '9am', 'Friday', [venue('Marble Mountains')]), // ready
  ]) });
  await openAndRead('anything');
  expect(screen.getByText('Is “7” in the morning or the evening?')).toBeTruthy();
  expect(screen.getByTestId('itinerary-fix-am-0').props.accessibilityLabel).toBe('7:00 am');
  expect(screen.getByText('No time zone is known for this place or this trip.')).toBeTruthy();
  expect(screen.getByLabelText("Use this phone's time zone, Europe/Berlin")).toBeTruthy();
  expect(screen.getByText('This trip has more than one Tuesday. Which one?')).toBeTruthy();
  expect(screen.getByTestId('itinerary-stop-blocked-3').props.children).toBe('No time in this line. This adds timed stops only.');
  for (const i of [0, 1, 2, 3]) expect(screen.queryByTestId(`itinerary-stop-tick-${i}`)).toBeNull();

  // with nothing fixed, only the ready stop is sent
  await fireEvent.press(screen.getByTestId('itinerary-type-event'));
  expect(screen.getByText('Add 1 stop')).toBeTruthy();
  await fireEvent.press(confirmLabel());
  await waitFor(() => screen.getByTestId('itinerary-stop-added-5'));
  expect(issued.map((i) => i.cmd.payload?.starts_at)).toEqual(['2026-10-23T09:00:00+07:00']);

  // the person fixes each one; each fix ticks the stop it completes
  await fireEvent.press(screen.getByTestId('itinerary-fix-pm-0'));
  expect(when(0)).toBe('Fri 23 Oct · 19:00 · Asia/Ho_Chi_Minh');
  await fireEvent.press(screen.getByTestId('itinerary-fix-zone-1'));
  expect(when(1)).toBe("Fri 23 Oct · 21:00 · Europe/Berlin (this phone's)");
  await fireEvent.press(screen.getByTestId('itinerary-fix-date-2-2026-10-27'));
  expect(when(2)).toBe('Tue 27 Oct · 23:00 · Asia/Ho_Chi_Minh');
  expect(screen.getByText('Add 3 stops')).toBeTruthy();
  await fireEvent.press(confirmLabel());
  await waitFor(() => screen.getByTestId('itinerary-stop-added-2'));
  expect(issued.slice(1).map((i) => i.cmd.payload?.starts_at)).toEqual([
    '2026-10-23T19:00:00+07:00', '2026-10-23T21:00:00+02:00', '2026-10-27T23:00:00+07:00',
  ]);
  expect(screen.getByTestId('itinerary-outcome').props.children.join('')).toBe('4 of 4 added.');
});

it('C6 a failed read is an error with retry — never an empty review; a paste that matched nothing says so and adds nothing', async () => {
  extractAnswer = () => ({ status: 503, body: { error: 'degraded_unavailable', message: 'We could not read that paste. Please try again.' } });
  await render(<TripStructureComposer tripId={TRIP} loadStructure={jest.fn().mockResolvedValue(ONE_STAGE)} />);
  await fireEvent.press(screen.getByTestId('itinerary-paste-open'));
  await fireEvent.changeText(screen.getByTestId('itinerary-paste-input'), 'Friday: Sky36 at 9pm');
  await fireEvent.press(screen.getByTestId('itinerary-paste-read'));
  await waitFor(() => screen.getByTestId('itinerary-paste-error'));
  expect(screen.getByText('We could not read that paste. Please try again.')).toBeTruthy();
  expect(screen.getByText('Try again')).toBeTruthy();
  expect(screen.queryByTestId('itinerary-unmatched-note')).toBeNull();

  extractAnswer = () => ({ status: 200, body: extraction([]) });
  await fireEvent.press(screen.getByTestId('itinerary-paste-read'));
  await waitFor(() => screen.getByTestId('itinerary-empty'));
  expect(confirmLabel().props.accessibilityState.disabled).toBe(true);
  expect(issued).toEqual([]);
});

it('C6b the trip read failing is said as such: a stop that needs a day is not given one', async () => {
  tripsMock.getTrip.mockRejectedValue(new Error('This trip could not be read'));
  await openAndRead('Friday: Sky36 at 9pm');
  expect(screen.getByTestId('itinerary-stop-blocked-0').props.children).toBe('Which day? This trip’s dates couldn’t be read.');
  expect(screen.queryByTestId('itinerary-batch')).toBeNull();
  expect(issued).toEqual([]);
});
