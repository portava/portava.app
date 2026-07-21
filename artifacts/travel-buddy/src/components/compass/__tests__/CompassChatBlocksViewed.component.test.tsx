/**
 * CompassChatBlocks — "viewed" outcome reporting from the chat surface.
 *
 * Run with: pnpm test:component
 *
 * Opening a recommendation card from Compass chat must fire the same
 * fire-and-forget reportCompassViewed used by the feed / picks / trip
 * surfaces. Chat uiBlocks carry no recommendation tokens, so the report is
 * keyed by item id (recommendationId = null).
 *
 * Renderer budget (TESTING.md): one press per render.
 */

import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react-native';
import { CompassChatBlocks } from '../CompassChatBlocks.tsx';
import { reportCompassViewed } from '../../../services/compass.ts';

jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => ({ push: jest.fn(), back: jest.fn(), replace: jest.fn() }),
}));

jest.mock('../../../services/compass.ts', () => ({
  ...jest.requireActual('../../../services/compass.ts'),
  reportCompassViewed: jest.fn(),
}));
const reportMock = reportCompassViewed as jest.Mock;

afterEach(() => {
  cleanup();
  reportMock.mockClear();
});

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

it('opening a place card reports a viewed outcome keyed by item id', async () => {
  await render(<CompassChatBlocks blocks={[{ type: 'place_cards', places: [PLACE] }]} />);
  fireEvent.press(screen.getByTestId(`compass-block-place-${PLACE.id}`));
  expect(reportMock).toHaveBeenCalledWith(null, PLACE.id);
});

it('opening a coordinate-less place card (search fallback) still reports viewed', async () => {
  await render(<CompassChatBlocks blocks={[{ type: 'place_cards', places: [PLACE_NO_COORDS] }]} />);
  fireEvent.press(screen.getByTestId(`compass-block-place-${PLACE_NO_COORDS.id}`));
  expect(reportMock).toHaveBeenCalledWith(null, PLACE_NO_COORDS.id);
});

it('opening an event card reports a viewed outcome keyed by event id', async () => {
  await render(<CompassChatBlocks blocks={[{ type: 'event_cards', events: [EVENT] }]} />);
  fireEvent.press(screen.getByTestId(`compass-block-event-${EVENT.id}`));
  expect(reportMock).toHaveBeenCalledWith(null, EVENT.id);
});

it('opening a comparison event row reports a viewed outcome', async () => {
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
  expect(reportMock).toHaveBeenCalledWith(null, EVENT.id);
});

it('opening a map row reports a viewed outcome for that place', async () => {
  await render(<CompassChatBlocks blocks={[{ type: 'map', places: [PLACE] }]} />);
  fireEvent.press(screen.getByTestId(`compass-block-map-${PLACE.id}`));
  expect(reportMock).toHaveBeenCalledWith(null, PLACE.id);
});
