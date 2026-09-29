/**
 * TRIP-F26: TripGeofenceCard mounts the geofence components on the trip page.
 */
import React from 'react';
import { Text } from 'react-native';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';

jest.mock('../../../../components/itinerary/GeofenceSettingsSheet.tsx', () => {
  const { Text: T } = jest.requireActual('react-native');
  return { ...jest.requireActual('../../../../components/itinerary/GeofenceSettingsSheet.tsx'), GeofenceSettingsSheet: () => <T testID="mock-settings-sheet">settings</T> };
});
jest.mock('../../../../components/itinerary/PlanCheckInView.tsx', () => {
  const { Text: T } = jest.requireActual('react-native');
  return { ...jest.requireActual('../../../../components/itinerary/PlanCheckInView.tsx'), PlanCheckInView: ({ isAcceptedMember }: { isAcceptedMember: boolean }) => <T testID="mock-checkin">{String(isAcceptedMember)}</T> };
});
jest.mock('../../../../components/itinerary/HostAttendanceDashboard.tsx', () => {
  const { Text: T } = jest.requireActual('react-native');
  return { ...jest.requireActual('../../../../components/itinerary/HostAttendanceDashboard.tsx'), HostAttendanceDashboard: ({ visible }: { visible: boolean }) => (visible ? <T testID="mock-attendance">attendance</T> : null) };
});

import { TripGeofenceCard } from '../TripGeofenceCard.tsx';

void Text;
const geofence = { id: 'g1', publicPreviewLevel: 'venue_tagged', hostEnabled: true, locationLabel: 'Café Nata' };

beforeAll(() => {
  process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://x.supabase.co';
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'anon';
});
afterAll(() => {
  delete process.env.EXPO_PUBLIC_SUPABASE_URL;
  delete process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
});

it('flag off: renders nothing', async () => {
  const load = jest.fn().mockResolvedValue({ state: 'ok', data: { featureEnabled: false, geofence: null } });
  const r = await render(<TripGeofenceCard tripId="t1" isOwner isMember load={load} />);
  await waitFor(() => expect(load).toHaveBeenCalled());
  await waitFor(() => expect(r.queryByTestId('trip-geofence-loading')).toBeNull());
  expect(r.queryByTestId('trip-geofence-card')).toBeNull();
});

it('the owner with no check-in point can set one up; with one, can open attendance', async () => {
  const load = jest.fn().mockResolvedValueOnce({ state: 'ok', data: { featureEnabled: true, geofence: null } })
    .mockResolvedValue({ state: 'ok', data: { featureEnabled: true, geofence } });
  const r = await render(<TripGeofenceCard tripId="t1" isOwner isMember load={load} />);
  await waitFor(() => r.getByText('Set up check-in'));
  await fireEvent.press(r.getByTestId('trip-geofence-settings'));
  expect(r.getByTestId('mock-settings-sheet')).toBeTruthy();
  const r2 = await render(<TripGeofenceCard tripId="t2" isOwner isMember load={load} />);
  await waitFor(() => r2.getByTestId('trip-geofence-attendance'));
  await fireEvent.press(r2.getByTestId('trip-geofence-attendance'));
  expect(r2.getByTestId('mock-attendance')).toBeTruthy();
  expect(r2.queryByTestId('mock-checkin')).toBeNull();
});

it('a member sees the check-in view for an enabled point', async () => {
  const load = jest.fn().mockResolvedValue({ state: 'ok', data: { featureEnabled: true, geofence } });
  await render(<TripGeofenceCard tripId="t1" isOwner={false} isMember load={load} />);
  await waitFor(() => screen.getByTestId('mock-checkin'));
  expect(screen.getByTestId('mock-checkin').props.children).toBe('true');
});

it('a failed read is shown with a retry, never as "no check-in"', async () => {
  const load = jest.fn().mockResolvedValueOnce({ state: 'unavailable', detail: 'Failed to load geofence' })
    .mockResolvedValue({ state: 'ok', data: { featureEnabled: true, geofence } });
  await render(<TripGeofenceCard tripId="t1" isOwner={false} isMember load={load} />);
  await waitFor(() => screen.getByTestId('trip-geofence-unavailable'));
  await fireEvent.press(screen.getByTestId('trip-geofence-retry'));
  await waitFor(() => screen.getByTestId('mock-checkin'));
});
