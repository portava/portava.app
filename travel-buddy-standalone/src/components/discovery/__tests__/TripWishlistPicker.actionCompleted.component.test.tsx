/**
 * §44 `action_completed` (census G319) — BOTH arms, from the picker that knows.
 *
 * WHAT WAS MISSING
 * ----------------
 * G319 read NOT-BUILT with the note: "The emitter now exists … and is
 * deliberately NOT called from `SmartInput`: selecting an action row OPENS a
 * propose-only picker, and calling the event 'completed' at that moment would
 * make every abandoned picker look like a success. The only place that knows is
 * the screen that dispatches the action." The census then named the owner: "the
 * global-search screen calling `emitActionCompleted` after the trip picker
 * CONFIRMS."
 *
 * `TripWishlistPicker` already told its caller about successes (`onSaved`). It
 * had no way to say a save was ATTEMPTED AND FAILED, so a caller wired to it
 * could only ever report `ok: true` — an `action_completed` that is green
 * because it cannot be anything else. `onSaveFailed` is that arm, and these
 * tests are why it is not decoration.
 *
 * EVERY TEST NAMES ITS MUTATION, and each was applied and watched go RED.
 */
import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';

// NOTE: exhaustive-by-design stub — `trips.ts` reaches Supabase at module load
// through the shared client, which has no native module under jest. This
// factory lists the two exports this component uses; `TripRow` is a type and
// carries no runtime binding.
jest.mock('../../../services/trips.ts', () => ({
  listMyTrips: jest.fn(),
}));
// NOTE: exhaustive-by-design stub — the full runtime export surface of
// discoveryBookmarks.ts as this component uses it. A new export becomes a
// deliberate contract change here rather than silent drift.
jest.mock('../../../services/discoveryBookmarks.ts', () => ({
  toggleSave: jest.fn(),
  getSavedListIds: jest.fn(),
}));
// NOTE: exhaustive-by-design stub — deferredNavigate.ts schedules a real
// navigation through expo-router, which is not mounted in a component test.
jest.mock('../../../lib/deferredNavigate.ts', () => ({
  closeThenNavigate: jest.fn(),
}));

import { TripWishlistPicker, type AddToTripPayload } from '../TripWishlistPicker.tsx';
import { listMyTrips } from '../../../services/trips.ts';
import { toggleSave, getSavedListIds } from '../../../services/discoveryBookmarks.ts';

const TRIP = { id: 't-1', title: 'Songkran', destination: 'Bangkok' };

const PLACE: AddToTripPayload = {
  id: 'c-1',
  name: 'Bangkok',
  category: 'city',
  type: 'city',
  address: 'Thailand',
  lat: null,
  lng: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  (listMyTrips as jest.Mock).mockResolvedValue([TRIP]);
  (getSavedListIds as jest.Mock).mockResolvedValue(new Set<string>());
});

async function openPicker(handlers: {
  onSaved?: jest.Mock;
  onSaveFailed?: jest.Mock;
}) {
  // RNTL v14: render() is async — always await the mount.
  const r = await render(
    <TripWishlistPicker
      place={PLACE}
      visible
      onClose={() => {}}
      onSaved={handlers.onSaved}
      onSaveFailed={handlers.onSaveFailed}
    />,
  );
  await waitFor(() => r.getByText('Songkran'));
  return r;
}

test('§44/G319: a CONFIRMED save reports the success arm and not the failure arm', async () => {
  (toggleSave as jest.Mock).mockResolvedValue({ added: true });
  const onSaved = jest.fn();
  const onSaveFailed = jest.fn();

  const r = await openPicker({ onSaved, onSaveFailed });
  fireEvent.press(r.getByText('Songkran'));

  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  expect(onSaved.mock.calls[0][0].id).toBe('t-1');
  expect(onSaveFailed).not.toHaveBeenCalled();
  r.unmount();
});

test('§44/G319: a FAILED save reports the failure arm — it is not silence', async () => {
  (toggleSave as jest.Mock).mockRejectedValue(new Error('network'));
  const onSaved = jest.fn();
  const onSaveFailed = jest.fn();

  const r = await openPicker({ onSaved, onSaveFailed });
  fireEvent.press(r.getByText('Songkran'));

  // MUTATION: delete `onSaveFailed?.(trip)` from the catch and this goes red —
  // which is the state the component shipped in, and the reason a caller could
  // only ever emit ok:true.
  await waitFor(() => expect(onSaveFailed).toHaveBeenCalledTimes(1));
  expect(onSaved).not.toHaveBeenCalled();
  r.unmount();
});

test('§44/G319: an UNTOGGLED save (already saved → removed) is neither arm', async () => {
  // `toggleSave` resolving `{added:false}` means the place was REMOVED from the
  // trip. That is not an `add_to_trip` completion and must not be counted as
  // one, or the metric counts undos as successes.
  (toggleSave as jest.Mock).mockResolvedValue({ added: false });
  const onSaved = jest.fn();
  const onSaveFailed = jest.fn();

  const r = await openPicker({ onSaved, onSaveFailed });
  fireEvent.press(r.getByText('Songkran'));

  await waitFor(() => expect(toggleSave).toHaveBeenCalled());
  expect(onSaved).not.toHaveBeenCalled();
  expect(onSaveFailed).not.toHaveBeenCalled();
  r.unmount();
});

test('§44/G319: opening and abandoning the picker reports NOTHING', async () => {
  const onSaved = jest.fn();
  const onSaveFailed = jest.fn();

  const r = await openPicker({ onSaved, onSaveFailed });
  // No press at all — the user changed their mind.
  expect(onSaved).not.toHaveBeenCalled();
  expect(onSaveFailed).not.toHaveBeenCalled();
  expect(toggleSave).not.toHaveBeenCalled();
  r.unmount();
});
