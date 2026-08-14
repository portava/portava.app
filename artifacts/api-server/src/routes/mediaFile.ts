/**
 * Media file access routes — private-bucket signed URL relay.
 *
 *   GET  /api/media/file/:bucket/*  — authorize, then 302 to a short-lived
 *         signed URL.  Fail-closed: unauthorized or unknown objects 403/404.
 *   POST /api/media/sign            — batch variant for feed hydration:
 *         { urls: string[] } → { signed: { [url]: string | null } }
 *
 * Both buckets (post-media, profile-media) are PRIVATE.  The feature flag
 * `media_private_buckets_enabled` that previously gated the signed-URL path
 * has been retired — signed URLs are always issued.  Authorization runs
 * before signing in both routes.
 *
 * Generic cover fallback: when the path resolves to an AI-generated event or
 * trip header whose `show_header_publicly` column is explicitly false, the
 * route redirects to GENERIC_COVER_URL instead of signing the real asset.
 */
import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { checkRateLimit } from "../lib/rateLimit.js";
import { appStorageUrlInfo } from "../lib/mediaUrl.js";
import { authorizeMediaAccess } from "../lib/mediaAccess.js";

const router = Router();

const SIGNED_TTL_SECONDS = 3600;
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
 * Fail-OPEN: any DB error → false (do not accidentally block valid media).
 * Owners and direct members always receive the real signed URL regardless of
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
      // Treat any error (including missing column) as fail-open.
      if (error || !data) return false;
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
      if (error || !data) return false;
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
    return false;
  }
}

/**
 * Sign a private-bucket object.  Returns null when Supabase storage rejects
 * the request (object not found, permissions, etc.).
 *
 * When `transform` is supplied, the signed URL is generated via the
 * `/render/image/sign/` path which applies Supabase's on-the-fly image
 * transformation (resize to the requested width/quality).  This is the only
 * way to get a resized derivative from a private bucket — appending query
 * params to a regular signed URL has no effect.
 */
async function signUrl(
  sc: any,
  bucket: string,
  path: string,
  transform?: { width?: number; quality?: number },
): Promise<string | null> {
  const options = transform
    ? {
        transform: {
          ...(transform.width   !== undefined && { width:   transform.width   }),
          ...(transform.quality !== undefined && { quality: transform.quality }),
          resize: "contain" as const,
        },
      }
    : undefined;
  const { data, error } = await sc.storage
    .from(bucket)
    .createSignedUrl(path, SIGNED_TTL_SECONDS, options);
  if (error || !data?.signedUrl) return null;
  return data.signedUrl as string;
}

// ── GET /api/media/file/:bucket/*path ─────────────────────────────────────────
router.get(
  "/media/file/:bucket/*path",
  asyncHandler(async (req, res) => {
    const auth = await requireUser(req, res);
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

    const allowed = await authorizeMediaAccess(sc, user.id, bucket, path);
    if (!allowed) {
      sendError(res, "forbidden", "Not authorized for this media");
      return;
    }

    // Generic cover fallback: private event/trip header with show_header_publicly=false.
    // Owners and members always receive the real signed URL regardless.
    if (await isHeaderPrivate(sc, path, user.id)) {
      res.setHeader("Cache-Control", "private, max-age=60");
      res.redirect(302, GENERIC_COVER_URL);
      return;
    }

    // Optional image-transform: ?width=<n> and/or ?quality=<n> produce a
    // /render/image/sign/ URL that Supabase resizes on the fly.  This is the
    // only supported resize path for private-bucket media — transform params
    // appended to a plain /object/sign/ URL have no effect.  Values are
    // clamped to sane ranges to prevent abuse.
    //
    // width=0 is dropped entirely (not clamped to 1) — same as the batch POST
    // handler.  quality=0 is also dropped entirely (mirrors width=0 rule): a
    // caller that passes ?quality=0 receives a plain /object/sign/ URL, not a
    // /render/image/sign/ URL with quality=1 silently promoted.
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
        // createSignedUrl.  Clamp to [0, 100], then drop if rounded to 0.
        const qualityRounded = Math.round(Math.min(Math.max(parsedQuality, 0), 100));
        if (qualityRounded > 0) {
          transform = { ...transform, quality: qualityRounded };
        }
      }
    }

    const signedUrl = await signUrl(sc, bucket, path, transform);
    if (!signedUrl) { sendError(res, "not_found", "Media unavailable"); return; }

    // no-store: the signed URL has a finite lifetime (SIGNED_TTL_SECONDS).
    // Caching the redirect would allow the same URL to be reused near expiry.
    res.setHeader("Cache-Control", "no-store");
    res.redirect(302, signedUrl);
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

    // Optional image-transform options applied at sign time.  When supplied,
    // createSignedUrl produces a /render/image/sign/ URL which Supabase's CDN
    // resizes on the fly — the only supported resize path for private buckets.
    // Values are clamped to sane ranges to prevent misuse.
    let transform: { width?: number; quality?: number } | undefined;
    const rawTransform = body.transform;
    if (rawTransform !== null && rawTransform !== undefined && typeof rawTransform === "object" && !Array.isArray(rawTransform)) {
      const t = rawTransform as Record<string, unknown>;
      // width=0 (or any non-positive number) is treated as an explicit "no resize"
      // signal that drops the ENTIRE transform — including a concurrent valid
      // quality value.  A caller that passes { width: 0, quality: 75 } receives
      // a plain /object/sign/ URL (no transform forwarded at all), not a
      // /render/image/sign/ URL with only quality forwarded.  This matches the
      // intuition: width=0 means "I don't want a resized derivative", so
      // forwarding quality alone would produce an unexpected transform URL.
      if (typeof t.width === "number" && t.width <= 0) {
        // Drop everything — no transform forwarded.
      } else {
        const width = typeof t.width === "number" && t.width > 0 ? Math.round(Math.min(t.width, 3000)) : undefined;
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
      signed[url] = (await signUrl(sc, ref.bucket, ref.path, transform)) ?? null;
    }

    res.json({ signed, ttlSeconds: SIGNED_TTL_SECONDS });
  }),
);

export default router;
