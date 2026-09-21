/**
 * W173 / spec §36 — "Postcard decorative typography must preserve readable
 * accessible text."
 *
 * WHY THIS FILE EXISTS. The census graded this row CANNOT-VERIFY as "needs a
 * rendered screen and a screen reader". That is the right answer to a question
 * this requirement does not ask. The clause has a SUBJECT (decorative
 * typography) and a PREDICATE (preserves readable accessible text), and both
 * halves of the predicate are decidable here:
 *
 *   READABLE  — contrast and size are arithmetic over the real tokens and the
 *               real styles. The Postcard is the one Wall surface that is NOT
 *               painted on `color.paper` or `color.paperRaised`: its card is a
 *               warmer `#FFFDF7`, so the Wall-wide AA scan in
 *               `WallAccessibility.component.test.tsx` — which computes every
 *               pair against the two standard surfaces — has never covered it.
 *               This file computes against the Postcard's own paper.
 *   ACCESSIBLE — whether the decorated strings are real `Text` nodes in the
 *               accessibility tree, or pixels. A postcard whose place name and
 *               date were baked into the image, or whose caption sat under a
 *               decorative overlay removed from the tree, would look identical
 *               and be unreadable to a screen reader. That is exactly what
 *               "preserves" is guarding against and it is observable in the
 *               rendered tree, which is the same argument that moved W174 out of
 *               this bucket.
 *
 * THE REGRESSION THIS FILE EXISTS FOR IS NOT HYPOTHETICAL. `PostcardWallItem.tsx`
 * carries a comment recording that the byline used to be `color.faint`, which is
 * 2.73:1 — below AA for normal text and below even the 3:1 large-text floor.
 * Nothing in the repository would catch it coming back on the Postcard's own
 * paper. The source scan below does.
 *
 * WHAT STILL NEEDS A DEVICE: whether a real screen reader pronounces an
 * uppercased monospace date stamp sensibly, and whether the -0.6° rotation reads
 * as charming or broken. Neither is claimed here.
 *
 * MUTATION PROOF (each verified: apply → RED, restore → GREEN) — the measured
 * counts are in the census entry for W173.
 */

import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen } from '@testing-library/react-native';

// NOTE: exhaustive-by-design mock — the real wallApi loads the supabase /
// apiToken chain at import, which would crash the jest suite. wallItemShared
// (imported transitively by PostcardWallItem) imports it.
jest.mock('../../../services/wallApi.ts', () => ({
  fetchWall: jest.fn(),
  fetchLiveForYou: jest.fn(),
  setSessionIntent: jest.fn(),
  clearSessionIntent: jest.fn(),
  sendImpression: jest.fn(),
  sendAction: jest.fn(),
}));

import { PostcardWallItem } from '../PostcardWallItem.tsx';
import { color, type as t } from '../../../../../theme/tokens.ts';
import type { PostcardProjection } from '../../../types/wallProjection.ts';

// ── WCAG 2.x contrast, computed over the real tokens ─────────────────────────
// Same formula as WallAccessibility.component.test.tsx. It is repeated rather
// than shared because a helper imported from a test file is not a public API and
// the two files must be able to disagree about which SURFACE they measure on.

function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * channel(parseInt(h.slice(0, 2), 16)) +
    0.7152 * channel(parseInt(h.slice(2, 4), 16)) +
    0.0722 * channel(parseInt(h.slice(4, 6), 16))
  );
}

function contrast(fg: string, bg: string): number {
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const AA_NORMAL_TEXT = 4.5;

const POSTCARD_SOURCE = join(
  process.cwd(),
  'src',
  'features',
  'wall',
  'components',
  'objects',
  'PostcardWallItem.tsx',
);

/** The Postcard's own card colour, read out of its source rather than guessed —
 *  if the paper changes, every ratio below is recomputed against the new one. */
function postcardPaper(): string {
  const src = readFileSync(POSTCARD_SOURCE, 'utf8');
  const m = src.match(/card:\s*\{[\s\S]*?backgroundColor:\s*'(#[0-9A-Fa-f]{6})'/);
  if (!m) throw new Error('could not read the Postcard card background from its source');
  return m[1];
}

/** Every `color: color.X` a style in PostcardWallItem paints text in. */
function postcardTextTokens(): string[] {
  const src = readFileSync(POSTCARD_SOURCE, 'utf8');
  const out = new Set<string>();
  for (const m of src.matchAll(/color:\s*color\.([A-Za-z]+)/g)) out.add(m[1]);
  return [...out];
}

const NOW = '2026-05-04T12:00:00.000Z';

function postcard(over: Partial<PostcardProjection> = {}): PostcardProjection {
  return {
    projectionId: 'wall_postcard_pc1',
    canonicalObjectId: 'pc1',
    objectType: 'postcard',
    storyPresentation: true,
    publishedAt: NOW,
    experienceAt: NOW,
    visibility: 'public',
    text: 'The ferry back at golden hour',
    actor: { userId: 'u1', displayName: 'Ana Reyes' },
    place: { placeId: 'p1', name: 'Đà Nẵng', city: 'Da Nang' },
    media: [{ mediaId: 'm1', kind: 'image', url: 'https://example.com/pc.jpg' }],
    actions: [],
    ...over,
  } as PostcardProjection;
}

/** Every host node in the rendered tree. */
function hostNodes(): any[] {
  const out: any[] = [];
  const visit = (n: any) => {
    if (!n || typeof n !== 'object') return;
    out.push(n);
    for (const c of n.children ?? []) visit(c);
  };
  visit((screen as any).root);
  return out;
}

describe('§36 / W173 — the Postcard is decorated, and still readable', () => {
  it('the scan reads the real source (guard against a vacuous pass)', () => {
    // If either of these stops matching, every contrast assertion below becomes
    // an assertion about an empty list.
    expect(postcardPaper()).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(postcardTextTokens().length).toBeGreaterThanOrEqual(3);
  });

  it('every text colour the Postcard paints clears AA on the Postcard\'s OWN paper', () => {
    const paper = postcardPaper();
    const failures = postcardTextTokens()
      .map((token) => ({
        token,
        ratio: Number(contrast((color as Record<string, string>)[token], paper).toFixed(2)),
      }))
      .filter((r) => r.ratio < AA_NORMAL_TEXT);
    // The postcard's paper (#FFFDF7) is LIGHTER than `color.paper`, so a token
    // that just scrapes AA on the standard surface can fail here. That is the
    // point: this surface has its own floor and nothing else computes it.
    expect(failures).toEqual([]);
  });

  it('the quietest decorative roles — date stamp and byline — are the ones under test', () => {
    const paper = postcardPaper();
    // Named explicitly so the assertion above cannot pass by scanning nothing:
    // these two styles ARE the decorative typography the spec clause is about.
    expect(contrast(color.deep, paper)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT); // dateStampText
    expect(contrast(color.mute, paper)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT); // byline, caption
    // …and the colour it used to be, which is what this test is here to refuse.
    expect(contrast(color.faint, paper)).toBeLessThan(AA_NORMAL_TEXT);
  });

  it('decorative type is small but not below the legibility floor it declares', () => {
    // `stamp` is the decorative monospace role: small, bold, letter-spaced. The
    // three properties travel together — dropping the weight or the tracking
    // makes 11px monospace materially harder to read, so all three are pinned.
    expect(t.stamp.fontSize).toBeGreaterThanOrEqual(11);
    expect(Number(t.stamp.fontWeight)).toBeGreaterThanOrEqual(700);
    expect(Number(t.stamp.letterSpacing)).toBeGreaterThan(0);
    // …and the caption is body-sized, not shrunk to fit the paper frame.
    expect(t.body.fontSize).toBeGreaterThanOrEqual(15);
  });

  it('every decorated string is REAL TEXT in the accessibility tree, not artwork', async () => {
    await render(<PostcardWallItem projection={postcard()} />);

    // Place, caption and byline are the three strings the decoration wraps.
    expect(screen.getByText('Đà Nẵng')).toBeTruthy();
    expect(screen.getByText('The ferry back at golden hour')).toBeTruthy();
    expect(screen.getByText(/Postcard · Ana Reyes/)).toBeTruthy();
    // The date stamp is rendered from the experience date, uppercased — a real
    // string, not a stamp graphic.
    expect(screen.getByText(/^[A-Z]{3} \d{1,2}$/)).toBeTruthy();
  });

  it('the decoration does not remove the card, or anything on it, from the tree', async () => {
    await render(<PostcardWallItem projection={postcard()} />);

    // The rotation/paper frame is presentation; the card is still one labelled
    // control, and nothing inside it is hidden from assistive technology.
    const card = screen.getByLabelText('Postcard from Đà Nẵng');
    expect(card.props.accessibilityRole).toBe('button');

    const hidden = hostNodes()
      .filter(
        (n) =>
          n.props?.importantForAccessibility === 'no-hide-descendants' ||
          n.props?.importantForAccessibility === 'no' ||
          n.props?.accessibilityElementsHidden === true,
      )
      .map((n) => String(n.props?.testID ?? n.type));
    expect(hidden).toEqual([]);
  });

  it('the text survives the decoration when the optional parts are absent', async () => {
    // A postcard with no caption and no place still announces what it is, so the
    // decorative frame is never the only thing a screen reader can find.
    await render(<PostcardWallItem projection={postcard({ text: undefined, place: undefined })} />);
    expect(screen.getByLabelText('Postcard from somewhere')).toBeTruthy();
    expect(screen.getByText('Somewhere')).toBeTruthy();
    expect(screen.getByText(/Postcard · Ana Reyes/)).toBeTruthy();
  });
});
