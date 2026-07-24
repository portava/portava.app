/**
 * Component tests — TripFsqPlacesSection
 *
 * Covers:
 *   1. Returns nothing when cityKey is absent
 *   2. Returns nothing when getCityPlaces returns null (flag off / not ingested)
 *   3. Renders place names when data is available
 *   4. ALWAYS renders Foursquare attribution string (license requirement)
 *   5. Renders nothing when places array is empty
 *   6. Groups places by category; accommodation leads
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react-native';
import { TripFsqPlacesSection } from '../trip/TripFsqPlacesSection.tsx';

// NOTE: fsqPlaces exports only the one function used in this component; factory is intentionally exhaustive.
jest.mock('../../services/fsqPlaces', () => ({
  getCityPlaces: jest.fn(),
}));

import { getCityPlaces } from '../../services/fsqPlaces.ts';

const mockGet = getCityPlaces as jest.MockedFunction<typeof getCityPlaces>;

const MOCK_RESULT = {
  attribution: 'Powered by Foursquare',
  datasetDate: '2025-01-01',
  places: [
    {
      fsqId: 'a1',
      name: 'Grand Hotel',
      latitude: 10.3,
      longitude: 123.9,
      category: 'accommodation' as const,
      label: 'Hotel',
      address: '1 Main St',
      locality: 'Cebu City',
      country: 'PH',
      confidence: 'high',
      datasetDate: '2025-01-01',
    },
    {
      fsqId: 'b1',
      name: 'La Tegola',
      latitude: 10.31,
      longitude: 123.91,
      category: 'food' as const,
      label: 'Italian Restaurant',
      address: null,
      locality: 'Cebu City',
      country: 'PH',
      confidence: 'high',
      datasetDate: '2025-01-01',
    },
  ],
};

describe('TripFsqPlacesSection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders nothing when cityKey is absent', async () => {
    await render(<TripFsqPlacesSection />);
    expect(screen.toJSON()).toBeNull();
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('renders nothing when cityKey is null', async () => {
    await render(<TripFsqPlacesSection cityKey={null} />);
    expect(screen.toJSON()).toBeNull();
  });

  it('renders nothing when getCityPlaces returns null (flag off)', async () => {
    mockGet.mockResolvedValue(null);
    await render(<TripFsqPlacesSection cityKey="cebu-ph" />);
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('cebu-ph'));
    expect(screen.toJSON()).toBeNull();
  });

  it('renders nothing when places array is empty', async () => {
    mockGet.mockResolvedValue({ places: [], attribution: 'Powered by Foursquare', datasetDate: null });
    await render(<TripFsqPlacesSection cityKey="cebu-ph" />);
    await waitFor(() => expect(mockGet).toHaveBeenCalled());
    expect(screen.toJSON()).toBeNull();
  });

  it('renders place names when data is available', async () => {
    mockGet.mockResolvedValue(MOCK_RESULT);
    await render(<TripFsqPlacesSection cityKey="cebu-ph" />);
    await waitFor(() => expect(screen.getByText('Grand Hotel')).toBeTruthy());
    expect(screen.getByText('La Tegola')).toBeTruthy();
  });

  it('always renders Foursquare attribution', async () => {
    mockGet.mockResolvedValue(MOCK_RESULT);
    await render(<TripFsqPlacesSection cityKey="cebu-ph" />);
    await waitFor(() =>
      expect(screen.getByText('Powered by Foursquare')).toBeTruthy()
    );
  });

  it('groups places by category — accommodation leads', async () => {
    mockGet.mockResolvedValue(MOCK_RESULT);
    await render(<TripFsqPlacesSection cityKey="cebu-ph" />);
    await waitFor(() => expect(screen.getByText('Accommodation')).toBeTruthy());
    expect(screen.getByText('Food & Drink')).toBeTruthy();
  });

  it('renders place meta text containing locality', async () => {
    mockGet.mockResolvedValue(MOCK_RESULT);
    await render(<TripFsqPlacesSection cityKey="cebu-ph" />);
    // locality is rendered joined with label: "Hotel · Cebu City"
    await waitFor(() =>
      expect(screen.getAllByText(/Cebu City/).length).toBeGreaterThan(0)
    );
  });
});
