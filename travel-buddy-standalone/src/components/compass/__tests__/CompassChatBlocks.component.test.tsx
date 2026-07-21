/**
 * CompassChatBlocks — Phase 5 dynamic UI rendering component tests.
 *
 * Run with: pnpm test:component
 *
 * ## What's covered
 *
 * 1. Block → component mapping: place_cards, event_cards, person_cards, map,
 *    comparison, and the itinerary payload each render their interface.
 * 2. No dead-end navigation: a press on each card type calls router.push with
 *    a real destination (map focus for places with coords, /event/[id] for
 *    events, /u/[handle] for people, /search fallback for coordinate-less
 *    places).
 * 3. Place "Plan" button routes through the caller's PlanPicker callback with
 *    the real place — never a direct write.
 * 4. Fallback: no blocks + no itinerary renders nothing (plain text reply).
 *
 * ## Renderer budget (TESTING.md)
 *
 * Presses are kept to one commit per render; each press test uses its own
 * render() to stay inside the React 19 renderer budget.
 */

import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react-native';
import { CompassChatBlocks } from '../CompassChatBlocks.tsx';
import type { CompassUiBlock, CompassAskPayload } from '../../../services/compass.ts';

jest.mock('expo-router', () => {
  const push = jest.fn();
  return {
    ...jest.requireActual('expo-router'),
    __push: push,
    useRouter: () => ({ push, back: jest.fn(), replace: jest.fn() }),
  };
});
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pushMock = (require('expo-router') as any).__push as jest.Mock;

afterEach(() => {
  cleanup();
  pushMock.mockClear();
});

// ── Fixtures (shapes mirror server-hydrated real tool data) ───────────────────

const PLACE = {
  id: 'place-1', name: 'Cafe Uno', category: 'food', city: 'Cebu',
  neighborhood: 'IT Park', rating: 4.5, blurb: 'Great beans', verified: true,
  lat: 10.3, lng: 123.9,
};
const PLACE_NO_COORDS = { ...PLACE, id: 'place-2', name: 'Bar Dos', lat: null, lng: null };
const EVENT = {
  id: 'event-1', title: 'Beach Meetup', city: 'Cebu', country: 'PH',
  startsAt: '2026-08-01T10:00:00Z', category: 'Hiking', description: 'Sunset walk',
};
const PERSON = { handle: 'maria_travels', circleName: 'Island Crew' };

const ITINERARY: CompassAskPayload = {
  type: 'itinerary',
  destination: 'Cebu',
  days: [{ label: 'Day 1', highlights: ['Beach', 'Lechon'] }],
};

// ── 1. Block → component mapping ──────────────────────────────────────────────

it('renders every block type plus the itinerary timeline', async () => {
  const blocks: CompassUiBlock[] = [
    { type: 'place_cards', places: [PLACE] },
    { type: 'event_cards', events: [EVENT] },
    { type: 'person_cards', people: [PERSON] },
    { type: 'map', places: [PLACE] },
    {
      type: 'comparison',
      columns: ['Distance'],
      rows: [{ kind: 'place', id: PLACE.id, label: PLACE.name, values: ['1 km'], place: PLACE }],
    },
  ];
  await render(<CompassChatBlocks blocks={blocks} payload={ITINERARY} />);

  expect(screen.getByTestId(`compass-block-place-${PLACE.id}`)).toBeTruthy();
  expect(screen.getByTestId(`compass-block-event-${EVENT.id}`)).toBeTruthy();
  expect(screen.getByTestId(`compass-block-person-${PERSON.handle}`)).toBeTruthy();
  expect(screen.getByTestId(`compass-block-map-${PLACE.id}`)).toBeTruthy();
  expect(screen.getByTestId(`compass-block-compare-${PLACE.id}`)).toBeTruthy();
  expect(screen.getByTestId('compass-block-itinerary')).toBeTruthy();
  expect(screen.getByText('Day 1')).toBeTruthy();
  expect(screen.getByText('• Beach')).toBeTruthy();
});

it('renders nothing without blocks or itinerary (plain-text fallback)', async () => {
  const { toJSON } = await render(
    <CompassChatBlocks blocks={[]} payload={{ type: 'recommendation' }} />,
  );
  expect(toJSON()).toBeNull();
});

// ── 2. No dead ends — each press lands on a real destination ─────────────────

it('place card with coordinates deep-links to the map focused on the place', async () => {
  await render(<CompassChatBlocks blocks={[{ type: 'place_cards', places: [PLACE] }]} />);
  fireEvent.press(screen.getByTestId(`compass-block-place-${PLACE.id}`));
  expect(pushMock).toHaveBeenCalledWith(expect.objectContaining({
    pathname: '/map',
    params: expect.objectContaining({ lat: '10.3', lng: '123.9', focusId: PLACE.id }),
  }));
});

it('place card without coordinates falls back to real search', async () => {
  await render(<CompassChatBlocks blocks={[{ type: 'place_cards', places: [PLACE_NO_COORDS] }]} />);
  fireEvent.press(screen.getByTestId(`compass-block-place-${PLACE_NO_COORDS.id}`));
  expect(pushMock).toHaveBeenCalledWith(expect.objectContaining({
    pathname: '/search',
    params: expect.objectContaining({ q: 'Bar Dos' }),
  }));
});

it('event card navigates to the real event screen', async () => {
  await render(<CompassChatBlocks blocks={[{ type: 'event_cards', events: [EVENT] }]} />);
  fireEvent.press(screen.getByTestId(`compass-block-event-${EVENT.id}`));
  expect(pushMock).toHaveBeenCalledWith(`/event/${EVENT.id}`);
});

it('person card navigates to the real profile screen', async () => {
  await render(<CompassChatBlocks blocks={[{ type: 'person_cards', people: [PERSON] }]} />);
  fireEvent.press(screen.getByTestId(`compass-block-person-${PERSON.handle}`));
  expect(pushMock).toHaveBeenCalledWith(`/u/${PERSON.handle}`);
});

it('comparison event row navigates to the event screen', async () => {
  await render(
    <CompassChatBlocks
      blocks={[{
        type: 'comparison',
        columns: ['Distance'],
        rows: [{ kind: 'event', id: EVENT.id, label: EVENT.title, values: ['2 km'], event: EVENT }],
      }]}
    />,
  );
  fireEvent.press(screen.getByTestId(`compass-block-compare-${EVENT.id}`));
  expect(pushMock).toHaveBeenCalledWith(`/event/${EVENT.id}`);
});

// ── 2b. Inline mini-map previews ──────────────────────────────────────────────

it('map block renders an inline mini-map preview; tapping it opens /map focused', async () => {
  await render(<CompassChatBlocks blocks={[{ type: 'map', places: [PLACE] }]} />);
  const preview = screen.getByTestId('compass-block-map-preview');
  expect(preview).toBeTruthy();
  fireEvent.press(preview);
  expect(pushMock).toHaveBeenCalledWith(expect.objectContaining({
    pathname: '/map',
    params: expect.objectContaining({ lat: '10.3', lng: '123.9', focusId: PLACE.id }),
  }));
});

it('map block with no coordinates renders no preview, only the rows', async () => {
  await render(<CompassChatBlocks blocks={[{ type: 'map', places: [PLACE_NO_COORDS] }]} />);
  expect(screen.queryByTestId('compass-block-map-preview')).toBeNull();
  expect(screen.getByTestId(`compass-block-map-${PLACE_NO_COORDS.id}`)).toBeTruthy();
});

it('comparison with two coordinate-bearing places shows a mini-map and distance delta', async () => {
  const PLACE_B = { ...PLACE, id: 'place-b', name: 'Cafe Dos', lat: 10.31, lng: 123.91 };
  await render(
    <CompassChatBlocks
      blocks={[{
        type: 'comparison',
        columns: ['Rating'],
        rows: [
          { kind: 'place', id: PLACE.id, label: PLACE.name, values: ['4.5'], place: PLACE },
          { kind: 'place', id: PLACE_B.id, label: PLACE_B.name, values: ['4.2'], place: PLACE_B },
        ],
      }]}
    />,
  );
  expect(screen.getByTestId('compass-block-compare-map')).toBeTruthy();
  const delta = screen.getByTestId('compass-block-compare-delta-0');
  expect(delta.props.children).toContain('Cafe Uno ↔ Cafe Dos');
  expect(delta.props.children).toMatch(/km|m$/);
});

it('comparison event row with hydrated coords contributes a pin and distance delta', async () => {
  const EVENT_WITH_COORDS = { ...EVENT, lat: 10.32, lng: 123.92 };
  await render(
    <CompassChatBlocks
      blocks={[{
        type: 'comparison',
        columns: ['Rating'],
        rows: [
          { kind: 'place', id: PLACE.id, label: PLACE.name, values: ['4.5'], place: PLACE },
          { kind: 'event', id: EVENT.id, label: EVENT.title, values: ['—'], event: EVENT_WITH_COORDS },
        ],
      }]}
    />,
  );
  expect(screen.getByTestId('compass-block-compare-map')).toBeTruthy();
  const delta = screen.getByTestId('compass-block-compare-delta-0');
  expect(delta.props.children).toContain('Cafe Uno ↔ Beach Meetup');
  expect(delta.props.children).toMatch(/km|m$/);
});

it('comparison with fewer than two coordinate rows renders no mini-map', async () => {
  await render(
    <CompassChatBlocks
      blocks={[{
        type: 'comparison',
        columns: ['Rating'],
        rows: [
          { kind: 'place', id: PLACE.id, label: PLACE.name, values: ['4.5'], place: PLACE },
          { kind: 'place', id: PLACE_NO_COORDS.id, label: PLACE_NO_COORDS.name, values: ['4.0'], place: PLACE_NO_COORDS },
        ],
      }]}
    />,
  );
  expect(screen.queryByTestId('compass-block-compare-map')).toBeNull();
});

// ── 3. Plan button uses the confirmation-gated PlanPicker callback ────────────

it('Plan button hands the real place to the PlanPicker callback', async () => {
  const onAdd = jest.fn();
  await render(
    <CompassChatBlocks blocks={[{ type: 'place_cards', places: [PLACE] }]} onAddPlaceToPlan={onAdd} />,
  );
  fireEvent.press(screen.getByTestId(`compass-block-place-plan-${PLACE.id}`));
  expect(onAdd).toHaveBeenCalledWith(PLACE);
  expect(pushMock).not.toHaveBeenCalled();
});
