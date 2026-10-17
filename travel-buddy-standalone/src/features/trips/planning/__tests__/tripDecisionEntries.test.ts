/**
 * census-trips TR85 / TR86 — the product's writer for decision tasks and risks
 * is a kernel command, never a table write, in 2762's vocabularies.
 * Run: node --import tsx/esm --test src/features/trips/planning/__tests__/tripDecisionEntries.test.ts
 */
import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

type Mod = typeof import('../tripDecisionEntries.ts');
let mod: Mod;
type Issued = { tripId: string; cmd: { type: string; payload?: Record<string, unknown>; idempotencyKey: string } };
let issued: Issued[] = [];
let answer: () => unknown = () => ({ ok: true, duplicate: false, version: 3, eventId: 'e1', sequence: 3, result: { id: 'x' }, contractVersion: 2 });

describe('decision tasks and risks, added through the kernel', () => {
  before(async () => {
    mod = await import('../tripDecisionEntries.ts');
    mod._setTestIssuer(async (tripId, cmd) => { issued.push({ tripId, cmd }); return answer() as any; });
  });
  after(() => mod._setTestIssuer(null));
  beforeEach(() => {
    issued = [];
    answer = () => ({ ok: true, duplicate: false, version: 3, eventId: 'e1', sequence: 3, result: { id: 'x' }, contractVersion: 2 });
  });

  it('a decision task is ADD_DECISION_TASK { type, consequence } with the caller\'s key; an empty consequence is not sent', async () => {
    assert.deepEqual(await mod.addDecisionTask('t1', { type: 'booking', consequence: '  the fare doubles  ' }, 'k1'), { state: 'recorded', duplicate: false });
    await mod.addDecisionTask('t1', { type: 'payment', consequence: '   ' }, 'k2');
    assert.deepEqual(issued, [
      { tripId: 't1', cmd: { type: 'ADD_DECISION_TASK', payload: { type: 'booking', consequence: 'the fare doubles' }, idempotencyKey: 'k1' } },
      { tripId: 't1', cmd: { type: 'ADD_DECISION_TASK', payload: { type: 'payment' }, idempotencyKey: 'k2' } },
    ]);
  });

  it('a risk is ADD_RISK { likelihood, impact, trigger_json? }', async () => {
    await mod.addRisk('t1', { likelihood: 'high', impact: 'medium', note: 'rail strike' }, 'r1');
    await mod.addRisk('t1', { likelihood: 'low', impact: 'low' }, 'r2');
    assert.deepEqual(issued.map((i) => [i.cmd.type, i.cmd.payload, i.cmd.idempotencyKey]), [
      ['ADD_RISK', { likelihood: 'high', impact: 'medium', trigger_json: { description: 'rail strike' } }, 'r1'],
      ['ADD_RISK', { likelihood: 'low', impact: 'low' }, 'r2'],
    ]);
  });

  it('the vocabularies are 2762\'s CHECKs, and a value outside them is refused locally — nothing is sent', async () => {
    assert.deepEqual([...mod.DECISION_TASK_TYPES], ['booking', 'transport', 'lodging', 'document', 'payment', 'logistics', 'other']);
    assert.deepEqual([...mod.RISK_LEVELS], ['low', 'medium', 'high']);
    assert.equal((await mod.addDecisionTask('t1', { type: 'vibes' }, 'k')).state, 'refused');
    assert.equal((await mod.addRisk('t1', { likelihood: 'certain', impact: 'low' }, 'k')).state, 'refused');
    assert.equal((await mod.addRisk('t1', { likelihood: 'low', impact: '' }, 'k')).state, 'refused');
    assert.deepEqual(issued, []);
  });

  it('free text is bounded so a paste cannot become a kernel refusal', async () => {
    await mod.addDecisionTask('t1', { type: 'other', consequence: 'x'.repeat(500) }, 'k');
    assert.equal(String(issued[0]!.cmd.payload!.consequence).length, mod.ENTRY_TEXT_MAX);
  });

  it('a refusal is carried by name; an unreachable kernel is unavailable — never "refused"', async () => {
    answer = () => ({ ok: false, kind: 'refused', status: 403, reason: 'TRIP_AUTH_NOT_CREW', detail: null, currentVersion: null, expectedVersion: null });
    assert.deepEqual(await mod.addRisk('t1', { likelihood: 'low', impact: 'low' }, 'k'), { state: 'refused', reason: 'TRIP_AUTH_NOT_CREW', detail: 'only the trip crew can add to this trip' });
    answer = () => ({ ok: false, kind: 'unavailable', detail: 'network error' });
    assert.deepEqual(await mod.addDecisionTask('t1', { type: 'booking' }, 'k'), { state: 'unavailable', detail: 'network error' });
  });

  it('every tap is a new intent: keys differ, so a second task is not answered with the first one\'s receipt', () => {
    const a = mod.entryKey('task');
    const b = mod.entryKey('task');
    assert.notEqual(a, b);
    assert.match(a, /^decision-entry:task:/);
    assert.match(mod.entryKey('risk'), /^decision-entry:risk:/);
  });
});
