/**
 * Trips spec §18.1 — the signed / versioned offline bundle (census-trips
 * TR334; §18.1's "stale / live-unavailable must be visible", TR342, on the
 * wire).
 *
 * "The mobile client stores a signed/versioned offline bundle containing
 * next commitments, active plan, selected route, meeting points, critical
 * addresses, cached map tiles where permitted, and the most recent
 * certified context."
 *
 * WHAT THIS FILE IS. The bundle's shape, its canonical bytes, the HMAC over
 * them, the verification, and the staleness rule. The route assembles the
 * contents from the tables it can read and signs with the server's secret;
 * the client stores what it is given and hands it back on reconnect, when
 * the same rule says whether it is still believable.
 *
 *   versioned   `bundleSchemaVersion` (this file's) and `sourceTripVersion`
 *               (the aggregate version the contents were read at, §18.4).
 *   signed      HMAC-SHA256 over the canonical JSON of everything but the
 *               signature, keyed by TRIP_OFFLINE_BUNDLE_SECRET (SESSION_SECRET
 *               as the fallback the tree's other HMACs use). A bundle a
 *               client edited — a moved commitment, a changed address — fails
 *               verification and is treated as no bundle at all.
 *   stale       past `expiresAt`, or `sourceTripVersion` behind the trip's
 *               current version: TRIP_OFFLINE_BUNDLE_STALE, stated with which.
 *               Stale is not invalid — a stale bundle is still the last
 *               certified context — but a renderer must say so (§18.1).
 *
 * What it does NOT carry, stated: the selected route (§19 route chains are
 * route_plans, a separate system — TR437), cached map tiles (a client
 * permission the server does not hold), and stored meeting points (§14.3
 * computes them on demand). Each is an empty, named field rather than an
 * omission a renderer would read as "none".
 *
 * PURE.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const OFFLINE_BUNDLE_SCHEMA_VERSION = 1;
export const OFFLINE_BUNDLE_TTL_MS = 24 * 60 * 60 * 1000;
const SIGNING_CONTEXT = "trip-offline-bundle/v1";

export interface BundleCommitment {
  id: string; type: string; title: string | null;
  startsAt: string | null; requiredArrivalAt: string | null; placeName: string | null;
}
export interface BundlePlan {
  id: string; title: string; status: string; dayDate: string | null;
  startsAt: string | null; endsAt: string | null; locationName: string | null;
}
export interface BundleAddress {
  /** "reservation" | "commitment" | "plan" */
  kind: string; id: string; title: string; address: string; at: string | null;
}

export interface TripOfflineBundle {
  bundleSchemaVersion: number;
  tripId: string;
  /** §18.4: the aggregate version the contents were read at. */
  sourceTripVersion: number;
  generatedAt: string;
  expiresAt: string;
  contents: {
    nextCommitments: BundleCommitment[];
    /** The in-progress plan, else the next confirmed one, else null. */
    activePlan: BundlePlan | null;
    plans: BundlePlan[];
    selectedRoute: null;
    meetingPoints: never[];
    criticalAddresses: BundleAddress[];
    certifiedContext: { sourceTripVersion: number; certifiedAt: string; reading: string };
  };
  /** What the bundle does not carry, named. */
  notCarried: { selectedRoute: string; meetingPoints: string; mapTiles: string };
}

export interface SignedTripOfflineBundle {
  bundle: TripOfflineBundle;
  /** hex HMAC-SHA256 over canonicalBundleJson(bundle). */
  signature: string;
  algorithm: "hmac-sha256";
}

/** Sorted-key JSON, so the same bundle always has the same bytes. */
export function canonicalBundleJson(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      return Object.fromEntries(Object.keys(o).sort().map((k) => [k, walk(o[k])]));
    }
    return v;
  };
  return JSON.stringify(walk(value));
}

export function bundleSigningSecret(env: NodeJS.ProcessEnv = process.env): string | null {
  const s = env.TRIP_OFFLINE_BUNDLE_SECRET ?? env.SESSION_SECRET;
  return typeof s === "string" && s.length >= 16 ? s : null;
}

export function signOfflineBundle(bundle: TripOfflineBundle, secret: string): SignedTripOfflineBundle {
  const signature = createHmac("sha256", secret).update(`${SIGNING_CONTEXT}|${canonicalBundleJson(bundle)}`).digest("hex");
  return { bundle, signature, algorithm: "hmac-sha256" };
}

/** Constant-time; false for a malformed signature rather than a throw. */
export function verifyOfflineBundle(bundle: TripOfflineBundle, signature: unknown, secret: string): boolean {
  if (typeof signature !== "string" || !/^[0-9a-f]{64}$/.test(signature)) return false;
  const expected = signOfflineBundle(bundle, secret).signature;
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature, "hex"));
}

export interface BundleStaleness {
  stale: boolean;
  reasonCode: "TRIP_OFFLINE_BUNDLE_STALE" | null;
  /** "expired" | "version_behind" | null */
  because: "expired" | "version_behind" | null;
  detail: string;
}

export function bundleStaleness(
  bundle: Pick<TripOfflineBundle, "sourceTripVersion" | "generatedAt" | "expiresAt">,
  now: number,
  currentTripVersion: number | null,
): BundleStaleness {
  const expires = Date.parse(bundle.expiresAt);
  if (!Number.isFinite(expires) || now > expires) {
    return { stale: true, reasonCode: "TRIP_OFFLINE_BUNDLE_STALE", because: "expired", detail: `the bundle expired at ${bundle.expiresAt}; it is the last certified context, not the current one` };
  }
  if (currentTripVersion !== null && bundle.sourceTripVersion < currentTripVersion) {
    return { stale: true, reasonCode: "TRIP_OFFLINE_BUNDLE_STALE", because: "version_behind", detail: `the bundle was read at trip version ${bundle.sourceTripVersion} and the trip is at ${currentTripVersion}; something changed while the client was away` };
  }
  return { stale: false, reasonCode: null, because: null, detail: `the bundle is current: read at version ${bundle.sourceTripVersion}, valid until ${bundle.expiresAt}` };
}

export interface BundleInputs {
  tripId: string;
  sourceTripVersion: number;
  commitments: readonly BundleCommitment[];
  plans: readonly BundlePlan[];
  reservations: ReadonlyArray<{ id: string; title: string; locationName: string | null; startsAt: string | null }>;
}

export function buildOfflineBundle(input: BundleInputs, now: number, ttlMs: number = OFFLINE_BUNDLE_TTL_MS): TripOfflineBundle {
  const nowIso = new Date(now).toISOString();
  const ms = (s: string | null) => (s ? Date.parse(s) : NaN);
  const upcoming = (s: string | null) => Number.isFinite(ms(s)) && ms(s) >= now;
  const nextCommitments = [...input.commitments]
    .filter((c) => upcoming(c.requiredArrivalAt ?? c.startsAt))
    .sort((a, b) => ms(a.requiredArrivalAt ?? a.startsAt) - ms(b.requiredArrivalAt ?? b.startsAt))
    .slice(0, 10);
  const plans = [...input.plans].filter((p) => p.status !== "cancelled");
  const inProgress = plans.find((p) => p.status === "in_progress") ?? null;
  const nextConfirmed = plans
    .filter((p) => p.status === "confirmed" && upcoming(p.startsAt))
    .sort((a, b) => ms(a.startsAt) - ms(b.startsAt))[0] ?? null;
  const criticalAddresses: BundleAddress[] = [
    ...input.reservations.filter((r) => r.locationName).map((r) => ({ kind: "reservation", id: r.id, title: r.title, address: r.locationName as string, at: r.startsAt })),
    ...nextCommitments.filter((c) => c.placeName).map((c) => ({ kind: "commitment", id: c.id, title: c.title ?? c.type, address: c.placeName as string, at: c.requiredArrivalAt ?? c.startsAt })),
    ...plans.filter((p) => p.locationName && upcoming(p.startsAt)).map((p) => ({ kind: "plan", id: p.id, title: p.title, address: p.locationName as string, at: p.startsAt })),
  ];
  return {
    bundleSchemaVersion: OFFLINE_BUNDLE_SCHEMA_VERSION,
    tripId: input.tripId,
    sourceTripVersion: input.sourceTripVersion,
    generatedAt: nowIso,
    expiresAt: new Date(now + ttlMs).toISOString(),
    contents: {
      nextCommitments,
      activePlan: inProgress ?? nextConfirmed,
      plans,
      selectedRoute: null,
      meetingPoints: [],
      criticalAddresses,
      certifiedContext: { sourceTripVersion: input.sourceTripVersion, certifiedAt: nowIso, reading: `read at trip version ${input.sourceTripVersion} on ${nowIso}; stale after ${new Date(now + ttlMs).toISOString()} or once the trip moves past that version` },
    },
    notCarried: {
      selectedRoute: "route chains are route_plans, a separate system (TR437); not in the bundle",
      meetingPoints: "§14.3 computes meeting points on demand; none are stored",
      mapTiles: "a client permission the server does not hold",
    },
  };
}
