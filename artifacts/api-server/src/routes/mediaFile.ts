/**
 * Private media delivery. Batch resolution returns viewer-bound app locators,
 * never provider bearer URLs. GET/HEAD recheck current permission and stream
 * authenticated storage bytes; browser AV uses the media-only cookie adapter.
 */
import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { checkRateLimit } from "../lib/rateLimit.js";
import { appStorageUrlInfo } from "../lib/mediaUrl.js";
import { authorizeMediaAccess, mediaAccessDeadline } from "../lib/mediaAccess.js";

import { deliverPrivateMedia } from "../lib/media/privateMediaDelivery.js";
import { requireMediaViewer, establishMediaBrowserSession, clearMediaBrowserSession } from "../lib/media/mediaBrowserSession.js";

const router = Router();
router.use((req, res, next) => {
  if (req.path.startsWith("/media/file") || req.path === "/media/sign") {
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    res.setHeader("Vary", "Authorization, Cookie");
  }
  next();
});
router.post("/media/file/session", asyncHandler(establishMediaBrowserSession));
router.delete("/media/file/session", clearMediaBrowserSession);

const LOCATOR_CACHE_SECONDS = 3600;
const ALLOWED_BUCKETS = new Set(["post-media", "profile-media"]);

/**
 * Branded generic placeholder served when a private event/trip header has
 * show_header_publicly = false.  Can be overridden via env for white-labelling.
 */
const GENERIC_COVER_URL =
  process.env.GENERIC_COVER_URL ??
  "https://portava.app/assets/generic-event-cover.jpg";

/**
 * Returns true when the path is an AI-generated event/trip header, the owning
 * entity has show_header_publicly explicitly set to false, AND the viewer is
 * NOT an owner/member/RSVP-holder who should always see the real image.
 *
 * Fail-CLOSED since census-media §28.8 (was Fail-OPEN: any DB error → false): an unreadable setting serves the generic cover, which blocks nothing.
 * Owners and direct members always receive the real asset regardless of
 * show_header_publicly — the flag masks the cover from casual/public viewers.
 */
async function isHeaderPrivate(
  sc: any,
  path: string,
  viewerId: string,
): Promise<boolean> {
  // Path convention: generated-visuals/{entity_type}/{entity_id}/...
  const m = path.match(
    /^generated-visuals\/(event|trip)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\//i,
  );
  if (!m) return false;
  const entityType = m[1];
  const entityId = m[2];
  try {
    // Static table names required for checkWritePathColumns static analysis.
    if (entityType === "event") {
      const { data, error } = await sc
        .from("events")
        .select("show_header_publicly, host_id")
        .eq("id", entityId)
        .maybeSingle();
      // §28.8: a read error MASKS (the generic cover); only a missing row means "not a header".
      if (error) return true; if (!data) return false;
      if ((data as any).show_header_publicly !== false) return false;
      // Owners / hosts always get the real image.
      if ((data as any).host_id === viewerId) return false;
      // Eligible RSVP-holders and non-banned role-holders get the real image.
      const [rsvp, role] = await Promise.all([
        sc.from("event_rsvps").select("status").eq("event_id", entityId).eq("user_id", viewerId).in("status", ["going", "maybe"]).maybeSingle(),
        sc.from("event_roles").select("role").eq("event_id", entityId).eq("user_id", viewerId).in("role", ["host", "co_host", "moderator"]).maybeSingle(),
      ]);
      if ((rsvp as any).data || (role as any).data) return false;
      return true; // outsider / casual viewer → generic cover
    } else {
      const { data, error } = await sc
        .from("trips")
        .select("show_header_publicly, owner_id")
        .eq("id", entityId)
        .maybeSingle();
      if (error) return true; if (!data) return false; // §28.8: a read error masks
      if ((data as any).show_header_publicly !== false) return false;
      // Trip owner always gets the real image.
      if ((data as any).owner_id === viewerId) return false;
      // Trip members get the real image.
      const { data: member } = await sc
        .from("trip_members")
        .select("user_id")
        .eq("trip_id", entityId)
        .eq("user_id", viewerId)
        .in("role", ["owner", "member"])
        .maybeSingle();
      if (member) return false;
      return true; // outsider → generic cover
    }
  } catch {
    return true; // §28.8: a thrown read masks too
  }
}

/** An identity-bound locator contains no credential and grants no access. */
function deliveryUrl(viewerId: string, bucket: string, path: string, transform?: { width?: number; quality?: number }): string {
  const query = new URLSearchParams({ viewer: viewerId });
  if (transform?.width !== undefined) query.set("width", String(transform.width));
  if (transform?.quality !== undefined) query.set("quality", String(transform.quality));
  return `/api/media/file/${[bucket, ...path.split("/")].map(encodeURIComponent).join("/")}?${query}`;
}

/** Advisory locator cache lifetime. Locators confer no authority: every byte
 * request rechecks current access. Keep expiry-sensitive objects from staying
 * in hydration caches beyond their source deadline. */
async function cacheSecondsFor(
  sc: any,
  viewerId: string,
  bucket: string,
  path: string,
): Promise<number> {
  const deadline = await mediaAccessDeadline(sc, viewerId, bucket, path);
  if (deadline === null) return LOCATOR_CACHE_SECONDS;
  const remaining = Math.floor((deadline - Date.now()) / 1000);
  return Math.max(1, Math.min(LOCATOR_CACHE_SECONDS, remaining));
}

// ── GET /api/media/file/:bucket/*path ─────────────────────────────────────────
router.get(
  "/media/file/:bucket/*path",
  asyncHandler(async (req, res) => {
    const auth = await requireMediaViewer(req, res);
    if (!auth) return;
    const { user } = auth;

    const sc = getServiceClient();
    if (!sc) { sendError(res, "server_not_configured"); return; }

    const rl = checkRateLimit("media_file", user.id, 300, 60_000);
    if (!rl.allowed) {
      res.setHeader("Retry-After", Math.ceil(rl.retryAfterMs / 1000).toString());
      sendError(res, "rate_limited", "Too many media requests.");
      return;
    }

    const bucket = String(req.params.bucket ?? "");
    // Express 5 named wildcard: *path arrives as an array of segments.
    const rawPath = (req.params as any).path;
    const path = (
      Array.isArray(rawPath) ? rawPath.join("/") : String(rawPath ?? "")
    ).replace(/^\/+/, "");

    if (!ALLOWED_BUCKETS.has(bucket) || !path || path.includes("..")) {
      sendError(res, "invalid_payload", "Invalid media reference");
      return;
    }

    // Preserve the existing controls; the transport applies them through the
    // authenticated image-render endpoint rather than a provider bearer URL.
    let transform: { width?: number; quality?: number } | undefined;
    const rawWidth = req.query.width;
    if (rawWidth !== undefined && rawWidth !== null && rawWidth !== "") {
      const parsedWidth = Number(rawWidth);
      if (Number.isFinite(parsedWidth) && parsedWidth > 0) {
        transform = { width: Math.round(Math.min(Math.max(parsedWidth, 1), 3000)) };
      }
    }
    const rawQuality = req.query.quality;
    if (rawQuality !== undefined && rawQuality !== null && rawQuality !== "") {
      const parsedQuality = Number(rawQuality);
      if (Number.isFinite(parsedQuality)) {
        // Round first so that sub-unit fractions like 0.1 don't slip through
        // the > 0 guard only to land as quality=0 after rounding inside
        // storage rendering. Clamp to [0, 100], then drop if rounded to 0.
        const qualityRounded = Math.round(Math.min(Math.max(parsedQuality, 0), 100));
        if (qualityRounded > 0) {
          transform = { ...transform, quality: qualityRounded };
        }
      }
    }

    await deliverPrivateMedia(req, res, sc, user.id, bucket, path, transform, {
      onAuthorized: async () => {
        if (!await isHeaderPrivate(sc, path, user.id)) return true;
        if (!res.destroyed) res.redirect(302, GENERIC_COVER_URL);
        return false;
      },
    });
  }),
);

// ── POST /api/media/sign — batch for feed hydration ──────────────────────────
router.post(
  "/media/sign",
  asyncHandler(async (req, res) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const { user } = auth;

    const sc = getServiceClient();
    if (!sc) { sendError(res, "server_not_configured"); return; }

    const rl = checkRateLimit("media_sign", user.id, 60, 60_000);
    if (!rl.allowed) {
      res.setHeader("Retry-After", Math.ceil(rl.retryAfterMs / 1000).toString());
      sendError(res, "rate_limited", "Too many sign requests.");
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const urls: unknown = body.urls;
    if (!Array.isArray(urls) || urls.length === 0 || urls.length > 50) {
      sendError(
        res,
        "invalid_payload",
        "urls must be an array of 1–50 app media URLs",
      );
      return;
    }

    // The locator carries bounded transform controls. The GET request
    // applies them only after checking current media access.
    let transform: { width?: number; quality?: number } | undefined;
    const rawTransform = body.transform;
    if (rawTransform !== null && rawTransform !== undefined && typeof rawTransform === "object" && !Array.isArray(rawTransform)) {
      const t = rawTransform as Record<string, unknown>;
      // Preserve width opt-out: a rounded non-positive width drops the
      // whole transform, including quality. Infinity is clamped; NaN omitted.
      const widthRounded =
        typeof t.width === "number" && !Number.isNaN(t.width)
          ? Math.round(Math.min(t.width, 3000))
          : undefined;
      if (widthRounded !== undefined && widthRounded <= 0) {
        // Drop everything — no transform forwarded.
      } else {
        const width = widthRounded;
        // quality=0 (and sub-unit fractions that round to 0) are dropped entirely
        // — same rule as width=0.  Round first, then guard, so that e.g. 0.1
        // doesn't slip through the > 0 check only to land as quality=0 after
        // rounding.  Positive rounded values are clamped to [1, 100].
        const qualityRounded = typeof t.quality === "number" ? Math.round(Math.min(Math.max(t.quality, 0), 100)) : undefined;
        const quality = qualityRounded !== undefined && qualityRounded > 0 ? qualityRounded : undefined;
        if (width !== undefined || quality !== undefined) {
          transform = { width, quality };
        }
      }
    }

    const signed: Record<string, string | null> = {};
    let issuedTtlSeconds = LOCATOR_CACHE_SECONDS;
    for (const raw of urls) {
      const url = typeof raw === "string" ? raw : "";
      const ref = appStorageUrlInfo(url);
      if (!ref) { signed[url] = null; continue; }
      const ok = await authorizeMediaAccess(sc, user.id, ref.bucket, ref.path);
      if (!ok) { signed[url] = null; continue; }
      if (await isHeaderPrivate(sc, ref.path, user.id)) {
        signed[url] = GENERIC_COVER_URL;
        continue;
      }
      const ttl = await cacheSecondsFor(sc, user.id, ref.bucket, ref.path);
      // Report the shortest source deadline for this batch's locator cache.
      if (ttl < issuedTtlSeconds) issuedTtlSeconds = ttl;
      signed[url] = deliveryUrl(user.id, ref.bucket, ref.path, transform);
    }

    res.json({ signed, ttlSeconds: issuedTtlSeconds, delivery: "authenticated" });
  }),
);

export default router;
