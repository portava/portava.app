/**
 * census-telegraph T448 (lane w-tg-cardtruth, 2026-10-14) — the client half of
 * the server's card truth: how a `card` maps onto the revocation hook's three
 * states, what the notice pill may say, and the Compass reference mapping that
 * mirrors the server's.
 *
 * NOTE: named `.component.test.tsx` so the jest `test:component` pattern runs it
 * (the modules import React and the share client, which jest stubs below).
 */
// NOTE: intentional stubs — the real module reaches lib/supabase, which builds a
// client at import time. The functions under test are REAL.
jest.mock('../sharing/shareApi.ts', () => {
  const actual = jest.requireActual('../sharing/shareApi.ts');
  return { ...actual, resolveShareProjections: jest.fn(), shareObjectIntoThread: jest.fn() };
});

import { revocationFromServerCard } from '../sharing/useShareRevocation.ts';
import { sharedCardNoticeText } from '../sharing/sharedCardNotice.ts';
import { compassCardRef, SHARED_CARD_UNVERIFIABLE_COPY } from '../sharing/shareApi.ts';

const live = {
  kind: 'discovery_card', state: 'live', objectType: 'PLACE', objectId: 'p1', status: 'active',
  projection: { objectType: 'PLACE', objectId: 'p1', title: 'Now', subtitle: null, imageUrl: null, projectionVersion: null, deepLink: '/place/p1' },
  actions: ['ADD_TO_TRIP'], deepLink: '/place/p1',
} as any;

describe('revocationFromServerCard', () => {
  it('maps live to available with the server projection and actions', () => {
    const r = revocationFromServerCard(live, 'm1');
    expect(r?.state).toBe('available');
    expect(r?.resolved?.available && r.resolved.projection.title).toBe('Now');
    expect(r?.resolved?.messageId).toBe('m1');
  });
  it('maps a real unavailability to unavailable with its reason', () => {
    const r = revocationFromServerCard({ kind: 'post_card', state: 'unavailable', objectType: 'POST', objectId: 'x', reason: 'deleted', deepLink: '/' } as any, null);
    expect([r?.state, r?.reason]).toEqual(['unavailable', 'deleted']);
  });
  it('maps an unreadable source and a withheld card to unknown — cannot tell, not revoked', () => {
    expect(revocationFromServerCard({ kind: 'post_card', state: 'unavailable', objectType: 'POST', objectId: 'x', reason: 'unknown', deepLink: '/' } as any, null)?.state).toBe('unknown');
    expect(revocationFromServerCard({ kind: 'compass_card', state: 'withheld', reason: 'no_source' } as any, null)?.state).toBe('unknown');
  });
  it('is null without server truth, so an older server leaves the hook to resolve for itself', () => {
    expect(revocationFromServerCard(undefined, null)).toBeNull();
    expect(revocationFromServerCard(null, null)).toBeNull();
  });
});

describe('sharedCardNoticeText', () => {
  it('says nothing for a live card or a message without truth', () => {
    expect(sharedCardNoticeText(live)).toBeNull();
    expect(sharedCardNoticeText(undefined)).toBeNull();
  });
  it('names the reason for a real unavailability, and nothing from the source', () => {
    expect(sharedCardNoticeText({ kind: 'meetup_card', state: 'unavailable', objectType: 'MEETUP', objectId: 'x', reason: 'unauthorized', deepLink: '/' } as any))
      .toBe('You no longer have access to this');
  });
  it('says it cannot be shown for an unreadable or withheld card', () => {
    expect(sharedCardNoticeText({ kind: 'meetup_card', state: 'unavailable', objectType: 'MEETUP', objectId: 'x', reason: 'unknown', deepLink: '/' } as any)).toBe(SHARED_CARD_UNVERIFIABLE_COPY);
    expect(sharedCardNoticeText({ kind: 'circle_status_card', state: 'withheld', reason: 'no_source' } as any)).toBe(SHARED_CARD_UNVERIFIABLE_COPY);
  });
});

describe('compassCardRef mirrors the server', () => {
  it('maps gem: and bare event ids; never a discovery_places id', () => {
    expect(compassCardRef({ id: 'gem:abc', cardType: 'hidden_gem' })).toEqual({ objectType: 'HIDDEN_GEM', objectId: 'abc' });
    expect(compassCardRef({ id: 'e1', cardType: 'event' })).toEqual({ objectType: 'EVENT', objectId: 'e1' });
    expect(compassCardRef({ id: 'place:abc', cardType: 'place' })).toBeNull();
    expect(compassCardRef({ id: 'x', cardType: 'activity' })).toBeNull();
    expect(compassCardRef(null)).toBeNull();
  });
});
