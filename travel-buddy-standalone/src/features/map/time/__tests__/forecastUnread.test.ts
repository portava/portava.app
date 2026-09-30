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
import { forecastLayersUnread, historyUnread, temporalNotice } from '../forecastUnread.ts';

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
    assert.match(screen, /unreadNotice=\{temporalNotice\(temporal\)\}/, 'the map screen says an unread events layer (§112: after a failed read; §113: through temporalNotice)'); assert.equal(temporalNotice({ failed: false, loading: false, unreadForecastLayers: ['events'] }), "Events couldn't be checked for this forecast");
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
    assert.ok(hook.includes('setFailed(res.data.refusal != null || historyUnread(res.data));'), 'a refused answer, or a past answer that read no history (§113), is a failed read');
    assert.ok(hook.includes('return { objects, enabled, forecast, history, loading, unreadForecastLayers, failed };'), 'and the hook returns it');
    const screen = readFileSync(join(HERE, '../../../../../app/map/index.tsx'), 'utf8');
    assert.match(screen, /unreadNotice=\{temporalNotice\(temporal\)\}/, 'the map screen says a failed read'); assert.equal(temporalNotice({ failed: true, loading: false, unreadForecastLayers: ['events'] }), "Couldn't load the map for this time");
  });
});

describe('historyUnread and temporalNotice (§113, D-W11X2-130)', () => {
  const past = { at: '2026-09-30T09:00:00.000Z', mode: 'historical' as const };
  it('FU7 a past answer with available:false, or with no history report, read no history', () => {
    assert.equal(historyUnread({ history: { available: false, covering: 0 }, target: past }), true);
    assert.equal(historyUnread({ history: null, target: past }), true);
  });
  it('FU7c CONTROL: an empty-but-read past, a forecast target and the flag-off envelope are not unread history', () => {
    assert.equal(historyUnread({ history: { available: true, covering: 0 }, target: past }), false);
    assert.equal(historyUnread({ history: null, target: target('forecast') }), false);
    assert.equal(historyUnread({ history: null, target: null }), false);
  });
  it('FU8 the notice: a failed read first, then a read in flight, then an unread forecast layer, else none', () => {
    assert.equal(temporalNotice({ failed: true, loading: true, unreadForecastLayers: ['events'] }), "Couldn't load the map for this time");
    assert.equal(temporalNotice({ failed: false, loading: true, unreadForecastLayers: [] }), 'Loading the map for this time…');
    assert.equal(temporalNotice({ failed: false, loading: false, unreadForecastLayers: ['events'] }), "Events couldn't be checked for this forecast");
    assert.equal(temporalNotice({ failed: false, loading: false, unreadForecastLayers: [] }), null);
  });
});
