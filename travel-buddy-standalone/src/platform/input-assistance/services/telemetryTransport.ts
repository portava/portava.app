/**
 * §44 — the telemetry transport's IMPURE half: a real `fetch`, a real bearer
 * token, a real timer.
 *
 * Pairs with `telemetryBatcher.ts`, which holds all the logic and is node-
 * testable. Everything that cannot be tested without a device or a Supabase
 * session lives here and nowhere else.
 *
 * THIS MODULE IMPORTS THE SUPABASE-BACKED TOKEN HELPER, so — exactly as
 * `inputAssistance.ts`'s header says of itself — it must NOT be imported by a
 * node:test file. Hooks and app bootstrap import it; tests do not.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * IT IS NOT INSTALLED BY DEFAULT, AND THAT IS DELIBERATE
 * ══════════════════════════════════════════════════════════════════════════════
 * `inputTelemetry.ts`'s default sink remains `() => {}`. Nothing in this package
 * calls `setTelemetrySink`, and this module does not install itself on import.
 *
 * The reason is that starting background network traffic from a device is an
 * APPLICATION decision, not a platform-library one, and the file where an app
 * makes it — `travel-buddy-standalone/app/_layout.tsx` — is not this layer's.
 * A library that quietly begins posting because it was imported is the kind of
 * thing nobody can find later.
 *
 * So the whole of the §44 funnel now needs exactly one line at bootstrap:
 *
 *     import { setTelemetrySink } from '@/platform/input-assistance';
 *     import { installInputTelemetryTransport } from '@/platform/input-assistance';
 *     setTelemetrySink(installInputTelemetryTransport().sink);
 *
 * Until that line exists, census G263 is still correctly BUILT-BUT-WRONG: the
 * events are produced and dropped. What changed is that there is now something
 * to attach, and a place for it to go.
 */
import { freshToken as freshApiToken } from '../../../services/apiToken.ts';
import {
  createTelemetryBatcher,
  newTelemetrySessionId,
  type TelemetryBatch,
  type TelemetryBatcher,
} from './telemetryBatcher.ts';

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

/**
 * Build the real transport. Returns the batcher so the caller decides when to
 * attach it and can flush it on background/foreground transitions.
 *
 * FAILS QUIET, BY CONSTRUCTION. With no API base or no session there is no
 * token to send, so the post resolves `{ ok: false }` and the batcher drops and
 * counts it — the same path a 503 takes. Telemetry never surfaces to the user
 * and never retries; `telemetryBatcher.ts`'s header argues why.
 */
export function installInputTelemetryTransport(
  sessionId: string = newTelemetrySessionId(),
): TelemetryBatcher {
  const post = async (batch: TelemetryBatch) => {
    const base = apiBase();
    if (!base) return { ok: false };
    let token: string | null = null;
    try {
      token = await freshApiToken();
    } catch {
      token = null;
    }
    if (!token) return { ok: false };
    try {
      const res = await fetch(`${base}/input-assistance/telemetry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(batch),
      });
      // 503 is the route's HONEST answer to a failed write (it refuses to call
      // a broken ingest an empty one). The client's answer to that is to drop,
      // not to retry into an incident.
      return { ok: res.ok, retryable: res.status === 503 };
    } catch {
      return { ok: false, retryable: true };
    }
  };

  return createTelemetryBatcher({ post, sessionId });
}
