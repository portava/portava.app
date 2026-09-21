/**
 * DiscoveryWall community byline — census-discovery C19 (the client half of §6 D2).
 *
 * THE REQUIREMENT
 * ===============
 * `.agents/memory/display-name-privacy.md`, as census-discovery C19 states it:
 * the canonical redaction shape is a NULL name plus a SEPARATE handle. The
 * server already emits it additively — `routes/discovery.ts` builds ONE
 * `nameAllowed` decision (self-exemption first, then opt-in) and gives it two
 * presentations: the canonical `displayName` (a real name iff allowed, else
 * null, NEVER a handle) and the legacy `name`, which bakes the literal
 * `@username` in when the name is withheld.
 *
 * `DiscoveryWall.tsx:407` rendered `By {gem.submittedBy.name}` — the legacy
 * field, raw. That pins the legacy shape in place: the server cannot stop
 * baking `@username` into `name` without blanking a live byline.
 *
 * WHAT THESE TESTS FIX THE CONTRACT AT
 * ====================================
 * The byline resolves from (`displayName`, `handle`) ONLY. The legacy `name`
 * is not read, so:
 *   - a `name` the server did not authorise (nameAllowed === false ⇒
 *     displayName === null) can never reach the screen — the privacy case, and
 *     the reason this is a requirement and not a nicety;
 *   - an EMPTY / absent legacy `name` (what the server follow-up will emit once
 *     the legacy field stops carrying `@username`) still renders a real byline
 *     rather than "By ".
 *
 * Reachable from: Explore tab → `app/(tabs)/discovery.tsx` → `ForYouTab` →
 * `HiddenGemsSection` / `TravelerPicksSection` (this file's two cards).
 *
 * Run with: pnpm test:component
 *
 * ## Mock strategy
 * Same seam as DiscoveryWall.livePill.component.test.tsx: services/discovery,
 * PlanPickerController, the highlight ring/viewer, the share sheet and
 * discoveryBookmarks are stubbed because they pull navigation/native deps that
 * have nothing to do with a byline string.
 */

import React from 'react';
import { render, screen } from '@testing-library/react-native';

// NOTE: exhaustive on purpose — spreading requireActual would pull in supabase/apiToken
// native deps; the cards only use these three exports.
jest.mock('../../services/discovery.ts', () => ({
  saveCommunityPlace: jest.fn(async () => ({ ok: true })),
  reportCommunityPlace: jest.fn(async () => ({ ok: true })),
  getPlaceLiveStatusCached: jest.fn(async () => null),
}));

// NOTE: exhaustive on purpose — the real provider needs navigation context; cards only call usePlanPicker.
jest.mock('../PlanPickerController.tsx', () => ({
  usePlanPicker: () => ({ open: jest.fn(), isAdded: () => false }),
}));

// NOTE: exhaustive on purpose — the real hook hits highlight services; null disables the ring.
jest.mock('../../hooks/useHighlightRingState.ts', () => ({
  useHighlightRingState: () => null,
}));

jest.mock('../HighlightRing.tsx', () => {
  const React = require('react');
  const { View } = require('react-native');
  return { HighlightRing: ({ children }: { children?: React.ReactNode }) => React.createElement(View, null, children) };
});

// NOTE: exhaustive on purpose — modal viewer irrelevant to the byline; render nothing.
jest.mock('../HighlightViewer.tsx', () => ({ HighlightViewer: () => null }));
// NOTE: exhaustive on purpose — share sheet pulls native share deps; render nothing.
jest.mock('../DiscoveryShareSheet.tsx', () => ({ DiscoveryShareSheet: () => null }));
// NOTE: exhaustive on purpose — only removeSaved is imported by DiscoveryWall.
jest.mock('../../services/discoveryBookmarks.ts', () => ({ removeSaved: jest.fn(async () => {}) }));

import { HiddenGemCard, TravelerPickCard } from '../DiscoveryWall.tsx';
import type { DiscoveryItem, TravelerPick } from '../../data/discovery.ts';

const BASE_GEM = {
  id: 'gem-1',
  name: 'Secret Falls Cafe',
  category: 'food',
  neighborhood: 'Lahug',
  city: 'Cebu City',
  blurb: 'A quiet spot behind the falls.',
  source: 'traveler',
  status: 'provisional',
  verified: false,
  savedCount: 0,
} as DiscoveryItem;

const BASE_PICK: TravelerPick = {
  id: 'tp-1',
  user: { name: 'Leo', avatarUrl: 'https://example.com/a.jpg', id: 'u1', handle: null },
  place: 'The Distillery Cebu',
  note: 'Great cocktails!',
  city: 'Cebu City',
  rating: 4.6,
  tag: 'Nightlife',
  timeAgo: '2h ago',
  source: 'traveler',
  status: 'provisional',
  verified: false,
  savedCount: 0,
};

/**
 * Built as a standalone value, not inline: the canonical `displayName` is not
 * on the legacy fixture type yet (`src/__fixtures__/discovery.ts` belongs to
 * another lane), and a fresh object literal would trip the excess-property
 * check. The wire DOES carry it — `routes/discovery.ts` emits it alongside
 * `name` from the one `nameAllowed` decision.
 */
function submitter(fields: { name: string; displayName: string | null; handle: string | null }) {
  return {
    id: 'u-sub-1',
    avatarUrl: 'https://example.com/a.jpg',
    name: fields.name,
    displayName: fields.displayName,
    handle: fields.handle,
  };
}

function gemWith(fields: { name: string; displayName: string | null; handle: string | null }): DiscoveryItem {
  return { ...BASE_GEM, submittedBy: submitter(fields) };
}

function pickWith(fields: { name: string; displayName: string | null; handle: string | null }): TravelerPick {
  return { ...BASE_PICK, user: submitter(fields) };
}

describe('HiddenGemCard byline — C19: resolved from (displayName, handle), never the legacy name', () => {
  it('WITHHELD: renders the handle, and never a real name the server did not authorise', async () => {
    // nameAllowed === false ⇒ displayName null. The legacy `name` here carries a
    // real name (the shape a partial server rollout, a stale cache entry or a
    // future regression can produce). Rendering it would leak exactly what the
    // `nameAllowed` decision withheld.
    await render(<HiddenGemCard gem={gemWith({ name: 'Nikki Chen', displayName: null, handle: 'nikki' })} />);

    expect(screen.getByText('By @nikki')).toBeTruthy();
    expect(screen.queryByText('By Nikki Chen')).toBeNull();
    expect(screen.queryByText(/Nikki Chen/)).toBeNull();
  });

  it('LEGACY FIELD EMPTY: still renders a byline (the server follow-up must not blank it)', async () => {
    // What the wire looks like once `name` stops carrying `@username`.
    await render(<HiddenGemCard gem={gemWith({ name: '', displayName: null, handle: 'nikki' })} />);

    expect(screen.getByText('By @nikki')).toBeTruthy();
  });

  it('ALLOWED: renders the canonical displayName, not the legacy handle-shaped name', async () => {
    await render(<HiddenGemCard gem={gemWith({ name: '@nikki', displayName: 'Nikki Chen', handle: 'nikki' })} />);

    expect(screen.getByText('By Nikki Chen')).toBeTruthy();
    expect(screen.queryByText('By @nikki')).toBeNull();
  });

  it('WITHHELD AND NO HANDLE: falls back to "Traveler", never to a blank byline', async () => {
    await render(<HiddenGemCard gem={gemWith({ name: '', displayName: null, handle: null })} />);

    expect(screen.getByText('By Traveler')).toBeTruthy();
  });
});

describe('TravelerPickCard byline — C19: the same one rule on the second byline', () => {
  it('WITHHELD: renders the handle, and never the unauthorised real name', async () => {
    await render(<TravelerPickCard pick={pickWith({ name: 'Nikki Chen', displayName: null, handle: 'nikki' })} />);

    expect(screen.getByText('@nikki')).toBeTruthy();
    expect(screen.queryByText(/Nikki Chen/)).toBeNull();
  });

  it('ALLOWED: renders the canonical displayName', async () => {
    await render(<TravelerPickCard pick={pickWith({ name: '@nikki', displayName: 'Nikki Chen', handle: 'nikki' })} />);

    expect(screen.getByText('Nikki Chen')).toBeTruthy();
    expect(screen.queryByText('@nikki')).toBeNull();
  });

  it('LEGACY FIELD EMPTY: still renders a byline', async () => {
    await render(<TravelerPickCard pick={pickWith({ name: '', displayName: null, handle: 'nikki' })} />);

    expect(screen.getByText('@nikki')).toBeTruthy();
  });
});
