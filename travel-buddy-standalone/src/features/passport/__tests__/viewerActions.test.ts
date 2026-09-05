/**
 * viewerActions — the F7 / §30 capability gate is fail-closed and verbatim.
 *
 *   • No projection (anonymous / loading / failed) ⇒ nothing is offered.
 *   • The owner never gets viewer actions on their own passport.
 *   • Each flag is rendered exactly as the server sent it — no inference from
 *     any other field, and a missing flag is a denied flag.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { NO_VIEWER_ACTIONS, resolveViewerActions } from '../viewerActions.ts';
import type { PassportViewerActions } from '../../../services/passportProjection.ts';

const ALL_TRUE: PassportViewerActions = {
  can_follow: true,
  can_message: true,
  can_make_plan: true,
  can_invite_trip: true,
  can_view_availability: true,
  can_view_trust: true,
};

test('no projection ⇒ nothing is offered (fail-closed)', () => {
  assert.deepEqual(resolveViewerActions(null, { isOwner: false }), NO_VIEWER_ACTIONS);
  assert.deepEqual(resolveViewerActions(undefined, { isOwner: false }), NO_VIEWER_ACTIONS);
});

test('the owner never sees viewer actions, whatever the server flags say', () => {
  assert.deepEqual(resolveViewerActions({ actions: ALL_TRUE }, { isOwner: true }), NO_VIEWER_ACTIONS);
});

test('flags are rendered verbatim, independently of each other', () => {
  const r = resolveViewerActions(
    { actions: { ...ALL_TRUE, can_follow: false, can_invite_trip: false } },
    { isOwner: false },
  );
  assert.equal(r.canFollow, false);
  assert.equal(r.canMessage, true);
  assert.equal(r.canInviteTrip, false);
  assert.equal(r.canMakePlan, true);
  assert.equal(r.canViewTrust, true);
  assert.equal(r.canViewAvailability, true);
});

test('a missing or non-boolean flag is denied — never coerced to allowed', () => {
  const partial = { actions: { can_message: 'yes' } as unknown as PassportViewerActions };
  const r = resolveViewerActions(partial, { isOwner: false });
  assert.deepEqual(r, NO_VIEWER_ACTIONS);
});

test('NO_VIEWER_ACTIONS is frozen so no caller can widen the gate by mutation', () => {
  assert.equal(Object.isFrozen(NO_VIEWER_ACTIONS), true);
});
