/**
 * eventCommunity.test.ts — the client gates in front of the event posts,
 * photos, comments and save-as-memory routes (PLAT-F30). Each gate mirrors the
 * server rule in artifacts/api-server/src/routes/events.ts.
 *
 * Run: node --import tsx/esm --test src/lib/__tests__/eventCommunity.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isEventStaff, isEventParticipant, canOfferEventContribution, canSaveEventAsMemory,
} from '../eventCommunity.ts';

describe('isEventStaff', () => {
  it('host flag, host role and co-host role; not moderators or attendees', () => {
    assert.equal(isEventStaff({ isHost: true }), true);
    assert.equal(isEventStaff({ myRole: 'host' }), true);
    assert.equal(isEventStaff({ myRole: 'co_host' }), true);
    assert.equal(isEventStaff({ myRole: 'moderator', myRsvp: 'going' }), false);
    assert.equal(isEventStaff({ myRsvp: 'going' }), false);
  });
});

describe('isEventParticipant — the GET scope (staff, going, maybe)', () => {
  it('going and maybe read; interested, cant_go and no RSVP do not', () => {
    assert.equal(isEventParticipant({ myRsvp: 'going' }), true);
    assert.equal(isEventParticipant({ myRsvp: 'maybe' }), true);
    assert.equal(isEventParticipant({ myRole: 'co_host' }), true);
    for (const r of ['interested', 'cant_go', null]) assert.equal(isEventParticipant({ myRsvp: r }), false, String(r));
  });
});

describe('canOfferEventContribution — the POST scope (staff, going)', () => {
  it('maybe may read but is not offered a composer', () => {
    assert.equal(canOfferEventContribution({ myRsvp: 'maybe' }), false);
    assert.equal(canOfferEventContribution({ myRsvp: 'going' }), true);
    assert.equal(canOfferEventContribution({ isHost: true }), true);
  });
});

describe('canSaveEventAsMemory — stored state completed + staff or going', () => {
  it('completed and going / host', () => {
    assert.equal(canSaveEventAsMemory({ state: 'completed', myRsvp: 'going' }), true);
    assert.equal(canSaveEventAsMemory({ state: 'completed', isHost: true }), true);
  });
  it('not before the server has completed the event, and not for maybe / no RSVP', () => {
    for (const s of ['open', 'started', 'cancelled', 'archived', null]) {
      assert.equal(canSaveEventAsMemory({ state: s, myRsvp: 'going' }), false, String(s));
    }
    assert.equal(canSaveEventAsMemory({ state: 'completed', myRsvp: 'maybe' }), false);
    assert.equal(canSaveEventAsMemory({ state: 'completed', myRsvp: null }), false);
  });
});
