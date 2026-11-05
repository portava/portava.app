/**
 * eventEditDiff — an event edit sends only what the host changed.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { changedFields } from '../eventEditDiff.ts';

const initial = {
  title: 'Sunset walk',
  description: 'Bring water',
  startsAt: '2026-11-10T19:00:00',
  visibility: 'public',
  maxAttendees: 12,
  verifiedOnly: true,
  priceType: 'free',
  priceUrl: null,
  city: 'Cebu',
};

describe('changedFields', () => {
  it('sends nothing when nothing changed', () => {
    assert.deepEqual(changedFields({ ...initial }, initial), {});
  });

  it('sends only the changed field, so a description fix notifies nobody', () => {
    assert.deepEqual(changedFields({ ...initial, description: 'Bring water and a hat' }, initial), {
      description: 'Bring water and a hat',
    });
  });

  it('never sends visibility unless the host changed it', () => {
    const out = changedFields({ ...initial, title: 'Sunset walk II' }, initial);
    assert.equal('visibility' in out, false);
    assert.equal('state' in out, false);
  });

  it('clears an emptied optional detail and switches verified-only off', () => {
    assert.deepEqual(
      changedFields({ ...initial, description: undefined, maxAttendees: undefined, verifiedOnly: undefined }, initial),
      { description: null, maxAttendees: null, verifiedOnly: false },
    );
  });

  it('leaves an emptied required field alone', () => {
    assert.deepEqual(changedFields({ ...initial, startsAt: undefined }, initial), {});
  });

  it('sends a ticket link removal (null) only when there was a link', () => {
    assert.deepEqual(changedFields({ ...initial }, { ...initial, priceType: 'external', priceUrl: 'https://t.example/x' }), {
      priceType: 'free',
      priceUrl: null,
    });
  });
});
