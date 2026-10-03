/**
 * census-discovery §114 (DV-83 round 17, lane W11-X2; sweep SW1): the Gems Discover list says a list the server cut.
 *
 * GET /hidden-gems sends `truncated: true` over a scan cut at its cap or a ranked list longer than the page
 * (D-W11X2-131); the privacy and Layover filters run AFTER that cut, so a cut read can hold no gem the viewer may see.
 * `listGems` answered only the array, so the Discover list said "No hidden gems found" over it, and drew a cut page as
 * the whole list (the round-16 verifier noted it; no client read the mark).
 *
 *   GL0  CONTROL: a whole, empty list → "No hidden gems found"
 *   GL1  a cut list with nothing in it → "Couldn't check every gem here", never "No hidden gems found"
 *   GL2  a cut list with rows → the rows, and "Showing some gems"
 *   GL3  the service marks a list the server said was cut (and not a whole one)
 *   GL5  the hook: a new query shows no old cut mark while it is read
 *   GL4  the hook: a refresh to a whole list clears the mark
 */
import React from 'react';
import { render, screen, waitFor, act, cleanup, renderHook } from '@testing-library/react-native';

// NOTE: exhaustive on purpose — the screen reads only useRouter from expo-router here; the spread keeps the rest.
jest.mock('expo-router', () => ({ ...jest.requireActual('expo-router'), useRouter: () => ({ push: jest.fn(), back: jest.fn() }) }));
jest.mock('react-native-safe-area-context', () => ({ ...jest.requireActual('react-native-safe-area-context'), useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
// NOTE: exhaustive on purpose — the screen reads only getCurrentGps from the location service.
jest.mock('../../../src/services/location', () => ({ getCurrentGps: jest.fn(async () => ({ granted: false, lat: null, lng: null, accuracyMeters: null, error: null })) }));
jest.mock('../../../src/services/hiddenGems', () => ({
  ...jest.requireActual('../../../src/services/hiddenGems'),
  listGems: jest.fn(async () => []), getSavedGems: jest.fn(async () => []), getLayoverGems: jest.fn(async () => []),
  listNearbyGems: jest.fn(async () => ({ gems: [], truncated: false })),
}));
import GemsScreen from '../index.tsx';
import { useGemList } from '../../../src/hooks/useHiddenGems';
import * as svc from '../../../src/services/hiddenGems';
import { markGemListCut, gemListCut } from '../../../src/services/gemListCut';

const listGems = svc.listGems as jest.Mock;
const gem = (id: string) => ({ id, name: `Gem ${id}`, category: 'food', city: 'Lisbon', country: null, neighborhood: null, description: null, lat: 38.73, lng: -9.15, coordsPrecision: 'exact', vibeTags: [], priceRange: null, safetyNotes: null, bestTimeToGo: null, localEtiquette: null, layoverSafe: false, minimumLayoverMinutes: null, sensitivityLevel: 'public', verificationLevel: 'guide', status: 'active', submittedBy: null, imageUrl: null, canonicalPlaceId: null, saveCount: 0, visitCount: 0, createdAt: '', updatedAt: '', gemState: null, gemConfidence: null, visitOutcomes: null });
afterEach(() => { cleanup(); jest.clearAllMocks(); });

async function open() {
  await render(<GemsScreen />);
  await waitFor(() => expect(listGems).toHaveBeenCalled());
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
}

describe('§114 SW1: the Gems Discover list says a cut list', () => {
  it('GL0 CONTROL: a whole, empty list → "No hidden gems found"', async () => {
    listGems.mockResolvedValue([]);
    await open();
    expect(screen.getByText('No hidden gems found')).toBeTruthy();
    expect(screen.queryByText("Couldn't check every gem here")).toBeNull();
  });

  it('GL1 a cut list with nothing in it → "Couldn\'t check every gem here", never "No hidden gems found"', async () => {
    listGems.mockImplementation(async () => markGemListCut([]));
    await open();
    expect(screen.getByText("Couldn't check every gem here")).toBeTruthy();
    expect(screen.queryByText('No hidden gems found')).toBeNull();
  });

  it('GL2 a cut list with rows → the rows, and "Showing some gems"', async () => {
    listGems.mockImplementation(async () => markGemListCut([gem('a'), gem('b')]));
    await open();
    expect(screen.getByText('Gem a')).toBeTruthy();
    expect(screen.getByText('Showing some gems')).toBeTruthy();
  });

  it('GL3 the service marks a list the server said was cut, and not a whole one', async () => {
    const real = jest.requireActual('../../../src/services/hiddenGems') as typeof svc;
    const fetchBefore = global.fetch;
    const raw = { id: 'g1', name: 'Gem g1', category: 'food', city: 'Lisbon' };
    try {
      global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ gems: [raw], truncated: true }) })) as any;
      const cut = await real.listGems({ city: 'Lisbon' });
      expect([cut.map((g) => g.id), gemListCut(cut)]).toEqual([['g1'], true]);
      global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ gems: [raw] }) })) as any;
      expect(gemListCut(await real.listGems({ city: 'Lisbon' }))).toBe(false);
    } finally { global.fetch = fetchBefore; }
  });

  it('GL4 the hook: a refresh to a whole list clears the mark', async () => {
    listGems.mockImplementationOnce(async () => markGemListCut([gem('a')]));
    const hook = await renderHook(() => useGemList({ city: 'Lisbon' }));
    await waitFor(() => expect(hook.result.current.truncated).toBe(true));
    listGems.mockResolvedValue([gem('a')]);
    await act(async () => { await hook.result.current.refresh(); });
    await waitFor(() => expect(hook.result.current.truncated).toBe(false));
  });

  it('GL5 the hook: a new query shows no old cut mark while it is read', async () => {
    listGems.mockImplementationOnce(async () => markGemListCut([gem('a')]));
    const hook = await renderHook((p: { city: string }) => useGemList({ city: p.city }), { initialProps: { city: 'Lisbon' } });
    await waitFor(() => expect(hook.result.current.truncated).toBe(true));
    listGems.mockImplementation(() => new Promise(() => {}));
    await hook.rerender({ city: 'Porto' });
    await waitFor(() => expect(hook.result.current.loading).toBe(true));
    expect(hook.result.current.truncated).toBe(false);
  });
});
