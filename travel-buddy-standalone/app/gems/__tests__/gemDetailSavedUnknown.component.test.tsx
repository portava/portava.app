/**
 * census-discovery §122 (DV-83 round 23, lane W11-X2; §119.16 B36): the gem detail screen never says "not saved" over a
 * saved read the server could not make.
 *
 * GET /hidden-gems/:id now serves `savedByMe: null` and names the read in `failedSources` when the viewer's
 * `hidden_gem_saves` row cannot be read, or no viewer could be resolved from the token (api-server
 * hiddenGemDetailSavedUnread GS1, GS4). getGem flattened that to `false` and the screen drew an outline bookmark. Now
 * getGem and useGemDetail carry the null; the screen's bookmark says "Couldn't check if saved" and is not a toggle.
 *
 *   GD0 getGem: savedByMe null → null, never false; GD0c CONTROL true / false carried
 *   GD1 useGemDetail: savedByMe null → null, and toggleSave saves and unsaves nothing
 *   GD2 the screen: savedByMe null → "Couldn't check if saved", never "Save", and a tap toggles nothing; GD2c CONTROL false → "Save"
 */
import React from 'react';
import { render, screen, act, renderHook, waitFor, cleanup, fireEvent } from '@testing-library/react-native';

jest.mock('../../../src/services/hiddenGems', () => ({
  ...jest.requireActual('../../../src/services/hiddenGems'),
  getGem: jest.fn(), saveGem: jest.fn(async () => undefined), unsaveGem: jest.fn(async () => undefined),
}));
import { getGem, saveGem, unsaveGem } from '../../../src/services/hiddenGems';
import { useGemDetail } from '../../../src/hooks/useHiddenGems';

const GEM = { id: 'g1', name: 'Tile courtyard', category: 'viewpoint', city: 'Lisbon', country: 'PT', neighborhood: null, description: null, latitude: null, longitude: null, approxLatitude: null, approxLongitude: null, vibeTags: [], priceRange: null, safetyNotes: null, bestTimeToGo: null, localEtiquette: null, layoverSafe: false, minimumLayoverMinutes: null, sensitivityLevel: 'public', verificationLevel: 'community', status: 'active', submittedBy: null, imageUrl: null, canonicalPlaceId: null, saveCount: 3, visitCount: 0, createdAt: '', updatedAt: '', gemState: null, gemConfidence: null, visitOutcomes: null };
afterEach(() => { cleanup(); jest.clearAllMocks(); delete (globalThis as any).fetch; });

describe('census-discovery §122 (B36): getGem and useGemDetail carry an unread save state as unknown', () => {
  const real = jest.requireActual('../../../src/services/hiddenGems') as typeof import('../../../src/services/hiddenGems');
  function answer(savedByMe: unknown) {
    process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test';
    (globalThis as any).fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ gem: { id: 'g1', name: 'x', status: 'active' }, guideProfile: null, savedByMe, ...(savedByMe === null ? { failedSources: ['hidden_gem_saves'] } : {}) }) }));
  }
  it('GD0 getGem: savedByMe null → null, never false', async () => {
    answer(null);
    expect((await real.getGem('g1')).savedByMe).toBeNull();
  });
  it('GD0c CONTROL: savedByMe true / false carried as measured', async () => {
    answer(true); expect((await real.getGem('g1')).savedByMe).toBe(true);
    answer(false); expect((await real.getGem('g1')).savedByMe).toBe(false);
  });
  it('GD1 useGemDetail: savedByMe null → null; toggleSave saves and unsaves nothing', async () => {
    (getGem as jest.Mock).mockResolvedValue({ gem: GEM, savedByMe: null, guideProfile: null });
    const { result } = await renderHook(() => useGemDetail('g1'));
    await waitFor(() => expect(result.current.gem?.id).toBe('g1'));
    expect(result.current.savedByMe).toBeNull();
    await act(async () => { await result.current.toggleSave(); });
    expect(saveGem).not.toHaveBeenCalled();
    expect(unsaveGem).not.toHaveBeenCalled();
    expect(result.current.savedByMe).toBeNull();
  });
});

// ── The screen: every heavy child stubbed; the hook mocked to the answer under test ──
const mockDetail = jest.fn();
jest.mock('../../../src/hooks/useHiddenGems', () => ({
  ...jest.requireActual('../../../src/hooks/useHiddenGems'),
  useGemDetail: (...a: unknown[]) => (mockDetail.getMockImplementation() ? mockDetail(...a) : jest.requireActual('../../../src/hooks/useHiddenGems').useGemDetail(...a)),
  useGemCheckin: () => ({ checkin: jest.fn(), loading: false, error: null, result: null }),
  useGemReport: () => ({ report: jest.fn(), loading: false, error: null, done: false }),
}));
jest.mock('expo-router', () => ({ ...jest.requireActual('expo-router'), useLocalSearchParams: () => ({ id: 'g1' }), useRouter: () => ({ push: jest.fn(), back: jest.fn() }) }));
jest.mock('react-native-safe-area-context', () => ({ ...jest.requireActual('react-native-safe-area-context'), useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock('../../../src/context/SessionContext', () => ({ ...jest.requireActual('../../../src/context/SessionContext'), useSession: () => ({ userId: 'u1', isAuthed: true }) }));
// NOTE: exhaustive on purpose — the screen imports only getCurrentGps from here.
jest.mock('../../../src/services/location', () => ({ getCurrentGps: jest.fn(async () => null) }));
// NOTE: exhaustive on purpose — getCanonicalPlace is the only export the screen reads; the real one fetches.
jest.mock('../../../src/services/places', () => ({ getCanonicalPlace: jest.fn(async () => null) }));
// NOTE: exhaustive on purpose — each stub below replaces a child that fetches or needs native modules; none bears on the bookmark.
jest.mock('../../../src/components/RouteBuilderSheet', () => ({ RouteBuilderSheet: () => null }));
// NOTE: exhaustive on purpose — see above.
jest.mock('../../../src/components/CachedImage', () => ({ CachedImage: () => null }));
// NOTE: exhaustive on purpose — see above.
jest.mock('../../../src/components/gems/GemContributeSection', () => ({ GemContributeSection: () => null }));
// NOTE: exhaustive on purpose — see above.
jest.mock('../../../src/components/discovery/TripWishlistPicker', () => ({ TripWishlistPicker: () => null }));
// NOTE: exhaustive on purpose — see above.
jest.mock('../../../src/components/gems/GemTripPlanPicker', () => ({ GemTripPlanPicker: () => null }));
// NOTE: exhaustive on purpose — see above.
jest.mock('../../../src/components/ReviewsSection', () => ({ ReviewsSection: () => null }));
// NOTE: exhaustive on purpose — see above.
jest.mock('../../../src/components/WorthItVoteRow', () => ({ WorthItVoteRow: () => null }));
// NOTE: exhaustive on purpose — see above.
jest.mock('../../../src/components/place/PlaceInfoSection', () => ({ PlaceInfoSection: () => null }));
// NOTE: exhaustive on purpose — see above.
jest.mock('../../../src/components/discovery/GemMapPreview', () => ({ GemMapPreview: () => null }));
// NOTE: exhaustive on purpose — see above.
jest.mock('../../../src/components/stamps/StampButton', () => ({ StampButton: () => null }));
// NOTE: exhaustive on purpose — see above.
jest.mock('../../../src/components/ReasonPromptModal', () => ({ ReasonPromptModal: () => null }));
// NOTE: exhaustive on purpose — see above.
jest.mock('../../../src/hooks/useNavBarCollapse', () => ({ useNavBarScrollHandler: () => undefined }));
import GemDetailScreen from '../[id].tsx';

describe('census-discovery §122 (B36): the gem detail screen over an unread save state', () => {
  const toggleSave = jest.fn();
  const detail = (savedByMe: boolean | null) => mockDetail.mockImplementation(() => ({ gem: GEM, savedByMe, guideProfile: null, loading: false, error: null, refresh: jest.fn(), toggleSave }));
  afterEach(() => mockDetail.mockReset());
  it('GD2 savedByMe null → "Couldn\'t check if saved", never "Save" or "Unsave"', async () => {
    detail(null);
    await render(<GemDetailScreen />);
    expect(screen.getByLabelText("Couldn't check if saved")).toBeTruthy();
    expect(screen.queryByLabelText('Save')).toBeNull();
    expect(screen.queryByLabelText('Unsave')).toBeNull();
    await fireEvent.press(screen.getByLabelText("Couldn't check if saved"));
    expect(toggleSave).not.toHaveBeenCalled();
  });
  it('GD2c CONTROL: savedByMe false → "Save"', async () => {
    detail(false);
    await render(<GemDetailScreen />);
    expect(screen.getByLabelText('Save')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Save'));
    expect(toggleSave).toHaveBeenCalledTimes(1);
  });
});
