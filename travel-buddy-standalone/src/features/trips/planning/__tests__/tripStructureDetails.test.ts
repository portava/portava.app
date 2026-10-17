/**
 * census-trips TR13 / TR15 / TR78 / TR122–TR125 / TR127: a stage's boundaries
 * and a commitment's §7.1 fields ride the product's ADD_STAGE / ADD_COMMITMENT,
 * checked against the migrations' own CHECKs, and the keys are the ones the
 * kernel reads.
 * Run: node --import tsx/esm --test src/features/trips/planning/__tests__/tripStructureDetails.test.ts
 */
import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type { TripCommandRequest, TripCommandResult } from '../../../../services/tripCommands.ts';
import { boundedStageCommand, detailedCommitmentCommand, stageBoundsPayload, commitmentDetailsPayload, intervalMinutes, CONFIDENCE_STEPS } from '../tripStructureDetails.ts';
import { stageBoundsDraft, commitmentDetailsDraft, commitmentZone, EMPTY_STAGE_BOUNDS, EMPTY_COMMITMENT_DETAILS } from '../structureDetailDrafts.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..', '..', '..', '..');
const sql = (file: string) => readFileSync(join(REPO, 'artifacts', 'api-server', 'src', 'migrations', file), 'utf8');

const S1 = '11111111-1111-4111-8111-111111111111';
const CITY = '33333333-3333-4333-8333-333333333333';
const stage = { stageType: 'city', cityId: CITY, timezone: 'Asia/Ho_Chi_Minh', sequence: 1 };
const t = (date: string, time: string, pick: 'earlier' | 'later' | null = null) => ({ date, time, pick });

describe('a stage\'s boundaries on ADD_STAGE', () => {
  it('ride the base command when given, and are absent when not', () => {
    assert.deepEqual(boundedStageCommand({ ...stage, startsAt: '2026-10-20T14:00:00+07:00', endsAt: '2026-10-23T11:00:00+07:00' }), {
      ok: true, type: 'ADD_STAGE',
      payload: { stage_type: 'city', city_id: CITY, timezone: 'Asia/Ho_Chi_Minh', sequence: 1, starts_at: '2026-10-20T14:00:00+07:00', ends_at: '2026-10-23T11:00:00+07:00' },
    });
    assert.deepEqual(boundedStageCommand(stage), { ok: true, type: 'ADD_STAGE', payload: { stage_type: 'city', city_id: CITY, timezone: 'Asia/Ho_Chi_Minh', sequence: 1 } });
    assert.deepEqual(boundedStageCommand({ ...stage, endsAt: '2026-10-23T11:00:00+07:00' }).ok, true);
  });

  it('2760\'s ordering CHECK and a zone-less time are refused here; a base refusal comes back as it is', () => {
    assert.deepEqual(boundedStageCommand({ ...stage, startsAt: '2026-10-23T11:00:00+07:00', endsAt: '2026-10-23T10:59:00+07:00' }), { ok: false, reason: 'LOCAL_ENDS_BEFORE_START' });
    assert.deepEqual(boundedStageCommand({ ...stage, startsAt: '2026-10-23T11:00:00' }), { ok: false, reason: 'LOCAL_BAD_TIME' });
    assert.deepEqual(boundedStageCommand({ ...stage, cityId: null, startsAt: '2026-10-23T11:00:00+07:00' }), { ok: false, reason: 'LOCAL_NO_ANCHOR' });
    // equal ends is allowed: 2760 says ends_at >= starts_at
    assert.equal(stageBoundsPayload({ startsAt: '2026-10-23T11:00:00+07:00', endsAt: '2026-10-23T04:00:00Z' }).ok, true);
    assert.match(sql('2760_trip_stages.sql'), /CHECK \(starts_at IS NULL OR ends_at IS NULL OR ends_at >= starts_at\)/);
  });
});

describe('a commitment\'s §7.1 fields on ADD_COMMITMENT', () => {
  it('start, required arrival, both buffers and confidence ride the base command under the kernel\'s keys', () => {
    const r = detailedCommitmentCommand({
      type: 'event', flexibility: 'fixed', stageId: S1,
      startsAt: '2026-10-02T19:00:00+07:00', requiredArrivalAt: '2026-10-02T18:45:00+07:00',
      latenessMinutes: 5, prepMinutes: 20, confidence: 0.75,
    });
    assert.deepEqual(r, {
      ok: true, type: 'ADD_COMMITMENT',
      payload: {
        type: 'event', flexibility: 'fixed', stage_id: S1,
        starts_at: '2026-10-02T19:00:00+07:00', required_arrival_at: '2026-10-02T18:45:00+07:00',
        lateness_tolerance: '5 minutes', prep_duration: '20 minutes', confidence: 0.75,
      },
    });
    // nothing given: exactly the base command
    assert.deepEqual(detailedCommitmentCommand({ type: 'lodging', flexibility: 'flexible', stageId: null }), { ok: true, type: 'ADD_COMMITMENT', payload: { type: 'lodging', flexibility: 'flexible' } });
    // ONE starts_at path: the start is commitmentCommand's (CommitmentInput.startsAt); the details never write it again
    const d = commitmentDetailsPayload({ startsAt: '2026-10-02T19:00:00+07:00', requiredArrivalAt: '2026-10-02T18:45:00+07:00' });
    assert.ok(d.ok && !('starts_at' in d.payload) && d.payload.required_arrival_at === '2026-10-02T18:45:00+07:00');
    // zero is a value, not "not stated"
    assert.deepEqual(commitmentDetailsPayload({ latenessMinutes: 0, confidence: 0 }), { ok: true, payload: { lateness_tolerance: '0 minutes', confidence: 0 } });
  });

  it('every refusal is a 2761 CHECK, made here first, and nothing reaches the kernel', () => {
    const base = { type: 'event', flexibility: 'fixed', stageId: null };
    const reasons = [
      detailedCommitmentCommand({ ...base, startsAt: '2026-10-02T19:00:00+07:00', requiredArrivalAt: '2026-10-02T19:01:00+07:00' }),
      detailedCommitmentCommand({ ...base, requiredArrivalAt: '2026-10-02T18:45:00' }),
      detailedCommitmentCommand({ ...base, prepMinutes: -1 }),
      detailedCommitmentCommand({ ...base, latenessMinutes: 2.5 }),
      detailedCommitmentCommand({ ...base, confidence: 1.01 }),
      detailedCommitmentCommand({ ...base, confidence: 0.333 }),
      detailedCommitmentCommand({ ...base, confidence: -0.1 }),
    ].map((c) => (c.ok ? 'sent' : c.reason));
    assert.deepEqual(reasons, ['LOCAL_ARRIVAL_AFTER_START', 'LOCAL_BAD_TIME', 'LOCAL_BAD_DURATION', 'LOCAL_BAD_DURATION', 'LOCAL_BAD_CONFIDENCE', 'LOCAL_BAD_CONFIDENCE', 'LOCAL_BAD_CONFIDENCE']);
    // arriving exactly at the start is allowed: 2761 says required_arrival_at <= starts_at
    assert.equal(commitmentDetailsPayload({ startsAt: '2026-10-02T19:00:00+07:00', requiredArrivalAt: '2026-10-02T12:00:00Z' }).ok, true);
    // a zone-less start is refused whichever module checks it first
    assert.equal(detailedCommitmentCommand({ ...base, startsAt: '2026-10-02T19:00:00' }).ok, false);
    const m = sql('2761_trip_legs_and_commitments.sql');
    assert.match(m, /CHECK \(starts_at IS NULL OR required_arrival_at IS NULL OR required_arrival_at <= starts_at\)/);
    assert.match(m, /lateness_tolerance IS NULL OR lateness_tolerance >= interval '0'/);
    assert.match(m, /prep_duration\s+IS NULL OR prep_duration\s+>= interval '0'/);
    assert.match(m, /CHECK \(confidence IS NULL OR \(confidence >= 0 AND confidence <= 1\)\)/);
    assert.match(m, /confidence\s+numeric\(3,2\) NULL/);
  });

  it('the offered confidences are all storable in numeric(3,2) within 0..1', () => {
    for (const c of CONFIDENCE_STEPS) assert.equal(commitmentDetailsPayload({ confidence: c }).ok, true, String(c));
  });

  it('the keys are the ones 2764 and 2765 read', () => {
    const stageSql = sql('2764_trip_kernel_stage_family.sql');
    for (const k of ['starts_at', 'ends_at']) assert.ok(stageSql.includes(`(v_payload->>'${k}')::timestamptz`), k);
    const c = sql('2765_trip_kernel_leg_and_commitment_families.sql');
    const add = c.slice(c.indexOf("WHEN 'ADD_COMMITMENT' THEN\n"), c.indexOf("WHEN 'UPDATE_COMMITMENT' THEN\n"));
    for (const [k, cast] of [['starts_at', 'timestamptz'], ['required_arrival_at', 'timestamptz'], ['lateness_tolerance', 'interval'], ['prep_duration', 'interval'], ['confidence', 'numeric']]) {
      assert.ok(add.includes(`(v_payload->>'${k}')::${cast}`), `${k} is not read by ADD_COMMITMENT as ${cast}`);
    }
  });

  it('a served interval reads back in minutes; an unreadable one is null, never zero', () => {
    assert.equal(intervalMinutes('00:20:00'), 20);
    assert.equal(intervalMinutes('1 day 02:00:00'), 1560);
    assert.equal(intervalMinutes('00:00:00'), 0);
    assert.equal(intervalMinutes('00:00:30'), null);
    assert.equal(intervalMinutes('P20M'), null);
    assert.equal(intervalMinutes(null), null);
  });
});

describe('the composer\'s drafts: ready only when every field can be sent', () => {
  it('stage bounds: empty is ready with nothing; a typed pair in the stage zone is two instants; disagreement is the group\'s to say', () => {
    assert.deepEqual(stageBoundsDraft(EMPTY_STAGE_BOUNDS, 'Asia/Ho_Chi_Minh'), { ready: true, value: {}, problem: null, where: null });
    assert.deepEqual(stageBoundsDraft({ starts: t('2026-10-20', '14:00'), ends: t('2026-10-23', '11:00') }, 'Asia/Ho_Chi_Minh').value,
      { startsAt: '2026-10-20T14:00:00+07:00', endsAt: '2026-10-23T11:00:00+07:00' });
    const backwards = stageBoundsDraft({ starts: t('2026-10-23', '11:00'), ends: t('2026-10-20', '14:00') }, 'Asia/Ho_Chi_Minh');
    assert.deepEqual([backwards.ready, backwards.where], [false, 'group']);
    const skipped = stageBoundsDraft({ starts: t('2026-03-29', '01:30'), ends: t('', '') }, 'Europe/Lisbon');
    assert.deepEqual([skipped.ready, skipped.where], [false, 'field']);
    assert.equal(stageBoundsDraft({ starts: t('2026-10-25', '01:30', 'later'), ends: t('', '') }, 'Europe/Lisbon').value?.startsAt, '2026-10-25T01:30:00+00:00');
  });

  it('commitment details: typed times in the zone shown, minutes as whole numbers, arrival not after the start', () => {
    const ok = commitmentDetailsDraft({ starts: t('2026-10-02', '19:00'), arriveBy: t('2026-10-02', '18:45'), lateness: '5', prep: '20', confidence: 0.5 }, 'Asia/Ho_Chi_Minh');
    assert.deepEqual(ok.value, { startsAt: '2026-10-02T19:00:00+07:00', requiredArrivalAt: '2026-10-02T18:45:00+07:00', latenessMinutes: 5, prepMinutes: 20, confidence: 0.5 });
    assert.deepEqual(commitmentDetailsDraft(EMPTY_COMMITMENT_DETAILS, null), { ready: true, value: {}, problem: null, where: null });
    const late = commitmentDetailsDraft({ ...EMPTY_COMMITMENT_DETAILS, starts: t('2026-10-02', '19:00'), arriveBy: t('2026-10-02', '19:30') }, 'UTC');
    assert.deepEqual([late.ready, late.where], [false, 'group']);
    assert.match(late.problem!, /arrival time is after it starts/);
    const minutes = commitmentDetailsDraft({ ...EMPTY_COMMITMENT_DETAILS, prep: '1.5' }, 'UTC');
    assert.deepEqual([minutes.ready, minutes.where], [false, 'group']);
    const noZone = commitmentDetailsDraft({ ...EMPTY_COMMITMENT_DETAILS, starts: t('2026-10-02', '19:00') }, null);
    assert.deepEqual([noZone.ready, noZone.where], [false, 'field']);
  });

  it('a commitment\'s zone: its stage\'s, else the trip\'s, else the phone\'s only once chosen', () => {
    const stages = [{ id: S1, timezone: 'Asia/Tokyo' }];
    assert.deepEqual(commitmentZone(stages, S1, 'Asia/Manila', 'Europe/Berlin'), { zone: 'Asia/Tokyo', from: 'stage' });
    assert.deepEqual(commitmentZone(stages, null, 'Asia/Manila', 'Europe/Berlin'), { zone: 'Asia/Manila', from: 'trip' });
    assert.deepEqual(commitmentZone(stages, null, null, null), { zone: null, from: null });
    assert.deepEqual(commitmentZone(stages, null, '  ', 'Europe/Berlin'), { zone: 'Europe/Berlin', from: 'device' });
  });
});

describe('through tripStructureEntries: the product\'s ADD_STAGE / ADD_COMMITMENT carry them', () => {
  type Mod = typeof import('../tripStructureEntries.ts');
  let mod: Mod;
  let issued: TripCommandRequest[] = [];
  const okAnswer = (): TripCommandResult => ({ ok: true, duplicate: false, version: 3, eventId: 'e1', sequence: 3, result: { id: 'row' }, contractVersion: 2 });
  before(async () => { mod = await import('../tripStructureEntries.ts'); mod._setTestIssuer(async (_t, cmd) => { issued.push(cmd); return okAnswer(); }); });
  after(() => mod._setTestIssuer(null));
  beforeEach(() => { issued = []; });

  it('addStage sends the boundaries; addCommitment sends the §7.1 fields; with the caller\'s key', async () => {
    await mod.addStage('t1', { ...stage, startsAt: '2026-10-20T14:00:00+07:00', endsAt: '2026-10-23T11:00:00+07:00' }, 'k-s');
    await mod.addCommitment('t1', { type: 'event', flexibility: 'fixed', stageId: S1, startsAt: '2026-10-02T19:00:00+07:00', requiredArrivalAt: '2026-10-02T18:45:00+07:00', prepMinutes: 20, latenessMinutes: 5, confidence: 1 }, 'k-c');
    assert.deepEqual(issued.map((c) => [c.type, c.payload, c.idempotencyKey]), [
      ['ADD_STAGE', { stage_type: 'city', city_id: CITY, timezone: 'Asia/Ho_Chi_Minh', sequence: 1, starts_at: '2026-10-20T14:00:00+07:00', ends_at: '2026-10-23T11:00:00+07:00' }, 'k-s'],
      ['ADD_COMMITMENT', { type: 'event', flexibility: 'fixed', stage_id: S1, starts_at: '2026-10-02T19:00:00+07:00', required_arrival_at: '2026-10-02T18:45:00+07:00', lateness_tolerance: '5 minutes', prep_duration: '20 minutes', confidence: 1 }, 'k-c'],
    ]);
  });

  it('a local refusal is said in words and nothing is sent', async () => {
    const r = await mod.addCommitment('t1', { type: 'event', flexibility: 'fixed', stageId: null, startsAt: '2026-10-02T19:00:00+07:00', requiredArrivalAt: '2026-10-02T19:30:00+07:00' }, 'k');
    assert.deepEqual(r, { state: 'refused', reason: 'LOCAL_ARRIVAL_AFTER_START', detail: 'the arrival time is after it starts' });
    const s = await mod.addStage('t1', { ...stage, startsAt: '2026-10-23T11:00:00+07:00', endsAt: '2026-10-20T11:00:00+07:00' }, 'k');
    assert.deepEqual(s, { state: 'refused', reason: 'LOCAL_ENDS_BEFORE_START', detail: 'the stage would end before it starts' });
    assert.deepEqual(issued, []);
  });
});
