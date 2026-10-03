/**
 * census-discovery §122 (DV-83 round 23, lane W11-X2; sweep SW29): a Discovery search event result whose attendance
 * the server could not read is never drawn as "not going".
 *
 * `searchEvents` now serves `actionState: null` on an event result when the viewer's RSVP read fails (api-server
 * searchEventsAttendingUnread SE1); the card read `actionState?.isAttending ?? false` and drew "Join", stating the viewer
 * is not going. A result with no measured attendance now says "View" and opens the event, where the detail reads it;
 * it never RSVPs from an unknown state.
 *
 *   SR0 actionState null → "View", never "Join"; a tap opens the event, no RSVP
 *   SR1 CONTROL: isAttending false → "Join"; a tap RSVPs
 *   SR2 CONTROL: isAttending true → "Attending"
 */

import React from 'react';
import { render, fireEvent, act } from '@testing-library/react-native';
import { SearchResultCard } from '../SearchResultCard.tsx';
import type { UnifiedSearchResult } from '../SearchResultCard.tsx';

// ── Module mocks ──────────────────────────────────────────────────────────────

// NOTE: intentionally exhaustive — expo-router navigation internals are not
// safe under jest-expo; only router.push is used by this component.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() },
}));

// NOTE: intentionally exhaustive — spreading requireActual pulls in native
// font loader internals that crash under jest-expo.

// NOTE: intentionally exhaustive — UserAvatarButton imports supabase and
// native image modules; only the children passthrough is needed here.
jest.mock('../../interaction/UserAvatarButton.tsx', () => ({
  UserAvatarButton: ({ children }: any) => {
    const { View } = require('react-native');
    return <View testID="avatar-btn">{children ?? null}</View>;
  },
}));

// NOTE: intentionally exhaustive — follows service makes real fetch calls;
// none of the follow/unfollow actions are exercised in this test file.
jest.mock('../../../services/follows.ts', () => ({
  followUser:   jest.fn(),
  unfollowUser: jest.fn(),
}));
// NOTE: intentionally exhaustive — events service makes real fetch calls;
// rsvpEvent is the only export referenced by this component path.
jest.mock('../../../services/events.ts', () => ({
  rsvpEvent: jest.fn(),
}));
// NOTE: intentionally exhaustive — collections service makes real fetch calls;
// saveItem/unsaveItem are the only exports referenced by this component path.
jest.mock('../../../services/collections.ts', () => ({
  saveItem:   jest.fn(),
  unsaveItem: jest.fn(),
}));

// NOTE: intentionally exhaustive — searchNav re-exports TypeIcon which
// imports lucide icons; the global Proxy mock already handles lucide.
// We only need resolveRoute to return a valid route string.
jest.mock('../searchNav.tsx', () => ({
  TypeIcon:     () => null,
  resolveRoute: (result: any) => `/place/${result.id}`,
}));

// NOTE: intentionally exhaustive — AiRepresentationLabel uses lucide icons,
// Modal, and theme tokens; only the testID presence/absence is asserted here.
jest.mock('../../visuals/AiRepresentationLabel.tsx', () => ({
  AiRepresentationLabel: ({ testID }: any) => {
    const { View } = require('react-native');
    return <View testID={testID ?? 'ai-representation-label'} />;
  },
}));

// NOTE: intentionally exhaustive — fallbackAssets requires bundled image
// assets that are not available in the jest-expo environment; returning null
// here replicates what the resolver sees at test time and keeps the emoji
// fallback path active when imageUrl is also null.
jest.mock('../../../lib/visuals/fallbackAssets.ts', () => ({
  fallbackUriFor: () => null,
}));

import { router } from 'expo-router';
import { rsvpEvent } from '../../../services/events.ts';

function makeEventResult(overrides: Partial<UnifiedSearchResult> = {}): UnifiedSearchResult {
  return {
    id: 'event-1', type: 'events', title: 'Rooftop quiz', subtitle: 'Lisbon', avatarUrl: null, imageUrl: null,
    fallbackInitials: 'RQ', locationPreview: 'Lisbon, PT', matchedReason: null, actionState: { isAttending: false },
    privacyState: { isPublic: true }, accessState: { canAccess: true }, destinationRoute: '/event/event-1',
    metadata: { hostId: 'h1', status: 'open', lat: null, lng: null }, createdAt: null, startsAt: null,
    ...overrides,
  } as UnifiedSearchResult;
}

describe('census-discovery §122 (SW29): an event result with unknown attendance', () => {
  afterEach(() => jest.clearAllMocks());
  it('SR0 actionState null → "View", never "Join"; a tap opens the event, no RSVP', async () => {
    const r = await render(<SearchResultCard result={makeEventResult({ actionState: null })} />);
    expect(r.queryByText('Join')).toBeNull();
    expect(r.getByText('View')).toBeTruthy();
    await act(async () => { fireEvent.press(r.getByText('View')); });
    expect(rsvpEvent).not.toHaveBeenCalled();
    expect(router.push).toHaveBeenCalled();
  });
  it('SR1 CONTROL: isAttending false → "Join"; a tap RSVPs', async () => {
    (rsvpEvent as jest.Mock).mockResolvedValue({ ok: true, data: { status: 'going' } });
    const r = await render(<SearchResultCard result={makeEventResult()} />);
    await act(async () => { fireEvent.press(r.getByText('Join')); });
    expect(rsvpEvent).toHaveBeenCalledWith('event-1', 'going');
  });
  it('SR2 CONTROL: isAttending true → "Attending"', async () => {
    const r = await render(<SearchResultCard result={makeEventResult({ actionState: { isAttending: true } })} />);
    expect(r.getByText('Attending')).toBeTruthy();
  });
});
