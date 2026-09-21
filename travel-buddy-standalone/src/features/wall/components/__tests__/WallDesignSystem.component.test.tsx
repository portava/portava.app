/**
 * §35 Design System Rules — the half of §35 that is DECIDABLE.
 *
 * §35 is ten clauses. Seven are already graded C on structural evidence (W160–
 * W165, W169…). Four are not, and three of those four — W159 "generous
 * whitespace", W167 "excessive badges", W168 "understands it without knowing the
 * architecture" — turn on an aesthetic or human judgement that no test can
 * settle. The fourth, W166, turns on a brand decision nobody has made.
 *
 * That does NOT make the whole of those rows undecidable, and this file is the
 * difference. Each of them has a structural half that the census currently
 * ASSERTS in prose — "spacing tokens are applied consistently", "no card uses
 * the accent as a background wash", "single-column list, one thread per object,
 * ≤4 strip items" — and an asserted property is one refactor away from being
 * false with nothing to notice. Everything below is that half, executed.
 *
 * WHAT THIS FILE DOES NOT CLAIM. It does not decide whether the whitespace is
 * generous, whether three action chips is excessive, or whether the accent
 * should be purple. Those verdicts stay where they are; see the census entries
 * for W159, W166, W167 and W168 for who can settle each and how.
 *
 * MUTATION PROOF (each verified: apply → RED, restore → GREEN) — measured counts
 * are recorded in the census entries above.
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

import { space } from '../../../../theme/tokens.ts';
import { ContextualActionChips } from '../objects/wallItemShared.tsx';
import type { WallProjection } from '../../types/wallProjection.ts';

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

const FILES = wallSources(WALL_ROOT);
const rel = (f: string) => f.slice(f.indexOf('src/features/wall/'));

function scan(re: RegExp): Array<{ where: string; line: string }> {
  const hits: Array<{ where: string; line: string }> = [];
  for (const file of FILES) {
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (re.test(line)) hits.push({ where: `${rel(file)}:${i + 1}`, line: line.trim() });
      });
  }
  return hits;
}

describe('the scan reads the Wall tree (guard against a vacuous pass)', () => {
  it('finds the Wall source files', () => {
    expect(FILES.length).toBeGreaterThan(20);
    expect(FILES.some((f) => f.endsWith('WallFeed.tsx'))).toBe(true);
    expect(FILES.some((f) => f.endsWith('objects/PostcardWallItem.tsx'))).toBe(true);
  });
});

// ── W166 (structural half): the accent is an ACCENT, never a wash ────────────
//
// The census's structural claim for W166 — "no card uses the accent as a
// background wash" — was established by a grep somebody ran by hand and wrote
// down. This is that grep, executed on every run, with the legitimate uses named
// one by one. A new `backgroundColor: color.signal` anywhere in the Wall fails
// here until somebody adds it to the list and says what it is, which is exactly
// the review the rule wants. Nothing here has an opinion about WHICH colour the
// accent should be — see the census entry for W166, which is an owner decision.

describe('§35 / W166 — the accent colour is used as an accent, not a background wash', () => {
  /**
   * Every place a Wall surface may paint an accent token as a BACKGROUND. Each
   * entry is a small interaction affordance — the thing the clause explicitly
   * permits ("an interaction/accent colour") — not a card or a content surface.
   */
  const ACCENT_BACKGROUND_ALLOWLIST: ReadonlyArray<{ where: string; what: string }> = [
    { where: 'src/features/wall/components/WallHeader.tsx', what: 'notification count badge' },
    { where: 'src/features/wall/components/FeedModeSwitcher.tsx', what: 'the selected tab pill' },
    {
      where: 'src/features/wall/components/objects/wallItemShared.tsx',
      what: 'the Buddy tag beside a commercial actor name',
    },
  ];

  const ACCENT_BACKGROUND = /backgroundColor:\s*color\.(signal|signalDim|deep)\b/;

  it('the rule is real: it matches an accent wash and not an accent icon', () => {
    expect(ACCENT_BACKGROUND.test('  card: { backgroundColor: color.signal },')).toBe(true);
    expect(ACCENT_BACKGROUND.test('  frame: { backgroundColor: color.deep },')).toBe(true);
    // An accent used as an ICON or tint colour is the permitted use and must not
    // be caught — the clause is about background washes.
    expect(ACCENT_BACKGROUND.test('<RefreshControl tintColor={color.signal} />')).toBe(false);
    expect(ACCENT_BACKGROUND.test('  placeText: { color: color.deep },')).toBe(false);
  });

  it('no Wall surface paints an accent background outside the named affordances', () => {
    const allowed = new Set(ACCENT_BACKGROUND_ALLOWLIST.map((a) => a.where));
    const unexpected = scan(ACCENT_BACKGROUND)
      .filter((h) => !allowed.has(h.where.split(':')[0]))
      .map((h) => `${h.where} — ${h.line}`);
    expect(unexpected).toEqual([]);
  });

  it('and every allowlisted affordance is still there (the list cannot rot)', () => {
    const found = new Set(scan(ACCENT_BACKGROUND).map((h) => h.where.split(':')[0]));
    for (const entry of ACCENT_BACKGROUND_ALLOWLIST) {
      expect({ where: entry.where, present: found.has(entry.where) }).toEqual({
        where: entry.where,
        present: true,
      });
    }
  });

  it('NO feed object card paints its own surface in the accent', () => {
    // The clause's own words: "not a background wash for every card". The object
    // renderers ARE the cards, so they are checked separately and admit no
    // allowlist at all — wallItemShared's Buddy tag is a tag inside a card, not
    // the card, and lives in its own file.
    const cards = FILES.filter((f) => /components\/objects\/\w+WallItem\.tsx$/.test(f));
    expect(cards.length).toBeGreaterThanOrEqual(5);
    const washed: string[] = [];
    for (const file of cards) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (ACCENT_BACKGROUND.test(line)) washed.push(`${rel(file)}:${i + 1} — ${line.trim()}`);
        });
    }
    expect(washed).toEqual([]);
  });
});

// ── W159 (structural half): spacing comes from the scale, not from taste ─────

describe('§35 / W159 — Wall spacing is the token scale, applied consistently', () => {
  /**
   * `space` runs 4 → 48. A literal INSIDE that band is a spacing decision made
   * outside the scale, which is what "applied consistently" forbids; literals
   * below it (0–3) are optical nudges the scale has no step for, and literals
   * above it are layout insets rather than rhythm.
   *
   * The two deliberate exceptions are named. Both are outside the band, so they
   * are documentation rather than an escape hatch — a new in-band literal cannot
   * be waved through by adding a line here without also being obviously in-band.
   */
  const SCALE = new Set<number>(Object.values(space));
  const SPACING_PROP =
    /\b(padding|margin|gap|rowGap|columnGap|paddingHorizontal|paddingVertical|paddingTop|paddingBottom|paddingLeft|paddingRight|marginHorizontal|marginVertical|marginTop|marginBottom|marginLeft|marginRight):\s*(\d+)\b/g;

  it('the scale is the one the components import', () => {
    expect([...SCALE].sort((a, b) => a - b)).toEqual([4, 8, 12, 16, 24, 32, 48]);
  });

  it('no Wall style sets an in-scale-band spacing value that is not a token', () => {
    const violations: string[] = [];
    for (const file of FILES) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          for (const m of line.matchAll(SPACING_PROP)) {
            const value = Number(m[2]);
            const inBand = value >= 4 && value <= 48;
            if (inBand && !SCALE.has(value)) {
              violations.push(`${rel(file)}:${i + 1} — ${m[1]}: ${value}`);
            }
          }
        });
    }
    expect(violations).toEqual([]);
  });

  it('the rule is real: it catches an off-scale value and permits a token one', () => {
    const check = (line: string) => {
      const out: number[] = [];
      for (const m of line.matchAll(SPACING_PROP)) {
        const v = Number(m[2]);
        if (v >= 4 && v <= 48 && !SCALE.has(v)) out.push(v);
      }
      return out;
    };
    expect(check('  row: { paddingHorizontal: 14, gap: 6 },')).toEqual([14, 6]);
    expect(check('  row: { paddingHorizontal: space.lg, gap: space.sm },')).toEqual([]);
    // …and leaves the sub-scale optical nudges and the list inset alone.
    expect(check('  badge: { paddingHorizontal: 3, paddingVertical: 2 },')).toEqual([]);
    expect(check('  content: { paddingBottom: 120 },')).toEqual([]);
  });
});

// ── W167 (structural half): no grid, no second recommendation surface, ───────
//     and a stated cap on the badges each card may carry.

function projectionWith(actionTypes: string[]): WallProjection {
  return {
    projectionId: 'wall_social_post_p1',
    canonicalObjectId: 'p1',
    objectType: 'social_post',
    publishedAt: '2026-09-04T00:00:00.000Z',
    visibility: 'public',
    actions: actionTypes.map((type) => ({ type, label: `Do ${type}` })),
  } as unknown as WallProjection;
}

describe('§35 / W167 — no dashboard grid, no second recommendation module', () => {
  it('nothing in the Wall lays content out in a grid', () => {
    // A dashboard grid in React Native is `numColumns` on a list, or a wrapping
    // flex row of content. The one wrapping row in the tree is the action chip
    // row, which is a row of affordances, not of content objects.
    const grids = scan(/numColumns/);
    expect(grids).toEqual([]);

    const wraps = scan(/flexWrap:\s*'wrap'/).map((h) => h.where.split(':')[0]);
    expect([...new Set(wraps)]).toEqual([
      'src/features/wall/components/objects/wallItemShared.tsx', // chipRow
    ]);
  });

  it('there is exactly ONE horizontally-browsable recommendation surface', () => {
    // "Giant recommendation modules" is a count as much as a size: the Wall
    // composes a header of at most the quick-media row and the Live strip, and
    // the Live strip is the only ranked-recommendation surface. A second one
    // added to the screen fails here.
    const screenSrc = readFileSync(join(WALL_ROOT, 'components', 'WallScreen.tsx'), 'utf8');
    const stripUses = screenSrc.match(/<LiveForYouStrip\b/g) ?? [];
    expect(stripUses.length).toBe(1);
    const horizontalScrollers = scan(/horizontal\b/).map((h) => h.where.split(':')[0]);
    expect([...new Set(horizontalScrollers)].sort()).toEqual([
      'src/features/wall/components/LiveForYouStrip.tsx',
      'src/features/wall/components/QuickMediaRow.tsx',
    ]);
  });
});

describe('§35 / W167 — the badge cap the Wall states is the badge cap it applies', () => {
  it('an object with many actions renders at most THREE chips', async () => {
    await render(
      <ContextualActionChips
        projection={projectionWith([
          'see_place',
          'add_to_trip',
          'open_map',
          'book_buddy',
          'message',
          'join',
        ])}
      />,
    );
    for (const label of ['Do see_place', 'Do add_to_trip', 'Do open_map']) {
      expect(screen.getByLabelText(label)).toBeTruthy();
    }
    for (const label of ['Do book_buddy', 'Do message', 'Do join']) {
      expect(screen.queryByLabelText(label)).toBeNull();
    }
  });

  it('the actions that already have a home elsewhere are never ALSO badges', async () => {
    // `save` is the bookmark in the social action row and `ask_compass` is the
    // quiet chip in the place line. Emitting them as chips too would put a second
    // Save on every post in the feed — the clause's own example of excess.
    await render(
      <ContextualActionChips projection={projectionWith(['save', 'ask_compass', 'open_object'])} />,
    );
    expect(screen.queryByLabelText('Do save')).toBeNull();
    expect(screen.queryByLabelText('Do ask_compass')).toBeNull();
    expect(screen.queryByLabelText('Do open_object')).toBeNull();
    // …and with nothing left to show, the row is absent rather than empty chrome.
    expect(screen.toJSON()).toBeNull();
  });

  it('a card with no contextual actions carries no chip row at all', async () => {
    await render(<ContextualActionChips projection={projectionWith([])} />);
    expect(screen.toJSON()).toBeNull();
  });
});

// ── W168 (structural half): the Wall speaks product, not architecture ────────

describe("§35 / W168 — no Portava architecture vocabulary reaches the viewer", () => {
  /**
   * Terms that name a piece of the Wall's MACHINERY. None of them is a thing a
   * traveler has; each is a thing an engineer has. The clause asks that the user
   * understand the Wall without knowing the architecture, and the most direct way
   * to break that is to let one of these words out of the codebase and onto the
   * screen — a label reading "Context thread" or "Ranked candidate" tells the
   * viewer nothing and asks them to know the design.
   *
   * This does NOT decide whether the Wall is comprehensible; that needs users and
   * the row stays CANNOT-VERIFY. It decides the one thing about comprehension
   * that a regression can silently break and a machine can see.
   */
  const ARCHITECTURE_VOCABULARY = [
    'projection',
    'canonical',
    'candidate',
    'context thread',
    'contextthread',
    'truth class',
    'truthclass',
    'diversity',
    'ranker',
    'ranking',
    'eligibility',
    'session intent',
    'cursor',
    'live claim',
    'liveclaim',
    'k-anonymity',
    'allowlist',
    'payload',
    'schema',
    'discovery insertion',
  ];

  /** Every string this tree can put in front of a person. */
  function viewerFacingStrings(): Array<{ where: string; text: string }> {
    const out: Array<{ where: string; text: string }> = [];
    const push = (file: string, i: number, raw: string) => {
      // Drop template interpolations — `${thread.label}` is data, not copy.
      const text = raw.replace(/\$\{[^}]*\}/g, ' ').trim();
      if (text) out.push({ where: `${rel(file)}:${i + 1}`, text });
    };
    for (const file of FILES) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          for (const m of line.matchAll(/accessibilityLabel=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
            push(file, i, m[1] ?? m[2] ?? '');
          }
          for (const m of line.matchAll(/accessibilityHint="([^"]*)"/g)) push(file, i, m[1]);
          // JSX text nodes: >Some words<
          for (const m of line.matchAll(/>\s*([A-Za-z][^<>{}\n]{2,80}?)\s*</g)) push(file, i, m[1]);
          // String literals rendered as copy: {'Some words'} / label: 'Some words'
          for (const m of line.matchAll(/'([A-Z][A-Za-z ·'!?,.-]{3,60})'/g)) push(file, i, m[1]);
        });
    }
    return out;
  }

  it('the extractor finds the real copy (guard against a vacuous pass)', () => {
    const texts = viewerFacingStrings().map((s) => s.text);
    expect(texts.length).toBeGreaterThan(20);
    // Strings a reader of the running app definitely sees.
    expect(texts).toEqual(expect.arrayContaining(['Not interested', 'Portava', 'See Live']));
  });

  it('no viewer-facing string names a piece of the Wall machinery', () => {
    const offenders = viewerFacingStrings()
      .filter((s) => ARCHITECTURE_VOCABULARY.some((w) => s.text.toLowerCase().includes(w)))
      .map((s) => `${s.where} — ${JSON.stringify(s.text)}`);
    expect(offenders).toEqual([]);
  });

  it('the rule is real: it would catch an internal term used as a label', () => {
    const hit = (text: string) =>
      ARCHITECTURE_VOCABULARY.some((w) => text.toLowerCase().includes(w));
    expect(hit('Context thread')).toBe(true);
    expect(hit('Ranking explanation')).toBe(true);
    expect(hit('Canonical object')).toBe(true);
    // …and leaves ordinary product copy alone.
    expect(hit('See live')).toBe(false);
    expect(hit('Not interested')).toBe(false);
    expect(hit('For You')).toBe(false);
  });
});
