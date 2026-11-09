import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { ConversationTools } from '../ConversationTools.tsx';
import * as api from '../../../../services/messaging.ts';
import { recordSuggestionSelection } from '../../../../platform/input-assistance/services/selectionRecorder.ts';
import { useInputAssistance } from '../../../../platform/input-assistance/hooks/useInputAssistance.ts';
import { router } from 'expo-router';
import { fetchCarryForwardPage } from '../carryForwardApi.ts';

let mockCurrent = true;
let mockUserId = 'me';
const mockOwner = { ownerId: 'me', sessionId: 'session', isCurrent: () => mockCurrent, invalidate: () => {} };
// NOTE: intentionally isolated boundary; the real auth, native storage, routing or API module would start side effects outside this controlled fixture.
jest.mock('../../../../services/messagingOwnerRequest.ts', () => ({ captureMessagingOwnerRequest: () => mockOwner }));
jest.mock('../../../../context/SessionContext.tsx', () => ({ useSession: () => ({ userId: mockUserId }) }));
jest.mock('../../../../services/discoveryViewerScope.ts', () => ({ ...jest.requireActual('../../../../services/discoveryViewerScope.ts'), currentDiscoveryScope: () => ({ viewer: 'u:me', revision: 1 }) }));
jest.mock('../../../../platform/input-assistance/services/selectionRecorder.ts', () => ({ ...jest.requireActual('../../../../platform/input-assistance/services/selectionRecorder.ts'), recordSuggestionSelection: jest.fn() }));
jest.mock('../../../../platform/input-assistance/hooks/useInputAssistance.ts', () => ({ ...jest.requireActual('../../../../platform/input-assistance/hooks/useInputAssistance.ts'), useInputAssistance: jest.fn() }));
// NOTE: intentionally isolated boundary; the real auth, native storage, routing or API module would start side effects outside this controlled fixture.
jest.mock('../../../../services/messaging.ts', () => ({ getMyThreads: jest.fn(), getThreadControls: jest.fn(), formConversationGroup: jest.fn(), forwardThreadMessage: jest.fn(), updateMessageContentCapability: jest.fn(), updateThreadControls: jest.fn(), moderateThreadMember: jest.fn() }));
jest.mock('../carryForwardApi.ts', () => ({ fetchCarryForwardPage: jest.fn() }));
jest.mock('expo-router', () => ({ useFocusEffect: (callback: () => void) => require('react').useEffect(callback, [callback]), router: { back: jest.fn(), replace: jest.fn() } }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
const thread = { id: 'source', threadType: 'direct', title: 'Original', otherMembers: [{ id: 'peer', name: 'Peer' }] };
const settings = { threadId: 'source', isHost: true, mutedUntil: null, controls: { slowModeSeconds: 0, postingPolicy: 'everyone', mediaPolicy: 'everyone', linkPolicy: 'everyone' } };
beforeEach(() => {
  jest.clearAllMocks(); jest.mocked(fetchCarryForwardPage).mockResolvedValue({ items: [], next: null }); mockCurrent = true; mockUserId = 'me';
  jest.mocked(api.getMyThreads).mockResolvedValue({ ok: true, data: { threads: [thread as any, { ...thread, id: 'target', title: 'Destination' } as any] } });
  jest.mocked(api.getThreadControls).mockResolvedValue({ ok: true, data: settings as any });
  jest.mocked(useInputAssistance).mockImplementation((opts) => ({ suggestions: opts.enabled && opts.text ? [{ entityType: 'user', entityId: 'new', label: 'New traveler' }] : [], loading: false, unavailable: false } as any));
});
it('creates a separate group only with explicitly selected people and never transmits direct history', async () => {
  jest.mocked(api.formConversationGroup).mockResolvedValue({ ok: true, data: { threadId: 'new-group', threadType: 'group', historyFrom: 'formation', memberUserIds: ['me', 'peer', 'new'] } });
  await render(<ConversationTools threadId="source" mode="add" />);
  await waitFor(() => expect(screen.getByLabelText('Search people')).toBeTruthy());
  await fireEvent.changeText(screen.getByLabelText('Search people'), 'new');
  expect(useInputAssistance).toHaveBeenLastCalledWith(expect.objectContaining({ fieldId: 'telegraph.recipient', context: 'telegraph_recipient', text: 'new', enabled: true }));
  await waitFor(() => expect(screen.getByText('Add New traveler')).toBeTruthy());
  expect(recordSuggestionSelection).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByText('Add New traveler'));
  expect(recordSuggestionSelection).toHaveBeenCalledTimes(1);
  expect(recordSuggestionSelection).toHaveBeenCalledWith(expect.objectContaining({ entityId: 'new', entityType: 'user' }),
    expect.objectContaining({ query: expect.any(String) }));
  await fireEvent.press(screen.getByText('Create group'));
  await waitFor(() => expect(api.formConversationGroup).toHaveBeenCalledWith('source', { userIds: ['new'], title: undefined }, mockOwner));
  expect(router.replace).toHaveBeenCalledWith(expect.objectContaining({ params: expect.objectContaining({ id: 'new-group', threadType: 'group' }) }));
});
it('shows forwarding refusal and stays on the picker', async () => {
  jest.mocked(api.forwardThreadMessage).mockResolvedValue({ ok: false, data: null, message: 'The author does not allow forwarding.' });
  await render(<ConversationTools threadId="source" messageId="message" mode="forward" />);
  await waitFor(() => expect(screen.getByText('Destination')).toBeTruthy());
  await fireEvent.press(screen.getByText('Destination'));
  await waitFor(() => expect(screen.getByText('The author does not allow forwarding.')).toBeTruthy());
  expect(router.replace).not.toHaveBeenCalled();
});
it('blocks duplicate taps while a forward is in flight', async () => {
  jest.mocked(api.forwardThreadMessage).mockReturnValue(new Promise(() => {}));
  await render(<ConversationTools threadId="source" messageId="message" mode="forward" />);
  await waitFor(() => expect(screen.getByText('Destination')).toBeTruthy());
  await act(async () => { await fireEvent.press(screen.getByText('Destination')); await fireEvent.press(screen.getByText('Destination')); });
  expect(api.forwardThreadMessage).toHaveBeenCalledTimes(1);
});
it('never navigates from an answer after the signed-in session changes', async () => {
  let resolve!: (result: any) => void;
  jest.mocked(api.forwardThreadMessage).mockReturnValue(new Promise((done) => { resolve = done; }));
  await render(<ConversationTools threadId="source" messageId="message" mode="forward" />);
  await waitFor(() => expect(screen.getByText('Destination')).toBeTruthy());
  await fireEvent.press(screen.getByText('Destination'));
  mockCurrent = false;
  await act(async () => resolve({ ok: true, data: { id: 'sent', threadId: 'target' } }));
  expect(router.replace).not.toHaveBeenCalled();
});
it('validates slow mode and saves host policies through the server', async () => {
  jest.mocked(api.updateThreadControls).mockResolvedValue({ ok: true, data: { controls: { ...settings.controls, slowModeSeconds: 30, mediaPolicy: 'hosts_only' } as any } });
  await render(<ConversationTools threadId="source" mode="manage" />);
  await waitFor(() => expect(screen.getByLabelText('Slow mode seconds')).toBeTruthy());
  await fireEvent.changeText(screen.getByLabelText('Slow mode seconds'), '3601');
  await fireEvent.press(screen.getByText('Save group settings'));
  expect(api.updateThreadControls).not.toHaveBeenCalled();
  await fireEvent.changeText(screen.getByLabelText('Slow mode seconds'), '30');
  await fireEvent(screen.getByLabelText('Only hosts can send media'), 'valueChange', true);
  await fireEvent.press(screen.getByText('Save group settings'));
  await waitFor(() => expect(screen.getByText('Group settings saved.')).toBeTruthy());
  expect(api.updateThreadControls).toHaveBeenCalledWith('source', expect.objectContaining({ slowModeSeconds: 30, mediaPolicy: 'hosts_only' }), mockOwner);
});
it('does not expose host writes to an ordinary member', async () => {
  jest.mocked(api.getThreadControls).mockResolvedValue({ ok: true, data: { ...settings, isHost: false } as any });
  await render(<ConversationTools threadId="source" mode="manage" />);
  await waitFor(() => expect(screen.getByText('Only hosts can change these settings.')).toBeTruthy());
  expect(screen.queryByText('Save group settings')).toBeNull();
  expect(screen.queryByText('Mute for 1 hour')).toBeNull();
});
it('distinguishes failed conversation reads from an empty recipient list', async () => {
  jest.mocked(api.getMyThreads).mockResolvedValue({ ok: false, data: null, message: 'Connection unavailable' });
  await render(<ConversationTools threadId="source" messageId="message" mode="forward" />);
  await waitFor(() => expect(screen.getByText('Connection unavailable')).toBeTruthy());
  expect(api.forwardThreadMessage).not.toHaveBeenCalled();
});
it('carries only explicitly checked plans and places into the new group', async () => {
  jest.mocked(fetchCarryForwardPage).mockResolvedValue({ items: [{ kind: 'PLAN', objectId: 'plan', title: 'Dinner' }, { kind: 'PLACE', objectId: 'place', title: 'Cafe' }], next: null });
  jest.mocked(api.formConversationGroup).mockResolvedValue({ ok: true, data: { threadId: 'new-group', threadType: 'group', historyFrom: 'formation', memberUserIds: ['me', 'peer', 'new'] } });
  await render(<ConversationTools threadId="source" mode="add" />);
  await waitFor(() => expect(screen.getByLabelText('Plan: Dinner')).toBeTruthy());
  expect(screen.getByLabelText('Plan: Dinner').props.accessibilityState.checked).toBe(false);
  await fireEvent.press(screen.getByLabelText('Plan: Dinner'));
  await fireEvent.changeText(screen.getByLabelText('Search people'), 'new');
  await waitFor(() => expect(screen.getByText('Add New traveler')).toBeTruthy());
  await fireEvent.press(screen.getByText('Add New traveler'));
  await fireEvent.press(screen.getByText('Create group'));
  expect(api.formConversationGroup).toHaveBeenCalledWith('source', { userIds: ['new'], title: undefined, carryForward: [{ kind: 'PLAN', objectId: 'plan' }] }, mockOwner);
});
it('checks older message pages without clearing explicit selections', async () => {
  const next = { createdAt: '2026-11-01T00:00:00Z', sequence: 5 };
  jest.mocked(fetchCarryForwardPage).mockResolvedValueOnce({ items: [{ kind: 'PLAN', objectId: 'plan', title: 'Dinner' }], next }).mockResolvedValueOnce({ items: [{ kind: 'PLACE', objectId: 'place', title: 'Cafe' }], next: null });
  await render(<ConversationTools threadId="source" mode="add" />);
  await waitFor(() => expect(screen.getByLabelText('Plan: Dinner')).toBeTruthy());
  await fireEvent.press(screen.getByLabelText('Plan: Dinner'));
  await fireEvent.press(screen.getByText('Check older messages'));
  await waitFor(() => expect(screen.getByLabelText('Place: Cafe')).toBeTruthy());
  expect(screen.getByLabelText('Plan: Dinner').props.accessibilityState.checked).toBe(true);
  expect(fetchCarryForwardPage).toHaveBeenLastCalledWith('source', mockOwner, expect.any(AbortSignal), next);
});
it('offers a retry on failed source reads and no unchecked selections are sent', async () => {
  jest.mocked(fetchCarryForwardPage).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ items: [{ kind: 'PLACE', objectId: 'place', title: 'Cafe' }], next: null });
  await render(<ConversationTools threadId="source" mode="add" />);
  await waitFor(() => expect(screen.getByText('Retry plans and places')).toBeTruthy());
  expect(screen.queryByText('No eligible plans or places in the messages checked.')).toBeNull();
  await fireEvent.press(screen.getByText('Retry plans and places'));
  await waitFor(() => expect(screen.getByLabelText('Place: Cafe')).toBeTruthy());
  expect(screen.getByLabelText('Place: Cafe').props.accessibilityState.checked).toBe(false);
});

it('reuses the media forward request id after an unconfirmed attempt', async () => {
  jest.mocked(api.forwardThreadMessage).mockResolvedValue({ ok: false, data: null, message: 'Please retry.' });
  await render(<ConversationTools threadId="source" messageId="message" mode="forward" />);
  await waitFor(() => expect(screen.getByText('Destination')).toBeTruthy());
  await fireEvent.press(screen.getByText('Destination'));
  await waitFor(() => expect(screen.getByText('Please retry.')).toBeTruthy());
  const first = jest.mocked(api.forwardThreadMessage).mock.calls[0][3];
  expect(first).toMatch(/^[0-9a-f-]{36}$/);
  await fireEvent.press(screen.getByText('Destination'));
  await waitFor(() => expect(api.forwardThreadMessage).toHaveBeenCalledTimes(2));
  expect(jest.mocked(api.forwardThreadMessage).mock.calls[1][3]).toBe(first);
});
