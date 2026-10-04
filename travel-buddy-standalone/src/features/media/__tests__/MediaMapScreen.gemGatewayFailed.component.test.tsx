/**
 * census-discovery §115 (DV-83 round 18, lane W11-X2; the round-17 verifier's B13): the Hidden Gems lens's map mode
 * (MediaMapScreen with no clusters and `includeGems`: every gem zone comes from the NOW gateway) is EMPTY only when the
 * gateway answered with its flag on. A gateway that failed, refused or is off read no gem; the screen says the
 * positions are unavailable, never "No hidden gems on the map yet". The verifier's V17-MG probes, copied in (MG0–MG2),
 * and this lane's:
 *
 *   V17-MG0  CONTROL: gems and places read whole, none in view → the empty state (honest)
 *   V17-MG1  the gateway call failed → not the empty state;   MG1b: the "could not be reached" copy
 *   V17-MG2  the gateway refused → not the empty state;       MG2b: the "not available right now" copy
 *   MG4      the gateway flag is off → not the empty state (gems are served only by the gateway)
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react-native';
import { MediaMapScreen } from '../screens/MediaMapScreen.tsx';

const mockFetchMediaMap = jest.fn();
const mockFetchMapProjection = jest.fn();

jest.mock('../services/mediaProjection.ts', () => ({
  ...jest.requireActual('../services/mediaProjection.ts'),
  fetchMediaMap: (...args: unknown[]) => mockFetchMediaMap(...args),
}));
jest.mock('../../../services/mapProjection.ts', () => ({
  ...jest.requireActual('../../../services/mapProjection.ts'),
  fetchMapProjection: (...args: unknown[]) => mockFetchMapProjection(...args),
}));
// NOTE: intentionally exhaustive — renders children so the canvas mounts.
jest.mock('@maplibre/maplibre-react-native', () => {
  const React = require('react');
  const { View } = require('react-native');
  const Pass = ({ children }: any) => <View>{children}</View>;
  return { Map: ({ children }: any) => <View testID="maplibre-map">{children}</View>, Camera: () => null, Marker: Pass, GeoJSONSource: Pass, Layer: () => null };
});

const CENTER = { lat: 16.05, lng: 108.22 };
const EMPTY = 'No hidden gems on the map yet';
const NO_CLUSTERS = () => Promise.resolve({ ok: true as const, data: [] });

beforeEach(() => { mockFetchMediaMap.mockReset(); mockFetchMapProjection.mockReset(); });

async function gemMap(center: { lat: number; lng: number } | null = CENTER) {
  await render(<MediaMapScreen center={center} loadClusters={NO_CLUSTERS as any} includeGems title="Hidden Gems" emptyTitle={EMPTY} emptyMessage="Gems appear as contoured areas once the map can place them — never as an exact point." />);
  if (center) await waitFor(() => expect(mockFetchMapProjection).toHaveBeenCalled());
  await waitFor(() => expect(screen.queryByText(/Loading|loading/)).toBeNull());
  await new Promise((r) => setTimeout(r, 20));
  const texts = screen.queryAllByText(/./).map((n) => String((n.props as any).children)).filter((t) => t && t !== 'undefined');
  const unavailable = screen.queryByTestId('media-map-positions-unavailable');
  return { empty: screen.queryByText(EMPTY) != null, texts, unavailable: unavailable ? String((unavailable.props as any).children) : null };
}

describe('census-discovery §115 (B13): the Hidden Gems map over a gateway that failed, refused or is off', () => {
  it('V17-MG0 CONTROL: gems and places read whole, none in view → the empty state', async () => {
    mockFetchMapProjection.mockResolvedValue({ ok: true, data: { enabled: true, objects: [], sources: ['places', 'gems'], nextCursor: null } });
    const r = await gemMap();
    expect(r.empty).toBe(true);
  });
  it('V17-MG1 the gateway call FAILED → never "No hidden gems on the map yet"', async () => {
    mockFetchMapProjection.mockResolvedValue({ ok: false, error: 'Network request failed' });
    const r = await gemMap();
    expect({ empty: r.empty, texts: r.texts }).toEqual(expect.objectContaining({ empty: false }));
  });
  it('V17-MG2 the gateway REFUSED (enabled:false, protection_unreadable) → never the empty state', async () => {
    mockFetchMapProjection.mockResolvedValue({ ok: true, data: { enabled: false, refusal: 'protection_unreadable', objects: [], sources: [], nextCursor: null } });
    const r = await gemMap();
    expect({ empty: r.empty, texts: r.texts }).toEqual(expect.objectContaining({ empty: false }));
  });
  it('MG1b the gateway call FAILED → the positions-unavailable copy is said', async () => {
    mockFetchMapProjection.mockResolvedValue({ ok: false, error: 'Network request failed' });
    const r = await gemMap();
    expect(r.unavailable).toBe('The map could not be reached. Places are listed below by perspective count.');
  });
  it('MG2b the gateway REFUSED → the positions-unavailable copy is said', async () => {
    mockFetchMapProjection.mockResolvedValue({ ok: true, data: { enabled: false, refusal: 'flag_unreadable', objects: [], sources: [], nextCursor: null } });
    const r = await gemMap();
    expect(r.empty).toBe(false);
    expect(r.unavailable).toBe('Map positions are not available right now. Places are listed below by perspective count.');
  });
  it('MG4 the gateway flag is OFF (enabled:false, no refusal) → gems were never read: not the empty state', async () => {
    mockFetchMapProjection.mockResolvedValue({ ok: true, data: { enabled: false, objects: [], sources: [], nextCursor: null } });
    const r = await gemMap();
    expect(r.empty).toBe(false);
    expect(r.unavailable).not.toBeNull();
  });
});
