import { afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { createInputRequestScheduler, type InputRequest } from '../inputRequestScheduler.ts';
import { invalidateDiscoveryCaches, setDiscoveryViewerFromSession } from '../../../../services/discoveryViewerScope.ts';

beforeEach(() => {
  setDiscoveryViewerFromSession('account-a');
  mock.timers.enable({ apis: ['setTimeout'] });
});
afterEach(() => mock.timers.reset());

test('a burst schedules only the final request', () => {
  const scheduler = createInputRequestScheduler();
  const started: string[] = [];
  scheduler.schedule(() => started.push('old'), 300);
  mock.timers.tick(200);
  scheduler.schedule(() => started.push('new'), 300);
  mock.timers.tick(299);
  assert.deepEqual(started, []);
  mock.timers.tick(1);
  assert.deepEqual(started, ['new']);
});

test('rescheduling immediately invalidates and aborts the active request, before the new timer', () => {
  const scheduler = createInputRequestScheduler();
  const requests: InputRequest[] = [];
  scheduler.schedule((request) => requests.push(request), 10);
  mock.timers.tick(10);
  assert.equal(requests[0].isCurrent(), true);
  scheduler.schedule((request) => requests.push(request), 10);
  assert.equal(requests[0].signal.aborted, true);
  assert.equal(requests[0].isCurrent(), false);
  assert.equal(requests.length, 1);
  mock.timers.tick(10);
  assert.equal(requests[1].isCurrent(), true);
  assert.equal(requests[1].signal.aborted, false);
});

test('cancel prevents pending work and invalidates active work even if it ignores abort', () => {
  const scheduler = createInputRequestScheduler();
  const requests: InputRequest[] = [];
  scheduler.schedule((request) => requests.push(request), 10);
  scheduler.cancel();
  mock.timers.tick(10);
  assert.equal(requests.length, 0);
  scheduler.schedule((request) => requests.push(request), 10);
  mock.timers.tick(10);
  scheduler.cancel();
  scheduler.cancel();
  assert.equal(requests[0].signal.aborted, true);
  assert.equal(requests[0].isCurrent(), false);
});

test('independent mounted fields do not cancel one another', () => {
  const first = createInputRequestScheduler();
  const second = createInputRequestScheduler();
  const requests: InputRequest[] = [];
  first.schedule((request) => requests.push(request), 10);
  second.schedule((request) => requests.push(request), 10);
  mock.timers.tick(10);
  first.cancel();
  assert.equal(requests[0].isCurrent(), false);
  assert.equal(requests[1].isCurrent(), true);
  second.cancel();
});

test('an account transition invalidates active work before React cleanup', () => {
  const scheduler = createInputRequestScheduler();
  const requests: InputRequest[] = [];
  scheduler.schedule((request) => requests.push(request), 10);
  mock.timers.tick(10);
  setDiscoveryViewerFromSession(null);
  setDiscoveryViewerFromSession('account-a');
  assert.equal(requests[0].signal.aborted, false);
  assert.equal(requests[0].isCurrent(), false);
  scheduler.cancel();
});

test('queued work cannot start under a different account epoch', () => {
  const scheduler = createInputRequestScheduler();
  const requests: InputRequest[] = [];
  scheduler.schedule((request) => requests.push(request), 10);
  setDiscoveryViewerFromSession('account-b');
  mock.timers.tick(10);
  assert.equal(requests.length, 0);
});

test('a token refresh preserves work but a permission invalidation rejects it', () => {
  const scheduler = createInputRequestScheduler();
  const requests: InputRequest[] = [];
  scheduler.schedule((request) => requests.push(request), 10);
  setDiscoveryViewerFromSession('account-a');
  mock.timers.tick(10);
  assert.equal(requests[0].isCurrent(), true);
  invalidateDiscoveryCaches();
  assert.equal(requests[0].isCurrent(), false);
  scheduler.cancel();
});
