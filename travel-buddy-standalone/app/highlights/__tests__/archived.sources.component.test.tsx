/**
 * §12 provenance is REACHABLE — it renders inside a screen the app mounts.
 *
 * Highlights/Memories Development Architecture Spec v1 §12. Census H93.
 *
 * WHY THIS SUITE EXISTS SEPARATELY FROM THE COMPONENT'S OWN. A census grades a
 * component that nothing renders as NOT-BUILT, not as built-but-wrong, and a
 * sibling census in this repository was burned by a 326-line screen that
 * nothing imported. `HighlightSourcesDisclosure` has its own suite, which
 * proves it behaves; this one proves it is on screen. The chain it closes is:
 *
 *   app/(tabs)/passport.tsx:29,906   mounts PassportOwnerMenuSheet
 *     → src/components/passport/PassportOwnerMenuSheet.tsx:142
 *         navigates to '/highlights/archived'
 *       → app/highlights/archived.tsx          (this screen)
 *         → src/components/highlights/HighlightSourcesDisclosure.tsx
 *           → src/hooks/useHighlightSources.ts
 *             → src/services/highlights.ts#fetchHighlightSources
 *               → GET /api/highlights/:id/sources
 *
 * It also pins the thing that makes the read safe on a LIST: the disclosure is
 * collapsed on mount, so no provenance request is issued for a row nobody
 * opened, and opening a second row closes the first.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';

// NOTE: intentionally exhaustive — expo-router's real module needs a navigator
// context this unit does not mount; the screen only calls back().
jest.mock('expo-router', () => ({
  router: { back: jest.fn(), push: jest.fn() },
  useLocalSearchParams: () => ({}),
}));

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// NOTE: intentionally exhaustive — DisplayMediaImage resolves through expo-image
// and the media cache, neither of which this suite exercises.
jest.mock('../../../src/components/ui/DisplayMediaImage', () => ({
  DisplayMediaImage: () => null,
  AvatarImage: () => null,
}));

const mockFetchArchived = jest.fn();
const mockUnarchive = jest.fn();
const mockFetchSources = jest.fn();
jest.mock('../../../src/services/highlights', () => ({
  ...jest.requireActual('../../../src/services/highlights'),
  fetchArchivedHighlights: () => mockFetchArchived(),
  unarchiveHighlight: (...a: unknown[]) => mockUnarchive(...a),
  fetchHighlightSources: (...a: unknown[]) => mockFetchSources(...a),
}));

import ArchivedHighlightsScreen from '../archived.tsx';
import type { Highlight } from '../../../src/services/highlights';

const A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const MEM = 'cccccccc-0000-4000-8000-00000000000c';

function archived(id: string, caption: string): Highlight {
  return {
    id,
    ownerId: 'me',
    mediaUrl: 'https://example.test/h.jpg',
    mediaType: 'image/jpeg',
    videoDurationSeconds: null,
    caption,
    locationName: null,
    locationCity: 'Hoi An',
    locationCountry: 'Vietnam',
    visibility: 'public',
    expiresAt: '2026-09-01T00:00:00.000Z',
    createdAt: '2026-08-30T00:00:00.000Z',
    deletedAt: null,
    author: null,
    viewCount: 0,
    likeCount: 0,
    viewedByMe: false,
    likedByMe: false,
    filterId: 'original',
    filterIntensity: 100,
    archivedAt: '2026-09-10T00:00:00.000Z',
  };
}

describe('§12 provenance on the archive screen', () => {
  beforeEach(() => {
    mockFetchArchived.mockReset();
    mockUnarchive.mockReset();
    mockFetchSources.mockReset();
  });

  it('offers the disclosure on every archived row', async () => {
    mockFetchArchived.mockResolvedValue({ ok: true, data: [archived(A, 'Lanterns'), archived(B, 'Rice fields')] });
    await render(<ArchivedHighlightsScreen />);

    expect(await screen.findByTestId(`highlight-sources-toggle-${A}`)).toBeTruthy();
    expect(screen.getByTestId(`highlight-sources-toggle-${B}`)).toBeTruthy();
  });

  it('asks NOTHING until a row is opened', async () => {
    mockFetchArchived.mockResolvedValue({ ok: true, data: [archived(A, 'Lanterns'), archived(B, 'Rice fields')] });
    await render(<ArchivedHighlightsScreen />);
    await screen.findByTestId(`highlight-sources-toggle-${A}`);

    // Two rows on screen, zero provenance requests. A list that fetched on
    // mount would issue one owner-scoped read per row for something nobody
    // asked for.
    expect(mockFetchSources).not.toHaveBeenCalled();
  });

  it('fetches and renders the sources for the row that was opened', async () => {
    mockFetchArchived.mockResolvedValue({ ok: true, data: [archived(A, 'Lanterns')] });
    mockFetchSources.mockResolvedValue({
      ok: true,
      data: [{ sourceType: 'MEMORY', sourceId: MEM, provenance: 'USER_ASSERTED', createdAt: null }],
    });

    await render(<ArchivedHighlightsScreen />);
    fireEvent.press(await screen.findByTestId(`highlight-sources-toggle-${A}`));

    await waitFor(() => expect(mockFetchSources).toHaveBeenCalledWith(A));
    expect(await screen.findByTestId(`highlight-sources-list-${A}`)).toBeTruthy();
    expect(screen.getByText('You said so')).toBeTruthy();
  });

  it('renders a refused provenance read as a refusal, not as "built from nothing"', async () => {
    mockFetchArchived.mockResolvedValue({ ok: true, data: [archived(A, 'Lanterns')] });
    mockFetchSources.mockResolvedValue({ ok: false, data: null, errorKind: 'degraded_unavailable' });

    await render(<ArchivedHighlightsScreen />);
    fireEvent.press(await screen.findByTestId(`highlight-sources-toggle-${A}`));

    expect(await screen.findByTestId(`highlight-sources-refused-${A}`)).toBeTruthy();
    expect(screen.queryByTestId(`highlight-sources-none-${A}`)).toBeNull();
  });

  it('closes the first row when a second is opened, so the reads cannot fan out', async () => {
    mockFetchArchived.mockResolvedValue({ ok: true, data: [archived(A, 'Lanterns'), archived(B, 'Rice fields')] });
    mockFetchSources.mockResolvedValue({ ok: true, data: [] });

    await render(<ArchivedHighlightsScreen />);
    fireEvent.press(await screen.findByTestId(`highlight-sources-toggle-${A}`));
    expect(await screen.findByTestId(`highlight-sources-none-${A}`)).toBeTruthy();

    fireEvent.press(screen.getByTestId(`highlight-sources-toggle-${B}`));
    await waitFor(() => expect(screen.queryByTestId(`highlight-sources-none-${A}`)).toBeNull());
    expect(await screen.findByTestId(`highlight-sources-none-${B}`)).toBeTruthy();
  });

  it('still offers no Delete — the disclosure did not smuggle one in', async () => {
    mockFetchArchived.mockResolvedValue({ ok: true, data: [archived(A, 'Lanterns')] });
    await render(<ArchivedHighlightsScreen />);
    await screen.findByTestId(`archived-highlight-${A}`);
    expect(screen.queryAllByText(/delete/i)).toHaveLength(0);
  });
});
