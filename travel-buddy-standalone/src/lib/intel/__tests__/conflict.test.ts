/**
 * §10 material conflict on the client (IG unit I2, AT-07).
 *
 * The server serves `conflictState` on every live-claim envelope. The client's
 * job is small and must be exact: a 'material' claim is never rendered as
 * Live, it is labelled "Reports differ" wherever a Live label would have
 * rendered, and the contradiction-resolution re-ask is offered ONLY where a
 * prompt may be shown at all.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeConflictState,
  resolveConflictReask,
  conflictExplanation,
  CONFLICT_LABEL,
  CONFLICT_REASK_CONTEXT,
} from '../conflict.ts';
import { liveState, liveStateLabel, liveStateColor, type LiveIntelClaim } from '../display.ts';
import { color } from '../../../theme/tokens.ts';

function claim(over: Partial<LiveIntelClaim> = {}): LiveIntelClaim {
  return {
    claimType: 'crowd.level',
    value: { level: 'packed' },
    band: 'strong',
    confidence: 0.92,
    sourceClass: 'firsthand_unverified',
    sourceCountBucket: 'few',
    serverState: 'live',
    observedAt: new Date().toISOString(),
    validUntil: null,
    ...over,
  } as LiveIntelClaim;
}

test('normalizeConflictState mirrors the server: NULL ⇒ none, contextualized ⇒ minor, unknown ⇒ material', () => {
  assert.equal(normalizeConflictState(null), 'none');
  assert.equal(normalizeConflictState(undefined), 'none');
  assert.equal(normalizeConflictState(''), 'none');
  assert.equal(normalizeConflictState('none'), 'none');
  assert.equal(normalizeConflictState('minor'), 'minor');
  assert.equal(normalizeConflictState('contextualized'), 'minor');
  assert.equal(normalizeConflictState('material'), 'material');
  assert.equal(normalizeConflictState('MATERIAL'), 'material');
  assert.equal(normalizeConflictState('something-else'), 'material');
  assert.equal(normalizeConflictState(42), 'material');
});

test('a material claim is never Live — even when the server state and band say so', () => {
  // Control: the same claim without a conflict IS live.
  assert.equal(liveState(claim()), 'live');
  // Material ⇒ capped to emerging (the value is shown WITH the label, not hidden).
  assert.equal(liveState(claim({ conflictState: 'material' })), 'emerging');
  // Band-derived path (no server state) caps the same way.
  assert.equal(liveState(claim({ serverState: null, conflictState: 'material' })), 'emerging');
  assert.equal(liveState(claim({ serverState: null })), 'live');
  // Minor / none do not cap.
  assert.equal(liveState(claim({ conflictState: 'minor' })), 'live');
  assert.equal(liveState(claim({ conflictState: 'none' })), 'live');
  // It never RAISES: an expired or unattributed claim stays where it was.
  assert.equal(liveState(claim({ conflictState: 'material', validUntil: new Date(Date.now() - 1000).toISOString() })), 'unknown');
  assert.equal(liveState(claim({ conflictState: 'material', sourceClass: null })), 'typical');
});

test('"Reports differ" replaces the Live/Observed label under a material conflict only', () => {
  assert.equal(liveStateLabel('live', 'material'), CONFLICT_LABEL);
  assert.equal(liveStateLabel('emerging', 'material'), CONFLICT_LABEL);
  assert.equal(liveStateLabel('live', 'minor'), 'Live');
  assert.equal(liveStateLabel('live', 'none'), 'Live');
  assert.equal(liveStateLabel('live'), 'Live');
  assert.equal(liveStateLabel('emerging'), 'Observed');
  // Typical/Unknown never carry a Live label, so nothing to replace.
  assert.equal(liveStateLabel('typical', 'material'), 'Typical');
  assert.equal(liveStateLabel('unknown', 'material'), 'Unknown');
  assert.equal(CONFLICT_LABEL, 'Reports differ');
});

test('the conflict colour is neither Live vermilion nor emerging teal', () => {
  assert.equal(liveStateColor('live', 'material'), color.warn);
  assert.equal(liveStateColor('emerging', 'material'), color.warn);
  assert.equal(liveStateColor('live'), color.signal);
  assert.equal(liveStateColor('live', 'minor'), color.signal);
  assert.equal(liveStateColor('emerging'), color.deep);
});

test('the re-ask is offered only for a material claim in a re-askable family, and only when a prompt may show', () => {
  const material = [{ claimType: 'crowd.level', conflictState: 'material' as const }];
  assert.deepEqual(resolveConflictReask(material, true), { claimType: 'crowd.level', context: 'arrival', reason: 'conflict' });
  // Suppressed (flag off / Safe Return / paused) ⇒ nothing, whatever the conflict.
  assert.equal(resolveConflictReask(material, false), null);
  // No material conflict ⇒ nothing.
  assert.equal(resolveConflictReask([{ claimType: 'crowd.level', conflictState: 'minor' }], true), null);
  assert.equal(resolveConflictReask([{ claimType: 'crowd.level' }], true), null);
  assert.equal(resolveConflictReask([], true), null);
  // A family with no §6 context is labelled but not re-asked.
  assert.equal(resolveConflictReask([{ claimType: 'access.walk_in', conflictState: 'material' }], true), null);
  // Families map to their own context — the SAME question the conflict is about.
  assert.equal(resolveConflictReask([{ claimType: 'crowd.trajectory', conflictState: 'material' }], true)?.context, 'inside');
  assert.equal(resolveConflictReask([{ claimType: 'queue.wait', conflictState: 'material' }], true)?.context, 'entrance');
  assert.deepEqual(Object.keys(CONFLICT_REASK_CONTEXT).sort(), ['crowd.level', 'crowd.trajectory', 'queue.wait']);
  // Served order wins: the first re-askable material claim.
  const many = [
    { claimType: 'access.walk_in', conflictState: 'material' as const },
    { claimType: 'queue.wait', conflictState: 'material' as const },
    { claimType: 'crowd.level', conflictState: 'material' as const },
  ];
  assert.equal(resolveConflictReask(many, true)?.claimType, 'queue.wait');
});

test('the explanation exists for material and minor, and is silent for none', () => {
  assert.ok(conflictExplanation('material')?.includes('disagree'));
  assert.ok(conflictExplanation('minor'));
  assert.equal(conflictExplanation('none'), null);
});
