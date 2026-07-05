/**
 * acceptResultMapper.test.ts
 *
 * Unit tests for mapAcceptResultToAction() — the pure function that drives
 * the handleAccept branch in app/invite/[token].tsx.
 *
 * Critical regression case: when `result.error === 'gone'` AND
 * `result.reason === 'trip_full'`, the action must be `{ kind: 'reload' }`.
 * Any other action (especially 'alert') would show the confusing
 * "link may have expired" message to users whose trip fills up between
 * preview and accept.
 *
 * Pure function; zero React Native / Supabase dependencies.
 * Runs under node:test.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mapAcceptResultToAction } from '../acceptResultMapper.ts';
import type { AcceptInviteResult } from '../../services/trips.ts';

const PREVIEW_TRIP = 'preview-trip-abc123';

function result(overrides: Partial<AcceptInviteResult> = {}): AcceptInviteResult {
  return { tripId: null, alreadyMember: false, ...overrides };
}

describe('mapAcceptResultToAction() — handleAccept branch coverage', () => {

  // ── Trip-full race condition (the regression we are guarding against) ──────
  it('returns { kind:"reload" } when error=gone and reason=trip_full', () => {
    const action = mapAcceptResultToAction(
      result({ error: 'gone', reason: 'trip_full' }),
      PREVIEW_TRIP,
    );
    assert.equal(
      action.kind,
      'reload',
      'trip_full must trigger a re-fetch (reload), not an alert or set_gone',
    );
  });

  // Confirm it is specifically the reason:'trip_full' combination.
  // error:'gone' alone (no reason) must NOT trigger reload.
  it('returns { kind:"set_gone" } when error=gone with no reason', () => {
    const action = mapAcceptResultToAction(result({ error: 'gone' }), PREVIEW_TRIP);
    assert.equal(action.kind, 'set_gone');
    if (action.kind === 'set_gone') {
      assert.equal(action.message, 'This trip is no longer active.');
    }
  });

  // error:'gone' with a different reason must also not trigger reload.
  it('returns { kind:"set_gone" } when error=gone with reason=revoked', () => {
    const action = mapAcceptResultToAction(
      result({ error: 'gone', reason: 'revoked' }),
      PREVIEW_TRIP,
    );
    assert.equal(action.kind, 'set_gone');
  });

  // ── Successful join ────────────────────────────────────────────────────────
  it('returns navigate to the server-returned tripId on success', () => {
    const action = mapAcceptResultToAction(
      result({ tripId: 'new-trip-xyz' }),
      PREVIEW_TRIP,
    );
    assert.equal(action.kind, 'navigate');
    if (action.kind === 'navigate') {
      assert.equal(action.tripId, 'new-trip-xyz');
    }
  });

  // tripId takes precedence over alreadyMember (defensive; server guarantees
  // mutual exclusivity but we verify the mapping respects field-check order).
  it('prefers tripId over alreadyMember when both are truthy', () => {
    const action = mapAcceptResultToAction(
      result({ tripId: 'server-trip', alreadyMember: true }),
      PREVIEW_TRIP,
    );
    assert.equal(action.kind, 'navigate');
    if (action.kind === 'navigate') {
      assert.equal(action.tripId, 'server-trip');
    }
  });

  // ── Already member ─────────────────────────────────────────────────────────
  it('returns navigate with previewTripId when alreadyMember is true', () => {
    const action = mapAcceptResultToAction(
      result({ alreadyMember: true }),
      PREVIEW_TRIP,
    );
    assert.equal(action.kind, 'navigate');
    if (action.kind === 'navigate') {
      assert.equal(
        action.tripId,
        PREVIEW_TRIP,
        'alreadyMember must navigate using the previewTripId',
      );
    }
  });

  // ── Auth error → alert ─────────────────────────────────────────────────────
  it('returns alert with sign-in message when error=not_authenticated', () => {
    const action = mapAcceptResultToAction(
      result({ error: 'not_authenticated' }),
      PREVIEW_TRIP,
    );
    assert.equal(action.kind, 'alert');
    if (action.kind === 'alert') {
      assert.ok(
        action.message.toLowerCase().includes('sign in'),
        'not_authenticated message must prompt the user to sign in',
      );
    }
  });

  // ── Generic error → alert with "expired" message ───────────────────────────
  it('returns alert with expired-link message for generic error codes', () => {
    const action = mapAcceptResultToAction(result({ error: 'error' }), PREVIEW_TRIP);
    assert.equal(action.kind, 'alert');
    if (action.kind === 'alert') {
      assert.ok(
        action.message.toLowerCase().includes('expired'),
        'generic errors must show the expired-link message',
      );
    }
  });

  it('returns alert with expired-link message when error is undefined', () => {
    const action = mapAcceptResultToAction(result({}), PREVIEW_TRIP);
    assert.equal(action.kind, 'alert');
  });
});
