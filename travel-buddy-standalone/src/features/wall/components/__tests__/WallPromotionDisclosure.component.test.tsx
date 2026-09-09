/**
 * WallPromotionDisclosure — the client half of Wall spec §37:
 * "Paid/promoted content, if introduced later, is explicitly labeled and
 * separated from factual live confidence."
 *
 * THE SERVER ALREADY DID THE SEPARATING. `deriveWallTruthClass` maps the
 * `sponsored` / `imported_owned` source classes to a non-observation truth
 * class, so by the time a promotional claim reaches this tree it is already
 * incapable of rendering as an observation. What the server could not do is
 * TELL THE VIEWER, and that is what these tests are about.
 *
 * The client classifies nothing. `promotionLabel` is a server string rendered
 * verbatim; there is no client-side notion of "sponsored" to drift out of step
 * with the server's (Sensing S6: no client truth duplication). So every
 * assertion here is about PRESENCE, PLACEMENT and REACH — never about deciding.
 *
 * WHAT TURNS THIS RED
 *   • drop the disclosure Text from either component  -> the render tests fail;
 *   • drop it from the accessibility label            -> the screen-reader
 *     tests fail (a disclosure only a sighted user gets is not a disclosure);
 *   • render it AFTER the state word / truth qualifier -> the order tests fail;
 *   • paint it in the accent colour                    -> the styling test fails;
 *   • emit it on a non-promotional item                -> the absence tests fail.
 */

import React from 'react';
import { render, screen } from '@testing-library/react-native';

// NOTE: exhaustive-by-design mock, same as WallAccessibility.component.test.tsx.
// The Wall components pull wallAnalytics -> wallApi, whose real module loads the
// supabase/apiToken chain at import and crashes the suite, so requireActual is
// not an option here and the factory must list every export those paths touch.
jest.mock('../../services/wallApi.ts', () => ({
  fetchWall: jest.fn(),
  fetchLiveForYou: jest.fn(),
  fetchQuickMedia: jest.fn(),
  setSessionIntent: jest.fn(),
  clearSessionIntent: jest.fn(),
  sendImpression: jest.fn(),
  sendAction: jest.fn(),
  revalidateCachedObjects: jest.fn(async () => ({ ok: false, error: 'Network error' })),
}));

import { color } from '../../../../theme/tokens.ts';
import { LiveForYouStrip } from '../LiveForYouStrip.tsx';
import { ContextThreadView } from '../ContextThreadView.tsx';
import type { LiveForYouItem } from '../../types/liveForYou.ts';
import type { WallProjection } from '../../types/wallProjection.ts';

function liveItem(n: number, over: Partial<LiveForYouItem> = {}): LiveForYouItem {
  return {
    id: `live-${n}`,
    liveObjectType: 'place_state',
    subjectId: `place-${n}`,
    subject: { placeId: `place-${n}`, name: `Place ${n}` },
    label: `Getting busier ${n}`,
    freshness: 'live',
    state: 'live',
    // A promotional claim can only arrive with a non-observation truth class —
    // the server guarantees it — so the fixture uses the class the server would
    // actually have produced rather than an impossible `observed`.
    truthClass: 'inferred',
    coverage: 'unknown',
    observedAt: new Date().toISOString(),
    validUntil: new Date(Date.now() + 60_000).toISOString(),
    ...over,
  };
}

function projection(): WallProjection {
  return {
    projectionId: 'wall_social_post_p1',
    objectType: 'social_post',
    canonicalObjectId: 'p1',
    publishedAt: '2026-09-04T00:00:00.000Z',
    visibility: 'public',
    actions: [],
  } as WallProjection;
}

describe('§37 — the Live strip discloses a promotional claim', () => {
  it('renders the server label as text on the card', async () => {
    await render(
      <LiveForYouStrip items={[liveItem(1, { promotionLabel: 'Sponsored' })]} />,
    );
    expect(screen.getByTestId('wall-live-promotion-live-1').props.children).toBe('Sponsored');
  });

  it('speaks it FIRST in the card label, before the state word', async () => {
    // The card is one focusable unit, so a disclosure that is not in its label
    // is a disclosure a screen-reader user never receives. First, because it
    // changes how everything after it should be heard.
    await render(
      <LiveForYouStrip items={[liveItem(1, { promotionLabel: 'Sponsored' })]} />,
    );
    const label = String(screen.getByTestId('wall-live-item-live-1').props.accessibilityLabel);
    expect(label.startsWith('Sponsored. ')).toBe(true);
    expect(label.indexOf('Sponsored')).toBeLessThan(label.indexOf('Getting busier 1'));
  });

  it('renders NOTHING for an ordinary item — absence of a label, not a label of absence', async () => {
    await render(<LiveForYouStrip items={[liveItem(1, { truthClass: 'observed' })]} />);
    expect(screen.queryByTestId('wall-live-promotion-live-1')).toBeNull();
    expect(
      String(screen.getByTestId('wall-live-item-live-1').props.accessibilityLabel),
    ).not.toContain('Sponsored');
  });

  it('is not painted in the accent colour', async () => {
    // §35: the accent is an interaction colour. A sponsored card must not be the
    // most eye-catching thing in the strip — disclosure, not promotion.
    await render(
      <LiveForYouStrip items={[liveItem(1, { promotionLabel: 'Sponsored' })]} />,
    );
    const style = screen.getByTestId('wall-live-promotion-live-1').props.style;
    const flat = Array.isArray(style) ? Object.assign({}, ...style) : style;
    expect(flat.color).not.toBe(color.signal);
    expect(flat.color).toBe(color.mute);
  });
});

describe('§37 — a Context Thread discloses a promotional claim', () => {
  const thread = (over: Record<string, unknown> = {}) =>
    ({
      kind: 'live_place' as const,
      label: 'Busy right now',
      freshness: 'live' as const,
      truthClass: 'inferred' as const,
      action: {
        type: 'see_place' as const,
        label: 'See place',
        targetType: 'place' as const,
        targetId: 'x',
      },
      ...over,
    });

  it('renders the server label alongside the thread', async () => {
    await render(
      <ContextThreadView
        thread={thread({ promotionLabel: 'Sponsored' }) as never}
        projection={projection()}
      />,
    );
    expect(screen.getByTestId('wall-context-promotion-live_place')).toBeTruthy();
  });

  it('announces it before the truth qualifier', async () => {
    await render(
      <ContextThreadView
        thread={thread({ promotionLabel: 'Sponsored' }) as never}
        projection={projection()}
      />,
    );
    const label = String(
      screen.getByTestId('wall-context-live_place').props.accessibilityLabel,
    );
    // Both are present, and "who is telling you this" comes before "how sure".
    expect(label).toContain('Sponsored');
    expect(label).toContain('Inferred');
    expect(label.indexOf('Sponsored')).toBeLessThan(label.indexOf('Inferred'));
  });

  it('renders nothing for an ordinary thread', async () => {
    await render(
      <ContextThreadView thread={thread() as never} projection={projection()} />,
    );
    expect(screen.queryByTestId('wall-context-promotion-live_place')).toBeNull();
  });
});
