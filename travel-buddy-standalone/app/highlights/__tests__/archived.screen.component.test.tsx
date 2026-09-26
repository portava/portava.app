/**
 * §21 Archive has a way BACK — otherwise it is a delete with a softer word.
 *
 * Highlights/Memories Development Architecture Spec v1 §21: Archive means
 * "retain canonical Memory; remove from normal browsing unless EXPLICITLY
 * REQUESTED", and Delete / Archive / do-not-resurface / do-not-personalize
 * "must remain separate in both data model and UX".
 *
 * `POST|DELETE /highlights/:id/archive` and `GET /highlights/archived` were
 * built and route-tested on the server and called by NOTHING in this client.
 * Two halves were therefore missing at once: an owner could not archive, and —
 * the sharper one — there was no surface on which an archived Highlight could
 * be explicitly requested, so archiving would have been irreversible from
 * inside the app.
 *
 * WHAT THIS SUITE ASSERTS:
 *   - the archive is listed and each row can be restored;
 *   - restoring follows the SERVER's answer, not the tap;
 *   - a FAILED read renders as a failure with a retry — never as "you have
 *     archived nothing". The route refuses with `degraded_unavailable` for
 *     precisely this reason, and a screen that flattened it into an empty list
 *     would tell an owner their retained record was gone.
 *   - the screen offers no Delete. §21's separation is a UX requirement.
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
jest.mock('../../../src/services/highlights', () => ({
  ...jest.requireActual('../../../src/services/highlights'),
  fetchArchivedHighlights: () => mockFetchArchived(),
  unarchiveHighlight: (...a: unknown[]) => mockUnarchive(...a),
}));

import ArchivedHighlightsScreen from '../archived.tsx';
import type { Highlight } from '../../../src/services/highlights';

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';

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

describe('§21 the archive is explicitly requestable', () => {
  beforeEach(() => {
    mockFetchArchived.mockReset();
    mockUnarchive.mockReset();
  });

  it('lists what the owner archived', async () => {
    mockFetchArchived.mockResolvedValue({ ok: true, data: [archived(A, 'Lanterns'), archived(B, 'Rice fields')] });
    await render(<ArchivedHighlightsScreen />);
    expect(await screen.findByTestId(`archived-highlight-${A}`)).toBeTruthy();
    expect(await screen.findByTestId(`archived-highlight-${B}`)).toBeTruthy();
  });

  it('restores one through DELETE /highlights/:id/archive, following the server', async () => {
    mockFetchArchived.mockResolvedValue({ ok: true, data: [archived(A, 'Lanterns'), archived(B, 'Rice fields')] });
    mockUnarchive.mockResolvedValue({ ok: true, data: { id: A, archivedAt: null } });

    await render(<ArchivedHighlightsScreen />);
    fireEvent.press(await screen.findByTestId(`archived-highlight-restore-${A}`));

    await waitFor(() => expect(mockUnarchive).toHaveBeenCalledWith(A));
    await waitFor(() => expect(screen.queryByTestId(`archived-highlight-${A}`)).toBeNull());
    // The other one is untouched — a restore is one row, not a page reset.
    expect(screen.queryByTestId(`archived-highlight-${B}`)).toBeTruthy();
  });

  it('keeps a refused restore in the list', async () => {
    mockFetchArchived.mockResolvedValue({ ok: true, data: [archived(A, 'Lanterns')] });
    mockUnarchive.mockResolvedValue({ ok: false, data: null, errorKind: 'degraded_unavailable' });

    await render(<ArchivedHighlightsScreen />);
    fireEvent.press(await screen.findByTestId(`archived-highlight-restore-${A}`));

    await waitFor(() => expect(mockUnarchive).toHaveBeenCalled());
    // A row that vanished on a refused write would tell the owner it was
    // restored when nothing was written.
    expect(screen.queryByTestId(`archived-highlight-${A}`)).toBeTruthy();
  });

  it('renders a FAILED read as a failure, never as an empty archive', async () => {
    mockFetchArchived.mockResolvedValue({ ok: false, data: null, errorKind: 'degraded_unavailable' });
    await render(<ArchivedHighlightsScreen />);

    expect(await screen.findByTestId('archived-highlights-unavailable')).toBeTruthy();
    // "Nothing archived" for an outage is the §28.11 defect this screen was
    // written around.
    expect(screen.queryByTestId('archived-highlights-empty')).toBeNull();
    expect(screen.queryByTestId('archived-highlights-list')).toBeNull();
    expect(screen.getByTestId('archived-highlights-retry')).toBeTruthy();
  });

  it('says the archive is empty only when the server said so', async () => {
    mockFetchArchived.mockResolvedValue({ ok: true, data: [] });
    await render(<ArchivedHighlightsScreen />);
    expect(await screen.findByTestId('archived-highlights-empty')).toBeTruthy();
    expect(screen.queryByTestId('archived-highlights-unavailable')).toBeNull();
  });

  it('offers no Delete — §21 keeps archive and delete separate in the UX too', async () => {
    mockFetchArchived.mockResolvedValue({ ok: true, data: [archived(A, 'Lanterns')] });
    await render(<ArchivedHighlightsScreen />);
    await screen.findByTestId(`archived-highlight-${A}`);
    expect(screen.queryAllByText(/delete/i)).toHaveLength(0);
  });
});
