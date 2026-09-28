/**
 * §18 on the Places lens: "When reports disagree, surface uncertainty such as
 * 'Mixed reports — conditions may be changing'." The server has emitted that
 * line since 2026-09-14; until census-media §22 no screen rendered it.
 */
import React from 'react';
import { render, waitFor, fireEvent } from '@testing-library/react-native';

let mockConsensus: unknown = null;

const PLACE_ID = '11111111-1111-4111-8111-111111111111';

jest.mock('../mediaOffline.ts', () => ({
  ...jest.requireActual('../mediaOffline.ts'),
  placeViewOffline: async () => ({
    ok: true,
    data: {
      placeId: PLACE_ID,
      placeName: 'An Thuong 2',
      stateLabel: null,
      currentPicture: { strength: 'low', updatedAt: null, ageMinutes: 12, perspectiveCount: 6, contributorCount: 4, sourceCount: 3, trend: 'steady' },
      groups: [],
      heroMedia: [],
      areaName: 'Da Nang',
      consensus: mockConsensus,
    },
  }),
}));

import { MediaPlacesScreen } from '../../../features/media/screens/MediaPlacesScreen.tsx';

const ZONES = [{ id: PLACE_ID, name: 'An Thuong 2', perspectiveCount: 6, state: null, freshness: 'recent' }] as any;

describe('the Places lens surfaces §18 uncertainty exactly when the server does', () => {
  it('a mixed consensus shows the banner', async () => {
    mockConsensus = {
      state: 'mixed',
      corroboration: { level: 'well_corroborated', freshPerspectiveCount: 6, independentSourceCount: 3 },
      contradiction: 'material',
      uncertaintyLabel: 'Mixed reports — conditions may be changing',
      requestAnotherObservation: true,
    };
    const view = await render(<MediaPlacesScreen mode="grid" zones={ZONES} />);
    fireEvent.press(view.getByText('An Thuong 2'));
    await waitFor(() => expect(view.getByText('Mixed reports — conditions may be changing')).toBeTruthy());
  });

  it('a corroborated consensus shows no banner', async () => {
    mockConsensus = {
      state: 'corroborated',
      corroboration: { level: 'corroborated', freshPerspectiveCount: 4, independentSourceCount: 2 },
      contradiction: null,
      uncertaintyLabel: null,
      requestAnotherObservation: false,
    };
    const view = await render(<MediaPlacesScreen mode="grid" zones={ZONES} />);
    fireEvent.press(view.getByText('An Thuong 2'));
    await waitFor(() => expect(view.getByText('Da Nang')).toBeTruthy());
    expect(view.queryByText(/Mixed reports/)).toBeNull();
  });
});
