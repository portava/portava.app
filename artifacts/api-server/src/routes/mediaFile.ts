/**
 * Media file access routes — the bucket-privacy compatibility layer.
 *
 *   GET  /api/media/file/:bucket/*  — authorize, then 302 to the file:
 *         • bucket still PUBLIC (Stage 1)  → redirect to the public URL
 *           (zero behavior change; lets clients migrate ahead of the flip)
 *         • bucket PRIVATE (post-Stage-3)  → redirect to a short-lived
 *           signed URL (bytes finally match row-level privacy)
 *   POST /api/media/sign            — batch variant for feed hydration:
 *         { urls: string[] } → { signed: { [url]: string | null } }
 *
 * Mode is driven by feature flag `media_private_buckets_enabled` (OFF = public
 * mode). Authorization runs in BOTH modes — turning the flag on changes only
 * what we redirect to, never who is allowed. Fail-closed: unauthorized or
 * unknown objects 403/404 regardless of mode.
 */
import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { isFlagEnabled } from "../lib/featureFlags.js";
import { checkRateLimit } from "../lib/rateLimit.js";
import { appStorageUrlInfo } from "../lib/mediaUrl.js";
import { authorizeMediaAccess, publicUrlFor } from "../lib/mediaAccess.js";

const router = Router();

const SIGNED_TTL_SECONDS = 3600;
const ALLOWED_BUCKETS = new Set(["post-media", "profile-media"]);

async function resolveRedirect(
  sc: any,
  bucket: string,
  path: string,
): Promise<{ url: string; privateMode: boolean } | null> {
  if (await isFlagEnabled(sc, "media_private_buckets_enabled")) {
    const { data, error } = await sc.storage.from(bucket).createSignedUrl(path, SIGNED_TTL_SECONDS);
    if (error || !data?.signedUrl) return null;
    return { url: data.signedUrl as string, privateMode: true };
  }
  const url = publicUrlFor(bucket, path);
  return url ? { url, privateMode: false } : null;
}

// ── GET /api/media/file/:bucket/*path ─────────────────────────────────────────
router.get("/media/file/:bucket/*path", asyncHandler(async (req, res) => {
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
  const path = (Array.isArray(rawPath) ? rawPath.join("/") : String(rawPath ?? "")).replace(/^\/+/, "");
  if (!ALLOWED_BUCKETS.has(bucket) || !path || path.includes("..")) {
    sendError(res, "invalid_payload", "Invalid media reference");
    return;
  }

  const allowed = await authorizeMediaAccess(sc, user.id, bucket, path);
  if (!allowed) { sendError(res, "forbidden", "Not authorized for this media"); return; }

  const resolved = await resolveRedirect(sc, bucket, path);
  if (!resolved) { sendError(res, "not_found", "Media unavailable"); return; }

  // In private-buckets mode the signed URL has a finite lifetime (SIGNED_TTL_SECONDS).
  // Allowing the browser to cache this redirect for up to 300 s means the same
  // signed URL can be reused near the end of its lifetime, recreating the
  // mid-session expiry window the batch-sign safety buffer was added to prevent.
  // Using no-store forces every fetch to re-hit the relay and receive a
  // freshly-issued signed URL.
  // In public mode the redirect target never expires, so a short private cache
  // is harmless and reduces load.
  res.setHeader(
    "Cache-Control",
    resolved.privateMode ? "no-store" : "private, max-age=300",
  );
  res.redirect(302, resolved.url);
}));

// ── POST /api/media/sign — batch for feed hydration ──────────────────────────
router.post("/media/sign", asyncHandler(async (req, res) => {
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

  const urls: unknown = (req.body ?? {}).urls;
  if (!Array.isArray(urls) || urls.length === 0 || urls.length > 50) {
    sendError(res, "invalid_payload", "urls must be an array of 1–50 app media URLs");
    return;
  }

  const signed: Record<string, string | null> = {};
  for (const raw of urls) {
    const url = typeof raw === "string" ? raw : "";
    const ref = appStorageUrlInfo(url);
    if (!ref) { signed[url] = null; continue; }
    const ok = await authorizeMediaAccess(sc, user.id, ref.bucket, ref.path);
    signed[url] = ok ? (await resolveRedirect(sc, ref.bucket, ref.path))?.url ?? null : null;
  }

  res.json({ signed, ttlSeconds: SIGNED_TTL_SECONDS });
}));

export default router;
