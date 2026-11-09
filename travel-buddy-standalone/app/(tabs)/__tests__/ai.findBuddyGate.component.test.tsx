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
import { registerSensingZoneSource } from '../../../src/services/sensing/sensingZoneHint.ts';
import { render, screen, fireEvent } from '@testing-library/react-native';

const mockRab = { enabled: false };
// NOTE: intentionally exhaustive — the flag is the input under test; the real hook fetches /api/feature-flags.
jest.mock('../../../src/hooks/useRentABuddyFlag', () => ({
  useRentABuddyFlag: () => ({ enabled: mockRab.enabled, loading: false }),
}));

const mockPush = jest.fn();
let mockPrefill: string | undefined = 'Who could show me around Da Nang?';
// NOTE: intentionally exhaustive — expo-router needs a NavigationContainer; useFocusEffect runs once on mount.
jest.mock('expo-router', () => {
  const R = jest.requireActual('react');
  return {
    useRouter: () => ({ push: (...a: unknown[]) => mockPush(...a), back: jest.fn(), replace: jest.fn(), canGoBack: () => true }),
    useLocalSearchParams: () => ({ prefillMessage: mockPrefill }),
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
jest.mock('../../../src/components/compass/CompassChatBlocks', () => ({ CompassChatBlocks: () => null, usePlaceNavigation: () => jest.fn() }));
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

beforeEach(() => { mockRab.enabled = false; mockPush.mockClear(); mockPrefill = 'Who could show me around Da Nang?'; });

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


describe('Compass composer', () => {
  it('shows the terminal reply, keeps the conversation on the next send and retries a broken stream in place', async () => {
    mockPrefill = undefined;
    process.env.EXPO_PUBLIC_API_BASE_URL = 'http://test.local';
    process.env.EXPO_PUBLIC_SUPABASE_URL ??= 'https://test.supabase.co';
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ??= 'test-anon-key';
    const service = jest.requireActual('../../../src/services/compass') as typeof import('../../../src/services/compass');
    const { postCompassAskStream } = jest.requireMock('../../../src/services/compass');
    const originalImplementation = postCompassAskStream.getMockImplementation();
    postCompassAskStream.mockImplementation(service.postCompassAskStream);
    registerSensingZoneSource(() => 'u4pruy');
    const turns: Array<{ prompt: string; conversationId?: string; sensingZoneIds?: string[] }> = [];
    service._setTestAuthToken('test-token');
    service._setTestStreamFetch((async (url, init) => {
      expect(url).toBe('http://test.local/api/compass/ask');
      expect(init?.headers).toEqual(expect.objectContaining({ Authorization: 'Bearer test-token' }));
      turns.push(JSON.parse(String(init?.body)));
      const answer = turns.length === 1 ? 'Start near the river.' : 'Return by tram.';
      const frame = turns.length === 2 ? 'data: {"delta":"unfinished"}\n\n' :
        `data: ${JSON.stringify({ done: true, conversationId: 'c-1', message: answer })}\r\n\r\n`;
      return {
        ok: true, headers: { get: () => 'text/event-stream' }, body: null,
        text: async () => frame,
      } as unknown as Response;
    }) as typeof fetch);
    try {
      await render(<AiChat />);
      const field = screen.getByPlaceholderText('Ask about Cebu, your saves, or a plan…');
      await fireEvent.changeText(field, 'Where should I walk?');
      await fireEvent.press(screen.getByLabelText('Send message'));
      expect(await screen.findByText('Start near the river.')).toBeTruthy();
      await fireEvent.changeText(field, 'And how do I return?');
      await fireEvent.press(screen.getByLabelText('Include my approximate area in this Compass reply'));
      await fireEvent(field, 'submitEditing');
      await fireEvent.press(await screen.findByText('Retry'));
      expect(await screen.findByText('Return by tram.')).toBeTruthy();
      expect(screen.getAllByText('And how do I return?')).toHaveLength(1);
      expect(screen.queryByText('Retry')).toBeNull();
      expect(turns.map(({ sensingZoneIds }) => sensingZoneIds)).toEqual([undefined, ['u4pruy'], undefined]);
      expect(turns.map(({ prompt, conversationId }) => [prompt, conversationId])).toEqual([
        ['Where should I walk?', undefined], ['And how do I return?', 'c-1'], ['And how do I return?', 'c-1'],
      ]);
    } finally {
      registerSensingZoneSource(null);
      service._setTestAuthToken(null);
      service._setTestStreamFetch(undefined);
      postCompassAskStream.mockImplementation(originalImplementation);
    }
  });
});
