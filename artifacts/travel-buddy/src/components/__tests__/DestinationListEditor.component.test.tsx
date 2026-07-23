/**
 * DestinationListEditor — component tests.
 *
 * Covers:
 *  1. Renders the "Add stop" button with no rows initially.
 *  2. Add a destination row — picker opens, city selected, row appears.
 *  3. Remove a destination row — row hidden from list.
 *  4. Reorder in create mode — up-arrow swaps rows, no API call.
 *  5. Reorder in edit mode — calls reorderDestinations with new order.
 *  6. Edit mode add — calls addDestination when a city is picked.
 *
 * Key: all fireEvent calls must be awaited in RNTL v14 (they return Promises);
 * skipping await leaves state updates uncommitted and subsequent queries stale.
 *
 * For accessibility label queries, use screen.getAllByLabelText (RNTL v14 name
 * for what was accessibilityLabel in earlier versions).
 *
 * GlobalPlacePicker stub: all data is inlined in the factory with no external
 * variable refs — avoids temporal-dead-zone from jest.mock() hoisting.
 *
 * Run with:  pnpm test:component
 */

import React, { useState } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { DestinationListEditor, type DestinationEntry } from '../trip/DestinationListEditor.tsx';

// NOTE: intentionally exhaustive — react-native-safe-area-context has native internals.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// NOTE: intentionally exhaustive — GlobalPlacePicker pulls expo-location native
// internals. All city data is inlined (no external variable refs) so the hoisted
// factory never lands in the temporal dead zone.
jest.mock('../selectors/GlobalPlacePicker', () => {
  const ReactActual = jest.requireActual('react');
  const { Pressable, Text } = jest.requireActual('react-native');
  return {
    GlobalPlacePicker: ({ visible, onSelect, onClose }: any) =>
      visible
        ? ReactActual.createElement(
            Pressable,
            {
              testID: 'mock-place-picker',
              onPress: () => {
                onSelect({
                  id: 'p-tokyo', type: 'city', name: 'Tokyo',
                  displayName: 'Tokyo, Japan', country: 'Japan', city: 'Tokyo',
                  lat: 35.68, lng: 139.69,
                });
                onClose();
              },
            },
            ReactActual.createElement(Text, null, 'Pick city'),
          )
        : null,
  };
});

// NOTE: intentionally exhaustive — GlobalCalendarPicker pulls calendar native modules.
jest.mock('../selectors/GlobalCalendarPicker', () => ({
  GlobalCalendarPicker: () => null,
}));

// NOTE: intentionally exhaustive — tripDestinations imports apiToken native deps.
jest.mock('../../services/tripDestinations', () => ({
  addDestination: jest.fn(),
  reorderDestinations: jest.fn(),
  deleteDestination: jest.fn(),
}));

// ── Stateful wrapper so onChange propagates back into the component ───────────
function Wrapper({
  initialDestinations = [] as DestinationEntry[],
  tripId,
}: { initialDestinations?: DestinationEntry[]; tripId?: string }) {
  const [dests, setDests] = useState<DestinationEntry[]>(initialDestinations);
  return (
    <DestinationListEditor tripId={tripId} destinations={dests} onChange={setDests} />
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('DestinationListEditor', () => {
  let mockAdd: jest.Mock;
  let mockReorder: jest.Mock;
  let mockDelete: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    const svc = require('../../services/tripDestinations.ts') as any;
    mockAdd = svc.addDestination;
    mockReorder = svc.reorderDestinations;
    mockDelete = svc.deleteDestination;
    mockAdd.mockResolvedValue({
      id: 'dest-server-1', city: 'Tokyo', country: 'Japan', position: 1, created_at: '',
    });
    mockReorder.mockResolvedValue(true);
    mockDelete.mockResolvedValue(true);
  });

  it('renders the Add stop button with no rows initially', async () => {
    const { getByTestId, queryByTestId } = await render(<Wrapper />);
    expect(getByTestId('add-destination')).toBeTruthy();
    expect(queryByTestId('remove-dest-0')).toBeNull();
  });

  it('adds a destination row when a city is picked (create mode)', async () => {
    const { getByTestId, findByTestId, findByText } = await render(<Wrapper />);

    // Awaiting fireEvent is required in RNTL v14 — it returns a Promise and
    // the state update (setPlacePickerRow) only commits after the await.
    await fireEvent.press(getByTestId('add-destination'));

    // Picker appears after state commits — use async findBy to wait for it.
    const picker = await findByTestId('mock-place-picker');
    await fireEvent.press(picker);

    await findByText('Tokyo, Japan');
    expect(getByTestId('remove-dest-0')).toBeTruthy();
  });

  it('removes a destination row', async () => {
    const { getByTestId, findByTestId, findByText, queryByText } = await render(<Wrapper />);

    await fireEvent.press(getByTestId('add-destination'));
    const picker = await findByTestId('mock-place-picker');
    await fireEvent.press(picker);
    await findByText('Tokyo, Japan');

    await fireEvent.press(getByTestId('remove-dest-0'));

    await waitFor(() => {
      expect(queryByText('Tokyo, Japan')).toBeNull();
    });
  });

  it('moves a stop up in create mode without calling the API', async () => {
    // Pre-populate so no picker presses needed — keeps press budget for the arrow.
    const initialDests: DestinationEntry[] = [
      { key: 'k1', city: 'Tokyo', country: 'Japan' },
      { key: 'k2', city: 'Paris', country: 'France' },
    ];

    await render(<Wrapper initialDestinations={initialDests} />);
    await screen.findByText('Tokyo, Japan');

    // RNTL v14 uses getAllByLabelText for accessibilityLabel queries.
    const moveUpBtns = screen.getAllByLabelText(/Move destination \d+ up/);
    await fireEvent.press(moveUpBtns[1]);

    expect(mockReorder).not.toHaveBeenCalled();
  });

  it('calls reorderDestinations after reorder in edit mode', async () => {
    const initialDests: DestinationEntry[] = [
      { key: 'k1', id: 'dest-1', city: 'Tokyo', country: 'Japan' },
      { key: 'k2', id: 'dest-2', city: 'Paris', country: 'France' },
    ];

    await render(<Wrapper tripId="trip-abc" initialDestinations={initialDests} />);
    await screen.findByText('Tokyo, Japan');

    const moveUpBtns = screen.getAllByLabelText(/Move destination \d+ up/);
    await fireEvent.press(moveUpBtns[1]);

    await waitFor(() => {
      expect(mockReorder).toHaveBeenCalledWith('trip-abc', ['dest-2', 'dest-1']);
    });
  });

  it('calls deleteDestination with the correct destId when a server row is removed in edit mode', async () => {
    // Pre-populate with a row that already has a server ID (edit mode).
    const initialDests: DestinationEntry[] = [
      { key: 'k1', id: 'dest-server-99', city: 'Tokyo', country: 'Japan' },
    ];

    const { getByTestId, queryByText } = await render(
      <Wrapper tripId="trip-edit" initialDestinations={initialDests} />,
    );

    await screen.findByText('Tokyo, Japan');

    await fireEvent.press(getByTestId('remove-dest-0'));

    await waitFor(() => {
      expect(mockDelete).toHaveBeenCalledWith('trip-edit', 'dest-server-99');
    });

    // Row should also disappear from the UI.
    await waitFor(() => {
      expect(queryByText('Tokyo, Japan')).toBeNull();
    });
  });

  it('disables the remove button while the DELETE is in-flight and hides the row after resolution', async () => {
    // Pre-populate with a server row (edit mode).
    const initialDests: DestinationEntry[] = [
      { key: 'k1', id: 'dest-slow-99', city: 'Tokyo', country: 'Japan' },
    ];

    // Deferred promise — lets us control when the delete resolves.
    let resolveDelete!: (v: boolean) => void;
    const deletePromise = new Promise<boolean>((res) => { resolveDelete = res; });
    mockDelete.mockReturnValue(deletePromise);

    const { getByTestId, queryByText } = await render(
      <Wrapper tripId="trip-slow" initialDestinations={initialDests} />,
    );

    await screen.findByText('Tokyo, Japan');

    // Fire the remove press — do NOT await full resolution yet.
    // The async handler sets busyRows immediately, so the button should
    // be disabled on the very next render.
    fireEvent.press(getByTestId('remove-dest-0'));

    // Button should be disabled while delete is in-flight.
    await waitFor(() => {
      expect(getByTestId('remove-dest-0').props.accessibilityState?.disabled).toBe(true);
    });

    // Row should still be visible (not yet hidden — waiting on the API).
    expect(queryByText('Tokyo, Japan')).not.toBeNull();

    // Resolve the delete — the row should now be hidden.
    resolveDelete(true);

    await waitFor(() => {
      expect(queryByText('Tokyo, Japan')).toBeNull();
    });
  });

  it('calls addDestination when a city is picked in edit mode', async () => {
    const { getByTestId, findByTestId, findByText } = await render(
      <Wrapper tripId="trip-xyz" />,
    );

    await fireEvent.press(getByTestId('add-destination'));
    const picker = await findByTestId('mock-place-picker');
    await fireEvent.press(picker);

    await findByText('Tokyo, Japan');

    await waitFor(() => {
      expect(mockAdd).toHaveBeenCalledWith(
        'trip-xyz',
        expect.objectContaining({ city: 'Tokyo', country: 'Japan' }),
      );
    });
  });
});
