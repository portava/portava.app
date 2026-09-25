/**
 * census-layover L127 / L128 / L294 — THE PRESENCE COUNT IS EITHER A
 * MEASUREMENT OR IT IS NOT, AND THE CARD MUST SAY WHICH.
 *
 * `GET /api/airport/sessions/:id/presence` has published four fields beyond
 * the count since the privacy-guard pass, and this card read none of them:
 *
 *   `degraded`         the count is NOT a measurement — a read fell closed
 *   `degradedReasons`  which read (`presence_unreadable`, `blocks_unreadable`,
 *                      `sharing_preferences_unreadable`, `presence_threw`)
 *   `withheld`         the traveller's OWN stored settings suppressed it
 *                      (`sharing_paused` | `location_mode_off` | `ghost_mode`)
 *   `level`            the §14 rung actually served
 *
 * (artifacts/api-server/src/services/airport/LayoverPrivacyGuard.ts:468
 *  `disclosePresence`; artifacts/api-server/src/routes/airport.ts:3272.)
 *
 * The server's own comment on `cityPresence` says why it publishes them:
 * *"a refusal caused by an UNREADABLE TABLE is now distinguishable from a
 * measured zero … Before this, an outage rendered as 'nobody else is here'."*
 * The client then rendered `count: 0` as the sentence
 * **"No other shared layovers here right now — you're the first."** — which is
 * an affirmative claim about a city, restored on the client from a refusal the
 * server had gone to some trouble to make.
 *
 * ── WHAT WOULD TURN THIS RED ─────────────────────────────────────────────────
 * Case 2 is the guard against "fixing" this by deleting the sentence: a
 * genuinely measured zero must still say "you're the first", because that is
 * true and useful. A card that never makes the claim fails case 2; a card that
 * always makes it fails cases 1, 3 and 4.
 *
 * The split between cases 3 and 4 is the SERVER's, not this card's:
 * `disclosePresence` sets `degraded` from `gate.degraded`, which is true
 * exactly when an input was the closed FALLBACK rather than the stored value
 * (`readTripGhostMode` returns `{ghostMode: true, degraded: true}` on an
 * unreadable table). So `withheld` with `degraded: false` is the traveller's
 * own switch, and `degraded: true` is a read that did not happen. This card
 * re-derives neither.
 */
import React from 'react';
import { render, screen } from '@testing-library/react-native';

import { LayoverPeopleSection } from '../LayoverPeopleSection.tsx';

const FIRST = /you're the first/i;

async function renderCard(presence: React.ComponentProps<typeof LayoverPeopleSection>['presence']) {
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

describe('LayoverPeopleSection — a refusal is not a measured zero', () => {
  it('1. an unreadable presence table does NOT read as "you\'re the first"', async () => {
    await renderCard({
      // Gate ALLOWED, so the route served: sharing true, count degraded.
      sharing: true,
      count: 0,
      travelers: [],
      degraded: true,
      degradedReasons: ['presence_unreadable'],
      withheld: [],
    });

    expect(screen.queryByText(FIRST)).toBeNull();
    expect(screen.getByTestId('layover-presence-unmeasured')).toBeTruthy();
  });

  it('2. a MEASURED zero still says "you\'re the first"', async () => {
    await renderCard({
      sharing: true,
      count: 0,
      travelers: [],
      degraded: false,
      degradedReasons: [],
      withheld: [],
    });

    expect(screen.getByText(FIRST)).toBeTruthy();
    expect(screen.queryByTestId('layover-presence-unmeasured')).toBeNull();
    expect(screen.queryByTestId('layover-presence-withheld')).toBeNull();
  });

  it('3. the traveller\'s own sharing switch is named, not rendered as an empty city', async () => {
    await renderCard({
      // The gate REFUSED on a stored setting, so the route serves sharing:false.
      sharing: false,
      count: 0,
      travelers: [],
      degraded: false,
      degradedReasons: [],
      withheld: ['ghost_mode'],
    });

    expect(screen.queryByText(FIRST)).toBeNull();
    expect(screen.getByTestId('layover-presence-withheld')).toBeTruthy();
    // It is the traveller's setting, so it must NOT be reported as a failure.
    expect(screen.queryByTestId('layover-presence-unmeasured')).toBeNull();
  });

  it('4. a gate that FELL CLOSED is a failed read, not a setting the traveller chose', async () => {
    // `preferences_unreadable` arrives with degraded: true — the stored value
    // was never read. Telling the traveller "your settings are hiding you"
    // would be a statement about a setting nobody looked at.
    await renderCard({
      // The gate REFUSED (fail-closed), so the route serves sharing:false.
      sharing: false,
      count: 0,
      travelers: [],
      degraded: true,
      degradedReasons: [],
      withheld: ['preferences_unreadable'],
    });

    expect(screen.queryByText(FIRST)).toBeNull();
    expect(screen.getByTestId('layover-presence-unmeasured')).toBeTruthy();
    expect(screen.queryByTestId('layover-presence-withheld')).toBeNull();
  });

  it('4b. a NON-ZERO count with no confidence behind it is still not claimed', async () => {
    // The screen passes `presence.count || overview.share.othersInCity`, so a
    // degraded answer can arrive here carrying a number — a count from the
    // OVERVIEW route's separate `disclosePresence` call, which says nothing
    // about whether THIS read succeeded. `degraded` governs the count, not its
    // magnitude, and this is the case that says so.
    await renderCard({
      sharing: true,
      count: 2,
      travelers: [],
      degraded: true,
      degradedReasons: ['presence_threw'],
      withheld: [],
    });

    expect(screen.queryByText(/2 travelers are also on a layover here/i)).toBeNull();
    expect(screen.queryByText(FIRST)).toBeNull();
    expect(screen.getByTestId('layover-presence-unmeasured')).toBeTruthy();
  });

  it('4c. a NON-ZERO count the traveller\'s own switch withheld is not claimed either', async () => {
    await renderCard({
      sharing: false,
      count: 2,
      travelers: [],
      degraded: false,
      degradedReasons: [],
      withheld: ['sharing_paused'],
    });

    expect(screen.queryByText(/2 travelers are also on a layover here/i)).toBeNull();
    expect(screen.getByTestId('layover-presence-withheld')).toBeTruthy();
  });

  it('5. a real measured count is still rendered as a count', async () => {
    await renderCard({
      sharing: true,
      count: 3,
      travelers: [],
      degraded: false,
      degradedReasons: [],
      withheld: [],
    });

    expect(screen.getByText(/3 travelers are also on a layover here/i)).toBeTruthy();
    expect(screen.queryByText(FIRST)).toBeNull();
  });
});
