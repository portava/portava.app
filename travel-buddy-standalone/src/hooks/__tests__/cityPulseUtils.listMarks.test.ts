/**
 * census-discovery §117 (DV-83 round 20, lane W11-X2; sweep SW17): fetchCityEvents keeps what GET /events could not
 * read, so the Pulse can say it.
 *
 * GET /events names a going count it could not recount live in `failedSources: ["event_rsvps"]` (the cached count is
 * served) and adds `truncated: true` to an answer that is not whole (§115 B12). fetchCityEvents read only `events`.
 *
 *   CP1  `failedSources: ["event_rsvps"]` → every mapped event is `attendeeCountUnread: true`
 *   CP2  `truncated: true` → the result is `notWhole: true`
 *   CP0  CONTROL: a whole body → the result has exactly `events` and `sessionId`, and no event is marked
 *
 * Run: node --import tsx/esm --test src/hooks/__tests__/cityPulseUtils.listMarks.test.ts
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fetchCityEvents } from '../cityPulseUtils.ts';

const apiEvent = { id: 'ev1', title: 'Rooftop quiz', city: 'Lisbon', startsAt: '2099-08-01T18:00:00Z', goingCount: 7, maxAttendees: 10 };
const answer = (body: unknown) => async () => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

describe('census-discovery §117 (SW17): fetchCityEvents keeps the list marks', () => {
  let originalFetch: typeof globalThis.fetch;
  before(() => { originalFetch = globalThis.fetch; });
  after(() => { globalThis.fetch = originalFetch; });

  test('CP1 a going count not recounted → every event is marked', async () => {
    globalThis.fetch = answer({ events: [apiEvent, { ...apiEvent, id: 'ev2' }], failedSources: ['event_rsvps'] });
    const r = await fetchCityEvents('https://api.example.com', 'tok', 'Lisbon', 'lisbon');
    assert.deepEqual(r.events.map((e: any) => [e.id, e.attendeeCount, e.attendeeCountUnread]), [['ev1', 7, true], ['ev2', 7, true]]);
  });
  test('CP2 an answer that is not whole → notWhole', async () => {
    globalThis.fetch = answer({ events: [], truncated: true, sessionId: 's1' });
    const r = await fetchCityEvents('https://api.example.com', 'tok', 'Lisbon', 'lisbon');
    assert.equal(r.notWhole, true);
    assert.equal(r.sessionId, 's1');
  });
  test('CP0 CONTROL: a whole body → events and sessionId only, nothing marked', async () => {
    globalThis.fetch = answer({ events: [apiEvent], sessionId: 's1' });
    const r = await fetchCityEvents('https://api.example.com', 'tok', 'Lisbon', 'lisbon');
    assert.deepEqual(Object.keys(r).sort(), ['events', 'sessionId']);
    assert.equal('attendeeCountUnread' in r.events[0]!, false);
  });
});
