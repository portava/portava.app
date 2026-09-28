/**
 * §15 Memory search has an ENTRY POINT, and it is over the right corpus.
 *
 * Highlights/Memories Development Architecture Spec v1 §15 ("Memory Retrieval
 * and Search"). Census H110–H114.
 *
 * ── WHY THIS SCREEN AND NOT THE PASSPORT MEMORIES TAB ──────────────────────
 *
 * `/memory/search` was mounted and registered, and still reachable only by deep
 * link: nothing in the app navigated to it. The obvious-looking host — the
 * Memories tab on the Passport — is the WRONG one, and putting a search box
 * there would have been the two-disagreeing-vocabularies failure this
 * repository keeps hitting:
 *
 *   MemoriesTab renders `passport_memories` (`services/passportStamps.ts`,
 *   `PassportMemory`, fields like `earnedAt`). `POST /api/memories/search`
 *   searches derivatives of the `memories` album table. They are different
 *   tables with different ids. A search box on that tab would return hits the
 *   tab cannot render and whose ids its own rows do not share.
 *
 * `/memory/:id` IS the `memories` corpus: `getMemory` reads `GET
 * /api/memories/:id`, and `MemorySearchScreen`'s own results navigate back into
 * THIS screen (`app/memory/search.tsx` pushes `/memory/:memoryId`). Hosting the
 * affordance here closes that loop over one vocabulary — search, open a hit,
 * search again — instead of straddling two.
 *
 * WHAT THIS SUITE ASSERTS. A person on a Memory can reach §15 retrieval, and
 * the navigation goes to the search route rather than anywhere else. The
 * screen's own behaviour is
 * `src/features/memories/__tests__/MemorySearchScreen.component.test.tsx`; its
 * mount is `app/memory/__tests__/search.route.component.test.tsx`.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';

const mockPush = jest.fn();

// NOTE: intentionally exhaustive — expo-router's real module needs a navigator
// context this unit does not mount. The screen uses push/back/params/focus.
jest.mock('expo-router', () => ({
  router: { back: jest.fn(), push: (...a: unknown[]) => mockPush(...a) },
  useLocalSearchParams: () => ({ id: '33333333-3333-4333-8333-000000000001' }),
  useFocusEffect: (cb: () => void) => {
    const R = jest.requireActual('react') as typeof import('react');
    R.useEffect(() => { cb(); }, [cb]);
  },
}));

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// NOTE: intentionally exhaustive — CachedImage resolves through expo-image and
// the media cache, neither of which this suite exercises.
jest.mock('../../../src/components/CachedImage', () => ({ CachedImage: () => null }));

// NOTE: intentionally exhaustive — StampButton pulls the stamps service graph.
jest.mock('../../../src/components/stamps/StampButton', () => ({ StampButton: () => null }));

// NOTE: intentionally exhaustive — the real SessionContext provider starts auth
// and storage work on mount; this screen reads only useSession().
jest.mock('../../../src/context/SessionContext', () => ({
  useSession: () => ({ userId: 'me', isAuthed: true }),
}));

// NOTE: intentionally exhaustive — useMediaPicker reaches the native image
// picker, which the jest-expo runner has no module for.
jest.mock('../../../src/hooks/useMediaPicker.ts', () => ({
  useMediaPicker: () => ({ pickMedia: jest.fn(async () => []) }),
}));

// NOTE: intentionally exhaustive — the §32 telemetry hook posts on mount.
jest.mock('../../../src/features/passport/useMemoryViewedTelemetry.ts', () => ({
  useMemoryViewedTelemetry: () => {},
}));

const MEMORY = {
  id: '33333333-3333-4333-8333-000000000001',
  title: 'Three days in Hoi An',
  visibility: 'only_me',
  createdAt: '2026-09-01T00:00:00.000Z',
  owner: { id: 'me', name: 'Me', handle: 'me', avatarUrl: null },
  items: [],
  likeCount: 0,
  locationCity: null,
  locationCountry: null,
};

jest.mock('../../../src/services/memories', () => ({
  ...jest.requireActual('../../../src/services/memories'),
  getMemory: async () => ({ ok: true, memory: MEMORY }),
  deleteMemory: async () => ({ ok: true }),
  deleteMemoryItem: async () => ({ ok: true }),
  addMemoryItem: async () => ({ ok: true }),
}));

import MemoryDetailScreen from '../[id].tsx';

describe('§15 retrieval is reachable from the Memories corpus', () => {
  beforeEach(() => { mockPush.mockReset(); });

  it('offers a search affordance on the Memory screen', async () => {
    await render(<MemoryDetailScreen />);
    expect(await screen.findByTestId('memory-search-entry')).toBeTruthy();
  });

  it('navigates to /memory/search — the route over the SAME corpus this screen reads', async () => {
    await render(<MemoryDetailScreen />);
    fireEvent.press(await screen.findByTestId('memory-search-entry'));
    await waitFor(() => expect(mockPush).toHaveBeenCalled());
    // Not the Passport memories tab, and not a filtered public feed: the
    // owner's own `memories`, which is what `{ kind: 'mine' }` searches.
    expect(String(mockPush.mock.calls[0][0])).toBe('/memory/search');
  });
});
