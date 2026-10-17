/**
 * census-trips TR149 (§9.1 attendance; populates TR83): the product states the
 * viewer's own attendance with JOIN_PLAN / SET_PLAN_ATTENDANCE / LEAVE_PLAN,
 * through the unflagged command door, in the keys 2772 reads.
 * Run: node --import tsx/esm --test src/features/trips/plans/__tests__/tripAttendance.test.ts
 */
import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type { TripCommandRequest, TripCommandResult } from '../../../../services/tripCommands.ts';
import { attendanceCommand, myAttendance, goingCount, ATTENDANCE_STATES, OFFERED_ATTENDANCE } from '../tripAttendancePayloads.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..', '..', '..', '..');
const sql = (file: string) => readFileSync(join(REPO, 'artifacts', 'api-server', 'src', 'migrations', file), 'utf8');
const PLAN = '55555555-5555-4555-8555-555555555555';

describe('which command moves the viewer\'s answer', () => {
  it('no row: JOIN_PLAN with the state; a row: SET_PLAN_ATTENDANCE; leaving: LEAVE_PLAN', () => {
    assert.deepEqual(attendanceCommand(PLAN, null, 'going'), { ok: true, type: 'JOIN_PLAN', payload: { plan_id: PLAN, attendance_state: 'going' } });
    assert.deepEqual(attendanceCommand(PLAN, null, 'cant_go'), { ok: true, type: 'JOIN_PLAN', payload: { plan_id: PLAN, attendance_state: 'cant_go' } });
    assert.deepEqual(attendanceCommand(PLAN, 'going', 'maybe'), { ok: true, type: 'SET_PLAN_ATTENDANCE', payload: { plan_id: PLAN, attendance_state: 'maybe' } });
    assert.deepEqual(attendanceCommand(PLAN, 'left', 'going'), { ok: true, type: 'SET_PLAN_ATTENDANCE', payload: { plan_id: PLAN, attendance_state: 'going' } });
    assert.deepEqual(attendanceCommand(PLAN, 'maybe', 'leave'), { ok: true, type: 'LEAVE_PLAN', payload: { plan_id: PLAN } });
  });

  it('nothing is sent for the answer already given, for leaving what was never joined, or for a plan that is not an id', () => {
    assert.deepEqual(attendanceCommand(PLAN, 'going', 'going'), { ok: false, reason: 'LOCAL_NO_CHANGE' });
    assert.deepEqual(attendanceCommand(PLAN, null, 'leave'), { ok: false, reason: 'LOCAL_NOT_ON_PLAN' });
    assert.deepEqual(attendanceCommand(PLAN, 'left', 'leave'), { ok: false, reason: 'LOCAL_NOT_ON_PLAN' });
    assert.deepEqual(attendanceCommand('plan-1', null, 'going'), { ok: false, reason: 'LOCAL_INVALID' });
    assert.deepEqual(attendanceCommand(PLAN, null, 'left' as never), { ok: false, reason: 'LOCAL_INVALID' });
  });

  it('the states are 2771\'s CHECK; `left` is reached only by leaving; no command names a user', () => {
    const m = /CHECK \(attendance_state IN \(([^)]*)\)\)/.exec(sql('2771_trip_plan_participants.sql'));
    assert.deepEqual([...ATTENDANCE_STATES], m![1]!.split(',').map((v) => v.trim().replace(/^'|'$/g, '')));
    assert.ok(!(OFFERED_ATTENDANCE as readonly string[]).includes('left'));
    for (const target of [...OFFERED_ATTENDANCE, 'leave'] as const) {
      for (const current of [null, ...ATTENDANCE_STATES]) {
        const c = attendanceCommand(PLAN, current, target);
        if (c.ok) assert.ok(!('user_id' in c.payload), `${c.type} names a user`);
      }
    }
  });

  it('the keys are the ones 2772 reads', () => {
    const k = sql('2772_trip_kernel_plan_attendance_and_plan_version.sql');
    assert.ok(k.includes("v_item_id := (v_payload->>'plan_id')::uuid;"));
    assert.ok(k.includes("v_attendance := coalesce(v_payload->>'attendance_state', 'going');"));
    assert.ok(k.includes("v_attendance := v_payload->>'attendance_state';"));
  });

  it('the three types are ones the client and the unflagged endpoint both issue', () => {
    const route = readFileSync(join(REPO, 'artifacts', 'api-server', 'src', 'server', 'trips', 'commandRoute.ts'), 'utf8');
    const allow = route.slice(route.indexOf('export const COMMANDS_ENDPOINT_TYPES'), route.indexOf('const ISSUABLE'));
    const client = readFileSync(join(HERE, '..', '..', '..', '..', 'services', 'tripCommands.ts'), 'utf8');
    for (const t of ['JOIN_PLAN', 'SET_PLAN_ATTENDANCE', 'LEAVE_PLAN']) {
      assert.ok(allow.includes(`"${t}"`), `${t} is not in COMMANDS_ENDPOINT_TYPES`);
      assert.ok(client.includes(`'${t}'`), `${t} is not in TRIP_COMMAND_TYPES`);
    }
  });
});

describe('reading the answers the structure served', () => {
  const attendance = [
    { planId: PLAN, participants: [{ userId: 'me', attendanceState: 'maybe' }, { userId: 'ana', attendanceState: 'going' }, { userId: 'bo', attendanceState: 'interested' }], goingUserIds: ['ana'] },
  ];
  it('the viewer\'s own row, or null; an unknown state is null', () => {
    assert.equal(myAttendance(attendance, PLAN, 'me'), 'maybe');
    assert.equal(myAttendance(attendance, PLAN, 'zed'), null);
    assert.equal(myAttendance([{ planId: PLAN, participants: [{ userId: 'me', attendanceState: 'attending' }] }], PLAN, 'me'), null);
  });
  it('going is the server\'s goingUserIds — interested and maybe are not counted; no rows is null, not 0', () => {
    assert.equal(goingCount(attendance, PLAN), 1);
    assert.equal(goingCount(attendance, 'other'), null);
  });
});

describe('mounted', () => {
  it('the trip screen mounts the attendance card for a signed-in member', () => {
    const screen = readFileSync(join(HERE, '..', '..', '..', '..', '..', 'app', 'trip', '[id].tsx'), 'utf8');
    assert.match(screen, /\{live && trip\.id && userId \? <TripPlanAttendanceCard tripId=\{trip\.id\} currentUserId=\{userId\} \/> : null\}/);
    assert.match(screen, /import \{ TripPlanAttendanceCard \} from '\.\.\/\.\.\/src\/features\/trips\/plans\/TripPlanAttendanceCard\.tsx';/);
  });
});

describe('through tripAttendance', () => {
  type Mod = typeof import('../tripAttendance.ts');
  let mod: Mod;
  let issued: TripCommandRequest[] = [];
  let answer: () => TripCommandResult;
  before(async () => { mod = await import('../tripAttendance.ts'); mod._setTestIssuer(async (_t, cmd) => { issued.push(cmd); return answer(); }); });
  after(() => mod._setTestIssuer(null));
  beforeEach(() => { issued = []; answer = () => ({ ok: true, duplicate: false, version: 5, eventId: 'e', sequence: 5, result: {}, contractVersion: 2 }); });

  it('sends the command with the caller\'s key; refusals in words; unreachable stays unavailable', async () => {
    assert.deepEqual(await mod.setAttendance('t1', PLAN, null, 'going', 'k1'), { state: 'recorded', duplicate: false });
    assert.deepEqual(issued, [{ type: 'JOIN_PLAN', payload: { plan_id: PLAN, attendance_state: 'going' }, idempotencyKey: 'k1' }]);
    answer = () => ({ ok: false, kind: 'refused', status: 404, reason: 'TRIP_PLAN_ATTENDANCE_NOT_FOUND', detail: null, currentVersion: null, expectedVersion: null });
    assert.deepEqual(await mod.setAttendance('t1', PLAN, 'going', 'maybe', 'k2'), { state: 'refused', reason: 'TRIP_PLAN_ATTENDANCE_NOT_FOUND', detail: "you're not on this plan's list any more — read it again" });
    answer = () => ({ ok: false, kind: 'unavailable', detail: 'network error' });
    assert.deepEqual(await mod.setAttendance('t1', PLAN, 'going', 'leave', 'k3'), { state: 'unavailable', detail: 'network error' });
    issued = [];
    assert.equal((await mod.setAttendance('t1', PLAN, 'going', 'going', 'k4')).state, 'refused');
    assert.deepEqual(issued, []);
    assert.match(mod.attendanceKey(PLAN, 'going'), new RegExp(`^attendance:${PLAN}:going:`));
  });
});
