/**
 * wallAnalyticsTransport — the real analytics transport for the Wall's §32 sink.
 *
 * wallAnalytics.ts fans every Wall event to a pluggable sink; until a transport
 * is injected the default sink only dev-logs, so in production the Wall's
 * client-only events (feed open, mode select, engagement, Live For You
 * shown/opened, Context Thread shown/acted/ignored, handoff, caught-up,
 * not-interested, consented real-world outcome) reach nothing.
 *
 * This builds the SAME authenticated, fire-and-forget POST the rest of the app
 * already uses for analytics — bearer token from `freshToken`, base URL from
 * `EXPO_PUBLIC_API_BASE_URL`, the server stamping the actor from the token
 * (identical to hooks/useMediaAnalytics.ts, hooks/useRankOutcome.ts and
 * features/map/telemetry `createFetchTelemetryTransport`). It is wired once at
 * app boot via `setWallAnalyticsSink`.
 *
 * PRIVACY (§32): every WallAnalyticsEvent carries ONLY ids, enums and counts by
 * construction — there is no free-text field on the union — so no raw post text
 * or typed content can leave through this seam.
 *
 * FAIL-SOFT (§32/§40): analytics must never break the feed. A missing base URL,
 * a signed-out viewer (no token), or any transport error is swallowed silently;
 * the event is simply not delivered.
 *
 * Pure of React and of the supabase chain — it imports only the sink TYPE and
 * takes `getToken`/`fetchImpl` by injection — so it is unit-testable.
 */
import type { WallAnalyticsEvent, WallAnalyticsSink } from './wallAnalytics.ts';

export interface WallAnalyticsTransportOptions {
  /** e.g. process.env.EXPO_PUBLIC_API_BASE_URL */
  baseUrl: string;
  /** e.g. `freshToken` from services/apiToken.ts */
  getToken: () => Promise<string | null>;
  /** Injected so this module imports nothing at runtime. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Defaults to '/api/wall/telemetry'. */
  path?: string;
}

/**
 * Build the Wall analytics sink: an authenticated, fire-and-forget POST of each
 * event to the wall telemetry ingest. Never throws, never blocks the caller.
 */
export function createWallAnalyticsTransport(
  opts: WallAnalyticsTransportOptions,
): WallAnalyticsSink {
  const doFetch = opts.fetchImpl ?? ((globalThis as { fetch?: typeof fetch }).fetch as typeof fetch);
  const path = opts.path ?? '/api/wall/telemetry';
  return (event: WallAnalyticsEvent) => {
    if (!opts.baseUrl || typeof doFetch !== 'function') return;
    void (async () => {
      try {
        const token = await opts.getToken();
        if (!token) return; // signed out — nothing to attribute; drop silently
        await doFetch(`${opts.baseUrl}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          // Batch-of-one envelope, matching the app's other analytics ingests so
          // the shape is stable if this later queues/batches.
          body: JSON.stringify({ events: [event] }),
        });
      } catch {
        // Fire-and-forget — an analytics failure must never surface to the user.
      }
    })();
  };
}
