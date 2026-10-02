/**
 * GemTripPlanPicker — add a hidden gem to a trip PLAN. TM-social, PLAT-F37.
 *
 * addGemToPlan (POST /hidden-gems/:id/plan) had no caller; "Add to Plan" opened
 * the trip WISHLIST picker. This pins the sheet: each server outcome is
 * reported as itself (added / already in plan / not yours / gone / failed),
 * a failed attempt can be retried, and an unreadable trips list is an error
 * with a retry — never "you have no trips".
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import { GemTripPlanPicker } from '../GemTripPlanPicker.tsx';

jest.mock('../../../services/trips.ts', () => ({
  ...jest.requireActual('../../../services/trips.ts'),
  listMyTrips: jest.fn(),
}));
jest.mock('../../../services/hiddenGems.ts', () => ({
  ...jest.requireActual('../../../services/hiddenGems.ts'),
  addGemToPlan: jest.fn(),
}));

const trips = require('../../../services/trips.ts');
const gems = require('../../../services/hiddenGems.ts');
const T = (id: string, title: string, status = 'upcoming') => ({ id, title, destinationCity: 'Split', destinationCountry: 'Croatia', status });
const httpErr = (status: number, code: string) => Object.assign(new Error(code), { status, code });

jest.setTimeout(20000);

async function mount(onOpenWishlist?: () => void) {
  return render(<GemTripPlanPicker gemId="g-1" gemName="Secret Cove" visible onClose={() => {}} onOpenWishlist={onOpenWishlist} />);
}

describe('GemTripPlanPicker', () => {
  beforeEach(() => jest.clearAllMocks());

  it('lists my open trips (not completed or cancelled)', async () => {
    trips.listMyTrips.mockResolvedValue([T('t1', 'Dalmatia'), T('t2', 'Old trip', 'completed'), T('t3', 'Off', 'cancelled')]);
    const { findByText, queryByText } = await mount();
    await findByText('Dalmatia');
    expect(queryByText('Old trip')).toBeNull();
    expect(queryByText('Off')).toBeNull();
  });

  it('an unreadable trips list is an error with a retry, never "no upcoming trips"', async () => {
    trips.listMyTrips.mockRejectedValueOnce(new Error('Your trips could not be read')).mockResolvedValueOnce([T('t1', 'Dalmatia')]);
    const { findByText, queryByText, getByTestId } = await mount();
    await findByText("Couldn't load your trips.");
    expect(queryByText(/no upcoming trips/)).toBeNull();
    await fireEvent.press(getByTestId('gem-plan-retry'));
    await findByText('Dalmatia');
  });

  it('added → "Added to plan", calling the plan route for this gem and trip', async () => {
    trips.listMyTrips.mockResolvedValue([T('t1', 'Dalmatia')]);
    gems.addGemToPlan.mockResolvedValue({ ok: true, planItemId: 'pi-1' });
    const { findByText, getByTestId } = await mount();
    await findByText('Dalmatia');
    await fireEvent.press(getByTestId('gem-plan-trip-t1'));
    await findByText('Added to plan');
    expect(gems.addGemToPlan).toHaveBeenCalledWith('g-1', 't1');
  });

  it.each([
    [409, 'duplicate', 'Already in plan'],
    [403, 'forbidden', "You can't edit this trip's plan"],
    [404, 'not_found', 'This trip or gem is no longer available'],
  ])('%s → reported as itself, not as a failure or a success', async (status, code, copy) => {
    trips.listMyTrips.mockResolvedValue([T('t1', 'Dalmatia')]);
    gems.addGemToPlan.mockRejectedValue(httpErr(status as number, code as string));
    const { findByText, getByTestId, queryByText } = await mount();
    await findByText('Dalmatia');
    await fireEvent.press(getByTestId('gem-plan-trip-t1'));
    await findByText(copy as string);
    expect(queryByText('Added to plan')).toBeNull();
  });

  it('a failed add can be retried from the same row', async () => {
    trips.listMyTrips.mockResolvedValue([T('t1', 'Dalmatia')]);
    gems.addGemToPlan.mockRejectedValueOnce(httpErr(500, 'db_error')).mockResolvedValueOnce({ ok: true, planItemId: 'pi' });
    const { findByText, getByTestId } = await mount();
    await findByText('Dalmatia');
    await fireEvent.press(getByTestId('gem-plan-trip-t1'));
    await findByText("Couldn't add — tap to try again");
    await fireEvent.press(getByTestId('gem-plan-trip-t1'));
    await findByText('Added to plan');
    expect(gems.addGemToPlan).toHaveBeenCalledTimes(2);
  });

  it('the trip wishlist is still one tap away', async () => {
    trips.listMyTrips.mockResolvedValue([]);
    const onOpenWishlist = jest.fn();
    const { findByText, getByTestId } = await mount(onOpenWishlist);
    await findByText('You have no upcoming trips to plan into.');
    await fireEvent.press(getByTestId('gem-plan-wishlist'));
    expect(onOpenWishlist).toHaveBeenCalledTimes(1);
  });
});
