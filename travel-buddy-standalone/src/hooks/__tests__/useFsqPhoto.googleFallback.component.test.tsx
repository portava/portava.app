/**
 * useFsqPhoto — Google Places fallback chain.
 *
 * Confirms the three critical branches of the deferred photo-resolution chain:
 *
 *  1. When Foursquare comes up empty (returns null), the hook falls through
 *     to lookupGooglePhoto and ultimately returns the Google URL — this is
 *     the primary path for OSM-backed Discovery venues that have no Foursquare
 *     match.
 *
 *  2. When Foursquare returns a URL, lookupGooglePhoto is never called
 *     (short-circuit: no unnecessary API call).
 *
 *  3. When `existingUrl` is already set, neither lookup fires at all — the
 *     hook returns the existing URL immediately and stays there.
 *
 *  4. When both FSQ and Google return null, the hook stays null (falls through
 *     to category-appropriate artwork, never a blank card).
 *
 * Run with: pnpm test:component
 *
 * Timing notes:
 *   The hook fires its chain after a 500 ms debounce to skip cards flung past
 *   while scrolling. Real timers + waitFor (1 500 ms timeout) are used because
 *   fake timers inside async React 19 tests poison subsequent renders in the
 *   file (see RNTL React 19 renderer budget in project memory).
 */

import { renderHook, waitFor } from '@testing-library/react-native';
import { lookupFsqPhoto } from '../../services/fsqPhotoLookup.ts';
import { lookupGooglePhoto } from '../../services/googlePhotoLookup.ts';
import { useFsqPhoto } from '../useFsqPhoto.ts';

// NOTE: intentionally exhaustive — fsqPhotoLookup calls the api-server proxy
// (GET /api/places/fsq-photo) to avoid CORS failures on the web build; only
// the stub return value matters here so no network activity occurs during tests.
jest.mock('../../services/fsqPhotoLookup.ts', () => ({
  lookupFsqPhoto: jest.fn(),
}));

// NOTE: intentionally exhaustive — googlePhotoLookup proxies through the
// api-server and holds GOOGLE_MAPS_API_KEY server-side; stub the whole
// module so no HTTP call reaches the server during unit tests.
jest.mock('../../services/googlePhotoLookup.ts', () => ({
  lookupGooglePhoto: jest.fn(),
}));

const mockLookupFsqPhoto   = jest.mocked(lookupFsqPhoto);
const mockLookupGooglePhoto = jest.mocked(lookupGooglePhoto);

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('useFsqPhoto — Google Places fallback chain', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('falls through to lookupGooglePhoto and returns the URL when FSQ is empty', async () => {
    const GOOGLE_URL =
      'https://places.googleapis.com/v1/places/ChIJabc/photos/AUGGfXnDef/media?maxWidthPx=800&key=test';

    mockLookupFsqPhoto.mockResolvedValue(null);
    mockLookupGooglePhoto.mockResolvedValue(GOOGLE_URL);

    const { result } = await renderHook(() =>
      useFsqPhoto('Cebu Zoo', 10.311, 123.891),
    );

    // Before the 500 ms debounce fires, the hook returns null.
    expect(result.current).toBeNull();

    // After the debounce + both lookups resolve, the hook should carry the
    // Google URL — this is what place cards display for OSM-backed venues.
    await waitFor(
      () => expect(result.current).toBe(GOOGLE_URL),
      { timeout: 1500 },
    );

    expect(mockLookupFsqPhoto).toHaveBeenCalledWith('Cebu Zoo', 10.311, 123.891);
    expect(mockLookupGooglePhoto).toHaveBeenCalledWith('Cebu Zoo', 10.311, 123.891);
  });

  it('short-circuits at FSQ and never calls lookupGooglePhoto when FSQ returns a URL', async () => {
    const FSQ_URL = 'https://fastly.4sqi.net/img/general/original/photo.jpg';

    mockLookupFsqPhoto.mockResolvedValue(FSQ_URL);
    mockLookupGooglePhoto.mockResolvedValue('should-never-be-used');

    const { result } = await renderHook(() =>
      useFsqPhoto('Cebu Zoo', 10.311, 123.891),
    );

    await waitFor(
      () => expect(result.current).toBe(FSQ_URL),
      { timeout: 1500 },
    );

    expect(mockLookupGooglePhoto).not.toHaveBeenCalled();
  });

  it('returns existingUrl immediately and never fires any lookup', async () => {
    const EXISTING = 'https://example.com/pre-loaded-photo.jpg';

    const { result } = await renderHook(() =>
      useFsqPhoto('Cebu Zoo', 10.311, 123.891, EXISTING),
    );

    // existingUrl is set as the initial state value — visible synchronously.
    expect(result.current).toBe(EXISTING);

    // Wait longer than the 500 ms debounce to confirm no lookup fires.
    await new Promise<void>((r) => setTimeout(r, 700));

    expect(result.current).toBe(EXISTING);
    expect(mockLookupFsqPhoto).not.toHaveBeenCalled();
    expect(mockLookupGooglePhoto).not.toHaveBeenCalled();
  });

  it('stays null when both FSQ and Google return null — falls through to category artwork', async () => {
    mockLookupFsqPhoto.mockResolvedValue(null);
    mockLookupGooglePhoto.mockResolvedValue(null);

    const { result } = await renderHook(() =>
      useFsqPhoto('Unknown Venue', null, null),
    );

    // Wait for the full chain to settle.
    await new Promise<void>((r) => setTimeout(r, 700));

    expect(result.current).toBeNull();
    expect(mockLookupFsqPhoto).toHaveBeenCalledTimes(1);
    expect(mockLookupGooglePhoto).toHaveBeenCalledTimes(1);
  });
});
