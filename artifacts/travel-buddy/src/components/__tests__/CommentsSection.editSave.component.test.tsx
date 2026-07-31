/**
 * CommentsSection — inline comment/reply edit-save flow.
 *
 * Confirms that the inline edit editor closes and shows the updated text
 * (not a stale or empty body) after saving, and that the "Edited" label
 * becomes visible.  Also confirms that saving with a blank body is rejected
 * client-side before any network call is made.
 *
 * Run with:  pnpm test:component
 *
 * ## What's covered
 *
 * 1. Comment edit: tap Edit → TextInput appears with original body → change
 *    text → tap Save → updated body appears in the list → "Edited" label shown.
 * 2. Reply edit: load replies → tap pencil icon → change text → tap Save →
 *    updated reply body appears → "Edited" label shown.
 * 3. Blank-body rejection: clearing the edit input and tapping Save fires no
 *    network call and the editor stays open.
 */

import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import { CommentsSection } from '../CommentsSheet.tsx';
import {
  listComments,
  editComment,
  listReplies,
} from '../../services/postEngagement.ts';

// ── Module mocks ──────────────────────────────────────────────────────────────

jest.mock('../../services/postEngagement', () => ({
  ...jest.requireActual('../../services/postEngagement'),
  listComments:  jest.fn(),
  editComment:   jest.fn(),
  listReplies:   jest.fn(),
  addComment:    jest.fn(),
  deleteComment: jest.fn(),
  likeComment:   jest.fn(),
  unlikeComment: jest.fn(),
  addReply:      jest.fn(),
}));

jest.mock('../../context/SessionContext', () => ({
  ...jest.requireActual('../../context/SessionContext'),
  useSession: () => ({ userId: 'user-owner', isAuthed: true }),
}));

// NOTE: intentionally exhaustive — react-native-safe-area-context requires a
// native SafeAreaProvider which is unavailable under jest-expo; the stub returns
// zero insets so layout math in CommentsSection doesn't crash.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// NOTE: intentionally exhaustive — useContentTranslation hits a real async
// translation service; the stub disables translation so comment bodies render
// their original text, making getByText() assertions reliable.
jest.mock('../../hooks/useContentTranslation', () => ({
  useContentTranslation: () => ({
    translated: false,
    translatedFields: {},
    toggle: () => {},
    loading: false,
    available: false,
  }),
}));

// NOTE: intentionally exhaustive — RichText pulls in complex mention/hashtag
// rendering logic; the stub renders a plain Text so getByText() works on body content.
jest.mock('../RichText.tsx', () => ({
  RichText: ({ content }: { content: string }) => {
    const { Text } = require('react-native');
    return <Text testID="rich-text">{content}</Text>;
  },
}));

// NOTE: intentionally exhaustive — MentionInput is a ref-forwarding native input
// wrapper that requires native modules unavailable under jest.
jest.mock('../MentionInput.tsx', () => ({
  MentionInput: (props: Record<string, unknown>) => {
    const { TextInput } = require('react-native');
    return <TextInput {...props} />;
  },
}));

// NOTE: intentionally exhaustive — avoids SafeAreaProvider and navigation requirements.
jest.mock('../ProfilePreviewCard.tsx', () => ({ ProfilePreviewCard: () => null }));
// NOTE: intentionally exhaustive — avoids deep modal/navigation provider chain.
jest.mock('./EngagementUserListSheet.tsx', () => ({ EngagementUserListSheet: () => null }), { virtual: true });
jest.mock('../EngagementUserListSheet.tsx', () => ({ EngagementUserListSheet: () => null }));
// NOTE: intentionally exhaustive — ReportSheet requires safe-area context deep inside.
jest.mock('../ReportSheet.tsx', () => ({ ReportSheet: () => null }));
// NOTE: intentionally exhaustive — StampIcon uses Reanimated worklets unavailable under jest.
jest.mock('./stamps/StampIcon.tsx', () => ({ StampIcon: () => null }), { virtual: true });
jest.mock('../stamps/StampIcon.tsx', () => ({ StampIcon: () => null }));
// NOTE: intentionally exhaustive — VerifiedStamp renders an SVG-based icon.
jest.mock('../ui/VerifiedStamp.tsx', () => ({ VerifiedStamp: () => null }));
// NOTE: intentionally exhaustive — TranslationToggle uses async translation service.
jest.mock('../TranslationToggle.tsx', () => ({ TranslationToggle: () => null }));
// NOTE: intentionally exhaustive — MentionSuggestionList has internal async fetch.
jest.mock('../MentionSuggestionList.tsx', () => ({ MentionSuggestionList: () => null }));

jest.mock('../../services/blocks.ts', () => ({ blockUser: jest.fn() }));

// ── Typed mock refs ───────────────────────────────────────────────────────────

const mockListComments = listComments as jest.Mock;
const mockEditComment  = editComment  as jest.Mock;
const mockListReplies  = listReplies  as jest.Mock;

// ── Fixtures ──────────────────────────────────────────────────────────────────

const COMMENT_ID = 'cmt-1';
const REPLY_ID   = 'reply-1';
const POST_ID    = 'post-xyz';

function makeComment(overrides = {}) {
  return {
    id: COMMENT_ID,
    body: 'Original comment body',
    author: { id: 'user-owner', handle: '@alice', name: 'Alice', avatarUrl: null },
    createdAt: '2024-01-01T10:00:00.000Z',
    updatedAt:  '2024-01-01T10:00:00.000Z',
    canDelete: true,
    likeCount: 0,
    likedByMe: false,
    ...overrides,
  };
}

function makeReply(overrides = {}) {
  return {
    id: REPLY_ID,
    parentCommentId: COMMENT_ID,
    body: 'Original reply body',
    author: { id: 'user-owner', handle: '@alice', name: 'Alice', avatarUrl: null },
    createdAt: '2024-01-01T10:01:00.000Z',
    updatedAt:  '2024-01-01T10:01:00.000Z',
    canDelete: true,
    likeCount: 0,
    likedByMe: false,
    ...overrides,
  };
}

// ── Render helper ─────────────────────────────────────────────────────────────

async function renderSection(onCountChange = jest.fn()) {
  return render(
    <CommentsSection postId={POST_ID} onCountChange={onCountChange} />,
  );
}

// ── Tests: comment edit ───────────────────────────────────────────────────────

describe('CommentsSection — comment edit-save flow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockListComments.mockResolvedValue([makeComment()]);
    mockListReplies.mockResolvedValue([]);
  });

  it('shows the TextInput pre-filled with the original body after tapping Edit', async () => {
    const { getByTestId, findByTestId } = await renderSection();

    // Wait for comments to load
    await findByTestId(`comment-edit-btn-${COMMENT_ID}`);

    await fireEvent.press(getByTestId(`comment-edit-btn-${COMMENT_ID}`));

    const input = getByTestId(`comment-edit-input-${COMMENT_ID}`);
    expect(input.props.value).toBe('Original comment body');
  });

  it('updates the comment body in place and shows "Edited" after saving', async () => {
    mockEditComment.mockResolvedValueOnce({
      id: COMMENT_ID,
      body: 'Updated comment text',
      updatedAt: '2024-01-01T11:00:00.000Z',
    });

    const { getByTestId, findByTestId, queryByTestId } = await renderSection();

    await findByTestId(`comment-edit-btn-${COMMENT_ID}`);

    // Open editor
    await fireEvent.press(getByTestId(`comment-edit-btn-${COMMENT_ID}`));

    // Change text
    await fireEvent.changeText(
      getByTestId(`comment-edit-input-${COMMENT_ID}`),
      'Updated comment text',
    );

    // Save
    await fireEvent.press(getByTestId(`comment-save-btn-${COMMENT_ID}`));

    // Editor must close (input gone)
    await waitFor(() => {
      expect(queryByTestId(`comment-edit-input-${COMMENT_ID}`)).toBeNull();
    });

    // Updated body visible via mocked RichText
    await waitFor(() => {
      const richTexts = require('@testing-library/react-native')
        .screen
        .queryAllByTestId('rich-text');
      const bodies = richTexts.map((n: { props: { children: unknown } }) => n.props.children);
      expect(bodies).toContain('Updated comment text');
    });

    // "Edited" label visible
    await findByTestId(`comment-edited-label-${COMMENT_ID}`);
  });

  it('closes the editor and shows the updated body — not a stale body', async () => {
    mockEditComment.mockResolvedValueOnce({
      id: COMMENT_ID,
      body: 'Brand new text',
      updatedAt: '2024-01-01T12:00:00.000Z',
    });

    const { getByTestId, findByTestId, queryByText } = await renderSection();
    await findByTestId(`comment-edit-btn-${COMMENT_ID}`);

    await fireEvent.press(getByTestId(`comment-edit-btn-${COMMENT_ID}`));
    await fireEvent.changeText(
      getByTestId(`comment-edit-input-${COMMENT_ID}`),
      'Brand new text',
    );
    await fireEvent.press(getByTestId(`comment-save-btn-${COMMENT_ID}`));

    // Original body must be gone, new body present
    await waitFor(() => {
      expect(queryByText('Original comment body')).toBeNull();
    });
    await waitFor(() => {
      expect(queryByText('Brand new text')).not.toBeNull();
    });
  });

  it('calls editComment once with the correct arguments', async () => {
    mockEditComment.mockResolvedValueOnce({
      id: COMMENT_ID,
      body: 'Checked body',
      updatedAt: '2024-01-01T13:00:00.000Z',
    });

    const { getByTestId, findByTestId } = await renderSection();
    await findByTestId(`comment-edit-btn-${COMMENT_ID}`);

    await fireEvent.press(getByTestId(`comment-edit-btn-${COMMENT_ID}`));
    await fireEvent.changeText(
      getByTestId(`comment-edit-input-${COMMENT_ID}`),
      'Checked body',
    );
    await fireEvent.press(getByTestId(`comment-save-btn-${COMMENT_ID}`));

    await waitFor(() => expect(mockEditComment).toHaveBeenCalledTimes(1));
    expect(mockEditComment).toHaveBeenCalledWith(POST_ID, COMMENT_ID, 'Checked body');
  });

  it('rejects a blank body client-side — no network call fires', async () => {
    const { getByTestId, findByTestId, queryByTestId } = await renderSection();
    await findByTestId(`comment-edit-btn-${COMMENT_ID}`);

    await fireEvent.press(getByTestId(`comment-edit-btn-${COMMENT_ID}`));

    // Clear the input to blank
    await fireEvent.changeText(
      getByTestId(`comment-edit-input-${COMMENT_ID}`),
      '   ',
    );

    // Save button is disabled when trimmed text is empty; press should no-op
    await fireEvent.press(getByTestId(`comment-save-btn-${COMMENT_ID}`));

    // Editor stays open — input still present
    expect(queryByTestId(`comment-edit-input-${COMMENT_ID}`)).not.toBeNull();

    // No network call
    expect(mockEditComment).not.toHaveBeenCalled();
  });
});

// ── Tests: reply edit ─────────────────────────────────────────────────────────

describe('CommentsSection — reply edit-save flow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockListComments.mockResolvedValue([makeComment()]);
    mockListReplies.mockResolvedValue([makeReply()]);
  });

  it('shows the TextInput pre-filled with the original reply body after tapping the pencil', async () => {
    const { getByTestId, findByTestId } = await renderSection();

    // Load and open the reply thread
    await findByTestId(`comment-edit-btn-${COMMENT_ID}`);
    const repliesToggle = require('@testing-library/react-native')
      .screen
      .queryByText('View replies');
    if (repliesToggle) await fireEvent.press(repliesToggle);

    await findByTestId(`reply-edit-btn-${REPLY_ID}`);
    await fireEvent.press(getByTestId(`reply-edit-btn-${REPLY_ID}`));

    const input = getByTestId(`reply-edit-input-${REPLY_ID}`);
    expect(input.props.value).toBe('Original reply body');
  });

  it('updates the reply body in place and shows "Edited" after saving', async () => {
    mockEditComment.mockResolvedValueOnce({
      id: REPLY_ID,
      body: 'Updated reply text',
      updatedAt: '2024-01-01T11:30:00.000Z',
    });

    const { getByTestId, findByTestId, queryByTestId } = await renderSection();

    await findByTestId(`comment-edit-btn-${COMMENT_ID}`);

    // Open reply thread
    const repliesToggle = require('@testing-library/react-native')
      .screen
      .queryByText('View replies');
    if (repliesToggle) await fireEvent.press(repliesToggle);

    await findByTestId(`reply-edit-btn-${REPLY_ID}`);

    // Open editor
    await fireEvent.press(getByTestId(`reply-edit-btn-${REPLY_ID}`));

    // Change text
    await fireEvent.changeText(
      getByTestId(`reply-edit-input-${REPLY_ID}`),
      'Updated reply text',
    );

    // Save
    await fireEvent.press(getByTestId(`reply-save-btn-${REPLY_ID}`));

    // Editor closes
    await waitFor(() => {
      expect(queryByTestId(`reply-edit-input-${REPLY_ID}`)).toBeNull();
    });

    // Updated text visible
    await waitFor(() => {
      const richTexts = require('@testing-library/react-native')
        .screen
        .queryAllByTestId('rich-text');
      const bodies = richTexts.map((n: { props: { children: unknown } }) => n.props.children);
      expect(bodies).toContain('Updated reply text');
    });

    // "Edited" label on the reply
    await findByTestId(`reply-edited-label-${REPLY_ID}`);
  });

  it('rejects a blank reply body client-side — no network call fires', async () => {
    const { getByTestId, findByTestId, queryByTestId } = await renderSection();

    await findByTestId(`comment-edit-btn-${COMMENT_ID}`);

    const repliesToggle = require('@testing-library/react-native')
      .screen
      .queryByText('View replies');
    if (repliesToggle) await fireEvent.press(repliesToggle);

    await findByTestId(`reply-edit-btn-${REPLY_ID}`);

    await fireEvent.press(getByTestId(`reply-edit-btn-${REPLY_ID}`));
    await fireEvent.changeText(
      getByTestId(`reply-edit-input-${REPLY_ID}`),
      '',
    );

    await fireEvent.press(getByTestId(`reply-save-btn-${REPLY_ID}`));

    // Editor stays open
    expect(queryByTestId(`reply-edit-input-${REPLY_ID}`)).not.toBeNull();
    expect(mockEditComment).not.toHaveBeenCalled();
  });
});
