/**
 * census-trips TR78 / TR79 / TR81 / TR84 — the product's writer for stages,
 * legs, commitments and goals is a kernel command, never a table write, in the
 * migrations' own vocabularies, and the trip screen mounts it.
 * Run: node --import tsx/esm --test src/features/trips/planning/__tests__/tripStructureEntries.test.ts
 */
import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type { TripCommandRequest, TripCommandResult } from '../../../../services/tripCommands.ts';

type Mod = typeof import('../tripStructureEntries.ts');
let mod: Mod;
let issued: Array<{ tripId: string; cmd: TripCommandRequest }> = [];
const okAnswer = (): TripCommandResult => ({ ok: true, duplicate: false, version: 3, eventId: 'e1', sequence: 3, result: { id: 'new-row' }, contractVersion: 2 });
let answer: () => TripCommandResult = okAnswer;

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..', '..', '..', '..');
const MIGRATIONS = join(REPO, 'artifacts', 'api-server', 'src', 'migrations');

/** The value list of one named CHECK ... IN (...) constraint, read from the migration itself. */
function checkValues(file: string, constraint: string): string[] {
  const sql = readFileSync(join(MIGRATIONS, file), 'utf8');
  const at = sql.indexOf(constraint);
  assert.ok(at >= 0, `${constraint} not found in ${file}`);
  const m = /IN\s*\(([^)]*)\)/.exec(sql.slice(at));
  assert.ok(m, `${constraint} has no IN list`);
  return m![1]!.split(',').map((v) => v.trim().replace(/^'|'$/g, ''));
}

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const CITY = '33333333-3333-4333-8333-333333333333';

describe('stages, legs, commitments and goals, added through the kernel', () => {
  before(async () => {
    mod = await import('../tripStructureEntries.ts');
    mod._setTestIssuer(async (tripId, cmd) => { issued.push({ tripId, cmd }); return answer(); });
  });
  after(() => mod._setTestIssuer(null));
  beforeEach(() => { issued = []; answer = okAnswer; });

  it('a stage is ADD_STAGE { stage_type, city_id, timezone, sequence } with the caller\'s key, and the new row id is returned', async () => {
    const r = await mod.addStage('t1', { stageType: 'city', cityId: CITY, timezone: ' Europe/Lisbon ', sequence: 2 }, 'k-stage');
    assert.deepEqual(r, { state: 'recorded', duplicate: false, id: 'new-row' });
    assert.deepEqual(issued, [{ tripId: 't1', cmd: { type: 'ADD_STAGE', payload: { stage_type: 'city', city_id: CITY, timezone: 'Europe/Lisbon', sequence: 2 }, idempotencyKey: 'k-stage' } }]);
  });

  it('a leg is ADD_LEG { leg_type, from_stage_id, to_stage_id }', async () => {
    await mod.addLeg('t1', { legType: 'train', fromStageId: S1, toStageId: S2 }, 'k-leg');
    assert.deepEqual(issued.map((i) => [i.cmd.type, i.cmd.payload, i.cmd.idempotencyKey]), [
      ['ADD_LEG', { leg_type: 'train', from_stage_id: S1, to_stage_id: S2 }, 'k-leg'],
    ]);
  });

  it('a commitment is ADD_COMMITMENT { type, flexibility, stage_id? } — no stage sends no stage_id', async () => {
    await mod.addCommitment('t1', { type: 'event', flexibility: 'fixed', stageId: S2 }, 'k-c1');
    await mod.addCommitment('t1', { type: 'lodging', flexibility: 'flexible', stageId: null }, 'k-c2');
    assert.deepEqual(issued.map((i) => [i.cmd.type, i.cmd.payload]), [
      ['ADD_COMMITMENT', { type: 'event', flexibility: 'fixed', stage_id: S2 }],
      ['ADD_COMMITMENT', { type: 'lodging', flexibility: 'flexible' }],
    ]);
  });

  it('a goal is ADD_GOAL { type, priority, scope }', async () => {
    await mod.addGoal('t1', { type: 'rest', priority: 'high', scope: 'personal' }, 'k-g');
    assert.deepEqual(issued.map((i) => [i.cmd.type, i.cmd.payload, i.cmd.idempotencyKey]), [
      ['ADD_GOAL', { type: 'rest', priority: 'high', scope: 'personal' }, 'k-g'],
    ]);
  });

  it('the vocabularies are the migrations\' CHECKs, read from the SQL', () => {
    assert.deepEqual([...mod.STAGE_TYPES], checkValues('2760_trip_stages.sql', 'trip_stages_type_known'));
    assert.deepEqual([...mod.LEG_TYPES], checkValues('2761_trip_legs_and_commitments.sql', 'trip_legs_type_known'));
    assert.deepEqual([...mod.COMMITMENT_TYPES], checkValues('2761_trip_legs_and_commitments.sql', 'trip_commitments_type_known'));
    assert.deepEqual([...mod.COMMITMENT_FLEXIBILITIES], checkValues('2761_trip_legs_and_commitments.sql', 'trip_commitments_flexibility_known'));
    assert.deepEqual([...mod.GOAL_TYPES], checkValues('2762_trip_goals_decisions_risks.sql', 'trip_goals_type_known'));
    assert.deepEqual([...mod.GOAL_PRIORITIES], checkValues('2762_trip_goals_decisions_risks.sql', 'CONSTRAINT trip_goals_priority_known'));
    assert.deepEqual([...mod.GOAL_SCOPES], checkValues('2783_trip_goal_scope_and_member_permissions_version.sql', 'ADD CONSTRAINT trip_goals_scope_known'));
  });

  it('a value the database would refuse is refused locally — nothing is sent', async () => {
    const refusals = [
      await mod.addStage('t1', { stageType: 'planet', cityId: CITY, timezone: 'UTC', sequence: 1 }, 'k'),
      await mod.addStage('t1', { stageType: 'city', cityId: CITY, timezone: 'UTC', sequence: 0 }, 'k'),
      await mod.addStage('t1', { stageType: 'city', cityId: 'nominatim:123', timezone: 'UTC', sequence: 1 }, 'k'),
      await mod.addStage('t1', { stageType: 'city', cityId: null, timezone: 'UTC', sequence: 1 }, 'k'),
      await mod.addStage('t1', { stageType: 'city', cityId: CITY, timezone: '  ', sequence: 1 }, 'k'),
      await mod.addLeg('t1', { legType: 'teleport', fromStageId: S1, toStageId: S2 }, 'k'),
      await mod.addLeg('t1', { legType: 'bus', fromStageId: S1, toStageId: S1 }, 'k'),
      await mod.addCommitment('t1', { type: 'party', flexibility: 'fixed', stageId: null }, 'k'),
      await mod.addCommitment('t1', { type: 'event', flexibility: 'maybe', stageId: null }, 'k'),
      await mod.addCommitment('t1', { type: 'event', flexibility: 'fixed', stageId: 'stage-one' }, 'k'),
      await mod.addGoal('t1', { type: 'food', priority: 'normal', scope: 'shared' }, 'k'),
      await mod.addGoal('t1', { type: 'rest', priority: '0.5', scope: 'shared' }, 'k'),
      await mod.addGoal('t1', { type: 'rest', priority: 'normal', scope: 'everyone' }, 'k'),
    ];
    assert.deepEqual(refusals.map((r) => r.state === 'refused' ? r.reason : r.state), [
      'LOCAL_INVALID', 'LOCAL_INVALID', 'LOCAL_NO_ANCHOR', 'LOCAL_NO_ANCHOR', 'LOCAL_NO_TIMEZONE',
      'LOCAL_INVALID', 'LOCAL_SAME_STAGE',
      'LOCAL_INVALID', 'LOCAL_INVALID', 'LOCAL_INVALID',
      'LOCAL_INVALID', 'LOCAL_INVALID', 'LOCAL_INVALID',
    ]);
    assert.deepEqual(issued, []);
  });

  it('a kernel refusal is carried by name with its words; an unreachable kernel is unavailable — never "refused"', async () => {
    answer = () => ({ ok: false, kind: 'refused', status: 409, reason: 'TRIP_STAGE_SEQUENCE_TAKEN', detail: null, currentVersion: null, expectedVersion: null });
    assert.deepEqual(await mod.addStage('t1', { stageType: 'city', cityId: CITY, timezone: 'UTC', sequence: 1 }, 'k'),
      { state: 'refused', reason: 'TRIP_STAGE_SEQUENCE_TAKEN', detail: 'another stage was added at that position first' });
    answer = () => ({ ok: false, kind: 'refused', status: 404, reason: 'TRIP_STAGE_NOT_FOUND', detail: 'from_stage_id is not a stage of this trip', currentVersion: null, expectedVersion: null });
    assert.deepEqual(await mod.addLeg('t1', { legType: 'bus', fromStageId: S1, toStageId: S2 }, 'k'),
      { state: 'refused', reason: 'TRIP_STAGE_NOT_FOUND', detail: 'that stage is no longer on this trip' });
    answer = () => ({ ok: false, kind: 'refused', status: 400, reason: 'TRIP_SOMETHING_NEW', detail: 'the kernel says no', currentVersion: null, expectedVersion: null });
    assert.deepEqual(await mod.addGoal('t1', { type: 'rest', priority: 'low', scope: 'shared' }, 'k'),
      { state: 'refused', reason: 'TRIP_SOMETHING_NEW', detail: 'the kernel says no' });
    answer = () => ({ ok: false, kind: 'unavailable', detail: 'network error' });
    assert.deepEqual(await mod.addCommitment('t1', { type: 'event', flexibility: 'fixed', stageId: null }, 'k'),
      { state: 'unavailable', detail: 'network error' });
  });

  it('the next stage position is one past the highest; an empty spine starts at 1', () => {
    assert.equal(mod.nextStageSequence([]), 1);
    assert.equal(mod.nextStageSequence([{ sequence: 1 }, { sequence: 4 }, { sequence: 2 }]), 5);
  });

  it('a key is fresh per tap and names its kind', () => {
    const a = mod.structureEntryKey('stage');
    const b = mod.structureEntryKey('stage');
    assert.match(a, /^structure-entry:stage:/);
    assert.notEqual(a, b);
  });

  it('the trip\'s time zone is read only when the trip read carries one', () => {
    assert.equal(mod.tripTimezoneOf({ timezone: 'Asia/Tokyo' }), 'Asia/Tokyo');
    assert.equal(mod.tripTimezoneOf({ timezone: '  ' }), null);
    assert.equal(mod.tripTimezoneOf({ title: 'x' }), null);
    assert.equal(mod.tripTimezoneOf(null), null);
  });

  it('all four command types are ones the client and the unflagged endpoint both issue', () => {
    const route = readFileSync(join(REPO, 'artifacts', 'api-server', 'src', 'server', 'trips', 'commandRoute.ts'), 'utf8');
    const allow = route.slice(route.indexOf('export const COMMANDS_ENDPOINT_TYPES'), route.indexOf('const ISSUABLE'));
    const client = readFileSync(join(HERE, '..', '..', '..', '..', 'services', 'tripCommands.ts'), 'utf8');
    for (const t of ['ADD_STAGE', 'ADD_LEG', 'ADD_COMMITMENT', 'ADD_GOAL']) {
      assert.ok(allow.includes(`"${t}"`), `${t} is not in COMMANDS_ENDPOINT_TYPES`);
      assert.ok(client.includes(`'${t}'`), `${t} is not in TRIP_COMMAND_TYPES`);
    }
  });

  it('the trip screen mounts the composer and the plan-privacy card for a signed-in member', () => {
    const screen = readFileSync(join(HERE, '..', '..', '..', '..', '..', 'app', 'trip', '[id].tsx'), 'utf8');
    assert.match(screen, /\{live && trip\.id \? <TripStructureComposer tripId=\{trip\.id\} tripTimezone=\{tripTimezoneOf\(realTrip\)\} onAdded=/);
    assert.match(screen, /\{live && trip\.id && userId \? <TripPlanPrivacyCard tripId=\{trip\.id\} currentUserId=\{userId\} \/> : null\}/);
    // a stage, leg or commitment re-reads the spine; a goal re-reads the decisions board
    assert.match(screen, /kind === 'goal' \? setDecisionsKey\(\(k\) => k \+ 1\) : setStagesKey\(\(k\) => k \+ 1\)/);
    assert.match(screen, /<React\.Fragment key=\{`stages-\$\{stagesKey\}`\}><TripStageSpineCard tripId=\{trip\.id\} \/><\/React\.Fragment>/);
  });
});
