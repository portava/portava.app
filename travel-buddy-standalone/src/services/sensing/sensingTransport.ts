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
 * ── THE WIRE IS A CONTRACT, NOT A SPREAD ─────────────────────────────────────
 * The server's ingest route (`artifacts/api-server/src/routes/sensingIngest.ts`)
 * validates a `.strict()` camelCase body that REQUIRES a per-epoch
 * `commitment`. This transport used to spread the reduced payload straight
 * into the body, which that schema refused on every field — census-sensing
 * §26 measured it. The body is now built by `toWireContribution`, whose
 * output is pinned to `docs/contracts/sensing-contribution-wire-v1.json`, the
 * same fixture the server's own test accepts; and the commitment comes from
 * the injected `commitmentFor`, which the installer backs with the device
 * secret (`commitment.ts`). No commitment, no request: a body the server
 * would refuse is not sent, and the refusal is named (`no_commitment`).
 * A missing route still reports `route_unavailable` — a named refusal, never
 * a silent success, per §20 "Ingest must fail explicitly … never return a
 * plausible empty world". The paths stay overridable through
 * EXPO_PUBLIC_SENSING_SESSION_PATH / EXPO_PUBLIC_SENSING_INGEST_PATH.
 */
import type { SensingContributionPayload } from '../../lib/sensing/contributionPayload.ts';
import { toWireContribution } from '../../lib/sensing/wireContribution.ts';

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
        | 'no_commitment'
        | 'invalid_payload'
        | 'route_unavailable'
        | 'rejected'
        | 'network_error';
      status?: number;
    };

export interface SensingTransportDeps {
  baseUrl: string;
  /** The account token, used ONLY to prove eligibility. */
  getEligibilityToken: () => Promise<string | null>;
  /**
   * The device's hash commitment for a rotation epoch — `deviceCommitment` in
   * lib/sensing/commitment.ts over a secret that never leaves the handset.
   * Null means the device cannot commit (no secure randomness), and then
   * nothing is sent.
   */
  commitmentFor: (rotationEpoch: number) => Promise<string | null>;
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
      const commitment = await deps.commitmentFor(cred.rotationEpoch);
      if (!commitment) return { ok: false, reason: 'no_commitment' };
      let body: string;
      try {
        body = JSON.stringify(toWireContribution(payload, { commitment, rotationEpoch: cred.rotationEpoch }));
      } catch {
        return { ok: false, reason: 'invalid_payload' };
      }
      try {
        const res = await deps.fetchImpl(`${deps.baseUrl}${ingestPath}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            [SENSING_CREDENTIAL_HEADER]: cred.credential,
          },
          body,
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
