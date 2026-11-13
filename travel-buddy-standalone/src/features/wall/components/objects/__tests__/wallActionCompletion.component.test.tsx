import React from 'react';
import { Alert } from 'react-native';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react-native';
// NOTE: canonical network seams are deterministic; no real relationship or chat is created.
jest.mock('../../../../../services/follows.ts', () => ({ followUser: jest.fn() }));
jest.mock('../../../../../services/messaging.ts', () => ({ openDirectThread: jest.fn() }));
jest.mock('../../../../../hooks/useSocialVersion.ts', () => ({ bumpSocialVersion: jest.fn() }));
// NOTE: native navigation is replaced at its external boundary.
jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
// NOTE: account changes are controlled independently of live auth.
jest.mock('../../../../../services/discoveryViewerScope.ts', () => ({ ...jest.requireActual('../../../../../services/discoveryViewerScope.ts'), currentDiscoveryScope: () => 'viewer', isCurrentDiscoveryScope: () => true }));
jest.mock('../../../../../platform/input-assistance/hooks/useInputAccountEpoch.ts', () => ({ useInputAccountEpoch: () => 0 }));
import { router } from 'expo-router';
import { followUser } from '../../../../../services/follows.ts';
import { openDirectThread } from '../../../../../services/messaging.ts';
import { bumpSocialVersion } from '../../../../../hooks/useSocialVersion.ts';
import { ContextualActionChips, resolveActionRoute, runWallAction } from '../wallItemShared.tsx';
import { resetWallAnalyticsSink, setWallAnalyticsSink, type WallAnalyticsEvent } from '../../../services/wallAnalytics.ts';
import type { WallProjection } from '../../../types/wallProjection.ts';
const projection: WallProjection = {
  projectionId: 'row', canonicalObjectId: 'post', objectType: 'discovery', discoveryReason: 'Nearby traveler', visibility: 'public', publishedAt: new Date().toISOString(),
  actor: { userId: 'author', displayName: 'Traveler' }, place: { placeId: 'place', name: 'Rooftop', city: 'Da Nang', lat: 16, lng: 108 },
  actions: [{ type: 'follow', label: 'Follow', targetType: 'user', targetId: 'author' }],
};
let events: WallAnalyticsEvent[];
beforeEach(() => { jest.clearAllMocks(); events = []; setWallAnalyticsSink(e => events.push(e)); jest.spyOn(Alert, 'alert').mockImplementation(() => {}); });
afterEach(async () => { await cleanup(); resetWallAnalyticsSink(); jest.restoreAllMocks(); });

it('follows the actual author, then updates the chip and shared social state only after confirmation', async () => {
  let finish!: (value: unknown) => void;
  (followUser as jest.Mock).mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const view = await render(<ContextualActionChips projection={projection} />);
  const pending = fireEvent.press(view.getByLabelText('Follow'));
  expect(followUser).toHaveBeenCalledTimes(1);
  expect(followUser).toHaveBeenCalledWith('author');
  expect(bumpSocialVersion).not.toHaveBeenCalled();
  finish({ ok: true, data: { following: true } });
  await pending;
  await waitFor(() => expect(view.getByLabelText('Following')).toBeTruthy());
  expect(bumpSocialVersion).toHaveBeenCalledTimes(1);
  expect(events.filter(e => e.type === 'wall_follow_from_feed')).toHaveLength(1);
});
it('failed follows show feedback and remain retryable without false follow analytics', async () => {
  (followUser as jest.Mock).mockResolvedValue({ ok: false, message: 'Try later' });
  const view = await render(<ContextualActionChips projection={projection} />);
  await fireEvent.press(view.getByLabelText('Follow'));
  await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Could not follow', 'Try later'));
  expect(bumpSocialVersion).not.toHaveBeenCalled();
  expect(events.some(e => e.type === 'wall_follow_from_feed')).toBe(false);
  await fireEvent.press(view.getByLabelText('Follow'));
  await waitFor(() => expect(followUser).toHaveBeenCalledTimes(2));
});
it('opens the recipient’s canonical direct thread without treating a user ID as a thread ID', async () => {
  (openDirectThread as jest.Mock).mockResolvedValue({ ok: true, data: { threadId: 'thread-123' } });
  expect(await runWallAction({ type: 'message', label: 'Message', targetType: 'user', targetId: 'recipient' }, projection)).toBe(true);
  expect(openDirectThread).toHaveBeenCalledWith('recipient');
  expect(router.push).toHaveBeenCalledWith('/messages/thread-123');
});
it('a departed account or card cannot navigate when delayed thread creation resolves', async () => {
  let current = true; let finish!: (value: unknown) => void;
  (openDirectThread as jest.Mock).mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const pending = runWallAction({ type: 'message', label: 'Message' }, projection, { isCurrent: () => current });
  current = false; finish({ ok: true, data: { threadId: 'old-thread' } });
  expect(await pending).toBe(false);
  expect(router.push).not.toHaveBeenCalled();
  expect(events).toHaveLength(0);
});
it('passes the place to the canonical trip picker without claiming a completed trip addition', async () => {
  const openPlanPicker = jest.fn();
  expect(await runWallAction({ type: 'add_to_trip', label: 'Add to trip', targetType: 'place', targetId: 'place' }, projection, { openPlanPicker })).toBe(true);
  expect(openPlanPicker).toHaveBeenCalledWith({ id: 'place', type: 'place', title: 'Rooftop', city: 'Da Nang', locationName: 'Rooftop', lat: 16, lng: 108 });
  expect(router.push).not.toHaveBeenCalled();
  expect(events.some(e => e.type === 'wall_real_world_outcome')).toBe(false);
});
it('does not attach a different place’s coordinates to an explicit trip target', async () => {
  const openPlanPicker = jest.fn();
  await runWallAction({ type: 'add_to_trip', label: 'Add', params: { placeId: 'other' } }, projection, { openPlanPicker });
  expect(openPlanPicker).toHaveBeenCalledWith({ id: 'other', type: 'place', title: 'Place', city: undefined, locationName: undefined, lat: undefined, lng: undefined });
});
it('preserves the place focus on the map and the specific Buddy on booking handoff', () => {
  const route = resolveActionRoute({ type: 'open_map', label: 'Map' }, projection)!;
  const params = new URLSearchParams(route.split('?')[1]);
  expect(params.get('focusId')).toBe('place'); expect(params.get('lat')).toBe('16'); expect(params.get('lng')).toBe('108');
  expect(resolveActionRoute({ type: 'book_buddy', label: 'Book', targetId: 'buddy-7' }, projection)).toBe('/(rent-a-buddy)/buddy/buddy-7');
});
