/**
 * Passport standalone-surface route wrappers pass the viewed traveler through
 * (§2 viewer nav). Each wrapper reads `?userId=`/`?username=` and hands the
 * screen a normalised target (a leading '@' stripped, blank → null/undefined),
 * so a viewer opening `/passport/trust?userId=them-1` sees THEIR passport, not
 * the owner's. The screens themselves do the fetch (covered elsewhere); this
 * pins the wiring so the param name can never drift.
 */
import React from 'react';
import { render } from '@testing-library/react-native';

const params = { current: {} as { userId?: string; username?: string } };
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => params.current,
}));

const mockTrustProps = jest.fn();
const mockJourneysProps = jest.fn();
const mockTravelIdentityProps = jest.fn();
jest.mock('../../../src/features/passport/TrustScreen.tsx', () => ({
  __esModule: true,
  default: (p: unknown) => { mockTrustProps(p); return null; },
}));
jest.mock('../../../src/features/passport/JourneysScreen.tsx', () => ({
  __esModule: true,
  default: (p: unknown) => { mockJourneysProps(p); return null; },
}));
jest.mock('../../../src/features/passport/TravelIdentityScreen.tsx', () => ({
  __esModule: true,
  default: (p: unknown) => { mockTravelIdentityProps(p); return null; },
}));

import TrustRoute from '../trust.tsx';
import JourneysRoute from '../journeys.tsx';
import TravelIdentityRoute from '../travel-identity.tsx';

beforeEach(() => {
  params.current = {};
  mockTrustProps.mockClear();
  mockJourneysProps.mockClear();
  mockTravelIdentityProps.mockClear();
});

it('passes an explicit userId to every surface (viewer nav)', async () => {
  params.current = { userId: 'them-1' };
  await render(<TrustRoute />);
  await render(<JourneysRoute />);
  await render(<TravelIdentityRoute />);
  expect(mockTrustProps).toHaveBeenCalledWith(expect.objectContaining({ userId: 'them-1' }));
  expect(mockJourneysProps).toHaveBeenCalledWith(expect.objectContaining({ targetUserId: 'them-1' }));
  expect(mockTravelIdentityProps).toHaveBeenCalledWith(expect.objectContaining({ targetUserId: 'them-1' }));
});

it('strips a leading @ from an @handle', async () => {
  params.current = { username: '@mai' };
  await render(<JourneysRoute />);
  expect(mockJourneysProps).toHaveBeenCalledWith(expect.objectContaining({ targetUserId: 'mai' }));
});

it('owner view (no param) passes no target', async () => {
  await render(<TrustRoute />);
  await render(<JourneysRoute />);
  await render(<TravelIdentityRoute />);
  expect(mockTrustProps).toHaveBeenCalledWith(expect.objectContaining({ userId: undefined }));
  expect(mockJourneysProps).toHaveBeenCalledWith(expect.objectContaining({ targetUserId: null }));
  expect(mockTravelIdentityProps).toHaveBeenCalledWith(expect.objectContaining({ targetUserId: null }));
});
