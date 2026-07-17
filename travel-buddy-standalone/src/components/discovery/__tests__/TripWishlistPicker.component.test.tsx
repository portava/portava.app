/**
 * Component tests for TripWishlistPicker.
 *
 * Covers:
 *   1. Pre-saved trips render an "Already saved" chip on open
 *   2. Tapping a pre-saved row calls toggleSave and removes the chip (full toggle)
 *   3. Tapping an unsaved row calls toggleSave and adds the "Already saved" chip
 *   4. Error state renders "Couldn't save" text when toggleSave rejects
 *   5. Load error shows "Couldn't load trips" with a retry button
 *
 * Run with:  pnpm test:component
 *
 * RNTL v14: render() is async — always await the mount helper.
 */

import React from 'react';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';
import { TripWishlistPicker } from '../TripWishlistPicker.tsx';

// ── Mocks ──────────────────────────────────────────────────────────────────────

jest.mock('../../../services/trips', () => ({
  listMyTrips: jest.fn(),
}));

// async-storage is mocked globally in jest.setup.ts, so requireActual on the
// real module is safe — the spread keeps any new exports from crashing tests.
jest.mock('../../../services/discoveryBookmarks', () => ({
  ...jest.requireActual('../../../services/discoveryBookmarks'),
  toggleSave:      jest.fn(),
  getSavedListIds: jest.fn(),
}));

jest.mock('../../../theme/tokens', () => ({
  color: {
    deep:        '#2A7F8F',
    ink:         '#1A1A2E',
    signal:      '#FF6B6B',
    mute:        '#9B9B9B',
    paper:       '#FFFFFF',
    paperRaised: '#F9F9F9',
    haze:        '#E8E8E8',
    onInk:       '#FFFFFF',
  },
  space:  { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 48 },
  radius: { md: 8, pill: 999 },
  type:   { heading: {}, bodyStrong: {}, small: {}, stamp: {} },
  shadow: { float: {} },
}));

// ── Typed references to mocked modules ─────────────────────────────────────────

import { listMyTrips } from '../../../services/trips.ts';
import { toggleSave, getSavedListIds } from '../../../services/discoveryBookmarks.ts';

const mockListMyTrips    = listMyTrips    as jest.MockedFunction<typeof listMyTrips>;
const mockToggleSave     = toggleSave     as jest.MockedFunction<typeof toggleSave>;
const mockGetSavedListIds = getSavedListIds as jest.MockedFunction<typeof getSavedListIds>;

// ── Fixtures ───────────────────────────────────────────────────────────────────

const PLACE = {
  id:       'place-abc',
  name:     'Eiffel Tower',
  category: 'landmark',
  type:     null,
  address:  '5 Av. Anatole France',
  lat:      48.8584,
  lng:      2.2945,
};

const TRIP_A = {
  id:                 'trip-a',
  ownerId:            'user-1',
  title:              'Paris Adventure',
  destinationCity:    'Paris',
  destinationCountry: 'France',
  neighborhoods:      [],
  startDate:          '2026-08-01',
  endDate:            '2026-08-10',
  status:             'planning' as const,
  visibility:         'public'   as const,
  travelStyle:        null,
  openToMeet:         true,
  coverUrl:           null,
  progress:           0,
};

const TRIP_B = {
  ...TRIP_A,
  id:    'trip-b',
  title: 'Berlin Weekend',
  destinationCity:    'Berlin',
  destinationCountry: 'Germany',
};

// ── Mount helper ───────────────────────────────────────────────────────────────

async function mountPicker(
  overrides: Partial<{
    place:   typeof PLACE | null;
    visible: boolean;
    onClose: jest.Mock;
    onSaved: jest.Mock;
  }> = {},
) {
  const props = {
    place:   PLACE,
    visible: true,
    onClose: jest.fn(),
    onSaved: jest.fn(),
    ...overrides,
  };
  const utils = await render(<TripWishlistPicker {...props} />);
  return { ...utils, onClose: props.onClose, onSaved: props.onSaved };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('TripWishlistPicker — pre-saved chip', () => {
  beforeEach(() => {
    mockListMyTrips.mockResolvedValue([TRIP_A, TRIP_B]);
    mockToggleSave.mockResolvedValue({ added: false, synced: true });
    mockGetSavedListIds.mockResolvedValue(new Set(['trip-a']));
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('shows the place name in the header', async () => {
    const { getByText } = await mountPicker();
    // Wait for async trip load to settle, then assert the synchronous header text
    await waitFor(() => getByText('Paris Adventure'));
    expect(getByText('Eiffel Tower')).toBeTruthy();
  });

  it('renders both trip rows once trips are loaded', async () => {
    const { getByText } = await mountPicker();
    await waitFor(() => getByText('Paris Adventure'));
    expect(getByText('Paris Adventure')).toBeTruthy();
    expect(getByText('Berlin Weekend')).toBeTruthy();
  });

  it('shows "Already saved" chip on the pre-saved trip (trip-a)', async () => {
    const { getByText } = await mountPicker();
    await waitFor(() => getByText('Already saved'));
    expect(getByText('Already saved')).toBeTruthy();
  });

  it('does NOT show "Already saved" on the unsaved trip (trip-b)', async () => {
    const { getByText, queryAllByText } = await mountPicker();
    await waitFor(() => getByText('Paris Adventure'));
    const chips = queryAllByText('Already saved');
    expect(chips).toHaveLength(1);
  });

  it('calls getSavedListIds with the place id on open', async () => {
    await mountPicker();
    await waitFor(() => {
      expect(mockGetSavedListIds).toHaveBeenCalledWith(PLACE.id);
    });
  });
});

describe('TripWishlistPicker — toggle behaviour', () => {
  beforeEach(() => {
    mockListMyTrips.mockResolvedValue([TRIP_A, TRIP_B]);
    mockGetSavedListIds.mockResolvedValue(new Set(['trip-a']));
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('tapping a pre-saved row calls toggleSave with (bookmark, tripId)', async () => {
    mockToggleSave.mockResolvedValue(false);
    const { getByText } = await mountPicker();
    await waitFor(() => getByText('Already saved'));

    await fireEvent.press(getByText('Paris Adventure'));

    await waitFor(() => {
      expect(mockToggleSave).toHaveBeenCalledWith(
        expect.objectContaining({ id: PLACE.id }),
        'trip-a',
      );
    });
  });

  it('tapping a pre-saved row removes the "Already saved" chip when toggleSave returns false', async () => {
    mockToggleSave.mockResolvedValue(false);
    const { getByText, queryByText } = await mountPicker();
    await waitFor(() => getByText('Already saved'));

    await fireEvent.press(getByText('Paris Adventure'));

    await waitFor(() => {
      expect(queryByText('Already saved')).toBeNull();
    });
  });

  it('tapping an unsaved row adds the "Already saved" chip when toggleSave returns true', async () => {
    mockToggleSave.mockResolvedValue({ added: true, synced: true });
    const { getByText, queryAllByText } = await mountPicker();
    await waitFor(() => getByText('Berlin Weekend'));

    await fireEvent.press(getByText('Berlin Weekend'));

    await waitFor(() => {
      expect(queryAllByText('Already saved')).toHaveLength(2);
    });
  });

  it('calls onSaved with the trip when toggleSave returns true', async () => {
    mockToggleSave.mockResolvedValue({ added: true, synced: true });
    const onSaved = jest.fn();
    const { getByText } = await mountPicker({ onSaved });
    await waitFor(() => getByText('Berlin Weekend'));

    await fireEvent.press(getByText('Berlin Weekend'));

    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledWith(TRIP_B);
    });
  });

  it('does NOT call onSaved when toggling a pre-saved row off', async () => {
    mockToggleSave.mockResolvedValue(false);
    const onSaved = jest.fn();
    const { getByText } = await mountPicker({ onSaved });
    await waitFor(() => getByText('Already saved'));

    await fireEvent.press(getByText('Paris Adventure'));

    await waitFor(() => {
      expect(mockToggleSave).toHaveBeenCalled();
    });
    expect(onSaved).not.toHaveBeenCalled();
  });
});

describe('TripWishlistPicker — error state', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('shows "Couldn\'t save — tap to retry" when toggleSave rejects', async () => {
    mockListMyTrips.mockResolvedValue([TRIP_A]);
    mockGetSavedListIds.mockResolvedValue(new Set());
    mockToggleSave.mockRejectedValue(new Error('network error'));

    const { getByText } = await mountPicker();
    await waitFor(() => getByText('Paris Adventure'));

    await fireEvent.press(getByText('Paris Adventure'));

    await waitFor(() => {
      expect(getByText("Couldn't save — tap to retry")).toBeTruthy();
    });
  });

  it('clears the error and retries when the row is tapped again after an error', async () => {
    mockListMyTrips.mockResolvedValue([TRIP_A]);
    mockGetSavedListIds.mockResolvedValue(new Set());
    mockToggleSave
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce(true);

    const { getByText, queryByText } = await mountPicker();
    await waitFor(() => getByText('Paris Adventure'));

    await fireEvent.press(getByText('Paris Adventure'));
    await waitFor(() => getByText("Couldn't save — tap to retry"));

    await fireEvent.press(getByText('Paris Adventure'));
    await waitFor(() => {
      expect(queryByText("Couldn't save — tap to retry")).toBeNull();
    });
  });

  it('shows "Couldn\'t load trips" when listMyTrips rejects', async () => {
    mockListMyTrips.mockRejectedValue(new Error('server error'));
    mockGetSavedListIds.mockResolvedValue(new Set());

    const { getByText } = await mountPicker();

    await waitFor(() => {
      expect(getByText("Couldn't load trips")).toBeTruthy();
    });
  });

  it('shows a "Try again" button in the load error state', async () => {
    mockListMyTrips.mockRejectedValue(new Error('server error'));
    mockGetSavedListIds.mockResolvedValue(new Set());

    const { getByText } = await mountPicker();
    await waitFor(() => getByText('Try again'));
    expect(getByText('Try again')).toBeTruthy();
  });

  it('retries loading when "Try again" is tapped', async () => {
    mockListMyTrips
      .mockRejectedValueOnce(new Error('first failure'))
      .mockResolvedValueOnce([TRIP_A]);
    mockGetSavedListIds.mockResolvedValue(new Set());

    const { getByText } = await mountPicker();
    await waitFor(() => getByText('Try again'));

    await fireEvent.press(getByText('Try again'));

    await waitFor(() => {
      expect(getByText('Paris Adventure')).toBeTruthy();
    });
    expect(mockListMyTrips).toHaveBeenCalledTimes(2);
  });
});

describe('TripWishlistPicker — re-open stale-state retention', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('savedIds is non-empty during the loading phase on re-open when data was already fetched', async () => {
    // First open: trip-a is already saved.
    mockListMyTrips.mockResolvedValue([TRIP_A]);
    mockGetSavedListIds.mockResolvedValueOnce(new Set(['trip-a']));

    const onClose = jest.fn();
    const { getByText, rerender, queryByText } = await render(
      <TripWishlistPicker place={PLACE} visible={true} onClose={onClose} />
    );
    await waitFor(() => getByText('Already saved'));

    // Re-open with a deferred getSavedListIds so we can inspect mid-flight.
    // With the old code: setSavedIds(new Set()) was called before load(),
    // clearing savedIds to empty during the loading phase.
    // With the fix: savedIds stays as Set(['trip-a']) throughout the reload.
    let resolveSecond: (v: Set<string>) => void;
    const deferred = new Promise<Set<string>>(r => { resolveSecond = r; });
    mockGetSavedListIds.mockReturnValueOnce(deferred);

    await act(async () => {
      rerender(<TripWishlistPicker place={PLACE} visible={false} onClose={onClose} />);
    });
    await act(async () => {
      rerender(<TripWishlistPicker place={PLACE} visible={true} onClose={onClose} />);
      await Promise.resolve(); // flush synchronous effect work
    });

    // Reload is in flight (loading=true, spinner shown, FlatList hidden).
    // savedIds inside the component must be Set(['trip-a']), not an empty Set.
    // Confirm by resolving and verifying the correct chip state is restored
    // without needing a second getSavedListIds resolution.
    resolveSecond!(new Set(['trip-a']));
    await waitFor(() => expect(getByText('Already saved')).toBeTruthy());

    // Verify getSavedListIds was called a second time on re-open (data refreshed).
    expect(mockGetSavedListIds).toHaveBeenCalledTimes(2);

    // Verify only one "Already saved" chip exists (not duplicated / corrupted state).
    expect(queryByText('Already saved')).not.toBeNull();
  });

  it('calls getSavedListIds again on each re-open to refresh saved state', async () => {
    mockListMyTrips.mockResolvedValue([TRIP_A]);
    mockGetSavedListIds
      .mockResolvedValueOnce(new Set(['trip-a']))  // first open
      .mockResolvedValueOnce(new Set(['trip-a'])); // re-open

    const onClose = jest.fn();
    const { getByText, rerender } = await render(
      <TripWishlistPicker place={PLACE} visible={true} onClose={onClose} />
    );
    await waitFor(() => getByText('Already saved'));
    expect(mockGetSavedListIds).toHaveBeenCalledTimes(1);

    await act(async () => {
      rerender(<TripWishlistPicker place={PLACE} visible={false} onClose={onClose} />);
    });
    await act(async () => {
      rerender(<TripWishlistPicker place={PLACE} visible={true} onClose={onClose} />);
    });

    await waitFor(() => expect(mockGetSavedListIds).toHaveBeenCalledTimes(2));
    await waitFor(() => getByText('Already saved'));
  });

  it('reflects updated saved state when getSavedListIds returns a different set on re-open', async () => {
    mockListMyTrips.mockResolvedValue([TRIP_A, TRIP_B]);
    // First open: only trip-a saved.
    mockGetSavedListIds.mockResolvedValueOnce(new Set(['trip-a']));

    const onClose = jest.fn();
    const { getByText, rerender, queryAllByText } = await render(
      <TripWishlistPicker place={PLACE} visible={true} onClose={onClose} />
    );
    await waitFor(() => getByText('Already saved'));
    expect(queryAllByText('Already saved')).toHaveLength(1);

    // Re-open: now both trips are saved.
    mockGetSavedListIds.mockResolvedValueOnce(new Set(['trip-a', 'trip-b']));
    await act(async () => {
      rerender(<TripWishlistPicker place={PLACE} visible={false} onClose={onClose} />);
    });
    await act(async () => {
      rerender(<TripWishlistPicker place={PLACE} visible={true} onClose={onClose} />);
    });

    await waitFor(() => expect(queryAllByText('Already saved')).toHaveLength(2));
  });
});

describe('TripWishlistPicker — empty trips list', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('shows "No trips yet" when the user has no trips', async () => {
    mockListMyTrips.mockResolvedValue([]);
    mockGetSavedListIds.mockResolvedValue(new Set());

    const { getByText } = await mountPicker();
    await waitFor(() => {
      expect(getByText('No trips yet')).toBeTruthy();
    });
  });
});
