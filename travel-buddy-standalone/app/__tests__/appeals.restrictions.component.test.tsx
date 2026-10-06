/**
 * appeals.restrictions.component.test.tsx
 *
 * The Appeals screen shows a restricted person what is restricted, for how
 * long, and lets them appeal THAT restriction (OD-TRUST-4; lead ruling D-24;
 * migration 3933). Driven through the REAL appeals service; only `fetch` is
 * faked, plus the session the service reads its bearer token from.
 *
 *  R1 the server's sentence is shown verbatim, with its end ("Until …" / "Until it is reviewed").
 *  R2 a FAILED load says so — it is never shown as "no restrictions".
 *  R3 "Appeal this restriction" files an appeal whose target is that restriction.
 *  R4 an explicit empty list shows no restriction section at all.
 *
 * Run: pnpm --dir travel-buddy-standalone exec jest --runTestsByPath app/__tests__/appeals.restrictions.component.test.tsx
 */

import React from 'react';
import { Alert } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

// NOTE: intentionally exhaustive — requireActual pulls native modules unavailable in jest-expo.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

// NOTE: intentionally exhaustive — requireActual would construct the real
// Supabase client, whose auto-refresh timer outlives the test environment.
jest.mock('../../src/lib/supabase', () => ({
  isSupabaseConfigured: true,
  authedClient: () => null,
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: { access_token: 'tok', expires_at: Math.floor(Date.now() / 1000) + 3600 } } }),
      refreshSession: async () => ({ data: { session: { access_token: 'tok' } } }),
    },
  },
}));

jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { push: jest.fn(), back: jest.fn() },
  useLocalSearchParams: () => ({}),
}));

// NOTE: intentionally exhaustive — the real handler calls Reanimated internals.
jest.mock('../../src/hooks/useNavBarCollapse', () => ({
  useNavBarScrollHandler: () => () => {},
  NavBarFiller: () => null,
}));

// NOTE: intentionally exhaustive — only PlainBottomFiller is used in this screen;
// the real hook reads native inset measurements unavailable in jest.
jest.mock('../../src/hooks/useBottomInset', () => ({
  PlainBottomFiller: () => null,
}));

jest.mock('../../src/components/ui/KeyboardSafeView', () => {
  const R = require('react');
  const RN = require('react-native');
  return {
    ...jest.requireActual('../../src/components/ui/KeyboardSafeView'),
    KeyboardSafeView: ({ children }: { children: React.ReactNode }) => R.createElement(RN.View, null, children),
  };
});

import AppealsScreen from '../appeals';

const HOSTING = 'You cannot host group trips or start or link public Trails. You also cannot be booked as a Buddy.';
const MESSAGING = 'You cannot start new conversations, submit public content (Trail suggestions, gems, community places), or have your posts boosted.';

type Reply = { status: number; body: unknown };
let restrictionsReply: Reply;
let posted: Array<Record<string, unknown>> = [];
const fetchMock = jest.fn();
let alertSpy: jest.SpyInstance;

function toResponse(r: Reply) {
  return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body } as unknown as Response;
}

beforeAll(() => { process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test'; });

beforeEach(() => {
  posted = [];
  restrictionsReply = {
    status: 200,
    body: { restrictions: [
      { id: 'r-host', type: 'hosting', summary: HOSTING, since: '2026-10-01T00:00:00Z', until: '2026-10-14T12:00:00Z', why: { shared: false }, appeal: {} },
      { id: 'r-msg', type: 'messaging', summary: MESSAGING, since: '2026-10-02T00:00:00Z', until: null, why: { shared: false }, appeal: {} },
    ] },
  };
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const u = new URL(url, 'http://api.test'); // the service reads its base URL at import time, so it may be relative here
    if (u.pathname === '/api/appeals/me/restrictions') return toResponse(restrictionsReply);
    if (u.pathname === '/api/appeals/me') return toResponse({ status: 200, body: { appeals: [], page: 1, limit: 20 } });
    if (u.pathname === '/api/appeals' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      posted.push(body);
      return toResponse({ status: 201, body: { id: 'ap-1', targetType: body.targetType, targetId: body.targetId, state: 'submitted', createdAt: '2026-10-06T00:00:00Z' } });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  (globalThis as any).fetch = fetchMock;
  alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});

afterEach(() => alertSpy.mockRestore());

describe('Appeals screen — the person\'s Trust restrictions (OD-TRUST-4)', () => {
  it('R1 shows each restriction\'s sentence verbatim with its end', async () => {
    const ui = await render(<AppealsScreen />);
    await waitFor(() => expect(ui.getByText(HOSTING)).toBeTruthy());
    expect(ui.getByText(MESSAGING)).toBeTruthy();
    expect(ui.getByText('Until it is reviewed')).toBeTruthy();
    expect(ui.getAllByText(/^Until .*2026$/).length).toBe(1);
    expect(ui.getAllByText('Appeal this restriction').length).toBe(2);
  });

  it('R2 a failed load says so, and is never shown as "no restrictions"', async () => {
    restrictionsReply = { status: 503, body: { error: 'degraded_unavailable', message: 'try again' } };
    const ui = await render(<AppealsScreen />);
    await waitFor(() => expect(ui.getByText("We couldn't load your restrictions right now. Please try again shortly.")).toBeTruthy());
    expect(ui.queryByText('Appeal this restriction')).toBeNull();
  });

  it('R3 "Appeal this restriction" files an appeal targeting that restriction', async () => {
    const ui = await render(<AppealsScreen />);
    await waitFor(() => expect(ui.getByText(HOSTING)).toBeTruthy());
    await act(async () => { await fireEvent.press(ui.getAllByText('Appeal this restriction')[0]); });
    await act(async () => {
      await fireEvent.changeText(
        ui.getByPlaceholderText('Explain why you believe this decision was incorrect. Include any relevant context or details.'),
        'This restriction was applied in error.',
      );
    });
    await act(async () => { await fireEvent.press(ui.getByText('Submit Appeal')); });
    await waitFor(() => expect(posted.length).toBe(1));
    expect(posted[0]).toMatchObject({ targetType: 'trust_restriction', targetId: 'r-host' });
  });

  it('R4 an explicit empty list shows no restriction section', async () => {
    restrictionsReply = { status: 200, body: { restrictions: [] } };
    const ui = await render(<AppealsScreen />);
    await waitFor(() => expect(ui.getByText('No appeals yet')).toBeTruthy());
    expect(ui.queryByText('Your restrictions')).toBeNull();
  });
});
