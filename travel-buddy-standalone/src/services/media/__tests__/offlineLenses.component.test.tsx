/**
 * §39's closing sentence, on the surfaces: "Cached intelligence must show
 * last-updated time and never be presented as live." The Places, People and
 * Experiences lenses answer through the offline media cache; whenever what is
 * on screen came from it, the lens renders the "Cached · updated …" label, and
 * the moment a live answer arrives, the label is gone.
 */
import React from 'react';
import { render, waitFor, fireEvent } from '@testing-library/react-native';

type Offline = { cachedAt: number; ageMinutes: number; label: string } | undefined;
let mockOffline: Offline;

const crewGroup = {
  contributor: { id: 'c1', displayName: 'Crewmate', username: null, avatarUrl: null, verified: false, trustLabel: null },
  relation: 'trip_crew',
  perspectiveCount: 1,
  freshness: 'recent',
  media: [],
};
const place = {
  placeId: '11111111-1111-4111-8111-111111111111',
  placeName: 'An Thuong 2',
  stateLabel: null,
  currentPicture: { strength: 'moderate', updatedAt: null, ageMinutes: 180, perspectiveCount: 2, contributorCount: 2, sourceCount: 2, trend: 'steady' },
  groups: [],
  heroMedia: [],
  areaName: 'Da Nang',
};
const experience = {
  id: '22222222-2222-4222-8222-222222222222', title: 'Vietnam trip', placeIds: [], tripId: '22222222-2222-4222-8222-222222222222',
  perspectiveCount: 3, contributorCount: 2, freshness: 'recent', heroMedia: [],
};

jest.mock('../mediaOffline.ts', () => ({
  ...jest.requireActual('../mediaOffline.ts'),
  peopleOffline: async () => ({ ok: true, data: { generatedAt: null, people: [crewGroup] }, offline: mockOffline }),
  placeViewOffline: async () => ({ ok: true, data: place, offline: mockOffline }),
  experiencesOffline: async () => ({ ok: true, data: [experience], offline: mockOffline }),
}));

import { MediaPeopleScreen } from '../../../features/media/screens/MediaPeopleScreen.tsx';
import { MediaPlacesScreen } from '../../../features/media/screens/MediaPlacesScreen.tsx';
import { MediaExperiencesScreen } from '../../../features/media/screens/MediaExperiencesScreen.tsx';

const CACHED: Offline = { cachedAt: 0, ageMinutes: 125, label: 'Cached · updated 2h ago' };

describe('§39 — every offline lens labels cached content with its age', () => {
  it('People lens: cached → the label, and it says the offline view is the Trip Crew only', async () => {
    mockOffline = CACHED;
    const view = await render(<MediaPeopleScreen />);
    await waitFor(() => expect(view.getByText('Cached · updated 2h ago — your Trip Crew only')).toBeTruthy());
  });

  it('People lens: a live answer carries no cached label', async () => {
    mockOffline = undefined;
    const view = await render(<MediaPeopleScreen />);
    await waitFor(() => expect(view.getByText('Crewmate')).toBeTruthy());
    expect(view.queryByText(/Cached ·/)).toBeNull();
  });

  it('Places lens: a cached place view shows its age above the current picture', async () => {
    mockOffline = CACHED;
    const view = await render(
      <MediaPlacesScreen
        mode="grid"
        zones={[{ id: place.placeId, name: 'An Thuong 2', perspectiveCount: 2, state: null, freshness: 'recent' }]}
      />,
    );
    fireEvent.press(view.getByText('An Thuong 2'));
    await waitFor(() => expect(view.getByText('Cached · updated 2h ago')).toBeTruthy());
  });

  it('Experiences lens: cached trip media shows its age', async () => {
    mockOffline = CACHED;
    const view = await render(<MediaExperiencesScreen mode="grid" experienceIds={[experience.id]} />);
    await waitFor(() => expect(view.getByText('Cached · updated 2h ago')).toBeTruthy());
  });
});
