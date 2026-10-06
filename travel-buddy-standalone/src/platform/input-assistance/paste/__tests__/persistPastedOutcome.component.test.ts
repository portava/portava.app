/**
 * §24 → §45: the paste-to-Trip write is a DOWNSTREAM TASK the field served, and
 * now reports itself (census G320; OD-INPUT-1). The reporter itself is a no-op
 * without the opt-in (services/__tests__/outcomeLearning.test.ts proves that);
 * this file proves WHEN and WHAT the call site reports.
 *
 * A .component test only because `persistPastedDestinations` imports the
 * Supabase-backed trip-destination client at load, which needs jest's module
 * mocking; nothing here renders.
 *
 * MUTATION LOG (each applied, watched go red, reverted):
 *   - persistPastedDestinations.ts: report in create mode too (move the call
 *     above the `if (!tripId)` return) → test 2 goes red.
 *   - persistPastedDestinations.ts: credit every saved destination regardless
 *     of entityType → test 1 goes red (a PLACE id credited as a city).
 *   - persistPastedDestinations.ts: report ok:true when some writes failed →
 *     test 3 goes red.
 */
// NOTE: exhaustive-by-design stub — apiToken.ts reaches Supabase at load.
jest.mock('../../../../services/apiToken.ts', () => ({ freshToken: async () => 'tok' }));

import { persistPastedDestinations, PASTE_TRIP_FIELD } from '../persistPastedDestinations.ts';
import type { PasteDestination } from '../pasteReview.ts';

const city = (i: number, id: string): PasteDestination => ({
  itemIndex: i, city: `City ${i}`, country: null, lat: null, lng: null, placeId: id, entityType: 'city',
});
const place = (i: number, id: string): PasteDestination => ({
  itemIndex: i, city: `Place ${i}`, country: null, lat: null, lng: null, placeId: id, entityType: 'place',
});

test('edit mode: a completed write reports trip_destinations_saved and credits the CITIES it wrote', async () => {
  const report = jest.fn().mockReturnValue('reported');
  let n = 0;
  const add = jest.fn(async () => ({ id: `d${++n}` }) as any);
  const out = await persistPastedDestinations('trip-1', [city(0, 'c-hoian'), place(1, 'p-bar'), city(2, 'c-hue')], 1, add, report);
  expect(out.saved).toHaveLength(3);
  expect(report).toHaveBeenCalledTimes(1);
  expect(report).toHaveBeenCalledWith(PASTE_TRIP_FIELD, 'trip_destinations_saved', true, [
    { entityType: 'city', entityId: 'c-hoian' },
    { entityType: 'city', entityId: 'c-hue' },
  ]);
  expect(PASTE_TRIP_FIELD).toEqual({ fieldId: 'trip.destination', context: 'trip_destination' });
});

test('create mode: adding to a DRAFT is not a completed task — nothing is reported', async () => {
  const report = jest.fn();
  const add = jest.fn();
  await persistPastedDestinations(undefined, [city(0, 'c-hoian')], 1, add, report);
  expect(add).not.toHaveBeenCalled();
  expect(report).not.toHaveBeenCalled();
});

test('a partial failure is reported as a FAILED task, crediting only what was written', async () => {
  const report = jest.fn();
  const add = jest.fn()
    .mockResolvedValueOnce({ id: 'd1' })
    .mockRejectedValueOnce(new Error('offline'));
  const out = await persistPastedDestinations('trip-1', [city(0, 'c-hoian'), city(1, 'c-hue')], 1, add, report);
  expect(out.failed).toHaveLength(1);
  expect(report).toHaveBeenCalledWith(PASTE_TRIP_FIELD, 'trip_destinations_saved', false, [
    { entityType: 'city', entityId: 'c-hoian' },
  ]);
});

test('an empty confirm is not a task at all', async () => {
  const report = jest.fn();
  await persistPastedDestinations('trip-1', [], 1, jest.fn(), report);
  expect(report).not.toHaveBeenCalled();
});
