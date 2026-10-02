/**
 * MediaContributionScreen + MediaContributionSheet — rendered (census-media §19:
 * MD28 · MD316). The three client services are stood in for, and the cases
 * assert the calls the screen makes — in ORDER — and what the contributor sees.
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { MediaContributionScreen } from '../screens/MediaContributionScreen.tsx';

const mockGetCanonicalPlace = jest.fn();
const mockUploadMedia = jest.fn();
const mockCreatePost = jest.fn();
const calls: string[] = [];

// NOTE: intentionally exhaustive — only getCanonicalPlace is used, and the real
// module pulls the Supabase client that jest cannot initialise.
jest.mock('../../../services/places.ts', () => ({
  getCanonicalPlace: (...a: unknown[]) => mockGetCanonicalPlace(...a),
}));
// NOTE: intentionally exhaustive — only uploadMedia is used; see above.
jest.mock('../../../services/media.ts', () => ({
  uploadMedia: (...a: unknown[]) => {
    calls.push('upload');
    return mockUploadMedia(...a);
  },
}));
// NOTE: intentionally exhaustive — only createPost is used; see above.
jest.mock('../../../services/posts.ts', () => ({
  createPost: (...a: unknown[]) => {
    calls.push('save');
    return mockCreatePost(...a);
  },
}));
// NOTE: intentionally exhaustive — imagery is not under test.
jest.mock('../../../components/CachedImage.tsx', () => {
  const { View } = require('react-native');
  return { CachedImage: () => <View testID="contribution-preview" /> };
});

const PLACE_ID = '11111111-1111-1111-1111-111111111111';

beforeEach(() => {
  calls.length = 0;
  mockGetCanonicalPlace.mockReset();
  mockUploadMedia.mockReset();
  mockCreatePost.mockReset();
  mockGetCanonicalPlace.mockResolvedValue({
    id: PLACE_ID,
    name: 'Vertigo Rooftop',
    category: 'bar',
    coordinates: { lat: 13.7236, lng: 100.5437 },
    address: null,
    city: 'Bangkok',
    neighborhood: null,
    countryCode: 'TH',
    status: 'active',
  });
  mockUploadMedia.mockResolvedValue({ ok: true, url: 'https://cdn.example.test/v.jpg', mediaType: 'image' });
});

const pick = jest.fn(async () => ({ uri: 'file:///v.jpg', mimeType: 'image/jpeg', type: 'image' }));

describe('MediaContributionScreen', () => {
  it('uploads THEN saves a post bound to the venue with every choice the contributor made', async () => {
    mockCreatePost.mockResolvedValue({ ok: true, data: { id: 'p1', postStatus: 'published' } });
    await render(<MediaContributionScreen placeId={PLACE_ID} deviceGps={{ lat: 13.72361, lng: 100.54371 }} pickMedia={pick} />);
    await waitFor(() => expect(screen.getByText('Add your view of Vertigo Rooftop')).toBeTruthy());
    expect(mockGetCanonicalPlace).toHaveBeenCalledWith(PLACE_ID);

    // Nothing to send yet.
    expect(screen.getByTestId('media-contribution-submit').props.accessibilityState.disabled).toBe(true);

    await fireEvent.press(screen.getByTestId('media-contribution-pick'));
    await waitFor(() => expect(screen.getByTestId('contribution-preview')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('media-contribution-category-nightlife'));
    await fireEvent.press(screen.getByTestId('media-contribution-precision-after_i_leave'));
    await fireEvent.changeText(screen.getByTestId('media-contribution-note'), 'filling up fast');
    await fireEvent.press(screen.getByTestId('media-contribution-submit'));

    await waitFor(() => expect(screen.getByTestId('media-contribution-done')).toBeTruthy());
    expect(calls).toEqual(['upload', 'save']);
    const input = mockCreatePost.mock.calls[0]![0];
    expect(input).toMatchObject({
      mediaUrls: ['https://cdn.example.test/v.jpg'],
      locationName: 'Vertigo Rooftop',
      locationLat: 13.7236,
      locationLng: 100.5437,
      userGpsLat: 13.72361,
      category: 'nightlife',
      locationPrivacyMode: 'delayed_until_exit',
      content: 'filling up fast',
      addToPassport: false,
      visibility: 'public',
    });
  });

  it('a post the server holds back is reported as held back, not as live', async () => {
    mockCreatePost.mockResolvedValue({ ok: true, data: { id: 'p1', postStatus: 'pending_location_exit' } });
    await render(<MediaContributionScreen placeId={PLACE_ID} pickMedia={pick} />);
    await waitFor(() => expect(screen.getByTestId('media-contribution-pick')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('media-contribution-pick'));
    await fireEvent.press(screen.getByTestId('media-contribution-precision-after_i_leave'));
    await waitFor(() => expect(screen.getByTestId('media-contribution-submit').props.accessibilityState.disabled).toBe(false));
    await fireEvent.press(screen.getByTestId('media-contribution-submit'));
    await waitFor(() => expect(screen.getByText('Saved — your perspective appears once you have left.')).toBeTruthy());
  });

  it('a failed SAVE is retried as a save — the file is not uploaded a second time', async () => {
    mockCreatePost
      .mockResolvedValueOnce({ ok: false, data: null, errorKind: 'db_error', message: 'boom.' })
      .mockResolvedValueOnce({ ok: true, data: { id: 'p1', postStatus: 'published' } });
    await render(<MediaContributionScreen placeId={PLACE_ID} pickMedia={pick} />);
    await waitFor(() => expect(screen.getByTestId('media-contribution-pick')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('media-contribution-pick'));
    await waitFor(() => expect(screen.getByTestId('media-contribution-submit').props.accessibilityState.disabled).toBe(false));
    await fireEvent.press(screen.getByTestId('media-contribution-submit'));
    await waitFor(() => expect(screen.getByTestId('media-contribution-failed')).toBeTruthy());
    expect(screen.getByText(/Uploaded, but not saved yet/)).toBeTruthy();
    await fireEvent.press(screen.getByTestId('media-contribution-submit'));
    await waitFor(() => expect(screen.getByTestId('media-contribution-done')).toBeTruthy());
    expect(calls).toEqual(['upload', 'save', 'save']);
  });

  it('a place that cannot be loaded offers nothing to contribute to', async () => {
    mockGetCanonicalPlace.mockResolvedValue(null);
    await render(<MediaContributionScreen placeId={PLACE_ID} pickMedia={pick} />);
    await waitFor(() => expect(screen.getByText('This place could not be loaded')).toBeTruthy());
    expect(screen.queryByTestId('media-contribution-sheet')).toBeNull();
  });
});
