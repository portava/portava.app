/**
 * PulseCreate — the location-privacy choices say what the server actually does
 * (§33/§34, census-media MD321 §22).
 *
 * The composer used to hard-code its privacy copy, and three of the six lines
 * promised more than the server delivers: "Hidden" said *"Location stays
 * completely hidden"* while the post keeps its city and country; "Trusted
 * circle" said *"Only people in your Trusted Circle can see where you are"*
 * while no audience sees the place; "Now" published nothing now, because the
 * composer omits the field and the server's default for a tagged post is
 * after-exit. The composer now consults services/media/mediaPrivacy.ts for the
 * choices, the copy and the request fields.
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

const PLACE = {
  id: 'p1', type: 'poi', name: 'Bamboo 2', displayName: 'Bamboo 2 Bar', country: 'Vietnam', countryCode: 'VN',
  region: null, city: 'Da Nang', district: null, lat: 16.06, lng: 108.22, timezone: null, source: 'manual',
} as any;

async function openWithPlace() {
  const view = await render(<UnifiedPostComposer onClose={() => {}} initialPlace={PLACE} />);
  fireEvent.press(view.getByText('Post Update'));
  await waitFor(() => expect(view.getByText('Share location')).toBeTruthy());
  return view;
}

describe('the location choices say what the server does', () => {
  beforeEach(() => mockCreate.mockClear());

  it('attaching a place defaults to after-exit, and says the whole post waits', async () => {
    const view = await openWithPlace();
    await waitFor(() =>
      expect(view.getByText("Your post waits until you've left this spot. Others may then see the place for up to 24 hours — after that, only your city and country.")).toBeTruthy(), // census-media MD79 (lead ruling D-26f)
    );
  });

  it('"Hidden" no longer claims the location is completely hidden — the city and country stay', async () => {
    const view = await openWithPlace();
    await act(async () => { fireEvent.press(view.getByText('Hidden')); });
    await waitFor(() =>
      expect(view.getByText('The place you tagged is hidden from everyone. Your city and country stay on the post.')).toBeTruthy(),
    );
    expect(view.queryByText(/completely hidden/)).toBeNull();
  });

  it('"Trusted circle" no longer claims the circle can see where you are', async () => {
    const view = await openWithPlace();
    await act(async () => { fireEvent.press(view.getByText('Trusted circle')); });
    await waitFor(() =>
      expect(
        view.getByText('Nobody sees the place you tagged — your Trusted Circle included. Your city and country stay on the post.'),
      ).toBeTruthy(),
    );
    expect(view.queryByText(/Only people in your Trusted Circle/)).toBeNull();
  });

  it('"Now" says what the server will actually do with a tagged post', async () => {
    const view = await openWithPlace();
    await act(async () => { fireEvent.press(view.getByText('Now')); });
    await waitFor(() =>
      expect(
        view.getByText(
          "A post with a place is held until you've left it. Others may then see the place for up to 24 hours — after that, only your city and country. Sharing a place instantly isn't available yet.", // census-media MD79 (lead ruling D-26f)
        ),
      ).toBeTruthy(),
    );
  });

  it('the request carries the chosen mode', async () => {
    const view = await openWithPlace();
    await act(async () => { fireEvent.changeText(view.getByTestId('composer-text'), 'Great spot'); });
    await act(async () => { fireEvent.press(view.getByText('Hidden')); });
    await act(async () => { fireEvent.press(view.getAllByText('Post Update').slice(-1)[0]!); });
    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
    expect(mockCreate.mock.calls[0]![0]).toMatchObject({ locationPrivacyMode: 'hidden', publishAfterTime: null });
  });

  it('"Now" is still sent as an ABSENT field — the wire behaviour is unchanged; only the words are', async () => {
    const view = await openWithPlace();
    await act(async () => { fireEvent.changeText(view.getByTestId('composer-text'), 'Great spot'); });
    await act(async () => { fireEvent.press(view.getByText('Now')); });
    await act(async () => { fireEvent.press(view.getAllByText('Post Update').slice(-1)[0]!); });
    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
    const sent = mockCreate.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent.locationPrivacyMode).toBeUndefined();
    expect(sent.publishAfterTime).toBeNull();
  });
});
