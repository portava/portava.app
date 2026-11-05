import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeFakeMapDb } from './helpers/fakeMapDb.js';
import { loadPersonalProtectedZones, personalPointSuppressed } from '../lib/mapPersonalProtection.js';
const fixture = { id: 'home', owner_user_id: 'a', category: 'home', center_lat: 16.12, center_lng: 108.12, radius_meters: 1500 };
test('private areas apply to their owner only, without sharing their geometry', async () => {
  const db = makeFakeMapDb({ map_personal_protected_places: [fixture] }, { token: 'test', userId: 'a' });
  const zones = await loadPersonalProtectedZones(db, ['a', 'b']); assert.ok(zones);
  assert.equal(personalPointSuppressed(zones.get('a'), { lat: 16.12, lng: 108.12 }), true);
  assert.equal(personalPointSuppressed(zones.get('b'), { lat: 16.12, lng: 108.12 }), false);
  assert.equal(personalPointSuppressed(zones.get('a'), { lat: 20, lng: 110 }), false);
});
test('unreadable privacy and malformed protection cannot become unprotected', async () => {
  const db = makeFakeMapDb({ map_personal_protected_places: { error: { message: 'offline' } } }, { token: 'test', userId: 'a' });
  assert.equal(await loadPersonalProtectedZones(db, ['a']), null);
  assert.equal(personalPointSuppressed(null, { lat: 16, lng: 108 }), true);
  const bad = makeFakeMapDb({ map_personal_protected_places: [{ ...fixture, radius_meters: 'broken' }] }, { token: 'test', userId: 'a' });
  const zones = await loadPersonalProtectedZones(bad, ['a']); assert.equal(personalPointSuppressed(zones?.get('a'), { lat: 20, lng: 110 }), true);
});
test('fakeMapDb reports exact total before windowing and preserves explicit malformed moderation', async () => {
  const db = makeFakeMapDb({ places: [{ id: 'a' }, { id: 'b', moderation_status: null }] }, { token: 'test', userId: 'a' });
  const page = await db.from('places').select('id,moderation_status', { count: 'exact' }).range(1,1);
  assert.equal(page.count, 2); assert.deepEqual(page.data, [{ id: 'b', moderation_status: null }]);
});
