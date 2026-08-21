/**
 * marketplace.tsx — selected city propagation.
 *
 * A picked city must update all three consumers together:
 * temporary app location context, route params, and the buddy-search request.
 */
import React from 'react';
import { act, render, waitFor } from '@testing-library/react-native';

let mockParams: Record<string, string> = {};
// NOTE: intentional exhaustive stub — only router state used by Marketplace is modeled.
jest.mock('expo-router', () => ({
  router: {
    push: jest.fn(),
    back: jest.fn(),
    replace: jest.fn(),
    setParams: jest.fn(),
  },
  useLocalSearchParams: () => mockParams,
}));

import { router } from 'expo-router';
const mockSetParams = router.setParams as jest.Mock;

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

// NOTE: intentional exhaustive stub — the concrete inset value is irrelevant here.
jest.mock('../../../src/hooks/useBottomInset', () => ({
  usePlainBottomInset: () => 34,
}));

const mockSetSessionLocation = jest.fn();
// NOTE: intentional exhaustive stub — Marketplace only reads setSessionLocation.
jest.mock('../../../src/context/LocationContext', () => ({
  useLocationContext: () => ({
    setSessionLocation: mockSetSessionLocation,
  }),
}));

// NOTE: intentional exhaustive stub — this test exercises only the search request.
jest.mock('../../../src/services/rentABuddy', () => ({
  searchBuddies: jest.fn().mockResolvedValue({
    ok: true,
    data: { buddies: [], total: 0 },
  }),
}));
import { searchBuddies } from '../../../src/services/rentABuddy';
const mockSearchBuddies = searchBuddies as jest.Mock;

let capturedOnSelect: ((place: any) => void) | undefined;
// NOTE: intentional exhaustive stub — captures selection without mounting native picker internals.
jest.mock('../../../src/components/selectors/GlobalPlacePicker', () => ({
  GlobalPlacePicker: ({ onSelect }: { onSelect?: (place: any) => void }) => {
    capturedOnSelect = onSelect;
    return null;
  },
}));

// NOTE: intentional exhaustive stub — loading/error visuals are outside this propagation test.
jest.mock('../../../src/components/primitives', () => ({
  TravelErrorState: () => null,
  TravelLoadingState: () => null,
}));

// NOTE: intentional exhaustive stub — result-card rendering is outside this propagation test.
jest.mock('../../../src/components/BuddyCard', () => ({
  BuddyCard: () => null,
}));

import Marketplace from '../marketplace';

beforeEach(() => {
  mockParams = {};
  capturedOnSelect = undefined;
  mockSetParams.mockClear();
  mockSetSessionLocation.mockClear();
  mockSearchBuddies.mockClear();
});

describe('Marketplace — selected city propagation', () => {
  it('updates context and route params, then searches with the selected coordinates', async () => {
    await render(<Marketplace />);

    const cebu = { city: 'Cebu City', name: 'Cebu', lat: 10.3157, lng: 123.8854 };
    await act(async () => {
      capturedOnSelect?.(cebu);
    });

    expect(mockSetSessionLocation).toHaveBeenCalledWith(cebu);
    expect(mockSetParams).toHaveBeenCalledWith({
      city: 'Cebu City',
      lat: '10.3157',
      lng: '123.8854',
    });
    await waitFor(() => expect(mockSearchBuddies).toHaveBeenCalledWith(
      expect.objectContaining({
        city: 'Cebu City',
        lat: 10.3157,
        lng: 123.8854,
      }),
    ));
  });
});