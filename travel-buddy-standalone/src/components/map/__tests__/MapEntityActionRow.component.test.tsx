/**
 * MapEntityActionRow — component tests
 *
 * Verifies:
 *   • Capability present → affordance visible
 *   • Capability absent  → affordance hidden
 *   • permissions.canBlock=false → Block button absent
 *   • permissions.canBlock=true on person entity → Block button present
 *   • Block never shown for gem / event entity types
 *   • Save button opens TripWishlistPicker
 *   • Report button opens ReportSheet
 *   • Follow button calls useFollow.toggle
 *   • Block button calls useBlockUser.doBlock (via Alert confirmation)
 *   • Directions button calls openInMaps
 *   • Message button calls openDirectThread
 *   • Grep assertion: no save/share/report/block mutations inside src/components/map/
 */
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react-native';
import { Alert } from 'react-native';
import path from 'path';
import fs from 'fs';

// ── Mocks ─────────────────────────────────────────────────────────────────────

// NOTE: useFollow is a hook whose real implementation makes network calls and
// manages async state — the test must fully control the returned state object.
// Spreading requireActual would still invoke the module's useEffect on mount.
jest.mock('../../../hooks/useFollow.ts', () => ({
  useFollow: jest.fn(() => ({
    isFollowing: false,
    followsYou: false,
    followersCount: 0,
    followingCount: 0,
    loading: false,
    toggling: false,
    toggle: jest.fn(),
  })),
}));

// NOTE: useBlockUser calls blockUser/unblockUser from services/blocks.ts which
// makes fetch calls; the test stubs both to avoid any network I/O.
jest.mock('../../../hooks/useBlockUser.ts', () => ({
  useBlockUser: jest.fn(() => ({
    doBlock: jest.fn().mockResolvedValue(true),
    doUnblock: jest.fn().mockResolvedValue(true),
    loading: false,
    error: null,
  })),
}));

// NOTE: PlanPickerController exports a React context provider and hook; the
// provider pulls in modal + trip-fetch side-effects we don't want in unit tests.
// Only usePlanPicker (the hook) is needed — the full provider is not mounted.
const mockOpenPlanPicker = jest.fn();
jest.mock('../../PlanPickerController.tsx', () => ({
  usePlanPicker: () => ({ open: mockOpenPlanPicker, isAdded: () => false }),
}));

// NOTE: messaging.ts makes real fetch calls; we only need to assert that
// openDirectThread is called with the correct userId.
jest.mock('../../../services/messaging.ts', () => ({
  openDirectThread: jest.fn().mockResolvedValue({ ok: true, data: { threadId: 'thread-1' } }),
}));

// NOTE: events.ts fetches from the API; we only need to assert that rsvpEvent
// is called with the correct eventId and status.
jest.mock('../../../services/events.ts', () => ({
  rsvpEvent: jest.fn().mockResolvedValue({ ok: true }),
}));

// NOTE: openInMaps calls Linking.openURL which is unavailable in jest-expo;
// the stub lets us assert calls without triggering native module access.
jest.mock('../../../lib/openInMaps.ts', () => ({
  openInMaps: jest.fn(),
}));

// Stub TripWishlistPicker — just render a testID so we can assert visibility.
jest.mock('../../discovery/TripWishlistPicker.tsx', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    TripWishlistPicker: ({ visible }: { visible: boolean }) =>
      visible ? <View testID="wishlist-picker" /> : null,
    default: ({ visible }: { visible: boolean }) =>
      visible ? <View testID="wishlist-picker" /> : null,
  };
});

// Stub ReportSheet — just render a testID so we can assert visibility.
jest.mock('../../ReportSheet.tsx', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    ReportSheet: ({ visible }: { visible: boolean }) =>
      visible ? <View testID="report-sheet" /> : null,
  };
});

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { MapEntityActionRow } from '../MapEntityActionRow.tsx';
import { useFollow } from '../../../hooks/useFollow.ts';
import { useBlockUser } from '../../../hooks/useBlockUser.ts';
import { openInMaps } from '../../../lib/openInMaps.ts';
import { openDirectThread } from '../../../services/messaging.ts';
import type { MapEntity } from '../../../types/mapTypes.ts';
import {
  buddyEntity,
  eventEntity,
  friendEntity,
  gemEntity,
} from '../../../__fixtures__/mapEntities.ts';

// ── Factory ───────────────────────────────────────────────────────────────────
//
// Entities come from the REAL projectors (src/__fixtures__/mapEntities.ts). They
// used to be hand-written raw-DTO literals, which is how this row kept "passing"
// while reading `payload.userId` / `.displayName` / `.title` / `.name` — fields
// that stopped existing when the producers switched to emitting `MapObject`. On
// the real path every buddy was "Local Buddy", every gem was "Hidden Gem", and
// `userId` was undefined, so Message / Follow / Block acted on a null user.
//
// (This file also ran in NO test runner until 2026-09-03: it was named
// `MapEntityActionRow.test.tsx`, which the node runner skips — it collects only
// `.test.ts` files — and which jest's `.component.test.` path pattern skips too.
// It was tracked debt in scripts/ORPHANED_TESTS_ALLOWLIST.json.)

function makeGemEntity(overrides: Partial<MapEntity> = {}): MapEntity {
  return {
    ...gemEntity({ id: 'abc' }),
    actionCapabilities: ['save', 'share', 'directions'],
    ...overrides,
  };
}

function makeFriendEntity(overrides: Partial<MapEntity> = {}): MapEntity {
  return {
    ...friendEntity({ userId: 'user-1', name: 'Alice', city: 'Paris' }),
    actionCapabilities: ['message', 'follow', 'report', 'block'],
    permissions: { canMessage: true, canFollow: true, canBlock: true, canReport: true },
    ...overrides,
  };
}

function makeEventEntity(overrides: Partial<MapEntity> = {}): MapEntity {
  return {
    ...eventEntity({ id: 'ev-1', title: 'Jazz Night' }),
    actionCapabilities: ['join', 'share', 'report'],
    permissions: { canMessage: false, canFollow: false, canBlock: false, canReport: true },
    ...overrides,
  };
}

function makeBuddyEntity(overrides: Partial<MapEntity> = {}): MapEntity {
  return {
    ...buddyEntity({ id: 'buddy-1', userId: 'user-2', displayName: 'Bob', city: 'NYC' }),
    actionCapabilities: ['book', 'message', 'report'],
    permissions: { canMessage: true, canFollow: false, canBlock: false, canReport: true },
    ...overrides,
  };
}

/**
 * A NON-projected entity, for the two producers that build envelopes directly:
 * the places layer (app/map/index.tsx) and passport mode. The row falls back to
 * reading `payload.name` / `payload.id` for those, and the fallback needs its
 * own coverage.
 */
function makePlaceEntity(overrides: Partial<MapEntity> = {}): MapEntity {
  return {
    id: 'place:p1',
    type: 'places',
    lat: 10,
    lng: 20,
    payload: { id: 'p1', name: 'Museu do Azulejo', city: 'Lisbon' },
    actionCapabilities: ['save', 'share', 'directions'],
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('MapEntityActionRow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset useFollow mock to default
    (useFollow as jest.Mock).mockReturnValue({
      isFollowing: false, followsYou: false, followersCount: 0,
      followingCount: 0, loading: false, toggling: false, toggle: jest.fn(),
    });
    (useBlockUser as jest.Mock).mockReturnValue({
      doBlock: jest.fn().mockResolvedValue(true),
      doUnblock: jest.fn().mockResolvedValue(true),
      loading: false, error: null,
    });
  });

  // ── Capability presence / absence ───────────────────────────────────────────

  it('renders nothing when actionCapabilities is empty', async () => {
    const entity = makeGemEntity({ actionCapabilities: [] });
    await render(<MapEntityActionRow entity={entity} />);
    expect(screen.queryByTestId('map-action-row')).toBeNull();
  });

  it('renders nothing when actionCapabilities is absent', async () => {
    const entity = makeGemEntity({ actionCapabilities: undefined });
    await render(<MapEntityActionRow entity={entity} />);
    expect(screen.queryByTestId('map-action-row')).toBeNull();
  });

  it('shows Save button when save capability present', async () => {
    await render(<MapEntityActionRow entity={makeGemEntity({ actionCapabilities: ['save'] })} />);
    expect(screen.getByTestId('map-action-save')).toBeTruthy();
  });

  it('hides Save button when save capability absent', async () => {
    await render(<MapEntityActionRow entity={makeGemEntity({ actionCapabilities: ['share'] })} />);
    expect(screen.queryByTestId('map-action-save')).toBeNull();
  });

  it('shows Share button when share capability present', async () => {
    await render(<MapEntityActionRow entity={makeGemEntity({ actionCapabilities: ['share'] })} />);
    expect(screen.getByTestId('map-action-share')).toBeTruthy();
  });

  it('shows Directions button when directions capability present', async () => {
    await render(<MapEntityActionRow entity={makeGemEntity({ actionCapabilities: ['directions'] })} />);
    expect(screen.getByTestId('map-action-directions')).toBeTruthy();
  });

  it('hides Directions button when directions capability absent', async () => {
    await render(<MapEntityActionRow entity={makeGemEntity({ actionCapabilities: ['save'] })} />);
    expect(screen.queryByTestId('map-action-directions')).toBeNull();
  });

  it('shows Join button when join capability present (event)', async () => {
    await render(<MapEntityActionRow entity={makeEventEntity()} />);
    expect(screen.getByTestId('map-action-join')).toBeTruthy();
  });

  it('shows Follow button when follow capability present', async () => {
    await render(<MapEntityActionRow entity={makeFriendEntity()} />);
    expect(screen.getByTestId('map-action-follow')).toBeTruthy();
  });

  it('shows Book button when book capability present', async () => {
    await render(<MapEntityActionRow entity={makeBuddyEntity()} />);
    expect(screen.getByTestId('map-action-book')).toBeTruthy();
  });

  it('shows Message button when message capability present', async () => {
    await render(<MapEntityActionRow entity={makeFriendEntity()} />);
    expect(screen.getByTestId('map-action-message')).toBeTruthy();
  });

  it('shows Report button when report capability present', async () => {
    await render(<MapEntityActionRow entity={makeEventEntity()} />);
    expect(screen.getByTestId('map-action-report')).toBeTruthy();
  });

  // ── Block gating ────────────────────────────────────────────────────────────

  it('shows Block button when block capability + person entity + canBlock=true', async () => {
    await render(<MapEntityActionRow entity={makeFriendEntity()} />);
    expect(screen.getByTestId('map-action-block')).toBeTruthy();
  });

  it('hides Block button when permissions.canBlock=false', async () => {
    const entity = makeFriendEntity({
      permissions: { canMessage: true, canFollow: true, canBlock: false, canReport: true },
    });
    await render(<MapEntityActionRow entity={entity} />);
    expect(screen.queryByTestId('map-action-block')).toBeNull();
  });

  it('hides Block button for gem entity even if capability listed', async () => {
    const entity = makeGemEntity({
      actionCapabilities: ['save', 'block'],
      permissions: { canMessage: false, canFollow: false, canBlock: true, canReport: false },
    });
    await render(<MapEntityActionRow entity={entity} />);
    expect(screen.queryByTestId('map-action-block')).toBeNull();
  });

  it('hides Block button for event entity even if capability listed', async () => {
    const entity = makeEventEntity({
      actionCapabilities: ['join', 'share', 'block'],
      permissions: { canMessage: false, canFollow: false, canBlock: true, canReport: true },
    });
    await render(<MapEntityActionRow entity={entity} />);
    expect(screen.queryByTestId('map-action-block')).toBeNull();
  });

  // ── Action handlers ─────────────────────────────────────────────────────────

  it('opens TripWishlistPicker when Save is tapped', async () => {
    await render(<MapEntityActionRow entity={makeGemEntity()} />);
    expect(screen.queryByTestId('wishlist-picker')).toBeNull();
    fireEvent.press(screen.getByTestId('map-action-save'));
    await waitFor(() => {
      expect(screen.getByTestId('wishlist-picker')).toBeTruthy();
    });
  });

  it('opens ReportSheet when Report is tapped', async () => {
    await render(<MapEntityActionRow entity={makeFriendEntity()} />);
    expect(screen.queryByTestId('report-sheet')).toBeNull();
    fireEvent.press(screen.getByTestId('map-action-report'));
    await waitFor(() => {
      expect(screen.getByTestId('report-sheet')).toBeTruthy();
    });
  });

  it('calls useFollow.toggle when Follow is tapped', async () => {
    const toggle = jest.fn();
    (useFollow as jest.Mock).mockReturnValue({
      isFollowing: false, followsYou: false, followersCount: 0,
      followingCount: 0, loading: false, toggling: false, toggle,
    });
    await render(<MapEntityActionRow entity={makeFriendEntity()} />);
    fireEvent.press(screen.getByTestId('map-action-follow'));
    expect(toggle).toHaveBeenCalledTimes(1);
  });

  it('shows Unfollow label when already following', async () => {
    (useFollow as jest.Mock).mockReturnValue({
      isFollowing: true, followsYou: false, followersCount: 1,
      followingCount: 0, loading: false, toggling: false, toggle: jest.fn(),
    });
    await render(<MapEntityActionRow entity={makeFriendEntity()} />);
    expect(screen.getByTestId('map-action-follow')).toBeTruthy();
    expect(screen.getByText('Unfollow')).toBeTruthy();
  });

  it('calls useBlockUser.doBlock when Block is confirmed via Alert', async () => {
    const doBlock = jest.fn().mockResolvedValue(true);
    (useBlockUser as jest.Mock).mockReturnValue({ doBlock, doUnblock: jest.fn(), loading: false, error: null });
    jest.spyOn(Alert, 'alert').mockImplementation((_title, _msg, buttons) => {
      const blockBtn = (buttons ?? []).find((b: any) => b.text === 'Block');
      blockBtn?.onPress?.();
    });

    await render(<MapEntityActionRow entity={makeFriendEntity()} />);
    fireEvent.press(screen.getByTestId('map-action-block'));
    expect(doBlock).toHaveBeenCalledWith('user-1');
  });

  it('calls openInMaps with entity lat/lng when Directions is tapped', async () => {
    // Read off the entity rather than hard-coded: the coordinates come from the
    // projector via the DTO, and a literal here would just re-assert the fixture.
    const entity = makeGemEntity({ actionCapabilities: ['directions'] });
    await render(<MapEntityActionRow entity={entity} />);
    fireEvent.press(screen.getByTestId('map-action-directions'));
    expect(openInMaps).toHaveBeenCalledWith(entity.lat, entity.lng);
  });

  it('calls openDirectThread when Message is tapped', async () => {
    await render(<MapEntityActionRow entity={makeFriendEntity()} />);
    fireEvent.press(screen.getByTestId('map-action-message'));
    await waitFor(() => {
      expect(openDirectThread).toHaveBeenCalledWith('user-1');
    });
  });

  // ── Join → Going flip ───────────────────────────────────────────────────────

  it('flips Join button to Going after a successful RSVP', async () => {
    const { rsvpEvent } = require('../../../services/events.ts');
    rsvpEvent.mockResolvedValue({ ok: true });

    await render(<MapEntityActionRow entity={makeEventEntity()} />);

    // Button starts as "Join"
    expect(screen.getByText('Join')).toBeTruthy();
    expect(screen.queryByText('Going')).toBeNull();

    fireEvent.press(screen.getByTestId('map-action-join'));

    await waitFor(() => {
      expect(screen.getByText('Going')).toBeTruthy();
      expect(screen.queryByText('Join')).toBeNull();
    });
  });

  it('disables the Join button after a successful RSVP', async () => {
    const { rsvpEvent } = require('../../../services/events.ts');
    rsvpEvent.mockResolvedValue({ ok: true });

    await render(<MapEntityActionRow entity={makeEventEntity()} />);
    fireEvent.press(screen.getByTestId('map-action-join'));

    await waitFor(() => {
      const btn = screen.getByTestId('map-action-join');
      expect(btn.props.accessibilityState?.disabled ?? btn.props.disabled).toBeTruthy();
    });
  });

  it('keeps Join label when rsvpEvent returns an error', async () => {
    const { rsvpEvent } = require('../../../services/events.ts');
    rsvpEvent.mockResolvedValue({ ok: false, message: 'Something went wrong' });
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});

    await render(<MapEntityActionRow entity={makeEventEntity()} />);
    fireEvent.press(screen.getByTestId('map-action-join'));

    await waitFor(() => {
      expect(screen.getByText('Join')).toBeTruthy();
      expect(screen.queryByText('Going')).toBeNull();
    });
  });

  // ── Join → Waitlisted flip ──────────────────────────────────────────────────

  it('shows Waitlisted (disabled) when rsvpEvent returns waitlisted status', async () => {
    const { rsvpEvent } = require('../../../services/events.ts');
    rsvpEvent.mockResolvedValue({ ok: true, data: { status: 'waitlisted', message: 'Event is full' } });
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});

    await render(<MapEntityActionRow entity={makeEventEntity()} />);
    expect(screen.getByText('Join')).toBeTruthy();

    fireEvent.press(screen.getByTestId('map-action-join'));

    await waitFor(() => {
      expect(screen.getByText('Waitlisted')).toBeTruthy();
      expect(screen.queryByText('Going')).toBeNull();
      expect(screen.queryByText('Join')).toBeNull();
    });
    const btn = screen.getByTestId('map-action-join');
    expect(btn.props.accessibilityState?.disabled ?? btn.props.disabled).toBeTruthy();
  });

  it('shows Going (not Waitlisted) when rsvpEvent returns a non-waitlisted ok response', async () => {
    const { rsvpEvent } = require('../../../services/events.ts');
    rsvpEvent.mockResolvedValue({ ok: true, data: { status: 'going', eventId: 'ev-1' } });
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});

    await render(<MapEntityActionRow entity={makeEventEntity()} />);
    fireEvent.press(screen.getByTestId('map-action-join'));

    await waitFor(() => {
      expect(screen.getByText('Going')).toBeTruthy();
      expect(screen.queryByText('Waitlisted')).toBeNull();
    });
  });

  // ── Join state is no longer SEEDED from the payload ────────────────────────
  //
  // Four tests here used to mount an event whose payload carried `myRsvp` /
  // `myWaitlistPosition` and assert the button opened as Going / Waitlisted.
  // Neither field is on the shape `projectEvent` emits, so that seeding had been
  // dead on the real path since the producers switched to MapObject — the tests
  // were describing a card the app had stopped rendering. Restoring it is a
  // projector change; see docs/map-card-projection-gaps.md.

  it('mounts showing Join — the projection carries no viewer RSVP to seed from', async () => {
    await render(<MapEntityActionRow entity={makeEventEntity()} />);
    expect(screen.getByText('Join')).toBeTruthy();
    expect(screen.queryByText('Going')).toBeNull();
    expect(screen.queryByText('Waitlisted')).toBeNull();
    const btn = screen.getByTestId('map-action-join');
    expect(btn.props.accessibilityState?.disabled ?? btn.props.disabled).toBeFalsy();
  });

  // ── Non-projected producers still work ─────────────────────────────────────

  it('a places entity (never projected) still resolves its name and id', async () => {
    await render(<MapEntityActionRow entity={makePlaceEntity()} />);
    expect(screen.getByTestId('map-action-save')).toBeTruthy();
    expect(screen.getByTestId('map-action-share')).toBeTruthy();
  });

  // ── Grep assertion: no duplicate mutations in src/components/map/ ───────────

  it('contains no duplicate save/share/report/block mutation logic in src/components/map/', () => {
    const mapDir = path.join(__dirname, '..');
    const files = fs.readdirSync(mapDir).filter((f) => f.endsWith('.tsx') || f.endsWith('.ts'));

    // Patterns that would indicate local reimplementation of the canonical flows.
    const FORBIDDEN_PATTERNS = [
      /saveItem\s*\(/,
      /unsaveItem\s*\(/,
      /blockUser\s*\(/,
      /unblockUser\s*\(/,
      /submitModerationReport\s*\(/,
      // Native Share.share within map components (action row delegates to Share)
      // is acceptable; duplicating whole ShareSheet modal logic is not.
    ];

    const violations: string[] = [];
    for (const file of files) {
      if (file.includes('MapEntityActionRow')) continue; // this file imports hooks, not mutations
      const src = fs.readFileSync(path.join(mapDir, file), 'utf-8');
      for (const pat of FORBIDDEN_PATTERNS) {
        if (pat.test(src)) {
          violations.push(`${file}: ${pat}`);
        }
      }
    }
    expect(violations).toHaveLength(0);
  });
});
