/**
 * PulseCreate — spec §34 "Show neighborhood only" (census-media §36, MD262).
 *
 * The composer offers the fifth §34 choice ONLY while the server flag
 * `media_neighborhood_only_mode_enabled` is on (it is seeded OFF by migration
 * 3350, and the server refuses the mode while it is off). With the flag off the
 * chip row is exactly what it was. With it on, "Neighbourhood" is offered, says
 * what the server does, and the request carries `neighborhood_only`.
 */
import React from 'react';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';

let mockFlagOn = false;
// NOTE: intentionally exhaustive — isEnabled is the only field the composer reads.
jest.mock('../../context/FeatureFlagsContext.tsx', () => ({
  useFeatureFlags: () => ({
    isEnabled: (k: string) => mockFlagOn && k === 'media_neighborhood_only_mode_enabled',
    isLivePlacesEnabled: () => false,
    loading: false,
  }),
}));

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

describe('§34 "Show neighborhood only" in the composer', () => {
  beforeEach(() => { mockCreate.mockClear(); mockFlagOn = false; });

  it('flag OFF: no "Neighbourhood" choice — the six choices are exactly as before', async () => {
    const view = await openWithPlace();
    expect(view.queryByText('Neighbourhood')).toBeNull();
    for (const label of ['After I leave', 'At a time', 'City only', 'Now', 'Hidden', 'Trusted circle']) {
      expect(view.getByText(label)).toBeTruthy();
    }
  });

  it('flag ON: "Neighbourhood" is offered, and its words say the place stays hidden', async () => {
    mockFlagOn = true;
    const view = await openWithPlace();
    await act(async () => { fireEvent.press(view.getByText('Neighbourhood')); });
    await waitFor(() =>
      expect(
        view.getByText('Nobody sees the place you tagged. At most its neighbourhood is shown, and your city and country stay on the post.'),
      ).toBeTruthy(),
    );
  });

  it('flag ON: the request carries neighborhood_only', async () => {
    mockFlagOn = true;
    const view = await openWithPlace();
    await act(async () => { fireEvent.changeText(view.getByTestId('composer-text'), 'Great spot'); });
    await act(async () => { fireEvent.press(view.getByText('Neighbourhood')); });
    await act(async () => { fireEvent.press(view.getAllByText('Post Update').slice(-1)[0]!); });
    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
    expect(mockCreate.mock.calls[0]![0]).toMatchObject({ locationPrivacyMode: 'neighborhood_only', publishAfterTime: null });
  });
});
