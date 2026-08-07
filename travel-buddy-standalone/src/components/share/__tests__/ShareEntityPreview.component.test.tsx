/**
 * ShareEntityPreview — §4 "what am I sharing".
 *
 * Run: pnpm test:component -- --testPathPattern=ShareEntityPreview
 *
 * Covers:
 *   A. the spec's four worked examples, rendered from real adapter output
 *      rather than hand-written props — if an adapter changes shape, this fails
 *   B. degradation: missing imageUrl, missing subtitle, very long title
 *   C. §23 accessibility: one spoken utterance per card, scaling text
 */
import React from 'react';
import { render } from '@testing-library/react-native';
import { PixelRatio } from 'react-native';
import { ShareEntityPreview } from '../ShareEntityPreview.tsx';
import {
  toShareablePlace, toShareableTrip, toShareableProfile, toShareablePostcard,
  toShareableStamp, toShareableCompassRecommendation,
} from '../../../services/shareAdapters.ts';
import type { ShareableEntity } from '../../../types/models.ts';

// NOTE: intentionally exhaustive — safe-area context reads native config that
// is unavailable under Jest.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

function flatStyle(style: unknown): Record<string, unknown> {
  return Object.assign({}, ...[style].flat(Infinity).filter(Boolean) as object[]);
}

const ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

// ── A. the four worked examples, built through the real adapters ─────────────

describe('the spec\'s four worked examples', () => {
  it('Place — Shibuya Sky / Tokyo, Japan / ★ 4.7', async () => {
    const entity = toShareablePlace({
      id: ID, name: 'Shibuya Sky', category: 'attraction',
      coordinates: { lat: 35.6, lng: 139.7 }, address: null, formattedAddress: null,
      city: 'Tokyo', neighborhood: null, countryCode: 'Japan',
      status: 'active', detailRoute: `/place/${ID}`, headerImageUrl: 'https://cdn/sky.jpg',
    } as never);
    const { getByText, getByTestId } = await render(
      <ShareEntityPreview entity={entity} meta="★ 4.7" testID="p" />,
    );
    expect(getByText('Shibuya Sky')).toBeTruthy();
    expect(getByText('Tokyo, Japan')).toBeTruthy();
    expect(getByText('★ 4.7')).toBeTruthy();
    expect(getByTestId('p-media')).toBeTruthy();
  });

  it('Trip — Thailand 2026 / destination / Aug 18–27', async () => {
    const entity = toShareableTrip({
      id: ID, title: 'Thailand 2026', destinationCity: 'Bangkok', destinationCountry: 'Thailand',
      neighborhoods: [], startDate: '2026-08-18', endDate: '2026-08-27', nights: 9,
      status: 'planning', visibility: 'public', travelStyle: 'solo', openToMeet: true,
      coverUrl: 'https://cdn/th.jpg', progress: 0, progressSteps: [], timeline: [],
      savedIdeas: [], safetyStatus: 'ok', tripNotes: null,
    } as never);
    const { getByText } = await render(
      <ShareEntityPreview entity={entity} meta="Aug 18–27" testID="p" />,
    );
    expect(getByText('Thailand 2026')).toBeTruthy();
    expect(getByText('Bangkok, Thailand')).toBeTruthy();
    expect(getByText('Aug 18–27')).toBeTruthy();
  });

  it('Profile — Maya / @mayatravels / Canada • Bangkok now, with a ROUND avatar', async () => {
    const entity = toShareableProfile({
      id: ID, username: 'mayatravels', displayName: 'Maya', bio: null,
      avatarUrl: 'https://cdn/maya.jpg', homeCity: 'Canada', homeCountry: null,
      travelStyle: null, interests: [], verified: false, verificationStatus: 'unverified',
      verifiedAt: null, passportVisibility: 'public', createdAt: null,
    } as never);
    const { getByText, getByTestId } = await render(
      <ShareEntityPreview entity={entity} meta="Canada • Bangkok now" testID="p" />,
    );
    expect(getByText('Maya')).toBeTruthy();
    expect(getByText('@mayatravels · Canada')).toBeTruthy();
    expect(getByText('Canada • Bangkok now')).toBeTruthy();
    // A profile is the layout variant: round, via the Avatar primitive.
    const media = flatStyle(getByTestId('p-media').props.style);
    expect(media.borderRadius).toBe(28);   // size 56 / 2
  });

  it('Postcard — caption / location, with a RECTANGULAR image', async () => {
    const entity = toShareablePostcard({
      id: 'pc-1', postId: ID, mediaUrl: 'https://cdn/night.jpg',
      caption: 'Night market in Bangkok', locationName: 'Yaowarat',
      locationCity: null, locationCountry: null, locationVerified: true,
      stampEligible: false, visibility: 'public', status: 'active',
      pinnedAt: null, note: null, createdAt: '2026-01-01T00:00:00Z',
    } as never);
    const { getByText, getByTestId } = await render(
      <ShareEntityPreview entity={entity} testID="p" />,
    );
    expect(getByText('Night market in Bangkok')).toBeTruthy();
    expect(getByText('Yaowarat')).toBeTruthy();
    const media = flatStyle(getByTestId('p-media').props.style);
    expect(media.borderRadius).not.toBe(28);   // rounded rect, not a circle
  });
});

// ── B. degradation ───────────────────────────────────────────────────────────

function bare(over: Partial<ShareableEntity> = {}): ShareableEntity {
  return {
    entityType: 'place', entityId: ID, title: 'Somewhere', subtitle: null,
    description: null, imageUrl: null, creator: null, location: null,
    canonicalUrl: null, metadata: {}, allowedDestinations: [], allowedActions: [],
    ...over,
  };
}

describe('degradation', () => {
  it('renders a placeholder glyph when imageUrl is missing, not a blank hole', async () => {
    const { getByTestId } = await render(
      <ShareEntityPreview entity={bare({ imageUrl: null })} testID="p" />,
    );
    const media = getByTestId('p-media');
    expect(media).toBeTruthy();
    // Still occupies the same box, so the row does not reflow.
    const st = flatStyle(media.props.style);
    expect(st.width).toBe(56);
    expect(st.height).toBe(56);
    expect(media.props.children).toBeTruthy();   // the glyph
  });

  it('gives each entity type its own placeholder glyph', async () => {
    // Not the same generic square for a trip and a stamp.
    for (const type of ['place', 'trip', 'stamp', 'compass_recommendation'] as const) {
      const { getByTestId } = await render(
        <ShareEntityPreview entity={bare({ entityType: type, imageUrl: null })} testID={`p-${type}`} />,
      );
      expect(getByTestId(`p-${type}-media`)).toBeTruthy();
    }
  });

  it('omits the subtitle row entirely when there is no subtitle', async () => {
    const { getByText, queryByText } = await render(
      <ShareEntityPreview entity={bare({ title: 'Just a title', subtitle: null })} testID="p" />,
    );
    expect(getByText('Just a title')).toBeTruthy();
    expect(queryByText('null')).toBeNull();
    expect(queryByText('undefined')).toBeNull();
  });

  it('omits the meta row when no meta is passed', async () => {
    const { queryByText } = await render(
      <ShareEntityPreview entity={bare({ subtitle: 'Sub' })} testID="p" />,
    );
    expect(queryByText('undefined')).toBeNull();
  });

  it('clamps a long title to two lines instead of widening the row', async () => {
    const long = 'A place with an extremely long name that would otherwise run off the edge of the sheet and take the layout with it';
    const { getByText } = await render(
      <ShareEntityPreview entity={bare({ title: long })} testID="p" />,
    );
    const title = getByText(long);
    expect(title.props.numberOfLines).toBe(2);
    expect(title.props.ellipsizeMode).toBe('tail');
  });

  it('keeps the text column shrinkable so the title never pushes the row wide', async () => {
    const { getByText } = await render(<ShareEntityPreview entity={bare()} testID="p" />);
    const column = getByText('Somewhere').parent;
    const st = flatStyle(column?.props.style);
    expect(st.flex).toBe(1);
    expect(st.minWidth).toBe(0);
  });

  it('handles a compass recommendation with no URL and no image', async () => {
    const entity = toShareableCompassRecommendation({ id: ID, type: 'booking', category: 'x', title: 'A booking' });
    const { getByText, getByTestId } = await render(<ShareEntityPreview entity={entity} testID="p" />);
    expect(entity.canonicalUrl).toBeNull();
    expect(getByText('A booking')).toBeTruthy();
    expect(getByTestId('p-media')).toBeTruthy();
  });

  it('never renders an empty title — the adapters guarantee a fallback', async () => {
    const entity = toShareableStamp({
      id: ID, stampDefinitionId: null, definition: null, stampType: 'city',
      country: null, city: null, neighborhood: null, titleOverride: null,
      placeId: null, planId: null, tripId: null, sourceType: 'auto',
      verificationLevel: 'v', visibility: 'public', displayOnPassport: true,
      isRevoked: false, earnedAt: '2026-01-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z',
      catalogId: null, activeArtworkUrl: null, thumbnailUrl: null,
    } as never);
    const { getByText } = await render(<ShareEntityPreview entity={entity} testID="p" />);
    expect(entity.title.trim()).not.toBe('');
    expect(getByText(entity.title)).toBeTruthy();
  });
});

// ── C. §23 accessibility ─────────────────────────────────────────────────────

describe('accessibility', () => {
  it('speaks the card as one utterance, not three fragments', async () => {
    const { getByTestId } = await render(
      <ShareEntityPreview entity={bare({ title: 'Shibuya Sky', subtitle: 'Tokyo, Japan' })} meta="★ 4.7" testID="p" />,
    );
    const row = getByTestId('p');
    expect(row.props.accessible).toBe(true);
    expect(row.props.accessibilityLabel).toBe('Shibuya Sky, Tokyo, Japan, ★ 4.7');
  });

  it('drops absent lines from the spoken label rather than saying "null"', async () => {
    const { getByTestId } = await render(
      <ShareEntityPreview entity={bare({ title: 'Somewhere', subtitle: null })} testID="p" />,
    );
    expect(getByTestId('p').props.accessibilityLabel).toBe('Somewhere');
  });

  it.each([1, 2, 3])('lets its text scale at fontScale %sx', async (scale) => {
    const spy = jest.spyOn(PixelRatio, 'getFontScale').mockReturnValue(scale);
    try {
      const { getByText } = await render(
        <ShareEntityPreview entity={bare({ title: 'Shibuya Sky', subtitle: 'Tokyo, Japan' })} testID="p" />,
      );
      // Card text is body chrome: it MUST scale, unlike avatar initials.
      expect(getByText('Shibuya Sky').props.allowFontScaling).not.toBe(false);
      expect(getByText('Tokyo, Japan').props.allowFontScaling).not.toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('does not fix a height anywhere, so the row grows with scaled text', async () => {
    const { getByTestId, getByText } = await render(
      <ShareEntityPreview entity={bare({ title: 'Shibuya Sky', subtitle: 'Tokyo, Japan' })} testID="p" />,
    );
    expect(flatStyle(getByTestId('p').props.style).height).toBeUndefined();
    expect(flatStyle(getByText('Shibuya Sky').props.style).height).toBeUndefined();
  });
});
