/**
 * TripHero (src/components/TripPage.tsx) — readiness is explained, not scored.
 *
 * Trips spec §8: "Readiness is an explanatory projection, not a gamified truth
 * score." Until census-trips §58 the hero drew a semicircle ring with a
 * percentage in it ("Trip Progress · 70%") from the same number the readiness
 * card showed. It now shows the server's headline and the seven checks, and no
 * number out of 100 — whatever `progress` still carries on the model.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { render, screen } from '@testing-library/react-native';

jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { push: jest.fn() },
}));

import { TripHero } from '../TripPage.tsx';
import { mockTripDetail } from '../../__fixtures__/tripDetail.ts';

describe('TripHero — §8 readiness explained, never a percentage', () => {
  it("shows the server's headline and the checks, and no percentage, even though the model still carries a number", async () => {
    await render(<TripHero trip={{ ...mockTripDetail, progress: 70, readinessHeadline: 'somewhere to stay needs action; documents is incomplete' }} />);
    expect(screen.getByText('Trip readiness')).toBeTruthy();
    expect(screen.getByTestId('trip-hero-readiness-line').props.children).toBe('somewhere to stay needs action; documents is incomplete');
    expect(screen.queryByText(/\d+ ?%/)).toBeNull();
    expect(screen.queryByText('Trip Progress')).toBeNull();
    // The seven checks (here the fixture's four) are the explanation's body.
    expect(screen.getByText('Add your availability')).toBeTruthy();
    expect(screen.getByText('Check-in to first plan')).toBeTruthy();
  });

  it('says the read did not answer when there is no headline and no number — never a confident 0%', async () => {
    await render(<TripHero trip={{ ...mockTripDetail, progress: null, readinessHeadline: null }} />);
    expect(screen.getByText("We couldn't check this trip's readiness just now.")).toBeTruthy();
    expect(screen.queryByText(/\d+ ?%/)).toBeNull();
  });

  it('an older server with a number but no headline still gets no percentage', async () => {
    await render(<TripHero trip={{ ...mockTripDetail, progress: 70, readinessHeadline: null }} />);
    expect(screen.getByText('What is ready, and what is not:')).toBeTruthy();
    expect(screen.queryByText(/70/)).toBeNull();
  });
});
