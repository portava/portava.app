/**
 * Open Graph / metadata endpoint
 *
 * GET /api/og/:type/:id
 *
 * Returns an HTML page whose <head> contains Open Graph and Twitter Card meta
 * tags used by link-preview scrapers (Slack, iMessage, WhatsApp, Twitter/X).
 *
 * GET /api/og/:type/:id/image.png
 *
 * The image those tags point at, for events and trips. Scrapers cannot run our
 * signed-URL hydration, so the server resolves the stored object itself and
 * serves the bytes from this stable, unauthenticated URL — a raw storage
 * reference never leaves the process. Profiles reuse the passport OG image
 * (GET /api/users/:username/og-image.png), the same endpoint wellKnownShare.ts
 * points at. Both routes gate on one shared resolveEntity() so the image and
 * the card can never disagree about what is public. See lib/ogImage.ts.
 *
 * iMessage / WhatsApp compatibility notes
 * ─────────────────────────────────────────
 * • iMessage requires og:image:width + og:image:height to render the preview
 *   card at all — without them it silently falls back to the plain URL.
 * • WhatsApp caches the first response it receives, so private entities must
 *   send Cache-Control: no-store so the generic card is never cached against
 *   a URL that may later become public.
 * • twitter:card must be "summary_large_image" (not "summary") for landscape
 *   cover photos — otherwise Telegram and Slack show a tiny thumbnail.
 * • og:image:secure_url is required by some Slack/iMessage parsers when the
 *   image is served over HTTPS (which it always is in production).
 *
 * Privacy rules
 * ─────────────
 * • Private / non-public profiles, events, trips → generic title + noindex/nofollow.
 * • Public entities → public-safe fields only (no exact venue, no coordinates,
 *   no member names, no hotel/accommodation details).
 * • Blocked / unavailable → same generic branded card as private.
 *
 * Supported types: "profile", "event", "trip"
 */

import { Router } from "express";
import { getServiceClient } from "../lib/supabase.js";
import { resolveProfileVisibility, extractBearerToken } from "../lib/profileVisibility.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import {
  OG_IMAGE_WIDTH,
  OG_IMAGE_HEIGHT,
  resolveOgImageBytes,
  renderOgImagePng,
} from "../lib/ogImage.js";

const router = Router();

// ---------------------------------------------------------------------------
// Shared helpers (inline — these are private to each route file in the main
// router, so we replicate the minimal subset needed here rather than coupling
// to unexported internals).
// ---------------------------------------------------------------------------

function escXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Resolve the authenticated viewer ID from an optional Bearer token. */
async function getViewerId(
  sc: any,
  req: { headers: { authorization?: string } },
): Promise<string | null> {
  const token = extractBearerToken(req);
  if (!token) return null;
  try {
    const { data: { user }, error } = await sc.auth.getUser(token);
    if (error || !user) return null;
    return user.id;
  } catch {
    return null;
  }
}

/** Minimal block check: returns true if either party has blocked the other. */
async function blocked(sc: any, userA: string, userB: string): Promise<boolean> {
  try {
    const { data } = await sc
      .from("blocks")
      .select("id")
      .or(`and(blocker_id.eq.${userA},blocked_id.eq.${userB}),and(blocker_id.eq.${userB},blocked_id.eq.${userA})`)
      .limit(1);
    return ((data as any[]) ?? []).length > 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// HTML builder
// ---------------------------------------------------------------------------

/**
 * Image layout hint.
 *
 * "square"  → avatar-style; twitter:card = "summary"
 * "banner"  → landscape cover photo; twitter:card = "summary_large_image"
 *
 * No default dimensions are assumed — callers must supply imageWidth /
 * imageHeight when the actual pixel size is known.  Scrapers degrade
 * gracefully when the tags are absent, but emit wrong values if the
 * hardcoded guess doesn't match the stored image (iMessage crops the
 * preview in that case).
 */
type ImageLayout = "square" | "banner";

function buildOgHtml(opts: {
  title: string;
  description: string;
  url: string;
  imageUrl?: string | null;
  imageLayout?: ImageLayout;
  /** Actual stored pixel width of the image. Omit when unknown. */
  imageWidth?: number | null;
  /** Actual stored pixel height of the image. Omit when unknown. */
  imageHeight?: number | null;
  noindex: boolean;
  siteName?: string;
}): string {
  const {
    title,
    description,
    url,
    imageUrl,
    imageLayout = "banner",
    imageWidth,
    imageHeight,
    noindex,
    siteName = "Portava",
  } = opts;

  const robots = noindex ? "noindex, nofollow" : "index, follow";

  // Twitter card type depends on image shape.
  // "summary_large_image" is needed for landscape banners (events, trips).
  // "summary" is used for square avatars and the no-image fallback.
  const twitterCard = imageUrl && imageLayout === "banner" ? "summary_large_image" : "summary";

  let imgMeta = "";
  if (imageUrl) {
    const isHttps = imageUrl.startsWith("https://");
    // Use stored pixel dimensions when available; fall back to layout-based
    // defaults so iMessage / WhatsApp always receive valid dimension hints.
    // "banner" covers (events, trips) → standard 16:9 OG card (1200×630).
    // "square" avatars → 800×800 square crop.
    const defaultWidth  = imageLayout === "banner" ? 1200 : 800;
    const defaultHeight = imageLayout === "banner" ? 630  : 800;
    const finalWidth  = imageWidth  != null ? imageWidth  : defaultWidth;
    const finalHeight = imageHeight != null ? imageHeight : defaultHeight;
    const widthTag  = `<meta property="og:image:width" content="${finalWidth}" />`;
    const heightTag = `<meta property="og:image:height" content="${finalHeight}" />`;
    imgMeta = [
      `<meta property="og:image" content="${escXml(imageUrl)}" />`,
      isHttps
        ? `<meta property="og:image:secure_url" content="${escXml(imageUrl)}" />`
        : "",
      widthTag,
      heightTag,
      `<meta name="twitter:image" content="${escXml(imageUrl)}" />`,
    ]
      .filter(Boolean)
      .join("\n  ");
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escXml(title)}</title>
  <meta name="robots" content="${robots}" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="${escXml(siteName)}" />
  <meta property="og:title" content="${escXml(title)}" />
  <meta property="og:description" content="${escXml(description)}" />
  <meta property="og:url" content="${escXml(url)}" />
  ${imgMeta}
  <meta name="twitter:card" content="${twitterCard}" />
  <meta name="twitter:title" content="${escXml(title)}" />
  <meta name="twitter:description" content="${escXml(description)}" />
</head>
<body></body>
</html>`;
}

// Generic fallback cards — returned whenever the entity is private, locked,
// or missing.  These are deliberately vague so no information leaks.
const GENERIC: Record<string, { title: string; description: string }> = {
  profile: {
    title: "Private Profile",
    description: "This profile is private on Portava.",
  },
  event: {
    title: "Private Event on Portava",
    description: "This event is invite-only on Portava.",
  },
  trip: {
    title: "Private Trip on Portava",
    description: "This trip is private on Portava.",
  },
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Entity resolution — shared by the HTML card and the OG image
// ---------------------------------------------------------------------------

/**
 * What the two routes agree on about one entity.
 *
 * `publicCard` is null for private, blocked and missing entities alike. The
 * HTML route and the image route BOTH derive their answer from this one
 * function precisely so they cannot drift apart: an image that rendered a cover
 * photo for an entity whose HTML card said "Private Event" would leak exactly
 * what the generic card exists to hide.
 */
interface ResolvedEntity {
  /** Canonical site path — used for og:url and for the fallback card. */
  path: string;
  publicCard: {
    title: string;
    description: string;
    /**
     * The STORED media reference (bare `<bucket>/<path>`, or a legacy URL).
     * Never emitted to a client: it is resolved to bytes server-side by the
     * image route. See lib/ogImage.ts for why a raw reference is useless to a
     * scraper.
     */
    imageRef: string | null;
    /** Profile handle, so the card can point at the passport OG image. */
    handle: string | null;
  } | null;
}

const PRIVATE_ENTITY: (path: string) => ResolvedEntity = (path) => ({ path, publicCard: null });

async function resolveEntity(
  sc: any,
  type: string,
  idSafe: string,
  viewerId: string | null,
): Promise<ResolvedEntity> {
  // ── Profile ────────────────────────────────────────────────────────────────
  if (type === "profile") {
    const { data: profile } = await sc
      .from("profiles")
      .select("id, handle, display_name, name, bio, avatar_url, avatar_image_width, avatar_image_height, is_private, passport_visibility, account_status")
      .or(`handle.eq.${idSafe},id.eq.${idSafe}`)
      .maybeSingle();

    if (!profile) return PRIVATE_ENTITY(`/u/${idSafe}`);

    const path = `/u/${(profile as any).handle ?? idSafe}`;

    const { visibility } = await resolveProfileVisibility(sc, viewerId, (profile as any).id, profile).catch(
      () => ({ visibility: "unavailable" as const, privacySettings: null }),
    );

    if (visibility === "unavailable" || visibility === "blocked" || visibility === "limited_preview") {
      return PRIVATE_ENTITY(path);
    }

    const handle = (profile as any).handle ? `@${(profile as any).handle}` : "Traveler";
    const bio = ((profile as any).bio as string | null) ?? "";
    return {
      path,
      publicCard: {
        title: `${handle} on Portava`,
        description: bio.slice(0, 200) || `Check out ${handle}'s travel passport on Portava.`,
        imageRef: ((profile as any).avatar_url ?? null) as string | null,
        handle: ((profile as any).handle ?? null) as string | null,
      },
    };
  }

  // ── Event ──────────────────────────────────────────────────────────────────
  if (type === "event") {
    const path = `/events/${idSafe}`;
    if (!UUID_RE.test(idSafe)) return PRIVATE_ENTITY(path);

    const { data: ev } = await sc
      .from("events")
      .select("id, title, description, city, country, visibility, host_id, state, cover_url, cover_image_width, cover_image_height")
      .eq("id", idSafe)
      .maybeSingle();

    if (!ev) return PRIVATE_ENTITY(path);

    // Only public events get real OG metadata; everything else gets the
    // generic private card.  Block check: a blocked host → fallback.
    const evVis = (ev as any).visibility as string ?? "invite_only";
    const isPublic = evVis === "public";
    const hostBlocked = viewerId ? await blocked(sc, viewerId, (ev as any).host_id) : false;

    if (!isPublic || hostBlocked) return PRIVATE_ENTITY(path);

    // Public event: safe fields only — no exact venue/address/coordinates.
    const loc = [(ev as any).city, (ev as any).country].filter(Boolean).join(", ");
    const rawDesc = ((ev as any).description as string | null) ?? "";
    return {
      path,
      publicCard: {
        title: `${(ev as any).title} · Portava`,
        description: rawDesc.slice(0, 200) || `A public event${loc ? ` in ${loc}` : ""} on Portava.`,
        imageRef: ((ev as any).cover_url ?? null) as string | null,
        handle: null,
      },
    };
  }

  // ── Trip ───────────────────────────────────────────────────────────────────
  if (type === "trip") {
    const path = `/trips/${idSafe}`;
    if (!UUID_RE.test(idSafe)) return PRIVATE_ENTITY(path);

    const { data: trip } = await sc
      .from("trips")
      .select("id, title, destination_city, destination_country, visibility, owner_id, cover_url, cover_image_width, cover_image_height, show_destination_city")
      .eq("id", idSafe)
      .maybeSingle();

    if (!trip) return PRIVATE_ENTITY(path);

    // Only public trips get real OG metadata.
    const tripVis = (trip as any).visibility as string ?? "private";
    const isPublicTrip = tripVis === "public";
    const ownerBlocked = viewerId ? await blocked(sc, viewerId, (trip as any).owner_id) : false;

    if (!isPublicTrip || ownerBlocked) return PRIVATE_ENTITY(path);

    // Public trip: safe fields — no exact dates, hotel names, addresses, or
    // coordinates. Destination city only if the owner opted in.
    const showCity = (trip as any).show_destination_city !== false;
    const city = showCity ? ((trip as any).destination_city as string | null) : null;
    const country = (trip as any).destination_country as string | null;
    const loc = [city, country].filter(Boolean).join(", ");
    return {
      path,
      publicCard: {
        title: `${(trip as any).title} · Portava`,
        description: loc ? `A trip to ${loc} on Portava.` : "A trip shared on Portava.",
        imageRef: ((trip as any).cover_url ?? null) as string | null,
        handle: null,
      },
    };
  }

  return PRIVATE_ENTITY("/");
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

router.get("/og/:type/:id", asyncHandler(async (req, res) => {
  const { type, id } = req.params;

  if (!["profile", "event", "trip"].includes(type)) {
    res.status(404).type("text").send("Not found");
    return;
  }

  const sc = getServiceClient();
  if (!sc) { res.status(503).type("text").send("Service unavailable"); return; }

  // Sanitise the id param (username handle or UUID).
  const idSafe = id.replace(/[^a-zA-Z0-9_\-]/g, "").slice(0, 100);
  if (!idSafe) {
    res.status(404).type("text").send("Not found");
    return;
  }

  // Derive a stable canonical URL from the request host.
  const origin = `${req.protocol}://${req.get("host")}`;

  res.type("text/html; charset=utf-8");

  const viewerId = await getViewerId(sc, req);
  const { title: gTitle, description: gDesc } = GENERIC[type]!;

  const resolved = await resolveEntity(sc, type, idSafe, viewerId);

  /**
   * Fallback (private/missing) card.
   *
   * Cache-Control: no-store — WhatsApp and Telegram cache the first response
   * they receive for a URL and will serve that cached card indefinitely.
   * Using no-store ensures they re-fetch when the entity becomes public, and
   * prevents the generic card from being stored against a URL that the entity
   * owner may later make public.
   */
  if (!resolved.publicCard) {
    res.setHeader("Cache-Control", "no-store");
    res.send(buildOgHtml({
      title: gTitle,
      description: gDesc,
      url: `${origin}${resolved.path}`,
      noindex: true,
    }));
    return;
  }

  // Public entity: brief cache so scrapers can share the same response, but
  // short enough to pick up cover/avatar changes.
  res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=300");

  /**
   * og:image never carries the stored reference itself — see lib/ogImage.ts.
   *
   * Profiles reuse the passport OG image, which already renders a 1200×630
   * card under the same visibility rules; wellKnownShare.ts points at it for
   * exactly this reason. Events and trips get the endpoint below. Both are
   * 1200×630 landscape, so both are "banner" — a profile card is no longer a
   * square avatar and must not claim to be one, or Slack and Telegram render
   * the passport card as a cropped thumbnail.
   */
  const imageUrl = type === "profile"
    ? `${origin}/api/users/${encodeURIComponent(resolved.publicCard.handle ?? idSafe)}/og-image.png`
    : `${origin}/api/og/${type}/${encodeURIComponent(idSafe)}/image.png`;

  res.send(buildOgHtml({
    title: resolved.publicCard.title,
    description: resolved.publicCard.description,
    url: `${origin}${resolved.path}`,
    imageUrl,
    imageLayout: "banner",
    imageWidth: OG_IMAGE_WIDTH,
    imageHeight: OG_IMAGE_HEIGHT,
    noindex: false,
  }));
}));

/**
 * GET /og/:type/:id/image.png — the server-rendered OG image for an entity.
 *
 * Stable and unauthenticated: a scraper fetches this one URL forever and the
 * bytes stay valid, which a signed storage URL could never promise.
 *
 * Every non-public outcome — private, blocked, missing, unknown type, storage
 * down, undecodable bytes — returns the SAME generic branded card at 200.
 * Never a 404 and never a distinguishable error: a status code that varied by
 * entity state would leak existence just as surely as the cover photo would.
 */
router.get("/og/:type/:id/image.png", asyncHandler(async (req, res) => {
  const { type, id } = req.params;

  const sendPng = async (bytes: Buffer | null) => {
    const png = await renderOgImagePng(bytes);
    res.status(200).set({
      "Content-Type": "image/png",
      // Personalised renders expire fast so a visibility flip to private stops
      // showing the old cover quickly; the generic card carries no entity data
      // and can be cached hard.
      "Cache-Control": bytes
        ? "no-store, no-cache, must-revalidate"
        : "public, max-age=600",
    }).send(png);
  };

  // Profiles are served by the passport OG image endpoint, which owns the
  // passport card render. Anything else here is an unknown type.
  if (type !== "event" && type !== "trip") { await sendPng(null); return; }

  const sc = getServiceClient();
  if (!sc) { await sendPng(null); return; }

  const idSafe = id.replace(/[^a-zA-Z0-9_\-]/g, "").slice(0, 100);
  if (!idSafe) { await sendPng(null); return; }

  try {
    const viewerId = await getViewerId(sc, req);
    const resolved = await resolveEntity(sc, type, idSafe, viewerId);
    if (!resolved.publicCard) { await sendPng(null); return; }

    await sendPng(await resolveOgImageBytes(sc, resolved.publicCard.imageRef));
  } catch (e: any) {
    req.log?.warn?.({ err: e }, "og-image: lookup failed, serving generic card");
    await sendPng(null);
  }
}));

export default router;
