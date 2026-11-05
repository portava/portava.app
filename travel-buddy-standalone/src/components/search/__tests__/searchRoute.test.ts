/**
 * Search result → screen. Every route resolveRoute returns must be a screen
 * the app has: the server sends /trip/:id/plan for plans and /language/:x,
 * /interest/:x, /vibe/:x for its static lists, and none of those exist, so
 * tapping such a result opened "This screen doesn't exist".
 *
 * Run: node --import tsx --test src/components/search/__tests__/searchRoute.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRoute, taxonomySearchTerm } from '../searchRoute.ts';
import type { UnifiedSearchResult } from '../../../services/discovery.ts';

function row(type: string, destinationRoute: string | null, title = 'Title'): UnifiedSearchResult {
  return {
    id: `${type}-1`, type, title, subtitle: null, avatarUrl: null, imageUrl: null,
    fallbackInitials: null, locationPreview: null, matchedReason: null, actionState: null,
    privacyState: null, accessState: { canAccess: true }, destinationRoute, metadata: null,
    createdAt: null, startsAt: null,
  };
}

test('a plan opens app/plan/[id] with the trip id, not /trip/:id/plan', () => {
  assert.equal(resolveRoute(row('plans', '/trip/7f1c/plan')), '/plan/7f1c');
  assert.equal(resolveRoute(row('plans', '/trip/7f1c/plan/')), '/plan/7f1c');
});

test('a trip still opens the trip screen', () => {
  assert.equal(resolveRoute(row('trips', '/trip/7f1c')), '/trip/7f1c');
});

test('language, interest and vibe rows search for their word', () => {
  assert.equal(resolveRoute(row('languages', '/language/spanish', 'Spanish')), '/search?q=Spanish');
  assert.equal(resolveRoute(row('interests', '/interest/street%20food', 'Street food')), '/search?q=Street%20food');
  assert.equal(resolveRoute(row('vibes', '/vibe/chill', 'Chill')), '/search?q=Chill');
});

test('taxonomySearchTerm uses the title, else the decoded slug, and is null for entities', () => {
  assert.equal(taxonomySearchTerm(row('languages', '/language/spanish', 'Spanish')), 'Spanish');
  assert.equal(taxonomySearchTerm(row('interests', '/interest/street%20food', '  ')), 'street food');
  assert.equal(taxonomySearchTerm(row('posts', '/post/abc')), null);
  assert.equal(taxonomySearchTerm(row('trips', '/trip/abc/plan')), null);
  assert.equal(taxonomySearchTerm(row('languages', null)), null);
});

test('existing mappings are unchanged', () => {
  assert.equal(resolveRoute(row('hidden_gems', '/hidden-gem/g1')), '/gems/g1');
  assert.equal(resolveRoute(row('stamps', '/stamps/first-flight')), '/stamp/first-flight');
  assert.equal(resolveRoute(row('circles', '/circle/u9')), '/circle?ownerId=u9');
  assert.equal(resolveRoute(row('buddies', '/passport/ana')), '/(rent-a-buddy)/buddy/buddies-1');
  assert.equal(resolveRoute(row('posts', '/post/p1')), '/post/p1');
  assert.equal(resolveRoute(row('posts', null)), null);
});
