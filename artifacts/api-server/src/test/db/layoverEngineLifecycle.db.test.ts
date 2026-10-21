import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PRESSED_SKIP_REASON, openPressedLayoverDb, type PressedDb, type PressedUser } from './pressedLayoverDb.js';
import { productionBaseFlags, startPressedLayoverApp, startSession, type PressedApp } from './pressedLayoverApp.js';
let db: PressedDb, app: PressedApp, owner: PressedUser, other: PressedUser;
describe('L39 actual unlinked session cancellation and reported boarding on migrated schema', { skip: PRESSED_SKIP_REASON }, () => {
  before(async () => { db = await openPressedLayoverDb(); await productionBaseFlags(db);
    await db.setFlags({ layover_lifecycle_machine_enabled: true, layover_flight_connections_enabled: true });
    owner = await db.seedUser('lifecycle_owner'); other = await db.seedUser('lifecycle_other'); app = await startPressedLayoverApp(db); });
  after(async () => { await app?.close(); await db?.close(); });
  it('traveller cancellation advances the graph even without a linked Trips flight', async () => {
    const sid = (await startSession(app, owner)).id;
    const r = await app.call('POST', `/api/airport/sessions/${sid}/disruption`, owner, { kind: 'cancellation' });
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.reportedCancellation?.event, 'DEPARTURE_CANCELLED', r.raw);
    const [row] = await db.query<{ state: string }>(`SELECT state FROM public.layover_sessions WHERE id='${sid}'`);
    assert.equal(row.state, 'CANCELLED');
  });
  it('I made my flight records traveller-reported boarding before the close, without claiming an observed departure', async () => {
    const sid = (await startSession(app, owner)).id;
    const foreign = await app.call('DELETE', `/api/airport/sessions/${sid}`, other, { outcome: 'completed' });
    assert.equal(foreign.status, 404, foreign.raw);
    const r = await app.call('DELETE', `/api/airport/sessions/${sid}`, owner, { outcome: 'completed' });
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.reportedBoarding?.event, 'BOARDING_STARTED', r.raw);
    assert.equal(r.body.reportedBoarding?.source, 'traveller');
    assert.equal(r.body.reportedBoarding?.state?.to, 'BOARDING', r.raw);
    const [row] = await db.query<{ state: string }>(`SELECT state FROM public.layover_sessions WHERE id='${sid}'`);
    assert.equal(row.state, 'COMPLETED');
  });
});
