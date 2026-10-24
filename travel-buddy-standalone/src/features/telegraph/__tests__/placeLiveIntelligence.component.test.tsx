/**
 * census-telegraph T265 — §20 Places "current intelligence" on a shared place card, client side.
 *
 * Pins:
 *   - a PLACE card draws Discovery's why-now as "Now: …" while it is current, in the claims' own words;
 *   - past its validity the claims stay, said to be no longer current (never silently dropped, never
 *     still "Now");
 *   - nothing is drawn with no claims, with no stated validity, or on any other kind of card;
 *   - the card re-renders itself at the expiry instant (a card left open stops saying "Now").
 *
 * The card, its hook and the parser are REAL; only the network resolve is stubbed (the real module
 * reaches lib/supabase, which builds a client at import time).
 *
 * NOTE: named `.component.test.tsx` so the jest `test:component` pattern runs it.
 */
import React from 'react';
import { act, render, screen } from '@testing-library/react-native';

jest.mock('../sharing/shareApi.ts', () => {
  const actual = jest.requireActual('../sharing/shareApi.ts');
  return { ...actual, resolveShareProjections: jest.fn(), shareObjectIntoThread: jest.fn() };
});

import { PortavaObjectMessage } from '../sharing/PortavaObjectMessage.tsx';
import { resolveShareProjections } from '../sharing/shareApi.ts';
import { placeLiveLine } from '../sharing/placeLiveIntelligence.ts';

const mockedResolve = resolveShareProjections as jest.MockedFunction<typeof resolveShareProjections>;
const THREAD = 'dddddddd-0000-4000-8000-00000000000d';
const PLACE = '77770000-0000-4000-8000-000000000007';
const EVENT = '88880000-0000-4000-8000-000000000008';

function body(objectType: string, objectId: string) {
  return JSON.stringify({ kind: 'PORTAVA_OBJECT', shareProjectionVersion: '1', objectType, objectId, caption: null });
}

function resolved(objectType: string, objectId: string, liveIntelligence: unknown) {
  return {
    ok: true as const,
    data: {
      threadId: THREAD,
      projections: [{
        objectType, objectId, messageId: null, available: true, status: 'active',
        projection: { objectType, objectId, title: 'Night market', subtitle: 'Old quarter', imageUrl: null, projectionVersion: 'v1', deepLink: '/place/x', liveIntelligence },
        actions: [], deepLink: '/place/x',
      }],
      unsupported: [],
    },
  } as any;
}

beforeEach(() => {
  mockedResolve.mockReset();
});
afterEach(() => {
  jest.useRealTimers();
});

describe('placeLiveLine (pure)', () => {
  const live = { whyNow: ['busier_than_usual', 'live_music'], whyNowValidForMs: 60_000 };
  it('inside its validity: "Now:" with the claims in their own words', () => {
    expect(placeLiveLine(live, 1_000, 30_000)).toEqual({ text: 'Now: busier than usual · live music', stale: false, expiresAtMs: 61_000 });
  });
  it('past it: kept, and said to be no longer current', () => {
    const l = placeLiveLine(live, 1_000, 61_000)!;
    expect(l.stale).toBe(true);
    expect(l.text).toBe('busier than usual · live music — no longer current');
    expect(l.text.startsWith('Now')).toBe(false);
  });
  it('nothing to say: absent, empty, no stated validity', () => {
    expect(placeLiveLine(null, 0, 0)).toBeNull();
    expect(placeLiveLine({ whyNow: [], whyNowValidForMs: 60_000 }, 0, 0)).toBeNull();
    expect(placeLiveLine({ whyNow: ['busy'], whyNowValidForMs: null }, 0, 0)).toBeNull();
    expect(placeLiveLine({ whyNow: ['busy'], whyNowValidForMs: 0 }, 0, 0)).toBeNull();
    expect(placeLiveLine({ whyNow: null, whyNowValidForMs: 60_000 }, 0, 0)).toBeNull();
  });
});

describe('the shared PLACE card', () => {
  it('draws "Now: …" while current, and re-renders itself to "no longer current" at the expiry instant', async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    mockedResolve.mockResolvedValue(resolved('PLACE', PLACE, { whyNow: ['busier_than_usual'], whyNowValidForMs: 60_000 }));
    await render(<PortavaObjectMessage body={body('PLACE', PLACE)} mine={false} threadId={THREAD} />);
    expect((await screen.findByTestId('telegraph-place-live-now')).props.children).toBe('Now: busier than usual');
    await act(async () => { await jest.advanceTimersByTimeAsync(61_000); });
    expect(screen.queryByTestId('telegraph-place-live-now')).toBeNull();
    expect(screen.getByTestId('telegraph-place-live-stale').props.children).toBe('busier than usual — no longer current');
  });

  it('draws nothing when Discovery served nothing', async () => {
    mockedResolve.mockResolvedValue(resolved('PLACE', PLACE, null));
    await render(<PortavaObjectMessage body={body('PLACE', PLACE)} mine={false} threadId={THREAD} />);
    expect(await screen.findByTestId('telegraph-portava-object-card')).toBeTruthy();
    expect(screen.queryByTestId('telegraph-place-live-now')).toBeNull();
    expect(screen.queryByTestId('telegraph-place-live-stale')).toBeNull();
  });

  it('never on another kind of card, even if a projection carried the field', async () => {
    mockedResolve.mockResolvedValue(resolved('EVENT', EVENT, { whyNow: ['busy'], whyNowValidForMs: 60_000 }));
    await render(<PortavaObjectMessage body={body('EVENT', EVENT)} mine={false} threadId={THREAD} />);
    expect(await screen.findByTestId('telegraph-portava-object-card')).toBeTruthy();
    expect(screen.queryByTestId('telegraph-place-live-now')).toBeNull();
  });
});
