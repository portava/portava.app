/**
 * Gem detail — Add to Route opens the route it made.
 *
 * Before: the route builder closed on success and nothing else happened, so the
 * traveller had no sign the route existed and no way to it. Discovery and the
 * trip plan open the new route; the gem screen now does the same.
 */
import React from 'react';
import { render, waitFor, screen, fireEvent } from '@testing-library/react-native';
import GemDetailScreen from '../../../app/gems/[id].tsx';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => ({ back: jest.fn(), push: (...a: unknown[]) => mockPush(...a) }),
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
// NOTE: intentional stub — the real sheet builds the route over the network; this one reports a
// created route when it is open, the way the real sheet calls onRouteCreated.
jest.mock('../RouteBuilderSheet', () => {
  const R = jest.requireActual('react');
  const { Pressable, Text } = jest.requireActual('react-native');
  return {
    RouteBuilderSheet: (p: any) => (p.visible
      ? R.createElement(Pressable, { testID: 'mock-route-created', onPress: () => p.onRouteCreated({ plan: { id: 'route-9' } }) },
          R.createElement(Text, null, `stops:${(p.initialStops ?? []).map((s: any) => s.sourceId).join(',')}`))
      : null),
  };
});
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

jest.setTimeout(20000);

describe('Gem detail — Add to Route', () => {
  it('seeds the gem as a stop and opens the created route', async () => {
    (useGemDetail as jest.Mock).mockReturnValue({
      gem, savedByMe: false, guideProfile: null,
      loading: false, error: null, refresh: jest.fn(), toggleSave: jest.fn(),
    });
    await render(<GemDetailScreen />);
    await waitFor(() => expect(screen.getByText('Add to Route')).toBeTruthy());
    expect(screen.queryByTestId('mock-route-created')).toBeNull();
    fireEvent.press(screen.getByText('Add to Route'));
    await waitFor(() => expect(screen.getByText('stops:gem-1')).toBeTruthy());
    fireEvent.press(screen.getByTestId('mock-route-created'));
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/route/route-9'));
    expect(screen.queryByTestId('mock-route-created')).toBeNull();
  });
});
