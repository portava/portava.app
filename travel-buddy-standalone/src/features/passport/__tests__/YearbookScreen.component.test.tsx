/**
 * Component tests for YearbookScreen — the §9 / Phase 9 Yearbook surface.
 *
 * The contract points this screen exists to keep:
 *   1. Every line renders WITH its evidence — no unexplained number reaches the
 *      user. A line that arrives without evidence is not rendered at all.
 *   2. §37 truth boundary — an inferred Travel DNA line is visibly labelled
 *      "Inferred" and its evidence heading says "Inferred from"; an observed
 *      line says "From your records" and carries no Inferred pill.
 *   3. An empty year renders its honest empty message, not a fabricated summary.
 *   4. An entirely empty yearbook renders the honest empty state.
 *   5. Blocked / hidden material is absent — the screen renders exactly the
 *      server projection and never re-derives or back-fills anything.
 *   6. A withheld (owner-private) yearbook explains itself rather than showing
 *      an error.
 *
 * NOTE: render() is awaited (RNTL 14 + React 19 + jest-expo) or the screen
 * stays unbound and queries throw "render not called".
 */
import React from 'react';
import { render, screen } from '@testing-library/react-native';
import YearbookScreen from '../YearbookScreen.tsx';
import { getPassportYearbook } from '../../../services/passportProjection.ts';
import type { YearbookProjection } from '../../../services/passportProjection.ts';

// NOTE: intentional stub — getPassportYearbook reaches Supabase auth + the API
// server and is the seam under test. The type-only exports of the real module
// are erased at runtime, so this factory is complete for what this screen imports.
jest.mock('../../../services/passportProjection', () => ({
  getPassportYearbook: jest.fn(),
  getPassportJourneys: jest.fn(),
  getTravelIdentity: jest.fn(),
  putTravelDna: jest.fn(),
  _setTestAuthToken: jest.fn(),
}));

// NOTE: the session hook would otherwise pull in the real Supabase client at
// import time — return a fixed owner id so the data hook fetches from the mock.
jest.mock('../../../context/SessionContext', () => ({
  useSession: () => ({ userId: 'me-123' }),
}));

// NOTE: expo-router requires Expo native navigation modules unavailable in the
// jest-expo env — exhaustive stub of the members this screen touches.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn() },
}));

// NOTE: react-native-safe-area-context needs a provider that isn't mounted in
// these unit renders — return fixed insets so the screen lays out.
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

const mockGetYearbook = getPassportYearbook as jest.Mock;

// ── Fixtures ─────────────────────────────────────────────────────────────────

function fullYearbook(): YearbookProjection {
  return {
    userId: 'me-123',
    years: [
      {
        year: 2025,
        countries: ['Vietnam'],
        cities: ['Da Nang', 'Hoi An'],
        journeyCount: 1,
        stampCount: 4,
        memoryCount: 2,
        empty: false,
        emptyMessage: null,
        lines: [
          {
            key: 'places',
            kind: 'places',
            headline: '1 country · 2 cities',
            basis: 'observed',
            evidence: ['Vietnam — Trip "30 Days in Vietnam"', 'Da Nang — Trip "30 Days in Vietnam"'],
          },
          {
            key: 'journey:trip-vn',
            kind: 'journey',
            headline: '30 Days in Vietnam — Da Nang, Vietnam',
            basis: 'observed',
            evidence: ['2 memories', '1 stamp', '30 days', 'Trip status: completed'],
          },
          {
            key: 'stamps-total:5',
            kind: 'stamp_milestone',
            headline: 'Reached 5 stamps',
            basis: 'observed',
            evidence: ['Stamp #5: "Quiet Alley Cafe" (2025-04-02)'],
          },
          {
            key: 'dna-trait:night_explorer',
            kind: 'dna_shift',
            headline: 'Night Explorer emerged',
            basis: 'inferred',
            evidence: ['2025: 2 nightlife visits', '2024: not enough activity for this trait'],
          },
        ],
      },
      {
        year: 2024,
        countries: [],
        cities: [],
        journeyCount: 0,
        stampCount: 0,
        memoryCount: 0,
        empty: true,
        emptyMessage: 'Nothing recorded for 2024.',
        lines: [],
      },
    ],
    empty: false,
    emptyMessage: null,
    included: { journeys: true, stamps: true, memories: true, travelDna: true },
  };
}

function emptyYearbook(): YearbookProjection {
  return {
    userId: 'me-123',
    years: [],
    empty: true,
    emptyMessage:
      'No travel recorded yet. Your yearbook fills in as you take trips, earn stamps and save memories.',
    included: { journeys: false, stamps: true, memories: true, travelDna: true },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetYearbook.mockResolvedValue({ ok: true, data: { yearbook: fullYearbook(), restricted: false } });
});

// ── 1 + 2. Evidence and the truth boundary ───────────────────────────────────

describe('YearbookScreen — every line is explained', () => {
  it('renders each line with the evidence it was built from', async () => {
    await render(<YearbookScreen />);

    expect(await screen.findByText('1 country · 2 cities')).toBeTruthy();
    expect(screen.getByText('• Vietnam — Trip "30 Days in Vietnam"')).toBeTruthy();

    expect(screen.getByText('30 Days in Vietnam — Da Nang, Vietnam')).toBeTruthy();
    expect(screen.getByText('• 2 memories')).toBeTruthy();
    expect(screen.getByText('• Trip status: completed')).toBeTruthy();

    expect(screen.getByText('Reached 5 stamps')).toBeTruthy();
    expect(screen.getByText('• Stamp #5: "Quiet Alley Cafe" (2025-04-02)')).toBeTruthy();
  });

  it('never renders a headline without at least one evidence line beside it', async () => {
    const yb = fullYearbook();
    // A line that somehow arrived unexplained must not be shown at all.
    yb.years[0].lines.push({
      key: 'unexplained',
      kind: 'places',
      headline: '99 countries',
      basis: 'observed',
      evidence: [],
    });
    mockGetYearbook.mockResolvedValue({ ok: true, data: { yearbook: yb, restricted: false } });

    await render(<YearbookScreen />);
    expect(await screen.findByText('Reached 5 stamps')).toBeTruthy();
    expect(screen.queryByText('99 countries')).toBeNull();
    expect(screen.queryByTestId('yearbook-line-unexplained')).toBeNull();
  });

  it('labels an inferred line as inferred and an observed line as a record (§37)', async () => {
    await render(<YearbookScreen />);
    expect(await screen.findByText('Night Explorer emerged')).toBeTruthy();

    // The DNA line carries the Inferred pill…
    expect(screen.getByTestId('yearbook-inferred-dna-trait:night_explorer')).toBeTruthy();
    expect(screen.getByText('Inferred')).toBeTruthy();
    expect(screen.getByText('Inferred from')).toBeTruthy();
    // …and its evidence names both years it compared.
    expect(screen.getByText('• 2025: 2 nightlife visits')).toBeTruthy();
    expect(screen.getByText('• 2024: not enough activity for this trait')).toBeTruthy();

    // …while the record-derived lines are not marked inferred.
    expect(screen.queryByTestId('yearbook-inferred-places')).toBeNull();
    expect(screen.queryByTestId('yearbook-inferred-journey:trip-vn')).toBeNull();
    expect(screen.getAllByText('From your records').length).toBe(3);
  });

  it('does not mark an observed line inferred even when the year has DNA lines', async () => {
    await render(<YearbookScreen />);
    await screen.findByText('Reached 5 stamps');
    // Exactly one Inferred pill in a year with three observed lines + one DNA line.
    expect(screen.getAllByText('Inferred').length).toBe(1);
  });
});

// ── 3 + 4. Honest empty states ───────────────────────────────────────────────

describe('YearbookScreen — empty states are honest', () => {
  it('renders an empty year with its own message and no fabricated summary', async () => {
    await render(<YearbookScreen />);
    expect(await screen.findByTestId('yearbook-year-2024')).toBeTruthy();
    expect(screen.getByTestId('yearbook-empty-2024')).toBeTruthy();
    expect(screen.getByText('Nothing recorded for 2024.')).toBeTruthy();
    // The 2024 card shows zeroed counts, never a borrowed number from 2025.
    expect(screen.getByText('0 journeys · 0 stamps · 0 memories')).toBeTruthy();
  });

  it('renders the honest empty state for a traveller with no history at all', async () => {
    mockGetYearbook.mockResolvedValue({ ok: true, data: { yearbook: emptyYearbook(), restricted: false } });
    await render(<YearbookScreen />);
    expect(await screen.findByTestId('yearbook-empty')).toBeTruthy();
    expect(screen.getByText('No yearbook yet')).toBeTruthy();
    expect(
      screen.getByText(
        'No travel recorded yet. Your yearbook fills in as you take trips, earn stamps and save memories.',
      ),
    ).toBeTruthy();
  });

  it('explains a collection the server could not include instead of under-counting silently', async () => {
    const yb = fullYearbook();
    yb.included = { journeys: true, stamps: false, memories: true, travelDna: true };
    mockGetYearbook.mockResolvedValue({ ok: true, data: { yearbook: yb, restricted: false } });
    await render(<YearbookScreen />);
    const note = await screen.findByTestId('yearbook-included-note');
    expect(note).toBeTruthy();
    expect(screen.getByText(/Not counted here: stamps/)).toBeTruthy();
  });
});

// ── 5 + 6. The screen shows exactly what the server permitted ────────────────

describe('YearbookScreen — renders only the server projection', () => {
  it('shows nothing the projection withheld', async () => {
    const yb = fullYearbook();
    // The server already removed the private trip, the private memory and the
    // blocked companion; the screen must not resurrect any of them.
    mockGetYearbook.mockResolvedValue({ ok: true, data: { yearbook: yb, restricted: false } });
    await render(<YearbookScreen />);
    await screen.findByText('Reached 5 stamps');
    expect(screen.queryByText(/Secret Trip/)).toBeNull();
    expect(screen.queryByText(/Mallory/)).toBeNull();
    expect(screen.queryByText(/Sa Pa/)).toBeNull();
    // Only the places the projection carried are rendered as chips.
    expect(screen.getByText('Da Nang')).toBeTruthy();
    expect(screen.getByText('Hoi An')).toBeTruthy();
  });

  it('asks the server only for the owner (no viewer id is ever sent)', async () => {
    await render(<YearbookScreen />);
    await screen.findByText('Reached 5 stamps');
    expect(mockGetYearbook).toHaveBeenCalledWith(null);
  });

  it('passes a requested year straight through', async () => {
    await render(<YearbookScreen year={2025} />);
    await screen.findByText('Reached 5 stamps');
    expect(mockGetYearbook).toHaveBeenCalledWith(2025);
  });

  it('explains a withheld yearbook rather than showing an error', async () => {
    mockGetYearbook.mockResolvedValue({ ok: true, data: { yearbook: null, restricted: true } });
    await render(<YearbookScreen />);
    expect(await screen.findByText('Yearbooks are private')).toBeTruthy();
    expect(
      screen.getByText('A yearbook is only ever shown to the traveller it belongs to.'),
    ).toBeTruthy();
  });

  it('surfaces a load failure with a retry affordance', async () => {
    mockGetYearbook.mockResolvedValue({ ok: false, message: 'API 500' });
    await render(<YearbookScreen />);
    expect(await screen.findByText("Couldn't load your yearbook")).toBeTruthy();
    expect(screen.getByText('API 500')).toBeTruthy();
    expect(screen.getByText('Tap to retry')).toBeTruthy();
  });
});
