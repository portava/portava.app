/**
 * mediaPrivacy — the composer's privacy words are derived from one disclosure
 * table and never promise more than it says (census-media MD321 §22). The
 * table's agreement with the SERVER is proved separately, on the server side:
 * artifacts/api-server/src/test/mediaPrivacyClientParity.test.ts.
 *
 * Run: node --import tsx --test src/services/media/__tests__/mediaPrivacy.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPOSER_LOCATION_MODES,
  DISCLOSURE,
  LOCATION_CHOICES,
  disclosureFor,
  effectiveMode,
  locationPrivacyHint,
  locationRequestFields,
} from '../mediaPrivacy.ts';

describe('the disclosure table', () => {
  it('only `none` ever discloses the tagged place, and no mode lets any audience see more than another', () => {
    for (const m of COMPOSER_LOCATION_MODES) {
      assert.equal(DISCLOSURE[m].placeName, m === 'none', m);
      assert.equal(DISCLOSURE[m].anyAudienceSeesMore, false, m);
      assert.equal(DISCLOSURE[m].city && DISCLOSURE[m].country, true, `${m}: city and country stay on every post`);
    }
  });
  it('an unknown mode reads as a delayed one — never as `none`', () => {
    assert.equal(disclosureFor('publish_everything').placeName, false);
    assert.equal(disclosureFor(undefined).release, 'after_exit');
  });
  it('offers every mode the post API carries, exactly once', () => {
    assert.deepEqual([...LOCATION_CHOICES.map((c) => c.mode)].sort(), [...COMPOSER_LOCATION_MODES].sort());
  });
});

describe('effectiveMode — what the server will apply', () => {
  it('"Now" with a place attached is after-exit, because `none` is sent absent', () => {
    assert.equal(effectiveMode('none', true), 'delayed_until_exit');
    assert.equal(effectiveMode('none', false), 'none');
    for (const m of COMPOSER_LOCATION_MODES.filter((x) => x !== 'none')) assert.equal(effectiveMode(m, true), m);
  });
});

describe('locationPrivacyHint — words backed by the table', () => {
  const hint = (m: string, scheduledTime: Date | null = null) => locationPrivacyHint(m, { hasPlace: true, scheduledTime });
  it('no hint for a withheld place ever says it is completely hidden or visible to a circle', () => {
    for (const m of COMPOSER_LOCATION_MODES) {
      const h = hint(m);
      assert.doesNotMatch(h, /completely hidden/i, m);
      assert.doesNotMatch(h, /only people in your trusted circle/i, m);
      if (!disclosureFor(effectiveMode(m, true)).placeName && m !== 'delayed_until_exit' && m !== 'delayed_until_time' && m !== 'none') {
        assert.match(h, /city and country/i, `${m} must say what is still shared`);
      }
    }
  });
  it('the delayed modes say the whole post waits', () => {
    assert.match(hint('delayed_until_exit'), /Your post waits until you've left/);
    assert.match(hint('delayed_until_time', new Date(2026, 8, 26, 21, 30)), /Your post appears at /);
    assert.equal(hint('delayed_until_time', null), 'Pick a time for your post to appear.');
  });
  it('"Now" with a place does not claim to publish now', () => {
    assert.doesNotMatch(hint('none'), /^Published now/);
    assert.match(hint('none'), /held until you've left it/);
    assert.equal(locationPrivacyHint('none', { hasPlace: false }), 'Published now, with the place you tagged.');
  });
  it('"Trusted circle" says the circle sees no more than anyone', () => {
    assert.match(hint('trusted_circle_only'), /your Trusted Circle included/);
  });
});

describe('locationRequestFields — the wire is unchanged', () => {
  it('`none` is absent; a time is sent only for the timed mode', () => {
    const at = new Date('2026-09-26T21:30:00.000Z');
    assert.deepEqual(locationRequestFields('none', at), { locationPrivacyMode: undefined, publishAfterTime: null });
    assert.deepEqual(locationRequestFields('hidden', at), { locationPrivacyMode: 'hidden', publishAfterTime: null });
    assert.deepEqual(locationRequestFields('delayed_until_time', at), {
      locationPrivacyMode: 'delayed_until_time',
      publishAfterTime: '2026-09-26T21:30:00.000Z',
    });
    assert.deepEqual(locationRequestFields('garbage', null), { locationPrivacyMode: 'delayed_until_exit', publishAfterTime: null });
  });
});
