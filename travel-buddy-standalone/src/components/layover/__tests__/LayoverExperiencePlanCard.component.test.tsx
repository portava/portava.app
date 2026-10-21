/** Real client transport and offline cache; only authentication/network are replaced. */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { LayoverExperiencePlanCard } from '../LayoverExperiencePlanCard.tsx';
import { experienceCacheKey, parseOfflineExperience } from '../../../lib/layoverExperienceCache.ts';
import type { PlanStop } from '../../../services/layover.ts';
// NOTE: intentionally exhaustive — apiToken imports native SecureStore through Supabase;
// requireActual would initialize unavailable native modules. The real experience service runs.
jest.mock('../../../services/apiToken.ts', () => ({ freshToken: jest.fn(async () => 'owner-token') }));
const sid = '11111111-1111-4111-8111-111111111111', stopId = '22222222-2222-4222-8222-222222222222';
const selectedId = '33333333-3333-4333-8333-333333333333', startedId = '44444444-4444-4444-8444-444444444444';
const stop = { id: stopId, stopOrder: 0, durationMin: 30, travelMin: 0 } as PlanStop;
const onChanged = jest.fn();
function plan(phase: 'selected' | 'executing' = 'selected') {
  const base = Date.now(), at = (min: number) => new Date(base + min * 60_000).toISOString(); // one instant: equal deadlines (hardReturnBy = returnBy = returnDeadline) must be byte-equal, or parseOfflineExperience refuses the plan when the clock ticks mid-object
  return { id: phase === 'selected' ? selectedId : startedId, version: phase === 'selected' ? 1 : 2, phase, stopIds: [stopId], createdAt: at(-1),
    contract: { state: 'READY', snapshotId: 'current-snapshot', candidateIds: ['card-1'], insideAirport: true,
      departBy: at(20), estimatedArrival: at(1), leaveActivityBy: at(50), expectedAirportReturn: at(31), hardReturnBy: at(60), expiresAt: at(10),
      riskBand: 'LOW', confidence: 'MEDIUM', minExperienceMinutes: 30, idealExperienceMinutes: 30, returnBufferMinutes: 0,
      fallbackPlan: { beforeDeparture: 'stay_airside', duringExperience: 'remain_airside', returnBy: at(60), returnRoute: null },
      abortThreshold: { leaveBy: at(50), returnDeadline: at(60), conditions: ['snapshot_changed'] }, failureModes: [], reasonCodes: [],
      itinerary: [{ kind: 'experience', startsAt: at(1), endsAt: at(31), mode: null, candidateId: 'card-1' }] } };
}
function transport(read: ReturnType<typeof plan> | null, mutate?: (url: string, input: RequestInit) => Promise<unknown>) {
  const spy = jest.fn(async (url: string, input: RequestInit = {}) => {
    const body = input.method === 'POST' ? await (mutate?.(url, input) ?? Promise.resolve({ ok: true, plan: plan(url.endsWith('/start') ? 'executing' : 'selected') })) : { ok: true, plan: read, usable: !!read, reason: null };
    return { ok: !(body as { reason?: string }).reason, status: (body as { reason?: string }).reason ? 409 : 200, json: async () => body } as Response;
  });
  global.fetch = spy as typeof fetch; return spy;
}
function posts(spy: ReturnType<typeof transport>) { return spy.mock.calls.filter(c => c[1]?.method === 'POST'); }
async function mount(extra: Record<string, unknown> = {}) {
  await render(<LayoverExperiencePlanCard sessionId={sid} stops={[stop]} timezone="UTC" canStart onChanged={onChanged} {...extra} />);
  await waitFor(() => expect(screen.getByText('Your timed experience')).toBeTruthy());
}
beforeEach(async () => { jest.clearAllMocks(); await AsyncStorage.clear(); });
it('selects only after an explicit review action and sends ordered stop identities without client contract JSON', async () => {
  const spy = transport(null); await mount(); expect(posts(spy)).toHaveLength(0);
  expect(screen.queryByText('Start experience')).toBeNull();
  fireEvent.press(screen.getByText('Review timed experience'));
  await waitFor(() => expect(screen.getByText('Start experience')).toBeTruthy());
  const [url, input] = posts(spy)[0]!; expect(url).toContain(`${sid}/experiences/plan/select`);
  expect(JSON.parse(String(input!.body))).toEqual({ requestId: expect.any(String), expectedStopIds: [stopId] });
  expect(posts(spy)).toHaveLength(1); expect(onChanged).toHaveBeenCalledTimes(1);
});
it('saves and reads back the actual return timetable before explicit start, then discloses missing street navigation', async () => {
  const selected = plan(), spy = transport(selected); await mount();
  await waitFor(() => expect(screen.getByText('Start experience')).toBeTruthy()); expect(posts(spy)).toHaveLength(0);
  fireEvent.press(screen.getByText('Start experience'));
  await waitFor(() => expect(screen.getByText('In progress')).toBeTruthy());
  const stored = JSON.parse((await AsyncStorage.getItem(experienceCacheKey(sid)))!); expect(stored.id).toBe(startedId);
  expect(stored.phase).toBe('executing'); expect(stored.contract.hardReturnBy).toBeTruthy();
  expect(JSON.parse(String(posts(spy)[0]![1]!.body))).toEqual({ requestId: expect.any(String), expectedStopIds: [stopId], selectedPlanId: selectedId, confirmed: true });
  expect(screen.getByText(/Street navigation is not saved/)).toBeTruthy(); expect(onChanged).toHaveBeenCalledTimes(1);
});
it('storage failure prevents any start request and is visible', async () => {
  const spy = transport(plan()); await mount(); await waitFor(() => expect(screen.getByText('Start experience')).toBeTruthy());
  jest.mocked(AsyncStorage.setItem).mockRejectedValueOnce(new Error('disk full'));
  fireEvent.press(screen.getByText('Start experience'));
  await waitFor(() => expect(screen.getByText(/Return details could not be saved/)).toBeTruthy());
  expect(posts(spy)).toHaveLength(0); expect(onChanged).not.toHaveBeenCalled();
});
it('a definitive stale refusal is shown and never represented as in progress', async () => {
  const spy = transport(plan(), async () => ({ ok: false, reason: 'snapshot_changed', actionId: startedId })); await mount();
  await waitFor(() => expect(screen.getByText('Start experience')).toBeTruthy()); fireEvent.press(screen.getByText('Start experience'));
  await waitFor(() => expect(screen.getByText(/Your layover conditions changed/)).toBeTruthy());
  expect(screen.queryByText('In progress')).toBeNull(); expect(onChanged).not.toHaveBeenCalled(); expect(posts(spy)).toHaveLength(1);
});
it('expired review disables start without a network mutation', async () => {
  const expired = plan(); expired.contract.expiresAt = new Date(Date.now() - 1000).toISOString();
  const spy = transport(expired); await mount(); await waitFor(() => expect(screen.getByText('Start experience')).toBeTruthy());
  fireEvent.press(screen.getByText('Start experience')); expect(posts(spy)).toHaveLength(0);
  expect(screen.getByText('This plan needs a fresh check before starting.')).toBeTruthy();
});
it('uncertain network outcome retries the same request identity', async () => {
  let attempts = 0;
  const spy = transport(plan(), async () => { if (++attempts === 1) throw new Error('response lost'); return { ok: true, plan: plan('executing') }; });
  await mount(); await waitFor(() => expect(screen.getByText('Start experience')).toBeTruthy());
  fireEvent.press(screen.getByText('Start experience')); await waitFor(() => expect(screen.getByText(/Retry the same action/)).toBeTruthy());
  fireEvent.press(screen.getByText('Start experience')); await waitFor(() => expect(screen.getByText('In progress')).toBeTruthy());
  expect(posts(spy)).toHaveLength(2); expect(posts(spy)[0]![1]!.body).toBe(posts(spy)[1]![1]!.body);
});
it('rapid repeated start presses issue one request', async () => {
  const spy = transport(plan()); await mount(); await waitFor(() => expect(screen.getByText('Start experience')).toBeTruthy());
  const button = screen.getByText('Start experience');
  await fireEvent.press(button); await fireEvent.press(button);
  await waitFor(() => expect(screen.getByText('In progress')).toBeTruthy()); expect(posts(spy)).toHaveLength(1);
});
it('failed cache refresh after a successful start reports execution truth and offers a local save retry', async () => {
  const realSet = AsyncStorage.setItem;
  const spy = transport(plan(), async () => {
    jest.mocked(realSet).mockRejectedValueOnce(new Error('disk changed'));
    return { ok: true, plan: plan('executing') };
  });
  await mount(); await waitFor(() => expect(screen.getByText('Start experience')).toBeTruthy());
  fireEvent.press(screen.getByText('Start experience')); await waitFor(() => expect(screen.getByText('In progress')).toBeTruthy());
  expect(screen.getByText(/updated timetable could not be saved offline/)).toBeTruthy();
  fireEvent.press(screen.getByText('Save timetable offline'));
  await waitFor(() => expect(screen.getByText('Timetable and return deadline saved. Street navigation is not saved.')).toBeTruthy());
  expect(posts(spy)).toHaveLength(1);
});
it('the plan fixture stays one consistent contract when the clock ticks while it is built (CI flake, PR #766)', () => {
  let t = Date.now(); const spy = jest.spyOn(Date, 'now').mockImplementation(() => (t += 1));
  try {
    for (const phase of ['selected', 'executing'] as const) {
      const p = plan(phase);
      expect(p.contract.fallbackPlan.returnBy).toBe(p.contract.hardReturnBy); expect(p.contract.abortThreshold.returnDeadline).toBe(p.contract.hardReturnBy);
      expect(parseOfflineExperience(p)).not.toBeNull();
    }
  } finally { spy.mockRestore(); }
});
