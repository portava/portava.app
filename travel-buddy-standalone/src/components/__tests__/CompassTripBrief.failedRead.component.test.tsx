/**
 * census-discovery §109 (DV-83 round 12, lane W11-X2, D-W11X2-86): the trip page's Compass Brief
 * (src/components/TripPage.tsx `CompassTripBrief`, mounted by app/trip/[id].tsx) over a failed,
 * refused or partial GET /compass/recommendations?surface=trip read.
 *
 * The brief read the answer as `res.ok && res.data` alone, swallowed a thrown read, and hid itself
 * whenever its list was empty, so a refusal (`nothing`) and a network error looked exactly like
 * "no results", a `partial` answer carrying only the static safety note was drawn as a complete
 * brief, and a late answer for one trip was drawn on another trip's brief (§109.1 BK1). It now
 * composes through `tripCompassRecommendations` / `tripCompassReadState` (the shared predicate),
 * says a failed read with a retry, keeps a partial answer's rows under `listPartialNotice`, and
 * lets only its latest request write.
 *
 *   V11-TB0  CONTROL: a complete answer renders its item, with no failed or partial line
 *   V11-TB1  refused `nothing` → the failed line, never hidden like "no results"
 *   V11-TB2  `partial` (only the static safety note survived) → the note, under the incomplete line
 *   V11-TB3  a network error → the failed line
 *   V11-TB4  trip t1's late answer lands after the brief moved to t2 → t1's item is never drawn on t2
 *   TB5      a thrown read → the failed line; Retry refetches and draws the answer
 *   TB6      a refusal with an unknown coverage → the failed line (the shared predicate)
 *   TB7      trip t1's late FAILURE lands after t2 answered → t2's brief keeps its item and no failed line
 *   TB8      CONTROL: an answered empty list with no refusal still hides the brief
 *   TB9      moving to another trip whose read fails never leaves the previous trip's items on it
 *   TB10     moving to another trip whose read fails never leaves the previous trip's held-back note on it
 *   TB11     moving to another trip whose read THROWS never leaves the previous trip's items on it
 *   TB12     a failed trip, then no trip and no city → the brief hides (no stale failed line)
 *   TB13     a trip still loading, then no trip and no city → the brief hides (no stale spinner)
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react-native';

jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { push: jest.fn() },
}));

// NOTE: intentional stub — the brief's one network call is replaced so the component is driven by
// the exact response shapes GET /compass/recommendations?surface=trip produces.
jest.mock('../../services/compass.ts', () => ({
  ...jest.requireActual('../../services/compass.ts'),
  fetchCompassTripBrief: jest.fn(),
  reportCompassViewed: jest.fn(),
}));

import { fetchCompassTripBrief } from '../../services/compass.ts';
import { CompassTripBrief } from '../TripPage.tsx';

const mockFetch = fetchCompassTripBrief as jest.MockedFunction<typeof fetchCompassTripBrief>;
const item = (id: string, title: string) => ({ id, type: 'hidden_gem', category: 'food', title, reason: 'near you', city: 'Cebu', data: null }) as any;
const safety = { id: 'static_safety_tip_cebu', type: 'safety_tip', category: 'safety', title: 'Safety Note — Cebu', reason: 'Check advisories', city: 'Cebu', data: null } as any;
const FAILED = 'Couldn’t load the Compass Brief just now.';
const PARTIAL = 'Some recommendations couldn’t be loaded just now, so this list may be incomplete.';
const FAILED_OR_INCOMPLETE = /couldn.?t|could not|unavailable|incomplete|try again/i;
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };

describe('CompassTripBrief — a failed, refused or partial /compass/recommendations read is said (§109, D-W11X2-86)', () => {
  beforeEach(() => mockFetch.mockReset());

  it('V11-TB0 CONTROL: a complete answer renders its item', async () => {
    mockFetch.mockResolvedValue({ ok: true, data: { recommendations: [item('r1', 'Colon Street pharmacy')], surface: 'trip' } });
    await render(<CompassTripBrief tripId="t1" city="Cebu" />);
    await screen.findByText('Colon Street pharmacy');
    expect(screen.queryByText(FAILED_OR_INCOMPLETE)).toBeNull();
    expect(screen.queryByTestId('compass-brief-failed')).toBeNull();
    expect(screen.queryByTestId('compass-brief-partial')).toBeNull();
  });

  it('V11-TB1 refused `nothing` → must not self-hide exactly as "no results"', async () => {
    mockFetch.mockResolvedValue({ ok: true, data: { recommendations: [], surface: 'trip', refusal: { class: 'transient_db', code: 'recommendations_build_failed', coverage: 'nothing', failedSources: ['compass_recommendations'] } } as any });
    await render(<CompassTripBrief tripId="t1" city="Cebu" />);
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    await flush();
    expect(screen.queryByText(FAILED_OR_INCOMPLETE)).not.toBeNull();
    await screen.findByText(FAILED);
    expect(screen.getByText('Compass Brief')).toBeTruthy();
  });

  it('V11-TB2 `partial` (only the static safety note survived) → must say the brief may be incomplete', async () => {
    mockFetch.mockResolvedValue({ ok: true, data: { recommendations: [safety], surface: 'trip', refusal: { class: 'transient_db', code: 'compass_sources_unread', coverage: 'partial', failedSources: ['posts', 'events', 'discovery_places', 'hidden_gems', 'rent_buddy_profiles'] } } as any });
    await render(<CompassTripBrief tripId="t1" city="Cebu" />);
    await screen.findByText('Safety Note — Cebu');
    expect(screen.queryByText(FAILED_OR_INCOMPLETE)).not.toBeNull();
    expect(screen.getByText(PARTIAL)).toBeTruthy();
    expect(screen.queryByText(FAILED)).toBeNull();
  });

  it('V11-TB3 network error → must not self-hide exactly as "no results"', async () => {
    mockFetch.mockResolvedValue({ ok: false, error: 'network_error' });
    await render(<CompassTripBrief tripId="t1" city="Cebu" />);
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    await flush();
    expect(screen.queryByText(FAILED_OR_INCOMPLETE)).not.toBeNull();
    expect(screen.getByTestId('compass-brief-failed')).toBeTruthy();
  });

  it("V11-TB4 a stale answer for trip t1 must not be drawn on trip t2's brief", async () => {
    let resolveT1: (v: any) => void = () => {};
    mockFetch.mockImplementation(((p: { tripId: string }) => p.tripId === 't1'
      ? new Promise((r) => { resolveT1 = r; })
      : Promise.resolve({ ok: true, data: { recommendations: [item('r2', 'Lisbon tram')], surface: 'trip' } })) as any);
    const view = await render(<CompassTripBrief tripId="t1" city="Cebu" />);
    await view.rerender(<CompassTripBrief tripId="t2" city="Lisbon" />);
    await screen.findByText('Lisbon tram');
    await act(async () => { resolveT1({ ok: true, data: { recommendations: [item('r1', 'Cebu pharmacy')], surface: 'trip' } }); await Promise.resolve(); });
    expect(screen.queryByText('Cebu pharmacy')).toBeNull();
    expect(screen.getByText('Lisbon tram')).toBeTruthy();
  });

  it('TB5 a thrown read → the failed line; Retry refetches and draws the answer', async () => {
    mockFetch.mockRejectedValueOnce(new Error('socket hang up'));
    mockFetch.mockResolvedValueOnce({ ok: true, data: { recommendations: [item('r1', 'Colon Street pharmacy')], surface: 'trip' } });
    await render(<CompassTripBrief tripId="t1" city="Cebu" />);
    await screen.findByText(FAILED);
    fireEvent.press(screen.getByTestId('compass-brief-retry'));
    await screen.findByText('Colon Street pharmacy');
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(FAILED)).toBeNull();
  });

  it('TB6 a refusal with an unknown coverage is a failed read, never a complete empty brief', async () => {
    mockFetch.mockResolvedValue({ ok: true, data: { recommendations: [item('r9', 'Should not show')], surface: 'trip', refusal: { code: 'x', coverage: 'mystery' } } as any });
    await render(<CompassTripBrief tripId="t1" city="Cebu" />);
    await screen.findByText(FAILED);
    expect(screen.queryByText('Should not show')).toBeNull();
  });

  it("TB7 trip t1's late FAILURE after t2 answered does not put the failed line on t2", async () => {
    let rejectT1: (e: unknown) => void = () => {};
    mockFetch.mockImplementation(((p: { tripId: string }) => p.tripId === 't1'
      ? new Promise((_r, j) => { rejectT1 = j; })
      : Promise.resolve({ ok: true, data: { recommendations: [item('r2', 'Lisbon tram')], surface: 'trip' } })) as any);
    const view = await render(<CompassTripBrief tripId="t1" city="Cebu" />);
    await view.rerender(<CompassTripBrief tripId="t2" city="Lisbon" />);
    await screen.findByText('Lisbon tram');
    await act(async () => { rejectT1(new Error('late')); await Promise.resolve(); await Promise.resolve(); });
    expect(screen.queryByText(FAILED)).toBeNull();
    expect(screen.getByText('Lisbon tram')).toBeTruthy();
  });

  it('TB8 CONTROL: an answered empty list with no refusal still hides the brief', async () => {
    mockFetch.mockResolvedValue({ ok: true, data: { recommendations: [], surface: 'trip' } });
    await render(<CompassTripBrief tripId="t1" city="Cebu" />);
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText('Compass Brief')).toBeNull());
  });

  it("TB9 moving to another trip whose read fails never leaves the previous trip's items on it", async () => {
    mockFetch.mockImplementation(((p: { tripId: string }) => p.tripId === 't1'
      ? Promise.resolve({ ok: true, data: { recommendations: [item('r1', 'Cebu pharmacy')], surface: 'trip' } })
      : Promise.resolve({ ok: false, error: 'network_error' })) as any);
    const view = await render(<CompassTripBrief tripId="t1" city="Cebu" />);
    await screen.findByText('Cebu pharmacy');
    await view.rerender(<CompassTripBrief tripId="t2" city="Lisbon" />);
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    await flush();
    expect(screen.queryByText('Cebu pharmacy')).toBeNull();
    expect(screen.getByTestId('compass-brief-failed')).toBeTruthy();
  });

  it("TB10 moving to another trip whose read fails never leaves the previous trip's held-back note on it", async () => {
    const suppressed = { consulted: true, tripId: 't1', mode: 'SAFETY_EVENT', suppressed: true, reason: 'TRIP_DISRUPTION_SUPPRESSED', withheld: 2, detail: null, info: null } as any;
    mockFetch.mockImplementation(((p: { tripId: string }) => p.tripId === 't1'
      ? Promise.resolve({ ok: true, data: { recommendations: [item('r1', 'Cebu pharmacy')], surface: 'trip', attention: suppressed } })
      : Promise.resolve({ ok: false, error: 'network_error' })) as any);
    const view = await render(<CompassTripBrief tripId="t1" city="Cebu" />);
    await screen.findByTestId('compass-brief-attention');
    await view.rerender(<CompassTripBrief tripId="t2" city="Lisbon" />);
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    await flush();
    expect(screen.getByTestId('compass-brief-failed')).toBeTruthy();
    expect(screen.queryByTestId('compass-brief-attention')).toBeNull();
  });

  it("TB11 moving to another trip whose read THROWS never leaves the previous trip's items on it", async () => {
    mockFetch.mockImplementation(((p: { tripId: string }) => p.tripId === 't1'
      ? Promise.resolve({ ok: true, data: { recommendations: [item('r1', 'Cebu pharmacy')], surface: 'trip' } })
      : Promise.reject(new Error('socket hang up'))) as any);
    const view = await render(<CompassTripBrief tripId="t1" city="Cebu" />);
    await screen.findByText('Cebu pharmacy');
    await view.rerender(<CompassTripBrief tripId="t2" city="Lisbon" />);
    await screen.findByTestId('compass-brief-failed');
    expect(screen.queryByText('Cebu pharmacy')).toBeNull();
  });

  it('TB12 a failed trip, then no trip and no city → the brief hides', async () => {
    mockFetch.mockResolvedValue({ ok: false, error: 'network_error' });
    const view = await render(<CompassTripBrief tripId="t1" city="Cebu" />);
    await screen.findByTestId('compass-brief-failed');
    await view.rerender(<CompassTripBrief tripId={undefined as any} city={undefined as any} />);
    await flush();
    expect(screen.queryByText('Compass Brief')).toBeNull();
  });

  it('TB13 a trip still loading, then no trip and no city → the brief hides, no stale spinner', async () => {
    mockFetch.mockImplementation((() => new Promise(() => {})) as any);
    const view = await render(<CompassTripBrief tripId="t1" city="Cebu" />);
    await screen.findByText('Loading recommendations…');
    await view.rerender(<CompassTripBrief tripId={undefined as any} city={undefined as any} />);
    await flush();
    expect(screen.queryByText('Loading recommendations…')).toBeNull();
    expect(screen.queryByText('Compass Brief')).toBeNull();
  });
});
