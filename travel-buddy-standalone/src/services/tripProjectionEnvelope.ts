/**
 * Trips §19.1 — the projection envelope, as the CLIENT reads it.
 *
 *   Every projection includes generatedAt, sourceTripVersion,
 *   projectionSchemaVersion, and freshness status. Consumers reject or
 *   visibly degrade on stale/incompatible critical projections.
 *
 * The server's copy is artifacts/api-server/src/services/trips/
 * TripProjectionEnvelope.ts; the four field names and the schema version are
 * the same on purpose, and the refusal reasons are Appendix B's. The client
 * has no canonical trip version to hand, so §22.4's version-ahead check is
 * the server's alone; what the client can and must do is refuse a schema it
 * does not read and a projection that is stale, and say which.
 */

export const TRIP_PROJECTION_SCHEMA_VERSION = 1 as const;

export type TripProjectionFreshness = 'live' | 'cached' | 'stale' | 'unattributable';

export interface TripProjectionEnvelope {
  projectionSchemaVersion: number;
  generatedAt: string;
  /** null = unattributable: do not cache, compare, or conclude "nothing changed". */
  sourceTripVersion: number | null;
  freshness: TripProjectionFreshness;
}

export type TripProjectionRefusal = 'TRIP_PROJECTION_SCHEMA_MISMATCH' | 'TRIP_PROJECTION_STALE';

export type AcceptProjectionDecision =
  | { accepted: true; envelope: TripProjectionEnvelope; lagSeconds: number }
  | { accepted: false; reason: TripProjectionRefusal; message: string };

/**
 * May this client use this body as a projection? Schema first (nothing after
 * it can be trusted to be there), then staleness. A body that is not an
 * object, lacks the envelope, or whose instant is not one is a schema
 * mismatch: it is not this schema.
 */
export function acceptProjection(
  body: unknown,
  opts: { acceptedSchemaVersion?: number; maxAgeSeconds?: number; now?: number } = {},
): AcceptProjectionDecision {
  const accepted = opts.acceptedSchemaVersion ?? TRIP_PROJECTION_SCHEMA_VERSION;
  const now = opts.now ?? Date.now();
  const b = body as Partial<TripProjectionEnvelope> | null;
  if (!b || typeof b !== 'object' || typeof b.projectionSchemaVersion !== 'number' || b.projectionSchemaVersion !== accepted) {
    return {
      accepted: false, reason: 'TRIP_PROJECTION_SCHEMA_MISMATCH',
      message: `projectionSchemaVersion ${String(b?.projectionSchemaVersion)} is not the accepted ${accepted}`,
    };
  }
  const generated = typeof b.generatedAt === 'string' ? Date.parse(b.generatedAt) : Number.NaN;
  if (!Number.isFinite(generated)) {
    return { accepted: false, reason: 'TRIP_PROJECTION_SCHEMA_MISMATCH', message: 'generatedAt is not an instant' };
  }
  const lagSeconds = Math.max(0, (now - generated) / 1000);
  if (b.freshness === 'stale') {
    return { accepted: false, reason: 'TRIP_PROJECTION_STALE', message: 'the projection declares itself stale' };
  }
  if (opts.maxAgeSeconds !== undefined && lagSeconds > opts.maxAgeSeconds) {
    return {
      accepted: false, reason: 'TRIP_PROJECTION_STALE',
      message: `generated ${lagSeconds.toFixed(1)}s ago; this consumer accepts at most ${opts.maxAgeSeconds}s`,
    };
  }
  return {
    accepted: true, lagSeconds,
    envelope: {
      projectionSchemaVersion: b.projectionSchemaVersion,
      generatedAt: b.generatedAt as string,
      sourceTripVersion: typeof b.sourceTripVersion === 'number' ? b.sourceTripVersion : null,
      freshness: b.freshness === 'live' || b.freshness === 'cached' || b.freshness === 'unattributable' ? b.freshness : 'unattributable',
    },
  };
}
