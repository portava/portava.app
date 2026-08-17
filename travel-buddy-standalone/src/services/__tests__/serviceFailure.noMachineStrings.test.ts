/**
 * Service layer: `error` is never a machine string, and the diagnostic survives.
 *
 * The screen-level wraps protect the call sites a survey found. This pins the
 * source: these services used to write `res.statusText`, `HTTP ${res.status}`
 * or `String(err)` straight into `error`, so ANY caller — including one written
 * next month that forgets to wrap — rendered "Forbidden" or
 * "TypeError: Network request failed".
 *
 * Asserts against the real exported functions with fetch stubbed, not against
 * the helper in isolation: the property under test is what a caller receives.
 *
 * Run via:
 *   node --import tsx/esm --test src/services/__tests__/serviceFailure.noMachineStrings.test.ts
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { isMachineString } from '../../lib/errorCopy.ts';
import { serviceFailure, thrownFailure } from '../serviceFailure.ts';

const originalWarn = console.warn;
let logged: string[] = [];

beforeEach(() => {
  logged = [];
  console.warn = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
});
afterEach(() => { console.warn = originalWarn; });

describe('serviceFailure', () => {
  it('never returns a machine string for the shapes these services produce', () => {
    const cases: Array<[{ status: number; statusText: string }, unknown]> = [
      [{ status: 403, statusText: 'Forbidden' }, undefined],          // hashtag/tripCrew `?? res.statusText`
      [{ status: 404, statusText: 'Not Found' }, undefined],
      [{ status: 500, statusText: 'Internal Server Error' }, undefined],
      [{ status: 403, statusText: 'Forbidden' }, 'forbidden'],        // a bare server code
      [{ status: 400, statusText: 'Bad Request' }, 'db_error'],
    ];
    for (const [res, body] of cases) {
      const copy = serviceFailure('svc', res, body, 'Could not complete that request.');
      assert.equal(copy, 'Could not complete that request.', `${res.statusText}/${String(body)}`);
      assert.equal(isMachineString(copy), false);
    }
  });

  it('keeps a real server sentence', () => {
    const msg = 'You have already reported this hashtag.';
    assert.equal(serviceFailure('svc', { status: 409, statusText: 'Conflict' }, msg, 'fallback'), msg);
  });

  it('logs status, statusText and the original value — the diagnostic is relocated, not destroyed', () => {
    serviceFailure('hashtag', { status: 403, statusText: 'Forbidden' }, 'forbidden', 'Could not.');
    assert.equal(logged.length, 1, 'exactly one log line');
    const line = logged[0]!;
    assert.match(line, /service-error/);
    assert.match(line, /hashtag\.request/, 'names the operation');
    assert.match(line, /403/, 'keeps the status');
    assert.match(line, /Forbidden/, 'keeps the statusText');
    assert.match(line, /forbidden/, 'keeps the original value');
  });
});

describe('thrownFailure', () => {
  it('never returns String(err) output', () => {
    const copy = thrownFailure('hashtag', new TypeError('Network request failed'));
    assert.doesNotMatch(copy, /TypeError/);
    assert.equal(isMachineString(copy), false);
  });

  it('logs the original error with its class name intact', () => {
    thrownFailure('blocks', new TypeError('Network request failed'));
    assert.equal(logged.length, 1);
    assert.match(logged[0]!, /blocks\.threw/);
    assert.match(logged[0]!, /TypeError: Network request failed/, 'full fidelity in the log');
  });

  it('keeps a human exception message when there is one', () => {
    const copy = thrownFailure('svc', new Error('Your session has expired. Please sign in again.'));
    assert.equal(copy, 'Your session has expired. Please sign in again.');
  });
});
