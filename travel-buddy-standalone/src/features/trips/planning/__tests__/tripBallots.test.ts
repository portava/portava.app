/**
 * TRIP-F15 on the client — ballots are kernel commands, never table writes.
 * Run: node --import tsx/esm --test src/features/trips/planning/__tests__/tripBallots.test.ts
 */
import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

type Mod = typeof import('../tripBallots.ts');
let mod: Mod;
type Issued = { tripId: string; cmd: { type: string; payload?: Record<string, unknown>; idempotencyKey: string } };
let issued: Issued[] = [];
let answer: () => unknown = () => ({ ok: true, duplicate: false, version: 7, eventId: 'e1', sequence: 7, result: {}, contractVersion: 2 });

const proposal = (over: Record<string, unknown> = {}) => ({
  id: 'p1', type: 'change_plan', status: 'pending', decisionRule: 'majority', proposedBy: 'u2', expiresAt: null,
  payload: { title: 'Move dinner to 8pm' }, tally: { found: true, decision_rule: 'majority', electorate: 3, yes: 1, no: 0, abstain: 0, cast: 1, majority_met: false }, myVote: null, ...over,
});

describe('ballots', () => {
  before(async () => {
    mod = await import('../tripBallots.ts');
    mod._setTestIssuer(async (tripId, cmd) => { issued.push({ tripId, cmd }); return answer() as any; });
  });
  after(() => mod._setTestIssuer(null));
  beforeEach(() => { issued = []; });

  it('a vote is VOTE_ON_PROPOSAL { proposal_id, vote } through the kernel, with the caller\'s intent key', async () => {
    const r = await mod.castBallot('t1', 'p1', 'yes', 'ballot:p1:yes:k1');
    assert.deepEqual(r, { state: 'recorded', duplicate: false });
    assert.deepEqual(issued, [{ tripId: 't1', cmd: { type: 'VOTE_ON_PROPOSAL', payload: { proposal_id: 'p1', vote: 'yes' }, idempotencyKey: 'ballot:p1:yes:k1' } }]);
  });

  it('a changed vote is a NEW intent: the two keys differ, so the kernel\'s receipt cannot answer the second with the first', () => {
    const a = mod.ballotKey('p1', 'yes');
    const b = mod.ballotKey('p1', 'no');
    const c = mod.ballotKey('p1', 'yes');
    assert.notEqual(a, b);
    assert.notEqual(a, c, 'voting yes again after no is a new intent, not a replay of the first yes');
    assert.match(a, /^ballot:p1:yes:/);
  });

  it('a refusal is carried by name, and an unreachable kernel is unavailable — never "your vote was rejected"', async () => {
    answer = () => ({ ok: false, kind: 'refused', status: 409, reason: 'TRIP_PROPOSAL_NOT_PENDING', detail: null, currentVersion: null, expectedVersion: null });
    assert.deepEqual(await mod.castBallot('t1', 'p1', 'no', 'k'), { state: 'refused', reason: 'TRIP_PROPOSAL_NOT_PENDING', detail: 'this vote has already been decided' });
    answer = () => ({ ok: false, kind: 'unavailable', detail: 'network error' });
    assert.deepEqual(await mod.castBallot('t1', 'p1', 'no', 'k'), { state: 'unavailable', detail: 'network error' });
  });

  it('accept and reject are ACCEPT_PROPOSAL / REJECT_PROPOSAL { proposal_id } — the kernel applies the rule', async () => {
    answer = () => ({ ok: true, duplicate: true, version: 8, eventId: null, sequence: null, result: {}, contractVersion: 2 });
    assert.deepEqual(await mod.decideProposal('t1', 'p1', 'accept', 'k1'), { state: 'recorded', duplicate: true });
    await mod.decideProposal('t1', 'p1', 'reject', 'k2');
    assert.deepEqual(issued.map((i) => [i.cmd.type, i.cmd.payload]), [['ACCEPT_PROPOSAL', { proposal_id: 'p1' }], ['REJECT_PROPOSAL', { proposal_id: 'p1' }]]);
  });

  it('only PENDING proposals are open ballots; a decided one is shown as decided, not voteable', () => {
    const board = { proposals: [proposal(), proposal({ id: 'p2', status: 'accepted' }), proposal({ id: 'p3', status: 'pending' })] };
    assert.deepEqual(mod.openBallots(board as any).map((p) => p.id), ['p1', 'p3']);
  });

  it('who is offered accept / reject: the owner always; others only under ANYONE, or when the vote has carried', () => {
    assert.equal(mod.canOfferDecision(proposal() as any, true), true);
    assert.equal(mod.canOfferDecision(proposal() as any, false), false);
    assert.equal(mod.canOfferDecision(proposal({ decisionRule: 'anyone' }) as any, false), true);
    assert.equal(mod.canOfferDecision(proposal({ tally: { found: true, majority_met: true } }) as any, false), true);
    // A tally that could not be computed does not license anything.
    assert.equal(mod.canOfferDecision(proposal({ tally: null }) as any, false), false);
  });

  it('describes a proposal from its payload without inventing one', () => {
    assert.equal(mod.proposalTitle(proposal() as any), 'Move dinner to 8pm');
    assert.equal(mod.proposalTitle(proposal({ payload: {} }) as any), 'Change plan');
    assert.equal(mod.tallyLine(proposal() as any), '1 yes · 0 no · 0 abstain — 1 of 3 voted');
    assert.equal(mod.tallyLine(proposal({ tally: null }) as any), "We couldn't count the votes");
  });
});
