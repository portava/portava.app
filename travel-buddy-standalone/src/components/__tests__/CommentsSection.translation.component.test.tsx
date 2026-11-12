import React from 'react';
import { act, render, fireEvent, waitFor } from '@testing-library/react-native';
import { CommentsSection } from '../CommentsSheet.tsx';

const mockListComments = jest.fn();
const mockEditComment = jest.fn();
const mockTranslate = jest.fn();
const mockOwner = { ownerId: 'owner', sessionId: 'session', isCurrent: () => true, invalidate: () => {} };
jest.mock('../../services/messagingOwnerRequest.ts', () => ({ ...jest.requireActual('../../services/messagingOwnerRequest.ts'), captureMessagingOwnerRequest: () => mockOwner }));
jest.mock('../../platform/input-assistance/hooks/useInputAccountEpoch.ts', () => ({ ...jest.requireActual('../../platform/input-assistance/hooks/useInputAccountEpoch.ts'), useInputAccountEpoch: () => 0 }));
jest.mock('../../hooks/useCommentTyping.ts', () => ({ ...jest.requireActual('../../hooks/useCommentTyping.ts'), useCommentTyping: () => 0 }));
jest.mock('../../services/commentActivity.ts', () => ({ ...jest.requireActual('../../services/commentActivity.ts'), readLiveComments: async () => ({ ok: true, comments: await mockListComments() }), readLiveReplies: async () => ({ ok: true, replies: [] }) }));
jest.mock('../../services/postEngagement', () => ({
  ...jest.requireActual('../../services/postEngagement'),
  listComments: (...args: unknown[]) => mockListComments(...args),
  editComment: (...args: unknown[]) => mockEditComment(...args),
  listReplies: jest.fn().mockResolvedValue([]),
}));
jest.mock('../../context/SessionContext', () => ({ ...jest.requireActual('../../context/SessionContext'), useSession: () => ({ userId: 'owner', isAuthed: true }) }));
jest.mock('../../context/LanguagePreferenceContext', () => ({ ...jest.requireActual('../../context/LanguagePreferenceContext'), useLanguagePreference: () => ({ preferredLanguage: 'en' }) }));
jest.mock('../../services/contentTranslation', () => ({ ...jest.requireActual('../../services/contentTranslation'), fetchContentTranslation: (...args: unknown[]) => mockTranslate(...args) }));
jest.mock('react-native-safe-area-context', () => ({ ...jest.requireActual('react-native-safe-area-context'), useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock('../RichText', () => ({ ...jest.requireActual('../RichText'), RichText: ({ content }: { content: string }) => {
  const { Text } = require('react-native');
  return <Text>{content}</Text>;
} }));
jest.mock('../MentionInput', () => ({ ...jest.requireActual('../MentionInput'), MentionInput: (props: Record<string, unknown>) => {
  const { TextInput } = require('react-native');
  return <TextInput {...props} />;
} }));
jest.mock('../ProfilePreviewCard', () => ({ ...jest.requireActual('../ProfilePreviewCard'), ProfilePreviewCard: () => null }));
jest.mock('../EngagementUserListSheet', () => ({ ...jest.requireActual('../EngagementUserListSheet'), EngagementUserListSheet: () => null }));
jest.mock('../ReportSheet', () => ({ ...jest.requireActual('../ReportSheet'), ReportSheet: () => null }));
jest.mock('../stamps/StampIcon', () => ({ ...jest.requireActual('../stamps/StampIcon'), StampIcon: () => null }));
jest.mock('../ui/VerifiedStamp', () => ({ ...jest.requireActual('../ui/VerifiedStamp'), VerifiedStamp: () => null }));
jest.mock('../MentionSuggestionList', () => ({ ...jest.requireActual('../MentionSuggestionList'), MentionSuggestionList: () => null }));

it('invalidates an edited comment translation, shows the new original while pending and preserves the original toggle', async () => {
  mockListComments.mockResolvedValue([{
    id: 'comment', body: 'Texto original', originalLanguage: 'es',
    author: { id: 'owner', handle: '@alice', name: 'Alice', avatarUrl: null },
    createdAt: '2024-01-01T10:00:00Z', updatedAt: '2024-01-01T10:00:00Z',
    canDelete: true, likeCount: 0, likedByMe: false,
  }]);
  mockEditComment.mockImplementation(async () => {
    const result = { id: 'comment', body: 'Texto nuevo', updatedAt: '2024-01-01T11:00:00Z' };
    const previous = await mockListComments();
    mockListComments.mockResolvedValue(previous.map((row: Record<string, unknown>) => ({ ...row, ...result })));
    return result;
  });
  const response = (body: string) => ({ ok: true, status: 'translated', translatedFields: { body }, translationLabel: 'Translated from Spanish' });
  let finish!: (value: ReturnType<typeof response>) => void;
  mockTranslate.mockResolvedValueOnce(response('Original text')).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const view = await render(<CommentsSection postId="post" onCountChange={jest.fn()} />);
  await view.findByText('Original text');
  await fireEvent.press(view.getByTestId('comment-edit-btn-comment'));
  await fireEvent.changeText(view.getByTestId('comment-edit-input-comment'), 'Texto nuevo');
  await fireEvent.press(view.getByTestId('comment-save-btn-comment'));
  await waitFor(() => expect(view.queryByText('Original text')).toBeNull());
  expect(view.getByText('Texto nuevo')).toBeTruthy();
  expect(mockTranslate).toHaveBeenCalledTimes(2);
  await act(async () => { finish(response('New text')); });
  await view.findByText('New text');
  await fireEvent.press(view.getByText('See original'));
  expect(view.getByText('Texto nuevo')).toBeTruthy();
  expect(view.queryByText('New text')).toBeNull();
});
