/**
 * Create trip (app/trip/new.tsx) reports the task its Input fields served
 * (§45 / OD-INPUT-1, census G320).
 *
 * Before: the outcome reporter had one caller (the paste-to-Trip write, edit
 * mode). Creating a trip from a destination the `trip.destination` picker served
 * reported nothing, because the screen kept no record of which field served it.
 *
 * Driven through the REAL reporter, the REAL consent gate and a telemetry sink
 * spy, so what is asserted is what would leave the device:
 *
 *   T1  a picked destination + a created trip: one `downstream_task_completed`
 *       (trip.destination, trip_created, ok) and the canonical city credited;
 *   T2  a refused create: ok:false, nothing credited;
 *   T3  a create that throws: ok:false once, nothing credited;
 *   T4  a destination from the description pre-fill was not served: nothing;
 *   T5  without consent: nothing at all;
 *   T6  an accepted AI title still standing at create is reported for
 *       trip.title; one the person rewrote is not.
 *
 * Run with: pnpm --dir travel-buddy-standalone run test:component
 */
import React from 'react';
import { render, fireEvent, screen, act } from '@testing-library/react-native';
import NewTrip from '../../../app/trip/new.tsx';
import { applyOutcomeConsent, beginOutcomeAccount, setOutcomePoster, type TaskOutcomeBody } from '../../platform/input-assistance/services/outcomeLearning.ts';
import { setTelemetrySink, resetTelemetrySink, type InputTelemetryEvent } from '../../platform/input-assistance/services/inputTelemetry.ts';

const CITY = '22222222-2222-4222-8222-222222222222';

// NOTE: intentionally exhaustive — expo-router pulls native navigation internals.
const mockReplace = jest.fn();
jest.mock('expo-router', () => ({
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
    proposals: o.optedIn ? [{
      id: 'ai-1', text: 'Coastal Da Nang', insertText: 'Coastal Da Nang', provenance: 'ai',
      suggestion: { id: 'ai-1', type: 'ai_suggestion', context: 'trip_title', label: 'Coastal Da Nang', source: 'ai', policyVersion: 'test', insertText: 'Coastal Da Nang' },
    }] : [],
    loading: false,
  }),
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
  GlobalCalendarPicker: () => null,
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

let events: InputTelemetryEvent[] = [];
let posts: TaskOutcomeBody[] = [];
const outcomes = () => events.filter((e) => e.name === 'downstream_task_completed');

function consent(granted: boolean) {
  beginOutcomeAccount('user-1');
  if (granted) applyOutcomeConsent('user-1', true);
}

async function fillAndCreate(opts: { pick?: boolean; title?: string } = {}) {
  await render(<NewTrip />);
  await act(async () => { await fireEvent.changeText(screen.getByPlaceholderText('Visayas, June'), opts.title ?? 'Da Nang week'); });
  if (opts.pick !== false) await act(async () => { await fireEvent.press(screen.getByTestId('pick-destination')); });
  await act(async () => { await fireEvent.press(screen.getByText('Create trip')); });
  await act(async () => {});
}

describe('Create trip — the task its Input fields served (G320)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    events = [];
    posts = [];
    setTelemetrySink((e) => { events.push(e); });
    setOutcomePoster(async (b) => { posts.push(b); return true; });
    consent(true);
    mockCreateTrip.mockResolvedValue({ id: 'trip-new' });
  });
  afterEach(() => {
    resetTelemetrySink();
    setOutcomePoster(null);
    beginOutcomeAccount(null);
  });

  it('T1: a picked destination and a created trip — reported once, the canonical city credited', async () => {
    await fillAndCreate();
    expect(mockReplace).toHaveBeenCalledWith('/trip/trip-new');
    expect(outcomes().map((e) => [e.fieldId, e.context, e.props])).toEqual([
      ['trip.destination', 'trip_destination', { task: 'trip_created', ok: true }],
    ]);
    expect(posts).toEqual([{
      context: 'trip_destination', fieldId: 'trip.destination', task: 'trip_created', ok: true,
      entities: [{ entityType: 'city', entityId: CITY }],
    }]);
  });

  it('T2: a refused create is reported ok:false and credits nothing', async () => {
    mockCreateTrip.mockResolvedValue(null);
    await fillAndCreate();
    expect(screen.getByText('Could not create the trip. Try again.')).toBeTruthy();
    expect(outcomes().map((e) => e.props)).toEqual([{ task: 'trip_created', ok: false }]);
    expect(posts).toEqual([]);
  });

  it('T3: a create that throws is reported ok:false once and credits nothing', async () => {
    mockCreateTrip.mockRejectedValue(new Error('Network request failed'));
    await fillAndCreate();
    expect(screen.getByText('Network request failed')).toBeTruthy();
    expect(outcomes().map((e) => e.props)).toEqual([{ task: 'trip_created', ok: false }]);
    expect(posts).toEqual([]);
  });

  it('T4: a destination the description pre-fill supplied was not served by the field — nothing is reported', async () => {
    mockDraftTrip.mockResolvedValue({ draft: { title: 'Da Nang week', destinationCity: 'Da Nang', destinationCountry: 'Vietnam' } });
    await render(<NewTrip />);
    await act(async () => { await fireEvent.changeText(screen.getByTestId('nl-input'), 'A week in Da Nang'); });
    await act(async () => { await fireEvent.press(screen.getByTestId('nl-submit')); });
    await act(async () => { await fireEvent.press(screen.getByText('Create trip')); });
    await act(async () => {});
    expect(mockCreateTrip).toHaveBeenCalledTimes(1);
    expect(outcomes()).toEqual([]);
    expect(posts).toEqual([]);
  });

  it('T5: without outcome-learning consent nothing leaves the device', async () => {
    consent(false);
    await fillAndCreate();
    expect(mockReplace).toHaveBeenCalledWith('/trip/trip-new');
    expect(outcomes()).toEqual([]);
    expect(posts).toEqual([]);
  });

  it('T6: an accepted AI title still standing at create is reported for trip.title; a rewritten one is not', async () => {
    await render(<NewTrip />);
    await act(async () => { await fireEvent.changeText(screen.getByPlaceholderText('Visayas, June'), 'Da'); });
    await act(async () => { await fireEvent.press(screen.getByLabelText('Suggest a trip title with AI')); });
    await act(async () => { await fireEvent.press(screen.getByLabelText('AI suggestion: Coastal Da Nang')); });
    await act(async () => { await fireEvent.press(screen.getByTestId('pick-destination')); });
    await act(async () => { await fireEvent.press(screen.getByText('Create trip')); });
    await act(async () => {});
    expect(outcomes().map((e) => e.fieldId).sort()).toEqual(['trip.destination', 'trip.title']);

    events = [];
    await render(<NewTrip />);
    await act(async () => { await fireEvent.changeText(screen.getAllByPlaceholderText('Visayas, June').at(-1)!, 'Da'); });
    await act(async () => { await fireEvent.press(screen.getAllByLabelText('Suggest a trip title with AI').at(-1)!); });
    await act(async () => { await fireEvent.press(screen.getAllByLabelText('AI suggestion: Coastal Da Nang').at(-1)!); });
    await act(async () => { await fireEvent.changeText(screen.getAllByPlaceholderText('Visayas, June').at(-1)!, 'My own words'); });
    await act(async () => { await fireEvent.press(screen.getAllByText('Create trip').at(-1)!); });
    await act(async () => {});
    expect(outcomes().map((e) => e.fieldId)).toEqual([]);
  });
});

// NOTE: intentionally exhaustive — the AI title button exists only while the server's AI-writing flag is on (it is
// off in production); T6 is about an accepted AI title, so the flag is on here. The gate: TripCreate.aiWritingGate.
// (Appended at the foot — jest.mock is hoisted — so the lines census-input-intelligence.md cites keep their numbers.)
jest.mock('../../context/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ isEnabled: (k: string) => k === 'compass_ai_writing_enabled' }),
}));
