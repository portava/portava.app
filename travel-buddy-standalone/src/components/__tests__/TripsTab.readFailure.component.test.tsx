/**
 * TripsTab (Passport "Plans") — a trips read that FAILED is shown as a failure
 * with a retry. Passport used to swallow the error, so the tab fell through to
 * "No trips shown yet" and told the owner they had no trips.
 *
 * Run with: npx jest src/components/__tests__/TripsTab.readFailure.component.test.tsx
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';

// NOTE: intentionally exhaustive — useBottomInset.ts imports reanimated at module
// scope; only useBottomInset is read by TripsTab.
jest.mock('../../hooks/useBottomInset.ts', () => ({
  usePlainBottomInset: () => 130,
  PlainBottomFiller: () => null,
  BOTTOM_BREATHING_ROOM: 24,
  useStickyBarInset: () => ({ inset: 130, onBarLayout: () => {} }),
  useKeyboardVisible: () => false,
  useBottomInset: () => 130,
}));

import { TripsTab } from '../TripsTab.tsx';

describe('TripsTab — failed trips read', () => {
  it('says the trips could not be loaded, offers a retry, and never says "No trips shown yet"', async () => {
    const onRetry = jest.fn();
    await render(<TripsTab trips={[]} isOwner error onRetry={onRetry} />);
    expect(screen.getByText("Couldn't load your trips")).toBeTruthy();
    expect(screen.queryByText('No trips shown yet')).toBeNull();
    fireEvent.press(screen.getByText('Try again'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('control: a read that answered with no trips is still the empty state', async () => {
    await render(<TripsTab trips={[]} isOwner />);
    expect(screen.getByText('No trips shown yet')).toBeTruthy();
    expect(screen.queryByText("Couldn't load your trips")).toBeNull();
  });
});
