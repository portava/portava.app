/**
 * Stamp overlay — shared pure logic for the optional passport-stamp badge
 * that can be placed on a Postcard photo.
 *
 * The server stores overlay metadata on `post_media.stamp_overlay` (jsonb):
 * the client only ever sends { stampDefinitionId, style, x, y, scale } at
 * upload-complete; the server resolves eligibility and PINS the artwork URL.
 * Everything here is display math + defensive parsing — no side effects, so
 * it is unit-testable in plain node.
 *
 * Coordinate model: x/y are the stamp CENTER, normalized 0..1 against the
 * rendered cover rect (the visible photo frame). scale is stamp diameter as a
 * fraction of the container width. The same overlayLayout() is used by the
 * composer editor and every feed surface so placement stays consistent.
 */

export type StampOverlayStyle = 'original' | 'white' | 'dark' | 'watermark';

/** Server-written overlay payload living on post_media.stamp_overlay. */
export interface StampOverlayData {
  stampDefinitionId: string;
  label: string;
  city: string | null;
  country: string | null;
  /** Artwork pinned server-side at publish — never rewritten afterwards. */
  artworkUrl: string;
  artworkPinnedAt?: string;
  style: StampOverlayStyle;
  x: number;
  y: number;
  scale: number;
  rotation: number;
  opacity: number;
}

/** Client-side editing state before publish (artworkUrl is preview-only). */
export interface StampOverlayDraft {
  stampDefinitionId: string;
  label: string;
  city: string | null;
  country: string | null;
  artworkUrl: string;
  style: StampOverlayStyle;
  x: number;
  y: number;
  scale: number;
}

/** One pickable stamp from GET /postcards/stamp-overlay-options. */
export interface StampOverlayOption {
  stampDefinitionId: string;
  name: string;
  city: string | null;
  country: string | null;
  rarity: string | null;
  artworkUrl: string;
}

export const STAMP_OVERLAY_MIN_SCALE = 0.12;
export const STAMP_OVERLAY_MAX_SCALE = 0.5;
export const STAMP_OVERLAY_DEFAULT_SCALE = 0.28;
export const STAMP_OVERLAY_SCALE_STEP = 0.04;
/** Default placement — bottom-right, like a real passport page. */
export const STAMP_OVERLAY_DEFAULT_POS = { x: 0.78, y: 0.8 };
export const STAMP_OVERLAY_WATERMARK_OPACITY = 0.45;
/** Keep the stamp center inside this band so it stays grabbable while editing. */
export const STAMP_OVERLAY_EDIT_MARGIN = 0.08;

export const STAMP_OVERLAY_STYLES: { key: StampOverlayStyle; label: string }[] = [
  { key: 'white', label: 'White ink' },
  { key: 'dark', label: 'Dark ink' },
  { key: 'original', label: 'Original' },
  { key: 'watermark', label: 'Watermark' },
];

export const STAMP_OVERLAY_CORNERS: { key: string; label: string; x: number; y: number }[] = [
  { key: 'tl', label: 'Top left', x: 0.2, y: 0.18 },
  { key: 'tr', label: 'Top right', x: 0.8, y: 0.18 },
  { key: 'bl', label: 'Bottom left', x: 0.2, y: 0.8 },
  { key: 'br', label: 'Bottom right', x: 0.8, y: 0.8 },
];

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

export function clamp01(v: number): number {
  return clamp(v, 0, 1);
}

/** Clamp a drag position so the stamp center stays inside the editable band. */
export function clampOverlayPosition(x: number, y: number): { x: number; y: number } {
  return {
    x: clamp(x, STAMP_OVERLAY_EDIT_MARGIN, 1 - STAMP_OVERLAY_EDIT_MARGIN),
    y: clamp(y, STAMP_OVERLAY_EDIT_MARGIN, 1 - STAMP_OVERLAY_EDIT_MARGIN),
  };
}

/** Effective render opacity: explicit value wins, watermark defaults translucent. */
export function overlayOpacityFor(style: StampOverlayStyle, opacity?: number | null): number {
  if (typeof opacity === 'number' && Number.isFinite(opacity)) return clamp(opacity, 0.05, 1);
  return style === 'watermark' ? STAMP_OVERLAY_WATERMARK_OPACITY : 1;
}

/**
 * Absolute layout for a container of the given size. Every surface (composer
 * editor, Pulse card, passport wall tile, post detail) calls this so the
 * badge lands on the same visual spot everywhere.
 */
export function overlayLayout(
  containerW: number,
  containerH: number,
  ov: Pick<StampOverlayData, 'x' | 'y' | 'scale' | 'style'> & { opacity?: number | null },
): { size: number; left: number; top: number; opacity: number } {
  const size = containerW * clamp(ov.scale, STAMP_OVERLAY_MIN_SCALE, STAMP_OVERLAY_MAX_SCALE);
  return {
    size,
    left: clamp01(ov.x) * containerW - size / 2,
    top: clamp01(ov.y) * containerH - size / 2,
    opacity: overlayOpacityFor(ov.style, ov.opacity),
  };
}

/**
 * The rect an image actually occupies when rendered with resizeMode="cover"
 * (it overflows the container on exactly one axis, centered). Exposed for
 * any surface that needs image-content-anchored math.
 */
export function computeCoverRect(
  containerW: number,
  containerH: number,
  imageW: number,
  imageH: number,
): { left: number; top: number; width: number; height: number; scale: number } {
  if (containerW <= 0 || containerH <= 0 || imageW <= 0 || imageH <= 0) {
    return { left: 0, top: 0, width: containerW, height: containerH, scale: 1 };
  }
  const scale = Math.max(containerW / imageW, containerH / imageH);
  const width = imageW * scale;
  const height = imageH * scale;
  return {
    left: (containerW - width) / 2,
    top: (containerH - height) / 2,
    width,
    height,
    scale,
  };
}

const VALID_STYLES: ReadonlySet<string> = new Set(['original', 'white', 'dark', 'watermark']);

function isHttpUrl(v: unknown): v is string {
  return typeof v === 'string' && (v.startsWith('https://') || v.startsWith('http://'));
}

/**
 * Defensive gate for the raw jsonb coming back through feeds. Feeds must
 * NEVER crash or show a broken badge because of malformed overlay data —
 * anything suspicious renders as "no overlay".
 */
export function parseStampOverlay(raw: unknown): StampOverlayData | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.stampDefinitionId !== 'string' || o.stampDefinitionId.length === 0) return null;
  if (typeof o.label !== 'string' || o.label.trim().length === 0) return null;
  if (!isHttpUrl(o.artworkUrl)) return null;

  const x = typeof o.x === 'number' && Number.isFinite(o.x) ? o.x : null;
  const y = typeof o.y === 'number' && Number.isFinite(o.y) ? o.y : null;
  const scale = typeof o.scale === 'number' && Number.isFinite(o.scale) ? o.scale : null;
  if (x === null || y === null || scale === null) return null;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;

  const style: StampOverlayStyle = VALID_STYLES.has(String(o.style))
    ? (o.style as StampOverlayStyle)
    : 'white';
  const rotation =
    typeof o.rotation === 'number' && Number.isFinite(o.rotation)
      ? clamp(o.rotation, -45, 45)
      : 0;

  return {
    stampDefinitionId: o.stampDefinitionId,
    label: o.label,
    city: typeof o.city === 'string' ? o.city : null,
    country: typeof o.country === 'string' ? o.country : null,
    artworkUrl: o.artworkUrl,
    artworkPinnedAt: typeof o.artworkPinnedAt === 'string' ? o.artworkPinnedAt : undefined,
    style,
    x,
    y,
    scale: clamp(scale, STAMP_OVERLAY_MIN_SCALE, STAMP_OVERLAY_MAX_SCALE),
    rotation,
    opacity: overlayOpacityFor(style, typeof o.opacity === 'number' ? o.opacity : undefined),
  };
}

/**
 * Airport-code style monogram for the procedural (ink) stamp faces:
 * multi-word names take word initials ("New York" → "NY", "Rio de Janeiro"
 * → "RDJ"), single words take their first three letters ("Tokyo" → "TOK").
 */
export function monogramFor(label: string): string {
  const words = label
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 0);
  if (words.length === 0) return 'ST';
  if (words.length === 1) return words[0].slice(0, 3).toUpperCase();
  return words
    .slice(0, 3)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
}

/** Build the draft placed when the user first picks a stamp. */
export function draftFromOption(option: StampOverlayOption): StampOverlayDraft {
  return {
    stampDefinitionId: option.stampDefinitionId,
    label: option.name,
    city: option.city,
    country: option.country,
    artworkUrl: option.artworkUrl,
    style: 'white',
    x: STAMP_OVERLAY_DEFAULT_POS.x,
    y: STAMP_OVERLAY_DEFAULT_POS.y,
    scale: STAMP_OVERLAY_DEFAULT_SCALE,
  };
}

/** Adapt an editing draft to the badge's render shape (no rotation while editing). */
export function draftToRenderData(draft: StampOverlayDraft): StampOverlayData {
  return {
    ...draft,
    rotation: 0,
    opacity: overlayOpacityFor(draft.style),
  };
}

/** The exact payload complete-upload sends — never includes artwork URLs. */
export function completePayloadFromDraft(draft: StampOverlayDraft): {
  stampDefinitionId: string;
  style: StampOverlayStyle;
  x: number;
  y: number;
  scale: number;
} {
  return {
    stampDefinitionId: draft.stampDefinitionId,
    style: draft.style,
    x: clamp01(draft.x),
    y: clamp01(draft.y),
    scale: clamp(draft.scale, STAMP_OVERLAY_MIN_SCALE, STAMP_OVERLAY_MAX_SCALE),
  };
}
