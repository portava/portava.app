/**
 * census-trips TR13 / TR65: a stage the trip already has can be dated
 * (UPDATE_STAGE) and moved through its lifecycle (START_STAGE /
 * COMPLETE_STAGE) by the product, through the unflagged command door, in the
 * keys the kernel reads.
 * Run: node --import tsx/esm --test src/features/trips/stages/__tests__/tripStageEntries.test.ts
 */
import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type { TripCommandRequest, TripCommandResult } from '../../../../services/tripCommands.ts';
import { stageBoundsCommand, stageTransitionCommand, nextArrow, STAGE_STATES } from '../tripStagePayloads.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..', '..', '..', '..');
const sql = (file: string) => readFileSync(join(REPO, 'artifacts', 'api-server', 'src', 'migrations', file), 'utf8');

const ST = '44444444-4444-4444-8444-444444444444';
const NONE = { startsAt: null, endsAt: null };

describe('UPDATE_STAGE: only the boundaries that changed', () => {
  it('a new start on an undated stage sends starts_at alone', () => {
    assert.deepEqual(stageBoundsCommand(ST, NONE, { startsAt: '2026-10-20T14:00:00+07:00', endsAt: null }),
      { ok: true, type: 'UPDATE_STAGE', payload: { stage_id: ST, patch: { starts_at: '2026-10-20T14:00:00+07:00' } } });
  });

  it('the same instant written another way is not a change; a cleared boundary is sent as null', () => {
    const current = { startsAt: '2026-10-20T07:00:00+00:00', endsAt: '2026-10-23T04:00:00+00:00' };
    assert.deepEqual(stageBoundsCommand(ST, current, { startsAt: '2026-10-20T14:00:00+07:00', endsAt: '2026-10-23T11:00:00+07:00' }), { ok: false, reason: 'LOCAL_NO_CHANGE' });
    assert.deepEqual(stageBoundsCommand(ST, current, { startsAt: '2026-10-20T14:00:00+07:00', endsAt: null }),
      { ok: true, type: 'UPDATE_STAGE', payload: { stage_id: ST, patch: { ends_at: null } } });
  });

  it('the ordering CHECK is judged on the stage as it will be — a new start after the kept end is refused', () => {
    const current = { startsAt: '2026-10-20T07:00:00+00:00', endsAt: '2026-10-23T04:00:00+00:00' };
    assert.deepEqual(stageBoundsCommand(ST, current, { startsAt: '2026-10-24T09:00:00+07:00', endsAt: current.endsAt }), { ok: false, reason: 'LOCAL_ENDS_BEFORE_START' });
    assert.deepEqual(stageBoundsCommand(ST, NONE, { startsAt: '2026-10-24T09:00', endsAt: null }), { ok: false, reason: 'LOCAL_BAD_TIME' });
    assert.deepEqual(stageBoundsCommand('stage-1', NONE, { startsAt: '2026-10-24T09:00:00Z', endsAt: null }), { ok: false, reason: 'LOCAL_INVALID' });
  });

  it('never writes `state` through the patch — the lifecycle has its own commands', () => {
    const r = stageBoundsCommand(ST, NONE, { startsAt: '2026-10-20T14:00:00+07:00', endsAt: '2026-10-21T14:00:00+07:00' });
    assert.ok(r.ok);
    assert.deepEqual(Object.keys((r.payload as { patch: object }).patch).sort(), ['ends_at', 'starts_at']);
  });
});

describe('START_STAGE / COMPLETE_STAGE: planned -> active -> completed', () => {
  it('each arrow is offered from the one state 2779 allows it from', () => {
    assert.deepEqual(stageTransitionCommand(ST, 'planned', 'start'), { ok: true, type: 'START_STAGE', payload: { stage_id: ST } });
    assert.deepEqual(stageTransitionCommand(ST, 'active', 'complete'), { ok: true, type: 'COMPLETE_STAGE', payload: { stage_id: ST } });
    assert.deepEqual(stageTransitionCommand(ST, 'active', 'start'), { ok: false, reason: 'LOCAL_NOT_PLANNED' });
    assert.deepEqual(stageTransitionCommand(ST, 'planned', 'complete'), { ok: false, reason: 'LOCAL_NOT_ACTIVE' });
    assert.deepEqual([nextArrow('planned'), nextArrow('active'), nextArrow('completed'), nextArrow('cancelled')], ['start', 'complete', null, null]);
  });

  it('the states are 2760\'s CHECK, and the arrows are 2779\'s', () => {
    const m = /CHECK \(state IN \(([^)]*)\)\)/.exec(sql('2760_trip_stages.sql'));
    assert.deepEqual([...STAGE_STATES], m![1]!.split(',').map((v) => v.trim().replace(/^'|'$/g, '')));
    const k = sql('2779_trip_kernel_plan_lifecycle_and_temporal_guard.sql');
    assert.ok(k.includes("IF (v_type = 'START_STAGE' AND v_status <> 'planned') OR (v_type = 'COMPLETE_STAGE' AND v_status <> 'active') THEN"));
    assert.ok(k.includes("v_stage_id := (v_payload->>'stage_id')::uuid;"));
  });

  it('UPDATE_STAGE\'s keys are the ones 2764 reads', () => {
    const k = sql('2764_trip_kernel_stage_family.sql');
    assert.ok(k.includes("v_patch    := coalesce(v_payload->'patch', '{}'::jsonb);"));
    for (const key of ['starts_at', 'ends_at']) assert.ok(k.includes(`WHEN v_patch ? '${key}'`), key);
  });

  it('the three types are ones the client and the unflagged endpoint both issue', () => {
    const route = readFileSync(join(REPO, 'artifacts', 'api-server', 'src', 'server', 'trips', 'commandRoute.ts'), 'utf8');
    const allow = route.slice(route.indexOf('export const COMMANDS_ENDPOINT_TYPES'), route.indexOf('const ISSUABLE'));
    const client = readFileSync(join(HERE, '..', '..', '..', '..', 'services', 'tripCommands.ts'), 'utf8');
    for (const t of ['UPDATE_STAGE', 'START_STAGE', 'COMPLETE_STAGE']) {
      assert.ok(allow.includes(`"${t}"`), `${t} is not in COMMANDS_ENDPOINT_TYPES`);
      assert.ok(client.includes(`'${t}'`), `${t} is not in TRIP_COMMAND_TYPES`);
    }
  });
});

describe('mounted', () => {
  it('the trip screen mounts the stage controls for a signed-in member, refreshed with the spine and refreshing it', () => {
    const screen = readFileSync(join(HERE, '..', '..', '..', '..', '..', 'app', 'trip', '[id].tsx'), 'utf8');
    assert.match(screen, /\{live && trip\.id \? <TripStageControls tripId=\{trip\.id\} refreshKey=\{stagesKey\} onChanged=\{\(\) => setStagesKey\(\(k\) => k \+ 1\)\} \/> : null\}/);
    assert.match(screen, /import \{ TripStageControls \} from '\.\.\/\.\.\/src\/features\/trips\/stages\/TripStageControls\.tsx';/);
  });
});

describe('through tripStageEntries', () => {
  type Mod = typeof import('../tripStageEntries.ts');
  let mod: Mod;
  let issued: Array<{ tripId: string; cmd: TripCommandRequest }> = [];
  let answer: () => TripCommandResult;
  const ok = (): TripCommandResult => ({ ok: true, duplicate: false, version: 4, eventId: 'e', sequence: 4, result: { id: ST, state: 'active' }, contractVersion: 2 });
  before(async () => { mod = await import('../tripStageEntries.ts'); mod._setTestIssuer(async (tripId, cmd) => { issued.push({ tripId, cmd }); return answer(); }); });
  after(() => mod._setTestIssuer(null));
  beforeEach(() => { issued = []; answer = ok; });

  it('sends the command with the caller\'s key and reports the kernel\'s word', async () => {
    assert.deepEqual(await mod.moveStage('t1', ST, 'planned', 'start', 'k-start'), { state: 'recorded', duplicate: false });
    assert.deepEqual(await mod.setStageBounds('t1', ST, NONE, { startsAt: '2026-10-20T14:00:00+07:00', endsAt: null }, 'k-dates'), { state: 'recorded', duplicate: false });
    assert.deepEqual(issued.map((i) => [i.tripId, i.cmd.type, i.cmd.payload, i.cmd.idempotencyKey]), [
      ['t1', 'START_STAGE', { stage_id: ST }, 'k-start'],
      ['t1', 'UPDATE_STAGE', { stage_id: ST, patch: { starts_at: '2026-10-20T14:00:00+07:00' } }, 'k-dates'],
    ]);
  });

  it('a kernel refusal is carried by name in words; unreachable is unavailable, never refused; a local refusal sends nothing', async () => {
    answer = () => ({ ok: false, kind: 'refused', status: 409, reason: 'TRIP_STAGE_INVALID_TRANSITION', detail: null, currentVersion: null, expectedVersion: null });
    assert.deepEqual(await mod.moveStage('t1', ST, 'planned', 'start', 'k'), { state: 'refused', reason: 'TRIP_STAGE_INVALID_TRANSITION', detail: 'the stage has moved on since this screen read it' });
    answer = () => ({ ok: false, kind: 'unavailable', detail: 'network error' });
    assert.deepEqual(await mod.moveStage('t1', ST, 'active', 'complete', 'k'), { state: 'unavailable', detail: 'network error' });
    issued = [];
    assert.deepEqual(await mod.moveStage('t1', ST, 'completed', 'complete', 'k'), { state: 'refused', reason: 'LOCAL_NOT_ACTIVE', detail: 'only a stage in progress can be completed' });
    assert.deepEqual(issued, []);
  });

  it('a key is fresh per tap and names the stage and the change', () => {
    const a = mod.stageControlKey(ST, 'start'); const b = mod.stageControlKey(ST, 'start');
    assert.match(a, new RegExp(`^stage-control:${ST}:start:`));
    assert.notEqual(a, b);
  });
});
