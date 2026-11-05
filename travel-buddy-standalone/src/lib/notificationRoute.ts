/**
 * notificationRoute — turns a notification's stored `actionUrl` into a path
 * this app has a screen for.
 *
 * Notification rows and push payloads carry the URL the server built when the
 * notification was created, and several server templates built paths no
 * screen answers, so a tap opened "This screen doesn't exist.":
 *
 *   /feed                       an @mention with no post id (old rows)
 *   /circle/<type>/<id>         every Find Your Circle notice, the safety
 *                               alert included; the screen is /circle-presence
 *   /airport/sessions/<id>      layover "head back" warnings and opportunity
 *                               notices; the dashboard is /layover/<id>
 *   /route-plan/<id>            the Compass "leave earlier" nudge; the screen
 *                               is /route/<id>
 *
 * The server templates for the first, second and fourth now build the right
 * path; this mapping keeps rows already stored (and layover notices, whose
 * stored URL also keys the server's supersede check) opening the right screen.
 * Anything else passes through unchanged.
 */

const CIRCLE = /^\/circle\/(trip|event)\/([^/?#]+)\/?$/;
const AIRPORT_SESSION = /^\/airport\/sessions\/([^/?#]+)\/?$/;
const ROUTE_PLAN = /^\/route-plan\/([^/?#]+)\/?$/;

export function normalizeNotificationRoute(actionUrl: string | null | undefined): string | null {
  if (typeof actionUrl !== 'string') return null;
  const url = actionUrl.trim();
  if (url.length === 0) return null;

  if (url === '/feed' || url === '/feed/') return '/(tabs)';

  const circle = CIRCLE.exec(url);
  if (circle) {
    return `/circle-presence?contextType=${encodeURIComponent(circle[1])}&contextId=${encodeURIComponent(decodeSafe(circle[2]))}`;
  }

  const session = AIRPORT_SESSION.exec(url);
  if (session) return `/layover/${session[1]}`;

  const plan = ROUTE_PLAN.exec(url);
  if (plan) return `/route/${plan[1]}`;

  return url;
}

function decodeSafe(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}
