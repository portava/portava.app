/**
 * census-discovery §115 (DV-83 round 18, lane W11-X2; the round-17 verifier's B7, B8, B9): the NOW map over a layer the
 * gateway cut at its cap or could not read, and over a gateway whose own flag could not be read.
 *
 * The round-17 verifier's V17-NC probes, adapted to the bodies the fixed gateway sends (`mapGatewayCutLayers`,
 * `mapGatewayFlagUnread`), with the real hook and the real `MapUnreadLayersBanner`:
 *
 *   V17-NC0  CONTROL: places, saved, memories and buddies not named → each is said
 *   V17-NC1  the verifier's body, unchanged: `places` named over `places.truncated` → the cut is said (the hook reads
 *            `places.truncated` as well as `nextCursor`)
 *   NC1b     the fixed body: `places` not named, `places.truncated` → places said, and the cut
 *   NC2      saved cut (`saves_capped`, not named) → said
 *   NC3      memories cut (`subjects_capped`, not named) → said
 *   NC4      buddies over an unread `rent_buddy_enabled` (not named) → said
 *   NC5      the gateway's flag could not be read (`enabled: false`, `refusal: "flag_unreadable"`) → the safety line
 *            first, as an alert, and every other optional layer only the gateway serves
 *   NC5o     CONTROL: the flag-off body (no refusal) is OFF, not unread → nothing said (NU8c)
 *   NC6      CONTROL: a whole answer (`places.truncated: false`, every layer named) → nothing said
 */
import React from 'react';
import { render, renderHook, screen, waitFor } from '@testing-library/react-native';
import { useMapEntities } from '../useMapEntities.ts';
import { MapUnreadLayersBanner } from '../../components/map/MapUnreadLayersBanner.tsx';

// NOTE: exhaustive by design — the hook forwards only to `fetchMapProjection` and `bboxFromCenter` from this module.
jest.mock('../../services/mapProjection.ts', () => ({
  fetchMapProjection: jest.fn(),
  bboxFromCenter: (lat: number, lng: number, r: number) => ({ west: lng - r / 111, south: lat - r / 111, east: lng + r / 111, north: lat + r / 111 }),
}));
// NOTE: exhaustive by design — the legacy fetchers answer empty and whole; the gateway leg is what is under test.
jest.mock('../../services/rentABuddy.ts', () => ({ searchBuddies: jest.fn() }));
// NOTE: exhaustive by design
jest.mock('../../services/trips.ts', () => ({ listMyTrips: jest.fn() }));
// NOTE: exhaustive by design
jest.mock('../../services/map.ts', () => ({ listVisibleCircleLocations: jest.fn() }));
// NOTE: exhaustive by design
jest.mock('../../services/events.ts', () => ({ listEvents: jest.fn() }));
// NOTE: exhaustive by design
jest.mock('../../services/hiddenGems.ts', () => ({ listGems: jest.fn() }));
// NOTE: exhaustive by design
jest.mock('../../features/map/cache/mapCache.ts', () => ({ mapCache: { read: jest.fn(), write: jest.fn(), purgeSupersededVersions: jest.fn().mockResolvedValue(0) } }));

const { fetchMapProjection } = jest.requireMock('../../services/mapProjection.ts') as { fetchMapProjection: jest.Mock };
const { searchBuddies } = jest.requireMock('../../services/rentABuddy.ts') as { searchBuddies: jest.Mock };
const { listEvents } = jest.requireMock('../../services/events.ts') as { listEvents: jest.Mock };
const { listGems } = jest.requireMock('../../services/hiddenGems.ts') as { listGems: jest.Mock };
const { mapCache } = jest.requireMock('../../features/map/cache/mapCache.ts') as { mapCache: { read: jest.Mock; write: jest.Mock } };

const CENTER = { city: 'Da Nang', lat: 16.1, lng: 108.25 };
const zone = { id: 'zone:city:1', kind: 'activity_zone', geometry: { type: 'Polygon', coordinates: [[[108.2, 16.05], [108.3, 16.05], [108.3, 16.15], [108.2, 16.05]]] }, title: '1000 places in this area', subtitle: null, count: 1000, privacyClass: 'aggregate_only', renderingPriority: 40, interaction: { actions: ['view'], opensSheet: false } };
const PRODUCERS = { meeting_point: null, memory: null, safety_notice: null, saved_place: null };
const body = (sources: string[], over: Record<string, unknown> = {}) => ({ ok: true as const, data: { enabled: true, objects: [], viewport: null, total: 0, nextCursor: null, sources, liveEnrichment: { considered: 0, enriched: 0, skipped: 0 }, producers: PRODUCERS, generatedAt: '2026-09-30T12:00:00.000Z', ...over } });
const FLAG_OFF = { enabled: false, objects: [], viewport: null, total: 0, nextCursor: null, sources: [], aggregation: null, protection: null, liveEnrichment: null, crowdFlow: null, producers: null, places: null, discoveryCandidates: null, trips: null, worldIntelligence: null, display: null, generatedAt: '2026-09-30T12:00:00.000Z' };

async function load(enabledLayers: any[], extra: Record<string, unknown>) {
  const hook = await renderHook(() => useMapEntities({ enabledLayers, ...CENTER, zoom: 9, ...extra }));
  await waitFor(() => expect(hook.result.current.stage).not.toBe('cached_geography'));
  await waitFor(() => expect(fetchMapProjection).toHaveBeenCalled());
  return hook.result.current;
}
async function said(r: { unreadLayers: readonly string[]; truncated: boolean }) {
  await render(<MapUnreadLayersBanner unread={r.unreadLayers} truncated={r.truncated} />);
  const nodes = screen.queryAllByTestId(/map-layers-unread-line-/);
  return { lines: nodes.map((n) => String((n.props as any).children)), roles: nodes.map((n) => (n.props as any).accessibilityRole ?? null), seen: JSON.stringify({ unreadLayers: r.unreadLayers, truncated: r.truncated }) };
}

beforeEach(() => {
  jest.clearAllMocks();
  mapCache.read.mockResolvedValue(null); mapCache.write.mockResolvedValue(undefined);
  listGems.mockResolvedValue([]); listEvents.mockResolvedValue({ ok: true, data: { events: [], page: 1, limit: 50 } });
  searchBuddies.mockResolvedValue({ ok: true, data: { buddies: [], total: 0, page: 1, perPage: 50 } });
});

describe('census-discovery §115 (B7, B8, B9): the NOW map over a cut or unread layer, and an unread gateway flag', () => {
  it('V17-NC0 CONTROL: places, saved, memories and buddies not named → each is said', async () => {
    fetchMapProjection.mockResolvedValue(body([]));
    const r = await load(['buddies'], { places: true, saved: true, memories: true });
    const s = await said(r);
    expect(s.lines.join(' | ')).toMatch(/places/);
    expect(s.lines.join(' | ')).toMatch(/saved places/);
    expect(s.lines.join(' | ')).toMatch(/memories/);
    expect(s.lines.join(' | ')).toMatch(/buddies/);
  });

  it('V17-NC1 (the verifier’s body, unchanged) places named over a read cut at its cap → the cut is said', async () => {
    fetchMapProjection.mockResolvedValue(body(['places'], { objects: [zone], total: 1, places: { rows: 1000, projected: 1000, truncated: true } }));
    const r = await load([], { places: true });
    const s = await said(r);
    expect(r.truncated).toBe(true);
    expect(s.lines).toEqual(expect.arrayContaining([expect.stringMatching(/part of this area/)]));
  });

  it('NC1b the fixed body: places not named, places.truncated → places said, and the cut', async () => {
    fetchMapProjection.mockResolvedValue(body([], { objects: [zone], total: 1, places: { rows: 1001, projected: 1000, truncated: true } }));
    const r = await load([], { places: true });
    const s = await said(r);
    expect(r.unreadLayers).toEqual(['relevant_places']);
    expect(r.truncated).toBe(true);
    expect(s.lines).toEqual(['Couldn’t load places here', 'Showing only part of this area — zoom in to see everything']);
  });

  it('NC2 saved cut at 500 saves (saves_capped, not named) → said', async () => {
    fetchMapProjection.mockResolvedValue(body([], { producers: { ...PRODUCERS, saved_place: { refusal: 'saves_capped', collected: 0 } } }));
    const r = await load([], { saved: true });
    expect((await said(r)).lines).toEqual(['Couldn’t load saved places here']);
  });

  it('NC3 memories cut at 300 subjects (subjects_capped, not named) → said', async () => {
    fetchMapProjection.mockResolvedValue(body([], { producers: { ...PRODUCERS, memory: { refusal: 'subjects_capped', collected: 0 } } }));
    const r = await load([], { memories: true });
    expect((await said(r)).lines).toEqual(['Couldn’t load memories here']);
  });

  it('NC4 buddies over an unread rent_buddy_enabled (not named) → said', async () => {
    fetchMapProjection.mockResolvedValue(body([]));
    const r = await load(['buddies'], {});
    expect((await said(r)).lines).toEqual(['Couldn’t load buddies here']);
  });

  it('NC5 the gateway flag could not be read (refusal flag_unreadable) → the safety line first, as an alert', async () => {
    fetchMapProjection.mockResolvedValue({ ok: true, data: { ...FLAG_OFF, refusal: 'flag_unreadable' } });
    const r = await load([], { safety: true, meetingPoints: true, crowdFlow: true });
    const s = await said(r);
    expect(r.unreadLayers).toEqual(['safety', 'meeting_point', 'crowd_flow']);
    expect(s.lines[0]).toBe('Safety notices couldn’t be checked here — hazards may not be shown');
    expect(s.roles[0]).toBe('alert');
    expect(s.lines[1]).toBe('Couldn’t load meeting points and crowd flow here');
  });

  it('NC5o CONTROL: the flag-off body (no refusal) is off, not unread → nothing said', async () => {
    fetchMapProjection.mockResolvedValue({ ok: true, data: FLAG_OFF });
    const r = await load([], { safety: true, meetingPoints: true });
    expect(r.unreadLayers).toEqual([]);
    expect((await said(r)).lines).toEqual([]);
  });

  it('NC6 CONTROL: a whole answer (places.truncated false, every layer named) → nothing said', async () => {
    fetchMapProjection.mockResolvedValue(body(['places', 'saved', 'memories', 'buddies'], { places: { rows: 3, projected: 3, truncated: false } }));
    const r = await load(['buddies'], { places: true, saved: true, memories: true });
    expect(r.truncated).toBe(false);
    expect((await said(r)).lines).toEqual([]);
  });
});
