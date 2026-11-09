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
import { runSensingRequest } from './sensingRequest.ts';
import type { SensingContributionPayload } from '../../lib/sensing/contributionPayload.ts';
import { toWireContribution } from '../../lib/sensing/wireContribution.ts';

export const DEFAULT_SENSING_SESSION_PATH = '/api/v1/sensing/session';
export const DEFAULT_SENSING_INGEST_PATH = '/api/v1/sensing/contributions';

/** The header the opaque credential travels in. Never `Authorization`. */
export const SENSING_CREDENTIAL_HEADER = 'X-Sensing-Credential';

export interface SensingCredential {
  credential: string;
  rotationEpoch: number;
  rotationPeriodSeconds: number;
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
        | 'cancelled'
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
  requestTimeoutMs?: number;
  surfaceAllowed?: () => boolean;
}

export interface SensingTransport {
  submit(payload: SensingContributionPayload): Promise<SubmitOutcome>;
  /** Invalidate pending dispatch and drop the cached credential. */
  reset(options?: { keepCredential?: boolean }): void;
  /** Current opaque session token, only for explicit device-contribution erasure. */
  revocationCredential(): string | null;
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
  let generation = 0;
  let cachedSurface = false;
  const controllers = new Set<AbortController>();
  let pendingCredential: { generation: number; promise: Promise<SensingCredential | null> } | null = null;

  async function request<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    controllers.add(controller);
    try { return await runSensingRequest(operation, controller, deps.requestTimeoutMs ?? 15_000); }
    finally { controllers.delete(controller); }
  }

  async function loadCredential(expected: number): Promise<SensingCredential | null> {
    const surface = deps.surfaceAllowed?.() === true;
    if (cachedSurface === surface && credentialIsFresh(cached, deps.now())) return cached;
    try {
      const body = await request(async (signal) => {
        const token = await deps.getEligibilityToken();
        if (signal.aborted || expected !== generation || !token) return null;
        const res = await deps.fetchImpl(`${deps.baseUrl}${sessionPath}`, {
          method: 'POST', signal,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          // The issuer intersects current consent for each scope with its active policy.
          body: JSON.stringify(surface ? {} : { purposeScopes: ['collect', 'retain', 'aggregate'] }),
        });
        if (!res.ok || signal.aborted) return null;
        return await res.json() as Partial<SensingCredential>;
      });
      if (expected !== generation || !body || typeof body.credential !== 'string' || !body.credential.trim() || !Number.isSafeInteger(body.rotationEpoch) || Number(body.rotationEpoch) < 0 || typeof body.expiresAt !== 'string' || !Number.isFinite(Date.parse(body.expiresAt)) || Date.parse(body.expiresAt) <= deps.now()) return null;
      // Servers predating this response field use the hourly v1 rotation.
      const period = body.rotationPeriodSeconds === undefined ? 3600 : body.rotationPeriodSeconds;
      if (!Number.isSafeInteger(period) || period < 1) return null;
      cachedSurface = surface;
      cached = {
        credential: body.credential,
        rotationEpoch: body.rotationEpoch!,
        rotationPeriodSeconds: period,
        expiresAt: body.expiresAt,
      };
      return cached;
    } catch {
      return null;
    }
  }

  function credential(expected: number): Promise<SensingCredential | null> {
    if (cachedSurface === (deps.surfaceAllowed?.() === true) && credentialIsFresh(cached, deps.now())) return Promise.resolve(cached);
    if (pendingCredential?.generation === expected) return pendingCredential.promise;
    const promise = loadCredential(expected).finally(() => { if (pendingCredential?.promise === promise) pendingCredential = null; });
    pendingCredential = { generation: expected, promise };
    return promise;
  }

  return {
    revocationCredential: () => credentialIsFresh(cached, deps.now()) ? cached!.credential : null,
    reset(options) {
      generation += 1;
      if (!options?.keepCredential) cached = null;
      pendingCredential = null;
      for (const controller of controllers) controller.abort();
      controllers.clear();
    },
    async submit(payload): Promise<SubmitOutcome> {
      if (!deps.baseUrl) return { ok: false, reason: 'not_configured' };
      const expected = generation;
      const cred = await credential(expected);
      if (expected !== generation) return { ok: false, reason: 'cancelled' };
      if (!cred) return { ok: false, reason: 'no_credential' };
      const rotationEpoch = Math.floor(payload.observed_at_ms / (cred.rotationPeriodSeconds * 1000));
      if (!Number.isSafeInteger(rotationEpoch) || rotationEpoch < 0) return { ok: false, reason: 'invalid_payload' };
      let commitment: string | null;
      try { commitment = await request(() => deps.commitmentFor(rotationEpoch)); } catch { commitment = null; }
      if (expected !== generation) return { ok: false, reason: 'cancelled' };
      if (!credentialIsFresh(cred, deps.now())) return { ok: false, reason: 'no_credential' };
      if (!commitment) return { ok: false, reason: 'no_commitment' };
      let body: string;
      try {
        body = JSON.stringify(toWireContribution(payload, { commitment, rotationEpoch }));
      } catch {
        return { ok: false, reason: 'invalid_payload' };
      }
      try {
        if (expected !== generation) return { ok: false, reason: 'cancelled' };
        const res = await request(signal => deps.fetchImpl(`${deps.baseUrl}${ingestPath}`, {
          signal,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            [SENSING_CREDENTIAL_HEADER]: cred.credential,
          },
          body,
        }));
        if (expected !== generation) return { ok: false, reason: 'cancelled' };
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
        return { ok: false, reason: expected !== generation ? 'cancelled' : 'network_error' };
      }
    },
  };
}
