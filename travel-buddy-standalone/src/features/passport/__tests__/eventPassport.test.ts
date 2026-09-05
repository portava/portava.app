/**
 * eventPassport — the client's LOCAL staleness read for a temporary event
 * Passport (spec §31 "Never render stale … as current").
 *
 * The property under test is one-directional: the client's clock may withhold a
 * share it believes has lapsed, but it can never grant one. The server re-checks
 * expiry, revocation, the event's end and co-attendance on every resolve, so
 * these helpers exist only to stop the UI showing "sharing" for something the
 * client already knows is over.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isShareLive,
  shareRemainingLabel,
  eventPassportDeepLink,
} from '../eventPassportShareUtils.ts';

const NOW = Date.parse('2026-09-05T20:00:00.000Z');
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

test('a share with no expiry instant is never live (fail-closed)', () => {
  assert.equal(isShareLive(null, NOW), false);
  assert.equal(isShareLive({ expiresAt: '' }, NOW), false);
  assert.equal(isShareLive({ expiresAt: 'not-a-date' }, NOW), false);
});

test('live strictly before the instant, dead at and after it', () => {
  assert.equal(isShareLive({ expiresAt: iso(1) }, NOW), true);
  assert.equal(isShareLive({ expiresAt: iso(0) }, NOW), false, 'the instant itself is expired');
  assert.equal(isShareLive({ expiresAt: iso(-1) }, NOW), false);
});

test('the remaining label disappears the moment the share lapses', () => {
  assert.equal(shareRemainingLabel({ expiresAt: iso(42 * 60_000) }, NOW), '42m left');
  assert.equal(shareRemainingLabel({ expiresAt: iso(60 * 60_000) }, NOW), '1h left');
  assert.equal(shareRemainingLabel({ expiresAt: iso((3 * 60 + 10) * 60_000) }, NOW), '3h 10m left');
  assert.equal(shareRemainingLabel({ expiresAt: iso(-1) }, NOW), null);
  assert.equal(shareRemainingLabel(null, NOW), null);
});

test('the deep link carries the opaque token and nothing about anyone', () => {
  const token = 'a'.repeat(48);
  const link = eventPassportDeepLink(token);
  assert.equal(link, `travelbuddy://passport/event/${token}`);
  // No handle, user id, event id or name is encoded into the link itself: the
  // scan is resolved server-side under normal privacy policy (§25).
  assert.ok(!link.includes('@'));
  assert.equal(link.split('/').filter(Boolean).length, 4);
});

test('a token needing escaping is encoded, not interpolated raw', () => {
  assert.equal(eventPassportDeepLink('a/b?c'), 'travelbuddy://passport/event/a%2Fb%3Fc');
});
