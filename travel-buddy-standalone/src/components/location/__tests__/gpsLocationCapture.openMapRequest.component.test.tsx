/**
 * census-input-intelligence G90 — `GpsLocationCapture`'s `openMapRequest`: the
 * Gem location sheet's "Drop a pin on the map" row asks the step to open its map.
 * Each NEW positive value opens the map picker once; 0 never does; the point the
 * person confirms is what `onCapture` receives.
 *
 * MUTATION LOG (applied, watched go red, restored):
 *   - drop the `openMapRequest` effect → "opens the map" red.
 *   - open on any value (no `> 0`) → the 0 control red.
 */
import React from 'react';
import { render, screen, cleanup } from '@testing-library/react-native';

// NOTE: intentionally exhaustive — the native icon set is not available under jest.
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
// NOTE: exhaustive-by-design stub — the map is a native module; this shows whether it is open.
jest.mock('../MapLocationPicker', () => {
  const R = require('react');
  const { Text } = require('react-native');
  return { MapLocationPicker: ({ visible }: { visible: boolean }) => (visible ? R.createElement(Text, null, 'MAP OPEN') : null) };
});
// NOTE: exhaustive-by-design stub — GPS and reverse geocoding are native/network flows, not under test.
jest.mock('../../../services/location.ts', () => ({
  getCurrentGps: jest.fn(),
  reverseGeocodeToPlace: jest.fn(),
}));

import { GpsLocationCapture } from '../GpsLocationCapture.tsx';

afterEach(() => cleanup());

test('a positive openMapRequest opens the map picker', async () => {
  await render(<GpsLocationCapture onCapture={() => {}} openMapRequest={1} />);
  expect(screen.getByText('MAP OPEN')).toBeTruthy();
});

test('CONTROL: 0 (or absent) never opens it', async () => {
  await render(<GpsLocationCapture onCapture={() => {}} openMapRequest={0} />);
  expect(screen.queryByText('MAP OPEN')).toBeNull();
  await cleanup();
  await render(<GpsLocationCapture onCapture={() => {}} />);
  expect(screen.queryByText('MAP OPEN')).toBeNull();
});

test('a request while a point is already pinned opens the map too', async () => {
  const r = await render(<GpsLocationCapture onCapture={() => {}} initialLabel="Old pin" openMapRequest={0} />);
  expect(screen.getByText('Location pinned')).toBeTruthy();
  expect(screen.queryByText('MAP OPEN')).toBeNull();
  await r.rerender(<GpsLocationCapture onCapture={() => {}} initialLabel="Old pin" openMapRequest={1} />);
  expect(screen.getByText('MAP OPEN')).toBeTruthy();
});
