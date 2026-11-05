import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import router from '../routes/mapPrivacy.js';
import { makeOracle } from './helpers/postgrestOracle.js';
import { mountRouterApp, type ProjectionApp } from './helpers/fakeMapDb.js';
const user = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
let app: ProjectionApp;
const writes: Array<{ name: string; args: Record<string,unknown> }> = [];
const tables = { map_personal_protected_places: [{ id: 'own', owner_user_id: user, category: 'home', center_lat: 16.12, center_lng: 108.12, radius_meters: 1500 }, { id: 'other', owner_user_id: other, category: 'work', center_lat: 1, center_lng: 2, radius_meters: 1500 }], feature_flags: [{ flag: 'map_route_flow_consent_enabled', enabled: false }], route_flow_contribution_consent: [] };
const rpc = (name: string) => (args: Record<string,unknown>) => { writes.push({name,args}); return {data:null,error:null}; };
before(async () => {
 const oracle = makeOracle({ tables, rpc: { set_map_personal_protected_place: rpc('protection'), set_map_route_flow_consent: rpc('consent') } });
 const client = { from: oracle.client.from.bind(oracle.client), rpc: oracle.client.rpc.bind(oracle.client), auth: { getUser: async (token: string) => ({ data: { user: token === 'fixture' ? { id: user } : null }, error: null }) } };
 app = await mountRouterApp(router, client, { token: 'fixture', userId: user });
});
after(async () => { await app?.close(); });
const request = (path: string, method = 'GET', body?: unknown, token = 'fixture') => fetch(`${app.baseUrl}/api/map/privacy${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
test('private map areas are account-scoped and anonymous callers cannot inspect them', async () => {
 const response = await request('/protected-places'); assert.equal(response.status,200);
 assert.deepEqual((await response.json() as { places: unknown[] }).places, [{id:'own',category:'home',lat:16.12,lng:108.12,radiusMeters:1500}]);
 assert.equal((await request('/protected-places','GET',undefined,'wrong')).status,401);
});
test('protection uses the authenticated owner, rounds before persistence, and refuses owner injection', async () => {
 const response = await request('/protected-places','PUT',{category:'school',lat:16.123456,lng:108.123456}); assert.equal(response.status,204);
 assert.deepEqual(writes.at(-1),{name:'protection',args:{p_user_id:user,p_category:'school',p_lat:16.12,p_lng:108.12,p_radius:1500}});
 const before=writes.length; assert.equal((await request('/protected-places','PUT',{category:'home',lat:0,lng:0,owner_user_id:other})).status,400); assert.equal(writes.length,before);
});
test('withdrawal remains reachable with collection disabled and cannot grant without reviewed text', async () => {
 assert.equal((await request('/route-flow','PUT',{granted:false})).status,204);
 assert.deepEqual(writes.at(-1),{name:'consent',args:{p_user_id:user,p_enabled:false,p_version:null}});
 const before=writes.length; assert.notEqual((await request('/route-flow','PUT',{granted:true,displayedVersion:'invented'})).status,204); assert.equal(writes.length,before);
});
test('removing own home protection leaves another account untouched', async () => {
 assert.equal((await request('/protected-places/home','DELETE')).status,204);
 assert.deepEqual(tables.map_personal_protected_places.map(row=>row.id),['other']);
});
