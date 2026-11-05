import React from 'react';
import { render, fireEvent, screen, waitFor, act } from '@testing-library/react-native';
import ReportedContentScreen from '../reported-content.tsx';
import * as removal from '../../../src/services/reportedContentRemoval.ts';

const mockTarget = { subjectType: 'post', subjectId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', reportId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' };
let mockRole = 'admin';
let mockPending: unknown = null;
let mockPrompt: any;
let mockScopeCallback: (() => void) | undefined;
let mockCurrent = true;
const mockOwner = () => { let valid = true; return { ownerId: 'admin', sessionId: 'session', isCurrent: () => mockCurrent && valid, invalidate: () => { valid = false; } }; };
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useLocalSearchParams: () => mockTarget,
  useFocusEffect: (callback: () => unknown) => require('react').useEffect(callback, [callback]),
}));
// NOTE: the screen's actual role check is exercised against a controlled resolved guard.
jest.mock('../../../src/hooks/useRequireAdmin', () => ({ useRequireAdmin: () => false }));
// NOTE: the current session is controlled without creating an auth client.
jest.mock('../../../src/context/SessionContext', () => ({ useSession: () => ({ userId: 'admin', role: mockRole, isAuthed: true }) }));
// NOTE: captures independent owner handles; invalidation must survive screen cleanup.
jest.mock('../../../src/services/messagingOwnerRequest', () => ({ captureMessagingOwnerRequest: () => mockOwner() }));
jest.mock('../../../src/services/discoveryViewerScope', () => ({
  ...jest.requireActual('../../../src/services/discoveryViewerScope'),
  onDiscoveryScopeChange: (callback: () => void) => { mockScopeCallback = callback; return () => { mockScopeCallback = undefined; }; },
}));
jest.mock('../../../src/services/reportedContentRemoval', () => ({
  ...jest.requireActual('../../../src/services/reportedContentRemoval'),
  getContentRemovalContext: jest.fn(), pendingContentRemoval: () => mockPending,
  confirmContentRemoval: jest.fn(), submitContentRemoval: jest.fn(),
}));
// NOTE: layout is outside the admin confirmation/recovery state machine being exercised.
jest.mock('../../../src/components/settings/SettingsUI', () => {
  const R = require('react'); const { Text, View, Pressable } = require('react-native');
  return { SettingsScreen: ({ children }: any) => R.createElement(View, null, children),
    SettingsSection: ({ children }: any) => R.createElement(View, null, children),
    SettingsRow: ({ title, onPress }: any) => R.createElement(Pressable, { onPress }, R.createElement(Text, null, title)) };
});
// NOTE: the destructive prompt's callbacks are exercised explicitly; native Modal timing is independent.
jest.mock('../../../src/components/ReasonPromptModal', () => ({ ReasonPromptModal: (props: unknown) => { mockPrompt = props; return null; } }));

const context = { ...mockTarget, contractVersion: 1, preview: 'Current reported item', reportStatus: 'open', effect: 'remove_content', contentToken: 'a'.repeat(64), reportToken: 'b'.repeat(64) };
const intent = { ...mockTarget, operationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', reason: 'Reviewed report', contentToken: context.contentToken, reportToken: context.reportToken };
beforeEach(() => {
  jest.clearAllMocks(); mockRole = 'admin'; mockPending = null; mockCurrent = true; mockPrompt = undefined;
  (removal.getContentRemovalContext as jest.Mock).mockResolvedValue(context);
  (removal.confirmContentRemoval as jest.Mock).mockImplementation(() => { mockPending = intent; return intent; });
  (removal.submitContentRemoval as jest.Mock).mockResolvedValue({ ok: true });
});
it('does not load a preview or offer removal to a non-admin', async () => {
  mockRole = 'user';
  await render(<ReportedContentScreen />);
  expect(removal.getContentRemovalContext).not.toHaveBeenCalled();
  expect(screen.queryByText('Remove content…')).toBeNull();
});
it('requires the explicit reason prompt before submitting the current preview', async () => {
  await render(<ReportedContentScreen />);
  await waitFor(() => expect(screen.getByText('Current reported item')).toBeTruthy());
  await fireEvent.press(screen.getByText('Remove content…'));
  expect(mockPrompt.visible).toBe(true);
  expect(removal.submitContentRemoval).not.toHaveBeenCalled();
  await act(async () => { mockPrompt.onSubmit('Reviewed report'); });
  expect(removal.confirmContentRemoval).toHaveBeenCalledWith(expect.anything(), context, 'Reviewed report');
  expect(removal.submitContentRemoval).toHaveBeenCalledWith(expect.anything(), intent);
  expect(screen.getByText('Return to reports')).toBeTruthy();
});
it('recovers a pending operation without replacing its original confirmation', async () => {
  mockPending = intent;
  (removal.submitContentRemoval as jest.Mock).mockRejectedValueOnce(new Error('Result unavailable')).mockResolvedValueOnce({ ok: true });
  await render(<ReportedContentScreen />);
  expect(removal.getContentRemovalContext).not.toHaveBeenCalled();
  fireEvent.press(screen.getByText('Retry same removal'));
  await waitFor(() => expect(screen.getByText('Result unavailable')).toBeTruthy());
  fireEvent.press(screen.getByText('Retry same removal'));
  await waitFor(() => expect(screen.getByText('Return to reports')).toBeTruthy());
  expect(removal.confirmContentRemoval).not.toHaveBeenCalled();
  expect((removal.submitContentRemoval as jest.Mock).mock.calls.map(call => call[1])).toEqual([intent, intent]);
});
it('invalidates an open confirmation when the session changes', async () => {
  await render(<ReportedContentScreen />);
  await waitFor(() => expect(screen.getByText('Remove content…')).toBeTruthy());
  await fireEvent.press(screen.getByText('Remove content…'));
  const oldSubmit = mockPrompt.onSubmit;
  await act(async () => { mockCurrent = false; mockScopeCallback?.(); oldSubmit('Old session reason'); });
  expect(removal.confirmContentRemoval).not.toHaveBeenCalled();
  expect(removal.submitContentRemoval).not.toHaveBeenCalled();
  expect(screen.getByText('Your session changed.')).toBeTruthy();
});
