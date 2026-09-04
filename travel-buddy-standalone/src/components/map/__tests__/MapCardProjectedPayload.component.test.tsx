/**
 * Map cards read the PROJECTED payload — regression guard.
 *
 * THE BUG THIS EXISTS FOR
 * =======================
 * `MapEntity.payload` used to be a raw service DTO. When the producers switched
 * to the §18 contract it became a `MapObject`, and the card renderers kept
 * reading the old field names through `as BuddyProfile`-style casts, which meant
 * the compiler agreed with them. Two of those reads did not merely return
 * undefined — they THREW, taking the whole card down:
 *
 *     trip.visibility.replace('_', ' ')     →  TypeError on undefined
 *     buddy.categories.slice(0, 2)          →  TypeError on undefined
 *
 * and a third, `gem.category.replace('_', ' ')`, threw the same way.
 *
 * Nothing caught it because the only carousel test built its fixtures in the old
 * raw-DTO shape — the shape the producer had stopped emitting. So every fixture
 * here is built by the REAL projectors (src/__fixtures__/mapEntities.ts).
 *
 * MUTATION PROOF
 * ==============
 * Every assertion below is on a value that ONLY exists on the projected object.
 * Reverting any card body to its raw-DTO read makes the corresponding test fail:
 * the throwing reads throw, and the non-throwing ones render the generic
 * fallback ("Local Buddy", "Circle member", an empty title) instead of the value
 * asserted here.
 */

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { MapStoreProvider } from '../../../stores/mapStore.tsx';
import { MapEntityCard } from '../MapCarousel.tsx';
import { MapEntityPreviewCard } from '../MapEntityPreviewCard.tsx';
import { useSharedValue } from 'react-native-reanimated';
import type { MapEntity } from '../../../types/mapTypes.ts';
import { mapObjectToEntity } from '../../../types/mapTypes.ts';
import { projectCompassResult } from '../../../features/map/projection/clientProjection.ts';
import {
  buddyEntity,
  eventEntity,
  friendEntity,
  gemEntity,
  tripEntity,
} from '../../../__fixtures__/mapEntities.ts';

// ── Module mocks ───────────────────────────────────────────────────────────────

// NOTE: intentional stub — expo-router requires native modules not available under
// jest-expo; spreading requireActual pulls in those modules and crashes the suite.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() },
  useRouter: () => ({ push: jest.fn(), back: jest.fn() }),
  useLocalSearchParams: () => ({}),
  usePathname: () => '/',
  useSegments: () => [],
  useFocusEffect: () => {},
  useNavigation: () => ({
    navigate: jest.fn(),
    goBack: jest.fn(),
    setOptions: jest.fn(),
    addListener: () => () => {},
  }),
  Link: ({ children }: any) => children,
  Redirect: () => null,
  Stack: { Screen: () => null },
  Tabs: { Screen: () => null },
}));

// NOTE: openDirectThread makes live Supabase fetch calls; stub here to prevent
// network I/O and keep the test deterministic.
jest.mock('../../../services/messaging.ts', () => ({
  openDirectThread: jest.fn().mockResolvedValue({ ok: false }),
}));

// NOTE: rsvpEvent hits the API; stub to avoid network calls.
jest.mock('../../../services/events.ts', () => ({
  rsvpEvent: jest.fn().mockResolvedValue({ ok: true }),
}));

// NOTE: openInMaps calls Linking.openURL — unavailable in jest-expo.
jest.mock('../../../lib/openInMaps.ts', () => ({
  openInMaps: jest.fn(),
}));

// NOTE: useFollow manages async follow-state and makes API calls; fully stub so
// no network I/O and the hook returns a stable shape on every render.
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

// NOTE: useBlockUser calls blockUser/unblockUser which make fetch calls.
jest.mock('../../../hooks/useBlockUser.ts', () => ({
  useBlockUser: jest.fn(() => ({
    doBlock: jest.fn().mockResolvedValue(true),
    doUnblock: jest.fn().mockResolvedValue(true),
    loading: false,
    error: null,
  })),
}));

// NOTE: usePlanPicker opens a modal backed by trip data fetching; stub the hook.
jest.mock('../../PlanPickerController.tsx', () => ({
  usePlanPicker: () => ({ open: jest.fn(), isAdded: () => false }),
}));

// NOTE: TripWishlistPicker fetches trip data on open; render a testID stub.
jest.mock('../../discovery/TripWishlistPicker.tsx', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    TripWishlistPicker: ({ visible }: { visible: boolean }) =>
      visible ? <View testID="wishlist-picker" /> : null,
  };
});

// NOTE: ReportSheet makes moderation API calls; render a testID stub.
jest.mock('../../ReportSheet.tsx', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    ReportSheet: ({ visible }: { visible: boolean }) =>
      visible ? <View testID="report-sheet" /> : null,
  };
});

// ── Harness ───────────────────────────────────────────────────────────────────

/**
 * MapEntityCard needs a Reanimated shared value for the scroll interpolation;
 * a hook cannot be called at module scope, so it is created inside a wrapper.
 */
function Card({ entity }: { entity: MapEntity }) {
  const scrollX = useSharedValue(0);
  return (
    <MapEntityCard entity={entity} index={0} scrollX={scrollX} onPress={jest.fn()} />
  );
}

function renderCard(entity: MapEntity) {
  return render(
    <MapStoreProvider>
      <Card entity={entity} />
    </MapStoreProvider>,
  );
}

function renderPreview(entity: MapEntity) {
  return render(
    <MapStoreProvider>
      <MapEntityPreviewCard entity={entity} onClose={jest.fn()} />
    </MapStoreProvider>,
  );
}

// ── 1. The two reads that THREW ───────────────────────────────────────────────

describe('the reads that threw on a projected payload', () => {
  // `trip.visibility.replace('_', ' ')`
  it('carousel: a trip card renders its visibility without throwing', async () => {
    await renderCard(tripEntity({ visibility: 'buddies' }));
    expect(screen.getByText('buddies')).toBeTruthy();
  });

  it('preview: a trip card renders its visibility without throwing', async () => {
    await renderPreview(tripEntity({ visibility: 'private' }));
    expect(screen.getByText('private')).toBeTruthy();
  });

  it('a trip with no projected visibility renders the card anyway', async () => {
    // The throw was on `undefined.replace`, so the absence case is the one that
    // has to be proven, not just the present one.
    const entity = tripEntity();
    const obj = { ...entity.payload, payload: { ...(entity.payload as any).payload, visibility: null } };
    await renderCard({ ...entity, payload: obj });
    expect(screen.getByText('Songkran')).toBeTruthy();
  });

  // `buddy.categories.slice(0, 2)`
  it('carousel: a buddy card renders its categories without throwing', async () => {
    await renderCard(buddyEntity());
    expect(screen.getByText('food · culture')).toBeTruthy();
  });

  it('preview: a buddy card renders its categories without throwing', async () => {
    await renderPreview(buddyEntity());
    expect(screen.getByText('food · culture')).toBeTruthy();
  });

  it('a buddy with no projected categories renders the card anyway', async () => {
    await renderCard(buddyEntity({ categories: [] }));
    expect(screen.getByText('Ana Costa')).toBeTruthy();
  });

  // `gem.category.replace('_', ' ')` — the same shape of throw, third instance.
  it('carousel: a gem card renders its category line without throwing', async () => {
    await renderCard(gemEntity());
    expect(screen.getByText('viewpoint · Da Nang')).toBeTruthy();
  });

  it('preview: a gem card renders its category line without throwing', async () => {
    await renderPreview(gemEntity());
    expect(screen.getByText('viewpoint · Da Nang')).toBeTruthy();
  });
});

// ── 2. Titles come from the projection ────────────────────────────────────────

describe('titles are the projector-supplied title, not a raw DTO field', () => {
  const cases: Array<[string, MapEntity, string]> = [
    ['buddy', buddyEntity(), 'Ana Costa'],
    ['trip', tripEntity(), 'Songkran'],
    ['friend', friendEntity(), 'Rui'],
    ['gem', gemEntity(), 'Rooftop stairwell'],
    ['event', eventEntity(), 'Evening Jazz at Alfama'],
  ];

  for (const [name, entity, title] of cases) {
    it(`carousel: the ${name} card shows "${title}"`, async () => {
      await renderCard(entity);
      // Reading the raw DTO instead yields the generic fallback for this layer
      // ("Local Buddy", "Circle member", …) or an empty title — never this.
      expect(screen.getAllByText(title).length).toBeGreaterThan(0);
    });

    it(`preview: the ${name} card shows "${title}"`, async () => {
      await renderPreview(entity);
      expect(screen.getAllByText(title).length).toBeGreaterThan(0);
    });
  }

  it('a circle member is named, not labelled "Friend"', async () => {
    // projectFriend used to read `loc.displayName ?? loc.handle`, neither of
    // which CircleMemberLocation has, so EVERY circle pin read "Friend".
    await renderCard(friendEntity({ name: 'Hanna' }));
    expect(screen.getByText('Hanna')).toBeTruthy();
    expect(screen.queryByText('Friend')).toBeNull();
  });
});

// ── 3. Detail routes come from the projection ─────────────────────────────────

describe('detail routes', () => {
  it('a buddy CTA uses the LISTING id, never the namespaced object id', async () => {
    const { router } = require('expo-router');
    router.push.mockClear();
    const { getByText } = await renderPreview(buddyEntity({ id: 'b-77' }));
    fireEvent.press(getByText('View Buddy Profile'));
    // The push is deferred past the sheet's close animation — see closeThenNavigate.
    await waitFor(() => expect(router.push).toHaveBeenCalledTimes(1));
    expect(router.push).toHaveBeenCalledWith('/(rent-a-buddy)/buddy/b-77');
    expect(router.push).not.toHaveBeenCalledWith(expect.stringContaining('buddy:'));
  });
});

// ── 4. Every projected kind renders ───────────────────────────────────────────

describe('no projected kind crashes a card', () => {
  const all: Array<[string, MapEntity]> = [
    ['buddy', buddyEntity()],
    ['trip', tripEntity()],
    ['friend', friendEntity()],
    ['gem', gemEntity()],
    ['event', eventEntity()],
  ];

  for (const [name, entity] of all) {
    it(`carousel: ${name}`, async () => {
      await expect(renderCard(entity)).resolves.toBeTruthy();
    });
    it(`preview: ${name}`, async () => {
      await expect(renderPreview(entity)).resolves.toBeTruthy();
    });
  }

  // A Compass result is a THIRD producer. It used to hand the raw
  // CompassRecommendation through, which is how a Compass buddy or trip result
  // hit `categories.slice` / `visibility.replace` and took the card down.
  const compassKinds = ['buddy', 'trip', 'hidden_gem', 'event', 'friend', 'place'];
  for (const type of compassKinds) {
    it(`carousel: a Compass ${type} result renders from title + subtitle`, async () => {
      const obj = projectCompassResult({
        id: `rec-${type}`,
        type,
        category: 'city',
        title: 'Compass suggestion',
        reason: 'Near you',
        city: 'Lisbon',
        data: { lat: 38.7, lng: -9.1 },
      });
      expect(obj).not.toBeNull();
      const entity = mapObjectToEntity(obj!)!;
      await renderCard(entity);
      expect(screen.getByText('Compass suggestion')).toBeTruthy();
    });
  }
});

// ── 5. Event live-state comes from the projector, not a client re-derivation ──

describe('event LIVE state', () => {
  // The card no longer recomputes "has this started" from raw timestamps — it
  // reads the projector's `hasStarted`, bounded by the object's own `expiresAt`.
  it('is on when the projector marked the event started and it has not expired', async () => {
    // eventDto starts before FIXTURE_NOW, so projectEventLocal sets hasStarted.
    await renderCard(eventEntity({ endsAt: '2099-01-01T00:00:00.000Z' }));
    expect(screen.getByText('LIVE')).toBeTruthy();
  });

  it('is off when the projector marked it not yet started', async () => {
    await renderCard(eventEntity({ startsAt: '2026-09-30T20:00:00.000Z' }));
    expect(screen.queryByText('LIVE')).toBeNull();
  });

  it('is off once the object has expired, even though it did start', async () => {
    // §37: "Do not let stale claims remain visually live."
    await renderCard(eventEntity({ endsAt: '2026-08-31T23:00:00.000Z' }));
    expect(screen.queryByText('LIVE')).toBeNull();
  });
});
