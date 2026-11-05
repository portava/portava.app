import { freshToken, isCurrentSessionToken } from './apiToken.ts';

export const DISCOVERY_TRAIL_OPEN_FLAG = 'discovery_trail_open_telemetry_enabled';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One actual screen visit, not a detail fetch or prefetch. Retries keep this ID. */
export interface TrailOpenEmission { trail_id: string; client_event_id: string }

/** The server's disabled-by-default collection gate remains authoritative. */
export async function sendTrailOpen(
  emission: TrailOpenEmission,
  opts: { ownerId: string; isAllowed: () => boolean; signal: AbortSignal },
): Promise<'sent' | 'skipped' | 'refused' | 'failed'> {
  const allowed = () => !opts.signal.aborted && opts.isAllowed();
  if (!allowed() || !opts.ownerId || !UUID.test(emission.trail_id) || !UUID.test(emission.client_event_id)) return 'skipped';
  const base = process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
  if (!base) return 'skipped';
  let token: string | null;
  try { token = await freshToken(); } catch { return 'skipped'; }
  if (!token) return 'skipped';
  const body = JSON.stringify(emission);
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!allowed() || !(await isCurrentSessionToken(opts.ownerId, token)) || !allowed()) return 'skipped';
    const controller = new AbortController();
    const cancel = () => controller.abort();
    opts.signal.addEventListener('abort', cancel, { once: true });
    const timeout = setTimeout(cancel, 10_000);
    try {
      const response = await fetch(`${base}/api/rank-events/trail-open`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body, signal: controller.signal,
      });
      if (response.ok) {
        const result = await response.json();
        if (result?.ok === true && (result.recorded === 0 || result.recorded === 1)) return 'sent';
      } else if (response.status < 500) return 'refused';
    } catch {
      // One retry with the same event ID handles a lost acknowledgement.
    } finally {
      clearTimeout(timeout);
      opts.signal.removeEventListener('abort', cancel);
    }
  }
  return 'failed';
}
