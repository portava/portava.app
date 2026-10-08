/**
 * The person's restriction list (OD-TRUST-4, lead ruling D-24): the client
 * shows the server's sentence verbatim and never turns a bad payload into
 * "no restrictions".
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseMyRestrictions, restrictionUntilLabel, RestrictionsPayloadError } from '../appealRestrictions.ts';

const HOSTING = "You cannot host group trips, change a group trip's shared plan, or start or link public Trails. You also cannot be booked as a Buddy.";

describe('AR1 parseMyRestrictions', () => {
  it('keeps the server sentence verbatim, with its end date', () => {
    const rows = parseMyRestrictions({ restrictions: [
      { id: 'r1', type: 'hosting', summary: HOSTING, since: '2026-10-01T00:00:00Z', until: '2026-10-14T00:00:00Z', why: { shared: false }, appeal: {} },
    ] });
    assert.deepEqual(rows, [{ id: 'r1', type: 'hosting', summary: HOSTING, since: '2026-10-01T00:00:00Z', until: '2026-10-14T00:00:00Z' }]);
  });
  it('an explicit empty list is "no restrictions"', () => {
    assert.deepEqual(parseMyRestrictions({ restrictions: [] }), []);
  });
  it('a malformed payload THROWS, never reads as "no restrictions"', () => {
    for (const bad of [null, {}, { restrictions: null }, { error: 'degraded_unavailable' }, { restrictions: [{ id: 'r1', type: 'hosting' }] }]) {
      assert.throws(() => parseMyRestrictions(bad), RestrictionsPayloadError, JSON.stringify(bad));
    }
  });
});

describe('AR2 restrictionUntilLabel', () => {
  it('no end date reads "Until it is reviewed"', () => {
    assert.equal(restrictionUntilLabel(null), 'Until it is reviewed');
  });
  it('a date reads "Until <date>"', () => {
    assert.match(restrictionUntilLabel('2026-10-14T12:00:00Z', 'en-GB'), /^Until 14 Oct 2026$/);
  });
});
