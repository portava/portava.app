/**
 * Compass (AI Buddy) — the "Find Buddy" quick action is drawn only while Rent a Buddy is served.
 *
 * The model may answer with a `findBuddy` quick action; the chip routes to /(rent-a-buddy). With
 * `rent_buddy_enabled` OFF (production, 2026-10-22) that is the layout's COMING SOON gate, so the chip was a dead
 * end on every answer that carried it.
 *   A1  flag off → the answer's other chips, no "Find Buddy";
 *   A2  flag on → "Find Buddy" is drawn and opens /(rent-a-buddy).
 *
 * The answer arrives the way Layover's "Ask locals" hands one in: a `prefillMessage` route param is sent once.
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

// NOTE: intentionally exhaustive — the four calls the screen makes; the answer carries a findBuddy chip and one other.
jest.mock('../../../src/services/compass', () => ({
  postCompassFrontloadEvent: jest.fn(() => Promise.resolve()),
  postCompassAskStream: jest.fn(() => Promise.resolve({
    ok: true,
    data: {
      message: 'A local buddy could show you the An Thuong food streets.',
      quickActions: [{ actionType: 'findBuddy', label: 'Find Buddy' }, { actionType: 'openMap', label: 'Open Map' }],
      pendingProposals: [], uiBlocks: [], payload: null, conversationId: 'c-1',
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
// NOTE: intentionally exhaustive — the chat blocks are empty in this answer.
jest.mock('../../../src/components/compass/CompassChatBlocks', () => ({ CompassChatBlocks: () => null }));
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

beforeEach(() => { mockRab.enabled = false; mockPush.mockClear(); });

describe('Compass — Find Buddy behind rent_buddy_enabled', () => {
  it('A1: flag off → the answer\'s other chips, no "Find Buddy"', async () => {
    await render(<AiChat />);
    expect(await screen.findByText('Open Map')).toBeTruthy();
    expect(screen.queryByText('Find Buddy')).toBeNull();
  });

  it('A2: flag on → "Find Buddy" is drawn and opens /(rent-a-buddy)', async () => {
    mockRab.enabled = true;
    await render(<AiChat />);
    await fireEvent.press(await screen.findByText('Find Buddy'));
    expect(mockPush).toHaveBeenCalledWith('/(rent-a-buddy)');
  });
});
