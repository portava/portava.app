/**
 * census-discovery §111 (DV-83 round 14, lane W11-X2, D-W11X2-115): a forecast layer the server did not name
 * as read is reported, never drawn as "nothing forecast".
 *
 * GET /map/projection/temporal now names `events` only over an events read that succeeded and withheld nothing
 * unchecked, and sends `forecast.events: null` over a failed one. `forecastLayersUnread` is how the client
 * learns it: a forecast answer (the report is present) without `events` in `sources`.
 *
 *   FU1  a forecast whose `sources` lacks `events` → ['events']
 *   FU2  a forecast with `events: null` → ['events'] even if a stale server named it
 *   FU3  the wiring: the hook keeps what the helper says, and the map screen hands it to the Time Machine
 *   FUc  CONTROL: a forecast naming `events`, a history answer, and the disabled envelope → []
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { forecastLayersUnread } from '../forecastUnread.ts';

const report = (events: number | null) => ({ events, itinerary: 0, plan: { published: 0, withheld: 0, refusal: null, refusals: {} } });

describe('forecastLayersUnread (§111, D-W11X2-115)', () => {
  it('FU1 a forecast whose sources lack events → the events layer is unread', () => {
    assert.deepEqual(forecastLayersUnread({ sources: ['itinerary', 'accepted_plan'], forecast: report(0) }), ['events']);
  });
  it('FU2 a forecast with events: null → unread, whatever sources say', () => {
    assert.deepEqual(forecastLayersUnread({ sources: ['events'], forecast: report(null) }), ['events']);
  });
  it('FUc CONTROL: a forecast naming events, a history answer, and the disabled envelope → nothing unread', () => {
    assert.deepEqual(forecastLayersUnread({ sources: ['events', 'itinerary'], forecast: report(0) }), []);
    assert.deepEqual(forecastLayersUnread({ sources: [], forecast: null }), []);
    assert.deepEqual(forecastLayersUnread({ sources: [], forecast: null }), []);
  });
  it('FU3 the wiring: the hook keeps forecastLayersUnread(res.data), and the map screen passes it to the Time Machine as its notice', () => {
    const hook = readFileSync(new URL('../../../../hooks/useTemporalEntities.ts', import.meta.url), 'utf8');
    assert.ok(hook.includes('setUnreadForecastLayers(forecastLayersUnread(res.data));'), 'the hook records the unread layers of each answer');
    assert.ok(hook.includes('return { objects, enabled, forecast, history, loading, unreadForecastLayers };'), 'and returns them');
    const screen = readFileSync(new URL('../../../../../app/map/index.tsx', import.meta.url), 'utf8');
    assert.match(screen, /unreadNotice=\{temporal\.unreadForecastLayers\.includes\('events'\) \? "[^"]+" : null\}/, 'the map screen says an unread events layer');
  });
});
