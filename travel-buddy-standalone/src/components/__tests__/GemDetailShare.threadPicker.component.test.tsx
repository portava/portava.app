/**
 * Gem detail — Share to a chat.
 *
 * The Share action first used iOS-only Alert.prompt (a silent no-op on
 * Android/web), then a modal asking for a raw "Thread ID" nobody knows. It now
 * lists the traveller's chats (ThreadPickerSheet) and shares to the one tapped.
 *
 * ## Act strategy
 *
 * All fireEvent calls are bare (no act() wrapper).  Wrapping fireEvent in
 * await act(async () => {}) causes React 19 to schedule concurrent follow-up
 * work after each commit, which overlaps with the next act() scope and
 * produces "overlapping act() calls" warnings.  Bare fireEvent + waitFor
 * avoids this: React batches the state update freely, and waitFor's own
 * internal act() flushes exactly what is needed before the assertion.
 */
import React from 'react';
import { render, waitFor, screen, fireEvent } from '@testing-library/react-native';
import GemDetailScreen from '../../../app/gems/[id].tsx';
import { shareGemToTelegraph } from '../../services/hiddenGems.ts';

jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => ({ back: jest.fn(), push: jest.fn() }),
  useLocalSearchParams: () => ({ id: 'gem-1' }),
}));
jest.mock('react-native-safe-area-context', () => {
  const { View } = require('react-native');
  return {
    SafeAreaView: ({ children }: any) => <View>{children}</View>,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});
// NOTE: intentionally exhaustive — requireActual pulls native-module internals
// that are not safe under jest.
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('expo-location', () => ({}));
jest.mock('../../hooks/useNavBarCollapse', () => ({
  ...jest.requireActual('../../hooks/useNavBarCollapse'),
  NavBarFiller: () => null,
  useNavBarScrollHandler: () => () => {},
}));
jest.mock('../../context/SessionContext', () => ({
  ...jest.requireActual('../../context/SessionContext'),
  useSession: () => ({ isAuthed: true, loading: false }),
}));
// NOTE: intentionally an exhaustive stub — requiring the actual component module
// would execute its heavy/native dependency imports under jest.
jest.mock('../RouteBuilderSheet', () => ({ RouteBuilderSheet: () => null }));
// NOTE: intentionally an exhaustive stub — requiring the actual component module
// would execute its heavy/native dependency imports under jest.
jest.mock('../discovery/TripWishlistPicker', () => ({ TripWishlistPicker: () => null }));
// NOTE: intentionally an exhaustive stub — requiring the actual component module
// would execute its heavy/native dependency imports under jest.
jest.mock('../ReviewsSection', () => ({ ReviewsSection: () => null }));
// NOTE: intentionally an exhaustive stub — requiring the actual component module
// would execute its heavy/native dependency imports under jest.
jest.mock('../discovery/GemMapPreview', () => ({ GemMapPreview: () => null }));
jest.mock('../../hooks/useHiddenGems', () => ({
  ...jest.requireActual('../../hooks/useHiddenGems'),
  useGemDetail: jest.fn(),
  useGemCheckin: () => ({ checkin: jest.fn(), loading: false, result: null }),
  useGemReport: () => ({ report: jest.fn(), loading: false, done: false }),
}));
jest.mock('../../services/messaging', () => ({
  ...jest.requireActual('../../services/messaging'),
  getMyThreads: jest.fn(async () => ({
    ok: true,
    data: {
      threads: [
        { id: 'thread-42', threadType: 'trip', title: 'Split crew', otherMembers: [], archivedAt: null },
        { id: 'thread-7', threadType: 'direct', title: null, otherMembers: [{ id: 'u2', handle: 'ana', name: 'Ana', avatarUrl: null }], archivedAt: null },
        { id: 'thread-old', threadType: 'direct', title: 'Archived', otherMembers: [], archivedAt: '2026-01-01T00:00:00Z' },
      ],
    },
  })),
}));
jest.mock('../../services/hiddenGems', () => ({
  ...jest.requireActual('../../services/hiddenGems'),
  verificationBadge: () => 'Community verified',
  sensitivityLabel: () => 'Public',
  shareGemToTelegraph: jest.fn(),
}));

const { useGemDetail } = require('../../hooks/useHiddenGems.ts');
const mockShare = shareGemToTelegraph as jest.Mock;

/** Defer mock resolution to the next macrotask so continuations fire outside act(). */
const deferred = <T,>(value: T): Promise<T> =>
  new Promise(resolve => setTimeout(() => resolve(value), 0));

const gem = {
  id: 'gem-1', name: 'Secret Cove', category: 'nature',
  neighborhood: null, city: 'Split', country: 'Croatia',
  coordsPrecision: 'exact', lat: 1, lng: 2,
  sensitivityLevel: 'public', verificationLevel: 'community',
  vibeTags: [], saveCount: 3,
  description: null, priceRange: null, bestTimeToGo: null,
  layoverSafe: false, minimumLayoverMinutes: null,
  safetyNotes: null, localEtiquette: null,
};

// Validation runs multiple full jest suites concurrently; the default 5s
// per-test budget flakes under that load (observed repeatedly). Local runs
// finish in <1s — this only widens headroom, it does not mask regressions.
jest.setTimeout(20000);

function mountGem() {
  (useGemDetail as jest.Mock).mockReturnValue({
    gem, savedByMe: false, guideProfile: null,
    loading: false, error: null, refresh: jest.fn(), toggleSave: jest.fn(),
  });
  // Deferred so the share continuation fires outside the act() flush — no overlap.
  mockShare.mockImplementation(() => deferred({}));
  return render(<GemDetailScreen />);
}

describe('Gem detail share to a chat', () => {
  it('lists your chats (not archived ones) and shares to the one tapped', async () => {
    mockShare.mockClear();
    await mountGem();
    await waitFor(() => expect(screen.getByText('Share')).toBeTruthy());
    expect(screen.queryByText('Split crew')).toBeNull();

    // Bare press — sync setState; waitFor confirms the chats are listed.
    fireEvent.press(screen.getByText('Share'));
    await waitFor(() => expect(screen.getByText('Split crew')).toBeTruthy());
    expect(screen.getByText('Ana')).toBeTruthy();
    expect(screen.queryByText('Archived')).toBeNull();
    expect(screen.queryByText(/Thread ID/i)).toBeNull();

    fireEvent.press(screen.getByLabelText('Share to Split crew'));
    await waitFor(() => expect(mockShare).toHaveBeenCalledWith('gem-1', 'thread-42'));
  });

  it('double-tapping a chat shares exactly once', async () => {
    mockShare.mockClear();
    await mountGem();
    await waitFor(() => expect(screen.getByText('Share')).toBeTruthy());

    fireEvent.press(screen.getByText('Share'));
    await waitFor(() => expect(screen.getByText('Split crew')).toBeTruthy());

    // Both presses are bare so the in-flight guard sees the first press before any re-render.
    const row = screen.getByLabelText('Share to Split crew');
    fireEvent.press(row);
    fireEvent.press(row);

    await waitFor(() => expect(mockShare).toHaveBeenCalledTimes(1));
    expect(mockShare).toHaveBeenCalledWith('gem-1', 'thread-42');
  });
});
