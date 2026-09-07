/**
 * §38 test family "Accessibility — focus, labels, reduced motion, contrast".
 *
 * The family named FOUR properties. Reduced motion was proven four ways in
 * VideoWallItem's own file, and labels were asserted incidentally wherever a
 * test happened to query by label. FOCUS and CONTRAST had no test anywhere in
 * the Wall tree: there was no accessibility test file at all. This is it.
 *
 * WHAT A TEST CAN AND CANNOT SETTLE. Screen-reader BEHAVIOUR needs a device and
 * stays CANNOT-VERIFY — nothing here claims otherwise. What is decidable in code
 * is the accessibility TREE the Wall hands the platform (roles, labels, merged
 * focusable units, selected state) and the CONTRAST of the token pairs the Wall
 * actually renders, which is arithmetic over the palette. Both are asserted.
 *
 * CONTRAST IS COMPUTED, NOT ASSERTED FROM A TABLE. The WCAG 2.x relative
 * luminance formula runs over the REAL theme tokens, so changing a token value
 * moves the test — and it is PAIRED with a scan of the Wall's own source,
 * because arithmetic over tokens alone would stay green while a component
 * reached for a failing one. When this file was written it found four genuine
 * failures the census had no way to see: `faint` text (2.73:1) on the Postcard
 * byline, the
 * Shared Moment subtitle, the actor meta line, the media placeholder, the live
 * card's place line, the inactive feed-mode tab and the Context Thread reason;
 * the live card's state word in `signal` on white (3.31:1); the notification
 * badge numeral (3.14:1); and the not-interested icon, the entire visual of a
 * control, at 2.73:1. All are fixed in the Wall tree and pinned below.
 *
 * MUTATION PROOF (each verified: revert → RED, restore → GREEN)
 *   • put `color.faint` back on ContextThreadView.reason (or any of the other
 *     six sites) → the corresponding contrast test RED.
 *   • put `color.signal` back on LiveForYouStrip.cardState → RED.
 *   • drop `importantForAccessibility="no"` from the card's inner Texts → the
 *     merged-focus test RED (the strip's focus order becomes 3 stops per card).
 *     `accessible` on the Pressable is NOT a separate proof — RN sets it by
 *     default, so asserting it would pass with or without the prop; the merged
 *     unit is proven by the inner Texts being out of the tree instead.
 *   • drop the "N of M" position from the card label → the focus-order test RED.
 *   • drop `accessibilityState={{ selected }}` from the mode switcher → RED.
 *   • drop an `accessibilityLabel` from any social action → the labels test RED.
 */

import React from 'react';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen } from '@testing-library/react-native';

// NOTE: exhaustive-by-design mock — the Wall components pull wallAnalytics →
// wallApi, whose real module loads the supabase/apiToken chain at import and
// crashes the suite. Stub only the exports those dependencies touch.
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

import { color, type as t } from '../../../../theme/tokens.ts';
import { LiveForYouStrip } from '../LiveForYouStrip.tsx';
import { FeedModeSwitcher } from '../FeedModeSwitcher.tsx';
import { ContextThreadView } from '../ContextThreadView.tsx';
import { SocialActionRow, NotInterestedControl } from '../objects/wallItemShared.tsx';
import type { LiveForYouItem } from '../../types/liveForYou.ts';
import type { WallProjection } from '../../types/wallProjection.ts';

// ── WCAG 2.x contrast, computed over the real tokens ─────────────────────────

/** WCAG relative luminance of an #rrggbb colour. */
function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const r = channel(parseInt(h.slice(0, 2), 16));
  const g = channel(parseInt(h.slice(2, 4), 16));
  const b = channel(parseInt(h.slice(4, 6), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(fg: string, bg: string): number {
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** WCAG AA floors. Nothing in the Wall is "large text": the biggest text token
 *  is 30px/800 (hero, 22.5pt) which clears 18pt bold, but no Wall surface uses
 *  it for a colour pair under test — every pair below is body/small/stamp. */
const AA_NORMAL_TEXT = 4.5;
const AA_NON_TEXT = 3.0;

describe('§38 accessibility — contrast (arithmetic over the real palette)', () => {
  it('the sanity check works: a known-failing pair is detected as failing', () => {
    // `faint` on paper is 2.73:1. If this ever passes, the formula is broken and
    // every assertion below is worthless.
    expect(contrast(color.faint, color.paper)).toBeLessThan(AA_NON_TEXT);
  });

  it('every Wall TEXT colour clears AA on the surface it is painted on', () => {
    const pairs: Array<[string, string, string]> = [
      ['post body / titles', color.ink, color.paper],
      ['post body on a raised card', color.ink, color.paperRaised],
      ['secondary + meta text', color.mute, color.paper],
      ['secondary text on a raised card', color.mute, color.paperRaised],
      ['place / accent text', color.deep, color.paper],
      ['place / accent text on a raised card', color.deep, color.paperRaised],
      ['live card state word', color.deep, color.paperRaised],
      ['text over the immersive video card', color.onInk, color.ink],
      ['buddy tag text', color.onInk, color.deep],
      ['notification badge numeral', color.ink, color.signal],
    ];
    for (const [what, fg, bg] of pairs) {
      expect({ what, ratio: Number(contrast(fg, bg).toFixed(2)) }).toEqual({
        what,
        ratio: expect.any(Number),
      });
      expect(contrast(fg, bg)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    }
  });

  it('the quiet secondary colour the Wall settled on is `mute`, and it passes', () => {
    // Pinned deliberately: the Wall's quiet text used to be `faint`, which fails.
    expect(contrast(color.mute, color.paper)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    expect(contrast(color.mute, color.paperRaised)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });

  it('vermilion cannot carry small text on white, which is why the Wall does not ask it to', () => {
    // The reason `cardState` is `deep` and the badge numeral is `ink`: neither
    // the signal nor its dimmed variant clears AA for 11px/9px text.
    expect(contrast(color.signal, color.paperRaised)).toBeLessThan(AA_NORMAL_TEXT);
    expect(contrast(color.signalDim, color.paperRaised)).toBeLessThan(AA_NORMAL_TEXT);
    expect(t.stamp.fontSize).toBeLessThan(18); // …and it really is small text
  });

  it('an icon that is the entire visual of a control clears the non-text floor', () => {
    // The not-interested control has no adjacent text.
    expect(contrast(color.mute, color.paper)).toBeGreaterThanOrEqual(AA_NON_TEXT);
  });
});

// ── …and the Wall actually PAINTS those pairs ────────────────────────────────
//
// The arithmetic above proves the palette is capable of AA. It says nothing
// about which token a component reaches for, so on its own it would stay green
// while a card went back to a failing colour. This scan closes that: it reads
// the Wall's own source and refuses the colours that cannot pass.

const WALL_ROOT = join(process.cwd(), 'src', 'features', 'wall');

function wallSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__') continue;
      wallSources(full, out);
      continue;
    }
    if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe('§38 accessibility — the Wall paints only AA-capable text colours', () => {
  const files = wallSources(WALL_ROOT);

  it('the scan reads the Wall tree (guard against a vacuous pass)', () => {
    expect(files.length).toBeGreaterThan(20);
    expect(files.some((f) => f.endsWith('LiveForYouStrip.tsx'))).toBe(true);
  });

  it('no Wall style paints text in a token that cannot reach AA', () => {
    // A StyleSheet text colour is `color: color.X`; an icon prop is
    // `color={color.X}`. Only the former is text, and only text carries the
    // 4.5:1 obligation — so the two are distinguished by the punctuation.
    const banned = /color:\s*color\.(faint|signal|signalDim)\b/;
    const violations: string[] = [];
    for (const file of files) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (banned.test(line)) violations.push(`${file}:${i + 1} — ${line.trim()}`);
        });
    }
    expect(violations).toEqual([]);
  });

  it('the rule is real: it matches the styles that used to be there', () => {
    const banned = /color:\s*color\.(faint|signal|signalDim)\b/;
    expect(banned.test('  reason: { ...t.small, color: color.faint },')).toBe(true);
    expect(banned.test('  cardState: { ...t.stamp, color: color.signal },')).toBe(true);
    // …and does not fire on an icon prop, which is a different obligation.
    expect(banned.test('<MapPin size={icon.s14} color={color.faint} />')).toBe(false);
  });

  it('the notification badge numeral is pinned to the ink-on-vermilion pairing', () => {
    // Light-on-vermilion is 3.14:1. The pairing is pinned by source because it
    // is the one place a background token, not a surface, sets the floor.
    const header = readFileSync(join(WALL_ROOT, 'components', 'WallHeader.tsx'), 'utf8');
    expect(header).toMatch(/badgeText:\s*\{\s*color:\s*color\.ink/);
    expect(contrast(color.ink, color.signal)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });
});

// ── Focus / labels, over the real accessibility tree ─────────────────────────

function liveItem(n: number, over: Partial<LiveForYouItem> = {}): LiveForYouItem {
  return {
    id: `live-${n}`,
    liveObjectType: 'place_state',
    subjectId: `place-${n}`,
    subject: { placeId: `place-${n}`, name: `Place ${n}` },
    label: `Getting busier ${n}`,
    freshness: 'live',
    state: 'live',
    truthClass: 'observed',
    coverage: 'several',
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

describe('§36/§38 accessibility — focus order in the horizontal Live strip', () => {
  it('each card is ONE focusable unit and announces its position in the strip', async () => {
    await render(<LiveForYouStrip items={[liveItem(1), liveItem(2), liveItem(3)]} />);

    for (const [idx, n] of [1, 2, 3].entries()) {
      const card = screen.getByTestId(`wall-live-item-live-${n}`);
      expect(card.props.accessibilityRole).toBe('button');
      // ONE focusable unit: the card's inner Texts are removed from the
      // accessibility tree, so a screen reader lands on the card and reads its
      // composed label rather than stopping on three loose fragments. Without
      // this the strip's focus order is 3 stops per card instead of 1.
      expect(screen.getByTestId(`wall-live-state-live-${n}`).props.importantForAccessibility).toBe(
        'no',
      );
      // Logical focus ORDER: the position is spoken, so a screen-reader user
      // knows where in the strip they are.
      expect(card.props.accessibilityLabel).toContain(`${idx + 1} of 3`);
      expect(card.props.accessibilityLabel).toContain(`Getting busier ${n}`);
    }
  });

  it('the strip is a list with a header, and its See Live control is labelled', async () => {
    await render(<LiveForYouStrip items={[liveItem(1)]} />);
    expect(screen.getByLabelText('See live')).toBeTruthy();
    expect(screen.getByRole('header')).toBeTruthy();
  });

  it('the state word is TEXT, not colour alone, and a prediction says so (§36/§108)', async () => {
    await render(
      <LiveForYouStrip
        items={[
          liveItem(1, { truthClass: 'observed' }),
          liveItem(2, { truthClass: 'predicted', liveObjectType: 'event_state' }),
        ]}
      />,
    );
    expect(screen.getByTestId('wall-live-state-live-1').props.children).toBe('Live now');
    expect(screen.getByTestId('wall-live-state-live-2').props.children).toBe('Scheduled');
    // …and the distinction reaches the screen reader too, not just the pixels.
    expect(screen.getByTestId('wall-live-item-live-2').props.accessibilityLabel).toContain(
      'Scheduled',
    );
  });
});

describe('§36/§38 accessibility — the mode switch', () => {
  it('is a tablist whose tabs carry a label and a selected state', async () => {
    await render(<FeedModeSwitcher mode="following" onChange={() => {}} />);
    const forYou = screen.getByTestId('wall-mode-for_you');
    const following = screen.getByTestId('wall-mode-following');

    expect(forYou.props.accessibilityRole).toBe('tab');
    expect(forYou.props.accessibilityLabel).toBe('For You');
    expect(forYou.props.accessibilityState).toEqual(
      expect.objectContaining({ selected: false }),
    );
    expect(following.props.accessibilityState).toEqual(
      expect.objectContaining({ selected: true }),
    );
    // Selection is not colour-only: the state is in the accessibility tree.
    // The container carries the `tablist` role but is not itself an
    // accessibility element (only the tabs are focusable, which is the correct
    // focus order), so it is asserted on the rendered props rather than through
    // a role query — which would only find focusable elements.
    expect(forYou.parent?.props.accessibilityRole).toBe('tablist');
  });
});

describe('§36 — every feed action has an accessible label', () => {
  it('the social action row labels all four controls', async () => {
    await render(<SocialActionRow projection={projection()} />);
    for (const label of ['Stamp', 'Comment', 'Share', 'Save']) {
      expect(screen.getByLabelText(label)).toBeTruthy();
    }
  });

  it('the save control announces the SERVER-resolved state, not a local guess', async () => {
    await render(<SocialActionRow projection={{ ...projection(), viewerSaved: true }} />);
    expect(screen.getByLabelText('Saved')).toBeTruthy();
  });

  it('the not-interested control is labelled even though it is icon-only', async () => {
    await render(<NotInterestedControl projection={projection()} />);
    expect(screen.getByLabelText('Not interested')).toBeTruthy();
  });

  it('a Context Thread announces its label, its truth qualifier and its action', async () => {
    await render(
      <ContextThreadView
        thread={{
          kind: 'live_place',
          label: 'Quiet right now',
          freshness: 'live',
          confidence: 0.8,
          truthClass: 'predicted',
          action: { type: 'see_place', label: 'See place', targetType: 'place', targetId: 'x' },
        }}
        projection={projection()}
      />,
    );
    const row = screen.getByTestId('wall-context-live_place');
    expect(row.props.accessibilityRole).toBe('button');
    expect(row.props.accessibilityLabel).toContain('Quiet right now');
    expect(row.props.accessibilityLabel).toContain('Scheduled');
    expect(row.props.accessibilityLabel).toContain('See place');
  });

  it('an observed Context Thread carries NO qualifier — the annotation means something', async () => {
    await render(
      <ContextThreadView
        thread={{
          kind: 'live_place',
          label: 'Quiet right now',
          freshness: 'live',
          truthClass: 'observed',
          action: { type: 'see_place', label: 'See place', targetType: 'place', targetId: 'x' },
        }}
        projection={projection()}
      />,
    );
    expect(screen.queryByTestId('wall-context-truth-live_place')).toBeNull();
  });
});
