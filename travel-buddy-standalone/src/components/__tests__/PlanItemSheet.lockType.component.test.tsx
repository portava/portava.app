/**
 * PlanItemSheet lock-type selector wiring — verifies that picking "Fixed" in
 * the edit form and saving sends `lockType: 'fixed'` through updatePlanItem
 * (the PATCH /trips/:tripId/plan/items/:id path).
 *
 * Budget notes (see memory: rntl-react19-renderer-budget): single it(), two
 * presses total, assertions on mock args, no trailing unmount.
 */
import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import { PlanItemSheet } from '../itinerary/PlanItemSheet.tsx';
import { updatePlanItem } from '../../services/tripPlan.ts';
import type { TripPlanItem } from '../../types/models.ts';

// Modal leaves a floating async act() scope; replace with a synchronous View.
jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  const R = require('react');
  const MockModal = ({ children, visible }: any) =>
    visible === false ? null : R.createElement(actual.View, null, children);
  const MockActivityIndicator = () => null;
  return new Proxy(actual, {
    get(target, prop, receiver) {
      if (prop === 'Modal') return MockModal;
      if (prop === 'ActivityIndicator') return MockActivityIndicator;
      return Reflect.get(target, prop, receiver);
    },
  });
});

jest.mock('../../services/tripPlan.ts', () => ({
  ...jest.requireActual('../../services/tripPlan.ts'),
  updatePlanItem: jest.fn(async (_tripId: string, itemId: string, patch: any) => ({
    id: itemId,
    ...patch,
  })),
  removePlanItem: jest.fn(async () => undefined),
}));

// NOTE: stub pickers — native date/place pickers are irrelevant to lock-type wiring.
jest.mock('../DateTimePickerField', () => ({
  DatePickerField: () => null,
}));
// NOTE: stub — GlobalPlacePicker pulls in map/geo stacks not under test here.
jest.mock('../selectors/GlobalPlacePicker.tsx', () => ({
  GlobalPlacePicker: () => null,
}));

function baseItem(): TripPlanItem {
  return {
    id: 'item-1',
    tripId: 'trip-1',
    creatorId: 'user-1',
    title: 'Dinner at Anzani',
    category: 'dining',
    status: 'tentative',
    sourceType: 'manual',
    sourceId: null,
    dayDate: null,
    startsAt: null,
    endsAt: null,
    locationName: null,
    notes: null,
    sortOrder: 1000,
    visibility: 'members',
    lat: null,
    lng: null,
    locationIsPrivate: false,
    lockType: 'flexible',
    warnings: [],
    createdAt: '2026-07-01T00:00:00Z',
    updatedAt: '2026-07-01T00:00:00Z',
  };
}

it('saves the selected lock type via updatePlanItem', async () => {
  const onUpdated = jest.fn();
  const view = await render(
    <PlanItemSheet
      item={baseItem()}
      tripId="trip-1"
      currentUserId="user-1"
      isOwner
      canEdit
      startInEditMode
      onClose={() => {}}
      onUpdated={onUpdated}
      onRemoved={() => {}}
    />,
  );

  // Selector renders all three options with the Autopilot hint for the
  // current (flexible) selection.
  expect(view.getByText('Autopilot handling')).toBeTruthy();
  expect(view.getByText('Optional')).toBeTruthy();
  expect(view.getByText('Autopilot may reschedule this item to fix conflicts.')).toBeTruthy();

  // Bare press — sync setState; waitFor flushes the commit and confirms the
  // hint updates to the Fixed explanation.
  fireEvent.press(view.getByText('Fixed'));
  await waitFor(() =>
    expect(view.getByText('Autopilot never moves or replaces this item.')).toBeTruthy(),
  );

  // Press #2: save → PATCH payload carries lockType 'fixed'.
  fireEvent.press(view.getByText('Save Changes'));
  await waitFor(() => expect(updatePlanItem).toHaveBeenCalledTimes(1));
  const [tripId, itemId, patch] = (updatePlanItem as jest.Mock).mock.calls[0];
  expect(tripId).toBe('trip-1');
  expect(itemId).toBe('item-1');
  expect(patch.lockType).toBe('fixed');
  await waitFor(() => expect(onUpdated).toHaveBeenCalled());
  expect(onUpdated.mock.calls[0][0].lockType).toBe('fixed');
});
