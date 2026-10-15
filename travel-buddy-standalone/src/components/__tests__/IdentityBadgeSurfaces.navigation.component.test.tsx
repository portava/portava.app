import React from 'react';
import { Text } from 'react-native';
import { fireEvent, render } from '@testing-library/react-native';
import { router } from 'expo-router';
import { BuddyCard } from '../BuddyCard.tsx';
import { ReviewsSection } from '../ReviewsSection.tsx';
import { PassportIdentityCard } from '../passport/PassportIdentityCard.tsx';
import { UserIdentityLink } from '../interaction/UserIdentityLink.tsx';
import { VerifiedBadge, VERIFIED_BADGE_PUBLIC_STATEMENT } from '../trust/VerifiedBadge.tsx';
import { ReportSheet } from '../ReportSheet.tsx';
import { getMyReview, getPlaceReviews, type Review } from '../../services/reviews.ts';
import { saveBuddy, unsaveBuddy, type BuddyProfile } from '../../services/rentABuddy.ts';

jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { ...jest.requireActual('expo-router').router, push: jest.fn() },
}));

const mockBlockedIds = new Set<string>();
const mockBlockerIds = new Set<string>();
jest.mock('../../context/BlockedIdsContext.tsx', () => ({
  ...jest.requireActual('../../context/BlockedIdsContext.tsx'),
  useBlockedIds: () => ({ blockedIds: mockBlockedIds, blockerIds: mockBlockerIds, isLoading: false }),
}));
jest.mock('../../context/SessionContext.tsx', () => ({
  ...jest.requireActual('../../context/SessionContext.tsx'),
  useSession: () => ({ isAuthed: true, userId: 'viewer' }),
}));
jest.mock('../../services/reviews.ts', () => ({
  ...jest.requireActual('../../services/reviews.ts'),
  getMyReview: jest.fn(),
  getPlaceReviews: jest.fn(),
}));
jest.mock('../../services/rentABuddy.ts', () => ({
  ...jest.requireActual('../../services/rentABuddy.ts'),
  saveBuddy: jest.fn(),
  unsaveBuddy: jest.fn(),
}));
jest.mock('../interaction/UserIdentityLink.tsx', () => {
  const actual = jest.requireActual('../interaction/UserIdentityLink.tsx');
  return {
    ...actual,
    UserIdentityLink: jest.fn((props) => require('react').createElement(actual.UserIdentityLink, props)),
  };
});
jest.mock('../ReportSheet.tsx', () => ({
  ...jest.requireActual('../ReportSheet.tsx'),
  ReportSheet: jest.fn(() => null),
}));

const profile = {
  id: 'person-1', username: 'ana', displayName: 'Ana', avatarUrl: null, bio: null,
  verified: true,
} as unknown as Parameters<typeof PassportIdentityCard>[0]['profile'];

const buddy: BuddyProfile = {
  id: 'listing-1', userId: 'person-1', displayName: 'Ana', city: 'Barcelona', country: 'Spain',
  categories: [], languages: [], verified: true, averageRating: 4.8, reviewCount: 12,
  hourlyRateUsd: 25, status: 'active', tagline: null, bio: null, coverPhotoUrl: null,
  responseTimeH: 1, distanceKm: null, verifiedAt: '2026-01-01T00:00:00Z', galleryUrls: [],
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  meetupBaseLat: null, meetupBaseLng: null,
};

const review: Review = {
  id: 'review-1', rating: 5, body: 'Review body', tags: [], anonymous: false,
  createdAt: '2026-10-01T00:00:00Z',
  reviewer: { id: 'person-1', handle: 'ana', displayName: 'Ana', avatarUrl: null },
};

type Surface = 'passport' | 'buddy' | 'review';
const surfaces: Surface[] = ['passport', 'buddy', 'review'];

function setReview(nextReview: Review) {
  jest.mocked(getPlaceReviews).mockResolvedValue({
    reviews: [nextReview], total: 1, avgRating: 5, page: 1, limit: 5,
  });
}

async function renderSurface(surface: Surface, identityBadge: unknown) {
  if (surface === 'passport') {
    return render(<PassportIdentityCard profile={{ ...profile, identityBadge } as typeof profile} isOwner={false} />);
  }
  if (surface === 'buddy') {
    return render(<BuddyCard buddy={{ ...buddy, identityBadge } as BuddyProfile} />);
  }
  setReview({ ...review, reviewer: { ...review.reviewer!, identityBadge } as Review['reviewer'] });
  const result = await render(<ReviewsSection entityType="place" entityId="place-1" />);
  await result.findByText('Review body');
  return result;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockBlockedIds.clear();
  mockBlockerIds.clear();
  jest.mocked(getMyReview).mockResolvedValue({ exists: false, reviewId: null });
  jest.mocked(saveBuddy).mockResolvedValue({ ok: true, data: { ok: true } });
  jest.mocked(unsaveBuddy).mockResolvedValue({ ok: true, data: { ok: true } });
});

describe.each(surfaces)('%s identity name and badge', (surface) => {
  it('places the existing badge inside the real shared identity link and keeps its size', async () => {
    const identityBadge = { tier: 'id_selfie' };
    const result = await renderSurface(surface, identityBadge);
    const call = jest.mocked(UserIdentityLink).mock.calls.find(([props]) => props.userId === 'person-1');
    expect(call).toBeDefined();
    const badge = React.Children.toArray(call![0].children).find(
      (child) => React.isValidElement(child) && child.type === VerifiedBadge,
    );
    expect(React.isValidElement(badge) ? badge.props : null).toEqual({
      badge: identityBadge, size: { passport: 18, buddy: 13, review: 12 }[surface],
    });
    expect(result.getAllByTestId('verified-badge-id_selfie')).toHaveLength(1);
    await fireEvent.press(result.getByText('Ana'));
    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith(surface === 'buddy' ? '/(rent-a-buddy)/buddy/listing-1' : '/u/ana');
  });

  it('opens criteria from the badge without opening a profile or another action', async () => {
    const result = await renderSurface(surface, { tier: 'id' });
    const stopPropagation = jest.fn();
    await fireEvent.press(result.getByTestId('verified-badge-id'), { stopPropagation });
    expect(stopPropagation).toHaveBeenCalledTimes(1);
    expect(result.getByText(VERIFIED_BADGE_PUBLIC_STATEMENT)).toBeTruthy();
    expect(router.push).not.toHaveBeenCalled();
    expect(saveBuddy).not.toHaveBeenCalled();
    expect(ReportSheet).not.toHaveBeenCalled();
    await fireEvent.press(result.getByLabelText('Close'));
    expect(result.queryByTestId('verified-badge-criteria')).toBeNull();
  });

  it.each(['blocked', 'blocker'])('suppresses name navigation for a %s person', async (direction) => {
    (direction === 'blocked' ? mockBlockedIds : mockBlockerIds).add('person-1');
    const result = await renderSurface(surface, { tier: 'id' });
    const stopPropagation = jest.fn();
    await fireEvent.press(result.getByText('Ana'), { stopPropagation });
    expect(router.push).not.toHaveBeenCalled();
    if (surface === 'buddy') expect(stopPropagation).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, null, true, { tier: 'unknown' }])('does not invent a current badge from legacy verification: %p', async (identityBadge) => {
    const result = await renderSurface(surface, identityBadge);
    expect(result.queryByTestId('verified-badge-id')).toBeNull();
    expect(result.queryByTestId('verified-badge-id_selfie')).toBeNull();
  });
});

it('routes an owner Passport name through the shared self destination', async () => {
  const result = await render(<PassportIdentityCard profile={profile} isOwner />);
  await fireEvent.press(result.getByText('Ana'));
  expect(router.push).toHaveBeenCalledWith('/(tabs)/passport');
});

it('leaves a Passport name without a handle inert', async () => {
  const result = await render(<PassportIdentityCard profile={{ ...profile, username: null }} isOwner={false} />);
  await fireEvent.press(result.getByText('Ana'));
  expect(router.push).not.toHaveBeenCalled();
});

it('keeps Passport follow, message and menu callbacks separate from name navigation', async () => {
  const onFollowPress = jest.fn();
  const onMessagePress = jest.fn();
  const onMenuPress = jest.fn();
  const result = await render(
    <PassportIdentityCard profile={profile} isOwner={false} onFollowPress={onFollowPress}
      onMessagePress={onMessagePress} onMenuPress={onMenuPress} />,
  );
  await fireEvent.press(result.getByTestId('passport-follow-pill'));
  await fireEvent.press(result.getByTestId('passport-message-pill'));
  await fireEvent.press(result.getByLabelText('More options'));
  expect(onFollowPress).toHaveBeenCalledTimes(1);
  expect(onMessagePress).toHaveBeenCalledTimes(1);
  expect(onMenuPress).toHaveBeenCalledTimes(1);
  expect(router.push).not.toHaveBeenCalled();
});

it('keeps owner camera and edit controls outside the identity link', async () => {
  const onChangeCover = jest.fn();
  const onEditProfile = jest.fn();
  const result = await render(
    <PassportIdentityCard profile={profile} isOwner onChangeCover={onChangeCover} onEditProfile={onEditProfile} />,
  );
  await fireEvent.press(result.getByLabelText('Change profile photo'));
  await fireEvent.press(result.getByText('Edit Profile'));
  expect(onChangeCover).toHaveBeenCalledTimes(1);
  expect(onEditProfile).toHaveBeenCalledTimes(1);
  expect(router.push).not.toHaveBeenCalled();
});

it('preserves the Buddy card callback without inventing a public handle or bubbling to the card', async () => {
  const onPress = jest.fn();
  const onBook = jest.fn();
  const stopPropagation = jest.fn();
  const result = await render(<BuddyCard buddy={{ ...buddy, identityBadge: { tier: 'id' } }} onPress={onPress} onBook={onBook} />);
  await fireEvent.press(result.getByText('Ana'), { stopPropagation });
  expect(stopPropagation).toHaveBeenCalledTimes(1);
  expect(onPress).toHaveBeenCalledTimes(1);
  expect(router.push).not.toHaveBeenCalled();
  await fireEvent.press(result.getByTestId('verified-badge-id'), { stopPropagation });
  expect(onPress).toHaveBeenCalledTimes(1);
  expect(onBook).not.toHaveBeenCalled();
});

it.each(['blocked', 'blocker'])('does not bypass a %s Buddy identity through its custom callback', async (direction) => {
  (direction === 'blocked' ? mockBlockedIds : mockBlockerIds).add(buddy.userId);
  const onPress = jest.fn();
  const result = await render(<BuddyCard buddy={buddy} onPress={onPress} />);
  await fireEvent.press(result.getByText('Ana'), { stopPropagation: jest.fn() });
  expect(onPress).not.toHaveBeenCalled();
});

it('preserves Buddy save, unsave, listing and booking controls', async () => {
  const onPress = jest.fn();
  const onBook = jest.fn();
  const result = await render(<BuddyCard buddy={buddy} onPress={onPress} onBook={onBook} />);
  await fireEvent.press(result.getByLabelText('Save buddy'));
  expect(saveBuddy).toHaveBeenCalledWith(buddy.id);
  await fireEvent.press(result.getByLabelText('Unsave buddy'));
  expect(unsaveBuddy).toHaveBeenCalledWith(buddy.id);
  await fireEvent.press(result.getByText('View Profile'));
  expect(router.push).toHaveBeenCalledWith('/(rent-a-buddy)/buddy/listing-1');
  await fireEvent.press(result.getByText('Book'));
  expect(onBook).toHaveBeenCalledTimes(1);
  expect(onPress).not.toHaveBeenCalled();
});

it('routes an own-review name to Passport and does not offer self reporting', async () => {
  setReview({ ...review, reviewer: { ...review.reviewer!, id: 'viewer' } });
  const result = await render(<ReviewsSection entityType="place" entityId="place-1" />);
  await fireEvent.press(await result.findByText('Ana'));
  expect(router.push).toHaveBeenCalledWith('/(tabs)/passport');
  await fireEvent(result.getByText('Review body'), 'longPress');
  expect(ReportSheet).not.toHaveBeenCalled();
});

it('preserves review reporting on the body with the original author and subject', async () => {
  const result = await renderSurface('review', { tier: 'id' });
  await fireEvent(result.getByText('Review body'), 'longPress');
  expect(jest.mocked(ReportSheet).mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({
    visible: true, subjectType: 'review', subjectId: 'review-1', subjectUserId: 'person-1',
  }));
  expect(router.push).not.toHaveBeenCalled();
});

it.each([true, false])('withholds identity for anonymous or unavailable reviewers: anonymous=%s', async (anonymous) => {
  setReview({ ...review, anonymous, reviewer: anonymous ? { ...review.reviewer!, identityBadge: { tier: 'id' } } : null });
  const result = await render(<ReviewsSection entityType="place" entityId="place-1" />);
  await fireEvent.press(await result.findByText('Anonymous'));
  expect(result.queryByText('Ana')).toBeNull();
  expect(result.queryByTestId('verified-badge-id')).toBeNull();
  expect(UserIdentityLink).not.toHaveBeenCalled();
  expect(router.push).not.toHaveBeenCalled();
});

it('does not invent a review handle, while retaining server badge criteria', async () => {
  setReview({ ...review, reviewer: { ...review.reviewer!, handle: null, identityBadge: { tier: 'id' } } });
  const result = await render(<ReviewsSection entityType="place" entityId="place-1" />);
  await fireEvent.press(await result.findByText('Ana'));
  expect(router.push).not.toHaveBeenCalled();
  await fireEvent.press(result.getByTestId('verified-badge-id'));
  expect(result.getByTestId('verified-badge-criteria')).toBeTruthy();
});

it('does not run an explicit profile callback when the shared link is disabled', async () => {
  const onProfilePress = jest.fn();
  const result = await render(
    <UserIdentityLink userId="person-1" handle={null} disabled onProfilePress={onProfilePress}>
      <Text>Ana</Text>
    </UserIdentityLink>,
  );
  await fireEvent.press(result.getByText('Ana'));
  expect(onProfilePress).not.toHaveBeenCalled();
  expect(router.push).not.toHaveBeenCalled();
});
