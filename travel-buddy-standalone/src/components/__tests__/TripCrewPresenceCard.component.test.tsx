/**
 * TripCrewPresenceCard — §10 reaching a screen without becoming a lie there.
 *
 * Five migrations built presence (2763 table, 2767 vocabulary, 2768 commands,
 * 2776 freshness + view, 2777 out-of-order guard) and until this card nothing
 * read any of it. What is pinned here is the set of distinctions those
 * migrations were careful about, surviving all the way to pixels:
 *
 *   a STALE row is shown, not hidden — §10.4 needs last-known data — and is
 *     never drawn like a current one, nor sorted above one
 *   the server's freshness label and isCurrent are used AS GIVEN; nothing is
 *     recomputed from observedAt against the device clock
 *   "never observed" is its own line, distinct from a reported 'offline'
 *   an unavailable read says so and explicitly denies meaning "nobody shares"
 *
 * RNTL v14: always await render().
 */
import React from 'react';
import { render, waitFor, fireEvent } from '@testing-library/react-native';

import {
  TripCrewPresenceCard, describeAge, presenceIdempotencyKey, PRESENCE_TTL_SECONDS,
} from '../trip/TripCrewPresenceCard.tsx';
import type { PresenceRead, PresenceEntry } from '../../services/tripPresence.ts';
import type { TripCommandResult } from '../../services/tripCommands.ts';

const TRIP_ID = 'trip-presence-test';
const ALICE = 'user-alice';
const BOB = 'user-bob';
const CARA = 'user-cara';
const NAMES = { [ALICE]: 'Alice', [BOB]: 'Bob', [CARA]: 'Cara' };

function entry(over: Partial<PresenceEntry> = {}): PresenceEntry {
  return {
    userId: ALICE,
    state: 'at_plan',
    visibility: 'crew',
    source: 'explicit',
    confidence: 0.9,
    observedAt: '2026-10-01T12:00:00.000Z',
    expiresAt: '2026-10-01T12:20:00.000Z',
    freshness: 'live',
    expired: false,
    observedSecondsAgo: 30,
    isCurrent: true,
    ...over,
  };
}

const board = (presence: PresenceEntry[], noPresence: string[] = []): PresenceRead => ({
  state: 'ok',
  board: { tripId: TRIP_ID, asOf: '2026-10-01T12:01:00.000Z', presence, noPresence },
});

const loader = (read: PresenceRead) => jest.fn(async () => read);

describe('TripCrewPresenceCard', () => {
  it('shows a stale row rather than hiding it, with its label and its age', async () => {
    // §10.4: last-known data may remain useful. A hidden row cannot be.
    const { findByText } = await render(
      <TripCrewPresenceCard
        tripId={TRIP_ID}
        names={NAMES}
        load={loader(board([
          entry({ userId: BOB, freshness: 'last_known', isCurrent: false, observedSecondsAgo: 5400 }),
        ]))}
      />,
    );
    expect(await findByText('Bob')).toBeTruthy();
    expect(await findByText(/Last known/)).toBeTruthy();
    expect(await findByText(/seen 2h ago/)).toBeTruthy();
  });

  it('never sorts a stale row above a current one', async () => {
    // A stale row at the top reads as the freshest thing on the card.
    const { findByTestId, toJSON } = await render(
      <TripCrewPresenceCard
        tripId={TRIP_ID}
        names={NAMES}
        load={loader(board([
          // Deliberately handed to the card stale-first, so a component that
          // preserves input order fails this test.
          entry({ userId: BOB, freshness: 'offline', isCurrent: false, observedSecondsAgo: 9000 }),
          entry({ userId: ALICE, freshness: 'live', isCurrent: true, observedSecondsAgo: 10 }),
        ]))}
      />,
    );
    await findByTestId('trip-presence-card');
    const tree = JSON.stringify(toJSON());
    const alice = tree.indexOf(`presence-${ALICE}`);
    const bob = tree.indexOf(`presence-${BOB}`);
    expect(alice).toBeGreaterThan(-1);
    expect(bob).toBeGreaterThan(-1);
    expect(alice).toBeLessThan(bob);
  });

  it('uses the SERVER\'s isCurrent, not its own arithmetic on observedAt', async () => {
    // A row the server calls current is drawn as current even though its
    // observedAt is far in the past relative to any device clock. This is the
    // §10.2 rule from the other direction: the client does not get a vote.
    const { findByText, queryByText } = await render(
      <TripCrewPresenceCard
        tripId={TRIP_ID}
        names={NAMES}
        load={loader(board([
          entry({ userId: ALICE, observedAt: '2020-01-01T00:00:00.000Z', freshness: 'live', isCurrent: true, observedSecondsAgo: 5 }),
        ]))}
      />,
    );
    expect(await findByText(/Live/)).toBeTruthy();
    // No age suffix: ages are shown only for rows the SERVER called stale.
    expect(queryByText(/seen .* ago/)).toBeNull();
  });

  it('"never observed" is its own line, distinct from a reported offline', async () => {
    const { findByText, findByTestId } = await render(
      <TripCrewPresenceCard
        tripId={TRIP_ID}
        names={NAMES}
        load={loader(board(
          [entry({ userId: ALICE, state: 'offline', freshness: 'recent', isCurrent: true })],
          [BOB, CARA],
        ))}
      />,
    );
    // Alice REPORTED offline. That is a report and it is a presence row.
    expect(await findByText(/Offline/)).toBeTruthy();
    // Bob and Cara have never been observed. Different sentence.
    expect(await findByTestId('trip-presence-not-sharing')).toBeTruthy();
    expect(await findByText(/2 not sharing/)).toBeTruthy();
    expect(await findByText(/not shared where they are/)).toBeTruthy();
  });

  it('an unavailable read says so, and denies meaning "nobody is sharing"', async () => {
    const { findByText, findByTestId } = await render(
      <TripCrewPresenceCard tripId={TRIP_ID} load={loader({ state: 'unavailable', detail: 'HTTP 503' })} />,
    );
    expect(await findByTestId('trip-presence-unavailable')).toBeTruthy();
    expect(await findByText(/doesn't mean nobody is sharing/)).toBeTruthy();
  });

  it('an unexpected throw is unavailable, never off', async () => {
    const { findByTestId } = await render(
      <TripCrewPresenceCard tripId={TRIP_ID} load={(jest.fn(async () => { throw new Error('x'); })) as any} />,
    );
    expect(await findByTestId('trip-presence-unavailable')).toBeTruthy();
  });

  it('renders nothing ONLY when presence is off here', async () => {
    const { toJSON, queryByTestId } = await render(
      <TripCrewPresenceCard tripId={TRIP_ID} load={loader({ state: 'off' })} />,
    );
    await waitFor(() => expect(queryByTestId('trip-presence-loading')).toBeNull());
    expect(toJSON()).toBeNull();
  });
});

describe('the WRITE path — SET_PRESENCE reaching a screen', () => {
  // Before this control, SET_PRESENCE and CLEAR_PRESENCE existed in the kernel
  // (2768), were issuable over §11's endpoint, and no screen could send
  // either. A command family nothing can issue is a stored procedure.
  const applied: TripCommandResult = {
    ok: true, duplicate: false, version: 2, eventId: 'e1', sequence: 1,
    result: { applied: true }, contractVersion: 2,
  };

  it('sends the state, a TTL, and an explicit source', async () => {
    // §10.1 requires a TTL: a presence row without one never goes stale.
    const set = jest.fn(async () => applied);
    const { findByTestId } = await render(
      <TripCrewPresenceCard tripId={TRIP_ID} load={loader(board([]))} set={set as any} />,
    );
    fireEvent.press(await findByTestId('presence-set-at_plan'));
    await waitFor(() => expect(set).toHaveBeenCalled());
    const [tripId, args] = set.mock.calls[0] as any[];
    expect(tripId).toBe(TRIP_ID);
    expect(args.state).toBe('at_plan');
    expect(args.ttlSeconds).toBe(PRESENCE_TTL_SECONDS);
    expect(args.source).toBe('explicit');
    expect(typeof args.idempotencyKey).toBe('string');
    expect(args.idempotencyKey.length).toBeGreaterThan(0);
  });

  it('reloads the board after a write, so the read reflects the write', async () => {
    const load = jest.fn(async () => board([]));
    const set = jest.fn(async () => applied);
    const { findByTestId } = await render(
      <TripCrewPresenceCard tripId={TRIP_ID} load={load as any} set={set as any} />,
    );
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    fireEvent.press(await findByTestId('presence-set-available'));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  });

  it('a STALE write is reported, not shown as a success', async () => {
    // The kernel returns ok with applied:false when a newer observation already
    // exists — a well-behaved retry causes it. A tick here would claim a write
    // that did not happen.
    const set = jest.fn(async (): Promise<TripCommandResult> => ({
      ok: true, duplicate: false, version: 2, eventId: null, sequence: null,
      result: { applied: false, reason: 'STALE_OBSERVATION' }, contractVersion: 2,
    }));
    const { findByTestId, findByText } = await render(
      <TripCrewPresenceCard tripId={TRIP_ID} load={loader(board([]))} set={set as any} />,
    );
    fireEvent.press(await findByTestId('presence-set-resting'));
    expect(await findByText(/newer update already covers this/)).toBeTruthy();
  });

  it('a REFUSAL names the kernel reason; an UNAVAILABLE says the fate is unknown', async () => {
    // The two must not be merged: one means the kernel said no, the other that
    // it may never have been asked.
    const refused = jest.fn(async (): Promise<TripCommandResult> => ({
      ok: false, kind: 'refused', status: 403, reason: 'TRIP_PRESENCE_NOT_SELF',
      detail: null, currentVersion: null, expectedVersion: null,
    }));
    const r1 = await render(
      <TripCrewPresenceCard tripId={TRIP_ID} load={loader(board([]))} set={refused as any} />,
    );
    fireEvent.press(await r1.findByTestId('presence-set-available'));
    expect(await r1.findByText(/Not recorded: TRIP_PRESENCE_NOT_SELF/)).toBeTruthy();

    const lost = jest.fn(async (): Promise<TripCommandResult> => ({
      ok: false, kind: 'unavailable', detail: 'network error',
    }));
    const r2 = await render(
      <TripCrewPresenceCard tripId={TRIP_ID} load={loader(board([]))} set={lost as any} />,
    );
    fireEvent.press(await r2.findByTestId('presence-set-available'));
    expect(await r2.findByText(/couldn't tell whether that was recorded/)).toBeTruthy();
  });

  it('Stop sharing issues CLEAR_PRESENCE, not a presence state', async () => {
    const clear = jest.fn(async () => applied);
    const set = jest.fn(async () => applied);
    const { findByTestId } = await render(
      <TripCrewPresenceCard tripId={TRIP_ID} load={loader(board([]))} set={set as any} clear={clear as any} />,
    );
    fireEvent.press(await findByTestId('presence-clear'));
    await waitFor(() => expect(clear).toHaveBeenCalled());
    expect(set).not.toHaveBeenCalled();
  });
});

describe('presenceIdempotencyKey', () => {
  it('is derived from the OBSERVATION, so a double tap is one command', async () => {
    // A randomUUID() here would make every retry a new command and defeat the
    // kernel receipt that exists for exactly this.
    const a = presenceIdempotencyKey('t', 'at_plan', new Date('2026-10-01T12:00:10Z'));
    const b = presenceIdempotencyKey('t', 'at_plan', new Date('2026-10-01T12:00:50Z'));
    expect(a).toBe(b);
  });

  it('a different state, trip or minute is a different observation', () => {
    const base = presenceIdempotencyKey('t', 'at_plan', new Date('2026-10-01T12:00:00Z'));
    expect(presenceIdempotencyKey('t', 'resting', new Date('2026-10-01T12:00:00Z'))).not.toBe(base);
    expect(presenceIdempotencyKey('u', 'at_plan', new Date('2026-10-01T12:00:00Z'))).not.toBe(base);
    expect(presenceIdempotencyKey('t', 'at_plan', new Date('2026-10-01T12:01:00Z'))).not.toBe(base);
  });
});

describe('describeAge', () => {
  it('is coarse, and never invents precision it does not have', () => {
    expect(describeAge(30)).toBe('seen a moment ago');
    expect(describeAge(600)).toBe('seen 10 min ago');
    expect(describeAge(7200)).toBe('seen 2h ago');
    expect(describeAge(180000)).toBe('seen 2d ago');
  });

  it('a nonsensical age is said to be unknown, not rendered as zero', () => {
    expect(describeAge(-5)).toBe('age unknown');
    expect(describeAge(Number.NaN)).toBe('age unknown');
  });
});
