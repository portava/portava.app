/**
 * layoverExperienceFacts — the one sentence a layover card may say about the
 * server's spec §9 ExperiencePrimitive (census-layover L75).
 *
 * ── WHAT WOULD TURN THIS RED ─────────────────────────────────────────────────
 *  * A TYPICAL NUMBER SPEAKING AS A FACT. The line must open "Typical for", and
 *    a descriptor that does not say it is a category default renders nothing.
 *  * REASSURANCE FROM A DEFAULT. Only cautionary traits are said; "easy to
 *    leave", "free", "no booking" never appear, whatever the descriptor holds.
 *  * A KIND NOBODY KNOWS. `typeBasis: "unmapped"`, an unknown type, or
 *    unreadable minutes render nothing rather than a guess.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EXPERIENCE_KIND,
  TRAIT_BOOKING,
  TRAIT_HARD_TO_LEAVE,
  TRAIT_WEATHER,
  typicalExperienceA11y,
  typicalExperienceLine,
  type ExperienceWire,
} from '../layoverExperienceFacts.ts';

/** What the server sends for a `food` card (Trips' EAT defaults). */
const EAT: ExperienceWire = {
  type: 'EAT', minDuration: 45, idealDuration: 90, compressibility: 0.5, interruptibility: 'low',
  reversibility: 'partially_reversible', costRange: 'medium', energyCost: 'low',
  weatherCompatibility: 'all_weather', reservationRequirement: 'unknown',
  source: 'category_default', typeBasis: 'rec_type', weatherBasis: 'category_default',
} as ExperienceWire;

test('1. a meal: kind, the typical range, energy, and the one caution that applies', () => {
  assert.equal(typicalExperienceLine(EAT), `Typical for a meal: 45m–1h 30m · low energy · ${TRAIT_HARD_TO_LEAVE}`);
});

test('2. every one of the thirteen kinds has words, and the line always opens "Typical for"', () => {
  const thirteen = ['EAT', 'SEE', 'MEET', 'DRINK', 'SHOP', 'WALK', 'REST', 'PHOTO', 'EXPLORE', 'PLAY', 'LEARN', 'NIGHTLIFE', 'TRANSIT'];
  assert.deepEqual(Object.keys(EXPERIENCE_KIND), thirteen);
  for (const type of thirteen) {
    const line = typicalExperienceLine({ ...EAT, type });
    assert.ok(line && line.startsWith(`Typical for ${EXPERIENCE_KIND[type]}: `), `${type}: ${line}`);
  }
});

test('3. the cautions appear exactly when the descriptor carries them', () => {
  const walk = typicalExperienceLine({ ...EAT, type: 'WALK', interruptibility: 'high', weatherCompatibility: 'fair_weather', reservationRequirement: 'not_required' });
  assert.equal(walk, `Typical for a walk: 45m–1h 30m · low energy · ${TRAIT_WEATHER}`);
  const learn = typicalExperienceLine({ ...EAT, type: 'LEARN', interruptibility: 'low', reservationRequirement: 'required' });
  assert.equal(learn, `Typical for a class or tour: 45m–1h 30m · low energy · ${TRAIT_HARD_TO_LEAVE} · ${TRAIT_BOOKING}`);
  const indoorsNoBooking = typicalExperienceLine({ ...EAT, interruptibility: 'medium', weatherCompatibility: 'all_weather', reservationRequirement: 'not_required' });
  assert.equal(indoorsNoBooking, 'Typical for a meal: 45m–1h 30m · low energy');
});

test('4. never reassurance, never a price: no "easy", "free", "no booking" or cost band, whatever is sent', () => {
  for (const interruptibility of ['low', 'medium', 'high']) {
    for (const reservationRequirement of ['required', 'not_required', 'unknown']) {
      for (const costRange of ['free', 'low', 'medium', 'high', null]) {
        const line = typicalExperienceLine({ ...EAT, interruptibility, reservationRequirement, costRange } as ExperienceWire) ?? '';
        assert.ok(!/easy|free|no booking|not required|cheap|\$|price|cost/i.test(line), line);
      }
    }
  }
});

test('5. nothing honest to say → null: no descriptor, not a category default, unmapped, unknown kind, unreadable minutes', () => {
  assert.equal(typicalExperienceLine(undefined), null);
  assert.equal(typicalExperienceLine(null), null);
  assert.equal(typicalExperienceLine({ ...EAT, source: 'measured' }), null, 'only a descriptor that says it is typical is rendered as typical');
  assert.equal(typicalExperienceLine({ ...EAT, source: undefined }), null);
  assert.equal(typicalExperienceLine({ ...EAT, type: 'EXPLORE', typeBasis: 'unmapped' }), null, 'a typical profile for an unknown kind');
  assert.equal(typicalExperienceLine({ ...EAT, type: 'SKYDIVE' }), null);
  assert.equal(typicalExperienceLine({ ...EAT, minDuration: null }), null);
  assert.equal(typicalExperienceLine({ ...EAT, minDuration: 0 }), null);
  assert.equal(typicalExperienceLine({ ...EAT, idealDuration: Number.NaN }), null);
  assert.equal(typicalExperienceLine({ ...EAT, minDuration: 120, idealDuration: 60 }), null);
});

test('6. a single typical length is said once; an unreadable energy is left out, not guessed', () => {
  assert.equal(typicalExperienceLine({ ...EAT, minDuration: 60, idealDuration: 60, interruptibility: 'high' }), 'Typical for a meal: 1h · low energy');
  assert.equal(typicalExperienceLine({ ...EAT, energyCost: 'extreme', interruptibility: 'high' }), 'Typical for a meal: 45m–1h 30m');
});

test('7. the screen reader hears the caveat the eye gets from "Typical"', () => {
  const line = typicalExperienceLine(EAT)!;
  assert.equal(typicalExperienceA11y(line), `${line}. Typical for this kind of place, not measured for this one.`);
});
