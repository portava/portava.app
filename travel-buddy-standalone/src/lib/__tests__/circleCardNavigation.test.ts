/**
 * Unit tests for the circle_status_card tap-handler navigation resolver.
 *
 * Run with:
 *   node --import tsx/esm --test \
 *     src/lib/__tests__/circleCardNavigation.test.ts
 *
 * ## Why this file exists
 *
 * `onCircleCardPress` in app/messages/[id].tsx now delegates its routing
 * decision to `resolveCircleCardNav` (circleCardNavigation.ts).  That keeps
 * the component thin and lets us test every branch — circle/trip/event thread,
 * member/non-member, no-context — without mounting the full messages screen or
 * mocking expo-router.
 *
 * These tests lock in the fix that routes circle-type threads to /circle
 * instead of silently returning early, and guard the trip/event member path
 * that routes to /circle-presence.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveCircleCardNav } from '../circleCardNavigation.ts';

// ── circle-type thread ────────────────────────────────────────────────────────

describe('resolveCircleCardNav — circle-type thread', () => {
  it('returns push-circle when threadType is "circle"', () => {
    const result = resolveCircleCardNav('circle', null, null, null);
    assert.equal(result.action, 'push-circle');
  });

  it('returns push-circle regardless of contextId', () => {
    const result = resolveCircleCardNav('circle', 'ctx-123', true, 'Tokyo');
    assert.equal(result.action, 'push-circle');
  });

  it('returns push-circle regardless of isCircleMember value', () => {
    const resultFalse = resolveCircleCardNav('circle', 'ctx-1', false, null);
    assert.equal(resultFalse.action, 'push-circle');

    const resultNull = resolveCircleCardNav('circle', null, null, null);
    assert.equal(resultNull.action, 'push-circle');
  });
});

// ── trip thread where viewer IS a member ─────────────────────────────────────

describe('resolveCircleCardNav — trip thread, viewer is a member', () => {
  it('returns push-presence for a trip thread', () => {
    const result = resolveCircleCardNav('trip', 'trip-abc', true, 'Bali');
    assert.equal(result.action, 'push-presence');
  });

  it('passes contextType=trip', () => {
    const result = resolveCircleCardNav('trip', 'trip-abc', true, 'Bali');
    assert.ok(result.action === 'push-presence');
    assert.equal(result.contextType, 'trip');
  });

  it('passes the contextId through', () => {
    const result = resolveCircleCardNav('trip', 'trip-abc', true, 'Bali');
    assert.ok(result.action === 'push-presence');
    assert.equal(result.contextId, 'trip-abc');
  });

  it('passes the contextLabel through', () => {
    const result = resolveCircleCardNav('trip', 'trip-xyz', true, 'Tokyo');
    assert.ok(result.action === 'push-presence');
    assert.equal(result.contextLabel, 'Tokyo');
  });

  it('falls back to "Circle" when contextLabel is null', () => {
    const result = resolveCircleCardNav('trip', 'trip-xyz', true, null);
    assert.ok(result.action === 'push-presence');
    assert.equal(result.contextLabel, 'Circle');
  });

  it('falls back to "Circle" when contextLabel is undefined', () => {
    const result = resolveCircleCardNav('trip', 'trip-xyz', true, undefined);
    assert.ok(result.action === 'push-presence');
    assert.equal(result.contextLabel, 'Circle');
  });
});

// ── event thread where viewer IS a member ────────────────────────────────────

describe('resolveCircleCardNav — event thread, viewer is a member', () => {
  it('returns push-presence for an event thread', () => {
    const result = resolveCircleCardNav('event', 'evt-999', true, 'Festival');
    assert.equal(result.action, 'push-presence');
  });

  it('passes contextType=event', () => {
    const result = resolveCircleCardNav('event', 'evt-999', true, 'Festival');
    assert.ok(result.action === 'push-presence');
    assert.equal(result.contextType, 'event');
  });

  it('passes the contextId and contextLabel through', () => {
    const result = resolveCircleCardNav('event', 'evt-42', true, 'Street Fest');
    assert.ok(result.action === 'push-presence');
    assert.equal(result.contextId, 'evt-42');
    assert.equal(result.contextLabel, 'Street Fest');
  });
});

// ── trip/event thread where viewer is NOT a member (fail-closed) ──────────────

describe('resolveCircleCardNav — trip/event thread, viewer not a member', () => {
  it('returns alert when isCircleMember is false (confirmed non-member)', () => {
    const result = resolveCircleCardNav('trip', 'trip-abc', false, 'Bali');
    assert.equal(result.action, 'alert');
  });

  it('alert title is "Circle members only"', () => {
    const result = resolveCircleCardNav('trip', 'trip-abc', false, 'Bali');
    assert.ok(result.action === 'alert');
    assert.equal(result.title, 'Circle members only');
  });

  it('alert message mentions Circle members', () => {
    const result = resolveCircleCardNav('trip', 'trip-abc', false, 'Bali');
    assert.ok(result.action === 'alert');
    assert.ok(result.message.length > 0);
  });
});

// ── trip/event thread where membership is still loading ───────────────────────

describe('resolveCircleCardNav — trip/event thread, membership still loading', () => {
  it('returns loading (not alert) when isCircleMember is null', () => {
    const result = resolveCircleCardNav('trip', 'trip-abc', null, 'Bali');
    assert.equal(result.action, 'loading');
  });

  it('returns loading (not alert) when isCircleMember is undefined', () => {
    const result = resolveCircleCardNav('event', 'evt-1', undefined, 'Fest');
    assert.equal(result.action, 'loading');
  });

  it('returns loading for an event thread with null membership', () => {
    const result = resolveCircleCardNav('event', 'evt-99', null, 'Jazz Night');
    assert.equal(result.action, 'loading');
  });
});

// ── no-context threads (direct messages, etc.) ───────────────────────────────

describe('resolveCircleCardNav — no Circle context → noop', () => {
  it('returns noop for a direct thread (no ctxType)', () => {
    const result = resolveCircleCardNav('direct', 'some-id', true, 'label');
    assert.equal(result.action, 'noop');
  });

  it('returns noop when threadType is null', () => {
    const result = resolveCircleCardNav(null, 'id', true, 'x');
    assert.equal(result.action, 'noop');
  });

  it('returns noop when threadType is undefined', () => {
    const result = resolveCircleCardNav(undefined, 'id', true, 'x');
    assert.equal(result.action, 'noop');
  });

  it('returns noop for a trip thread with no contextId', () => {
    const result = resolveCircleCardNav('trip', null, true, 'Bali');
    assert.equal(result.action, 'noop');
  });

  it('returns noop for an event thread with an empty contextId', () => {
    const result = resolveCircleCardNav('event', '', true, 'Fest');
    assert.equal(result.action, 'noop');
  });
});
