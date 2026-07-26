/**
 * Open Graph / metadata endpoint
 *
 * GET /api/og/:type/:id
 *
 * Returns an HTML page whose <head> contains Open Graph and Twitter Card meta
 * tags used by link-preview scrapers (Slack, iMessage, WhatsApp, Twitter/X).
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

function buildOgHtml(opts: {
  title: string;
  description: string;
  url: string;
  imageUrl?: string | null;
  noindex: boolean;
  siteName?: string;
}): string {
  const { title, description, url, imageUrl, noindex, siteName = "Portava" } = opts;
  const robots = noindex ? "noindex, nofollow" : "index, follow";
  const imgMeta = imageUrl
    ? `<meta property="og:image" content="${escXml(imageUrl)}" />\n  <meta name="twitter:image" content="${escXml(imageUrl)}" />`
    : "";

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
  <meta name="twitter:card" content="summary" />
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
// Route
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

  // OG pages are briefly cacheable; preview scrapers respect Cache-Control.
  res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
  res.type("text/html; charset=utf-8");

  const viewerId = await getViewerId(sc, req);
  const { title: gTitle, description: gDesc } = GENERIC[type]!;
  const fallback = (path: string) =>
    buildOgHtml({ title: gTitle, description: gDesc, url: `${origin}${path}`, noindex: true });

  // ── Profile ────────────────────────────────────────────────────────────────
  if (type === "profile") {
    const { data: profile } = await sc
      .from("profiles")
      .select("id, handle, display_name, name, bio, avatar_url, is_private, passport_visibility, account_status")
      .or(`handle.eq.${idSafe},id.eq.${idSafe}`)
      .maybeSingle();

    if (!profile) {
      res.send(fallback(`/u/${idSafe}`));
      return;
    }

    const { visibility } = await resolveProfileVisibility(sc, viewerId, (profile as any).id, profile).catch(
      () => ({ visibility: "unavailable" as const, privacySettings: null }),
    );

    if (visibility === "unavailable" || visibility === "blocked" || visibility === "limited_preview") {
      res.send(fallback(`/u/${(profile as any).handle ?? idSafe}`));
      return;
    }

    const handle = (profile as any).handle ? `@${(profile as any).handle}` : "Traveler";
    const bio = ((profile as any).bio as string | null) ?? "";
    res.send(buildOgHtml({
      title: `${handle} on Portava`,
      description: bio.slice(0, 200) || `Check out ${handle}'s travel passport on Portava.`,
      url: `${origin}/u/${(profile as any).handle ?? idSafe}`,
      imageUrl: (profile as any).avatar_url ?? null,
      noindex: false,
    }));
    return;
  }

  // ── Event ──────────────────────────────────────────────────────────────────
  if (type === "event") {
    if (!UUID_RE.test(idSafe)) { res.send(fallback(`/events/${idSafe}`)); return; }

    const { data: ev } = await sc
      .from("events")
      .select("id, title, description, city, country, visibility, host_id, state, cover_url")
      .eq("id", idSafe)
      .maybeSingle();

    if (!ev) { res.send(fallback(`/events/${idSafe}`)); return; }

    // Only public events get real OG metadata; everything else gets the
    // generic private card.  Block check: a blocked host → fallback.
    const evVis = (ev as any).visibility as string ?? "invite_only";
    const isPublic = evVis === "public";
    const hostBlocked = viewerId ? await blocked(sc, viewerId, (ev as any).host_id) : false;

    if (!isPublic || hostBlocked) {
      res.send(fallback(`/events/${idSafe}`));
      return;
    }

    // Public event: safe fields only — no exact venue/address/coordinates.
    const loc = [(ev as any).city, (ev as any).country].filter(Boolean).join(", ");
    const rawDesc = ((ev as any).description as string | null) ?? "";
    const desc = rawDesc.slice(0, 200) || `A public event${loc ? ` in ${loc}` : ""} on Portava.`;

    res.send(buildOgHtml({
      title: `${(ev as any).title} · Portava`,
      description: desc,
      url: `${origin}/events/${idSafe}`,
      imageUrl: (ev as any).cover_url ?? null,
      noindex: false,
    }));
    return;
  }

  // ── Trip ───────────────────────────────────────────────────────────────────
  if (type === "trip") {
    if (!UUID_RE.test(idSafe)) { res.send(fallback(`/trips/${idSafe}`)); return; }

    const { data: trip } = await sc
      .from("trips")
      .select("id, title, destination_city, destination_country, visibility, owner_id, cover_url, show_destination_city")
      .eq("id", idSafe)
      .maybeSingle();

    if (!trip) { res.send(fallback(`/trips/${idSafe}`)); return; }

    // Only public trips get real OG metadata.
    const tripVis = (trip as any).visibility as string ?? "private";
    const isPublicTrip = tripVis === "public";
    const ownerBlocked = viewerId ? await blocked(sc, viewerId, (trip as any).owner_id) : false;

    if (!isPublicTrip || ownerBlocked) {
      res.send(fallback(`/trips/${idSafe}`));
      return;
    }

    // Public trip: safe fields — no exact dates, hotel names, addresses, or
    // coordinates. Destination city only if the owner opted in.
    const showCity = (trip as any).show_destination_city !== false;
    const city = showCity ? ((trip as any).destination_city as string | null) : null;
    const country = (trip as any).destination_country as string | null;
    const loc = [city, country].filter(Boolean).join(", ");
    const desc = loc ? `A trip to ${loc} on Portava.` : "A trip shared on Portava.";

    res.send(buildOgHtml({
      title: `${(trip as any).title} · Portava`,
      description: desc,
      url: `${origin}/trips/${idSafe}`,
      imageUrl: (trip as any).cover_url ?? null,
      noindex: false,
    }));
    return;
  }

  res.status(404).type("text").send("Not found");
}));

export default router;
