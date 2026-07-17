import { test } from 'node:test';
import assert from 'node:assert/strict';
import { disputeErrorMessage } from './disputeErrorMessage.ts';

test('no_show_in_progress gets the dedicated no-show message', () => {
  assert.equal(
    disputeErrorMessage('no_show_in_progress'),
    'A no-show report is already open — it will escalate to a dispute automatically.',
  );
});

test('other 409 codes keep their own messages', () => {
  assert.equal(disputeErrorMessage('already_disputed'), 'This booking is already under dispute.');
  assert.equal(
    disputeErrorMessage('invalid_transition'),
    "This booking can't be disputed in its current state.",
  );
  assert.equal(
    disputeErrorMessage('dispute_window_expired'),
    'The dispute window has closed. The booking has been automatically completed.',
  );
});

test('unknown / missing codes fall back to the generic message', () => {
  assert.equal(disputeErrorMessage('HTTP 500'), 'Could not open a dispute. Please try again.');
  assert.equal(disputeErrorMessage(undefined), 'Could not open a dispute. Please try again.');
  assert.equal(disputeErrorMessage(null), 'Could not open a dispute. Please try again.');
  assert.equal(disputeErrorMessage(''), 'Could not open a dispute. Please try again.');
});
