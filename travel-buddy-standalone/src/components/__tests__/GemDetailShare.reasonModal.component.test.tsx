/**
 * Gem detail — Share-to-Telegraph thread-ID modal test.
 *
 * The Share action used iOS-only Alert.prompt (a silent no-op on
 * Android/web). It now uses ReasonPromptModal to collect the thread ID.
 */
import React from 'react';
import { render, act, waitFor, screen, fireEvent } from '@testing-library/react-native';
import GemDetailScreen from '../../../app/gems/[id].tsx';
import { shareGemToTelegraph } from '../../services/hiddenGems.ts';

jest.mock('expo-router', () => ({
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
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('expo-location', () => ({}));
jest.mock('../../hooks/useNavBarCollapse', () => ({
  NavBarFiller: () => null,
  useNavBarScrollHandler: () => () => {},
}));
jest.mock('../../context/SessionContext', () => ({
  useSession: () => ({ isAuthed: true, loading: false }),
}));
jest.mock('../RouteBuilderSheet', () => ({ RouteBuilderSheet: () => null }));
jest.mock('../discovery/TripWishlistPicker', () => ({ TripWishlistPicker: () => null }));
jest.mock('../ReviewsSection', () => ({ ReviewsSection: () => null }));
jest.mock('../discovery/GemMapPreview', () => ({ GemMapPreview: () => null }));
jest.mock('../../hooks/useHiddenGems', () => ({
  useGemDetail: jest.fn(),
  useGemCheckin: () => ({ checkin: jest.fn(), loading: false, result: null }),
  useGemReport: () => ({ report: jest.fn(), loading: false, done: false }),
}));
jest.mock('../../services/hiddenGems', () => ({
  verificationBadge: () => 'Community verified',
  sensitivityLabel: () => 'Public',
  shareGemToTelegraph: jest.fn(),
}));

const { useGemDetail } = require('../../hooks/useHiddenGems.ts');
const mockShare = shareGemToTelegraph as jest.Mock;

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

describe('Gem detail share modal', () => {
  it('shares to a Telegraph thread via the modal with a required thread ID', async () => {
    (useGemDetail as jest.Mock).mockReturnValue({
      gem, savedByMe: false, guideProfile: null,
      loading: false, error: null, refresh: jest.fn(), toggleSave: jest.fn(),
    });
    mockShare.mockResolvedValue({});

    await act(async () => { render(<GemDetailScreen />); });
    await waitFor(() => expect(screen.getByText('Share')).toBeTruthy());

    expect(screen.queryByTestId('reason-modal')).toBeNull();
    await act(async () => { fireEvent.press(screen.getByText('Share')); });
    expect(screen.getByTestId('reason-modal')).toBeTruthy();

    // Thread ID required
    await act(async () => { fireEvent.press(screen.getByTestId('reason-confirm-btn')); });
    expect(mockShare).not.toHaveBeenCalled();

    await act(async () => { fireEvent.changeText(screen.getByTestId('reason-input'), 'thread-42'); });
    await act(async () => { fireEvent.press(screen.getByTestId('reason-confirm-btn')); });

    await waitFor(() => expect(mockShare).toHaveBeenCalledWith('gem-1', 'thread-42'));
    expect(screen.queryByTestId('reason-modal')).toBeNull();
  });
});
