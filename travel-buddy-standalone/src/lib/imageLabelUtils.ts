/**
 * imageLabelUtils — pure mapping functions for real-place image source labels.
 *
 * All user-facing strings are defined here as a single source of truth so
 * every card, detail, and accessibility surface stays consistent and this file
 * is the only change needed for localisation.
 *
 * Maps `imageSourceType` + `accuracyStatus` + `disclaimerRequired` from the
 * accuracy pipeline onto a `PlaceImageSourceLabel` enum, then resolves the
 * final display string and accessibility copy.
 */

// ── Label enum ────────────────────────────────────────────────────────────────

/**
 * Canonical label categories for place images.
 * Null means "no label should be shown" (unclassified or legacy sources).
 */
export type PlaceImageSourceLabel =
  | 'official_photo'   // official / trusted_provider / tourism_authority
  | 'venue_provided'   // verified_owner
  | 'traveler_photo'   // verified_user_photo
  | 'reference_ai'     // reference_grounded_ai
  | 'illustrative'     // generic_ai_illustration / category_fallback / map_fallback + disclaimerRequired
  | null;

// ── All user-facing strings (single localisation entry point) ─────────────────

export const IMAGE_LABEL_STRINGS = {
  /** Short badge text on compact cards. */
  official_photo:           'Official photo',
  venue_provided:           'Venue-provided photo',
  traveler_photo:           'Traveler photo',
  reference_ai_short:       'Reference-grounded photo',
  illustrative_short:       'Illustrative image',

  /** Full disclosure text for info sheets and detail pages. */
  reference_ai_full:
    'Created using verified images of this location. Some presentation details may have been adjusted.',
  illustrative_full:
    'Illustrative image — this does not show the actual location.',

  /** Info sheet */
  info_sheet_title:         'About this image',

  /** Report flow */
  report_action_label:      'Report image',
  report_reason_label:      'This image does not match the place',
  report_confirm_title:     "Thanks — we'll review this",
  report_confirm_body:
    "We'll look into whether this image accurately shows the place and take action if needed.",
  report_cancel:            'Cancel',
  report_submit:            'Submit report',

  /** Accessibility prefix when an image carries a disclaimer. */
  accessibility_disclaimer_prefix: 'Disclaimer:',
} as const;

// ── Source label derivation ───────────────────────────────────────────────────

/**
 * Map image provenance fields onto a `PlaceImageSourceLabel` category.
 *
 * @param imageSourceType   Nine-category source classification from the accuracy pipeline.
 * @param disclaimerRequired  When true, low-trust sources force the 'illustrative' label.
 */
export function derivePlaceImageSourceLabel(
  imageSourceType?: string | null,
  disclaimerRequired?: boolean | null,
): PlaceImageSourceLabel {
  switch (imageSourceType) {
    case 'official':
    case 'trusted_provider':
    case 'tourism_authority':
      return 'official_photo';
    case 'verified_owner':
      return 'venue_provided';
    case 'verified_user_photo':
      return 'traveler_photo';
    case 'reference_grounded_ai':
      return 'reference_ai';
    case 'generic_ai_illustration':
    case 'category_fallback':
    case 'map_fallback':
      return disclaimerRequired ? 'illustrative' : null;
    case null:
    case undefined:
      return null;
    default:
      // `imageSourceType` comes from backend/DB data, not a compile-time
      // guarantee — an unrecognized value here means the source was
      // misclassified (or the nine-type enum drifted) upstream. Warn rather
      // than silently rendering no badge, so a misclassification never goes
      // unnoticed.
      if (typeof __DEV__ !== 'undefined' && __DEV__) {
        console.warn(
          `[imageLabelUtils] Unrecognized imageSourceType "${imageSourceType}" — falling back to no badge.`,
        );
      }
      return null;
  }
}

// ── Short / compact label text ────────────────────────────────────────────────

/**
 * Short text shown in compact card badges.
 * Returns null when no badge should be rendered.
 */
export function shortLabelText(label: PlaceImageSourceLabel): string | null {
  switch (label) {
    case 'official_photo':  return IMAGE_LABEL_STRINGS.official_photo;
    case 'venue_provided':  return IMAGE_LABEL_STRINGS.venue_provided;
    case 'traveler_photo':  return IMAGE_LABEL_STRINGS.traveler_photo;
    case 'reference_ai':    return IMAGE_LABEL_STRINGS.reference_ai_short;
    case 'illustrative':    return IMAGE_LABEL_STRINGS.illustrative_short;
    default:                return null;
  }
}

// ── Full disclosure text for detail pages / info sheets ───────────────────────

/**
 * Full disclosure text for info sheets and detail-page labels.
 * Falls back to a supplied `disclaimerText` (from the backend accuracy pipeline)
 * when the label category doesn't carry its own copy.
 */
export function fullDisclaimerText(
  label: PlaceImageSourceLabel,
  backendDisclaimerText?: string | null,
): string | null {
  switch (label) {
    case 'reference_ai':  return IMAGE_LABEL_STRINGS.reference_ai_full;
    case 'illustrative':  return IMAGE_LABEL_STRINGS.illustrative_full;
    default:
      return backendDisclaimerText ?? null;
  }
}

// ── Accessibility label builder ───────────────────────────────────────────────

/**
 * Build an accessibility label that includes the disclaimer when required.
 *
 * @param altText           Base description of the image (e.g. the place name).
 * @param disclaimerRequired  Whether a disclaimer must be announced to screen readers.
 * @param disclaimer          The disclaimer copy to append.
 */
export function buildPlaceImageAccessibilityLabel(
  altText: string,
  disclaimerRequired: boolean,
  disclaimer: string | null,
): string {
  if (disclaimerRequired && disclaimer) {
    return `${altText}. ${IMAGE_LABEL_STRINGS.accessibility_disclaimer_prefix} ${disclaimer}`;
  }
  return altText;
}
