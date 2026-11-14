import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
// NOTE: SDK boundary; session observer, service and panel remain real.
jest.mock('../../../lib/supabase.ts', () => {
  const listeners = new Set();
  return { isSupabaseConfigured: true, supabase: { auth: { listeners, onAuthStateChange: (listener: unknown) => { listeners.add(listener); return { data: { subscription: { unsubscribe: () => listeners.delete(listener) } } }; } } } };
});
// NOTE: unrelated share panel loads native encrypted chat dependencies.
jest.mock('../../../components/ShareSheet.tsx', () => ({ ShareSheet: () => null }));
import { TripChoicePanel, InvitePanel } from '../components/MediaActionPanels.tsx';
import { mapCompiledPlan } from '../services/mediaActions.ts';
import { setDiscoveryViewerFromSession } from '../../../services/discoveryViewerScope.ts';
import { _setTestSupabase, _resetTestSupabase } from '../../../services/apiToken.ts';
import { seedObservedOwnerSession, disposeObservedOwnerSession, observedOwnerAccessToken, emitObservedAuthEvent, observedOwnerSession } from '../../../services/__tests__/observedOwnerSessionFixture.ts';
const plan = mapCompiledPlan({ compiled: { source: { kind: 'trail', id: 'trail-a', title: 'Walk' }, day: '2026-11-05', eligibleTripIds: ['trip-a'], feasibility: 'not_verified', stops: [1, 2].map(i => ({ order: i, sourceType: 'place', sourceId: `place-${i}`, title: `Stop ${i}`, startsAt: '2026-11-05T10:00:00Z', endsAt: '2026-11-05T11:00:00Z', dwellMinutes: 60, transitMinutesBefore: 0, transitBasis: 'none' })) } })!;
const realFetch = globalThis.fetch;
const realBase = process.env.EXPO_PUBLIC_API_BASE_URL;
const response = (body: unknown, status = 200) => ({ ok: status < 300, status, json: async () => body });
function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(done => { resolve = done; }), resolve: (value: T) => resolve(value) }; }
const writes: string[] = [];
let submit: (path: string) => Promise<ReturnType<typeof response>>;
beforeEach(() => {
  writes.length = 0; submit = async () => response({ id: 'added', ok: true });
  setDiscoveryViewerFromSession('owner-a'); seedObservedOwnerSession('owner-a', 'session-a');
  _setTestSupabase({ auth: { getSession: async () => ({ data: { session: { access_token: observedOwnerAccessToken('owner-a', 'session-a'), expires_at: Math.floor(Date.now() / 1000) + 3600 } } }) } } as any);
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test';
  globalThis.fetch = jest.fn(async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (init?.method === 'POST') { writes.push(path); return submit(path) as any; }
    if (path === '/api/me/plan-editable-trips') return response({ trips: [{ id: 'trip-a', title: 'Weekend' }, { id: 'ineligible', title: 'Other' }] }) as any;
    if (path === '/api/users/search') return response({ users: [{ id: 'person-a', displayName: 'Alex' }] }) as any;
    throw new Error('Unexpected request');
  });
});
afterEach(async () => { await act(async () => { disposeObservedOwnerSession(); setDiscoveryViewerFromSession(null); }); _resetTestSupabase(); globalThis.fetch = realFetch; if (realBase === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL; else process.env.EXPO_PUBLIC_API_BASE_URL = realBase; jest.useRealTimers(); });

it('allows eligible trips only and prevents repeat taps while posting', async () => {
  const pending = deferred<ReturnType<typeof response>>(); submit = () => pending.promise;
  const applied = jest.fn(), committed = jest.fn();
  await render(<TripChoicePanel plan={plan} onBack={() => {}} onApplied={applied} onCommitted={committed} />);
  const button = await screen.findByLabelText('Add to Weekend');
  expect(screen.queryByLabelText('Add to Other')).toBeNull();
  await fireEvent.press(button); await fireEvent.press(button);
  expect(writes).toHaveLength(1); expect(committed).not.toHaveBeenCalled();
  await act(async () => { pending.resolve(response({ id: 'added' })); });
  expect(writes).toHaveLength(2); expect(applied).toHaveBeenCalledTimes(1); expect(committed).toHaveBeenCalledTimes(1); expect(committed).toHaveBeenCalledWith('trip-a');
});
it('stops the remaining plan writes and navigation after the chooser closes', async () => {
  const pending = deferred<ReturnType<typeof response>>(); submit = () => pending.promise;
  const applied = jest.fn(), committed = jest.fn(), back = jest.fn();
  await render(<TripChoicePanel plan={plan} onBack={back} onApplied={applied} onCommitted={committed} />);
  await fireEvent.press(await screen.findByLabelText('Add to Weekend'));
  await fireEvent.press(screen.getByLabelText('Back to actions'));
  await act(async () => { pending.resolve(response({ id: 'added' })); });
  expect(writes).toHaveLength(1); expect(applied).not.toHaveBeenCalled(); expect(committed).not.toHaveBeenCalled(); expect(back).toHaveBeenCalledTimes(1);
});
it('stops remaining plan writes and navigation after a new login session', async () => {
  const pending = deferred<ReturnType<typeof response>>(); submit = () => pending.promise;
  const applied = jest.fn(), committed = jest.fn();
  await render(<TripChoicePanel plan={plan} onBack={() => {}} onApplied={applied} onCommitted={committed} />);
  await fireEvent.press(await screen.findByLabelText('Add to Weekend'));
  await act(async () => { emitObservedAuthEvent('SIGNED_IN', observedOwnerSession('owner-a', 'session-b')); pending.resolve(response({ id: 'added' })); });
  expect(writes).toHaveLength(1); expect(applied).not.toHaveBeenCalled(); expect(committed).not.toHaveBeenCalled();
});
it('keeps a partial result visible and offers review instead of replaying accepted stops', async () => {
  submit = async () => writes.length === 1 ? response({ id: 'added' }) : response({ message: 'unavailable' }, 503);
  const applied = jest.fn(), committed = jest.fn();
  await render(<TripChoicePanel plan={plan} onBack={() => {}} onApplied={applied} onCommitted={committed} />);
  const add = await screen.findByLabelText('Add to Weekend');
  await fireEvent.press(add);
  expect(await screen.findByText(/Added 1 of 2 stops/)).toBeTruthy();
  expect(applied).not.toHaveBeenCalled(); expect(committed).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByLabelText('Add to Weekend'));
  expect(writes).toHaveLength(2);
  await fireEvent.press(screen.getByLabelText('Open trip to review stops'));
  expect(applied).toHaveBeenCalledWith('trip-a'); expect(committed).not.toHaveBeenCalled();
});
it('sends one invitation on double tap and does not claim success after dismissal', async () => {
  jest.useFakeTimers();
  const pending = deferred<ReturnType<typeof response>>(); submit = () => pending.promise;
  await render(<InvitePanel momentId="moment-a" mediaId="post-a" onBack={() => {}} />);
  await fireEvent.changeText(screen.getByLabelText('Search travellers to invite'), 'Alex');
  await act(async () => { await jest.advanceTimersByTimeAsync(301); });
  const invite = screen.getByLabelText('Invite Alex');
  await fireEvent.press(invite); await fireEvent.press(invite);
  expect(writes).toHaveLength(1);
  await fireEvent.press(screen.getByLabelText('Back to actions'));
  await act(async () => { pending.resolve(response({ ok: true })); });
  expect(screen.queryByTestId('icon-Check')).toBeNull();
});
