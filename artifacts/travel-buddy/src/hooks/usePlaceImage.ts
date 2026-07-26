/**
 * usePlaceImage — shared hook for real-place image display metadata.
 *
 * Accepts the accuracy-pipeline provenance fields that travel alongside every
 * resolved place image and returns a single consistent shape that every card,
 * detail page, and map popup can render without re-implementing label logic.
 *
 * The hook is pure (no side effects) and memoised so it is safe to call on
 * every render without performance concerns.
 */
import { useMemo } from 'react';
import {
  derivePlaceImageSourceLabel,
  fullDisclaimerText,
  buildPlaceImageAccessibilityLabel,
  type PlaceImageSourceLabel,
} from '../lib/imageLabelUtils.ts';

// ── Input shape ───────────────────────────────────────────────────────────────

export interface PlaceImageInput {
  /** Resolved image URL. */
  url?: string | null;
  /**
   * Nine-category source classification from the accuracy pipeline
   * (ImageSourceType from api-server visuals/types.ts).
   */
  imageSourceType?: string | null;
  /** Current accuracy assessment from the verification pipeline. */
  accuracyStatus?: string | null;
  /** When true the UI must show a disclaimer. */
  disclaimerRequired?: boolean | null;
  /** Backend-supplied disclaimer copy (overridden by label-specific copy when available). */
  disclaimerText?: string | null;
  /**
   * True when the image is an AI-generated representation (legacy field from
   * the pre-accuracy-pipeline `resolveHeaderImage` resolver). Treated as
   * `illustrative` when present and no `imageSourceType` is available.
   */
  isRepresentation?: boolean;
  /** Alt text / place name used to build the accessibility label. */
  altText?: string | null;
}

// ── Output shape ──────────────────────────────────────────────────────────────

export interface PlaceImageResult {
  /** Resolved image URL (pass-through). */
  url: string | null;
  /**
   * Derived label category. Null means no badge/label should be shown.
   */
  sourceLabel: PlaceImageSourceLabel;
  /** Whether a disclaimer must be shown alongside this image. */
  disclaimerRequired: boolean;
  /** The disclaimer copy to display. Null when no disclaimer is needed. */
  disclaimerText: string | null;
  /**
   * Accessibility label including the disclaimer when required.
   * Null when no alt text was supplied.
   */
  accessibilityLabel: string | null;
  /**
   * True for the legacy AI representation case (backwards compat with
   * AiRepresentationLabel). When this is true and sourceLabel is null,
   * callers may still render AiRepresentationLabel.
   */
  isRepresentation: boolean;
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function usePlaceImage(input: PlaceImageInput): PlaceImageResult {
  return useMemo(() => {
    // Derive label from accuracy-pipeline source type.
    // Fall back to 'illustrative' for legacy AI representation images.
    const imageSourceType =
      input.imageSourceType ??
      (input.isRepresentation ? 'generic_ai_illustration' : null);

    const sourceLabel = derivePlaceImageSourceLabel(
      imageSourceType,
      input.disclaimerRequired,
    );

    // Disclaimer is required when the accuracy pipeline says so, or when the
    // label category inherently carries a disclaimer, or for legacy AI images.
    const effectiveDisclaimerRequired = !!(
      input.disclaimerRequired ||
      sourceLabel === 'illustrative' ||
      sourceLabel === 'reference_ai' ||
      (input.isRepresentation && !input.imageSourceType)
    );

    const disclaimer = fullDisclaimerText(sourceLabel, input.disclaimerText);

    const accessibilityLabel =
      input.altText
        ? buildPlaceImageAccessibilityLabel(
            input.altText,
            effectiveDisclaimerRequired,
            disclaimer,
          )
        : null;

    return {
      url: input.url ?? null,
      sourceLabel,
      disclaimerRequired: effectiveDisclaimerRequired,
      disclaimerText: disclaimer,
      accessibilityLabel,
      isRepresentation: !!(input.isRepresentation),
    };
  }, [
    input.url,
    input.imageSourceType,
    input.accuracyStatus,
    input.disclaimerRequired,
    input.disclaimerText,
    input.isRepresentation,
    input.altText,
  ]);
}
