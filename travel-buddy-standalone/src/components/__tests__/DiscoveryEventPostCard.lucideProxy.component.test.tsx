/**
 * DiscoveryEventPostCard — lucide Proxy sub-component coverage (#774)
 *
 * DiscoveryEventPostCard is rendered as a child component inside the Discovery
 * tab's "Live from events" strip.  Its lucide icons (MapPin, Music2) are
 * imported in the component file itself, not in this test file — so these
 * tests verify that the file-level Proxy in src/__mocks__/lucide-react-native.tsx
 * intercepts lucide named exports originating from a child component, not only
 * from the file that the test author wrote inline jest.mock calls for.
 *
 * A regression in the Proxy's get trap (e.g. broken cache key, wrong prototype
 * chain) would cause getByTestId('icon-Music2') or getByTestId('icon-MapPin')
 * to throw, making the failure immediately visible.
 *
 * Run with:  pnpm test:component
 */

import React from 'react';
import { render, waitFor } from '@testing-library/react-native';
import { DiscoveryEventPostCard } from '../discovery/DiscoveryEventPostCard.tsx';
import type { DiscoveryEventPost } from '../../types/discovery.ts';

// ── Sub-component stubs ───────────────────────────────────────────────────────

// NOTE: intentionally an exhaustive stub — DisplayMediaImage pulls in Expo's
// image module which requires native bridging unavailable under jest-expo.
// The Music2 icon asserted below comes from the badge section of the component
// directly, not from the fallbackIcon prop passed to DisplayMediaImage.
jest.mock('../ui/DisplayMediaImage', () => ({
  DisplayMediaImage: () => null,
  MediaFallback: () => null,
}));

// NOTE: intentionally an exhaustive stub — StampIcon pulls in the stamp
// Reanimated worklet chain which requires native bridging unavailable under jest.
jest.mock('../stamps/StampIcon', () => ({ StampIcon: () => null }));

// ── Fixture ───────────────────────────────────────────────────────────────────

/** Post with a linked event title (→ Music2 badge) and a city (→ MapPin footer). */
const POST_WITH_VENUE_AND_CITY: DiscoveryEventPost = {
  id: 'proxy-test-post-1',
  authorId: 'user-proxy-1',
  content: 'Great evening at the jazz venue!',
  mediaUrls: [],
  venueName: null,
  locationCity: 'Paris',          // triggers MapPin in footer
  publicLat: null,
  publicLng: null,
  createdAt: new Date(Date.now() - 3_600_000).toISOString(),
  likeCount: 0,
  commentCount: 0,
  linkedEventId: 'ev-1',
  linkedEventTitle: 'Jazz Night', // triggers Music2 badge
  venueLabel: null,
  sourceKind: 'event_link',
};

/** Post without a city — MapPin should be absent. */
const POST_NO_CITY: DiscoveryEventPost = {
  ...POST_WITH_VENUE_AND_CITY,
  id: 'proxy-test-post-2',
  locationCity: null,
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('DiscoveryEventPostCard — lucide Proxy sub-component coverage', () => {
  it('icon-Music2 resolves via the file-level Proxy — badge renders when linkedEventTitle is set', async () => {
    // DiscoveryEventPostCard (the child component) imports Music2 from lucide-react-native.
    // This test file does NOT add an inline jest.mock for lucide — the file-level
    // Proxy must cover the child's import automatically.
    const { getByTestId } = await render(
      <DiscoveryEventPostCard post={POST_WITH_VENUE_AND_CITY} />,
    );
    await waitFor(() => expect(getByTestId('icon-Music2')).toBeTruthy());
  });

  it('icon-MapPin resolves via the file-level Proxy — footer renders when locationCity is set', async () => {
    const { getByTestId } = await render(
      <DiscoveryEventPostCard post={POST_WITH_VENUE_AND_CITY} />,
    );
    await waitFor(() => expect(getByTestId('icon-MapPin')).toBeTruthy());
  });

  it('icon-MapPin is absent when locationCity is null', async () => {
    // Confirms the icon assertion above is sensitive to render conditions — not
    // a false positive from an always-visible element.
    const { queryByTestId } = await render(
      <DiscoveryEventPostCard post={POST_NO_CITY} />,
    );
    await waitFor(() => expect(queryByTestId('icon-MapPin')).toBeNull());
  });
});
