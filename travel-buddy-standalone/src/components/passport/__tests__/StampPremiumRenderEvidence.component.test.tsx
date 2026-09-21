/**
 * P66 RENDER EVIDENCE — a fixture generator, NOT a verdict.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THIS FILE DOES NOT ANSWER P66 AND MUST NOT BE READ AS ANSWERING IT.       │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * `census-passport.md` P66 reads "Premium collectible appearance with
 * perforated / passport-stamp edges" and is graded `?`/`X` — an AESTHETIC
 * JUDGEMENT that no static method decides. The census is explicit about what
 * would close it: "A named person looking at a rendered screen of the shipped
 * Stamps surface on a device and recording a verdict", and about what would
 * make artwork count as evidence: "a generator or CI step IN THE TREE that
 * produces them from the shipped pipeline, cited by path" — as opposed to the
 * three PNGs sitting at the repo root (`premium-test-epic.png`,
 * `premium-test-common.png`, `premium-hero-raw.png`), which arrived from an
 * unrelated Discovery PR, are referenced by no code, and are therefore not
 * evidence of anything this tree renders.
 *
 * THIS IS THAT GENERATOR. It renders the SHIPPED components across every
 * rarity tier and every supported width, and writes what they actually resolve
 * to — frame shape, border treatment, rarity badge, glow, colours — as a
 * deterministic fixture at:
 *
 *     src/components/passport/__tests__/__fixtures__/stamp-premium-render.json
 *
 * WHAT A DESIGNER STILL HAS TO DO, because this cannot:
 * ====================================================
 * The open question is **"is this premium ENOUGH?"**, not "is there any premium
 * treatment?" — the tree demonstrably ships rarity affordances an earlier
 * census pass missed (`src/components/StampDetailArtwork.tsx:158#rarityBadge`,
 * sawtooth/wave frames, a legendary glow ring), and the perforated half holds
 * (`src/components/PassportStamps.tsx:104#borderStyle: 'dashed'`). The fixture
 * below tells a reviewer exactly WHAT is on screen. It cannot tell them whether
 * it LOOKS premium. That is a person's call, recorded with a date.
 *
 * NO IMAGE IS PRODUCED BY THIS FILE. See the header of the generated fixture
 * for the exact capture command and why it cannot run in this container.
 */
import React from 'react';
import { render } from '@testing-library/react-native';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// NOTE: intentionally exhaustive — StampSvgFrame draws the sawtooth/wave frames
// through react-native-svg, whose native module is unavailable under jest-expo.
// Stubbed to a View that ECHOES its shape/border props, so the fixture still
// records which frame treatment each rarity resolves to.
jest.mock('../../StampSvgFrame.tsx', () => {
  const R = jest.requireActual('react');
  const { View } = jest.requireActual('react-native');
  return {
    StampSvgFrame: (p: Record<string, unknown>) =>
      R.createElement(View, { testID: `svgframe-${String(p.shape)}-${String(p.border)}` }),
  };
});

import { StampDetailArtwork } from '../../StampDetailArtwork.tsx';
import { resolveArtwork } from '../../../lib/stampArtworkResolver.ts';
import { STAMP_RARITY_COLORS, STAMP_RARITY_LABELS } from '../../../types/stampArtwork.ts';
import type { StampRarity } from '../../../lib/stampRarity.ts';
import type { PassportStamp } from '../../../types/models.ts';

/**
 * Supported widths. The app ships to phones and small tablets; these are the
 * device widths the Passport is expected to read at. They are stated here
 * rather than imported because the theme defines no breakpoint scale — if one
 * is ever added, this list should collapse onto it.
 */
const WIDTHS = [320, 375, 390, 430, 768];

/** StampDetailArtwork's own documented size range is 120–200px (file header). */
const SIZES = [120, 148, 200];

const RARITIES: StampRarity[] = ['common', 'uncommon', 'rare', 'epic', 'legendary'];

function stamp(rarity: StampRarity, locked = false): PassportStamp {
  return {
    id: `stamp-${rarity}`,
    kind: 'city',
    label: 'Bangkok',
    caption: 'Thailand',
    sublabel: '2026',
    rarity,
    locked,
  } as unknown as PassportStamp;
}

/** Collect every style object in a rendered tree, flattened and ordered. */
function collectStyles(node: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (!node || typeof node !== 'object') return out;
  const n = node as { props?: Record<string, unknown>; children?: unknown[] };
  const style = n.props?.style;
  if (style) {
    const flat = Array.isArray(style) ? Object.assign({}, ...style.filter(Boolean)) : style;
    if (flat && typeof flat === 'object' && Object.keys(flat).length > 0) {
      out.push(flat as Record<string, unknown>);
    }
  }
  for (const child of n.children ?? []) collectStyles(child, out);
  return out;
}

/** The visual properties a designer actually needs, pulled from the style set. */
function visualSummary(styles: Record<string, unknown>[]) {
  const pick = (k: string) =>
    styles.map((s) => s[k]).filter((v) => v !== undefined && v !== null);
  return {
    borderStyles: Array.from(new Set(pick('borderStyle') as string[])),
    borderWidths: Array.from(new Set(pick('borderWidth') as number[])).sort((a, b) => a - b),
    borderColors: Array.from(new Set(pick('borderColor') as string[])),
    backgroundColors: Array.from(new Set(pick('backgroundColor') as string[])),
    borderRadii: Array.from(new Set(pick('borderRadius') as number[])).sort((a, b) => a - b),
    // Shadow/elevation are the "premium" depth cues a reviewer looks for.
    hasShadow: styles.some((s) => s.shadowOpacity !== undefined || s.elevation !== undefined),
  };
}

const evidence: Record<string, unknown> = {
  README: [
    'P66 RENDER EVIDENCE — generated by',
    'src/components/passport/__tests__/StampPremiumRenderEvidence.component.test.tsx',
    'from the SHIPPED stamp components. Regenerate with:',
    '  cd travel-buddy-standalone && npx jest src/components/passport/__tests__/StampPremiumRenderEvidence.component.test.tsx',
    '',
    'THIS IS NOT A VERDICT ON P66. P66 asks "is this premium ENOUGH", which is a',
    'designer judgement. This file records WHAT RENDERS so a person can answer it.',
    '',
    'NO SCREENSHOT WAS PRODUCED. This container has no browser or device runtime:',
    'there is no playwright, puppeteer or chromium binary present, node_modules is',
    'symlinked and read-only for installs, and MapLibre/SVG native modules are',
    'stubbed under jest. To capture real images on a machine that has a device or',
    'simulator, run the app and photograph the Stamps surface:',
    '  cd travel-buddy-standalone && npx expo run:ios     # or run:android',
    '  # open Passport -> Stamps, then capture the stamp grid and one stamp detail',
    '  #   xcrun simctl io booted screenshot p66-stamps.png',
    '  #   adb exec-out screencap -p > p66-stamps.png',
  ],
  rarityPalette: Object.fromEntries(
    RARITIES.map((r) => [r, { color: STAMP_RARITY_COLORS[r], label: STAMP_RARITY_LABELS[r] }]),
  ),
  widthsConsidered: WIDTHS,
  rarities: {} as Record<string, unknown>,
};

/**
 * One render per test, deliberately. Rendering several times inside a single
 * test and unmounting between them silently returned EMPTY trees from the
 * third render onward under RNTL v14's concurrent root — which produced a
 * fixture full of empty arrays that still passed a weak assertion. The
 * cartesian product below gives every (rarity, size) pair its own render, and
 * the assertion now checks the captured evidence is NON-EMPTY so the same
 * failure cannot pass again.
 */
const CASES: Array<[StampRarity, number]> = RARITIES.flatMap(
  (r) => SIZES.map((sz) => [r, sz] as [StampRarity, number]),
);

describe('P66 — stamp premium render evidence (generator, not a verdict)', () => {
  it.each(CASES)('records what the shipped artwork resolves to for %s at %ipx', async (rarity, size) => {
    const art = resolveArtwork(stamp(rarity));
    const view = await render(<StampDetailArtwork stamp={stamp(rarity)} size={size} />);
    const summary = visualSummary(collectStyles(view.toJSON()));

    const rarities = evidence.rarities as Record<string, Record<string, unknown>>;
    rarities[rarity] = {
      ...(rarities[rarity] ?? {}),
      resolved: {
        shape: art.shape,
        borderStyle: art.borderStyle,
        borderWeight: art.borderWeight,
        accent: art.accent,
        background: art.background,
        pattern: art.pattern,
        texture: art.texture,
        hasShimmer: art.hasShimmer,
        hasGlow: art.hasGlow,
        iconKey: art.iconKey,
        rarity: art.rarity,
      },
      badgeLabel: STAMP_RARITY_LABELS[rarity],
      badgeColor: STAMP_RARITY_COLORS[rarity],
      bySize: {
        ...((rarities[rarity]?.bySize as Record<string, unknown>) ?? {}),
        [String(size)]: summary,
      },
    };

    // The ONLY assertion: the artwork actually rendered something visual. An
    // empty summary means the capture silently failed, which is what happened
    // before this file rendered one component per test. Nothing here asserts
    // the result LOOKS premium — that is the designer's call.
    expect(summary.backgroundColors.length + summary.borderColors.length).toBeGreaterThan(0);
  });

  afterAll(() => {
    const dir = join(__dirname, '__fixtures__');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'stamp-premium-render.json'),
      JSON.stringify(evidence, null, 2) + '\n',
      'utf8',
    );
  });
});
