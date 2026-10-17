/**
 * census-trips TR154 (§9.3 decisionRule; populates TR88): the product creates a
 * proposal with the rule the proposer chose, straight through the unflagged
 * command door — not through /replan, which skips it with the kernel flag off —
 * and offers only proposal types whose acceptance changes nothing by itself.
 * Run: node --import tsx/esm --test src/features/trips/planning/__tests__/tripProposals.test.ts
 */
import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type { TripCommandRequest, TripCommandResult } from '../../../../services/tripCommands.ts';
import { proposalCommand, DECISION_RULES, OFFERED_PROPOSAL_TYPES, PROPOSAL_TITLE_MAX } from '../tripProposalPayloads.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..', '..', '..', '..');
const sql = (file: string) => readFileSync(join(REPO, 'artifacts', 'api-server', 'src', 'migrations', file), 'utf8');
const inList = (text: string, constraint: string) => {
  const at = text.indexOf(constraint);
  const m = /IN\s*\(([^)]*)\)/.exec(text.slice(at));
  return m![1]!.split(',').map((v) => v.trim().replace(/^'|'$/g, ''));
};

describe('CREATE_PROPOSAL as the product builds it', () => {
  it('carries the type, the CHOSEN rule, and the ballot\'s title; the §9.3 fields under their canonical keys, only when given', () => {
    assert.deepEqual(proposalCommand({ proposalType: 'stage_change', decisionRule: 'majority', title: '  Leave Hoi An a day early ', rationale: 'the storm', impactSummary: 'one night less in Hoi An' }), {
      ok: true, type: 'CREATE_PROPOSAL',
      payload: { proposal_type: 'stage_change', decision_rule: 'majority', payload_json: { title: 'Leave Hoi An a day early', rationale: 'the storm', impact_summary: 'one night less in Hoi An' } },
    });
    assert.deepEqual(proposalCommand({ proposalType: 'other', decisionRule: 'host', title: 'Pool day', rationale: '  ', impactSummary: null }), {
      ok: true, type: 'CREATE_PROPOSAL', payload: { proposal_type: 'other', decision_rule: 'host', payload_json: { title: 'Pool day' } },
    });
  });

  it('refuses locally what the door or the kernel would, and anything not offered', () => {
    const r = (over: Record<string, unknown>) => {
      const c = proposalCommand({ proposalType: 'other', decisionRule: 'host', title: 'x', ...over } as never);
      return c.ok ? 'sent' : c.reason;
    };
    assert.deepEqual(
      [r({ proposalType: 'move_plan' }), r({ proposalType: 'add_plan' }), r({ decisionRule: 'dictator' }), r({ title: '   ' }), r({ title: 'x'.repeat(PROPOSAL_TITLE_MAX + 1) }), r({ rationale: 'y'.repeat(501) })],
      ['LOCAL_INVALID', 'LOCAL_INVALID', 'LOCAL_INVALID', 'LOCAL_NO_TITLE', 'LOCAL_TOO_LONG', 'LOCAL_TOO_LONG'],
    );
  });

  it('the rules are 2774\'s CHECK; the offered types are 2763\'s and none is one 2775 applies to the plan', () => {
    assert.deepEqual([...DECISION_RULES], inList(sql('2774_trip_proposal_governance.sql'), 'trip_proposals_decision_rule_known'));
    const types = inList(sql('2763_trip_presence_proposals_snapshots_outcomes.sql'), 'trip_proposals_type_known');
    for (const t of OFFERED_PROPOSAL_TYPES) assert.ok(types.includes(t), `${t} is not a 2763 type`);
    const apply = sql('2775_trip_kernel_proposal_governance_and_apply.sql');
    assert.ok(apply.includes("IF v_role = 'add_plan' THEN") && apply.includes("ELSIF v_role IN ('move_plan', 'cancel_plan') THEN"));
    assert.ok(apply.includes("'PROPOSAL_TYPE_HAS_NO_CANONICAL_EFFECT'"));
    for (const t of OFFERED_PROPOSAL_TYPES) assert.ok(!['add_plan', 'move_plan', 'cancel_plan'].includes(t), `${t} would write the plan on acceptance`);
  });

  it('the keys are the ones 2768/2775 read, and CREATE_PROPOSAL is issued by the unflagged endpoint and the client', () => {
    const create = sql('2768_trip_kernel_presence_proposal_outcome_families.sql');
    assert.ok(create.includes("v_payload->>'proposal_type'") && create.includes("coalesce(v_payload->'payload_json', '{}'::jsonb)"));
    assert.ok(sql('2775_trip_kernel_proposal_governance_and_apply.sql').includes("coalesce(v_payload->>'decision_rule', 'host'))"));
    const route = readFileSync(join(REPO, 'artifacts', 'api-server', 'src', 'server', 'trips', 'commandRoute.ts'), 'utf8');
    assert.ok(route.slice(route.indexOf('export const COMMANDS_ENDPOINT_TYPES'), route.indexOf('const ISSUABLE')).includes('"CREATE_PROPOSAL"'));
    assert.ok(readFileSync(join(HERE, '..', '..', '..', '..', 'services', 'tripCommands.ts'), 'utf8').includes("'CREATE_PROPOSAL'"));
  });
});

describe('mounted', () => {
  it('the votes card mounts the composer in both of its read states, and the trip screen mounts the votes card', () => {
    const card = readFileSync(join(HERE, '..', 'TripBallotsCard.tsx'), 'utf8');
    assert.equal(card.match(/<TripProposalComposer key="proposal-composer" tripId=\{tripId\} propose=\{propose\} onProposed=\{\(\) => void rereadAfterProposal\(\)\} \/>/g)?.length, 2);
    const screen = readFileSync(join(HERE, '..', '..', '..', '..', '..', 'app', 'trip', '[id].tsx'), 'utf8');
    assert.match(screen, /\{live && trip\.id \? <TripBallotsCard tripId=\{trip\.id\} isOwner=\{realTrip\.ownerId === userId\} \/> : null\}/);
  });
});

describe('through tripProposals', () => {
  type Mod = typeof import('../tripProposals.ts');
  let mod: Mod;
  let issued: TripCommandRequest[] = [];
  let answer: () => TripCommandResult;
  before(async () => { mod = await import('../tripProposals.ts'); mod._setTestIssuer(async (_t, cmd) => { issued.push(cmd); return answer(); }); });
  after(() => mod._setTestIssuer(null));
  beforeEach(() => { issued = []; answer = () => ({ ok: true, duplicate: false, version: 6, eventId: 'e', sequence: 6, result: { id: 'prop-1' }, contractVersion: 2 }); });

  it('sends CREATE_PROPOSAL with the caller\'s key and returns the new id; refusals in words; nothing sent for a local refusal', async () => {
    assert.deepEqual(await mod.createProposal('t1', { proposalType: 'other', decisionRule: 'anyone', title: 'Pool day' }, 'k1'), { state: 'recorded', duplicate: false, id: 'prop-1' });
    assert.deepEqual(issued, [{ type: 'CREATE_PROPOSAL', payload: { proposal_type: 'other', decision_rule: 'anyone', payload_json: { title: 'Pool day' } }, idempotencyKey: 'k1' }]);
    answer = () => ({ ok: false, kind: 'refused', status: 403, reason: 'trust_restriction', detail: 'You cannot propose changes on this trip right now.', currentVersion: null, expectedVersion: null });
    assert.deepEqual(await mod.createProposal('t1', { proposalType: 'other', decisionRule: 'host', title: 'x' }, 'k2'), { state: 'refused', reason: 'trust_restriction', detail: 'You cannot propose changes on this trip right now.' });
    answer = () => ({ ok: false, kind: 'unavailable', detail: 'kernel unavailable' });
    assert.deepEqual(await mod.createProposal('t1', { proposalType: 'other', decisionRule: 'host', title: 'x' }, 'k3'), { state: 'unavailable', detail: 'kernel unavailable' });
    issued = [];
    assert.deepEqual(await mod.createProposal('t1', { proposalType: 'other', decisionRule: 'host', title: ' ' }, 'k4'), { state: 'refused', reason: 'LOCAL_NO_TITLE', detail: 'say what you are proposing' });
    assert.deepEqual(issued, []);
    assert.match(mod.proposalKey(), /^proposal:create:/);
  });
});
