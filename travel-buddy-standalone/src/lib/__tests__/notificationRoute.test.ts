/**
 * normalizeNotificationRoute — a stored notification URL that names no screen
 * is mapped to the screen that shows that thing; everything else is untouched.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeNotificationRoute } from '../notificationRoute.ts';

describe('normalizeNotificationRoute', () => {
  it('maps the Find Your Circle shape to circle-presence with both params', () => {
    assert.equal(
      normalizeNotificationRoute('/circle/trip/0b6f3c1e-1111-4222-8333-944445555666'),
      '/circle-presence?contextType=trip&contextId=0b6f3c1e-1111-4222-8333-944445555666',
    );
    assert.equal(
      normalizeNotificationRoute('/circle/event/abc'),
      '/circle-presence?contextType=event&contextId=abc',
    );
  });

  it('maps a layover session API path to the layover dashboard', () => {
    assert.equal(normalizeNotificationRoute('/airport/sessions/s-1'), '/layover/s-1');
  });

  it('maps the Compass route-plan path to the route screen', () => {
    assert.equal(normalizeNotificationRoute('/route-plan/p-9'), '/route/p-9');
  });

  it('sends an old mention row with no post to Pulse instead of a missing /feed', () => {
    assert.equal(normalizeNotificationRoute('/feed'), '/(tabs)');
  });

  it('leaves real screens alone', () => {
    for (const u of ['/post/1', '/layover/2', '/circle', '/circle-presence?contextType=trip&contextId=3', '/u/abc', '/follow-requests']) {
      assert.equal(normalizeNotificationRoute(u), u);
    }
  });

  it('answers null for no URL', () => {
    assert.equal(normalizeNotificationRoute(undefined), null);
    assert.equal(normalizeNotificationRoute(null), null);
    assert.equal(normalizeNotificationRoute('  '), null);
  });
});
