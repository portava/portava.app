/**
 * sensingTransport — how a bucketed contribution reaches the server, and what
 * it deliberately does not carry.
 *
 * ── §3, THE PART THAT IS A CLIENT DECISION ───────────────────────────────────
 * "Separate contribution eligibility/authentication from signal ingest where
 * practical: eligibility proves an authorized participating device; ingest
 * receives an opaque short-lived credential."
 *
 * So this is two calls, not one:
 *
 *   ELIGIBILITY   POST {base}/api/v1/sensing/session
 *                 Authorization: Bearer <account token>
 *                 → { credential, rotationEpoch, expiresAt }
 *
 *   INGEST        POST {base}/api/v1/sensing/contributions
 *                 X-Sensing-Credential: <credential>
 *                 NO Authorization header. NO account id in the body.
 *
 * The account token proves the device may participate and is then put down. The
 * ingest request is the one that carries the sensor features, and it carries no
 * way to identify who sent it beyond a rotating credential the server itself
 * minted — which is the whole architecture of §3's right-hand branch.
 * `sensingTransport.test.ts` asserts the absence of that header, because an
 * `Authorization` added here "for convenience" would quietly rejoin the two
 * branches the diagram separates.
 *
 * ── PURE-ISH ON PURPOSE ──────────────────────────────────────────────────────
 * `fetch`, the clock and the eligibility-token getter are injected, so the
 * whole request shape is assertable in a unit test. `installSensingCapture.ts`
 * supplies the real ones.
 *
 * ── THE ROUTE IS NOT THIS LANE'S ─────────────────────────────────────────────
 * The server half (an ingest route that accepts these features without reading
 * `location_snapshots` by `actor_id`) is a separate change. Until it exists
 * every submission gets a 404 and `submit` reports `route_unavailable` — a
 * named refusal, never a silent success, per §20 "Ingest must fail explicitly …
 * never return a plausible empty world". The paths are overridable through
 * EXPO_PUBLIC_SENSING_SESSION_PATH / EXPO_PUBLIC_SENSING_INGEST_PATH so the
 * client can be pointed at the route the server lane actually lands.
 */
import type { SensingContributionPayload } from '../../lib/sensing/contributionPayload.ts';

export const DEFAULT_SENSING_SESSION_PATH = '/api/v1/sensing/session';
export const DEFAULT_SENSING_INGEST_PATH = '/api/v1/sensing/contributions';

/** The header the opaque credential travels in. Never `Authorization`. */
export const SENSING_CREDENTIAL_HEADER = 'X-Sensing-Credential';

export interface SensingCredential {
  credential: string;
  rotationEpoch: number;
  /** ISO. A credential is short-lived by design; past this it is re-fetched. */
  expiresAt: string;
}

export type SubmitOutcome =
  | { ok: true }
  | {
      ok: false;
      reason:
        | 'not_configured'
        | 'no_eligibility'
        | 'no_credential'
        | 'route_unavailable'
        | 'rejected'
        | 'network_error';
      status?: number;
    };

export interface SensingTransportDeps {
  baseUrl: string;
  /** The account token, used ONLY to prove eligibility. */
  getEligibilityToken: () => Promise<string | null>;
  fetchImpl: typeof fetch;
  now: () => number;
  sessionPath?: string;
  ingestPath?: string;
}

export interface SensingTransport {
  submit(payload: SensingContributionPayload): Promise<SubmitOutcome>;
  /** Drop the cached credential — e.g. on sign-out. */
  reset(): void;
}

function credentialIsFresh(c: SensingCredential | null, nowMs: number): boolean {
  if (!c || !c.credential) return false;
  const expires = Date.parse(c.expiresAt);
  return Number.isFinite(expires) && expires > nowMs;
}

export function createSensingTransport(deps: SensingTransportDeps): SensingTransport {
  const sessionPath = deps.sessionPath ?? DEFAULT_SENSING_SESSION_PATH;
  const ingestPath = deps.ingestPath ?? DEFAULT_SENSING_INGEST_PATH;
  let cached: SensingCredential | null = null;

  async function credential(): Promise<SensingCredential | null> {
    if (credentialIsFresh(cached, deps.now())) return cached;
    const token = await deps.getEligibilityToken();
    if (!token) return null;
    try {
      const res = await deps.fetchImpl(`${deps.baseUrl}${sessionPath}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // The ONLY request in this file that carries an identity.
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ purposeScopes: ['collect', 'retain', 'aggregate'] }),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as Partial<SensingCredential>;
      if (!body || typeof body.credential !== 'string') return null;
      cached = {
        credential: body.credential,
        rotationEpoch: typeof body.rotationEpoch === 'number' ? body.rotationEpoch : 0,
        expiresAt: typeof body.expiresAt === 'string' ? body.expiresAt : new Date(deps.now()).toISOString(),
      };
      return cached;
    } catch {
      return null;
    }
  }

  return {
    reset() {
      cached = null;
    },
    async submit(payload): Promise<SubmitOutcome> {
      if (!deps.baseUrl) return { ok: false, reason: 'not_configured' };
      const cred = await credential();
      if (!cred) return { ok: false, reason: 'no_credential' };
      try {
        const res = await deps.fetchImpl(`${deps.baseUrl}${ingestPath}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            [SENSING_CREDENTIAL_HEADER]: cred.credential,
          },
          body: JSON.stringify({ rotationEpoch: cred.rotationEpoch, ...payload }),
        });
        if (res.ok) return { ok: true };
        if (res.status === 404) {
          // The credential may be fine; the route is not there yet.
          return { ok: false, reason: 'route_unavailable', status: 404 };
        }
        if (res.status === 401 || res.status === 403) {
          cached = null;
          return { ok: false, reason: 'no_eligibility', status: res.status };
        }
        return { ok: false, reason: 'rejected', status: res.status };
      } catch {
        return { ok: false, reason: 'network_error' };
      }
    },
  };
}
