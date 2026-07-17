/**
 * Legacy long display names must not bloat server-composed notification text.
 *
 * Onboarding caps display names at 40 chars, but legacy accounts may still
 * have longer names in the DB. renderTemplate must cap name-bearing params
 * (actor, travelerName) with the same 40-char + ellipsis rule as the mobile
 * client (truncateDisplayName in travel-buddy/src/utils/identity.ts).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { renderTemplate } from '../services/notifications/NotificationTemplateService';
import { truncateDisplayName, DISPLAY_NAME_MAX_LENGTH, circleThreadTitle } from '../lib/displayName';

const LONG_NAME = 'Bartholomew Maximilian Constantine von Hohenzollern-Sigmaringen III';
const CAPPED = truncateDisplayName(LONG_NAME);

describe('truncateDisplayName', () => {
  it('leaves names at or under the limit untouched', () => {
    const name = 'A'.repeat(DISPLAY_NAME_MAX_LENGTH);
    assert.equal(truncateDisplayName(name), name);
    assert.equal(truncateDisplayName('Maria Santos'), 'Maria Santos');
  });

  it('caps longer names at 40 chars plus a single ellipsis', () => {
    assert.ok(CAPPED.endsWith('…'));
    assert.ok(CAPPED.length <= DISPLAY_NAME_MAX_LENGTH + 1);
    assert.ok(CAPPED.startsWith(LONG_NAME.slice(0, 30)));
  });
});

describe('circleThreadTitle', () => {
  it('leaves short names untouched in the thread title', () => {
    assert.equal(circleThreadTitle('Maria Santos'), "Maria Santos's Circle");
  });

  it('caps legacy >40-char names in the thread title', () => {
    assert.equal(circleThreadTitle(LONG_NAME), `${CAPPED}'s Circle`);
    assert.ok(circleThreadTitle(LONG_NAME).length <= DISPLAY_NAME_MAX_LENGTH + 1 + "'s Circle".length);
  });
});

describe('renderTemplate name capping', () => {
  it('caps a legacy long actor name in title and body', () => {
    const r = renderTemplate('trip_crew.friend_request', { actor: LONG_NAME });
    assert.ok(r);
    assert.equal(r!.title, `${CAPPED} sent a friend request`);
    assert.equal(r!.body, `${CAPPED} wants to connect`);
    assert.ok(!r!.title.includes(LONG_NAME));
  });

  it('caps travelerName params too', () => {
    const r = renderTemplate('safe_return.trusted_circle_alert', { travelerName: LONG_NAME });
    assert.ok(r);
    assert.ok(!`${r!.title} ${r!.body}`.includes(LONG_NAME));
    assert.ok(`${r!.title} ${r!.body}`.includes(CAPPED));
  });

  it('leaves short actor names unchanged', () => {
    const r = renderTemplate('trip_crew.friend_request', { actor: 'Maria Santos' });
    assert.equal(r!.title, 'Maria Santos sent a friend request');
  });
});
