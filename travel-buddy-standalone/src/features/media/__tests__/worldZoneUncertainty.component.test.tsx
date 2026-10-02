/**
 * census-media §26, MD152 — §18 "When reports disagree, surface uncertainty
 * ('Mixed reports — conditions may be changing')" on every surface that renders
 * a §43 WorldZone, not only the Places lens's place view.
 *
 * The server has emitted `consensus.uncertaintyLabel` on every WorldZone since
 * 2026-09-14 (MediaProjectionService `buildWorldProjection`). The client's zone
 * mappers dropped it, so the NOW lens's city pulse, its "Changing now" cards
 * and the Places lens's zone list rendered a disputed zone exactly like an
 * undisputed one. A changing-now card is the case that matters most: it is a
 * zone WITH a live claim — the only kind that can be in material dispute — and
 * its crowd label still carries the plurality value under that dispute.
 */
import React from 'react';
import { render } from '@testing-library/react-native';
import { mapWorldProjection } from '../services/mediaProjection.ts';
import { MediaWorldScreen } from '../screens/MediaWorldScreen.tsx';
import { MediaPlacesScreen } from '../screens/MediaPlacesScreen.tsx';
import { MIXED_REPORTS_LABEL } from '../../../services/media/mediaIntelligence.ts';

const DISPUTED = '22222222-2222-4222-8222-222222222222';
const AGREED = '33333333-3333-4333-8333-333333333333';

function consensus(over: Record<string, unknown> = {}) {
  return {
    state: 'corroborated',
    corroboration: { level: 'corroborated', freshPerspectiveCount: 3, independentSourceCount: 2 },
    contradiction: null,
    uncertaintyLabel: null,
    requestAnotherObservation: false,
    ...over,
  };
}

const MIXED = consensus({
  state: 'mixed',
  contradiction: { state: 'material', claimTypes: ['crowd.level'], block: null },
  uncertaintyLabel: MIXED_REPORTS_LABEL,
  requestAnotherObservation: true,
});

/** The server's §43 WorldZone shape (MediaProjectionService `WorldZone`). */
function zone(placeId: string, label: string, c: unknown, live = false) {
  return {
    placeId,
    label,
    perspectiveCount: 5,
    freshness: 'fresh',
    liveClaims: live ? [{ claimType: 'crowd.level', value: 'busy', conflictState: 'material' }] : [],
    liveCrowdLabel: live ? 'busy' : null,
    consensus: c,
  };
}

function world() {
  const disputed = zone(DISPUTED, 'An Thuong', MIXED, true);
  const agreed = zone(AGREED, 'My Khe', consensus());
  return mapWorldProjection({
    city: 'Da Nang',
    generatedAt: '2026-09-26T10:00:00.000Z',
    cityVisualState: [disputed, agreed],
    forYouNow: [],
    changingNow: [disputed],
    totalPerspectives: 10,
  });
}

describe('MD152 — the zone mappers keep the server’s §18 line', () => {
  it('a mixed zone carries the line on the city pulse AND on its changing-now card; an agreeing zone carries none', () => {
    const w = world();
    expect(w.cityVisualState.map((z) => z.uncertaintyLabel)).toEqual([MIXED_REPORTS_LABEL, null]);
    expect(w.changingNow.map((c) => c.uncertaintyLabel)).toEqual([MIXED_REPORTS_LABEL]);
  });

  it('never invents one: an absent or unreadable consensus is no line; a `mixed` state without its label uses the §18 copy', () => {
    const w = mapWorldProjection({
      cityVisualState: [
        zone(AGREED, 'Absent', undefined),
        zone(AGREED, 'Garbage', { state: 'confident' }),
        zone(AGREED, 'Minor', consensus({ contradiction: { state: 'minor', claimTypes: ['crowd.level'], block: null } })),
        zone(DISPUTED, 'Unlabelled', consensus({ state: 'mixed' })),
      ],
    });
    expect(w.cityVisualState.map((z) => z.uncertaintyLabel)).toEqual([null, null, null, MIXED_REPORTS_LABEL]);
  });
});

describe('MD152 — every WorldZone surface renders it', () => {
  it('NOW lens: under the disputed zone’s city-pulse row and on its changing-now card, and nowhere else', async () => {
    const view = await render(
      <MediaWorldScreen
        state={{ status: 'ready', data: world(), loadedAt: 0, errorKind: null }}
        mode="overview"
      />,
    );
    expect(view.getByTestId(`zone-uncertainty-${DISPUTED}`).props.children).toBe(MIXED_REPORTS_LABEL);
    expect(view.queryByTestId(`zone-uncertainty-${AGREED}`)).toBeNull();
    expect(view.getByTestId(`changing-uncertainty-${DISPUTED}`).props.children).toBe(MIXED_REPORTS_LABEL);
    expect(view.getAllByText(MIXED_REPORTS_LABEL)).toHaveLength(2);
  });

  it('Places lens overview: under the disputed zone in the list, and nowhere else', async () => {
    const view = await render(<MediaPlacesScreen mode="overview" zones={world().cityVisualState} />);
    expect(view.getByTestId(`places-zone-uncertainty-${DISPUTED}`).props.children).toBe(MIXED_REPORTS_LABEL);
    expect(view.queryByTestId(`places-zone-uncertainty-${AGREED}`)).toBeNull();
    expect(view.getAllByText(MIXED_REPORTS_LABEL)).toHaveLength(1);
  });
});
