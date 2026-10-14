/**
 * census-telegraph T448 / T359 / T445 (lane w-tg-cardtruth, 2026-10-14) — the
 * three legacy card renderers under the SERVER's card truth.
 *
 *   1. A card that arrives with the server's truth (`card` on the message,
 *      resolved in the page's one batch) draws from it and makes NO request of
 *      its own — the per-card resolve was the N+1.
 *   2. CompassCardMessage never draws the sender's snapshot. It used to draw it
 *      unconditionally: no resolve, no revocation, the one card §5.3 never
 *      reached. Now it is live (the server's projection), revoked, loading, or
 *      the reference only.
 *
 * WHAT IS EXERCISED: the real components, the real useShareRevocation and the
 * real legacyCardView; only the resolve seam is stubbed. Written so it runs on
 * main: there every "no request" and every Compass case below is red (main's
 * cards ignore `serverCard` and Compass draws the snapshot).
 *
 * NOTE: named `.component.test.tsx` so the jest `test:component` pattern runs it.
 */
import React from 'react';
import { render, screen } from '@testing-library/react-native';

// NOTE: intentional stubs — the real module reaches lib/supabase, which builds a
// client at import time. Everything else here is REAL.
jest.mock('../sharing/shareApi.ts', () => {
  const actual = jest.requireActual('../sharing/shareApi.ts');
  return { ...actual, resolveShareProjections: jest.fn(), shareObjectIntoThread: jest.fn() };
});
jest.mock('../coordination/coordinationApi.ts', () => {
  const actual = jest.requireActual('../coordination/coordinationApi.ts');
  return { ...actual, postCoordinationKind: jest.fn() };
});

import { DiscoveryCardMessage } from '../../../components/DiscoveryCardMessage.tsx';
import { PostCardMessage } from '../../../components/PostCardMessage.tsx';
import { CompassCardMessage } from '../../../components/CompassCardMessage.tsx';
import { resolveShareProjections } from '../sharing/shareApi.ts';

const mockedResolve = resolveShareProjections as jest.MockedFunction<typeof resolveShareProjections>;

const THREAD = 'dddddddd-0000-4000-8000-00000000000d';
const PLACE = '55550000-0000-4000-8000-000000000001';
const GEM = '55550000-0000-4000-8000-000000000002';
const POST = '11110000-0000-4000-8000-000000000001';

// What a server that predates the reader rule stored and served: every
// source-derived field says SNAPSHOT.
const discoveryLive = JSON.stringify({ sourceId: PLACE, sourceType: 'place', title: 'Sky36 (now)', category: 'place', city: 'Hoan Kiem, Hanoi', caption: 'you will love this' });
const postWithheld = JSON.stringify({ postId: POST, caption: 'look', withheld: true });
const compassSnapshotPlace = JSON.stringify({ type: 'compass_card', id: 'place:9f9f', cardType: 'place', title: 'SNAPSHOT pick', city: 'SNAPSHOT city', category: 'SNAPSHOT cat', description: 'SNAPSHOT desc', imageUrl: null });
const compassSnapshotGem = JSON.stringify({ type: 'compass_card', id: `gem:${GEM}`, cardType: 'hidden_gem', title: 'SNAPSHOT gem', city: 'SNAPSHOT city', category: null, description: 'SNAPSHOT desc', imageUrl: null });

const projection = (objectType: string, objectId: string, title: string) => ({
  objectType, objectId, title, subtitle: 'Live area', imageUrl: null, projectionVersion: 'v9', deepLink: `/place/${objectId}`,
});

function liveCard(objectType: string, objectId: string, title: string) {
  return {
    kind: 'discovery_card', state: 'live' as const, objectType, objectId, status: 'active',
    projection: projection(objectType, objectId, title), actions: ['ADD_TO_TRIP'], deepLink: `/place/${objectId}`,
  } as any;
}

beforeEach(() => {
  mockedResolve.mockReset();
  mockedResolve.mockReturnValue(new Promise(() => {}));
});

describe('T448 — a card carrying the server’s truth makes no request of its own', () => {
  it('Discovery, live: draws the server projection, and resolve is never called', async () => {
    await render(
      <DiscoveryCardMessage body={discoveryLive} mine={false} threadId={THREAD} messageId="m1" {...({ serverCard: liveCard('PLACE', PLACE, 'Sky36 (now)') } as any)} />,
    );
    expect(screen.getByText('Sky36 (now)')).toBeTruthy();
    expect(screen.getByText('Live area')).toBeTruthy();
    expect(mockedResolve).not.toHaveBeenCalled();
  });

  it('Discovery, unavailable (private): the revoked notice, no request', async () => {
    const card = { kind: 'discovery_card', state: 'unavailable', objectType: 'PLACE', objectId: PLACE, reason: 'private', deepLink: '/' };
    await render(
      <DiscoveryCardMessage body={JSON.stringify({ sourceId: PLACE, sourceType: 'place', withheld: true })} mine={false} threadId={THREAD} messageId="m2" {...({ serverCard: card } as any)} />,
    );
    expect(screen.getByTestId('discovery-card-revoked')).toBeTruthy();
    expect(screen.getByText('This content is now private')).toBeTruthy();
    expect(mockedResolve).not.toHaveBeenCalled();
  });

  it('Post, unavailable because the server could not READ it: the reference only — not "removed", not the snapshot', async () => {
    const card = { kind: 'post_card', state: 'unavailable', objectType: 'POST', objectId: POST, reason: 'unknown', deepLink: '/' };
    await render(<PostCardMessage body={postWithheld} mine={false} threadId={THREAD} messageId="m3" {...({ serverCard: card } as any)} />);
    expect(screen.getByTestId('post-card-reference')).toBeTruthy();
    expect(screen.queryByTestId('post-card-revoked')).toBeNull();
    expect(mockedResolve).not.toHaveBeenCalled();
  });
});

describe('T359 / T445 — CompassCardMessage never draws the sender’s snapshot', () => {
  it('a Compass place pick (no §5 family): the reference only, and nothing to resolve', async () => {
    await render(<CompassCardMessage body={compassSnapshotPlace} mine={false} {...({ threadId: THREAD, messageId: 'm4' } as any)} />);
    expect(screen.queryByText(/SNAPSHOT/)).toBeNull();
    expect(screen.getByTestId('compass-card-reference')).toBeTruthy();
    expect(mockedResolve).not.toHaveBeenCalled();
  });

  it('a Compass gem pick on an older server: resolves for this viewer and draws the LIVE title', async () => {
    mockedResolve.mockResolvedValue({
      ok: true,
      data: { threadId: THREAD, projections: [{ objectType: 'HIDDEN_GEM', objectId: GEM, messageId: 'm5', available: true, status: 'active', projection: projection('HIDDEN_GEM', GEM, 'Quiet Alley Tea (now)'), actions: [], deepLink: `/gems/${GEM}` }], unsupported: [] },
    } as any);
    await render(<CompassCardMessage body={compassSnapshotGem} mine={false} {...({ threadId: THREAD, messageId: 'm5' } as any)} />);
    expect(await screen.findByText('Quiet Alley Tea (now)')).toBeTruthy();
    expect(screen.queryByText(/SNAPSHOT/)).toBeNull();
    expect(mockedResolve).toHaveBeenCalledTimes(1);
  });

  it('while the answer is out, nothing from the source', async () => {
    await render(<CompassCardMessage body={compassSnapshotGem} mine={false} {...({ threadId: THREAD, messageId: 'm6' } as any)} />);
    expect(screen.queryByText(/SNAPSHOT/)).toBeNull();
  });

  it('with the server’s truth: unavailable draws the revoked notice; live draws the projection; neither makes a request', async () => {
    const gone = { kind: 'compass_card', state: 'unavailable', objectType: 'HIDDEN_GEM', objectId: GEM, reason: 'deleted', deepLink: '/' };
    await render(<CompassCardMessage body={JSON.stringify({ id: `gem:${GEM}`, cardType: 'hidden_gem', withheld: true })} mine={false} {...({ threadId: THREAD, messageId: 'm7', serverCard: gone } as any)} />);
    expect(screen.getByText('This content was removed')).toBeTruthy();
    await render(<CompassCardMessage body={compassSnapshotGem} mine={false} {...({ threadId: THREAD, messageId: 'm8', serverCard: liveCard('HIDDEN_GEM', GEM, 'Quiet Alley Tea (now)') } as any)} />);
    expect(screen.getByText('Quiet Alley Tea (now)')).toBeTruthy();
    expect(screen.queryByText(/SNAPSHOT/)).toBeNull();
    expect(mockedResolve).not.toHaveBeenCalled();
  });

  it('with no thread at all: still never the snapshot', async () => {
    await render(<CompassCardMessage body={compassSnapshotGem} mine />);
    expect(screen.queryByText(/SNAPSHOT/)).toBeNull();
  });
});
