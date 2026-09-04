/**
 * temporalQueryParams — Map spec §15: the control's WIRE encoding for GET
 * /api/map/projection/temporal.
 *
 * The client owns the timezone and the DST-safe calendar, so a NAMED offset must
 * be resolved HERE into an explicit window and NEVER re-derived on the server;
 * a relative offset (and NOW) needs no calendar and goes as `offsetMinutes`.
 * These tests pin that split — it is the boundary that keeps the two ends of the
 * wire from disagreeing about what "Last Friday" means.
 *
 * Run: node --import tsx/esm --test src/features/map/time/__tests__/temporalQuery.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { temporalQueryParams, type TimeOffset } from '../timeMachine.ts';

const NOW = new Date('2026-09-04T12:00:00.000Z'); // a Friday
const UTC = 'UTC';

describe('temporalQueryParams', () => {
  it('sends NOW and relative offsets as offsetMinutes (no calendar)', () => {
    assert.deepEqual(temporalQueryParams({ kind: 'now' }, NOW, UTC), { offsetMinutes: '0' });
    assert.deepEqual(temporalQueryParams({ kind: 'relative', minutes: 60 }, NOW, UTC), {
      offsetMinutes: '60',
    });
    assert.deepEqual(temporalQueryParams({ kind: 'relative', minutes: -120 }, NOW, UTC), {
      offsetMinutes: '-120',
    });
  });

  it('resolves a NAMED offset on the client into an explicit window + at', () => {
    const yesterday: TimeOffset = { kind: 'named', name: 'yesterday' };
    const params = temporalQueryParams(yesterday, NOW, UTC);
    // The server must not re-derive "yesterday" — the resolved instants are sent
    // outright, and there is no offsetMinutes to tempt it into a second answer.
    assert.ok(params.windowStartsAt, 'windowStartsAt present');
    assert.ok(params.windowEndsAt, 'windowEndsAt present');
    assert.ok(params.at, 'at present');
    assert.equal(params.offsetMinutes, undefined);
    assert.ok(Date.parse(params.at) < NOW.getTime(), 'yesterday is in the past');
  });

  it('sends a window for every named later-control', () => {
    for (const name of ['yesterday', 'tonight', 'tomorrow', 'last_friday'] as const) {
      const params = temporalQueryParams({ kind: 'named', name }, NOW, UTC);
      assert.ok(params.windowStartsAt && params.windowEndsAt && params.at, `${name} carries a window`);
      assert.ok(Date.parse(params.windowStartsAt) < Date.parse(params.windowEndsAt), `${name} window is ordered`);
    }
  });
});
