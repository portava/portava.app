import type { MessagingOwnerRequest } from '../../../services/messagingOwnerRequest.ts';
import type { OwnedApiContext } from '../../../services/ownedApiRequest.ts';
import type { WallAnalyticsEvent, WallAnalyticsSink } from './wallAnalytics.ts';

export interface WallAnalyticsTransportOptions {
  baseUrl: string;
  captureOwner: () => MessagingOwnerRequest | null;
  send: (path: string, options: OwnedApiContext & { method: string; body: object }) => Promise<unknown>;
  outcomeConsentAt: (owner: MessagingOwnerRequest) => string | null;
  path?: string;
}
export type WallAnalyticsTransport = WallAnalyticsSink & { invalidate(): void; dispose(): void };

/** Bounded fire-and-forget delivery, tied to the initiating account and grant.
 * The owned API transport checks that same identity after token refresh and
 * every await. Invalidation aborts network work without retrying old events. */
export function createWallAnalyticsTransport(opts: WallAnalyticsTransportOptions): WallAnalyticsTransport {
  let revision = 0;
  let disposed = false;
  const pending = new Set<AbortController>();
  const path = opts.path ?? '/api/wall/telemetry';
  const invalidate = () => { revision++; for (const controller of pending) controller.abort(); pending.clear(); };
  const sink: WallAnalyticsSink = (event: WallAnalyticsEvent) => {
    if (disposed || !opts.baseUrl || pending.size >= 32) return;
    const owner = opts.captureOwner();
    if (!owner?.isCurrent()) return;
    const consentAt = event.type === 'wall_real_world_outcome' ? opts.outcomeConsentAt(owner) : null;
    if (event.type === 'wall_real_world_outcome' && !consentAt) return;
    const started = revision;
    const controller = new AbortController();
    const current = () => !disposed && revision === started && !controller.signal.aborted && owner.isCurrent()
      && (event.type !== 'wall_real_world_outcome' || opts.outcomeConsentAt(owner) === consentAt);
    const body = { events: [{ ...event }], ...(consentAt ? { meta: { outcomeConsentAt: consentAt } } : {}) };
    pending.add(controller);
    void Promise.resolve().then(async () => {
      if (current()) await opts.send(path, { owner, signal: controller.signal, isCurrent: current, method: 'POST', body });
    }).catch(() => { /* Analytics cannot break navigation. */ }).finally(() => pending.delete(controller));
  };
  return Object.assign(sink, { invalidate, dispose() { disposed = true; invalidate(); } });
}
