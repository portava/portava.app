/**
 * LivingDestinationPage — the Official Info card labels stored hours as listed
 * hours (lead ruling D-67, 2026-10-06).
 *
 * D-67 lets listing hours be shown only when they are labelled as listed hours.
 * The card printed `officialInfo.hours` bare beside a clock icon, where a
 * reader takes it for the place's state today. It now reads
 * "Listed hours: <hours>", in the wording `features/discovery/listedHours.ts`
 * gives every surface.
 *
 * Run with: pnpm test:component
 */

import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import { LivingDestinationPage } from '../LivingDestinationPage.tsx';
import type { PlaceLivingResponse } from '../../../../types/placeLiving.ts';
import type { CanonicalPlace } from '../../../../types/canonicalPlace.ts';

// NOTE: intentionally exhaustive — expo-linear-gradient pulls a native gradient
// module that is unavailable under jest-expo; a plain View wrapper is sufficient.
jest.mock('expo-linear-gradient', () => ({
  LinearGradient: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

// NOTE: intentionally exhaustive — CachedImage wraps expo-image which pulls in
// native modules unavailable under jest-expo; a stub View is sufficient because
// assertions target the info card's text, not image rendering.
jest.mock('../../../CachedImage.tsx', () => {
  const { View } = require('react-native');
  return {
    CachedImage: () => require('react').createElement(View, null),
  };
});

// NOTE: intentionally exhaustive — only getPlaceTimeline is reached; the rest of
// the places service imports Supabase native internals that crash under jest-expo.
jest.mock('../../../../services/places.ts', () => ({
  getPlaceTimeline: jest.fn().mockResolvedValue(null),
}));

function makeLiving(hours: string | null): PlaceLivingResponse {
  return {
    placeId:      'place-hours',
    sparseMode:   true,
    hero:         { imageUrl: null, videoUrl: null },
    rating:       null,
    bestTime:     null,
    crowdLevel:   null,
    weather:      null,
    directionsUrl: null,
    officialInfo: {
      hours,
      isOpenNow:   null,
      address:     '1 Falls Road',
      phone:       null,
      website:     null,
      priceLevel:  null,
      rating:      null,
      reviewCount: null,
      bookingUrl:  null,
      attribution: [],
    },
    aiSummary:      null,
    buckets:        [],
    timeline:       { slice: 'today', posts: [], crowdLevel: null, weatherBrief: null },
    bestOf:         null,
    dedupGroups:    [],
    topContributor: null,
    thinBuckets:    [],
    generatedAt:    '2026-10-06T00:00:00Z',
  };
}

const PLACE: CanonicalPlace = {
  id:           'place-hours',
  name:         'Kawasan Falls',
  category:     'attraction',
  coordinates:  { lat: 9.8063, lng: 123.3739 },
  address:      null,
  city:         null,
  neighborhood: null,
  countryCode:  null,
  status:       'active',
  detailRoute:  '/place/place-hours',
  attribution:  [],
  sources:      [],
  fieldFreshness: {},
};

describe('LivingDestinationPage — Official Info hours (lead ruling D-67)', () => {
  it('labels the stored hours "Listed hours" and never shows them bare', async () => {
    const { getByText, getByTestId, queryByText } = await render(
      <LivingDestinationPage place={PLACE} living={makeLiving('Mo-Su 07:00-17:00')} />,
    );
    await fireEvent.press(getByText('Official Info'));
    expect(getByTestId('living-official-listed-hours')).toHaveTextContent('Listed hours: Mo-Su 07:00-17:00', { exact: true });
    expect(queryByText('Mo-Su 07:00-17:00')).toBeNull();
  });
});
