import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

jest.mock('@supabase/supabase-js', () => ({
  ...jest.requireActual('@supabase/supabase-js'),
  createClient: jest.fn(() => ({})),
}));

jest.mock('../../../lib/supabase.ts', () => ({
  ...jest.requireActual('../../../lib/supabase.ts'),
  isSupabaseConfigured: true,
}));

import { TripHeartbeatCard } from '../TripHeartbeatCard.tsx';
import {
  _setTestAuthToken,
  fetchTripHeartbeat,
  type AutopilotProposal,
  type AutopilotSettings,
  type TripHeartbeat,
} from '../../../services/compass.ts';

const TRIP_ID = '20000000-0000-4000-8000-000000000001';
const API_ORIGIN = 'http://127.0.0.1:9';
const ALL_CLEAR = 'No conflicts or risks detected. Everything looks workable.';
const INCOMPLETE = 'Some trip information could not be read. This check is incomplete.';
const originalFetch = global.fetch;
const originalApiBase = process.env.EXPO_PUBLIC_API_BASE_URL;
const requests: Array<{ path: string; method: string; body: unknown }> = [];
const unexpectedRequests: string[] = [];
let heartbeatBody: { compassEnabled: boolean; heartbeat?: unknown };
let settings: AutopilotSettings;
let proposals: AutopilotProposal[];

function healthyHeartbeat(): TripHeartbeat {
  return {
    status: 'healthy',
    issues: [],
    risks: [],
    pendingProposals: 0,
    itemCounts: { fixed: 0, flexible: 0, optional: 0, total: 0 },
    nextItem: null,
    unreadSources: [],
  };
}

function unreadHeartbeat(source: 'trip_plan_items' | 'trip_autopilot_proposals'): TripHeartbeat {
  return {
    ...healthyHeartbeat(),
    status: 'unknown',
    pendingProposals: null,
    itemCounts: source === 'trip_plan_items' ? null : healthyHeartbeat().itemCounts,
    unreadSources: [source],
  };
}

function findingHeartbeat(status: 'at_risk' | 'attention'): TripHeartbeat {
  return {
    ...healthyHeartbeat(),
    status,
    issues: [{
      type: 'timing_conflict',
      severity: status === 'at_risk' ? 'high' : 'attention',
      itemIds: ['30000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000002'],
      reason: '"Museum" (17:00–18:00) overlaps "Dinner" at 17:30.',
    }],
    risks: [{ type: 'weather', label: 'Rain tomorrow', detail: 'An indoor backup may help.' }],
    pendingProposals: null,
    itemCounts: { fixed: 0, flexible: 2, optional: 0, total: 2 },
    nextItem: {
      id: '30000000-0000-4000-8000-000000000001',
      title: 'Museum',
      startsAt: '2026-08-05T17:00:00Z',
      dayDate: '2026-08-05',
    },
    unreadSources: ['trip_autopilot_proposals'],
  };
}

beforeEach(() => {
  heartbeatBody = { compassEnabled: true, heartbeat: healthyHeartbeat() };
  settings = { enabled: true, allowMoveFlexible: true, allowMoveOptional: true, allowRemoveOptional: false };
  proposals = [];
  requests.length = 0;
  unexpectedRequests.length = 0;
  process.env.EXPO_PUBLIC_API_BASE_URL = API_ORIGIN;
  _setTestAuthToken('heartbeat-test-token');
  global.fetch = jest.fn(async (input: string | URL | Request, options?: RequestInit) => {
    const url = new URL(String(input));
    const method = options?.method ?? 'GET';
    if (url.origin !== API_ORIGIN || new Headers(options?.headers).get('Authorization') !== 'Bearer heartbeat-test-token') {
      unexpectedRequests.push(`${method} ${url}`);
      throw new Error('Unexpected request destination or token');
    }
    const body: unknown = options?.body ? JSON.parse(String(options.body)) : null;
    requests.push({ path: url.pathname, method, body });
    let payload: unknown;
    if (url.pathname === `/api/trips/${TRIP_ID}/heartbeat` && method === 'GET') {
      payload = heartbeatBody;
    } else if (url.pathname === `/api/trips/${TRIP_ID}/autopilot/settings` && method === 'GET') {
      payload = { compassEnabled: true, settings };
    } else if (url.pathname === `/api/trips/${TRIP_ID}/autopilot/settings` && method === 'PUT') {
      settings = { ...settings, ...body as Partial<AutopilotSettings> };
      payload = { compassEnabled: true, settings };
    } else if (url.pathname === `/api/trips/${TRIP_ID}/autopilot/proposals` && method === 'GET') {
      payload = { compassEnabled: true, proposals };
    } else if (url.pathname === `/api/trips/${TRIP_ID}/autopilot/check` && method === 'POST') {
      payload = { compassEnabled: true };
    } else if (['/api/autopilot/proposals/proposal-1/confirm', '/api/autopilot/proposals/proposal-1/decline'].includes(url.pathname) && method === 'POST') {
      proposals = [];
      payload = { applied: method === 'POST' && url.pathname.endsWith('/confirm') ? 1 : 0, blocked: [] };
    } else {
      unexpectedRequests.push(`${method} ${url}`);
      throw new Error('Unexpected heartbeat request');
    }
    return { ok: true, status: 200, json: async () => payload } as Response;
  });
});

afterEach(async () => {
  await cleanup();
  global.fetch = originalFetch;
  _setTestAuthToken(null);
  if (originalApiBase === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL;
  else process.env.EXPO_PUBLIC_API_BASE_URL = originalApiBase;
  expect(unexpectedRequests).toEqual([]);
});

async function mountCard() {
  await render(<TripHeartbeatCard tripId={TRIP_ID} />);
  await waitFor(() => expect(screen.getByTestId('trip-heartbeat-card')).toBeTruthy());
  expect(requests.slice(0, 3)).toEqual([
    { path: `/api/trips/${TRIP_ID}/heartbeat`, method: 'GET', body: null },
    { path: `/api/trips/${TRIP_ID}/autopilot/settings`, method: 'GET', body: null },
    { path: `/api/trips/${TRIP_ID}/autopilot/proposals`, method: 'GET', body: null },
  ]);
}

function expectUnknownReading() {
  expect(screen.queryByText('On track')).toBeNull();
  expect(screen.queryByText(ALL_CLEAR)).toBeNull();
  expect(screen.getByText('Could not check')).toBeTruthy();
  expect(screen.getByTestId('trip-heartbeat-incomplete')).toBeTruthy();
  expect(screen.getByText(INCOMPLETE)).toBeTruthy();
}

describe('TripHeartbeat availability through the real client and mounted card', () => {
  it.each(['trip_plan_items', 'trip_autopilot_proposals'] as const)('keeps canonical %s unknown and nullable through the real service', async (source) => {
    const heartbeat = unreadHeartbeat(source);
    heartbeatBody = { compassEnabled: true, heartbeat };
    expect(await fetchTripHeartbeat(TRIP_ID)).toEqual({ ok: true, compassEnabled: true, heartbeat });
    expect(requests).toEqual([{ path: `/api/trips/${TRIP_ID}/heartbeat`, method: 'GET', body: null }]);
  });

  it.each(['trip_plan_items', 'trip_autopilot_proposals'] as const)('renders canonical %s unread as neutral and incomplete, not healthy', async (source) => {
    heartbeatBody.heartbeat = unreadHeartbeat(source);
    await mountCard();
    expectUnknownReading();
    expect(screen.queryByText(source, { exact: false })).toBeNull();
    expect(screen.getByTestId('trip-heartbeat-check')).toBeTruthy();
  });

  it.each(['at_risk', 'attention'] as const)('retains %s findings beside the incomplete notice', async (status) => {
    heartbeatBody.heartbeat = findingHeartbeat(status);
    await mountCard();
    expect(screen.getByText(status === 'at_risk' ? 'At risk' : 'Needs attention')).toBeTruthy();
    expect(screen.getByText('"Museum" (17:00–18:00) overlaps "Dinner" at 17:30.')).toBeTruthy();
    expect(screen.getByText('Rain tomorrow — An indoor backup may help.')).toBeTruthy();
    expect(screen.getByText(INCOMPLETE)).toBeTruthy();
    expect(screen.queryByText(ALL_CLEAR)).toBeNull();
    expect(screen.queryByText('Could not check')).toBeNull();
  });

  it.each(['at_risk', 'attention'] as const)('preserves a complete %s verdict even without findings', async (status) => {
    heartbeatBody.heartbeat = { ...healthyHeartbeat(), status };
    await mountCard();
    expect(screen.getByText(status === 'at_risk' ? 'At risk' : 'Needs attention')).toBeTruthy();
    expect(screen.queryByText(ALL_CLEAR)).toBeNull();
    expect(screen.queryByTestId('trip-heartbeat-incomplete')).toBeNull();
  });

  it.each(['unknown', 'future_status', ' healthy ', '', null, undefined, 'constructor', '__proto__', { status: 'healthy' }])('never falls back to green for status %p', async (status) => {
    heartbeatBody.heartbeat = { ...healthyHeartbeat(), status };
    await mountCard();
    expectUnknownReading();
  });

  it.each([
    { unreadSources: ['trip_plan_items'] },
    { unreadSources: null },
    { unreadSources: undefined },
    { unreadSources: {} },
    { unreadSources: '' },
    { itemCounts: null },
    { pendingProposals: null },
  ])('does not call a healthy-labelled incomplete response all clear: %p', async (availability) => {
    heartbeatBody.heartbeat = { ...healthyHeartbeat(), ...availability };
    await mountCard();
    expectUnknownReading();
  });

  it('preserves the existing healthy empty message only for a complete reading', async () => {
    await mountCard();
    expect(screen.getByText('On track')).toBeTruthy();
    expect(screen.getByText(ALL_CLEAR)).toBeTruthy();
    expect(screen.queryByTestId('trip-heartbeat-incomplete')).toBeNull();
  });

  it.each(['issues', 'risks'] as const)('does not show all-clear while actual %s remain', async (field) => {
    heartbeatBody.heartbeat = { ...healthyHeartbeat(), [field]: findingHeartbeat('at_risk')[field] };
    await mountCard();
    expect(screen.queryByText(ALL_CLEAR)).toBeNull();
    expect(screen.getByTestId(`trip-heartbeat-${field === 'issues' ? 'issue' : 'risk'}-0`)).toBeTruthy();
  });

  it('refreshes an unread result to healthy using the existing check command', async () => {
    heartbeatBody.heartbeat = unreadHeartbeat('trip_plan_items');
    await mountCard();
    expectUnknownReading();
    heartbeatBody.heartbeat = healthyHeartbeat();
    fireEvent.press(screen.getByTestId('trip-heartbeat-check'));
    await waitFor(() => expect(screen.getByText(ALL_CLEAR)).toBeTruthy());
    expect(screen.queryByTestId('trip-heartbeat-incomplete')).toBeNull();
    expect(requests.filter(({ method }) => method === 'POST')).toEqual([
      { path: `/api/trips/${TRIP_ID}/autopilot/check`, method: 'POST', body: {} },
    ]);
    expect(requests.filter(({ path }) => path.endsWith('/heartbeat'))).toHaveLength(2);
  });

  it.each(['confirm', 'decline'] as const)('retains the explicit proposal %s command when the reading is incomplete', async (action) => {
    heartbeatBody.heartbeat = unreadHeartbeat('trip_plan_items');
    proposals = [{
      id: 'proposal-1', issueType: 'timing_conflict', severity: 'attention', reason: 'Move dinner later.',
      changes: [], status: 'pending', createdAt: '2026-08-05T12:00:00Z', resolvedAt: null,
    }];
    await mountCard();
    expectUnknownReading();
    expect(screen.getByText('Move dinner later.')).toBeTruthy();
    fireEvent.press(screen.getByTestId(`autopilot-${action}-proposal-1`));
    await waitFor(() => expect(screen.queryByTestId('autopilot-proposal-proposal-1')).toBeNull());
    expect(requests.filter(({ method }) => method === 'POST')).toEqual([
      { path: `/api/autopilot/proposals/proposal-1/${action}`, method: 'POST', body: {} },
    ]);
    expectUnknownReading();
  });

  it('retains the existing settings command without changing the unread result', async () => {
    heartbeatBody.heartbeat = unreadHeartbeat('trip_plan_items');
    await mountCard();
    fireEvent.press(screen.getByTestId('autopilot-settings-toggle'));
    await waitFor(() => expect(screen.getByTestId('autopilot-settings-panel')).toBeTruthy());
    fireEvent(screen.getByTestId('autopilot-switch-allowRemoveOptional'), 'valueChange', true);
    await waitFor(() => expect(screen.getByTestId('autopilot-switch-allowRemoveOptional').props.value).toBe(true));
    expect(requests.filter(({ method }) => method === 'PUT')).toEqual([
      { path: `/api/trips/${TRIP_ID}/autopilot/settings`, method: 'PUT', body: { allowRemoveOptional: true } },
    ]);
    expectUnknownReading();
  });

  it('keeps Compass disabled entirely hidden and skips the other reads', async () => {
    heartbeatBody = { compassEnabled: false };
    await render(<TripHeartbeatCard tripId={TRIP_ID} />);
    await waitFor(() => expect(screen.queryByTestId('trip-heartbeat-loading')).toBeNull());
    expect(screen.queryByTestId('trip-heartbeat-card')).toBeNull();
    expect(requests).toEqual([{ path: `/api/trips/${TRIP_ID}/heartbeat`, method: 'GET', body: null }]);
  });

  it('keeps the incomplete health view when Autopilot is off but hides the check command', async () => {
    heartbeatBody.heartbeat = unreadHeartbeat('trip_plan_items');
    settings.enabled = false;
    await mountCard();
    expectUnknownReading();
    expect(screen.getByTestId('autopilot-off-note')).toBeTruthy();
    expect(screen.queryByTestId('trip-heartbeat-check')).toBeNull();
    expect(requests.every(({ method }) => method === 'GET')).toBe(true);
  });
});
