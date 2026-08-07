/**
 * SharedEntityCard — §19 canonical in-message card.
 *
 * Run: pnpm test:component -- --testPathPattern=SharedEntityCard
 *
 * Covers:
 *   A. routing to the canonical in-app route, including the two redirects
 *   B. the no-route case rendering as static content, not a dead button
 *   C. surface variants (Telegraph `mine`, footer slot, onPress override)
 *   D. §23 accessibility and touch targets
 */
import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import { Text } from 'react-native';
import { router } from 'expo-router';
import { SharedEntityCard } from '../SharedEntityCard.tsx';
import {
  toShareableTrip, toShareablePostcard, toShareableProfile,
  toShareableCompassRecommendation, toShareableStamp, appRouteFor,
} from '../../../services/shareAdapters.ts';
import type { ShareableEntity } from '../../../types/models.ts';

// NOTE: intentionally exhaustive — safe-area context reads native config
// unavailable under Jest.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// NOTE: intentionally exhaustive — expo-router's real push would need a
// navigation container; only the call is under test here.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn() },
}));

const push = router.push as unknown as jest.Mock;
beforeEach(() => push.mockClear());

const ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const trip = toShareableTrip({
  id: ID, title: 'Thailand 2026', destinationCity: 'Bangkok', destinationCountry: 'Thailand',
  neighborhoods: [], startDate: '2026-08-18', endDate: '2026-08-27', nights: 9,
  status: 'planning', visibility: 'public', travelStyle: 'solo', openToMeet: true,
  coverUrl: null, progress: 0, progressSteps: [], timeline: [],
  savedIdeas: [], safetyStatus: 'ok', tripNotes: null,
} as never);

const postcard = toShareablePostcard({
  id: 'pc-1', postId: ID, mediaUrl: null, caption: 'Night market',
  locationName: null, locationCity: null, locationCountry: null,
  locationVerified: false, stampEligible: false, visibility: 'public',
  status: 'active', pinnedAt: null, note: null, createdAt: '2026-01-01T00:00:00Z',
} as never);

function profile(username: string | null) {
  return toShareableProfile({
    id: ID, username, displayName: 'Maya', bio: null, avatarUrl: null,
    homeCity: null, homeCountry: null, travelStyle: null, interests: [],
    verified: false, verificationStatus: 'unverified', verifiedAt: null,
    passportVisibility: 'public', createdAt: null,
  } as never);
}

// ── A. routing ───────────────────────────────────────────────────────────────

describe('routes to the canonical in-app route', () => {
  it('opens a trip at the SINGULAR app path, not the plural web one', async () => {
    const { getByTestId } = await render(<SharedEntityCard entity={trip} testID="c" />);
    fireEvent.press(getByTestId('c'));
    expect(push).toHaveBeenCalledWith(`/trip/${ID}`);
    // The web URL is plural; the two must not be confused.
    expect(trip.canonicalUrl).toContain('/trips/');
  });

  it('a postcard opens its POST, matching where its canonicalUrl points', async () => {
    const { getByTestId } = await render(<SharedEntityCard entity={postcard} testID="c" />);
    fireEvent.press(getByTestId('c'));
    expect(push).toHaveBeenCalledWith(`/post/${ID}`);
    expect(postcard.canonicalUrl).toContain(`/posts/${ID}`);
  });

  it.each([
    ['place', 'place'],
    ['event', 'event'],
    ['buddy', 'buddy'],
    ['post', 'post'],
    ['hidden_gem', 'gems'],
    ['trip', 'trip'],
  ])('a compass recommendation wrapping a %s opens /%s/:id', async (type, seg) => {
    const rec = toShareableCompassRecommendation({ id: ID, type, category: 'x', title: 'T' });
    const { getByTestId } = await render(<SharedEntityCard entity={rec} testID="c" />);
    fireEvent.press(getByTestId('c'));
    expect(push).toHaveBeenCalledWith(`/${seg}/${ID}`);
  });

  it('a profile routes by handle, never by id', async () => {
    const { getByTestId } = await render(<SharedEntityCard entity={profile('mayatravels')} testID="c" />);
    fireEvent.press(getByTestId('c'));
    expect(push).toHaveBeenCalledWith('/u/mayatravels');
    expect(push).not.toHaveBeenCalledWith(`/u/${ID}`);
  });

  it('appRouteFor agrees with canonicalUrl on which entity is opened', () => {
    // Different string forms, same destination entity. If these ever diverge a
    // shared card and the link inside it land in different places. Pure — no
    // render needed.
    for (const e of [trip, postcard, profile('mayatravels')]) {
      const appId = appRouteFor(e)!.split('/').pop();
      const webId = new URL(e.canonicalUrl!).pathname.split('/').pop();
      expect(appId).toBe(webId);
    }
  });
});

// ── B. no route ──────────────────────────────────────────────────────────────

describe('entities with no route', () => {
  it('renders a handle-less profile as static content, not a dead button', async () => {
    const e = profile(null);
    expect(appRouteFor(e)).toBeNull();
    const { getByTestId } = await render(<SharedEntityCard entity={e} testID="c" />);
    const card = getByTestId('c');
    // No "button" announced for something that cannot be pressed.
    expect(card.props.accessibilityRole).toBeUndefined();
    fireEvent.press(card);
    expect(push).not.toHaveBeenCalled();
  });

  it('renders a linkless compass recommendation as static content', async () => {
    const rec = toShareableCompassRecommendation({ id: ID, type: 'booking', category: 'x', title: 'A booking' });
    const { getByTestId, getByText } = await render(<SharedEntityCard entity={rec} testID="c" />);
    expect(getByText('A booking')).toBeTruthy();
    expect(getByTestId('c').props.accessibilityRole).toBeUndefined();
  });

  it('is still pressable with no route when given an explicit onPress', async () => {
    const onPress = jest.fn();
    const { getByTestId } = await render(
      <SharedEntityCard entity={profile(null)} onPress={onPress} testID="c" />,
    );
    fireEvent.press(getByTestId('c'));
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
  });
});

// ── C. surfaces ──────────────────────────────────────────────────────────────

describe('surface variants', () => {
  it('onPress overrides routing entirely', async () => {
    const onPress = jest.fn();
    const { getByTestId } = await render(<SharedEntityCard entity={trip} onPress={onPress} testID="c" />);
    fireEvent.press(getByTestId('c'));
    expect(onPress).toHaveBeenCalledWith(trip);
    expect(push).not.toHaveBeenCalled();
  });

  it('renders a footer slot for surface-specific actions', async () => {
    const { getByText } = await render(
      <SharedEntityCard entity={trip} footer={<Text>Add to Plan</Text>} testID="c" />,
    );
    expect(getByText('Add to Plan')).toBeTruthy();
  });

  it.each([false, true])('`mine`=%s changes chrome but not preview content', async (mine) => {
    const { getByText } = await render(<SharedEntityCard entity={trip} mine={mine} testID="c" />);
    expect(getByText('Thailand 2026')).toBeTruthy();
    expect(getByText('Bangkok, Thailand')).toBeTruthy();
  });

  it('renders the same for a stamp with no image and no subtitle', async () => {
    const stamp = toShareableStamp({
      id: ID, stampDefinitionId: null, definition: null, stampType: 'city',
      country: null, city: null, neighborhood: null, titleOverride: null,
      placeId: null, planId: null, tripId: null, sourceType: 'auto',
      verificationLevel: 'v', visibility: 'public', displayOnPassport: true,
      isRevoked: false, earnedAt: '2026-01-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z',
      catalogId: null, activeArtworkUrl: null, thumbnailUrl: null,
    } as never);
    const { getByTestId } = await render(<SharedEntityCard entity={stamp} testID="c" />);
    fireEvent.press(getByTestId('c'));
    expect(push).toHaveBeenCalledWith(`/stamp/${ID}`);
  });
});

// ── D. §23 accessibility ─────────────────────────────────────────────────────

describe('accessibility', () => {
  it('announces the affordance without repeating the content', async () => {
    const { getByTestId } = await render(<SharedEntityCard entity={trip} testID="c" />);
    const card = getByTestId('c');
    expect(card.props.accessibilityRole).toBe('button');
    // The preview already speaks the content; the hint adds only the action.
    expect(card.props.accessibilityHint).toBe('Opens this trip');
  });

  it('names the postcard noun as "post", matching where it actually goes', async () => {
    const { getByTestId } = await render(<SharedEntityCard entity={postcard} testID="c" />);
    expect(getByTestId('c').props.accessibilityHint).toBe('Opens this post');
  });

  it('names the profile noun', async () => {
    const { getByTestId } = await render(<SharedEntityCard entity={profile('m')} testID="c" />);
    expect(getByTestId('c').props.accessibilityHint).toBe('Opens this profile');
  });

  it('meets the platform minimum touch target', async () => {
    const { getByTestId } = await render(<SharedEntityCard entity={trip} testID="c" />);
    const style = getByTestId('c').props.style;
    const merged = Object.assign(
      {},
      ...[typeof style === 'function' ? style({ pressed: false }) : style].flat(Infinity).filter(Boolean) as object[],
    ) as Record<string, unknown>;
    expect(merged.minHeight as number).toBeGreaterThanOrEqual(44);
    // minHeight, not height — the card grows with scaled text rather than clipping.
    expect(merged.height).toBeUndefined();
  });

  it('leaves the preview to speak the content, so it is not read twice', async () => {
    const { getByTestId } = await render(<SharedEntityCard entity={trip} testID="c" />);
    expect(getByTestId('c').props.accessibilityLabel).toBeUndefined();
    expect(getByTestId('c-preview').props.accessibilityLabel).toContain('Thailand 2026');
  });
});

// ── E. the shape the existing message cards would need ───────────────────────

describe('usable as a Telegraph / notification / activity card', () => {
  it('needs nothing but a ShareableEntity — no body string, no fetch', async () => {
    // The three surfaces share only the entity. Anything else in the props
    // would push storage details into this component.
    const e: ShareableEntity = trip;
    const { getByTestId } = await render(<SharedEntityCard entity={e} testID="c" />);
    expect(getByTestId('c')).toBeTruthy();
  });
});
