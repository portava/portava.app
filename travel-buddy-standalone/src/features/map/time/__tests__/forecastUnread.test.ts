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
 *
 * census-discovery §112 (DV-83 round 15, D-W11X2-121, D-W11X2-122; D-W11X2-115's client leg corrected):
 *   FU4  a forecast target answered with no forecast report (the server's failed blocks read) → ['events']
 *   FU5  a refused forecast target (a refusal is named) → ['events'], whatever the report says
 *   FU6  the wiring: the hook keeps a failed state and the map screen says it before the unread layer
 *   FU4c CONTROL: a historical target with no forecast, and the flag-off envelope (no target) → []
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { forecastLayersUnread } from '../forecastUnread.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
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
    const hook = readFileSync(join(HERE, '../../../../hooks/useTemporalEntities.ts'), 'utf8');
    assert.ok(hook.includes('setUnreadForecastLayers(forecastLayersUnread(res.data));'), 'the hook records the unread layers of each answer');
    assert.ok(hook.includes('return { objects, enabled, forecast, history, loading, unreadForecastLayers'), 'and returns them');
    const screen = readFileSync(join(HERE, '../../../../../app/map/index.tsx'), 'utf8');
    assert.match(screen, /unreadNotice=\{temporal\.failed \? "[^"]+" : temporal\.unreadForecastLayers\.includes\('events'\) \? "[^"]+" : null\}/, 'the map screen says an unread events layer (§112: after a failed read)');
  });
});

const target = (mode: 'forecast' | 'historical') => ({ at: '2026-10-01T20:00:00.000Z', mode });

describe('forecastLayersUnread over a refused or report-less forecast (§112, D-W11X2-121)', () => {
  it('FU4 a forecast target answered with no forecast report → the events layer is unread', () => {
    assert.deepEqual(forecastLayersUnread({ sources: [], forecast: null, target: target('forecast') }), ['events']);
  });
  it('FU5 a refused forecast target → unread, whatever the report and sources say', () => {
    assert.deepEqual(forecastLayersUnread({ sources: ['events'], forecast: report(0), target: target('forecast'), refusal: 'block_set_unreadable' }), ['events']);
    assert.deepEqual(forecastLayersUnread({ sources: [], forecast: null, target: target('forecast'), refusal: 'protection_unreadable' }), ['events']);
  });
  it('FU4c CONTROL: a historical target with no forecast, a healthy forecast target, and the flag-off envelope → nothing unread', () => {
    assert.deepEqual(forecastLayersUnread({ sources: ['history'], forecast: null, target: target('historical') }), []);
    assert.deepEqual(forecastLayersUnread({ sources: ['events', 'itinerary'], forecast: report(0), target: target('forecast'), refusal: null }), []);
    assert.deepEqual(forecastLayersUnread({ sources: [], forecast: null, target: null }), []);
  });
  it('FU6 the wiring: the hook records a failed or refused read, and the map screen says it first', () => {
    const hook = readFileSync(join(HERE, '../../../../hooks/useTemporalEntities.ts'), 'utf8');
    assert.ok(hook.includes('setFailed(res.data.refusal != null);'), 'a refused answer is a failed read');
    assert.ok(hook.includes('return { objects, enabled, forecast, history, loading, unreadForecastLayers, failed };'), 'and the hook returns it');
    const screen = readFileSync(join(HERE, '../../../../../app/map/index.tsx'), 'utf8');
    assert.match(screen, /unreadNotice=\{temporal\.failed \? "Couldn't load the map for this time" :/, 'the map screen says a failed read');
  });
});
