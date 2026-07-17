/**
 * Standalone production server for Expo static builds.
 *
 * Serves the output of build.js (static-build/) with two special routes:
 * - GET / or /manifest with expo-platform header → platform manifest JSON
 * - GET / without expo-platform → landing page HTML
 * Everything else falls through to static file serving from ./static-build/.
 *
 * Zero external dependencies — uses only Node.js built-ins (http, fs, path).
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const STATIC_ROOT = path.resolve(__dirname, "..", "static-build");
const TEMPLATE_PATH = path.resolve(__dirname, "templates", "landing-page.html");
const basePath = (process.env.BASE_PATH || "/").replace(/\/+$/, "");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".map": "application/json",
};

function getAppName() {
  try {
    const appJsonPath = path.resolve(__dirname, "..", "app.json");
    const appJson = JSON.parse(fs.readFileSync(appJsonPath, "utf-8"));
    return appJson.expo?.name || "App Landing Page";
  } catch {
    return "App Landing Page";
  }
}

function serveManifest(platform, res) {
  const manifestPath = path.join(STATIC_ROOT, platform, "manifest.json");

  if (!fs.existsSync(manifestPath)) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(
      JSON.stringify({ error: `Manifest not found for platform: ${platform}` }),
    );
    return;
  }

  const manifest = fs.readFileSync(manifestPath, "utf-8");
  res.writeHead(200, {
    "content-type": "application/json",
    "expo-protocol-version": "1",
    "expo-sfv-version": "0",
  });
  res.end(manifest);
}

function serveLandingPage(req, res, landingPageTemplate, appName) {
  const forwardedProto = req.headers["x-forwarded-proto"];
  const protocol = forwardedProto || "https";
  const host = req.headers["x-forwarded-host"] || req.headers["host"];
  const baseUrl = `${protocol}://${host}`;
  const expsUrl = `${host}`;

  const html = landingPageTemplate
    .replace(/BASE_URL_PLACEHOLDER/g, baseUrl)
    .replace(/EXPS_URL_PLACEHOLDER/g, expsUrl)
    .replace(/APP_NAME_PLACEHOLDER/g, appName);

  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

// ── /u/<username> share page with server-rendered Open Graph tags ────────────

// Legacy accounts created before the 40-char display-name limit may still
// have longer names stored; cap them so they can't bloat share previews.
// Mirrors truncateDisplayName in src/utils/identity.ts.
const DISPLAY_NAME_MAX_LENGTH = 40;
function truncateDisplayName(name, max = DISPLAY_NAME_MAX_LENGTH) {
  const s = String(name);
  if (s.length <= max) return s;
  return s.slice(0, max).trimEnd() + "\u2026";
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Fetch the public profile card from the API server (same host, /api prefix).
 * Returns the parsed JSON or null on any failure. Never throws.
 */
async function fetchProfileCard(baseUrl, username) {
  const apiOrigin = (process.env.API_ORIGIN || baseUrl).replace(/\/$/, "");
  try {
    const resp = await fetch(
      `${apiOrigin}/api/users/${encodeURIComponent(username)}/profile`,
      { signal: AbortSignal.timeout(4000), headers: { accept: "application/json" } },
    );
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

const STAMP_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Fetch the public stamp preview card (label + artwork) for a
 * /u/<username>?stamp=<id> share link. The API enforces the same visibility
 * rules as the passport preview and 404s for missing/locked/private stamps,
 * so a null return simply means "fall back to the passport preview".
 * Never throws.
 */
async function fetchStampPreview(baseUrl, username, stampId) {
  if (!stampId || !STAMP_UUID_RE.test(stampId)) return null;
  const apiOrigin = (process.env.API_ORIGIN || baseUrl).replace(/\/$/, "");
  try {
    const resp = await fetch(
      `${apiOrigin}/api/users/${encodeURIComponent(username)}/stamps/${encodeURIComponent(stampId)}/preview`,
      { signal: AbortSignal.timeout(4000), headers: { accept: "application/json" } },
    );
    if (!resp.ok) return null;
    const card = await resp.json();
    if (!card || typeof card.label !== "string" || !card.label.trim()) return null;
    return card;
  } catch {
    return null;
  }
}

/**
 * Serve HTML for /u/<username> with Open Graph metadata so chat apps render a
 * rich preview. Private / blocked / unavailable / unknown profiles get generic
 * metadata (no name, no counts) so link previews never leak account state.
 * When a valid ?stamp=<id> is present and publicly visible, the preview shows
 * that stamp's label and artwork instead of the generic passport card.
 */
async function serveProfileSharePage(req, res, username, appName, stampId) {
  const forwardedProto = req.headers["x-forwarded-proto"];
  const protocol = forwardedProto || "https";
  const host = req.headers["x-forwarded-host"] || req.headers["host"];
  const baseUrl = `${protocol}://${host}`;
  const validStampId = stampId && STAMP_UUID_RE.test(stampId) ? stampId : null;
  const pageUrl =
    `${baseUrl}${basePath}/u/${encodeURIComponent(username)}` +
    (validStampId ? `?stamp=${encodeURIComponent(validStampId)}` : "");
  const apiOrigin = (process.env.API_ORIGIN || baseUrl).replace(/\/$/, "");

  const [card, stampCard] = await Promise.all([
    fetchProfileCard(baseUrl, username),
    validStampId ? fetchStampPreview(baseUrl, username, validStampId) : Promise.resolve(null),
  ]);
  const isPublic =
    card &&
    !card.unavailable &&
    !card.blocked &&
    !card.private &&
    card.visibility !== "private";

  let title = `${appName} Passport`;
  let description = "A traveler's passport of trips, stamps & postcards.";
  let imageUrl = `${apiOrigin}/api/users/${encodeURIComponent(username)}/og-image.png`;

  if (isPublic && stampCard) {
    // Stamp share variant — the API already enforced visibility for the
    // stamp itself; a missing/locked/private stamp yields stampCard=null and
    // falls into the regular passport branch below.
    const name = truncateDisplayName(card.displayName || (card.username ? `@${card.username}` : username));
    const label = String(stampCard.label).slice(0, 80);
    title = `"${label}" Stamp · ${appName}`;
    const place = stampCard.city || stampCard.country || null;
    description = `${name} earned the "${label}" passport stamp${place ? ` in ${place}` : ""} on ${appName}.`;
    imageUrl = `${apiOrigin}/api/users/${encodeURIComponent(username)}/og-image.png?stamp=${encodeURIComponent(validStampId)}`;
  } else if (isPublic) {
    const name = truncateDisplayName(card.displayName || (card.username ? `@${card.username}` : username));
    title = `${name} · ${appName} Passport`;
    const trips = Number(card.tripCount) || 0;
    const stamps = Number(card.stampCount) || 0;
    const stats = `${trips} ${trips === 1 ? "trip" : "trips"} · ${stamps} ${stamps === 1 ? "stamp" : "stamps"}`;
    description = card.bio ? `${stats} — ${String(card.bio).slice(0, 140)}` : `${stats} on ${appName}.`;
  } else {
    // Generic image endpoint enforces the same visibility rules server-side,
    // but point at a username-less generic render to avoid cache confusion.
    imageUrl = `${apiOrigin}/api/users/_/og-image.png`;
  }

  const deepLink =
    `travelbuddy://passport/@${encodeURIComponent(username)}` +
    (validStampId ? `?stamp=${encodeURIComponent(validStampId)}` : "");
  const safeTitle = escapeHtml(title);
  const safeDesc = escapeHtml(description);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${safeTitle}</title>
<meta name="description" content="${safeDesc}"/>
<meta property="og:type" content="profile"/>
<meta property="og:site_name" content="${escapeHtml(appName)}"/>
<meta property="og:title" content="${safeTitle}"/>
<meta property="og:description" content="${safeDesc}"/>
<meta property="og:url" content="${escapeHtml(pageUrl)}"/>
<meta property="og:image" content="${escapeHtml(imageUrl)}"/>
<meta property="og:image:width" content="1200"/>
<meta property="og:image:height" content="630"/>
<meta name="twitter:card" content="summary_large_image"/>
<meta name="twitter:title" content="${safeTitle}"/>
<meta name="twitter:description" content="${safeDesc}"/>
<meta name="twitter:image" content="${escapeHtml(imageUrl)}"/>
<style>
  body{margin:0;font-family:Georgia,serif;background:#0E1B31;color:#F5EFE0;display:flex;min-height:100vh;align-items:center;justify-content:center}
  .card{max-width:420px;margin:24px;padding:40px 32px;border:2px solid #C9A227;background:#152642;text-align:center}
  .kicker{letter-spacing:6px;font-size:12px;color:#C9A227;margin-bottom:6px}
  h1{font-size:26px;margin:10px 0 6px}
  p{opacity:.8;font-size:15px;line-height:1.5}
  a.btn{display:inline-block;margin-top:18px;padding:12px 28px;background:#C9A227;color:#152642;text-decoration:none;font-weight:bold}
</style>
</head>
<body>
<div class="card">
  <div class="kicker">TRAVEL BUDDY · PASSPORT</div>
  <h1>${safeTitle}</h1>
  <p>${safeDesc}</p>
  <a class="btn" href="${escapeHtml(deepLink)}">Open in ${escapeHtml(appName)}</a>
</div>
</body>
</html>`;

  // Personalized pages must not linger in CDN/crawler caches: when a profile
  // flips to private, the old name/stats/avatar preview should stop showing
  // quickly. Generic (private/unavailable) pages carry no personal data and
  // can stay cacheable.
  const cacheControl = isPublic
    ? "no-store, no-cache, must-revalidate"
    : "public, max-age=300";
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": cacheControl,
  });
  res.end(html);
}

function serveStaticFile(urlPath, res) {
  const safePath = path.normalize(urlPath).replace(/^(\.\.(\/|\\|$))+/, "");
  const filePath = path.join(STATIC_ROOT, safePath);

  if (!filePath.startsWith(STATIC_ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404);
    res.end("Not Found");
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";
  const content = fs.readFileSync(filePath);
  res.writeHead(200, { "content-type": contentType });
  res.end(content);
}

function createRequestHandler(landingPageTemplate, appName) {
  return (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  let pathname = url.pathname;

  if (basePath && pathname.startsWith(basePath)) {
    pathname = pathname.slice(basePath.length) || "/";
  }

  if (pathname === "/" || pathname === "/manifest") {
    const platform = req.headers["expo-platform"];
    if (platform === "ios" || platform === "android") {
      return serveManifest(platform, res);
    }

    if (pathname === "/") {
      return serveLandingPage(req, res, landingPageTemplate, appName);
    }
  }

  let decodedPathname = pathname;
  try {
    decodedPathname = decodeURIComponent(pathname);
  } catch {
    // Malformed percent-encoding — fall through with the raw path (static
    // serving will 404); never let a crafted URL throw in the handler.
  }
  const shareMatch = /^\/u\/(@?[A-Za-z0-9_]{1,64})\/?$/.exec(decodedPathname);
  if (shareMatch && (req.method === "GET" || req.method === "HEAD")) {
    const username = shareMatch[1].replace(/^@/, "").toLowerCase();
    const stampId = url.searchParams.get("stamp");
    serveProfileSharePage(req, res, username, appName, stampId).catch(() => {
      res.writeHead(500);
      res.end("Internal Server Error");
    });
    return;
  }

  serveStaticFile(pathname, res);
  };
}

module.exports = {
  fetchProfileCard,
  serveProfileSharePage,
  createRequestHandler,
  escapeHtml,
};

if (require.main === module) {
  const landingPageTemplate = fs.readFileSync(TEMPLATE_PATH, "utf-8");
  const appName = getAppName();
  const server = http.createServer(createRequestHandler(landingPageTemplate, appName));

  const port = parseInt(process.env.PORT || "20682", 10);
  server.listen(port, "0.0.0.0", () => {
    console.log(`Serving static Expo build on port ${port}`);
  });
}
