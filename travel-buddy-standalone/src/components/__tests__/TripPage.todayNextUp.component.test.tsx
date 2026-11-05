/**
 * TodayNextUp (src/components/TripPage.tsx) — "View Plan" stays on the trip.
 *
 * It used to push the Trips tab, which left the trip the traveller was reading.
 * The plan is a section of the trip page, so the page passes `onViewPlan`
 * (scroll to that section); without it the button is not drawn.
 *
 * Run with: npx jest src/components/__tests__/TripPage.todayNextUp.component.test.tsx
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { push: (...args: unknown[]) => mockPush(...args) },
}));

import { TodayNextUp } from '../TripPage.tsx';

const ACTION = { title: 'Book somewhere to stay', detail: null, category: 'stay', severity: 'high', dueAt: null };

describe('TodayNextUp — View Plan', () => {
  beforeEach(() => mockPush.mockClear());

  it('scrolls to the plan on this page instead of leaving for the Trips tab', async () => {
    const onViewPlan = jest.fn();
    await render(<TodayNextUp nextUp={null} tripId="trip-1" action={ACTION} onViewPlan={onViewPlan} />);
    fireEvent.press(screen.getByText('View Plan'));
    expect(onViewPlan).toHaveBeenCalledTimes(1);
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('is not drawn when there is no plan section to go to', async () => {
    await render(<TodayNextUp nextUp={null} tripId="trip-1" action={ACTION} />);
    expect(screen.queryByText('View Plan')).toBeNull();
    expect(screen.getByText('Ask Compass')).toBeTruthy();
  });
});
