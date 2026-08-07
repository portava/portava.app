/**
 * Gem detail — Share-to-Telegraph thread-ID modal test.
 *
 * The Share action used iOS-only Alert.prompt (a silent no-op on
 * Android/web). It now uses ReasonPromptModal to collect the thread ID.
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

describe('Gem detail share modal', () => {
  it('shares to a Telegraph thread via the modal with a required thread ID', async () => {
    (useGemDetail as jest.Mock).mockReturnValue({
      gem, savedByMe: false, guideProfile: null,
      loading: false, error: null, refresh: jest.fn(), toggleSave: jest.fn(),
    });
    // Deferred so the share continuation fires outside the act() flush — no overlap.
    mockShare.mockImplementation(() => deferred({}));

    await render(<GemDetailScreen />);
    await waitFor(() => expect(screen.getByText('Share')).toBeTruthy());

    expect(screen.queryByTestId('reason-modal')).toBeNull();

    // Bare press — sync setState; waitFor below confirms modal appears.
    fireEvent.press(screen.getByText('Share'));
    await waitFor(() => expect(screen.getByTestId('reason-modal')).toBeTruthy());

    // Thread ID required — disabled confirm does nothing.
    // Bare press — sync no-op; assert immediately.
    fireEvent.press(screen.getByTestId('reason-confirm-btn'));
    expect(mockShare).not.toHaveBeenCalled();

    // Bare changeText — sync setState; waitFor confirms thread ID committed.
    fireEvent.changeText(screen.getByTestId('reason-input'), 'thread-42');
    await waitFor(() =>
      expect(screen.getByTestId('reason-input').props.value).toBe('thread-42'),
    );

    // Bare press — async submit handler; waitFor below settles the chain.
    fireEvent.press(screen.getByTestId('reason-confirm-btn'));
    await waitFor(() => expect(mockShare).toHaveBeenCalledWith('gem-1', 'thread-42'));
    expect(screen.queryByTestId('reason-modal')).toBeNull();
  });

  it('double-tapping the modal confirm shares exactly once', async () => {
    mockShare.mockClear();
    (useGemDetail as jest.Mock).mockReturnValue({
      gem, savedByMe: false, guideProfile: null,
      loading: false, error: null, refresh: jest.fn(), toggleSave: jest.fn(),
    });
    // Deferred so the share continuation fires outside the act() flush — no overlap.
    mockShare.mockImplementation(() => deferred({}));

    await render(<GemDetailScreen />);
    await waitFor(() => expect(screen.getByText('Share')).toBeTruthy());

    // Bare press — sync setState; waitFor confirms modal appears.
    fireEvent.press(screen.getByText('Share'));
    await waitFor(() => expect(screen.getByTestId('reason-input')).toBeTruthy());

    // Bare changeText — sync setState; waitFor confirms thread ID committed.
    fireEvent.changeText(screen.getByTestId('reason-input'), 'thread-42');
    await waitFor(() =>
      expect(screen.getByTestId('reason-input').props.value).toBe('thread-42'),
    );

    // Fast double-tap before the modal closes — both presses are bare so the
    // in-flight guard (submittingRef) sees the first press before any re-render.
    const btn = screen.getByTestId('reason-confirm-btn');
    fireEvent.press(btn);
    fireEvent.press(btn);

    await waitFor(() => expect(mockShare).toHaveBeenCalledTimes(1));
    expect(mockShare).toHaveBeenCalledWith('gem-1', 'thread-42');
  });
});
