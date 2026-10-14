/**
 * layoverExperienceFacts — the one sentence a layover card may say about the
 * server's spec §9 ExperiencePrimitive (census-layover L75).
 *
 * ── WHAT WOULD TURN THIS RED ─────────────────────────────────────────────────
 *  * A TYPICAL NUMBER SPEAKING AS A FACT. The line must open "Typical for", and
 *    a descriptor that does not say it is a category default renders nothing.
 *  * REASSURANCE FROM A DEFAULT. Beside the kind and its length, only cautionary
 *    traits are said; "low energy", "easy to leave", "free", "no booking" never
 *    appear, whatever the descriptor holds.
 *  * A WEATHER CLAIM THE TYPE CANNOT MAKE. "weather-dependent" only for
 *    `fair_weather`; `unknown` (the server's answer for a museum, a mall, a spa)
 *    says nothing.
 *  * A KIND NOBODY KNOWS. `typeBasis: "unmapped"`, an unknown type, or
 *    unreadable minutes render nothing rather than a guess.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EXPERIENCE_KIND,
  TRAIT_BOOKING,
  TRAIT_HIGH_ENERGY,
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

test('1. a meal: kind, the typical range, and the one caution that applies — low energy is not a caution', () => {
  assert.equal(typicalExperienceLine(EAT), `Typical for a meal: 45m–1h 30m · ${TRAIT_HARD_TO_LEAVE}`);
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
  assert.equal(walk, `Typical for a walk: 45m–1h 30m · ${TRAIT_WEATHER}`);
  const learn = typicalExperienceLine({ ...EAT, type: 'LEARN', interruptibility: 'low', reservationRequirement: 'required' });
  assert.equal(learn, `Typical for a class or tour: 45m–1h 30m · ${TRAIT_HARD_TO_LEAVE} · ${TRAIT_BOOKING}`);
  const night = typicalExperienceLine({ ...EAT, type: 'NIGHTLIFE', energyCost: 'high', interruptibility: 'medium' });
  assert.equal(night, `Typical for a night out: 45m–1h 30m · ${TRAIT_HIGH_ENERGY}`);
  const indoorsNoBooking = typicalExperienceLine({ ...EAT, interruptibility: 'medium', weatherCompatibility: 'all_weather', reservationRequirement: 'not_required' });
  assert.equal(indoorsNoBooking, 'Typical for a meal: 45m–1h 30m');
});

test('4. never reassurance, never a price: no "low"/"medium" energy, "easy", "free", "no booking" or cost band, whatever is sent', () => {
  for (const interruptibility of ['low', 'medium', 'high']) {
    for (const reservationRequirement of ['required', 'not_required', 'unknown']) {
      for (const costRange of ['free', 'low', 'medium', 'high', null]) {
        for (const energyCost of ['low', 'medium', 'high']) {
          const line = typicalExperienceLine({ ...EAT, interruptibility, reservationRequirement, costRange, energyCost } as ExperienceWire) ?? '';
          assert.ok(!/easy|free|no booking|not required|cheap|\$|price|cost|low energy|medium energy/i.test(line), line);
          assert.equal(line.includes(TRAIT_HIGH_ENERGY), energyCost === 'high', line);
        }
      }
    }
  }
});

test('4b. weather: said for fair_weather only — unknown and all_weather say nothing about weather', () => {
  for (const weatherCompatibility of ['all_weather', 'fair_weather', 'unknown', undefined, 'sunny']) {
    for (const type of ['REST', 'EXPLORE', 'WALK', 'PHOTO', 'EAT']) {
      const line = typicalExperienceLine({ ...EAT, type, weatherCompatibility }) ?? '';
      assert.equal(/weather/i.test(line), weatherCompatibility === 'fair_weather', `${type}/${weatherCompatibility}: ${line}`);
      assert.equal(/weather/i.test(typicalExperienceA11y(line)), weatherCompatibility === 'fair_weather', `${type}/${weatherCompatibility}`);
    }
  }
  // What the server sends for a museum (EXPLORE) and a spa (REST) on a landside card.
  assert.equal(typicalExperienceLine({ ...EAT, type: 'EXPLORE', interruptibility: 'high', energyCost: 'medium', weatherCompatibility: 'unknown', weatherBasis: 'venue_dependent' } as ExperienceWire), 'Typical for exploring: 45m–1h 30m');
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
  assert.equal(typicalExperienceLine({ ...EAT, minDuration: 60, idealDuration: 60, interruptibility: 'high' }), 'Typical for a meal: 1h');
  assert.equal(typicalExperienceLine({ ...EAT, energyCost: 'extreme', interruptibility: 'high' }), 'Typical for a meal: 45m–1h 30m');
});

test('7. the screen reader hears the caveat the eye gets from "Typical"', () => {
  const line = typicalExperienceLine(EAT)!;
  assert.equal(typicalExperienceA11y(line), `${line}. Typical for this kind of place, not measured for this one.`);
});
