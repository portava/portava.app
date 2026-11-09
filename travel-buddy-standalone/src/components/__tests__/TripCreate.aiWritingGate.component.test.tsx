/**
 * Create trip — "Suggest with AI" is offered only while it can answer, and an empty answer says so.
 *
 * On the owner's iPhone (2026-10-22) the AI title button was on screen while `compass_ai_writing_enabled` is OFF in
 * production: tapping it opted in, the gateway returned no AI rows, `AiWritingAssist` rendered nothing (its §38
 * degrade) and the control simply vanished — "fill with AI doesn't work". Now:
 *   G1  flag OFF → no AI title button at all;
 *   G2  flag ON, the gateway answers nothing (provider down) → "No AI suggestion right now." as the Compass tab says;
 *   G3  flag ON with an answer → the proposal is offered (the path T6 in TripCreate.taskOutcome relies on).
 *
 * Mocks are TripCreate.taskOutcome.component.test.tsx's, with the flag and the gateway's answer switchable.
 */
import React from 'react';
import { waitFor, render, fireEvent, screen, act } from '@testing-library/react-native';
import NewTrip from '../../../app/trip/new.tsx';

let mockAiWritingOn = false;
let mockAiAnswers = false;

import { _seedPolicyForTests, sharedPolicyStore } from '../../platform/input-assistance/services/policyStore.ts';
import type { SuggestRequest } from '../../platform/input-assistance/types/inputSuggestion.ts';
let mockRefocus: (() => void | (() => void)) | undefined;
let mockBlur: void | (() => void);
let mockTripWindow = { start: '2027-01-12', end: '2027-01-15' };
const mockTitleGateway = jest.fn(async (_req: SuggestRequest) => ({
  ok: true, requestId: 'dates', policyVersion: 'test', suggestions: [],
}));
// NOTE: only the gateway transport is replaced. The mounted form uses its actual field policy, date controls and debounce.
jest.mock('../../platform/input-assistance/services/inputAssistance.ts', () => ({
  ...jest.requireActual('../../platform/input-assistance/services/inputAssistance.ts'),
  requestSuggestions: (req: SuggestRequest) => mockTitleGateway(req),
}));
const CITY = '22222222-2222-4222-8222-222222222222';

// NOTE: intentionally exhaustive — expo-router pulls native navigation internals.
const mockReplace = jest.fn();
jest.mock('expo-router', () => ({
  useFocusEffect: (effect: () => void | (() => void)) => require('react').useEffect(() => {
    mockRefocus = effect;
    mockBlur = effect();
    return () => { if (mockBlur) mockBlur(); };
  }, [effect]),
  router: { replace: (...a: unknown[]) => mockReplace(...a), push: jest.fn(), back: jest.fn() },
}));

// NOTE: intentionally exhaustive — react-native-safe-area-context has native internals.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// NOTE: intentionally exhaustive — SessionContext uses supabase internals.
jest.mock('../../context/SessionContext', () => ({
  useSession: () => ({ configured: true, isAuthed: true, userId: 'user-1' }),
}));

// NOTE: intentionally exhaustive — StampEarnedToast has async native deps.
jest.mock('../../components/stamps/StampEarnedToast', () => ({
  useStampToast: () => ({ checkForNewStamps: jest.fn() }),
}));

// NOTE: intentionally exhaustive — tripIntel imports apiToken/supabase native deps.
const mockDraftTrip = jest.fn();
jest.mock('../../services/tripIntel', () => ({
  draftTripFromText: (...a: unknown[]) => mockDraftTrip(...a),
}));

// NOTE: intentionally exhaustive — trips imports supabase + apiToken native deps.
const mockCreateTrip = jest.fn();
jest.mock('../../services/trips', () => ({
  createTrip: (...a: unknown[]) => mockCreateTrip(...a),
}));

// NOTE: intentionally exhaustive — tripDestinations imports apiToken native deps.
jest.mock('../../services/tripDestinations', () => ({
  addDestination: jest.fn(),
  reorderDestinations: jest.fn(),
}));

// NOTE: intentionally exhaustive — the AI title hook calls the gateway; here it
// answers one proposal once the person opts in, as the gateway would.
jest.mock('../../hooks/useAiWritingAssist.ts', () => ({
  useAiWritingAssist: (o: { optedIn: boolean }) => ({
    proposals: o.optedIn && mockAiAnswers ? [{
      id: 'ai-1', text: 'Coastal Da Nang', insertText: 'Coastal Da Nang', provenance: 'ai',
      suggestion: { id: 'ai-1', type: 'ai_suggestion', context: 'trip_title', label: 'Coastal Da Nang', source: 'ai', policyVersion: 'test', insertText: 'Coastal Da Nang' },
    }] : [],
    loading: false,
  }),
}));

// NOTE: intentionally exhaustive — the AI title button exists only while the server's AI-writing flag is on (it is
// off in production); T6 is about an accepted AI title, so the flag is on here. The gate: TripCreate.aiWritingGate.
jest.mock('../../context/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ isEnabled: (k: string) => mockAiWritingOn && k === 'compass_ai_writing_enabled' }),
}));

// NOTE: intentionally exhaustive — GlobalPlacePicker pulls expo-location native
// internals. This stand-in does what the real one does on a pick: the canonical
// binding first, then the selection.
jest.mock('../../components/selectors/GlobalPlacePicker', () => {
  const ReactActual = jest.requireActual('react');
  const { Pressable, Text } = jest.requireActual('react-native');
  return {
    GlobalPlacePicker: (p: { onSelect: (x: unknown) => void; onCanonicalBinding?: (b: unknown) => void }) =>
      ReactActual.createElement(Pressable, {
        testID: 'pick-destination',
        onPress: () => {
          p.onCanonicalBinding?.({
            entityType: 'city', entityId: '22222222-2222-4222-8222-222222222222', canonicalId: '22222222-2222-4222-8222-222222222222',
            displayName: 'Da Nang, Vietnam', city: 'Da Nang', country: 'Vietnam', countryCode: 'VN', neighborhood: null,
            lat: 16.0544, lng: 108.2022, timezone: 'Asia/Ho_Chi_Minh', resolved: true,
          });
          p.onSelect({
            id: 'da-nang', type: 'city', name: 'Da Nang', displayName: 'Da Nang, Vietnam', city: 'Da Nang', country: 'Vietnam',
            canonicalId: '22222222-2222-4222-8222-222222222222', source: 'canonical',
          });
        },
      }, ReactActual.createElement(Text, null, 'pick')),
  };
});

// NOTE: intentionally exhaustive — GlobalCalendarPicker pulls calendar native modules.
jest.mock('../../components/selectors/GlobalCalendarPicker', () => ({
  GlobalCalendarPicker: (props: { onConfirm: (dates: { start: string; end: string }) => void }) => {
    const React = require('react');
    const { Pressable } = require('react-native');
    return React.createElement(Pressable, { testID: 'select-test-trip-dates',
      onPress: () => props.onConfirm(mockTripWindow),
    });
  },
}));

// NOTE: intentionally exhaustive — KeyboardSafeScrollView wraps a native scroll view.
jest.mock('../../components/ui/KeyboardSafeView', () => {
  const { ScrollView } = jest.requireActual('react-native');
  return { KeyboardSafeScrollView: ScrollView };
});

// NOTE: intentionally exhaustive — DestinationListEditor pulls its own native deps.
jest.mock('../../components/trip/DestinationListEditor', () => ({
  DestinationListEditor: () => null,
}));

async function typeTitle() {
  await render(<NewTrip />);
  await act(async () => { await fireEvent.changeText(screen.getByPlaceholderText('Visayas, June'), 'Da'); });
}

describe('Create trip — the AI title control', () => {
  beforeEach(() => { mockAiWritingOn = false; mockAiAnswers = false; });

  it('G1: with the AI-writing flag off there is no AI title button', async () => {
    await typeTitle();
    expect(screen.queryByLabelText('Suggest a trip title with AI')).toBeNull();
    expect(screen.queryByText('Suggest with AI')).toBeNull();
  });

  it('G2: flag on but nothing comes back — it says so instead of vanishing', async () => {
    mockAiWritingOn = true;
    await typeTitle();
    await act(async () => { await fireEvent.press(screen.getByLabelText('Suggest a trip title with AI')); });
    expect(screen.getByText('No AI suggestion right now.')).toBeTruthy();
  });

  it('G3: flag on with an answer — the proposal is offered and no "nothing" note shows', async () => {
    mockAiWritingOn = true; mockAiAnswers = true;
    await typeTitle();
    await act(async () => { await fireEvent.press(screen.getByLabelText('Suggest a trip title with AI')); });
    expect(screen.getByLabelText('AI suggestion: Coastal Da Nang')).toBeTruthy();
    expect(screen.queryByText('No AI suggestion right now.')).toBeNull();
  });
});

it('validates a candidate date range once and sends zero title keystrokes to the deterministic gateway', async () => {
  _seedPolicyForTests(['trip_title'], { trip_title: { debounceMs: 0, minChars: 1, privacyClass: 'viewer_scoped' } });
  mockTitleGateway.mockClear();
  try {
    await typeTitle();
    await fireEvent.changeText(screen.getByPlaceholderText('Visayas, June'), 'Weekend getaway');
    expect(mockTitleGateway).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId('select-test-trip-dates'));
    await waitFor(() => expect(mockTitleGateway).toHaveBeenCalledTimes(1));
    expect(mockTitleGateway.mock.calls[0][0]).toMatchObject({
      text: '', context: 'trip_title',
      sessionContext: { startDate: '2027-01-12', endDate: '2027-01-15' },
    });
    await fireEvent.changeText(screen.getByPlaceholderText('Visayas, June'), 'Weekend in Cebu');
    expect(mockTitleGateway).toHaveBeenCalledTimes(1);
    mockTripWindow = { start: '2027-02-08', end: '2027-02-10' };
    await fireEvent.press(screen.getByTestId('select-test-trip-dates'));
    await waitFor(() => expect(mockTitleGateway).toHaveBeenCalledTimes(2));
    expect(mockTitleGateway.mock.calls[1][0].sessionContext).toMatchObject({ startDate: '2027-02-08' });
    await act(async () => { if (mockBlur) mockBlur(); });
    await act(async () => { mockBlur = mockRefocus?.(); });
    await waitFor(() => expect(mockTitleGateway).toHaveBeenCalledTimes(3));
  } finally {
    await act(async () => { sharedPolicyStore.clear(); });
  }
});
