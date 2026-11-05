/**
 * PulseCreate — posting TO a trip (/create?tripId=…, the trip page's Add Post).
 *
 * The trip page's Add Post used to open the composer with no trip, so the post
 * was a standalone post and never reached the trip's Trip Posts list. With a
 * tripId the composer says it is posting to the trip (trip posts are kept out
 * of the public feeds by the server), sends `tripId`, and does not offer
 * Highlight, whose own composer cannot post to a trip.
 */
import React from 'react';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';

const mockCreate = jest.fn(async (..._args: unknown[]) => ({ ok: true, data: { id: 'post-1' } }));
// NOTE: intentionally exhaustive — create/submitting are the only hook fields the composer reads.
jest.mock('../../hooks/usePosts.ts', () => ({
  usePostActions: () => ({ create: (...a: unknown[]) => mockCreate(...a), submitting: false }),
}));

// NOTE: intentionally exhaustive — signOut is the only session field the composer reads.
jest.mock('../../context/SessionContext.tsx', () => ({
  useSession: () => ({ signOut: jest.fn() }),
}));

// NOTE: intentionally exhaustive — useSafeAreaInsets is the only export used.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// NOTE: intentionally exhaustive — a pass-through scroll wrapper.
jest.mock('../ui/KeyboardSafeView.tsx', () => ({
  KeyboardSafeScrollView: ({ children }: any) => children,
  KeyboardSafeView: ({ children }: any) => children,
}));

// NOTE: intentionally exhaustive — a plain text field standing in for the mention editor.
jest.mock('../MentionInput.tsx', () => {
  const R = require('react');
  const { TextInput } = require('react-native');
  return {
    MentionInput: R.forwardRef((props: any, _ref: unknown) =>
      R.createElement(TextInput, { testID: 'composer-text', value: props.value, onChangeText: props.onChangeText })),
  };
});

// NOTE: intentionally exhaustive — the suggestion list renders nothing here.
jest.mock('../MentionSuggestionList.tsx', () => ({ MentionSuggestionList: () => null }));
// NOTE: intentionally exhaustive — the place picker is a full modal.
jest.mock('../selectors/GlobalPlacePicker.tsx', () => ({ GlobalPlacePicker: () => null }));
// NOTE: intentionally exhaustive — the highlight composer is a separate flow.
jest.mock('../HighlightComposer.tsx', () => ({ HighlightComposer: () => null }));
// NOTE: intentionally exhaustive — the filter editor is a separate flow.
jest.mock('../MediaFilterEditor.tsx', () => ({ MediaFilterEditor: () => null }));
// NOTE: intentionally exhaustive — no media is picked in these tests.
jest.mock('../../hooks/useMediaPicker.ts', () => ({ useMediaPicker: () => ({ pickMedia: jest.fn(async () => null) }) }));
// NOTE: intentionally exhaustive — a native spinner.
jest.mock('@react-native-community/datetimepicker', () => () => null);
// NOTE: intentionally exhaustive — upload is never reached without media.
jest.mock('../../services/media.ts', () => ({
  uploadMedia: jest.fn(),
  validateMedia: jest.fn(() => ({ ok: true })),
}));

import { UnifiedPostComposer } from '../PulseCreate.tsx';

async function postUpdate(view: Awaited<ReturnType<typeof render>>) {
  fireEvent.press(view.getByText('Post Update'));
  await waitFor(() => expect(view.getByTestId('composer-text')).toBeTruthy());
  await act(async () => { fireEvent.changeText(view.getByTestId('composer-text'), 'Ferry at 9'); });
  await act(async () => { fireEvent.press(view.getAllByText('Post Update').slice(-1)[0]!); });
  await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
  return mockCreate.mock.calls[0]![0] as Record<string, unknown>;
}

describe('posting to a trip', () => {
  beforeEach(() => mockCreate.mockClear());

  it('says it posts to the trip, offers no Highlight, and sends the tripId', async () => {
    const view = await render(<UnifiedPostComposer onClose={() => {}} tripId="trip-1" />);
    expect(view.getByText('Posting to this trip')).toBeTruthy();
    expect(view.getByText("It shows in the trip's Trip Posts, not in the public feeds.")).toBeTruthy();
    expect(view.queryByText('Highlight')).toBeNull();
    expect(await postUpdate(view)).toMatchObject({ tripId: 'trip-1', content: 'Ferry at 9' });
  });

  it('control: without a trip there is no note, Highlight is offered, and no tripId is sent', async () => {
    const view = await render(<UnifiedPostComposer onClose={() => {}} />);
    expect(view.queryByText('Posting to this trip')).toBeNull();
    expect(view.getByText('Highlight')).toBeTruthy();
    expect((await postUpdate(view)).tripId).toBeUndefined();
  });
});
