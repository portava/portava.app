/**
 * census G46 — the client half: reading `structured_value` rows defensively and
 * turning a TAPPED one into a patch for the event form's own fields.
 *
 * Pure logic — runs under node:test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mapStructuredValues, readStructuredValue, eventFormPatch } from '../structuredValues.ts';
import type { InputSuggestion } from '../../types/inputSuggestion.ts';

function row(value: unknown, over: Partial<InputSuggestion> = {}): InputSuggestion {
  return {
    id: `event_title:structured_value:${JSON.stringify(value)}`,
    type: 'structured_value',
    context: 'event_title',
    label: 'Fri 9 Oct · 8:00 PM – 11:00 PM',
    subtitle: 'Set as the date and time',
    action: { type: 'set_structured_value', value },
    structuredValue: value,
    source: 'local',
    policyVersion: 'input-2026-08',
    ...over,
  } as InputSuggestion;
}

const TIME = { kind: 'event_time', date: '2026-10-09', startTime: '20:00', endDate: '2026-10-09', endTime: '23:00' };
const EMPTY = { startDateStr: '', startTime: '', endDateStr: '', endTime: '' };

test('a served structured value becomes a chip carrying the exact value', () => {
  const chips = mapStructuredValues([row(TIME), row({ kind: 'party_size', count: 6 }, { label: '6 people', subtitle: 'Set as the capacity' })]);
  assert.equal(chips.length, 2);
  assert.deepEqual(chips[0]!.value, TIME);
  assert.deepEqual(chips[1]!.value, { kind: 'party_size', count: 6 });
});

test('only structured_value rows with a set_structured_value action are chips', () => {
  // MUTATION: drop the type check → the entity row below becomes a chip → RED.
  const chips = mapStructuredValues([
    row(TIME, { type: 'entity' }),
    row(TIME, { action: { type: 'replace_text', text: 'x' } as any }),
    row(TIME, { label: '  ' }),
  ]);
  assert.equal(chips.length, 0);
});

test('a malformed value is dropped whole, never half-applied', () => {
  // MUTATION: accept any string as a time → "25:00" survives → RED.
  assert.equal(readStructuredValue({ ...TIME, startTime: '25:00' }), null);
  assert.equal(readStructuredValue({ ...TIME, date: '9 Oct' }), null);
  assert.equal(readStructuredValue({ kind: 'event_time', date: null, startTime: null, endDate: null, endTime: null }), null);
  assert.equal(readStructuredValue({ kind: 'party_size', count: 0 }), null);
  assert.equal(readStructuredValue({ kind: 'party_size', count: 2.5 }), null);
  assert.equal(readStructuredValue({ kind: 'duration', minutes: 100000 }), null);
  assert.equal(readStructuredValue({ kind: 'price', amount: 3 }), null);
  assert.equal(readStructuredValue('Fri 8pm'), null);
});

test('tapping an event time sets start and end; a time-only value keeps the date the form has', () => {
  assert.deepEqual(eventFormPatch(TIME as any, EMPTY), { startDateStr: '2026-10-09', startTime: '20:00', endTime: '23:00', endDateStr: '2026-10-09' });
  assert.deepEqual(
    eventFormPatch({ kind: 'event_time', date: null, startTime: '18:30', endDate: null, endTime: null }, { ...EMPTY, startDateStr: '2026-10-20' }),
    { startTime: '18:30' },
  );
});

test('a party size sets the capacity only', () => {
  assert.deepEqual(eventFormPatch({ kind: 'party_size', count: 6 }, EMPTY), { maxAttendees: '6' });
});

test('a length needs a start: none → no patch (not offered); with one → end = start + length, across midnight', () => {
  // MUTATION: compute from 00:00 when no start → a patch appears → RED.
  assert.equal(eventFormPatch({ kind: 'duration', minutes: 120 }, EMPTY), null);
  assert.equal(eventFormPatch({ kind: 'duration', minutes: 120 }, { ...EMPTY, startDateStr: '2026-10-09' }), null, 'a date without a time is not a start');
  assert.deepEqual(
    eventFormPatch({ kind: 'duration', minutes: 150 }, { ...EMPTY, startDateStr: '2026-10-09', startTime: '22:30' }),
    { endDateStr: '2026-10-10', endTime: '01:00' },
  );
});
