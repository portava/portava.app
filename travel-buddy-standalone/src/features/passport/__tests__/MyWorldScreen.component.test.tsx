/**
 * Component tests for MyWorldScreen — the standalone My World Passport surface.
 *
 * Covers the four contract points for this screen:
 *   1. Renders the WORLD → Country → City hierarchy from the passport map payload.
 *   2. Privacy (§23 / TABLE 25): coarse place is shown, exact coordinates never.
 *   3. Empty state when the traveller has no place-rooted stamps yet.
 *   4. Deep-link action present — "View on Map" hands off to the main Map, and
 *      a country row deep-links into the existing country stamps screen.
 *   5. (bonus) Error + retry state machine.
 *
 * NOTE: render() is awaited (RNTL 14 + React 19 + jest-expo) or the screen
 * stays unbound and queries throw "render not called".
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import MyWorldScreen from '../MyWorldScreen.tsx';
import { getPassportMap } from '../../../services/passportStamps.ts';
import { router } from 'expo-router';

// NOTE: intentional stub — the real service reaches Supabase auth + the API
// server, neither of which is available in the jest-expo env. getPassportMap is
// the seam under test; _setTestAuthToken is a no-op so imports don't crash.
jest.mock('../../../services/passportStamps', () => ({
  getPassportMap: jest.fn(),
  _setTestAuthToken: jest.fn(),
}));

// NOTE: expo-router requires Expo native navigation modules unavailable in the
// jest-expo env — exhaustive stub of the two members this screen touches.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn() },
}));

// NOTE: react-native-safe-area-context needs a provider that isn't mounted in
// these unit renders — return fixed insets so the screen lays out.
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

const mockGetPassportMap = getPassportMap as jest.Mock;
const mockPush = router.push as jest.Mock;

// ── Fixtures ─────────────────────────────────────────────────────────────────
// Japan (Tokyo 4, Kyoto 2) + Thailand (Bangkok 1) → 2 countries, 3 cities, 7 stamps.

function makePayload() {
  return {
    countries: ['Japan', 'Thailand'],
    cities: ['Bangkok', 'Kyoto', 'Tokyo'],
    markers: [
      {
        country: 'Japan',
        city: 'Tokyo',
        neighborhood: 'Shibuya',
        stampCount: 4,
        verificationLevel: 'gps',
        displayLabel: 'Tokyo, Japan',
      },
      {
        country: 'Japan',
        city: 'Kyoto',
        neighborhood: null,
        stampCount: 2,
        verificationLevel: 'unverified',
        displayLabel: 'Kyoto, Japan',
      },
      {
        country: 'Thailand',
        city: 'Bangkok',
        neighborhood: null,
        stampCount: 1,
        verificationLevel: 'checkin',
        displayLabel: 'Bangkok, Thailand',
      },
    ],
  };
}

beforeEach(() => {
  mockGetPassportMap.mockReset();
  mockPush.mockReset();
});

describe('MyWorldScreen', () => {
  it('renders the WORLD → Country → City hierarchy from the passport map payload', async () => {
    mockGetPassportMap.mockResolvedValue({ ok: true, data: makePayload() });

    await render(<MyWorldScreen />);

    // Countries
    await waitFor(() => expect(screen.getByText('Japan')).toBeTruthy());
    expect(screen.getByText('Thailand')).toBeTruthy();

    // Cities under their countries
    expect(screen.getByText('Tokyo')).toBeTruthy();
    expect(screen.getByText('Kyoto')).toBeTruthy();
    expect(screen.getByText('Bangkok')).toBeTruthy();

    // World stats (labels + the unique total-stamps value)
    expect(screen.getByText('Countries')).toBeTruthy();
    expect(screen.getByText('Cities')).toBeTruthy();
    expect(screen.getByText('Stamps')).toBeTruthy();
    expect(screen.getAllByText('7').length).toBeGreaterThan(0); // total stamps
  });

  it('shows coarse place but never renders exact coordinates (§23)', async () => {
    // Smuggle coordinates onto a marker: even if the payload carried them, the
    // UI must not surface them.
    const payload = makePayload();
    (payload.markers[0] as Record<string, unknown>).lat = 35.658034;
    (payload.markers[0] as Record<string, unknown>).lng = 139.701636;
    mockGetPassportMap.mockResolvedValue({ ok: true, data: payload });

    await render(<MyWorldScreen />);

    // Coarse neighbourhood label IS shown — that is the permitted granularity.
    await waitFor(() => expect(screen.getByText('Shibuya')).toBeTruthy());

    // No decimal-coordinate-looking string anywhere in the rendered tree.
    const treeText = JSON.stringify(screen.toJSON());
    expect(treeText).not.toMatch(/\d+\.\d{4,}/);
    expect(treeText).not.toContain('35.658034');
    expect(treeText).not.toContain('139.701636');
  });

  it('shows the empty state when the traveller has no place-rooted stamps', async () => {
    mockGetPassportMap.mockResolvedValue({
      ok: true,
      data: { countries: [], cities: [], markers: [] },
    });

    await render(<MyWorldScreen />);

    await waitFor(() =>
      expect(screen.getByText('Your world map is empty')).toBeTruthy(),
    );
    // No country cards rendered.
    expect(screen.queryByText('Japan')).toBeNull();
  });

  it('deep-links to the main Map (never embeds it) via the "View on Map" action', async () => {
    mockGetPassportMap.mockResolvedValue({ ok: true, data: makePayload() });

    await render(<MyWorldScreen />);

    const mapBtn = await waitFor(() => screen.getByText('View on Map'));
    fireEvent.press(mapBtn);

    expect(mockPush).toHaveBeenCalledWith('/map?entityTypes=stamps&mode=passport');
  });

  it('deep-links into the country stamps screen when a country is pressed', async () => {
    mockGetPassportMap.mockResolvedValue({ ok: true, data: makePayload() });

    await render(<MyWorldScreen />);

    const country = await waitFor(() => screen.getByText('Japan'));
    fireEvent.press(country);

    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/passport/country/[country]',
      params: { country: 'Japan' },
    });
  });

  it('shows an error card and recovers on retry', async () => {
    mockGetPassportMap.mockResolvedValueOnce({ ok: false, message: 'Network error' });

    await render(<MyWorldScreen />);

    await waitFor(() =>
      expect(screen.getByText("Couldn't load your world")).toBeTruthy(),
    );

    // Retry resolves with an empty (but valid) world → empty state.
    mockGetPassportMap.mockResolvedValueOnce({
      ok: true,
      data: { countries: [], cities: [], markers: [] },
    });
    fireEvent.press(screen.getByText('Tap to retry'));

    await waitFor(() =>
      expect(screen.getByText('Your world map is empty')).toBeTruthy(),
    );
  });
});
