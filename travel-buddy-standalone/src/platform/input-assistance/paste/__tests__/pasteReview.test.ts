/**
 * §24 Paste Intelligence — the review model (GII-F08). Pure; node:test.
 *
 * Proves what the review screen may and may not do with the extract answer:
 *   - an answer that is not the contract (including one that does not say
 *     `mutated: false`) is REFUSED, so the screen shows a failure, never an
 *     empty review;
 *   - only COMPLETE resolved answers are pre-ticked — a partial answer (a
 *     source could not be read) waits for the person;
 *   - a country row cannot become a city destination;
 *   - every non-resolved status says which one it is.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  acceptedDestinations,
  destinationFromCandidate,
  initialSelection,
  itemStatusCopy,
  parsePasteExtraction,
  reviewSummary,
  toggleSelection,
} from '../pasteReview.ts';

const city = (id: string, name: string, country: string) => ({
  id, label: name, subtitle: country, type: 'entity', context: 'trip_destination', entityType: 'city', entityId: id,
  structuredValue: { entityType: 'city', cityId: id, city: name, country, lat: 16, lng: 108 }, source: 'canonical', policyVersion: 'v',
});
const country = { id: 'country:vn', label: 'Vietnam', type: 'entity', context: 'trip_destination', entityType: 'country', entityId: 'country:vn', source: 'canonical', policyVersion: 'v' };
const item = (index: number, status: string, over: Record<string, unknown> = {}) => ({
  index, raw: `line ${index}`, source: 'text', query: `line ${index}`, lat: null, lng: null, timeHint: null, dayLabel: null,
  status, reason: null, partial: false, candidates: [], ...over,
});
const answer = (items: unknown[], over: Record<string, unknown> = {}) => ({ requestId: 'r', shape: 'list', truncated: false, mutated: false, items, ...over });

test('an answer that is not the contract is refused (shown as a failure, never an empty review)', () => {
  assert.equal(parsePasteExtraction(null), null);
  assert.equal(parsePasteExtraction({ items: [] }), null);
  assert.equal(parsePasteExtraction(answer([], { mutated: true })), null, 'an endpoint that says it mutated is not the review contract');
  assert.equal(parsePasteExtraction(answer([], { mutated: undefined })), null);
  assert.equal(parsePasteExtraction(answer([item(0, 'maybe')])), null, 'an unknown status is not guessed at');
  const ok = parsePasteExtraction(answer([item(0, 'resolved', { candidates: [city('c1', 'Hoi An', 'Vietnam')] })]));
  assert.ok(ok);
  assert.equal(ok.items[0]!.candidates.length, 1);
});

test('only COMPLETE resolved answers are pre-ticked', () => {
  const parsed = parsePasteExtraction(answer([
    item(0, 'resolved', { candidates: [city('c1', 'Hoi An', 'Vietnam')] }),
    item(1, 'resolved', { partial: true, candidates: [country, city('c2', 'Hue', 'Vietnam')] }),
    item(2, 'no_match'),
    item(3, 'failed', { reason: 'The place lookup didn’t answer.' }),
    item(4, 'unsupported', { reason: 'Shortened map links can’t be read.' }),
  ]))!;
  const sel = initialSelection(parsed.items);
  assert.deepEqual(sel, { 0: 0 });
  assert.deepEqual(acceptedDestinations(parsed.items, sel).map((d) => d.city), ['Hoi An']);
  const withHue = toggleSelection(sel, 1, 1);
  assert.deepEqual(acceptedDestinations(parsed.items, withHue).map((d) => [d.itemIndex, d.city]), [[0, 'Hoi An'], [1, 'Hue']]);
  assert.deepEqual(toggleSelection(withHue, 0, 0), { 1: 1 }, 'tapping a ticked candidate unticks it');
  assert.deepEqual(reviewSummary(parsed.items), { resolved: 2, noMatch: 1, failed: 1, unsupported: 1, partial: 1 });
});

test('a country row cannot become a city destination; a city row carries its canonical binding', () => {
  assert.equal(destinationFromCandidate(country as any), null);
  assert.deepEqual(destinationFromCandidate(city('c1', 'Hoi An', 'Vietnam') as any, 3), {
    itemIndex: 3, city: 'Hoi An', country: 'Vietnam', lat: 16, lng: 108, placeId: 'c1',
  });
});

test('every status that is not a clean match says which one it is', () => {
  const parsed = parsePasteExtraction(answer([
    item(0, 'no_match', { query: 'Atlantis' }),
    item(1, 'failed'),
    item(2, 'unsupported'),
    item(3, 'resolved', { partial: true }),
    item(4, 'resolved'),
  ]))!;
  const copy = parsed.items.map(itemStatusCopy);
  assert.match(copy[0]!, /No place matched “Atlantis”/);
  assert.match(copy[1]!, /couldn’t check/);
  assert.match(copy[2]!, /can’t be read/);
  assert.match(copy[3]!, /couldn’t be checked/);
  assert.equal(copy[4], null);
  assert.notEqual(copy[0], copy[1], 'no match and failed are never the same sentence');
});
