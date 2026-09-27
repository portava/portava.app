/**
 * MediaContributionScreen — §12 perspective groups on the §4 Media Contribution
 * sheet (census-media §36, MD82–MD85).
 *
 * The sheet offers "Where in the place?" ONLY while the server flag
 * `media_perspective_vantage_enabled` is on (seeded OFF by migration 3352; the
 * server refuses a vantage while it is off), and only for a category that is
 * one of §12's four entity types. The chosen group is sent as
 * `perspectiveVantage`.
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { MediaContributionScreen } from '../screens/MediaContributionScreen.tsx';

let mockVantageOn = false;
const mockCreatePost = jest.fn();

// NOTE: intentionally exhaustive — isEnabled is the only field the screen reads.
jest.mock('../../../context/FeatureFlagsContext.tsx', () => ({
  useFeatureFlags: () => ({
    isEnabled: (k: string) => mockVantageOn && k === 'media_perspective_vantage_enabled',
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
  mockVantageOn = false;
  mockCreatePost.mockReset();
  mockCreatePost.mockResolvedValue({ ok: true, data: { id: 'post-1', post_status: 'published' } });
});

async function open() {
  await render(<MediaContributionScreen placeId="11111111-1111-1111-1111-111111111111" pickMedia={async () => PICKED} />);
  await waitFor(() => expect(screen.getByTestId('media-contribution-sheet')).toBeTruthy());
}

test('flag OFF: no vantage question, even for a §12 category', async () => {
  await open();
  await fireEvent.press(screen.getByTestId('media-contribution-category-nightlife'));
  expect(screen.queryByText('Where in the place?')).toBeNull();
  expect(screen.queryByTestId('media-contribution-vantage-entrance')).toBeNull();
});

test('flag ON: a Nightclub category offers §12\'s groups, a non-§12 category offers none', async () => {
  mockVantageOn = true;
  await open();
  expect(screen.queryByText('Where in the place?')).toBeNull();
  await fireEvent.press(screen.getByTestId('media-contribution-category-culture'));
  expect(screen.queryByText('Where in the place?')).toBeNull();
  await fireEvent.press(screen.getByTestId('media-contribution-category-nightlife'));
  for (const k of ['entrance', 'queue', 'street', 'main_room', 'stage', 'bar', 'vip', 'outside']) {
    expect(screen.getByTestId(`media-contribution-vantage-${k}`)).toBeTruthy();
  }
});

test('flag ON: the chosen group is sent as perspectiveVantage', async () => {
  mockVantageOn = true;
  await open();
  await fireEvent.press(screen.getByTestId('media-contribution-category-nightlife'));
  await fireEvent.press(screen.getByTestId('media-contribution-vantage-queue'));
  await fireEvent.press(screen.getByTestId('media-contribution-pick'));
  await waitFor(() => expect(screen.getByTestId('contribution-preview')).toBeTruthy());
  await fireEvent.press(screen.getByTestId('media-contribution-submit'));
  await waitFor(() => expect(mockCreatePost).toHaveBeenCalledTimes(1));
  expect(mockCreatePost.mock.calls[0]![0]).toMatchObject({ category: 'nightlife', perspectiveVantage: 'queue' });
});
