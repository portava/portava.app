/**
 * §37 — an unattributed claim must not borrow a traveller's credibility.
 *
 * DecisionExposureChips built every claim with
 *
 *     sourceClass: (dto.sourceClass as SourceClass) ?? 'firsthand_unverified'
 *
 * so a claim the wire did not attribute — a sponsored one whose class was
 * dropped in transit, or a class this build does not recognise — rendered on
 * the Place Living sheet as a FIRSTHAND TRAVELLER OBSERVATION. The `as` cast
 * also let an unrecognised value through unchecked and straight into a label
 * lookup.
 *
 * That is the same §37 violation the server side closed one commit earlier
 * ("A few recent traveler reports"), reached by a different route: there the
 * bucket was non-nullable, here the class was defaulted.
 *
 * The rule these pin: when we do not know who is speaking, we say so. We do
 * not guess, and we do not fall back to the most credible option — which is
 * what a default of `firsthand_unverified` was.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { sourceLabel, observedVerb, liveState, type LiveIntelClaim } from '../display.ts';
import { SOURCE_CLASS_LABELS, type SourceClass } from '../contracts.ts';

function claim(over: Partial<LiveIntelClaim> = {}): LiveIntelClaim {
  return {
    claimType: 'crowd.level',
    value: { level: 'busy' },
    band: 'live',
    confidence: 0.9,
    sourceClass: 'firsthand_unverified',
    sourceCountBucket: 'few',
    serverState: 'live',
    observedAt: new Date().toISOString(),
    validUntil: null,
    ...over,
  } as LiveIntelClaim;
}

test('an unattributed claim is not labelled as a traveller report', () => {
  const label = sourceLabel(null);
  assert.equal(label, 'Source not attributed');
  // The specific regression: it must not be the firsthand string.
  assert.notEqual(label, SOURCE_CLASS_LABELS.firsthand_unverified);
  // Nor any other class's label — silence is not the same as picking one.
  for (const [cls, text] of Object.entries(SOURCE_CLASS_LABELS)) {
    assert.notEqual(label, text, `unattributed must not read as ${cls}`);
  }
});

test('an unrecognised class is not labelled as a traveller report either', () => {
  // A class this build does not know about — a newer server, a corrupted
  // payload. The old `as SourceClass` cast sent this straight into the lookup.
  const label = sourceLabel('some_future_class' as SourceClass);
  assert.equal(label, 'Source not attributed');
  assert.notEqual(label, SOURCE_CLASS_LABELS.firsthand_unverified);
});

test('every real class still renders its own label — the fix is not a blanket', () => {
  for (const cls of Object.keys(SOURCE_CLASS_LABELS) as SourceClass[]) {
    assert.equal(sourceLabel(cls), SOURCE_CLASS_LABELS[cls]);
  }
});

test('an unattributed claim gets the neutral verb, not "Checked"', () => {
  // "Checked" asserts somebody went and looked. That is the claim we cannot
  // support without knowing who spoke.
  assert.equal(observedVerb(null), 'As of');
  assert.equal(observedVerb('verified_firsthand'), 'Checked');
});

test('an unattributed claim is NOT live, however strong its band', () => {
  // Fails toward `typical`, the same direction a forecast falls. A claim with
  // band "live" and serverState "live" still is not live if nobody owns it.
  assert.equal(liveState(claim({ sourceClass: null })), 'typical');
  // Control: the identical claim WITH an attribution is live, so this test
  // cannot pass by the claim being unusable for some other reason.
  assert.equal(liveState(claim({ sourceClass: 'firsthand_unverified' })), 'live');
});
