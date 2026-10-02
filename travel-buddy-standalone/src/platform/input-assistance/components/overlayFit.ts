/**
 * Global Input Intelligence — how tall the suggestion overlay is allowed to be
 * (spec §46 "no suggestion overlay trapped behind the software keyboard" and
 * §46 "dynamic type and large text support"; §33 stable layout).
 *
 * WHAT WAS THERE BEFORE, AND WHY IT IS NOT ENOUGH
 * ----------------------------------------------
 * `SuggestionOverlay` capped itself at a literal `maxHeight = 320` and nothing
 * else. The census records both consequences:
 *
 *   G327 — "no `KeyboardAvoidingView`, no `Keyboard` height listener, no
 *          safe-area inset, and the overlay renders BELOW the field — the
 *          position a keyboard occupies."
 *   G328 — "the overlay's height cap is a fixed `maxHeight = 320` that does not
 *          scale, and rows use `numberOfLines={1}`, so at large type a label
 *          truncates rather than wraps."
 *
 * A 320-high card hung under a field that sits 400 px down an 800-high window
 * with a 300-high keyboard up has 92 px of visible room and draws 320. The
 * bottom 228 px are behind the keyboard. That is a geometry fact, not a device
 * question, and it is what this module computes.
 *
 * WHAT THIS MODULE DOES *NOT* SETTLE — read before quoting it
 * ----------------------------------------------------------
 * It decides a HEIGHT. It does not move the overlay above the field, and it
 * cannot: the overlay is an inline sibling of the input (`SmartInput`'s
 * `overlayHost`), and flipping it would change the layout of every consuming
 * screen. So when the space between the field and the keyboard is smaller than
 * {@link MIN_OVERLAY_HEIGHT}, this returns that floor and the card IS partly
 * occluded — deliberately, because a 20-px-tall card is not a usable
 * alternative. That residual is why census G327 stays CANNOT-VERIFY and is
 * written down in `docs/architecture/input-assistance-a11y-device-protocol.md`
 * rather than argued away here.
 *
 * Pure module — no React, no RN, no measurement of its own. Every input is
 * supplied by the caller, which is what makes it provable under node:test.
 */

/** The historical cap, unchanged at fontScale 1 so nothing shifts by default. */
export const DEFAULT_OVERLAY_MAX_HEIGHT = 320;

/**
 * The shortest overlay worth drawing. Below roughly this height the card shows
 * less than one full row plus its live region and is not a usable surface, so
 * the fit stops shrinking and accepts partial occlusion instead (see the header).
 */
export const MIN_OVERLAY_HEIGHT = 96;

/** Breathing room kept between the overlay's bottom edge and the keyboard. */
export const OVERLAY_BOTTOM_GUTTER = 8;

/**
 * Ceiling on how far the cap is allowed to grow with the OS text scale. iOS's
 * largest accessibility size reports about 3.1x and Android's about 2.0x with
 * "largest" display size on top; past 3x the card would be taller than any
 * phone window and the space clamp below would be doing all the work anyway.
 */
export const MAX_FONT_SCALE_GROWTH = 3;

export interface OverlayFitInput {
  /**
   * The field's BOTTOM edge in window coordinates, px. `null` means "not
   * measured yet" — the first render before `onLayout`/`measureInWindow` has
   * reported, and every platform where the measurement is unavailable. A null
   * measurement must never shrink the overlay: an unknown position is not a
   * known-bad one.
   */
  fieldBottomY: number | null;
  /** Window height in px (`Dimensions.get('window').height`). */
  windowHeight: number;
  /** Software-keyboard height in px; 0 when the keyboard is down. */
  keyboardHeight: number;
  /** The caller's own cap — `SmartInput`'s `overlayMaxHeight` prop. */
  cap?: number;
  /** OS text scale (`PixelRatio.getFontScale()`); 1 when unscaled. */
  fontScale?: number;
  /** Extra inset below the overlay (home indicator, tab bar). */
  bottomInset?: number;
}

/** Clamp a scale into [1, MAX_FONT_SCALE_GROWTH], treating junk as 1. */
function safeFontScale(raw: number | undefined): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 1) return 1;
  return Math.min(raw, MAX_FONT_SCALE_GROWTH);
}

/**
 * §46 dynamic type — the cap a given text scale WANTS.
 *
 * At 2x text a row is roughly twice as tall, so a fixed 320 shows half as many
 * suggestions: the list silently gets shorter for exactly the users who most
 * need to see it. Growing the desired cap with the scale keeps the number of
 * visible rows roughly constant. It is a DESIRE, not a grant — {@link overlayFit}
 * clamps it against the space that actually exists, so on a small window the
 * user gets fewer rows rather than a card hidden behind the keyboard.
 */
export function scaledOverlayCap(cap: number, fontScale: number | undefined): number {
  const base = Number.isFinite(cap) && cap > 0 ? cap : DEFAULT_OVERLAY_MAX_HEIGHT;
  return Math.round(base * safeFontScale(fontScale));
}

export interface OverlayFit {
  /** The `maxHeight` to hand the overlay. */
  maxHeight: number;
  /**
   * True when the keyboard (or the window edge) forced the overlay below the
   * height the text scale asked for — i.e. the user is seeing fewer rows than
   * the cap would allow. Exposed so a test can distinguish "fits" from "was
   * clamped" instead of only comparing a number.
   */
  clamped: boolean;
  /**
   * True when even {@link MIN_OVERLAY_HEIGHT} does not fit above the keyboard,
   * so part of the card IS occluded. This is the residual G327 names; nothing
   * in this layer can currently clear it, and it is what the device protocol
   * goes looking for.
   */
  occluded: boolean;
}

/**
 * Decide the overlay's height for the space that is actually visible.
 *
 * The visible band ends at `windowHeight - keyboardHeight - bottomInset`; the
 * overlay starts at the field's bottom edge. Everything between them, less a
 * gutter, is what the card may use.
 */
export function overlayFit(input: OverlayFitInput): OverlayFit {
  const desired = scaledOverlayCap(input.cap ?? DEFAULT_OVERLAY_MAX_HEIGHT, input.fontScale);

  const { fieldBottomY, windowHeight, keyboardHeight } = input;
  // Unmeasured, or a window we cannot reason about: grant the desire. Shrinking
  // on a measurement nobody took would be a guess dressed as avoidance.
  if (
    fieldBottomY == null ||
    !Number.isFinite(fieldBottomY) ||
    !Number.isFinite(windowHeight) ||
    windowHeight <= 0
  ) {
    return { maxHeight: desired, clamped: false, occluded: false };
  }

  const keyboard = Number.isFinite(keyboardHeight) && keyboardHeight > 0 ? keyboardHeight : 0;
  const inset = Number.isFinite(input.bottomInset ?? 0) ? Math.max(0, input.bottomInset ?? 0) : 0;
  const visibleBottom = windowHeight - keyboard - inset;
  const available = Math.floor(visibleBottom - fieldBottomY - OVERLAY_BOTTOM_GUTTER);

  if (available >= desired) return { maxHeight: desired, clamped: false, occluded: false };
  if (available >= MIN_OVERLAY_HEIGHT) {
    return { maxHeight: available, clamped: true, occluded: false };
  }
  return { maxHeight: MIN_OVERLAY_HEIGHT, clamped: true, occluded: true };
}

/**
 * §46 dynamic type — how many lines a suggestion's title/subtitle may use.
 *
 * `numberOfLines={1}` at 2x text turns "Đà Nẵng, Vietnam" into "Đà Na…", which
 * is not large-text SUPPORT: it is the same row with less of the answer in it.
 * Wrapping instead of truncating is the only way the label survives the scale,
 * and the overlay's own internal ScrollView absorbs the extra height.
 *
 * Deliberately capped at 3: past that a single row would fill the card and the
 * list would stop being a list.
 */
export function rowLineLimit(fontScale: number | undefined): number {
  const s = safeFontScale(fontScale);
  if (s < 1.3) return 1;
  if (s < 2) return 2;
  return 3;
}
