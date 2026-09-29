/**
 * GII-F08 end to end on the client: paste into the Trip's destination editor,
 * review, confirm — through the REAL editor, the REAL review screen, the REAL
 * extract client and the REAL `tripDestinations.addDestination`. Only `fetch`
 * is faked (plus the Supabase-backed token helper and the two native pickers the
 * editor mounts, exactly as DestinationListEditor.component.test.tsx does).
 *
 * §24: "Bulk extraction must always lead to a review screen before persistent
 * mutation." Asserted as: no POST to /destinations happens until the confirm
 * button is pressed, and then only for what is ticked.
 *
 * Failure honesty: a failed extract is an error with Retry (never an empty
 * review); an unreadable answer is an error; per item, failed / no match /
 * unsupported each say which; a destination that fails to save stays on the
 * review screen with Retry while the others land.
 *
 * Run with: pnpm test:component
 */
import React, { useState } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { DestinationListEditor, type DestinationEntry } from '../../../../components/trip/DestinationListEditor.tsx';

// NOTE: exhaustive — the real token helper reaches the Supabase client.
jest.mock('../../../../services/apiToken.ts', () => ({ freshToken: async () => 'tok' }));

// NOTE: intentionally exhaustive — react-native-safe-area-context has native internals.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// NOTE: intentionally exhaustive — the pickers pull expo-location / calendar native internals.
jest.mock('../../../../components/selectors/GlobalPlacePicker', () => ({ GlobalPlacePicker: () => null }));
// NOTE: intentionally exhaustive — see above.
jest.mock('../../../../components/selectors/GlobalCalendarPicker', () => ({ GlobalCalendarPicker: () => null }));

const TRIP = '11111111-1111-4111-8111-111111111111';
const ORIGIN = 'https://portava.test';

const city = (id: string, name: string, country: string) => ({
  id, label: name, subtitle: country, type: 'entity', context: 'trip_destination', entityType: 'city', entityId: id,
  structuredValue: { entityType: 'city', cityId: id, city: name, country, lat: 16, lng: 108 }, source: 'canonical', policyVersion: 'v',
});
const item = (index: number, query: string, status: string, over: Record<string, unknown> = {}) => ({
  index, raw: query, source: 'text', provider: null, query, lat: null, lng: null, timeHint: null, dayLabel: null,
  unsupported: null, status, reason: null, partial: false, candidates: [], ...over,
});
const EXTRACTION = {
  requestId: 'req-1', policyVersion: 'v', context: 'trip_destination', fieldId: 'trip.destination',
  shape: 'itinerary', truncated: false, mutated: false,
  items: [
    item(0, 'Da Nang', 'resolved', { dayLabel: 'Friday', candidates: [city('c-dn', 'Đà Nẵng', 'Vietnam')] }),
    item(1, 'Hoi An', 'resolved', { candidates: [city('c-ha', 'Hoi An', 'Vietnam')] }),
    item(2, 'Hue', 'resolved', { partial: true, candidates: [city('c-hue', 'Hue', 'Vietnam')] }),
    item(3, 'Atlantis', 'no_match', { reason: 'No place matched “Atlantis”.' }),
    item(4, 'Bana Hills', 'failed', { reason: 'We couldn’t check this one — the place lookup didn’t answer.' }),
    item(5, 'https://maps.app.goo.gl/x', 'unsupported', { reason: 'Shortened map links can’t be read.' }),
  ],
};

type Route = (init: RequestInit) => { status: number; body: unknown };
let routes: Record<string, Route>;
let calls: Array<{ url: string; method: string; body: any }>;

beforeEach(() => {
  process.env.EXPO_PUBLIC_API_BASE_URL = ORIGIN;
  calls = [];
  routes = {
    [`POST ${ORIGIN}/api/input-assistance/extract`]: () => ({ status: 200, body: EXTRACTION }),
    [`POST ${ORIGIN}/api/trips/${TRIP}/destinations`]: (init) => {
      const b = JSON.parse(String(init.body));
      return { status: 201, body: { id: `srv-${b.city}`, ...b } };
    },
  };
  (global as any).fetch = jest.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    calls.push({ url: String(url), method, body: init.body ? JSON.parse(String(init.body)) : null });
    const route = routes[`${method} ${url}`];
    if (!route) return new Response('not found', { status: 404 });
    const { status, body } = route(init);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  });
});

function Wrapper({ tripId }: { tripId?: string }) {
  const [dests, setDests] = useState<DestinationEntry[]>([]);
  return <DestinationListEditor tripId={tripId} destinations={dests} onChange={setDests} />;
}

const destinationPosts = () => calls.filter((c) => c.method === 'POST' && c.url.endsWith('/destinations'));

async function pasteAndExtract(text = 'Friday:\nDa Nang\nHoi An\nHue\nAtlantis\nBana Hills\nhttps://maps.app.goo.gl/x') {
  await fireEvent.press(screen.getByTestId('paste-destinations'));
  await fireEvent.changeText(screen.getByTestId('paste-input'), text);
  await fireEvent.press(screen.getByTestId('paste-extract'));
}

test('paste → review → confirm: nothing is written until confirm, then only what is ticked', async () => {
  await render(<Wrapper tripId={TRIP} />);
  await pasteAndExtract();
  await waitFor(() => expect(screen.getByTestId('paste-summary')).toBeTruthy());

  // The extract request went through the real client, to the real path, with the paste.
  const extract = calls.find((c) => c.url.endsWith('/api/input-assistance/extract'))!;
  expect(extract.body).toMatchObject({ context: 'trip_destination', fieldId: 'trip.destination' });
  expect(extract.body.text).toContain('Hoi An');

  // Every status says which one it is.
  expect(screen.getByTestId('paste-item-status-3').props.children).toMatch(/No place matched/);
  expect(screen.getByTestId('paste-item-status-4').props.children).toMatch(/couldn’t check/);
  expect(screen.getByTestId('paste-item-status-5').props.children).toMatch(/can’t be read/);
  expect(screen.getByTestId('paste-item-status-2').props.children).toMatch(/couldn’t be checked/);

  // Complete answers are pre-ticked; the partial one is not.
  expect(screen.getByTestId('paste-candidate-0-0').props.accessibilityState).toMatchObject({ checked: true });
  expect(screen.getByTestId('paste-candidate-1-0').props.accessibilityState).toMatchObject({ checked: true });
  expect(screen.getByTestId('paste-candidate-2-0').props.accessibilityState).toMatchObject({ checked: false });

  // G162: the review screen is up and NOTHING has been persisted.
  expect(destinationPosts()).toHaveLength(0);

  await fireEvent.press(screen.getByTestId('paste-candidate-2-0')); // the person confirms Hue themselves
  await fireEvent.press(screen.getByTestId('paste-confirm'));
  await waitFor(() => expect(screen.queryByTestId('paste-review-sheet')).toBeNull());

  expect(destinationPosts().map((c) => c.body.city)).toEqual(['Đà Nẵng', 'Hoi An', 'Hue']);
  expect(destinationPosts().map((c) => c.body.position)).toEqual([1, 2, 3]);
  expect(screen.getAllByTestId(/^remove-dest-/)).toHaveLength(3);
});

test('a failed extract is an ERROR with retry — never an empty review', async () => {
  let fail = true;
  routes[`POST ${ORIGIN}/api/input-assistance/extract`] = () =>
    fail ? { status: 503, body: { error: 'degraded_unavailable', message: 'We could not read that paste. Please try again.' } } : { status: 200, body: EXTRACTION };
  await render(<Wrapper tripId={TRIP} />);
  await pasteAndExtract('Da Nang\nHoi An');
  await waitFor(() => expect(screen.getByTestId('paste-error')).toBeTruthy());
  expect(screen.queryByTestId('paste-summary')).toBeNull();
  fail = false;
  await fireEvent.press(screen.getByTestId('paste-retry'));
  await waitFor(() => expect(screen.getByTestId('paste-summary')).toBeTruthy());
  expect(destinationPosts()).toHaveLength(0);
});

test('an answer that is not the review contract is an error, not "nothing found"', async () => {
  routes[`POST ${ORIGIN}/api/input-assistance/extract`] = () => ({ status: 200, body: { ...EXTRACTION, mutated: undefined } });
  await render(<Wrapper tripId={TRIP} />);
  await pasteAndExtract('Da Nang');
  await waitFor(() => expect(screen.getByTestId('paste-error')).toBeTruthy());
  expect(screen.queryByTestId('paste-summary')).toBeNull();
});

test('a destination that fails to save stays on the review screen with Retry; the others land', async () => {
  let hoiAnFails = true;
  routes[`POST ${ORIGIN}/api/trips/${TRIP}/destinations`] = (init) => {
    const b = JSON.parse(String(init.body));
    if (b.city === 'Hoi An' && hoiAnFails) return { status: 500, body: { error: 'db_error' } };
    return { status: 201, body: { id: `srv-${b.city}`, ...b } };
  };
  await render(<Wrapper tripId={TRIP} />);
  await pasteAndExtract();
  await waitFor(() => expect(screen.getByTestId('paste-summary')).toBeTruthy());
  await fireEvent.press(screen.getByTestId('paste-confirm'));
  await waitFor(() => expect(screen.getByTestId('paste-apply-error')).toBeTruthy());
  expect(screen.getByTestId('paste-candidate-1-0').props.accessibilityState).toMatchObject({ checked: true });
  expect(screen.getByTestId('paste-candidate-0-0').props.accessibilityState).toMatchObject({ checked: false });
  expect(screen.getAllByTestId(/^remove-dest-/)).toHaveLength(1);

  hoiAnFails = false;
  await fireEvent.press(screen.getByTestId('paste-confirm'));
  await waitFor(() => expect(screen.queryByTestId('paste-review-sheet')).toBeNull());
  expect(destinationPosts().map((c) => c.body.city)).toEqual(['Đà Nẵng', 'Hoi An', 'Hoi An']);
  expect(screen.getAllByTestId(/^remove-dest-/)).toHaveLength(2);
});

test('creating a Trip: confirmed stops join the draft and nothing is sent', async () => {
  await render(<Wrapper />);
  await pasteAndExtract();
  await waitFor(() => expect(screen.getByTestId('paste-summary')).toBeTruthy());
  await fireEvent.press(screen.getByTestId('paste-confirm'));
  await waitFor(() => expect(screen.queryByTestId('paste-review-sheet')).toBeNull());
  expect(destinationPosts()).toHaveLength(0);
  expect(screen.getAllByTestId(/^remove-dest-/)).toHaveLength(2);
});
