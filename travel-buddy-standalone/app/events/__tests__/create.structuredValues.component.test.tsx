/**
 * Create Event → the title's date, time and size are offered as taps (census-
 * input-intelligence G46, §7 `structured_value`).
 *
 * Driven through the REAL creation-assistance hook and gateway client; only
 * `fetch` is faked. The gateway answers the title with the server's two
 * `structured_value` rows; tapping the time row fills the Date & Time step and
 * tapping the size row fills Capacity — and the title is never touched.
 */
import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

// NOTE: intentionally exhaustive — a fresh create (no draft).
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => ({}),
  usePathname: () => '/events/create',
}));

// NOTE: intentionally exhaustive — requireActual pulls native modules unavailable in jest-expo.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// NOTE: intentionally exhaustive — requireActual would construct the real
// Supabase client, whose auto-refresh timer outlives the test environment.
jest.mock('../../../src/lib/supabase', () => ({
  isSupabaseConfigured: true,
  authedClient: () => null,
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: { access_token: 'tok', expires_at: Math.floor(Date.now() / 1000) + 3600 } } }),
      refreshSession: async () => ({ data: { session: { access_token: 'tok' } } }),
    },
  },
}));

// NOTE: intentionally exhaustive — KeyboardAvoidingView hits native modules.
jest.mock('../../../src/components/ui/KeyboardSafeView', () => ({
  KeyboardSafeScrollView: ({ children }: any) => {
    const { View } = require('react-native');
    return <View>{children}</View>;
  },
}));

// NOTE: intentionally exhaustive — the cover picker needs expo-image-picker's native module.
jest.mock('../../../src/hooks/useMediaPicker.ts', () => ({
  useMediaPicker: () => ({ pickMedia: jest.fn(async () => null), pickerElement: null }),
}));

// The served policy for the field, as the server's registry declares it (event_title admits structured_value).
import { _seedPolicyForTests } from '../../../src/platform/input-assistance/services/policyStore.ts';
_seedPolicyForTests(['event_title'], {
  event_title: { mode: 'free_text_assisted', allowedSuggestionTypes: ['ai_suggestion', 'disambiguation', 'correction', 'structured_value'], entityTypes: ['event'], minChars: 1, offlinePolicy: 'unavailable', privacyClass: 'public' },
});

const TIME = { kind: 'event_time', date: '2030-06-07', startTime: '20:00', endDate: '2030-06-07', endTime: '23:00' };
const SIZE = { kind: 'party_size', count: 6 };
const row = (value: unknown, label: string, subtitle: string) => ({
  id: `event_title:structured_value:${JSON.stringify(value)}`,
  type: 'structured_value', context: 'event_title', label, subtitle,
  action: { type: 'set_structured_value', value }, structuredValue: value,
  source: 'local', confidence: 0.7, policyVersion: 'test-policy-v1',
});

let served: unknown[] = [];
const fetchMock = jest.fn();
let ui: Awaited<ReturnType<typeof render>>;

beforeAll(() => { process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test'; });
beforeEach(() => {
  served = [row(TIME, 'Fri 7 Jun · 8:00 PM – 11:00 PM', 'Set as the date and time'), row(SIZE, '6 people', 'Set as the capacity')];
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string, init?: any) => {
    const u = new URL(url, 'http://api.test');
    if (u.pathname === '/api/input-assistance/suggest') {
      const body = JSON.parse(init?.body ?? '{}');
      const suggestions = body.context === 'event_title' ? served : [];
      return { ok: true, status: 200, json: async () => ({ suggestions, policyVersion: 'test-policy-v1', schemaVersion: 1 }) } as any; // the seeded table's own version, so the store does not read the serve as a newer one
    }
    return { ok: false, status: 404, json: async () => ({ error: 'not_found' }) } as any;
  });
  (globalThis as any).fetch = fetchMock;
});
afterEach(async () => { await act(async () => {}); });

async function openAndType(title: string) {
  const CreateEventScreen = require('../create/index').default;
  ui = await render(<CreateEventScreen />);
  await waitFor(() => expect(ui.getByPlaceholderText('e.g. Sunset hike at Mount Batang')).toBeTruthy());
  await act(async () => { fireEvent.changeText(ui.getByPlaceholderText('e.g. Sunset hike at Mount Batang'), title); });
}

describe('Create Event — structured values typed into the title (G46)', () => {
  it('SV1. the served time and size are shown as taps, and the request carries the device zone', async () => {
    await openAndType('Rooftop drinks Fri 8-11pm for 6 people');
    await waitFor(() => expect(ui.getByText('Fri 7 Jun · 8:00 PM – 11:00 PM')).toBeTruthy());
    expect(ui.getByText('6 people')).toBeTruthy();
    const call = fetchMock.mock.calls.find(([u]) => String(u).includes('/input-assistance/suggest'));
    expect(typeof JSON.parse(call![1].body).tz).toBe('string');
  });

  it('SV2. tapping the time fills the Date & Time step; the title is unchanged', async () => {
    await openAndType('Rooftop drinks Fri 8-11pm for 6 people');
    await waitFor(() => expect(ui.getByTestId('structured-value-event_time')).toBeTruthy());
    await act(async () => { fireEvent.press(ui.getByTestId('structured-value-event_time')); });
    expect(ui.getByDisplayValue('Rooftop drinks Fri 8-11pm for 6 people')).toBeTruthy();
    await act(async () => { fireEvent.press(ui.getByText('Next')); });
    await waitFor(() => expect(ui.getByLabelText(/^Start date: /)).toBeTruthy());
    expect(ui.getByLabelText(/^Start time: /)).toBeTruthy();
  });

  it('SV3. nothing is filled without a tap', async () => {
    await openAndType('Rooftop drinks Fri 8-11pm for 6 people');
    await waitFor(() => expect(ui.getByTestId('structured-value-event_time')).toBeTruthy());
    await act(async () => { fireEvent.press(ui.getByText('Next')); });
    await waitFor(() => expect(ui.getByLabelText('Pick a start date')).toBeTruthy());
    expect(ui.getByLabelText('Pick a start time')).toBeTruthy();
  });

  it('SV4. nothing served (flag OFF) → no chips', async () => {
    served = [];
    await openAndType('Rooftop drinks Fri 8-11pm');
    await act(async () => { await new Promise((r) => setTimeout(r, 400)); });
    expect(ui.queryByTestId('structured-value-chips')).toBeNull();
  });
});
