/**
 * MediaContributionScreen — spec §34 "Show neighborhood only" on the §4 Media
 * Contribution sheet (census-media §36, MD262).
 *
 * The sheet offers "Neighbourhood only" ONLY while the server flag
 * `media_neighborhood_only_mode_enabled` is on (seeded OFF by migration 3350;
 * the server refuses the mode while it is off). With it off the four precision
 * chips are exactly as before; with it on, choosing it sends `neighborhood_only`.
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { MediaContributionScreen } from '../screens/MediaContributionScreen.tsx';

let mockFlagOn = false;
const mockCreatePost = jest.fn();

// NOTE: intentionally exhaustive — isEnabled is the only field the screen reads.
jest.mock('../../../context/FeatureFlagsContext.tsx', () => ({
  useFeatureFlags: () => ({
    isEnabled: (k: string) => mockFlagOn && k === 'media_neighborhood_only_mode_enabled',
    isLivePlacesEnabled: () => false,
    loading: false,
  }),
}));
// NOTE: intentionally exhaustive — only getCanonicalPlace is used, and the real
// module pulls the Supabase client that jest cannot initialise.
jest.mock('../../../services/places.ts', () => ({
  getCanonicalPlace: async () => ({
    id: '11111111-1111-1111-1111-111111111111',
    name: 'Vertigo Rooftop',
    category: 'bar',
    coordinates: { lat: 13.7236, lng: 100.5437 },
    address: null,
    city: 'Bangkok',
    neighborhood: null,
    countryCode: 'TH',
    status: 'active',
  }),
}));
// NOTE: intentionally exhaustive — only uploadMedia is used; see above.
jest.mock('../../../services/media.ts', () => ({
  uploadMedia: async () => ({ ok: true, url: 'https://cdn.example.test/v.jpg', mediaType: 'image' }),
}));
// NOTE: intentionally exhaustive — only createPost is used; see above.
jest.mock('../../../services/posts.ts', () => ({
  createPost: (...a: unknown[]) => mockCreatePost(...a),
}));
// NOTE: intentionally exhaustive — imagery is not under test.
jest.mock('../../../components/CachedImage.tsx', () => {
  const { View } = require('react-native');
  return { CachedImage: () => <View testID="contribution-preview" /> };
});

const PICKED = { uri: 'file:///x.jpg', mimeType: 'image/jpeg', type: 'image' };

beforeEach(() => {
  mockFlagOn = false;
  mockCreatePost.mockReset();
  mockCreatePost.mockResolvedValue({ ok: true, data: { id: 'post-1', post_status: 'published' } });
});

async function open() {
  render(<MediaContributionScreen placeId="11111111-1111-1111-1111-111111111111" pickMedia={async () => PICKED} />);
  await waitFor(() => expect(screen.getByTestId('media-contribution-sheet')).toBeTruthy());
}

test('flag OFF: the four precision choices, and no neighbourhood', async () => {
  await open();
  for (const p of ['venue', 'city_only', 'after_i_leave', 'hidden']) {
    expect(screen.getByTestId(`media-contribution-precision-${p}`)).toBeTruthy();
  }
  expect(screen.queryByTestId('media-contribution-precision-neighborhood')).toBeNull();
});

test('flag ON: "Neighbourhood only" is offered and the save carries neighborhood_only', async () => {
  mockFlagOn = true;
  await open();
  fireEvent.press(screen.getByTestId('media-contribution-precision-neighborhood'));
  fireEvent.press(screen.getByTestId('media-contribution-pick'));
  await waitFor(() => expect(screen.getByTestId('contribution-preview')).toBeTruthy());
  fireEvent.press(screen.getByTestId('media-contribution-submit'));
  await waitFor(() => expect(mockCreatePost).toHaveBeenCalledTimes(1));
  expect(mockCreatePost.mock.calls[0]![0]).toMatchObject({ locationPrivacyMode: 'neighborhood_only' });
});
