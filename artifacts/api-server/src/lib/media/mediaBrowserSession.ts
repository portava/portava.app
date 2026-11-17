import type { Request, Response } from "express";
import { requireUser, sendError } from "../http.js";
import { mediaAccountAllowsAccess } from "../mediaAccess.js";

const COOKIE_NAME = "portava_media_session";
const COOKIE_PATH = "/api/media/file";
export const MEDIA_BROWSER_SESSION_SECONDS = 90;

/** Fetch Metadata is browser-set and cannot be supplied by page JavaScript.
 * Cross-origin embeds and sibling origins never get cookie authentication.
 * Native consumers send the existing Authorization header instead. */
function sameOriginBrowser(req: Request): boolean {
  return req.headers["sec-fetch-site"] === "same-origin";
}

function cookieOptions(req: Request) {
  let localHttp = false;
  try {
    const origin = new URL(String(req.headers.origin ?? ""));
    localHttp = origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
  } catch { /* Production defaults to Secure, including requests without Origin. */ }
  return { path: COOKIE_PATH, httpOnly: true, secure: !localHttp, sameSite: "strict" as const };
}

function cookieToken(req: Request): string | null {
  if (!sameOriginBrowser(req)) return null;
  const fields = (req.headers.cookie ?? "").split(";").map(value => value.trim()).filter(value => value.startsWith(`${COOKIE_NAME}=`));
  if (fields.length !== 1) return null;
  try {
    const token = decodeURIComponent(fields[0]!.slice(COOKIE_NAME.length + 1));
    return token.length <= 8192 && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token) ? token : null;
  } catch { return null; }
}

/** The media-only cookie adapter for the existing authentication owner.
 * No other endpoint gains cookie auth. Never override a supplied header, even
 * an invalid one, and never mutate the original request/logging context. */
export async function requireMediaViewer(req: Request, res: Response) {
  let authRequest = req;
  if (req.headers.authorization === undefined) {
    const token = cookieToken(req);
    if (token) {
      authRequest = Object.create(req) as Request;
      Object.defineProperty(authRequest, "headers", { value: { ...req.headers, authorization: `Bearer ${token}` } });
    }
  }
  const auth = await requireUser(authRequest, res);
  if (!auth) return null;
  // A URL held by a prior account cannot be loaded under a new account's
  // cookie or native headers. Viewer identity is not a credential.
  if (req.query.viewer !== auth.user.id) {
    sendError(res, "forbidden", "Media belongs to another viewing session");
    return null;
  }
  return auth;
}

/** POST handler for the media-only browser session. Uses bearer auth to set a
 * short cookie; it never accepts cookie auth to renew itself. No database or
 * alternate session store is created. Actual byte requests still recheck both
 * existing Auth and current media account/source authority. */
export async function establishMediaBrowserSession(req: Request, res: Response): Promise<void> {
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  if (!sameOriginBrowser(req)) { sendError(res, "forbidden", "Same-origin media session required"); return; }
  const auth = await requireUser(req, res);
  if (!auth) return;
  if (!await mediaAccountAllowsAccess(auth.client, auth.user.id)) { sendError(res, "forbidden", "Media access unavailable"); return; }
  const token = req.headers.authorization!.slice(7).trim();
  let expiresAt = 0;
  try {
    // requireUser has verified this token. An absent or malformed expiry is
    // refused rather than minting browser authority beyond its source token.
    const claims: unknown = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"));
    if (claims && typeof claims === "object" && "exp" in claims && typeof claims.exp === "number" && Number.isSafeInteger(claims.exp)) expiresAt = claims.exp;
  } catch { /* Refuse below. */ }
  const ttlSeconds = Math.min(MEDIA_BROWSER_SESSION_SECONDS, expiresAt - Math.floor(Date.now() / 1000));
  if (ttlSeconds <= 0) { sendError(res, "unauthenticated", "Media session expired"); return; }
  res.cookie(COOKIE_NAME, token, { ...cookieOptions(req), maxAge: ttlSeconds * 1000 });
  res.json({ viewerId: auth.user.id, ttlSeconds });
}

/** DELETE never needs a valid token: sign-out must clear an expired session. */
export function clearMediaBrowserSession(req: Request, res: Response): void {
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  if (!sameOriginBrowser(req)) { sendError(res, "forbidden", "Same-origin media session required"); return; }
  res.clearCookie(COOKIE_NAME, cookieOptions(req));
  res.status(204).end();
}
