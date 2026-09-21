/**
 * Component tests for JourneysScreen — the standalone Journeys Passport surface.
 *
 * Covers the contract points for this screen (§14 / TABLE 26 / §23):
 *   1. Renders the year → country → city → Trip hierarchy from the projection.
 *   2. Renders the single Featured Journey ("30 Days in Vietnam") with its
 *      route/timeline, places, memories, stamps and people context.
 *   3. Privacy (§23 / TABLE 25): coarse place is shown, exact coordinates never;
 *      the coarse-location assurance note is present.
 *   4. Empty state when the traveller has no journeys yet.
 *
 * NOTE: render() is awaited (RNTL 14 + React 19 + jest-expo) or the screen
 * stays unbound and queries throw "render not called".
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import JourneysScreen from '../JourneysScreen.tsx';
import { getPassportJourneys } from '../../../services/passportProjection.ts';
import { router } from 'expo-router';

// NOTE: intentional stub — the real service reaches Supabase auth + the API
// server, neither available in jest-expo. getPassportJourneys is the seam under
// test; the type-only exports are erased at runtime so this factory is complete.
jest.mock('../../../services/passportProjection', () => ({
  getPassportJourneys: jest.fn(),
  getTravelIdentity: jest.fn(),
  _setTestAuthToken: jest.fn(),
}));

// NOTE: the session hook would otherwise pull in the real Supabase client at
// import time — return a fixed owner id so the data hook fetches from the mock.
jest.mock('../../../context/SessionContext', () => ({
  useSession: () => ({ userId: 'me-123' }),
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

const mockGetJourneys = getPassportJourneys as jest.Mock;

// ── Fixtures — the canonical "30 Days in Vietnam" featured journey. ───────────

function makeFeatured() {
  return {
    tripId: 'trip-vn',
    title: '30 Days in Vietnam',
    year: 2024,
    country: 'Vietnam',
    city: 'Da Nang',
    startDate: '2024-05-01',
    endDate: '2024-05-30',
    durationLabel: '30 days',
    status: 'completed',
    memoryCount: 2,
    stampCount: 2,
    memories: [
      { id: 'm1', title: 'Marble Mountains', city: 'Da Nang', country: 'Vietnam', category: 'nature', photoUrl: null, earnedAt: '2024-05-03' },
      { id: 'm2', title: 'Hoi An Lanterns', city: 'Hoi An', country: 'Vietnam', category: 'culture', photoUrl: null, earnedAt: '2024-05-12' },
    ],
    stamps: [
      { name: 'Vietnam Explorer', city: 'Da Nang', country: 'Vietnam', earnedAt: '2024-05-02' },
      { name: 'Hidden Gem: Hoi An', city: 'Hoi An', country: 'Vietnam', earnedAt: '2024-05-12' },
    ],
    featured: true,
    people: [{ id: 'p1', name: 'Mai', handle: 'mai', avatarUrl: null }],
    // §14's last two elements (census-passport P75). The server decides what
    // arrives — it has already applied event visibility and the Hidden Gem
    // disclosure policy — so the screen's whole job is to render what it gets.
    events: [
      { id: 'e1', title: 'Lantern Festival', city: 'Hoi An', country: 'Vietnam', startsAt: '2024-05-12T10:00:00Z', endsAt: '2024-05-12T20:00:00Z', role: 'attendee' as const },
      { id: 'e2', title: 'Crew Dinner', city: 'Da Nang', country: 'Vietnam', startsAt: '2024-05-20T10:00:00Z', endsAt: '2024-05-20T14:00:00Z', role: 'host' as const },
    ],
    recommendations: [
      { id: 'g1', kind: 'hidden_gem' as const, name: 'Rooftop Noodle Stall', category: 'food', city: 'Da Nang', country: 'Vietnam', neighborhood: 'An Hai', createdAt: '2024-05-08T00:00:00Z' },
    ],
  };
}

function makeProjection() {
  const featured = makeFeatured();
  return {
    userId: 'me-123',
    years: [
      {
        year: 2024,
        countries: [
          { country: 'Vietnam', cities: [{ city: 'Da Nang', journeys: [featured] }] },
        ],
      },
    ],
    featured,
    totalJourneys: 1,
  };
}

beforeEach(() => {
  mockGetJourneys.mockReset();
  (router.push as jest.Mock).mockReset();
  (router.back as jest.Mock).mockReset();
});

describe('JourneysScreen', () => {
  it('renders the year → country → city → Trip hierarchy', async () => {
    mockGetJourneys.mockResolvedValue({ ok: true, data: { journeys: makeProjection(), restricted: false } });

    await render(<JourneysScreen />);

    await waitFor(() => expect(screen.getByText('2024')).toBeTruthy());
    // Country + city appear (as hierarchy labels; also elsewhere → getAllByText).
    expect(screen.getAllByText('Vietnam').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Da Nang').length).toBeGreaterThan(0);
    // The Trip title appears in both the featured card and the trip row.
    expect(screen.getAllByText('30 Days in Vietnam').length).toBeGreaterThan(0);
  });

  it('renders the single Featured Journey with route, places, memories, stamps and people', async () => {
    mockGetJourneys.mockResolvedValue({ ok: true, data: { journeys: makeProjection(), restricted: false } });

    await render(<JourneysScreen />);

    // Featured badge + section headers
    await waitFor(() => expect(screen.getByText('Featured Journey')).toBeTruthy());
    expect(screen.getByText('Route')).toBeTruthy();
    expect(screen.getByText('Places')).toBeTruthy();
    expect(screen.getByText('Memories')).toBeTruthy();
    expect(screen.getByText('Stamps')).toBeTruthy();
    expect(screen.getByText('People')).toBeTruthy();

    // Duration + specific places / memories / stamps / people
    expect(screen.getAllByText('30 days').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Marble Mountains').length).toBeGreaterThan(0);
    // The stamp name also surfaces as a derived "place" chip → appears twice.
    expect(screen.getAllByText('Vietnam Explorer').length).toBeGreaterThan(0);
    expect(screen.getByText('Mai')).toBeTruthy();
  });

  it('renders the Featured Journey EVENTS and RECOMMENDATIONS sections (§14, P75)', async () => {
    mockGetJourneys.mockResolvedValue({ ok: true, data: { journeys: makeProjection(), restricted: false } });

    await render(<JourneysScreen />);

    await waitFor(() => expect(screen.getByText('Featured Journey')).toBeTruthy());
    expect(screen.getByText('Events')).toBeTruthy();
    expect(screen.getByText('Recommendations')).toBeTruthy();
    expect(screen.getByText('Lantern Festival')).toBeTruthy();
    expect(screen.getByText('Crew Dinner')).toBeTruthy();
    expect(screen.getByText('Rooftop Noodle Stall')).toBeTruthy();
    // The owner's OWN relationship to each event is the server's answer, shown
    // verbatim — attended vs hosted is not something this screen guesses.
    expect(screen.getByText(/Attended · Hoi An · May 2024/)).toBeTruthy();
    expect(screen.getByText(/Hosted · Da Nang · May 2024/)).toBeTruthy();
  });

  it('omits both new sections entirely when the server attaches neither (§14, P75)', async () => {
    // An older server, or a viewer permitted neither, sends no field at all.
    const projection = makeProjection();
    delete (projection.featured as Record<string, unknown>).events;
    delete (projection.featured as Record<string, unknown>).recommendations;
    mockGetJourneys.mockResolvedValue({ ok: true, data: { journeys: projection, restricted: false } });

    await render(<JourneysScreen />);

    await waitFor(() => expect(screen.getByText('Featured Journey')).toBeTruthy());
    expect(screen.queryByText('Events')).toBeNull();
    expect(screen.queryByText('Recommendations')).toBeNull();
    // …and the sections that WERE there are unaffected.
    expect(screen.getByText('Memories')).toBeTruthy();
  });

  it('shows coarse place but never renders exact coordinates (§23)', async () => {
    // Smuggle coordinates onto a memory: even if the payload carried them, the
    // UI must not surface them.
    const projection = makeProjection();
    (projection.featured!.memories[0] as Record<string, unknown>).lat = 16.004567;
    (projection.featured!.memories[0] as Record<string, unknown>).lng = 108.219123;
    mockGetJourneys.mockResolvedValue({ ok: true, data: { journeys: projection, restricted: false } });

    await render(<JourneysScreen />);

    // Coarse city labels ARE shown — that is the permitted granularity.
    await waitFor(() => expect(screen.getAllByText('Da Nang').length).toBeGreaterThan(0));
    // The coarse-location assurance note is present.
    expect(screen.getByText(/your exact locations are never shown/i)).toBeTruthy();

    // No decimal-coordinate-looking string anywhere in the rendered tree.
    const treeText = JSON.stringify(screen.toJSON());
    expect(treeText).not.toMatch(/\d+\.\d{4,}/);
    expect(treeText).not.toContain('16.004567');
    expect(treeText).not.toContain('108.219123');
  });

  it('shows the empty state when the traveller has no journeys', async () => {
    mockGetJourneys.mockResolvedValue({
      ok: true,
      data: { journeys: { userId: 'me-123', years: [], featured: null, totalJourneys: 0 }, restricted: false },
    });

    await render(<JourneysScreen />);

    await waitFor(() => expect(screen.getByText('No journeys yet')).toBeTruthy());
    expect(screen.queryByText('Featured Journey')).toBeNull();
  });

  it('deep-links to the Map from the empty state (never embeds it)', async () => {
    mockGetJourneys.mockResolvedValue({
      ok: true,
      data: { journeys: { userId: 'me-123', years: [], featured: null, totalJourneys: 0 }, restricted: false },
    });

    await render(<JourneysScreen />);

    const btn = await waitFor(() => screen.getByText('Explore the Map'));
    fireEvent.press(btn);
    expect(router.push).toHaveBeenCalledWith('/map?entityTypes=stamps&mode=passport&entry=passport');
  });
});
