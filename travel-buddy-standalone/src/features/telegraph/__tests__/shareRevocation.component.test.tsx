/**
 * Telegraph §5.3 — a shared card must stop showing revoked content.
 *
 *   "If the source becomes deleted, private or unauthorized, the Telegraph
 *    reference must degrade to an unavailable state. Telegraph is never a
 *    backdoor into revoked source content."
 *
 * THE DEFECT. `DiscoveryCardMessage` parsed the sender's JSON and rendered it,
 * with no refetch and no authorization call; `PostCardMessage` had no fetch at
 * all. A place made private, or a post deleted, after sharing still rendered in
 * full inside the thread forever.
 *
 * WHAT IS EXERCISED: the real components, the real `useShareRevocation` hook
 * and the real `parsePortavaObjectBody`. Only the network call is stubbed —
 * that is the seam between this test and the server test that covers the same
 * requirement from the other side (`src/test/telegraphShare.test.ts`).
 *
 * THE THREE-STATE RULE IS THE POINT. `unknown` (no threadId, an unmappable
 * legacy source type, a failed resolve) must render EXACTLY as before —
 * collapsing it into "revoked" would blank every card on a network blip, and
 * collapsing it into "available" is the backdoor. Both directions are asserted.
 *
 * SHOWN RED before commit, each reverted:
 *   • disable DiscoveryCardMessage's revoked branch (its pre-§5 behaviour) →
 *     "a revoked place stops rendering the sender's snapshot" RED
 *     (1 failed / 10 passed).
 *   • make `useShareRevocation` treat a failed resolve as `unavailable` →
 *     "a failed resolve renders the card unchanged" RED (1 failed / 10 passed).
 *   Both restored: 11/11.
 */
import React from 'react';
import { render, screen } from '@testing-library/react-native';

// NOTE: intentional stub — the real module reaches lib/supabase, which builds
// a client at import time and fails outside an Expo runtime. The hook, the
// parser and both card components under test are the REAL ones.
jest.mock('../sharing/shareApi.ts', () => {
  const actual = jest.requireActual('../sharing/shareApi.ts');
  return {
    ...actual,
    resolveShareProjections: jest.fn(),
    shareObjectIntoThread: jest.fn(),
  };
});

import { DiscoveryCardMessage } from '../../../components/DiscoveryCardMessage.tsx';
import { PostCardMessage } from '../../../components/PostCardMessage.tsx';
import { PortavaObjectMessage } from '../sharing/PortavaObjectMessage.tsx';
import {
  legacySourceTypeToObjectType,
  parsePortavaObjectBody,
  resolveShareProjections,
} from '../sharing/shareApi.ts';

const mockedResolve = resolveShareProjections as jest.MockedFunction<typeof resolveShareProjections>;

const THREAD = 'dddddddd-0000-4000-8000-00000000000d';
const GEM = '55550000-0000-4000-8000-000000000002';
const POST = '11110000-0000-4000-8000-000000000001';

const discoveryBody = JSON.stringify({
  sourceId: GEM,
  sourceType: 'hidden_gem',
  title: 'The rooftop with no sign',
  category: 'nightlife',
  city: 'Hue',
  blurb: 'Ask for the back stairs',
});

const postBody = JSON.stringify({
  postId: POST,
  authorName: 'Bob',
  snippet: 'A bar with no sign',
});

function unavailable(objectType: string, objectId: string, reason: string) {
  return {
    ok: true as const,
    data: {
      threadId: THREAD,
      projections: [
        {
          objectType,
          objectId,
          messageId: null,
          available: false,
          status: reason,
          reason,
          projection: null,
          actions: [],
          deepLink: '/',
        },
      ],
      unsupported: [],
    },
  } as any;
}

function available(objectType: string, objectId: string, title: string) {
  return {
    ok: true as const,
    data: {
      threadId: THREAD,
      projections: [
        {
          objectType,
          objectId,
          messageId: null,
          available: true,
          status: 'active',
          projection: {
            objectType,
            objectId,
            title,
            subtitle: 'Old town, Hue',
            imageUrl: null,
            projectionVersion: 'v1',
            deepLink: `/gems/${objectId}`,
          },
          actions: ['ADD_TO_TRIP'],
          deepLink: `/gems/${objectId}`,
        },
      ],
      unsupported: [],
    },
  } as any;
}

beforeEach(() => {
  mockedResolve.mockReset();
});

describe('§5.3 — DiscoveryCardMessage', () => {
  it('a revoked place stops rendering the sender’s snapshot', async () => {
    mockedResolve.mockResolvedValue(unavailable('HIDDEN_GEM', GEM, 'private'));
    await render(<DiscoveryCardMessage body={discoveryBody} mine={false} threadId={THREAD} />);
    expect(await screen.findByTestId('discovery-card-revoked')).toBeTruthy();
    expect(screen.queryByText('The rooftop with no sign')).toBeNull();
    expect(screen.queryByText('Ask for the back stairs')).toBeNull();
    expect(screen.getByText('This content is now private')).toBeTruthy();
  });

  it('a live place still renders the card', async () => {
    mockedResolve.mockResolvedValue(available('HIDDEN_GEM', GEM, 'The rooftop with no sign'));
    await render(<DiscoveryCardMessage body={discoveryBody} mine={false} threadId={THREAD} />);
    expect(await screen.findByText('The rooftop with no sign')).toBeTruthy();
    expect(screen.queryByTestId('discovery-card-revoked')).toBeNull();
  });

  it('WITHOUT a threadId nothing is resolved and the card is unchanged', async () => {
    await render(<DiscoveryCardMessage body={discoveryBody} mine={false} />);
    expect(screen.getByText('The rooftop with no sign')).toBeTruthy();
    expect(mockedResolve).not.toHaveBeenCalled();
  });

  it('a failed resolve renders the card unchanged — "could not tell" is not "revoked"', async () => {
    mockedResolve.mockResolvedValue({ ok: false, error: 'network' } as any);
    await render(<DiscoveryCardMessage body={discoveryBody} mine={false} threadId={THREAD} />);
    expect(await screen.findByText('The rooftop with no sign')).toBeTruthy();
    expect(screen.queryByTestId('discovery-card-revoked')).toBeNull();
  });
});

describe('§5.3 — PostCardMessage', () => {
  it('a deleted post stops rendering its snippet', async () => {
    mockedResolve.mockResolvedValue(unavailable('POST', POST, 'deleted'));
    await render(<PostCardMessage body={postBody} mine={false} threadId={THREAD} />);
    expect(await screen.findByTestId('post-card-revoked')).toBeTruthy();
    expect(screen.queryByText('A bar with no sign')).toBeNull();
    expect(screen.getByText('This content was removed')).toBeTruthy();
  });

  it('without a threadId the card is byte-for-byte its old self', async () => {
    await render(<PostCardMessage body={postBody} mine={false} />);
    expect(screen.getByText('A bar with no sign')).toBeTruthy();
    expect(mockedResolve).not.toHaveBeenCalled();
  });
});

describe('§6.2 PORTAVA_OBJECT — a reference, resolved at render', () => {
  const body = JSON.stringify({
    kind: 'PORTAVA_OBJECT',
    objectType: 'HIDDEN_GEM',
    objectId: GEM,
    caption: 'this one',
    shareProjectionVersion: '1',
  });

  it('renders the server-resolved title, never a stored one', async () => {
    mockedResolve.mockResolvedValue(available('HIDDEN_GEM', GEM, 'Renamed since sharing'));
    await render(<PortavaObjectMessage body={body} mine={false} threadId={THREAD} />);
    expect(await screen.findByText('Renamed since sharing')).toBeTruthy();
    expect(screen.getByText('this one')).toBeTruthy();
  });

  it('degrades when the source is gone, keeping only the sender’s own words', async () => {
    mockedResolve.mockResolvedValue(unavailable('HIDDEN_GEM', GEM, 'deleted'));
    await render(<PortavaObjectMessage body={body} mine={false} threadId={THREAD} />);
    expect(await screen.findByTestId('telegraph-portava-object-revoked')).toBeTruthy();
    expect(screen.getByText('This content was removed')).toBeTruthy();
  });

  it('an unreadable envelope is a neutral placeholder, not a crash', async () => {
    await render(<PortavaObjectMessage body={'not json'} mine={false} threadId={THREAD} />);
    expect(screen.getByTestId('telegraph-portava-object-unreadable')).toBeTruthy();
  });
});

describe('the envelope parser and the legacy mapping', () => {
  it('parses a v1 envelope and refuses anything else', () => {
    expect(parsePortavaObjectBody(JSON.stringify({ kind: 'PORTAVA_OBJECT', objectType: 'POST', objectId: 'x', caption: null, shareProjectionVersion: '1' }))?.objectId).toBe('x');
    expect(parsePortavaObjectBody(JSON.stringify({ kind: 'PORTAVA_OBJECT', objectType: 'POST', objectId: 'x', shareProjectionVersion: '2' }))).toBeNull();
    expect(parsePortavaObjectBody('nope')).toBeNull();
    expect(parsePortavaObjectBody(null)).toBeNull();
  });

  it('maps the legacy sourceType vocabulary, and returns null for the rest', () => {
    expect(legacySourceTypeToObjectType('hidden_gem')).toBe('HIDDEN_GEM');
    expect(legacySourceTypeToObjectType('place')).toBe('PLACE');
    expect(legacySourceTypeToObjectType('post')).toBe('POST');
    expect(legacySourceTypeToObjectType('for_you')).toBeNull();
    expect(legacySourceTypeToObjectType(undefined)).toBeNull();
  });
});
