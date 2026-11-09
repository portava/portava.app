import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
const mockAreas = jest.fn(); const mockConsent = jest.fn(); const mockSetConsent = jest.fn(); const mockPush = jest.fn();
// NOTE: isolates network/storage results so the mounted settings flow can exercise partial failure and withdrawal without a real account.
jest.mock('../../../services/mapPrivacy', () => ({ readProtectedPlaces: () => mockAreas(), readMapRouteConsent: () => mockConsent(), setMapRouteConsent: (...args: unknown[]) => mockSetConsent(...args), removeProtectedPlace: jest.fn() }));
// NOTE: navigation is observed rather than launching an actual map; the focus callback runs once per mount.
jest.mock('expo-router', () => ({ router: { push: (...args: unknown[]) => mockPush(...args) }, useFocusEffect: (callback: () => void) => { require('react').useEffect(callback, [callback]); } }));
// NOTE: owner remount behavior is covered by useInputAccountEpoch; this test keeps one authenticated owner stable.
jest.mock('../../../platform/input-assistance/hooks/useInputAccountEpoch', () => ({ useInputAccountEpoch: () => 1 }));
import { setDiscoveryViewerFromSession } from '../../../services/discoveryViewerScope.ts';
import { MapPrivacySection } from '../MapPrivacySection.tsx';
const words = { version: 'v1', title: 'Route contributions', what: 'What is shared.', who: 'Who sees it.', retention: '15 minutes.', off: 'Withdrawal removes it.' };
beforeEach(() => { jest.clearAllMocks(); setDiscoveryViewerFromSession('map-settings-owner'); mockAreas.mockResolvedValue([]); mockConsent.mockResolvedValue({ available: true, current: true, granted: true, disclosure: words }); mockSetConsent.mockResolvedValue(undefined); });
it('keeps protected-area controls reachable if the route-consent read fails', async () => {
  mockConsent.mockRejectedValue(new Error('offline'));
  const ui = await render(<MapPrivacySection />);
  await waitFor(() => expect(ui.getByText('Home')).toBeTruthy());
  fireEvent.press(ui.getByText('Home'));
  expect(mockPush).toHaveBeenCalledWith({ pathname: '/map', params: { protectArea: 'home' } });
  expect(ui.getByText('Some map privacy settings could not be read. Please retry.')).toBeTruthy();
});
it('failed withdrawal displays paused state and an explicit retry', async () => {
  mockSetConsent.mockRejectedValue(new Error('offline'));
  const ui = await render(<MapPrivacySection />);
  await waitFor(() => expect(ui.getByTestId('map-route-flow-consent')).toBeTruthy());
  fireEvent(ui.getByTestId('map-route-flow-consent'), 'valueChange', false);
  await waitFor(() => expect(ui.getByText('Retry route withdrawal')).toBeTruthy());
  expect(ui.getByTestId('map-route-flow-consent').props.value).toBe(false);
  fireEvent.press(ui.getByText('Retry route withdrawal'));
  await waitFor(() => expect(mockSetConsent).toHaveBeenCalledTimes(2));
});
it('an unavailable reviewed disclosure never presents an enabled opt-in switch', async () => {
  mockConsent.mockResolvedValue({ available: false, current: false, granted: false, disclosure: null });
  const ui = await render(<MapPrivacySection />);
  await waitFor(() => expect(ui.getByTestId('map-route-flow-consent').props.disabled).toBe(true));
  expect(mockSetConsent).not.toHaveBeenCalled();
});
