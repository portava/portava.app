/**
 * TM-live (WP-11) TRIP-F19 — regroup and meeting checkpoints, through the
 * REAL service (tripRegroup.ts → features/live/liveApi.ts). Only `fetch` is
 * faked, answering in routes/tripMeetingCheckpoints.ts's and
 * server/trips/readRoutes/tripProjections.ts's (meeting-point) shapes.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

import { TripRegroupCard, arrivalSummary } from '../TripRegroupCard.tsx';
import { _setLiveTestToken } from '../../../live/liveApi.ts';

process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test';
process.env.EXPO_PUBLIC_SUPABASE_URL = 'http://sb.test';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'anon';

const TRIP = '11111111-2222-4333-8444-555555555555';
const CP = '22222222-3333-4444-8555-666666666666';
const CHECKPOINT = {
  id: CP, tripId: TRIP, subgroupId: null, createdBy: 'u-host', label: 'Dragon Bridge east end', lat: 16.06, lng: 108.22, placeId: null,
  meetAt: null, purpose: 'regroup', status: 'open', explanation: null, createdAt: '2026-09-29T10:00:00Z', closedAt: null,
  participants: [{ userId: 'u-a', arrivalState: 'arrived', arrivedAt: null }, { userId: 'u-b', arrivalState: 'en_route', arrivedAt: null }, { userId: 'u-c', arrivalState: 'pending', arrivedAt: null }],
  pendingCount: 2, arrivedCount: 1,
};

type Ans = { status: number; body: unknown };
type Call = { method: string; path: string; body: any };
let calls: Call[] = [];
function serve(route: (method: string, path: string, body: any) => Ans | undefined) {
  (global as any).fetch = jest.fn(async (raw: string, init: RequestInit = {}) => {
    const u = new URL(raw);
    const method = (init.method ?? 'GET').toUpperCase();
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: u.pathname + u.search, body });
    const a = route(method, u.pathname + u.search, body) ?? { status: 404, body: { error: 'not_found' } };
    return { ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => a.body };
  });
}
const LIST = (checkpoints: unknown[]) => ({ status: 200, body: { tripId: TRIP, status: 'open', checkpoints, prioritySwitch: 'x' } });
const listPath = `/api/trips/${TRIP}/meeting-checkpoints?status=open`;

beforeEach(() => { calls = []; _setLiveTestToken(async () => 'tok'); });
afterEach(() => _setLiveTestToken(null));

describe('TRIP-F19 TripRegroupCard', () => {
  it('lists the open checkpoint with the crew\'s arrival states, without naming anyone', async () => {
    serve((m, p) => (m === 'GET' && p === listPath ? LIST([CHECKPOINT]) : undefined));
    const { findByTestId } = await render(<TripRegroupCard tripId={TRIP} />);
    expect((await findByTestId(`trip-checkpoint-${CP}-states`)).props.children).toBe('1 arrived · 1 on the way · 1 not yet');
    expect(arrivalSummary({ ...CHECKPOINT, participants: [] })).toBe('No one is listed for this checkpoint.');
  });

  it('marking myself arrived is a kernel write; the list is re-read after the server confirms', async () => {
    serve((m, p) => {
      if (m === 'GET' && p === listPath) return LIST([CHECKPOINT]);
      if (m === 'POST' && p === `/api/trips/${TRIP}/meeting-checkpoints/${CP}/arrival`) return { status: 200, body: { ok: true, checkpointId: CP, arrival: {}, kernel: { version: 3, eventId: 'e', duplicate: false } } };
      return undefined;
    });
    const { findByTestId, getByTestId } = await render(<TripRegroupCard tripId={TRIP} />);
    fireEvent.press(await findByTestId(`trip-checkpoint-${CP}-arrived`));
    await waitFor(() => expect(getByTestId('trip-regroup-note').props.children).toBe('Marked you as arrived.'));
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.body.arrivalState).toBe('arrived');
    expect(typeof post.body.idempotencyKey).toBe('string');
    await waitFor(() => expect(calls.filter((c) => c.method === 'GET').length).toBe(2));
  });

  it('with the kernel off the arrival is "not written", by name; a retry reuses the same idempotency key', async () => {
    serve((m, p) => {
      if (m === 'GET' && p === listPath) return LIST([CHECKPOINT]);
      if (m === 'POST') return { status: 503, body: { ok: false, error: 'degraded_unavailable', reason: 'TRIP_KERNEL_UNAVAILABLE', detail: 'trip_kernel_enabled is off' } };
      return undefined;
    });
    const { findByTestId, getByTestId } = await render(<TripRegroupCard tripId={TRIP} />);
    fireEvent.press(await findByTestId(`trip-checkpoint-${CP}-en_route`));
    await waitFor(() => expect(getByTestId('trip-regroup-note').props.children).toMatch(/^Not written: regroups are recorded only through the trip kernel/));
    fireEvent.press(getByTestId(`trip-checkpoint-${CP}-en_route`));
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST').length).toBe(2));
    const [a, b] = calls.filter((c) => c.method === 'POST');
    expect(b.body.idempotencyKey).toBe(a.body.idempotencyKey);
    expect(calls.filter((c) => c.method === 'GET').length).toBe(1);
  });

  it('closing as someone who may not is refused by name', async () => {
    serve((m, p) => {
      if (m === 'GET' && p === listPath) return LIST([CHECKPOINT]);
      if (m === 'POST' && p.endsWith('/close')) return { status: 403, body: { ok: false, error: 'forbidden', reason: 'TRIP_AUTH_NOT_HOST', detail: null } };
      return undefined;
    });
    const { findByTestId, getByTestId } = await render(<TripRegroupCard tripId={TRIP} />);
    fireEvent.press(await findByTestId(`trip-checkpoint-${CP}-met`));
    await waitFor(() => expect(getByTestId('trip-regroup-note').props.children).toBe('Only the person who called it, or the trip host, can close it.'));
    expect(calls.find((c) => c.method === 'POST')!.body.outcome).toBe('met');
  });

  it('a failed checkpoint read is "couldn\'t load" with Try again — never "no open checkpoints"', async () => {
    let down = true;
    serve((m, p) => (m === 'GET' && p === listPath ? (down ? { status: 503, body: { error: 'degraded_unavailable', reason: 'TRIP_PROJECTION_UNAVAILABLE', message: 'read failed' } } : LIST([])) : undefined));
    const { findByTestId, queryByTestId, getByTestId } = await render(<TripRegroupCard tripId={TRIP} />);
    expect(await findByTestId('trip-regroup-failed')).toBeTruthy();
    expect(queryByTestId('trip-regroup-none')).toBeNull();
    down = false;
    fireEvent.press(getByTestId('trip-regroup-retry'));
    expect(await findByTestId('trip-regroup-none')).toBeTruthy();
  });

  it('"Where should we meet?" shows the §14.3 answer; "Regroup here" calls the regroup for that place', async () => {
    serve((m, p) => {
      if (m === 'GET' && p === listPath) return LIST([]);
      if (m === 'POST' && p === `/api/trips/${TRIP}/meeting-point`) {
        return { status: 200, body: { tripId: TRIP, sourceTripVersion: 4, unread: [], candidatesConsidered: 3, meetingPoint: { recommended: { candidateId: 'saved:9', name: 'Han Market', primitive: 'x', groupBurdenMinutes: 31, longestJourneyMinutes: 14, journeys: [], refusals: [], explanation: ['closest for everyone'] }, alternatives: [], refused: [], unplaced: [{ userId: 'u-c', reason: 'no_position' }], constraintsApplied: [], explanation: [] } } };
      }
      if (m === 'POST' && p === `/api/trips/${TRIP}/regroup`) return { status: 201, body: { ok: true, tripId: TRIP, checkpoint: { id: CP }, kernel: { version: 5, eventId: 'e', duplicate: false }, meetingPoint: {}, prioritySwitch: 'x' } };
      return undefined;
    });
    const { findByTestId, getByText, getByTestId } = await render(<TripRegroupCard tripId={TRIP} />);
    fireEvent.press(await findByTestId('trip-meeting-point-ask'));
    await findByTestId('trip-meeting-point');
    expect(getByText('Meet at Han Market')).toBeTruthy();
    expect(getByText("1 of the crew couldn't be placed (no shared location).")).toBeTruthy();
    fireEvent.press(getByTestId('trip-regroup-here'));
    await waitFor(() => expect(getByTestId('trip-regroup-note').props.children).toBe('Regroup called at Han Market.'));
    expect(calls.find((c) => c.path === `/api/trips/${TRIP}/regroup`)!.body).toMatchObject({ candidateId: 'saved:9' });
  });

  it('off in this build renders nothing', async () => {
    serve(() => ({ status: 404, body: { error: 'feature_disabled', message: 'off' } }));
    const { toJSON } = await render(<TripRegroupCard tripId={TRIP} />);
    await waitFor(() => expect(toJSON()).toBeNull());
  });
});
