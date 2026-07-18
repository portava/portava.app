/**
 * Remaining admin screens (content reports, feature flags, hashtags,
 * geocode cache, trust detail, schema drift) — error banner screen-reader
 * accessibility.
 *
 * Run with: pnpm test:component
 *
 * ## What's covered
 *
 * When the initial data fetch fails, each screen shows an error banner.
 * These tests assert the banner container carries accessibilityRole="alert"
 * and accessibilityLiveRegion="assertive" so TalkBack/VoiceOver announce the
 * dynamically-appearing error instead of leaving it silent.
 */

import React from 'react';
import { render, waitFor, screen } from '@testing-library/react-native';

// ── Module mocks ─────────────────────────────────────────────────────────────

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useLocalSearchParams: jest.fn(() => ({ userId: 'user-1' })),
}));

jest.mock('../../../src/hooks/useRequireAdmin', () => ({
  ...jest.requireActual('../../../src/hooks/useRequireAdmin'),
  useRequireAdmin: jest.fn(),
}));

jest.mock('../../../src/context/SessionContext', () => ({
  ...jest.requireActual('../../../src/context/SessionContext'),
  useSession: () => ({ isAuthed: true, loading: false }),
}));

jest.mock('../../../src/services/reportsAdmin', () => ({
  ...jest.requireActual('../../../src/services/reportsAdmin'),
  fetchAdminReports: jest.fn(),
}));

jest.mock('../../../src/services/adminApi', () => ({
  ...jest.requireActual('../../../src/services/adminApi'),
  adminGet: jest.fn(),
  adminPost: jest.fn(),
  adminPatch: jest.fn(),
}));

jest.mock('../../../src/services/adminGeocode', () => ({
  ...jest.requireActual('../../../src/services/adminGeocode'),
  getGeocodeCacheRows: jest.fn(),
  deleteGeocodeCacheRow: jest.fn(),
  putGeocodeCacheRow: jest.fn(),
}));

jest.mock('../../../src/services/trustAdmin', () => ({
  ...jest.requireActual('../../../src/services/trustAdmin'),
  fetchUserTrustDetail: jest.fn(),
}));

import { fetchAdminReports } from '../../../src/services/reportsAdmin';
import { adminGet } from '../../../src/services/adminApi';
import { getGeocodeCacheRows } from '../../../src/services/adminGeocode';
import { fetchUserTrustDetail } from '../../../src/services/trustAdmin';
import ContentReportsScreen from '../content-reports';
import FeatureFlagsScreen from '../feature-flags';
import HashtagsScreen from '../hashtags';
import GeocodeCacheScreen from '../geocode-cache';
import TrustDetailScreen from '../trust-detail';
import SchemaDriftScreen from '../schema-drift';

const mockFetchReports    = fetchAdminReports as jest.Mock;
const mockAdminGet        = adminGet as jest.Mock;
const mockGetGeocodeRows  = getGeocodeCacheRows as jest.Mock;
const mockFetchTrustDetail = fetchUserTrustDetail as jest.Mock;

function expectAlertBanner(testID: string) {
  const banner = screen.getByTestId(testID);
  expect(banner.props.accessibilityRole).toBe('alert');
  expect(banner.props.accessibilityLiveRegion).toBe('assertive');
}

describe('remaining admin error banners are announced to screen readers', () => {
  beforeEach(() => jest.clearAllMocks());

  it('content reports: load-failure banner has alert role + assertive live region', async () => {
    mockFetchReports.mockRejectedValue(new Error('reports down'));
    render(<ContentReportsScreen />);
    await waitFor(() => expect(screen.getByTestId('content-reports-error')).toBeTruthy(), { timeout: 5000 });
    expectAlertBanner('content-reports-error');
    expect(screen.getByText('reports down')).toBeTruthy();
  });

  it('feature flags: load-failure banner has alert role + assertive live region', async () => {
    mockAdminGet.mockResolvedValue({ ok: false, error: 'flags down' });
    render(<FeatureFlagsScreen />);
    await waitFor(() => expect(screen.getByTestId('feature-flags-error')).toBeTruthy(), { timeout: 5000 });
    expectAlertBanner('feature-flags-error');
    expect(screen.getByText('flags down')).toBeTruthy();
  });

  it('hashtags: load-failure banner has alert role + assertive live region', async () => {
    mockAdminGet.mockResolvedValue({ ok: false, error: 'hashtags down' });
    render(<HashtagsScreen />);
    await waitFor(() => expect(screen.getByTestId('hashtags-error')).toBeTruthy(), { timeout: 5000 });
    expectAlertBanner('hashtags-error');
    expect(screen.getByText('hashtags down')).toBeTruthy();
  });

  it('geocode cache: load-failure banner has alert role + assertive live region', async () => {
    mockGetGeocodeRows.mockResolvedValue({ ok: false, error: 'cache down' });
    render(<GeocodeCacheScreen />);
    await waitFor(() => expect(screen.getByTestId('geocode-cache-error')).toBeTruthy(), { timeout: 5000 });
    expectAlertBanner('geocode-cache-error');
    expect(screen.getByText('cache down')).toBeTruthy();
  });

  it('trust detail: load-failure banner has alert role + assertive live region', async () => {
    mockFetchTrustDetail.mockRejectedValue(new Error('trust down'));
    render(<TrustDetailScreen />);
    await waitFor(() => expect(screen.getByTestId('trust-detail-error')).toBeTruthy(), { timeout: 5000 });
    expectAlertBanner('trust-detail-error');
    expect(screen.getByText('trust down')).toBeTruthy();
  });

  it('schema drift: load-failure banner has alert role + assertive live region', async () => {
    mockAdminGet.mockResolvedValue({ ok: false, error: 'drift down' });
    render(<SchemaDriftScreen />);
    await waitFor(() => expect(screen.getByTestId('schema-drift-error')).toBeTruthy(), { timeout: 5000 });
    expectAlertBanner('schema-drift-error');
    expect(screen.getByText('drift down')).toBeTruthy();
  });
});
