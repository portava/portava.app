/**
 * ogImage — resolve an entity's stored cover to real image bytes, server-side,
 * and render a 1200×630 Open Graph PNG.
 *
 * WHY THIS EXISTS
 * ---------------
 * routes/og.ts used to put the raw stored reference straight into the
 * `og:image` meta tag. That cannot work for a link-preview scraper:
 *
 *   - `post-media` and `profile-media` are PRIVATE buckets, so a stored
 *     `/object/public/<bucket>/…` URL does not serve. The scraper gets a 400
 *     and renders a card with no image.
 *   - The shape the upload endpoints write today is a bare `<bucket>/<path>`
 *     reference, which is not a URL at all. An `og:image` pointing at it is
 *     simply invalid.
 *   - The client-side fix for both — useHydratedMedia signing the reference
 *     on demand — is unavailable to Slack, iMessage and WhatsApp. They fetch
 *     one URL, unauthenticated, and never run our JavaScript.
 *
 * A signed URL is not the answer either: signatures expire, and scrapers cache
 * the URL they were given for far longer than any TTL we would issue. The
 * preview would work on the day it was shared and break afterwards.
 *
 * So the server resolves the object itself and serves the bytes from a stable,
 * unauthenticated endpoint. This mirrors the passport OG image
 * (GET /api/users/:username/og-image.png in routes/passport.ts), which
 * wellKnownShare.ts already points its own `og:image` at for the same reason.
 *
 * SECURITY
 * --------
 * Resolution is storage-only and goes through the service client, never an
 * outbound HTTP fetch. `cover_url` is written from a client-supplied field
 * (`b.coverUrl` in routes/events.ts and routes/trips.ts) and is NOT validated
 * against our buckets on write, so treating it as a fetchable URL would turn
 * this endpoint into an SSRF gadget pointed at anything an event host typed.
 * `appStorageUrlInfo` accepts only `post-media` / `profile-media`, rejects
 * traversal, and rejects any absolute URL that is not on our own origin;
 * anything it refuses renders the generic branded card instead.
 */

import { appStorageUrlInfo } from "./mediaUrl.js";

/** Standard Open Graph card size. iMessage and Slack both expect 1.91:1. */
export const OG_IMAGE_WIDTH = 1200;
export const OG_IMAGE_HEIGHT = 630;

/** Refuse absurd payloads before handing bytes to the image decoder. */
const MAX_SOURCE_BYTES = 10 * 1024 * 1024;

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Download the object a stored media reference points at.
 *
 * Accepts every shape the database actually holds — bare `<bucket>/<path>`,
 * `/object/public/<bucket>/…`, and the image-transform `/render/image/…`
 * variant — because `appStorageUrlInfo` already normalises all of them to
 * `{ bucket, path }`. Private buckets are fine: the service client reads them
 * directly, which is the entire point of resolving server-side.
 *
 * Returns null for anything not in our storage (external avatar hosts left by
 * seed data, or a `cover_url` someone typed by hand). Null is not an error —
 * it means "render the branded card", which is a working preview rather than a
 * broken image.
 */
export async function resolveOgImageBytes(
  sc: any,
  ref: string | null | undefined,
): Promise<Buffer | null> {
  if (!ref) return null;

  const info = appStorageUrlInfo(ref);
  if (!info) return null;

  try {
    const { data, error } = await sc.storage.from(info.bucket).download(info.path);
    if (error || !data) return null;
    const buf = Buffer.from(await data.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_SOURCE_BYTES) return null;
    return buf;
  } catch {
    // A storage outage must degrade to the branded card, never to a 500 —
    // a failed preview fetch is what makes a chat app cache a broken card.
    return null;
  }
}

/**
 * The generic branded card. Deliberately carries no entity data: it is what a
 * private, blocked, missing or unresolvable entity returns, and those cases
 * must be byte-identical so the image response never leaks which one it was.
 */
function buildGenericOgSvg(): string {
  const navy = "#152642";
  const gold = "#C9A227";
  const cream = "#F5EFE0";

  return `<svg width="${OG_IMAGE_WIDTH}" height="${OG_IMAGE_HEIGHT}" viewBox="0 0 ${OG_IMAGE_WIDTH} ${OG_IMAGE_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${navy}"/>
      <stop offset="1" stop-color="#0E1B31"/>
    </linearGradient>
  </defs>
  <rect width="${OG_IMAGE_WIDTH}" height="${OG_IMAGE_HEIGHT}" fill="url(#bg)"/>
  <rect x="28" y="28" width="${OG_IMAGE_WIDTH - 56}" height="${OG_IMAGE_HEIGHT - 56}" fill="none" stroke="${gold}" stroke-width="3"/>
  <rect x="40" y="40" width="${OG_IMAGE_WIDTH - 80}" height="${OG_IMAGE_HEIGHT - 80}" fill="none" stroke="${gold}" stroke-width="1" opacity="0.55"/>
  <text x="${OG_IMAGE_WIDTH / 2}" y="300" text-anchor="middle" font-family="Georgia, serif" font-size="72" letter-spacing="14" fill="${gold}">${escapeXml("PORTAVA")}</text>
  <line x1="360" y1="350" x2="840" y2="350" stroke="${gold}" stroke-width="1.5" opacity="0.6"/>
  <text x="${OG_IMAGE_WIDTH / 2}" y="410" text-anchor="middle" font-family="Georgia, serif" font-size="30" fill="${cream}" opacity="0.8">${escapeXml("Scan the world, one stamp at a time")}</text>
</svg>`;
}

/** Render the generic branded 1200×630 card. */
export async function renderGenericOgPng(): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  return sharp(Buffer.from(buildGenericOgSvg())).png().toBuffer();
}

/**
 * Render `bytes` as a 1200×630 OG card, falling back to the branded card when
 * there are no bytes or they do not decode.
 *
 * `fit: "cover"` crops rather than letterboxes: a card with black bars reads as
 * broken in a chat preview. The decode is wrapped because these bytes come from
 * user uploads — a truncated or malformed object must produce the branded card,
 * not a 500 that teaches the scraper to cache a failure.
 */
export async function renderOgImagePng(bytes: Buffer | null): Promise<Buffer> {
  if (!bytes) return renderGenericOgPng();

  try {
    const sharp = (await import("sharp")).default;
    return await sharp(bytes)
      .resize(OG_IMAGE_WIDTH, OG_IMAGE_HEIGHT, { fit: "cover", position: "attention" })
      .png()
      .toBuffer();
  } catch {
    return renderGenericOgPng();
  }
}
