import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyDriftLoadResult,
  driftCount,
  type SchemaDriftReport,
} from '../schemaDrift.machine.ts';

const okReport = {
  status: 'ok',
  missingColumns: [],
  missingFunctions: [],
  checkedAt: '2026-07-16T10:00:00.000Z',
  cached: true,
};

test('applyDriftLoadResult: failed fetch surfaces error', () => {
  const r = applyDriftLoadResult({ ok: false, error: 'HTTP 500' });
  assert.equal(r.report, null);
  assert.equal(r.error, 'HTTP 500');
});

test('applyDriftLoadResult: failed fetch without message gets fallback', () => {
  const r = applyDriftLoadResult({ ok: false });
  assert.equal(r.report, null);
  assert.equal(r.error, 'Failed to load schema status');
});

test('applyDriftLoadResult: ok report parses', () => {
  const r = applyDriftLoadResult({ ok: true, data: okReport });
  assert.equal(r.error, null);
  assert.equal(r.report?.status, 'ok');
  assert.equal(r.report?.cached, true);
  assert.equal(r.report?.checkedAt, okReport.checkedAt);
});

test('applyDriftLoadResult: drift report keeps columns and functions', () => {
  const data = {
    status: 'drift',
    missingColumns: [
      { table: 'profiles', column: 'x', migration: '0120.sql', impact: 'saves fail' },
    ],
    missingFunctions: [
      { fn: 'toggle_fn', migration: '0119.sql', impact: 'toggles 503' },
    ],
    checkedAt: '2026-07-16T10:00:00.000Z',
    cached: false,
  };
  const r = applyDriftLoadResult({ ok: true, data });
  assert.equal(r.report?.status, 'drift');
  assert.equal(r.report?.missingColumns.length, 1);
  assert.equal(r.report?.missingFunctions.length, 1);
  assert.equal(r.report?.cached, false);
});

test('applyDriftLoadResult: malformed payload is an error, not a bogus OK', () => {
  for (const data of [undefined, {}, { status: 'weird' }, { status: 'ok', missingColumns: 'nope' }]) {
    const r = applyDriftLoadResult({ ok: true, data });
    assert.equal(r.report, null);
    assert.equal(r.error, 'Unexpected response from server');
  }
});

test('driftCount sums columns and functions', () => {
  const report: SchemaDriftReport = {
    status: 'drift',
    missingColumns: [
      { table: 'a', column: 'b', migration: 'm', impact: 'i' },
      { table: 'c', column: 'd', migration: 'm', impact: 'i' },
    ],
    missingFunctions: [{ fn: 'f', migration: 'm', impact: 'i' }],
    checkedAt: '',
    cached: false,
  };
  assert.equal(driftCount(report), 3);
  assert.equal(driftCount({ ...report, missingColumns: [], missingFunctions: [] }), 0);
});
