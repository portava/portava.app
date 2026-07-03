/**
 * Visual QA: WCAG AA contrast verification for PulseFeedCard's gradient scrim.
 *
 * Confirms that white author-name text (color.onInk = #FAF9F6) achieves ≥ 4.5:1
 * contrast against bright, mid-tone, and dark travel-photo backgrounds after the
 * gradient was bumped to rgba(17,17,15,0.85) end-stop at 60% height.
 *
 * Test geometry — worst-case: top edge of the AuthorRow on a phone-width card.
 *
 *   Card width  ≈ 390 px (phone)
 *   Media height = round(390 × 5/4) = 488 px   (4:5 aspect ratio in PostCard)
 *   Scrim height = round(488 × 0.60) = 293 px   (height: '60%')
 *   Author row top edge ≈ 60 px from card bottom (padding ~12 + avatar 36 + padding ~12)
 *   Position in scrim (0=top/transparent, 1=bottom/opaque): (293 − 60) / 293 ≈ 0.795
 *   Effective scrim opacity at that point: 0.85 × 0.795 ≈ 0.675
 *
 * Run with:
 *   node --import tsx/esm --test src/components/__tests__/postScrim.contrast.test.ts
 *
 * Pure TypeScript — no React, no native modules, no network calls.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ── WCAG 2.x helpers ─────────────────────────────────────────────────────────

/** Convert an sRGB channel (0-255) to linear light. */
function srgbToLinear(u8: number): number {
  const c = u8 / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Relative luminance of an sRGB colour (WCAG 2.x definition). */
function luminance(r: number, g: number, b: number): number {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

/** WCAG contrast ratio between two relative luminances. */
function contrastRatio(l1: number, l2: number): number {
  const lighter = Math.max(l1, l2);
  const darker  = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Alpha-composite foreground over background (all channel values 0–255). */
function composite(
  fgR: number, fgG: number, fgB: number, fgA: number,
  bgR: number, bgG: number, bgB: number,
): [number, number, number] {
  return [
    Math.round(fgR * fgA + bgR * (1 - fgA)),
    Math.round(fgG * fgA + bgG * (1 - fgA)),
    Math.round(fgB * fgA + bgB * (1 - fgA)),
  ];
}

// ── Scrim constants — must match s.postScrim in PulseFeedCard.tsx ─────────────

/** Scrim ink colour (the dark endpoint of the gradient). */
const SCRIM_R = 17, SCRIM_G = 17, SCRIM_B = 15;
/** End-stop opacity: rgba(17,17,15, SCRIM_END_STOP). */
const SCRIM_END_STOP   = 0.85;
/** Scrim height as a fraction of media height. */
const SCRIM_HEIGHT_FRAC = 0.60;

// ── Card geometry — worst-case phone, portrait 4:5 PostCard ──────────────────

const CARD_WIDTH_PX    = 390;
const MEDIA_HEIGHT_PX  = Math.round(CARD_WIDTH_PX * 5 / 4);    // 488
const SCRIM_HEIGHT_PX  = Math.round(MEDIA_HEIGHT_PX * SCRIM_HEIGHT_FRAC); // 293

/**
 * Distance from the bottom of the card to the TOP edge of the AuthorRow.
 * postAuthorOverlay: bottom 0, padding space.md (≈12 px)
 * HighlightRing / avatar: height 36 px
 * Additional top padding within the row: ≈12 px
 * Total conservative estimate: 60 px
 */
const AUTHOR_TOP_FROM_BOTTOM_PX = 60;

/**
 * Gradient position at the author-name top edge.
 * 0 = top of scrim (transparent); 1 = bottom of scrim (full SCRIM_END_STOP).
 */
const AUTHOR_GRADIENT_POS =
  (SCRIM_HEIGHT_PX - AUTHOR_TOP_FROM_BOTTOM_PX) / SCRIM_HEIGHT_PX; // ≈ 0.795

/** Actual alpha of the scrim ink at the author-name top edge. */
const SCRIM_ALPHA_AT_AUTHOR = SCRIM_END_STOP * AUTHOR_GRADIENT_POS; // ≈ 0.675

// ── Text colour: color.onInk = '#FAF9F6' ─────────────────────────────────────

const TEXT_R = 250, TEXT_G = 249, TEXT_B = 246;
const L_TEXT = luminance(TEXT_R, TEXT_G, TEXT_B);

// ── Media background fixtures ─────────────────────────────────────────────────

const MEDIA_FIXTURES: ReadonlyArray<{ label: string; rgb: readonly [number, number, number] }> = [
  { label: 'bright  — snowy landscape / beach / white wall',  rgb: [255, 255, 255] },
  { label: 'mid-tone — overcast sky / concrete',              rgb: [128, 128, 128] },
  { label: 'dark    — night shot / heavy edit',               rgb: [30,  30,  30]  },
];

// ── Gradient geometry sanity ──────────────────────────────────────────────────

describe('postScrim — gradient geometry', () => {
  it('author-row gradient position is strictly between 0 and 1', () => {
    assert.ok(
      AUTHOR_GRADIENT_POS > 0 && AUTHOR_GRADIENT_POS < 1,
      `AUTHOR_GRADIENT_POS must be in (0, 1), got ${AUTHOR_GRADIENT_POS.toFixed(4)}`,
    );
  });

  it('effective scrim alpha at author position is ≥ 0.60 (sufficient to protect text)', () => {
    assert.ok(
      SCRIM_ALPHA_AT_AUTHOR >= 0.60,
      `Scrim too light at author row — alpha ${SCRIM_ALPHA_AT_AUTHOR.toFixed(3)}; ` +
      'bump SCRIM_END_STOP or SCRIM_HEIGHT_FRAC',
    );
  });
});

// ── Author-name WCAG AA contrast across media tones ──────────────────────────

describe('postScrim — author-name (color.onInk #FAF9F6) contrast at author-row top edge', () => {
  for (const { label, rgb } of MEDIA_FIXTURES) {
    it(`≥ 4.5:1 on ${label}`, () => {
      const [mr, mg, mb] = rgb;

      const [bgR, bgG, bgB] = composite(
        SCRIM_R, SCRIM_G, SCRIM_B, SCRIM_ALPHA_AT_AUTHOR,
        mr, mg, mb,
      );

      const L_bg = luminance(bgR, bgG, bgB);
      const ratio = contrastRatio(L_TEXT, L_bg);

      assert.ok(
        ratio >= 4.5,
        `WCAG AA requires ≥ 4.5:1; got ${ratio.toFixed(2)}:1 — ` +
        `media rgb(${mr},${mg},${mb}), effective bg rgb(${bgR},${bgG},${bgB}), ` +
        `scrim alpha ${SCRIM_ALPHA_AT_AUTHOR.toFixed(3)}`,
      );
    });
  }
});

// ── Bottom-edge contrast (author text at absolute bottom, alpha = end-stop) ───

describe('postScrim — author-name contrast at card bottom (maximum gradient darkness)', () => {
  it('white media at card bottom: contrast well above WCAG AAA (7:1)', () => {
    const [bgR, bgG, bgB] = composite(
      SCRIM_R, SCRIM_G, SCRIM_B, SCRIM_END_STOP,
      255, 255, 255,
    );
    const ratio = contrastRatio(L_TEXT, luminance(bgR, bgG, bgB));
    assert.ok(
      ratio >= 7.0,
      `Expected ≥ 7:1 (AAA) at card bottom; got ${ratio.toFixed(2)}:1`,
    );
  });
});
