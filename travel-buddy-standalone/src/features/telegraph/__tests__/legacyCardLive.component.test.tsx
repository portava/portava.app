/**
 * census-telegraph T413 / T448 / T411 — the two legacy shared cards draw the
 * server's CURRENT projection and offer only the server's CURRENT actions.
 *
 *   §30A.20 "A source object shared in Telegraph cannot grant broader access than
 *            its authorized share projection."
 *   §30A.10 "Action buttons are derived from current capabilities. An old
 *            rendered card must not authorize a stale action."
 *
 * WHAT IS EXERCISED: the real DiscoveryCardMessage / PostCardMessage, the real
 * useShareRevocation hook and the real legacyCardView. Only the two network
 * seams are stubbed: the share resolve and the coordination post.
 *
 * SHOWN RED (T2 lane report): `legacyCardMode` returning 'legacy' for an
 * available resolve (i.e. drawing the snapshot again) turns the live cases red;
 * `offeredCardActions` returning Add/Save for 'reference' turns the
 * reference-actions case red.
 *
 * NOTE: named `.component.test.tsx` so the jest `test:component` pattern runs it.
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';

// NOTE: intentional stubs — the real modules reach lib/supabase, which builds a
// client at import time. The components, the hook and legacyCardView are REAL.
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
import { resolveShareProjections } from '../sharing/shareApi.ts';
import { postCoordinationKind } from '../coordination/coordinationApi.ts';
import { legacyCardMode, offeredCardActions } from '../sharing/legacyCardView.ts';

const mockedResolve = resolveShareProjections as jest.MockedFunction<typeof resolveShareProjections>;
const mockedPost = postCoordinationKind as jest.MockedFunction<typeof postCoordinationKind>;

const THREAD = 'dddddddd-0000-4000-8000-00000000000d';
const GEM = '55550000-0000-4000-8000-000000000002';
const POST = '11110000-0000-4000-8000-000000000001';

const discoveryBody = JSON.stringify({
  sourceId: GEM,
  sourceType: 'hidden_gem',
  title: 'Snapshot title the sender saw',
  category: 'nightlife',
  city: 'Snapshot city',
  blurb: 'Snapshot blurb',
  priceLevel: '$$$',
  caption: 'you will love this',
});

const postBody = JSON.stringify({
  postId: POST,
  authorName: 'Snapshot Bob',
  authorHandle: 'oldhandle',
  snippet: 'Snapshot snippet',
  likeCount: 42,
  city: 'Snapshot city',
  caption: 'look',
});

function resolved(objectType: string, objectId: string, over: Record<string, unknown>, actions: string[]) {
  return {
    ok: true as const,
    data: {
      threadId: THREAD,
      projections: [{
        objectType, objectId, messageId: null, available: true, status: 'active',
        projection: {
          objectType, objectId, title: 'Live title', subtitle: 'Live neighbourhood, Hue',
          imageUrl: null, projectionVersion: 'v2', deepLink: `/gems/${objectId}`, ...over,
        },
        actions, deepLink: `/gems/${objectId}`,
      }],
      unsupported: [],
    },
  } as unknown as Awaited<ReturnType<typeof resolveShareProjections>>;
}

beforeEach(() => {
  mockedResolve.mockReset();
  mockedPost.mockReset();
});

describe('T413 — DiscoveryCardMessage draws the live projection, not the snapshot', () => {
  it('live: the server title and location replace the snapshot; blurb and price are not drawn', async () => {
    mockedResolve.mockResolvedValue(resolved('HIDDEN_GEM', GEM, {}, ['ADD_TO_TRIP', 'MEET_HERE']));
    await render(<DiscoveryCardMessage body={discoveryBody} mine={false} threadId={THREAD} />);
    expect(await screen.findByText('Live title')).toBeTruthy();
    expect(screen.getByText('Live neighbourhood, Hue')).toBeTruthy();
    expect(screen.queryByText('Snapshot title the sender saw')).toBeNull();
    expect(screen.queryByText('Snapshot blurb')).toBeNull();
    expect(screen.queryByText(/\$\$\$/)).toBeNull();
    // The sender's OWN words are theirs to show.
    expect(screen.getByText('"you will love this"')).toBeTruthy();
  });

  it('loading: nothing from the source is drawn while the answer is out', async () => {
    mockedResolve.mockReturnValue(new Promise(() => {}));
    await render(<DiscoveryCardMessage body={discoveryBody} mine={false} threadId={THREAD} />);
    expect(screen.getByTestId('discovery-card-loading')).toBeTruthy();
    expect(screen.queryByText('Snapshot title the sender saw')).toBeNull();
  });
});

describe('T411 — the action row is the server’s current actions', () => {
  it('ADD_TO_TRIP alone: View, Add to Plan and Save — no Meet here', async () => {
    mockedResolve.mockResolvedValue(resolved('HIDDEN_GEM', GEM, {}, ['ADD_TO_TRIP']));
    await render(<DiscoveryCardMessage body={discoveryBody} mine={false} threadId={THREAD} />);
    await screen.findByText('Live title');
    expect(screen.getByTestId('discovery-card-view')).toBeTruthy();
    expect(screen.getByTestId('discovery-card-add-to-plan')).toBeTruthy();
    expect(screen.getByTestId('discovery-card-save')).toBeTruthy();
    expect(screen.queryByTestId('discovery-card-meet-here')).toBeNull();
  });

  it('no current actions: no Add to Plan, no Meet here', async () => {
    mockedResolve.mockResolvedValue(resolved('HIDDEN_GEM', GEM, {}, []));
    await render(<DiscoveryCardMessage body={discoveryBody} mine={false} threadId={THREAD} />);
    await screen.findByText('Live title');
    expect(screen.queryByTestId('discovery-card-add-to-plan')).toBeNull();
    expect(screen.queryByTestId('discovery-card-meet-here')).toBeNull();
  });

  it('MEET_HERE: the card proposes meeting at the LIVE place, through the coordination route', async () => {
    mockedResolve.mockResolvedValue(resolved('HIDDEN_GEM', GEM, {}, ['MEET_HERE']));
    mockedPost.mockResolvedValue({ ok: true, data: { id: 'm1' } } as Awaited<ReturnType<typeof postCoordinationKind>>);
    await render(<DiscoveryCardMessage body={discoveryBody} mine={false} threadId={THREAD} />);
    fireEvent.press(await screen.findByTestId('discovery-card-meet-here'));
    expect(mockedPost).toHaveBeenCalledTimes(1);
    const [threadArg, kindArg, payloadArg] = mockedPost.mock.calls[0]!;
    expect(threadArg).toBe(THREAD);
    expect(kindArg).toBe('ACTION_PROPOSAL');
    expect(payloadArg).toEqual({ action: 'MEET_HERE', title: 'Meet at Live title', objectType: 'HIDDEN_GEM', objectId: GEM });
  });

  it('a failed resolve draws the reference and offers View only — no stale Add or Save', async () => {
    mockedResolve.mockResolvedValue({ ok: false, error: 'network' } as Awaited<ReturnType<typeof resolveShareProjections>>);
    await render(<DiscoveryCardMessage body={discoveryBody} mine={false} threadId={THREAD} />);
    expect(await screen.findByTestId('discovery-card-reference')).toBeTruthy();
    expect(screen.getByTestId('discovery-card-view')).toBeTruthy();
    expect(screen.queryByTestId('discovery-card-add-to-plan')).toBeNull();
    expect(screen.queryByTestId('discovery-card-save')).toBeNull();
    expect(screen.getByText('"you will love this"')).toBeTruthy();
  });

  it('no thread (nothing to resolve in): the pre-§5 card, with View as its only action', async () => {
    await render(<DiscoveryCardMessage body={discoveryBody} mine={false} />);
    expect(screen.getByText('Snapshot title the sender saw')).toBeTruthy();
    expect(screen.getByTestId('discovery-card-view')).toBeTruthy();
    expect(screen.queryByTestId('discovery-card-add-to-plan')).toBeNull();
    expect(screen.queryByTestId('discovery-card-save')).toBeNull();
    expect(mockedResolve).not.toHaveBeenCalled();
  });
});

describe('T448 — PostCardMessage draws only the authorized projection', () => {
  it('live: current text and handle; NOT the snapshot author, snippet, counts or place', async () => {
    mockedResolve.mockResolvedValue(resolved('POST', POST, {
      title: 'Edited post text', subtitle: '@newhandle', deepLink: `/post/${POST}`,
    }, []));
    await render(<PostCardMessage body={postBody} mine={false} threadId={THREAD} />);
    expect(await screen.findByTestId('post-card-live')).toBeTruthy();
    expect(screen.getByText('Edited post text')).toBeTruthy();
    expect(screen.getByText('@newhandle')).toBeTruthy();
    for (const snap of ['Snapshot Bob', '@oldhandle', 'Snapshot snippet', '42', 'Snapshot city']) {
      expect(screen.queryByText(snap)).toBeNull();
    }
    expect(screen.getByText('"look"')).toBeTruthy();
  });

  it('a failed resolve draws the reference, not the snippet', async () => {
    mockedResolve.mockResolvedValue({ ok: false, error: 'network' } as Awaited<ReturnType<typeof resolveShareProjections>>);
    await render(<PostCardMessage body={postBody} mine={false} threadId={THREAD} />);
    expect(await screen.findByTestId('post-card-reference')).toBeTruthy();
    expect(screen.queryByText('Snapshot snippet')).toBeNull();
    expect(screen.getByTestId('post-card-view')).toBeTruthy();
  });

  it('loading draws nothing from the post', async () => {
    mockedResolve.mockReturnValue(new Promise(() => {}));
    await render(<PostCardMessage body={postBody} mine={false} threadId={THREAD} />);
    expect(screen.getByTestId('post-card-loading')).toBeTruthy();
    expect(screen.queryByText('Snapshot snippet')).toBeNull();
  });
});

describe('legacyCardView — the five modes, decided once', () => {
  const avail = { state: 'available' as const, reason: null, resolved: { available: true } as never };
  it('maps the hook states', () => {
    expect(legacyCardMode({ state: 'unavailable', reason: 'deleted', resolved: null }, true)).toBe('revoked');
    expect(legacyCardMode(avail, true)).toBe('live');
    expect(legacyCardMode({ state: 'loading', reason: null, resolved: null }, true)).toBe('loading');
    expect(legacyCardMode({ state: 'unknown', reason: null, resolved: null }, true)).toBe('reference');
    expect(legacyCardMode({ state: 'unknown', reason: null, resolved: null }, false)).toBe('legacy');
  });
  it('only live derives more than View, and only from the actions given', () => {
    expect(offeredCardActions('live', ['ADD_TO_TRIP'])).toEqual({ view: true, addToTrip: true, meetHere: false, save: true });
    expect(offeredCardActions('reference', ['ADD_TO_TRIP', 'MEET_HERE'])).toEqual({ view: true, addToTrip: false, meetHere: false, save: false });
    expect(offeredCardActions('legacy', ['ADD_TO_TRIP'])).toEqual({ view: true, addToTrip: false, meetHere: false, save: false });
    expect(offeredCardActions('loading')).toEqual({ view: false, addToTrip: false, meetHere: false, save: false });
    expect(offeredCardActions('revoked')).toEqual({ view: false, addToTrip: false, meetHere: false, save: false });
  });
});
