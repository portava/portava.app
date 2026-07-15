/**
 * Stamp Artwork Validation
 *
 * Pure TypeScript — no React, no RN.
 * Guards against unsafe SVG content, unrecognized file types, and missing
 * accessibility labels before artwork is accepted or displayed.
 */

/* ── SVG safety ──────────────────────────────────────────────────────────── */

/**
 * Patterns that indicate potentially dangerous SVG content.
 * Any match causes the SVG to be rejected.
 */
const UNSAFE_SVG_PATTERNS: RegExp[] = [
  /<script/i,
  /on\w+\s*=/i,                                   // inline event handlers (onclick= etc.)
  /javascript\s*:/i,                              // javascript: URIs
  /<iframe/i,
  /<embed/i,
  /<object/i,
  /xlink:href\s*=\s*["'](?!#)/i,                  // external xlink:href (non-fragment)
  /href\s*=\s*["']javascript/i,
  /<use\b[^>]*\bhref\s*=\s*["'][^#]/i,            // <use href="external-url">
  /data:(?!image\/(?:png|jpeg|gif|webp|svg\+xml))/i, // data URIs other than safe images
];

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Inspect an SVG string for unsafe content.
 * Returns `{ valid: false, errors }` if any unsafe pattern is found.
 */
export function validateSvgContent(svgString: string): ValidationResult {
  const errors: string[] = [];
  for (const pattern of UNSAFE_SVG_PATTERNS) {
    if (pattern.test(svgString)) {
      errors.push(`Unsafe SVG pattern detected: ${pattern.toString()}`);
      break; // one error is sufficient — fail fast
    }
  }
  return { valid: errors.length === 0, errors };
}

/* ── Image file type ─────────────────────────────────────────────────────── */

const ALLOWED_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/svg+xml',
]);

const ALLOWED_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.svg'];

/**
 * Validate that an artwork image URL refers to an allowed file type.
 * When a `mimeType` is provided it is checked directly; otherwise the
 * function attempts to infer the type from the URL extension.
 */
export function validateArtworkImageUrl(
  url: string,
  mimeType?: string,
): ValidationResult {
  const errors: string[] = [];

  if (mimeType) {
    if (!ALLOWED_MIME_TYPES.has(mimeType.toLowerCase())) {
      errors.push(
        `Unrecognized file type "${mimeType}". Allowed: ${[...ALLOWED_MIME_TYPES].join(', ')}`,
      );
    }
  } else {
    const clean = url.toLowerCase().split('?')[0]; // strip query params
    const allowed = ALLOWED_EXTENSIONS.some((ext) => clean.endsWith(ext));
    if (!allowed) {
      errors.push(
        `Cannot determine file type from URL "${url}". ` +
        `Allowed extensions: ${ALLOWED_EXTENSIONS.join(', ')}`,
      );
    }
  }

  return { valid: errors.length === 0, errors };
}

/* ── Accessibility label ─────────────────────────────────────────────────── */

const MIN_LABEL_LENGTH = 5;

/**
 * Ensure a stamp artwork definition carries a meaningful accessibility label.
 */
export function validateAccessibilityLabel(
  label: string | undefined | null,
): ValidationResult {
  const errors: string[] = [];
  if (!label || label.trim().length === 0) {
    errors.push('Stamp artwork must have a non-empty accessibility label');
  } else if (label.trim().length < MIN_LABEL_LENGTH) {
    errors.push(
      `Accessibility label is too short (minimum ${MIN_LABEL_LENGTH} characters, got ${label.trim().length})`,
    );
  }
  return { valid: errors.length === 0, errors };
}

/* ── Icon name allowlist ─────────────────────────────────────────────────── */

/**
 * Lucide icon names that are registered in the stamp icon resolver.
 * Artwork definitions submitted via the admin API must use one of these names
 * so the mobile app can actually render the icon.
 */
export const ALLOWED_ICON_NAMES = new Set([
  'MapPin', 'Users', 'Gem', 'ShieldCheck', 'Crown', 'Ticket',
  'Sparkles', 'Star', 'Lock', 'QrCode', 'Compass', 'Plane', 'Globe',
  'Heart', 'Camera', 'Mountain', 'Waves', 'Building2', 'TreePine',
  'Utensils', 'Music', 'Coffee', 'Ship', 'Train', 'Bus', 'Bike',
]);

/**
 * Validate that an icon name is in the allowed set.
 * Returns `{ valid: false, errors }` if the name is not recognised.
 */
export function validateIconName(iconName: string | undefined | null): ValidationResult {
  const errors: string[] = [];
  if (!iconName || !iconName.trim()) {
    errors.push('Icon name is required');
  } else if (!ALLOWED_ICON_NAMES.has(iconName.trim())) {
    errors.push(
      `Icon "${iconName}" is not in the allowed set. ` +
      `Allowed: ${[...ALLOWED_ICON_NAMES].sort().join(', ')}`,
    );
  }
  return { valid: errors.length === 0, errors };
}

/* ── Combined validator ──────────────────────────────────────────────────── */

export interface ArtworkAssetInput {
  /** Raw SVG string, if the artwork is SVG-based. */
  svgContent?: string;
  /** URL of a raster / SVG image asset. */
  imageUrl?: string;
  /** MIME type, if known (from Content-Type header or upload metadata). */
  mimeType?: string;
  /** Accessibility label from the artwork definition. */
  accessibilityLabel?: string;
  /** Lucide icon name (validated against the allowlist when provided). */
  iconName?: string;
}

/**
 * Run all relevant validations on an artwork asset input.
 * Returns a combined result with all errors.
 */
export function validateArtworkAsset(input: ArtworkAssetInput): ValidationResult {
  const allErrors: string[] = [];

  if (input.svgContent) {
    const r = validateSvgContent(input.svgContent);
    allErrors.push(...r.errors);
  }

  if (input.imageUrl) {
    const r = validateArtworkImageUrl(input.imageUrl, input.mimeType);
    allErrors.push(...r.errors);
  }

  const labelResult = validateAccessibilityLabel(input.accessibilityLabel);
  allErrors.push(...labelResult.errors);

  if (input.iconName !== undefined) {
    const iconResult = validateIconName(input.iconName);
    allErrors.push(...iconResult.errors);
  }

  return { valid: allErrors.length === 0, errors: allErrors };
}
