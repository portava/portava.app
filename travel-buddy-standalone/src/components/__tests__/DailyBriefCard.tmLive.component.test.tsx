/**
 * TM-live (WP-11) COMP-F14 — the daily brief's refresh, dismiss and act,
 * through the REAL service layer (src/services/intelligence.ts). Only the
 * network is faked: `fetch` answers by URL, the way the api-server route does.
 *
 *   - a quick action runs POST /daily-brief/actions/:kind and navigates only
 *     on the server's `ok: true`; a refusal says so and does not navigate
 *   - a dismissal leaves the card only once the server recorded it
 *   - a brief whose dismissals could not be applied says so
 *   - an unreadable membership (`denialReason: db_error`) is an error with a
 *     retry, never "only available to accepted trip members"
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test';

// NOTE: intentionally exhaustive — the real Supabase client pulls react-native
// native internals that crash under jest-expo; the service reads only this flag.
jest.mock('../../lib/supabase', () => ({ supabase: {}, isSupabaseConfigured: true }));
jest.mock('../../services/apiToken', () => ({
  ...jest.requireActual('../../services/apiToken'),
  freshToken: jest.fn(async () => 'tok'),
}));

const { router } = require('expo-router');
const { DailyBriefCard } = require('../DailyBriefCard.tsx');

const TRIP = '11111111-2222-4333-8444-555555555555';
type Call = { url: string; method: string };
let calls: Call[] = [];
type Route = (url: string, method: string) => { status: number; body: unknown } | undefined;

function serve(route: Route) {
  (global as any).fetch = jest.fn(async (url: string, init: RequestInit = {}) => {
    const method = (init.method ?? 'GET').toUpperCase();
    calls.push({ url, method });
    const r = route(url, method) ?? { status: 404, body: { error: 'not_found' } };
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
  });
}

const brief = (over: Record<string, unknown> = {}) => ({
  briefType: 'trip', date: '2026-09-29', destination: 'Hoi An', summaryText: 'A calm day',
  generatedAt: Date.now(), isStale: false, dismissalsApplied: true,
  suggestions: [{ id: 'rec_culture', title: 'Old Town walk', category: 'culture', reason: 'x', estimatedTime: '1h', priceLevel: '$' }],
  quickActions: [{ id: 'qa_plan', label: 'View plan', kind: 'view_plan' }, { id: 'qa_telegraph', label: 'Ask Telegraph', kind: 'ask_telegraph' }],
  ...over,
});
const GET_OK = (b = brief()) => ({ status: 200, body: { access: 'full', brief: b } });

beforeEach(() => { calls = []; jest.spyOn(router, 'push').mockImplementation(() => {}); });
afterEach(() => jest.restoreAllMocks());

describe('COMP-F14 daily brief actions', () => {
  it('a quick action is executed on the server and only then navigates', async () => {
    serve((url, method) => {
      if (method === 'GET' && url.includes('/daily-brief')) return GET_OK();
      if (method === 'POST' && url.endsWith('/daily-brief/actions/view_plan')) return { status: 200, body: { ok: true, actionId: 'view_plan', tripId: TRIP, requiresConfirmation: false } };
      return undefined;
    });
    const { findByTestId } = await render(<DailyBriefCard tripId={TRIP} />);
    fireEvent.press(await findByTestId('daily-brief-action-view_plan'));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith(`/trip/${TRIP}`));
    expect(calls.some((c) => c.method === 'POST' && c.url === `http://api.test/api/trips/${TRIP}/daily-brief/actions/view_plan`)).toBe(true);
  });

  it('a refused action says so and does not navigate', async () => {
    serve((url, method) => {
      if (method === 'GET' && url.includes('/daily-brief')) return GET_OK();
      if (method === 'POST' && url.includes('/daily-brief/actions/')) return { status: 403, body: { error: 'not_member' } };
      return undefined;
    });
    const { findByTestId } = await render(<DailyBriefCard tripId={TRIP} />);
    fireEvent.press(await findByTestId('daily-brief-action-view_plan'));
    expect((await findByTestId('daily-brief-note')).props.children).toMatch(/Only accepted trip members/);
    expect(router.push).not.toHaveBeenCalled();
  });
});

describe('COMP-F14 dismiss', () => {
  it('a dismissal the server refused keeps the suggestion and says so', async () => {
    serve((url, method) => {
      if (method === 'GET' && url.includes('/daily-brief')) return GET_OK();
      if (method === 'POST' && url.includes('/daily-brief/dismiss/rec_culture')) return { status: 503, body: { error: 'degraded_unavailable' } };
      return undefined;
    });
    const { findByText, findByTestId, getByText } = await render(<DailyBriefCard tripId={TRIP} />);
    await findByText('Old Town walk');
    fireEvent.press(await findByTestId('feedback-menu-rec_culture'));
    fireEvent.press(await findByText('Dismiss'));
    expect((await findByTestId('daily-brief-note')).props.children).toMatch(/Couldn't dismiss "Old Town walk"/);
    expect(getByText('Old Town walk')).toBeTruthy();
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/daily-brief/dismiss/rec_culture'))).toBe(true);
  });

  it('a recorded dismissal removes it', async () => {
    serve((url, method) => {
      if (method === 'GET' && url.includes('/daily-brief')) return GET_OK();
      if (method === 'POST' && url.includes('/daily-brief/dismiss/rec_culture')) return { status: 200, body: { ok: true, dismissed: 'rec_culture' } };
      return undefined;
    });
    const { findByText, findByTestId, queryByText } = await render(<DailyBriefCard tripId={TRIP} />);
    await findByText('Old Town walk');
    fireEvent.press(await findByTestId('feedback-menu-rec_culture'));
    fireEvent.press(await findByText('Dismiss'));
    await waitFor(() => expect(queryByText('Old Town walk')).toBeNull());
  });

  it('a brief whose dismissals could not be applied says so', async () => {
    serve((url, method) => (method === 'GET' && url.includes('/daily-brief') ? GET_OK(brief({ dismissalsApplied: false })) : undefined));
    const { findByTestId } = await render(<DailyBriefCard tripId={TRIP} />);
    expect(await findByTestId('daily-brief-dismissals-unread')).toBeTruthy();
  });
});

describe('COMP-F14 read honesty', () => {
  it('an unreadable membership is an error with Retry, not "only for accepted members"', async () => {
    serve((url, method) => (method === 'GET' && url.includes('/daily-brief')
      ? { status: 200, body: { access: 'access_denied', denialReason: 'db_error', brief: null } } : undefined));
    const { findByText, queryByText } = await render(<DailyBriefCard tripId={TRIP} />);
    expect(await findByText("Could not load today's brief")).toBeTruthy();
    expect(await findByText('Retry')).toBeTruthy();
    expect(queryByText(/only available to accepted trip members/)).toBeNull();
  });

  it('a genuine non-member still reads as the members-only state', async () => {
    serve((url, method) => (method === 'GET' && url.includes('/daily-brief')
      ? { status: 200, body: { access: 'access_denied', denialReason: 'not_a_member', brief: null } } : undefined));
    const { findByText } = await render(<DailyBriefCard tripId={TRIP} />);
    expect(await findByText(/only available to accepted trip members/)).toBeTruthy();
  });
});
