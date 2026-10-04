/**
 * census-layover L273 / L254 / L294 — THE BUDDY LIST SAYS WHY IT IS SHORT.
 *
 * `LayoverPeopleSection` rendered the Rent-a-Buddy row only when
 * `buddies.length > 0` and nothing otherwise, so five different answers left
 * the screen identically — as no section at all:
 *
 *   the read failed (503 / offline)          → the dashboard stored `[]`
 *   the certified window refused (verdict)   → `reason: safety_gate_not_passed`
 *   the marketplace is switched off          → `reason: rent_buddy_not_enabled`
 *   the block list could not be read         → `degraded`, nobody served
 *   nobody is listed in this city            → a measured empty list
 *
 * Only the last is "there is nobody", and even that the card does not claim
 * (the list is the top of a bounded page, not a census of the city). The other
 * four are reasons a traveller can act on — wait, retry, or head back — and
 * the gate's refusal is the safety answer the server computed precisely so a
 * traveller who cannot leave is not handed people to go and meet.
 *
 * And `availableDuringLayover` is `boolean | null` on the wire: `null` means
 * nobody could check. Rendered through a truthiness test it looked exactly
 * like `false` (census §23.8). A "free during your layover" badge is only ever
 * drawn for a measured `true`, and an unmeasured availability says so.
 */
import React from 'react';
import { render, screen } from '@testing-library/react-native';

import { LayoverPeopleSection } from '../LayoverPeopleSection.tsx';
import type { LayoverBuddiesAnswer, LayoverBuddy } from '../../../services/layover.ts';

const BUDDY: LayoverBuddy = {
  id: 'b-1', userId: 'u-9', displayName: 'Mai', tagline: null, city: 'Bangkok', country: 'Thailand',
  categories: ['city'], hourlyRateUsd: 20, averageRating: 4.8, reviewCount: 12, verified: true,
  coverPhotoUrl: null, buddyLevel: 'pro', availableNow: false, availableDuringLayover: true,
};

const OPEN_GATE = { passed: true, verdict: 'yes', usableMinutes: 240, returnState: 'NORMAL' } as const;

function measured(over: Partial<Extract<LayoverBuddiesAnswer, { ok: true }>> = {}): LayoverBuddiesAnswer {
  return {
    ok: true, city: 'Bangkok', buddies: [BUDDY], refusal: null,
    safetyGate: OPEN_GATE, trustRequirement: { applied: false, reason: null, requires: [] },
    degraded: false, degradedReasons: [], ...over,
  };
}

async function renderCard(buddies: LayoverBuddiesAnswer | null) {
  return await render(
    <LayoverPeopleSection
      city="Bangkok"
      shareEnabled={false}
      shareBusy={false}
      presence={{ sharing: false, count: 0, travelers: [], degraded: false, degradedReasons: [], withheld: [] }}
      buddies={buddies}
      canEdit
      onToggleShare={() => {}}
      onOpenBuddy={() => {}}
    />,
  );
}

describe('LayoverPeopleSection — the buddy list is an answer, or it says why not', () => {
  it('1. a FAILED read says so — it is not an empty marketplace', async () => {
    await renderCard({ ok: false, message: 'Local buddies could not be loaded. Please try again.' });
    expect(screen.getByTestId('layover-buddies-unavailable')).toBeTruthy();
    expect(screen.getByText('Local buddies could not be loaded. Please try again.')).toBeTruthy();
    expect(screen.queryByText('Mai')).toBeNull();
  });

  it('2. the SAFETY GATE\'s refusal is explained from its certified verdict', async () => {
    await renderCard(measured({
      buddies: [], refusal: 'safety_gate_not_passed',
      safetyGate: { passed: false, verdict: 'no', usableMinutes: 20, returnState: 'NORMAL' },
    }));
    const gate = screen.getByTestId('layover-buddies-gate');
    expect(gate).toBeTruthy();
    expect(screen.getByText(/not enough time to leave the airport/i)).toBeTruthy();
  });

  it('3. a traveller already due back is told that is why — not that nobody is here', async () => {
    await renderCard(measured({
      buddies: [], refusal: 'safety_gate_not_passed',
      safetyGate: { passed: false, verdict: 'yes', usableMinutes: 50, returnState: 'RETURN_SOON' },
    }));
    expect(screen.getByTestId('layover-buddies-gate')).toBeTruthy();
    expect(screen.getByText(/time to head back/i)).toBeTruthy();
  });

  it('4. the marketplace switched OFF is said plainly', async () => {
    await renderCard(measured({ buddies: [], refusal: 'rent_buddy_not_enabled' }));
    expect(screen.getByTestId('layover-buddies-off')).toBeTruthy();
  });

  it('5. an unreadable block list served nobody ON PURPOSE — and says that is not a count', async () => {
    await renderCard(measured({ buddies: [], degraded: true, degradedReasons: ['blocks_unreadable'] }));
    expect(screen.getByTestId('layover-buddies-unmeasured')).toBeTruthy();
  });

  it('6. an UNMEASURED availability draws no "free" badge and says it was not checked', async () => {
    await renderCard(measured({
      buddies: [{ ...BUDDY, availableDuringLayover: null }],
      degraded: true, degradedReasons: ['buddy_availability_unreadable'],
    }));
    expect(screen.getByText('Mai')).toBeTruthy();
    // Exact text: the BADGE reads exactly this; the caption below merely mentions it.
    expect(screen.queryByText('free during your layover')).toBeNull();
    expect(screen.getByTestId('layover-buddies-availability-unknown')).toBeTruthy();
  });

  it('7. a TIGHT window explains why only verified buddies are shown', async () => {
    await renderCard(measured({
      safetyGate: { passed: true, verdict: 'tight', usableMinutes: 60, returnState: 'NORMAL' },
      trustRequirement: { applied: true, reason: 'tight_window', requires: ['verified', 'buddy_level_not_new'] },
    }));
    expect(screen.getByText('Mai')).toBeTruthy();
    expect(screen.getByTestId('layover-buddies-verified-only')).toBeTruthy();
  });

  it('8. CONTROL: a measured list with measured availability shows the badge and no caveat', async () => {
    await renderCard(measured());
    expect(screen.getByText('Mai')).toBeTruthy();
    expect(screen.getByText('free during your layover')).toBeTruthy();
    for (const id of ['layover-buddies-unavailable', 'layover-buddies-gate', 'layover-buddies-off',
      'layover-buddies-unmeasured', 'layover-buddies-availability-unknown', 'layover-buddies-verified-only']) {
      expect(screen.queryByTestId(id)).toBeNull();
    }
  });

  it('9. CONTROL: a measured EMPTY list claims nothing — no section, no "nobody here"', async () => {
    await renderCard(measured({ buddies: [] }));
    expect(screen.queryByText(/Local buddies for a few hours/i)).toBeNull();
    expect(screen.queryByText(/no (local )?buddies/i)).toBeNull();
    expect(screen.queryByTestId('layover-buddies-unavailable')).toBeNull();
  });

  it('10. CONTROL: before the first read nothing is claimed either way', async () => {
    await renderCard(null);
    expect(screen.queryByTestId('layover-buddies-unavailable')).toBeNull();
    expect(screen.queryByText(/Local buddies for a few hours/i)).toBeNull();
  });
});
