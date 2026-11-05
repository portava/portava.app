import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { ConversationContext, currentSharedObjectLink } from '../sharedContext/ConversationContext.tsx';
import { fetchOwnedApi } from '../../../services/ownedApiRequest.ts';
import { resolveShareProjections } from '../sharing/shareApi.ts';

let mockUser = 'viewer';
// NOTE: synthetic authentication and HTTP boundaries keep this fixture off the network.
jest.mock('../../../services/ownedApiRequest.ts', () => ({ fetchOwnedApi: jest.fn() }));
jest.mock('../../../context/SessionContext.tsx', () => ({ useSession: () => ({ userId: mockUser }) }));
jest.mock('../../../services/messagingOwnerRequest.ts', () => ({ captureMessagingOwnerRequest: () => {
  const user = mockUser; let valid = true;
  return { ownerId: user, sessionId: 'session', isCurrent: () => valid && mockUser === user, invalidate: () => { valid = false; } };
} }));
// NOTE: source projection responses are controlled separately from the context read.
jest.mock('../sharing/shareApi.ts', () => ({ resolveShareProjections: jest.fn() }));
// NOTE: focus is mounted by the synthetic renderer, with no real navigation container.
jest.mock('expo-router', () => ({ useFocusEffect: (callback: () => void) => require('react').useEffect(callback, [callback]) }));

const object = { objectType: 'PLAN' as const, objectId: 'plan', title: 'Dinner plan', orderBand: 'UPCOMING' as const, startsAt: '2099-11-05T10:00:00Z', availableActions: [], relationship: 'BOTH_PARTICIPANTS' as const, status: 'active' };
const answer = () => ({ conversationId: 'thread', capabilities: { canCreatePlan: true, canSendMessage: false }, offeredActions: [{ action: 'CREATE_PLAN', capability: 'canCreatePlan' }, { action: 'SHARE_LOCATION', capability: 'canSendMessage' }], degraded: false, inputs: {
  time: { revealed: true, value: { band: 'UPCOMING', nextStartsAt: object.startsAt } }, proximity: { revealed: false, value: null },
  sharedObjects: { revealed: true, value: { incomplete: false, projection: { conversationId: 'thread', generatedAt: '2026-11-05T00:00:00Z', now: [], upcoming: [object], unresolved: [], past: [] } } },
} });
const props = () => ({ threadId: 'thread', expanded: true, onExpanded: jest.fn(), onOpenObject: jest.fn(), actions: { CREATE_PLAN: { label: 'Plan a meetup', run: jest.fn() }, SHARE_LOCATION: { label: 'Share location', run: jest.fn() } } });
beforeEach(() => {
  jest.clearAllMocks(); mockUser = 'viewer';
  jest.mocked(fetchOwnedApi).mockResolvedValue({ ok: true, status: 200, json: async () => answer() });
});

it('does not fetch the context while collapsed', async () => {
  const p = props();
  await render(<ConversationContext {...p} expanded={false} />);
  expect(fetchOwnedApi).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByText('Shared plans & suggestions'));
  expect(p.onExpanded).toHaveBeenCalledWith(true);
});
it('opens revealed shared plans and offers only actions the server permits and the app implements', async () => {
  const p = props();
  await render(<ConversationContext {...p} />);
  await waitFor(() => expect(screen.getByText('Dinner plan')).toBeTruthy());
  expect(screen.queryByText('Share location')).toBeNull();
  await fireEvent.press(screen.getByText('Dinner plan'));
  expect(p.onOpenObject).toHaveBeenCalledWith(object);
  await fireEvent.press(screen.getByText('Plan a meetup'));
  expect(p.actions.CREATE_PLAN.run).toHaveBeenCalledTimes(1);
});
it('never renders a withheld projection even if a stale value accompanies it', async () => {
  const value = answer(); value.inputs.sharedObjects.revealed = false; value.offeredActions = [];
  jest.mocked(fetchOwnedApi).mockResolvedValue({ ok: true, status: 200, json: async () => value });
  await render(<ConversationContext {...props()} />);
  await waitFor(() => expect(screen.getByText('Shared plans are not available right now.')).toBeTruthy());
  expect(screen.queryByText('Dinner plan')).toBeNull();
  expect(screen.queryByText('No shared plans to show yet.')).toBeNull();
});
it('offers retry on failed reads and does not claim an empty conversation', async () => {
  jest.mocked(fetchOwnedApi).mockRejectedValueOnce(new Error('offline'));
  await render(<ConversationContext {...props()} />);
  await waitFor(() => expect(screen.getByText('Retry shared plans')).toBeTruthy());
  expect(screen.queryByText('No shared plans to show yet.')).toBeNull();
  await fireEvent.press(screen.getByText('Retry shared plans'));
  await waitFor(() => expect(screen.getByText('Dinner plan')).toBeTruthy());
});
it('cancels an old account read and cannot display its delayed context', async () => {
  let finish!: (value: any) => void;
  jest.mocked(fetchOwnedApi).mockReturnValueOnce(new Promise(done => { finish = done; }));
  const view = await render(<ConversationContext {...props()} />);
  await waitFor(() => expect(finish).toBeDefined());
  const old = jest.mocked(fetchOwnedApi).mock.calls[0][1]!;
  mockUser = 'other';
  const next = answer(); next.inputs.sharedObjects.value.projection.upcoming = [];
  jest.mocked(fetchOwnedApi).mockResolvedValue({ ok: true, status: 200, json: async () => next });
  await view.rerender(<ConversationContext {...props()} />);
  await act(async () => finish({ ok: true, status: 200, json: async () => answer() }));
  await waitFor(() => expect(screen.getByText('No shared plans to show yet.')).toBeTruthy());
  expect(screen.queryByText('Dinner plan')).toBeNull();
  expect(old.signal?.aborted).toBe(true);
});
it('rechecks source access before opening and rejects a withdrawn or external destination', async () => {
  const result = (available: boolean, link = '/plan/plan') => ({ ok: true as const, data: { threadId: 'thread', unsupported: [], projections: [{ available, objectType: 'PLAN', objectId: 'plan', deepLink: link }] } } as any);
  jest.mocked(resolveShareProjections).mockResolvedValueOnce(result(true)).mockResolvedValueOnce(result(false)).mockResolvedValueOnce(result(true, 'https://elsewhere.test'));
  expect(await currentSharedObjectLink('thread', object)).toBe('/plan/plan');
  await expect(currentSharedObjectLink('thread', object)).rejects.toThrow('no longer available');
  await expect(currentSharedObjectLink('thread', object)).rejects.toThrow('cannot be opened');
});
it('does not navigate after the account changes during the source recheck', async () => {
  let finish!: (value: any) => void;
  jest.mocked(resolveShareProjections).mockReturnValue(new Promise(done => { finish = done; }));
  const link = currentSharedObjectLink('thread', object);
  mockUser = 'other'; finish({ ok: true, data: { projections: [{ available: true, objectType: 'PLAN', objectId: 'plan', deepLink: '/plan/plan' }] } });
  expect(await link).toBeNull();
});
