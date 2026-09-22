/**
 * census-layover L128 — THE RUNG THE SERVER SERVED IS THE RUNG THE CARD SHOWS.
 *
 * `disclosePresence` publishes `level` — the §14 rung it actually served —
 * and it is the ONLY field that says whether identities were part of the
 * answer (artifacts/api-server/src/services/airport/LayoverPrivacyGuard.ts:468):
 *
 *   gate refuses / not opted in   → L0_AGGREGATE, sharing:false, no travellers
 *   gate allows, LADDER ON        → L0_AGGREGATE, sharing:true, count ONLY
 *   gate allows, LADDER OFF       → L2_DISCOVERY, count + up to six profiles
 *
 * `services/layover.ts` has parsed `level` off the wire since the privacy-guard
 * pass and NOTHING read it. The card rendered `travelers.slice(0, 6)` whenever
 * the count was claimable, so the identity rung was decided by whether an array
 * happened to be non-empty rather than by the server's statement about it.
 *
 * ── WHAT WOULD TURN THIS RED ─────────────────────────────────────────────────
 * Case 1 is the load-bearing one and it is deliberately CONTRADICTORY input:
 * `level: 'L0_AGGREGATE'` arriving WITH a non-empty `travelers` array. Today's
 * server never sends that pair, and that is exactly why the card must be pinned
 * against it — the rung must be read off `level`, not inferred from the array,
 * so that a server which later starts populating both cannot silently promote
 * an aggregate answer into a discovery one on the last hop. A card that keys
 * on `travelers.length` passes every other case here and fails this one.
 *
 * Case 2 pins the behaviour actually in force. `layover_presence_ladder_enabled`
 * is seeded FALSE and migration 2740 is UNAPPLIED, so every production
 * response today is L2_DISCOVERY. The ladder is IMPLEMENTED AND NOT IN FORCE;
 * this suite covers both rungs so that turning the flag on is a server
 * decision and not a client change.
 *
 * Case 3 is the compatibility rung: a server that predates the guard sends no
 * `level` at all. It gets the pre-existing behaviour — no claim is made about a
 * rung nobody stated.
 *
 * NOTHING HERE RE-DERIVES A RUNG. `level` is read; it is never computed from
 * `count`, `sharing`, `withheld` or the length of `travelers`.
 */
import React from 'react';
import { render, screen } from '@testing-library/react-native';

import { LayoverPeopleSection } from '../LayoverPeopleSection.tsx';
import type { LayoverPresenceAnswer } from '../../../services/layover.ts';

const TRAVELERS = [
  { id: 'u1', handle: 'ana', name: 'Ana', avatarUrl: null },
  { id: 'u2', handle: 'bo', name: 'Bo', avatarUrl: null },
];

async function renderCard(presence: LayoverPresenceAnswer) {
  return await render(
    <LayoverPeopleSection
      city="Bangkok"
      shareEnabled
      shareBusy={false}
      presence={presence}
      buddies={[]}
      canEdit
      onToggleShare={() => {}}
      onOpenBuddy={() => {}}
    />,
  );
}

describe('LayoverPeopleSection — §14 progressive disclosure, L128', () => {
  it('1. an L0_AGGREGATE answer shows the COUNT and no identities, even when profiles arrive with it', async () => {
    await renderCard({
      sharing: true,
      count: 3,
      // Contradictory on purpose — see the header.
      travelers: TRAVELERS,
      level: 'L0_AGGREGATE',
      degraded: false,
      degradedReasons: [],
      withheld: [],
    });

    // The count is a claim the server DID make at this rung.
    expect(screen.getByText(/3 travelers are also on a layover here/i)).toBeTruthy();
    // The identities are a claim it did NOT.
    expect(screen.queryByTestId('layover-presence-travelers')).toBeNull();
    // And the card says which rung it is standing on rather than leaving the
    // absence of faces to look like an empty city.
    expect(screen.getByTestId('layover-presence-aggregate-only')).toBeTruthy();
  });

  it('2. an L2_DISCOVERY answer shows the identities the server served', async () => {
    await renderCard({
      sharing: true,
      count: 2,
      travelers: TRAVELERS,
      level: 'L2_DISCOVERY',
      degraded: false,
      degradedReasons: [],
      withheld: [],
    });

    expect(screen.getByTestId('layover-presence-travelers')).toBeTruthy();
    expect(screen.queryByTestId('layover-presence-aggregate-only')).toBeNull();
    expect(screen.getByText(/2 travelers are also on a layover here/i)).toBeTruthy();
  });

  it('3. a server that publishes no rung is not given one — the pre-guard behaviour stands', async () => {
    await renderCard({
      sharing: true,
      count: 2,
      travelers: TRAVELERS,
      // `level` absent: an older server. No rung was stated.
      degraded: false,
      degradedReasons: [],
      withheld: [],
    });

    expect(screen.getByTestId('layover-presence-travelers')).toBeTruthy();
    expect(screen.queryByTestId('layover-presence-aggregate-only')).toBeNull();
  });

  it('4. the rung never overrides an UNMEASURED answer — a refusal outranks a level', async () => {
    // L0_AGGREGATE is also what the route serves when the gate refused. A
    // degraded answer must keep reading as "we could not check", not as the
    // aggregate rung working correctly.
    await renderCard({
      sharing: true,
      count: 0,
      travelers: [],
      level: 'L0_AGGREGATE',
      degraded: true,
      degradedReasons: ['presence_unreadable'],
      withheld: [],
    });

    expect(screen.getByTestId('layover-presence-unmeasured')).toBeTruthy();
    expect(screen.queryByTestId('layover-presence-aggregate-only')).toBeNull();
    expect(screen.queryByText(/you're the first/i)).toBeNull();
  });
});
