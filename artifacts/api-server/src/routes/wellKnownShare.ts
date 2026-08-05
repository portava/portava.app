/**
 * wellKnownShare — deep-link association files + public share landing pages,
 * served directly from the deployed API host.
 *
 * Ported from travel-buddy-standalone/server/serve.js (lines ~60-360) so the
 * production deployment — which runs ONLY the api-server — still satisfies
 * Apple Universal Links / Android App Links verification and renders rich
 * link previews for shared passports.
 *
 * Routes (mounted at the app ROOT, before the /api router — public surface,
 * no auth, no cookies):
 *   GET /.well-known/apple-app-site-association
 *   GET /.well-known/assetlinks.json
 *   GET /u/:username
 *   GET /passport/:username
 *
 * Association files
 * ─────────────────
 * Apple and Google verify deep links by fetching these two files over HTTPS
 * from the web origin baked into app.json. The identifiers live in the EAS
 * credential store, not the repo, so they come from deployment env vars:
 *
 *   APPLE_APP_ID_PREFIX   Apple Developer Team ID (e.g. "A1B2C3D4E5"),
 *                         prefixed onto the bundle id to form the AASA appID.
 *   ANDROID_CERT_SHA256   Signing-cert SHA-256 fingerprint(s), colon-separated
 *                         hex; comma-separate multiple certs.
 *
 * When a value is missing we return 503 rather than a syntactically valid
 * file with placeholder IDs: a wrong appID/fingerprint makes Apple and Google
 * cache a FAILED verification, which is far harder to recover from than a
 * retry.
 *
 * Share pages
 * ───────────
 * Minimal server-rendered OG landing pages. Public profiles get real
 * title/description; private / blocked / unavailable profiles get a generic
 * card (no name, no bio) so link previews never leak account state; unknown
 * handles 404. og:image points at the existing passport OG image endpoint
 * (GET /api/users/:username/og-image.png in routes/passport.ts), which
 * enforces the same visibility rules server-side. All interpolated values are
 * HTML-escaped.
 */

import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { getServiceClient } from "../lib/supabase.js";
import { resolveProfileVisibility } from "../lib/profileVisibility.js";
import { nameVisibleFor } from "../lib/publicIdentity.js";

const router = Router();

// ── App identity (keep in sync with travel-buddy-standalone/app.json) ────────
// serve.js reads these out of app.json at runtime; the api-server deployment
// does not ship that file, so the identifiers are pinned here.
const APP_NAME = "Portava";
const IOS_BUNDLE_ID = "com.passporttravelbuddy.app";
const ANDROID_PACKAGE = "com.passporttravelbuddy.app";
const APP_SCHEME = "travelbuddy";
/** Deep-link path prefixes — keep in sync with app.json android.intentFilters. */
const APP_LINK_PATHS = ["/passport", "/passport/*", "/u", "/u/*"];

/** Shared-cache lifetime for share pages (~5 min). */
const SHARE_PAGE_CACHE = "public, max-age=300";

// ── Helpers ──────────────────────────────────────────────────────────────────

function escapeHtml(s: unknown): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Mirror of truncateDisplayName in the mobile client (40-char cap). */
function truncateDisplayName(name: string, max = 40): string {
  const s = String(name);
  if (s.length <= max) return s;
  return s.slice(0, max).trimEnd() + "…";
}

function requestOrigin(req: any): string {
  return `${req.protocol}://${req.get("host")}`;
}

// ── /.well-known/apple-app-site-association ──────────────────────────────────

router.get("/.well-known/apple-app-site-association", (_req, res) => {
  const teamId = (process.env.APPLE_APP_ID_PREFIX || "").trim();

  if (!teamId) {
    res
      .status(503)
      .type("application/json")
      .json({
        error: "not_configured",
        message: "APPLE_APP_ID_PREFIX (Apple Team ID) is not set on this deployment.",
      });
    return;
  }

  const doc = {
    applinks: {
      // `details` supersedes the legacy `apps` key, which must stay empty.
      apps: [],
      details: [{ appID: `${teamId}.${IOS_BUNDLE_ID}`, paths: APP_LINK_PATHS }],
    },
  };

  // Apple requires application/json even though the path has no extension.
  // Short cache: the file is tiny and a stale copy blocks link verification
  // after a credential rotation.
  res
    .status(200)
    .set({ "Content-Type": "application/json", "Cache-Control": "public, max-age=3600" })
    .send(JSON.stringify(doc));
});

// ── /.well-known/assetlinks.json ─────────────────────────────────────────────

router.get("/.well-known/assetlinks.json", (_req, res) => {
  const fingerprints = (process.env.ANDROID_CERT_SHA256 || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (fingerprints.length === 0) {
    res
      .status(503)
      .type("application/json")
      .json({
        error: "not_configured",
        message: "ANDROID_CERT_SHA256 (signing certificate fingerprint) is not set on this deployment.",
      });
    return;
  }

  const doc = [
    {
      relation: ["delegate_permission/common.handle_all_urls"],
      target: {
        namespace: "android_app",
        package_name: ANDROID_PACKAGE,
        sha256_cert_fingerprints: fingerprints,
      },
    },
  ];

  res
    .status(200)
    .set({ "Content-Type": "application/json", "Cache-Control": "public, max-age=3600" })
    .send(JSON.stringify(doc));
});

// ── Share landing pages ──────────────────────────────────────────────────────

interface SharePageData {
  title: string;
  description: string;
  pageUrl: string;
  imageUrl: string;
  deepLink: string;
  /** Generic (private/unavailable) pages are noindex'd. */
  noindex: boolean;
}

function buildSharePageHtml(d: SharePageData): string {
  const safeTitle = escapeHtml(d.title);
  const safeDesc = escapeHtml(d.description);
  const safeUrl = escapeHtml(d.pageUrl);
  const safeImage = escapeHtml(d.imageUrl);
  const safeDeepLink = escapeHtml(d.deepLink);
  const robots = d.noindex ? '<meta name="robots" content="noindex, nofollow"/>' : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${safeTitle}</title>
<meta name="description" content="${safeDesc}"/>
${robots}
<meta property="og:type" content="profile"/>
<meta property="og:site_name" content="${escapeHtml(APP_NAME)}"/>
<meta property="og:title" content="${safeTitle}"/>
<meta property="og:description" content="${safeDesc}"/>
<meta property="og:url" content="${safeUrl}"/>
<meta property="og:image" content="${safeImage}"/>
<meta property="og:image:width" content="1200"/>
<meta property="og:image:height" content="630"/>
<meta name="twitter:card" content="summary_large_image"/>
<meta name="twitter:title" content="${safeTitle}"/>
<meta name="twitter:description" content="${safeDesc}"/>
<meta name="twitter:image" content="${safeImage}"/>
<style>
  body{margin:0;font-family:Georgia,serif;background:#0E1B31;color:#F5EFE0;display:flex;min-height:100vh;align-items:center;justify-content:center}
  .card{max-width:420px;margin:24px;padding:40px 32px;border:2px solid #C9A227;background:#152642;text-align:center}
  .kicker{letter-spacing:6px;font-size:12px;color:#C9A227;margin-bottom:6px}
  h1{font-size:26px;margin:10px 0 6px}
  p{opacity:.8;font-size:15px;line-height:1.5}
  a.btn{display:inline-block;margin-top:18px;padding:12px 28px;background:#C9A227;color:#152642;text-decoration:none;font-weight:bold}
  .store{font-size:13px;opacity:.6;margin-top:14px}
</style>
</head>
<body>
<div class="card">
  <div class="kicker">${escapeHtml(APP_NAME.toUpperCase())} · PASSPORT</div>
  <h1>${safeTitle}</h1>
  <p>${safeDesc}</p>
  <a class="btn" href="${safeDeepLink}">Open in ${escapeHtml(APP_NAME)}</a>
  <p class="store">Don&#39;t have the app yet? Get ${escapeHtml(APP_NAME)} from the App Store or Google Play, then open this link again.</p>
</div>
</body>
</html>`;
}

function send404Page(res: any): void {
  res
    .status(404)
    .set({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" })
    .send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="robots" content="noindex, nofollow"/>
<title>Not found · ${escapeHtml(APP_NAME)}</title>
<style>
  body{margin:0;font-family:Georgia,serif;background:#0E1B31;color:#F5EFE0;display:flex;min-height:100vh;align-items:center;justify-content:center}
  .card{max-width:420px;margin:24px;padding:40px 32px;border:2px solid #C9A227;background:#152642;text-align:center}
  h1{font-size:26px;margin:10px 0 6px}
  p{opacity:.8;font-size:15px;line-height:1.5}
</style>
</head>
<body>
<div class="card">
  <h1>Traveler not found</h1>
  <p>This passport doesn&#39;t exist, or the link is out of date.</p>
</div>
</body>
</html>`);
}

const shareHandler = asyncHandler(async (req: any, res: any) => {
  // Sanitise the handle the same way routes/passport.ts does.
  const username = String(req.params.username ?? "")
    .replace(/^@/, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_]/g, "");
  if (!username) {
    send404Page(res);
    return;
  }

  const sc = getServiceClient();
  if (!sc) {
    res.status(503).type("text").send("Service unavailable");
    return;
  }

  const origin = requestOrigin(req);
  const pageUrl = `${origin}/u/${encodeURIComponent(username)}`;
  const deepLink = `${APP_SCHEME}://passport/@${encodeURIComponent(username)}`;

  const { data: profile } = await sc
    .from("profiles")
    .select("id, username, display_name, name, bio, avatar_url, passport_visibility, is_private, account_status")
    .eq("handle", username)
    .maybeSingle();

  if (!profile) {
    send404Page(res);
    return;
  }

  let visibility = "unavailable";
  try {
    // Share pages are rendered for anonymous crawlers — no viewer.
    const result = await resolveProfileVisibility(sc, null, (profile as any).id, profile as any);
    visibility = result.visibility;
  } catch {
    visibility = "unavailable"; // fail closed → generic card
  }

  const isPublic = visibility === "full" || visibility === "followers_only";

  let title = `${APP_NAME} Passport`;
  let description = "A traveler's passport of trips, stamps & postcards.";
  // The OG image endpoint enforces the same visibility rules server-side; for
  // non-public profiles point at a username-less generic render to avoid
  // cache confusion (same trick as serve.js).
  let imageUrl = `${origin}/api/users/_/og-image.png`;

  if (isPublic) {
    // Universal display-name rule: the real name only appears when the
    // profile owner opted in; everyone else is presented as @handle.
    const allowName = await nameVisibleFor(sc, (profile as any).id);
    const handle = ((profile as any).username as string | null) ?? username;
    const realName = ((profile as any).display_name as string | null) ?? ((profile as any).name as string | null);
    const name = truncateDisplayName(allowName && realName ? realName : `@${handle}`);
    title = `${name} · ${APP_NAME} Passport`;
    const bio = (((profile as any).bio as string | null) ?? "").trim();
    description = bio ? bio.slice(0, 200) : `Check out @${handle}'s travel passport on ${APP_NAME}.`;
    imageUrl = `${origin}/api/users/${encodeURIComponent(username)}/og-image.png`;
  }

  res
    .status(200)
    .set({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": SHARE_PAGE_CACHE })
    .send(
      buildSharePageHtml({
        title,
        description,
        pageUrl,
        imageUrl,
        deepLink,
        noindex: !isPublic,
      }),
    );
});

router.get("/u/:username", shareHandler);
router.get("/passport/:username", shareHandler);

export default router;
