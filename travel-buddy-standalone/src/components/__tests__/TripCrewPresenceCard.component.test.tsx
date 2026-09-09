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
import { render, waitFor } from '@testing-library/react-native';

import { TripCrewPresenceCard, describeAge } from '../trip/TripCrewPresenceCard.tsx';
import type { PresenceRead, PresenceEntry } from '../../services/tripPresence.ts';

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
