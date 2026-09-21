/**
 * useCommunityDiscovery — the mapping half of census-discovery C19 / §6 D2.
 *
 * The hook is what turns a served `CommunityPlaceItem` into the `DiscoveryItem`
 * / `TravelerPick` shapes `DiscoveryWall` renders. Before this it copied the
 * LEGACY `submittedBy.name` straight through (`useCommunityDiscovery.ts:37`,
 * `:59` — the two lines §6 D2 names). That made the legacy field load-bearing
 * twice over: the wall rendered it raw, and the hook was the thing that put it
 * there.
 *
 * These tests pin the mapping at the canonical decision instead:
 *   - the byline the hook produces is resolved from (`displayName`, `handle`);
 *   - the canonical `displayName` is CARRIED THROUGH, so the card can re-resolve
 *     it rather than trust a string it was handed;
 *   - a `name` the server did not authorise never survives the mapping.
 *
 * Reachable from: Explore tab → `app/(tabs)/discovery.tsx` → `ForYouTab`
 * (`community = useCommunityDiscovery(destination, sortBy)`).
 *
 * Run with: pnpm test:component
 *
 * ## Mock strategy
 * Only `getCommunityPlaces` is stubbed — it is the hook's single dependency on
 * the network. Everything else is the real hook.
 */

import { renderHook, waitFor } from '@testing-library/react-native';

const mockGetCommunityPlaces = jest.fn();

// NOTE: exhaustive on purpose — spreading requireActual pulls in supabase/apiToken
// native deps at module load; useCommunityDiscovery imports only this one function
// (its other imports from the module are types, erased at runtime).
jest.mock('../../services/discovery.ts', () => ({
  getCommunityPlaces: (...args: unknown[]) => mockGetCommunityPlaces(...args),
}));

import { useCommunityDiscovery } from '../useCommunityDiscovery.ts';

/** One served row, in the shape `routes/discovery.ts` emits it. */
function servedItem(over: Record<string, unknown>) {
  return {
    id: 'p-1',
    city: 'Cebu City',
    name: 'Secret Falls Cafe',
    placeType: 'hidden_gem',
    category: 'hidden_gem',
    neighborhood: 'Lahug',
    blurb: 'Quiet spot behind the falls.',
    imageUrl: null,
    submittedBy: null,
    savedCount: 0,
    tag: null,
    note: '',
    rating: null,
    source: 'traveler',
    status: 'provisional',
    verified: false,
    createdAt: new Date().toISOString(),
    lat: null,
    lng: null,
    ...over,
  };
}

function resolveWith(items: unknown[]) {
  mockGetCommunityPlaces.mockResolvedValue({
    ok: true,
    data: { items, city: 'Cebu City', total: items.length },
  });
}

// The hook keeps a module-level stale-while-revalidate cache keyed by
// `${city}:${sortBy}` that deliberately survives unmount. Each test therefore
// uses its OWN city, so no case reads the previous case's cached state.
beforeEach(() => {
  mockGetCommunityPlaces.mockReset();
});

describe('useCommunityDiscovery — C19 byline mapping', () => {
  it('WITHHELD: maps the byline to the handle, dropping the unauthorised legacy name', async () => {
    const CITY = 'C19-withheld-city';
    resolveWith([
      servedItem({
        id: 'gem-withheld',
        submittedBy: { id: 'u1', name: 'Nikki Chen', displayName: null, avatarUrl: null, handle: 'nikki' },
      }),
    ]);

    const { result } = await renderHook(() => useCommunityDiscovery(CITY));
    await waitFor(() => expect(result.current.gems).toHaveLength(1));

    const by = result.current.gems[0].submittedBy;
    expect(by).toBeTruthy();
    expect(by!.name).toBe('@nikki');
    // Carried through so the card re-resolves the decision instead of trusting a string.
    expect((by as { displayName?: string | null }).displayName).toBeNull();
  });

  it('ALLOWED: maps the byline to the canonical displayName', async () => {
    const CITY = 'C19-allowed-city';
    resolveWith([
      servedItem({
        id: 'gem-allowed',
        submittedBy: { id: 'u2', name: '@nikki', displayName: 'Nikki Chen', avatarUrl: null, handle: 'nikki' },
      }),
    ]);

    const { result } = await renderHook(() => useCommunityDiscovery(CITY));
    await waitFor(() => expect(result.current.gems).toHaveLength(1));

    const by = result.current.gems[0].submittedBy;
    expect(by!.name).toBe('Nikki Chen');
    expect((by as { displayName?: string | null }).displayName).toBe('Nikki Chen');
  });

  it('TRAVELER PICK: the same rule on the pick byline', async () => {
    const CITY = 'C19-pick-city';
    resolveWith([
      servedItem({
        id: 'pick-withheld',
        placeType: 'traveler_pick',
        submittedBy: { id: 'u3', name: 'Nikki Chen', displayName: null, avatarUrl: null, handle: 'nikki' },
      }),
    ]);

    const { result } = await renderHook(() => useCommunityDiscovery(CITY));
    await waitFor(() => expect(result.current.picks).toHaveLength(1));

    expect(result.current.picks[0].user.name).toBe('@nikki');
  });

  it('LEGACY FIELD ABSENT: the mapping still produces a byline', async () => {
    // The wire once the server follow-up stops emitting the legacy field.
    const CITY = 'C19-nolegacy-city';
    resolveWith([
      servedItem({
        id: 'gem-nolegacy',
        submittedBy: { id: 'u4', displayName: null, avatarUrl: null, handle: 'nikki' },
      }),
    ]);

    const { result } = await renderHook(() => useCommunityDiscovery(CITY));
    await waitFor(() => expect(result.current.gems).toHaveLength(1));

    expect(result.current.gems[0].submittedBy!.name).toBe('@nikki');
  });
});
