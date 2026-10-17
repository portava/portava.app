/**
 * The server's structured-value parser and the app's event-form application,
 * end to end: what `parseStructuredValues` serves is exactly what the create
 * screen's `readStructuredValue` + `eventFormPatch` apply.
 *
 * Lives on the API side (moved from the app's structuredValues.test.ts) because
 * the app's CI job installs only the app workspace: an app test importing
 * server source cannot resolve the server's own dependencies there. Importing
 * the app's pure, type-only module from here is the established direction
 * (see clientLetterFoldParity.test.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStructuredValues } from '../lib/inputAssistance/structuredValues.js';
import { readStructuredValue, eventFormPatch } from '../../../../travel-buddy-standalone/src/platform/input-assistance/creation/structuredValues.ts';

const EMPTY = { startDateStr: '', startTime: '', endDateStr: '', endTime: '' };

for (const title of ['Club night 10pm-2am', 'Club night 10pm for 4 hours']) {
  for (const [startDateStr, endDateStr] of [
    ['2026-10-09', '2026-10-10'], ['2026-12-31', '2027-01-01'],
    ['2028-02-28', '2028-02-29'], ['2028-02-29', '2028-03-01'],
    ['2026-03-08', '2026-03-09'], ['2026-11-01', '2026-11-02'],
  ]) {
    test(`server-derived ${title} applies the next calendar day from ${startDateStr}`, () => {
      const values = parseStructuredValues(title);
      assert.deepEqual(values, [{ kind: 'event_time', date: null, startTime: '22:00', endDate: null, endTime: '02:00' }]);
      const value = readStructuredValue(values[0]);
      assert.ok(value);
      const form = { ...EMPTY, startDateStr };
      assert.deepEqual(eventFormPatch(value, form), { startTime: '22:00', endTime: '02:00', endDateStr });
      assert.deepEqual(form, { ...EMPTY, startDateStr });
    });
  }
}

test('equal clocks do not acquire an inferred 24-hour date policy', () => {
  assert.deepEqual(parseStructuredValues('Club night 10pm-10pm'), []);
  const value = readStructuredValue(parseStructuredValues('Club night 10pm for 24 hours')[0]);
  assert.ok(value);
  assert.deepEqual(eventFormPatch(value, { ...EMPTY, startDateStr: '2030-06-07' }),
    { startTime: '22:00', endTime: '22:00', endDateStr: '2030-06-07' });
});
