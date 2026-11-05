/**
 * Compass (AI Buddy) — "View place" and "View event" open what the answer showed.
 *
 * Both chips used to open the Discovery or Events tab whatever the answer was
 * about. When the answer's server-checked cards show exactly one place or one
 * event, the chip now opens it (lib/compassActionTarget.ts); otherwise the tab.
 *   V1  one place card → the card's own place opener; one event card → /event/:id;
 *   V2  two places and no event → Discovery and Events, as before.
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';

const mockRab = { enabled: false };
// NOTE: intentionally exhaustive — the flag is the input under test; the real hook fetches /api/feature-flags.
jest.mock('../../../src/hooks/useRentABuddyFlag', () => ({
  useRentABuddyFlag: () => ({ enabled: mockRab.enabled, loading: false }),
}));

const mockPush = jest.fn();
// NOTE: intentionally exhaustive — expo-router needs a NavigationContainer; useFocusEffect runs once on mount.
jest.mock('expo-router', () => {
  const R = jest.requireActual('react');
  return {
    useRouter: () => ({ push: (...a: unknown[]) => mockPush(...a), back: jest.fn(), replace: jest.fn(), canGoBack: () => true }),
    useLocalSearchParams: () => ({ prefillMessage: 'Who could show me around Da Nang?' }),
    useFocusEffect: (cb: () => void) => R.useEffect(cb, []),
  };
});

let mockBlocks: unknown[] = [];
// NOTE: intentionally exhaustive — the four calls the screen makes; the answer carries View place and View event
// chips, and the uiBlocks each test sets.
jest.mock('../../../src/services/compass', () => ({
  postCompassFrontloadEvent: jest.fn(() => Promise.resolve()),
  postCompassAskStream: jest.fn(() => Promise.resolve({
    ok: true,
    data: {
      message: 'Try the An Thuong food streets.',
      quickActions: [{ actionType: 'viewPlace', label: 'View place' }, { actionType: 'viewEvent', label: 'View event' }],
      pendingProposals: [], uiBlocks: mockBlocks, payload: null, conversationId: 'c-1',
    },
  })),
  confirmCompassProposal: jest.fn(),
  declineCompassProposal: jest.fn(),
}));

// NOTE: intentionally exhaustive — the scroll wrapper is a native keyboard-aware view; a plain View stands in.
jest.mock('../../../src/components/ui/KeyboardSafeView', () => {
  const { View } = jest.requireActual('react-native');
  return { KeyboardSafeScrollView: View };
});
// NOTE: intentionally exhaustive — the nav-bar collapse needs the tab bar's animated context.
jest.mock('../../../src/hooks/useNavBarCollapse', () => ({ useNavBarScrollHandler: () => () => undefined, NavBarFiller: () => null }));
const mockOpenPlace = jest.fn();
// NOTE: intentional stub — the cards are not drawn; the place opener is the card's own, observed here.
jest.mock('../../../src/components/compass/CompassChatBlocks', () => ({ CompassChatBlocks: () => null, usePlaceNavigation: () => mockOpenPlace }));
// NOTE: intentional stub — AppHeader chrome is not under test.
jest.mock('../../../src/components/ui/AppHeader', () => ({ AppHeader: () => null }));
// NOTE: intentional stub — the layover sheet is closed.
jest.mock('../../../src/components/layover/LayoverModeSheet', () => ({ LayoverModeSheet: () => null }));
// NOTE: intentionally exhaustive — the plan picker is not opened here.
jest.mock('../../../src/components/PlanPickerController', () => ({ usePlanPicker: () => ({ open: jest.fn() }) }));
// NOTE: intentional stub — Compass Home and the live session read the API; not under test.
jest.mock('../../../src/components/compass/CompassHome', () => ({ CompassHome: () => null }));
// NOTE: intentional stub — Compass Home and the live session read the API; not under test.
jest.mock('../../../src/components/compass/CompassLive', () => ({ CompassLive: () => null }));
// NOTE: intentionally exhaustive — no city is resolved.
jest.mock('../../../src/context/LocationContext', () => ({ useLocationContext: () => ({ resolvedLocation: { place: { city: null } } }) }));
// NOTE: intentionally exhaustive — the AI prompt assist is opt-in and off here.
jest.mock('../../../src/hooks/useAiWritingAssist.ts', () => ({ useAiWritingAssist: () => ({ proposals: [], loading: false }) }));
// NOTE: intentionally exhaustive — no other flag is under test (AI writing off).
jest.mock('../../../src/context/FeatureFlagsContext.tsx', () => ({ useFeatureFlags: () => ({ isEnabled: () => false, loading: false }) }));
// NOTE: intentionally exhaustive — the starters bar serves nothing here.
jest.mock('../../../src/platform/input-assistance/hooks/useInputAssistance.ts', () => ({ useInputAssistance: () => ({ suggestions: [], loading: false }) }));
// NOTE: intentionally exhaustive — the four members the screen imports from the input-assistance barrel.
jest.mock('../../../src/platform/input-assistance', () => ({
  CompassStarters: () => null,
  AiWritingAssist: () => null,
  startersFromSuggestions: () => [],
  COMPASS_FIELD_IDS: { compassPrompt: 'compass.prompt' },
}));

import AiChat from '../ai.tsx';

const PLACE = (id: string) => ({ id, name: id, category: null, neighborhood: null, rating: null, blurb: null, verified: true, lat: 16.05, lng: 108.24 });

beforeEach(() => { mockRab.enabled = false; mockPush.mockClear(); mockOpenPlace.mockClear(); mockBlocks = []; });

describe('Compass — View place / View event', () => {
  it('V1: one place card and one event card are what the chips open', async () => {
    mockBlocks = [
      { type: 'place_cards', places: [PLACE('pl-1')] },
      { type: 'event_cards', events: [{ id: 'ev-9', title: 'Night market', city: null, country: null, startsAt: null, category: null, description: null }] },
    ];
    await render(<AiChat />);
    await fireEvent.press(await screen.findByText('View Place'));
    expect(mockOpenPlace).toHaveBeenCalledWith(expect.objectContaining({ id: 'pl-1' }));
    await fireEvent.press(screen.getByText('View Event'));
    expect(mockPush).toHaveBeenCalledWith('/event/ev-9');
  });

  it('V2: two places and no event fall back to the tabs', async () => {
    mockBlocks = [{ type: 'place_cards', places: [PLACE('a'), PLACE('b')] }];
    await render(<AiChat />);
    await fireEvent.press(await screen.findByText('View Place'));
    expect(mockOpenPlace).not.toHaveBeenCalled();
    expect(mockPush).toHaveBeenCalledWith('/(tabs)/discovery');
    await fireEvent.press(screen.getByText('View Event'));
    expect(mockPush).toHaveBeenCalledWith('/(tabs)/events');
  });
});
