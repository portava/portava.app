/**
 * Create Event → the Capacity step no longer offers a join mode the server
 * does not have.
 *
 * THE DEFECT. Capacity asked "How can people join?" — Open RSVP / Request to
 * join / Invite only — and sent the pick as `joinMode`. The server has no join
 * mode: CreateEventSchema (artifacts/api-server/src/routes/events.ts) has no
 * such key, so zod stripped it, and the RSVP gate asks for host approval ONLY
 * when `visibility === 'invite_only'`. A host who chose "Request to join —
 * You approve each attendee" published an open event that anyone could RSVP
 * to. The approval the server does enforce is already offered, truthfully, in
 * the Privacy step ("Invite only — Requires your approval to join"); mapping
 * the Capacity pick onto it would silently overwrite the visibility the host
 * chose there. So the picker is gone, the payload stops carrying the key, and
 * the step points at where approval actually lives.
 *
 * Driven through the REAL screen and the REAL events service; only `fetch` is
 * faked. The screen resumes a draft whose first gap is Capacity.
 *
 * RED on the tree before this change: 2 failed (the picker rendered, and the
 * autosaved draft carried `joinMode: 'open'`).
 */
import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

// NOTE: intentionally exhaustive — resume draft d1.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => ({ draftId: 'd1' }),
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

// NOTE: intentionally exhaustive — the provider fetches /api/feature-flags; the screen reads only isEnabled.
jest.mock('../../../src/context/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ isEnabled: () => false, isLivePlacesEnabled: () => false, loading: false }),
}));

// NOTE: intentionally exhaustive — the cover picker needs expo-image-picker's native module.
jest.mock('../../../src/hooks/useMediaPicker.ts', () => ({
  useMediaPicker: () => ({ pickMedia: jest.fn(async () => null), pickerElement: null }),
}));

const DRAFT = {
  id: 'd1',
  title: 'Rooftop drinks',
  startsAt: '2030-06-07T20:00:00.000Z',
  locationName: 'Rooftop Bar',
  maxAttendees: null,
  chatEnabled: true,
  waitlistEnabled: true,
  updatedAt: '2030-06-01T00:00:00.000Z',
};

const fetchMock = jest.fn();
let ui: Awaited<ReturnType<typeof render>>;

beforeAll(() => { process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test'; });
beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string, init?: any) => {
    const u = new URL(url, 'http://api.test');
    if (u.pathname === '/api/events/drafts/d1' && (!init?.method || init.method === 'GET')) {
      return { ok: true, status: 200, json: async () => DRAFT } as any;
    }
    if (u.pathname === '/api/events/drafts/d1' && init?.method === 'PATCH') {
      return { ok: true, status: 200, json: async () => ({ ...DRAFT, ...JSON.parse(init.body) }) } as any;
    }
    return { ok: false, status: 404, json: async () => ({ error: 'not_found' }) } as any;
  });
  (globalThis as any).fetch = fetchMock;
});
afterEach(async () => { await act(async () => {}); });

describe('Create Event — Capacity offers no join mode the server drops', () => {
  it('the step shows no join-mode picker, and says where approval lives', async () => {
    const CreateEventScreen = require('../create/index').default;
    ui = await render(<CreateEventScreen />);
    await waitFor(() => expect(ui.getByText('Max attendees (optional)')).toBeTruthy());
    expect(ui.queryByText('How can people join?')).toBeNull();
    expect(ui.queryByText('Request to join')).toBeNull();
    expect(ui.queryByText('You approve each attendee')).toBeNull();
    expect(ui.getByTestId('event-create-approval-hint')).toBeTruthy();
  });

  it('leaving the step autosaves a draft whose body carries no `joinMode`', async () => {
    const CreateEventScreen = require('../create/index').default;
    ui = await render(<CreateEventScreen />);
    await waitFor(() => expect(ui.getByText('Max attendees (optional)')).toBeTruthy());
    await act(async () => { fireEvent.press(ui.getByText('Next')); });
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(true));
    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH')!;
    const body = JSON.parse(patch[1].body);
    expect(body.title).toBe('Rooftop drinks'); // vacuity: this is the real autosave body
    expect('joinMode' in body).toBe(false);
  });
});
