/**
 * Telegraph §4.1 / §4.3 — the AvailabilitySignal contract on Nearby (census-telegraph T22, T23, T27;
 * migration 3652; behind `availability_signal_contract_enabled`, seeded FALSE).
 *
 *   "AVAILABLE ≠ ONLINE ≠ NEARBY ≠ SHARING LOCATION. Never collapse these states into one permission."
 *   "AvailabilitySignal = { … audiencePolicyId, proximityVisibility: 'HIDDEN' | 'NEARBY' |
 *    'DISTANCE_BUCKET' | 'ETA_IF_MUTUAL', geographyScope? }"
 *   "Exact ETA/location requires stronger mutual coordination permissions."
 *
 * Applied by GET /nearby/reachable to the list the query layer already projected (and BEFORE the
 * T26 observation budget records anything), so it can only take away — it never adds a person, a
 * field or a finer value. For each listed person:
 *
 *   1. NEARBY is its own permission (T22): no `nearby_consents` row with `opted_in` → not shown.
 *   2. The signal's AUDIENCE (T23 audiencePolicyId; proposed ruling P-T10): a window without a policy
 *      has the default audience — mutual follows and crew (shared trip or circle) only; 'crew_only' is
 *      narrower; 'public' exists only as a policy the owner created. A viewer the audience does not
 *      admit gets neither the availability nor the proximity that rides with it.
 *   3. The PROXIMITY RUNG (T23 proximityVisibility; default HIDDEN in 3652): HIDDEN → none; NEARBY →
 *      only that the person is near (same_area / nearby → `nearby`, anything farther → none);
 *      DISTANCE_BUCKET → the bucket; ETA_IF_MUTUAL → the bucket. With no published signal for this
 *      viewer there is no rung, so no proximity.
 *   4. The GEOGRAPHY CAP (T23 geographyScope): proximity is never finer than the scope the signal
 *      speaks for (city → at most same_city, region → at most same_region).
 *   5. ETA (T27): the travel band — the only ETA-shaped value on the projection — is shown only on an
 *      ETA_IF_MUTUAL signal AND where both people hold a live grant for each other.
 *
 * A person left with neither availability nor proximity is not shown (the projection's own rule). Where
 * a person has several published windows the most restrictive of each field wins. Every read fails
 * CLOSED: any error answers `{ ok: false }` and the route refuses (503) — a contract that cannot be read
 * is not a contract that allows.
 */
import { travelBandForBucket, type ProximityBucket } from "../../lib/proximityBuckets.js";
import { readFlagState } from "../../lib/featureFlags.js";
import type { ReachableLoadOk, ReachableLoadResult } from "./reachablePeopleQuery.js";
import {
  nearbyRank,
  orderReachablePeople,
  type ReachablePersonProjection,
  type RelationshipTier,
} from "./reachablePeople.js";

export const SIGNAL_CONTRACT_FLAG = "availability_signal_contract_enabled";

export const AUDIENCES = ["crew_only", "mutual_follow_and_crew", "public"] as const; // narrowest → widest
export type Audience = (typeof AUDIENCES)[number];
/** Proposed ruling P-T10: a signal with no policy has this audience. Nothing wider without an explicit choice. */
export const DEFAULT_AUDIENCE: Audience = "mutual_follow_and_crew";

export const PROXIMITY_RUNGS = ["HIDDEN", "NEARBY", "DISTANCE_BUCKET", "ETA_IF_MUTUAL"] as const; // narrowest → widest
export type ProximityRung = (typeof PROXIMITY_RUNGS)[number];

export const GEOGRAPHY_SCOPES = ["neighborhood", "city", "region"] as const; // finest → coarsest
export type GeographyScope = (typeof GEOGRAPHY_SCOPES)[number];

const ADMITTED_TIERS: ReadonlyMap<Audience, ReadonlySet<RelationshipTier>> = new Map([
  ["crew_only", new Set<RelationshipTier>(["crew", "shared_context"])],
  ["mutual_follow_and_crew", new Set<RelationshipTier>(["mutual_follow", "friend", "shared_context", "crew"])],
  ["public", new Set<RelationshipTier>(["none", "follow", "mutual_follow", "friend", "shared_context", "crew"])],
]);

/** Does `audience` admit a viewer whose relationship to the owner is `tier`? */
export function audienceAdmits(audience: Audience, tier: RelationshipTier): boolean {
  return ADMITTED_TIERS.get(audience)?.has(tier) === true;
}

function narrowest<T extends string>(order: readonly T[], values: readonly T[]): T {
  let best = order.length - 1;
  for (const v of values) {
    const i = order.indexOf(v);
    best = Math.min(best, i < 0 ? 0 : i); // an unknown value is read as the narrowest
  }
  return order[best]!;
}

/** The signal's effective contract for one owner: the most restrictive field across their published windows. */
export interface EffectiveSignal {
  readonly audience: Audience;
  readonly rung: ProximityRung;
  /** The COARSEST scope any window names, or null. */
  readonly scope: GeographyScope | null;
}

export function effectiveSignal(
  windows: ReadonlyArray<{ audience: Audience; rung: ProximityRung; scope: GeographyScope | null }>,
): EffectiveSignal | null {
  if (windows.length === 0) return null;
  const scopes = windows.map((w) => w.scope).filter((s): s is GeographyScope => s !== null);
  let scope: GeographyScope | null = null;
  for (const s of scopes) {
    if (scope === null || GEOGRAPHY_SCOPES.indexOf(s) > GEOGRAPHY_SCOPES.indexOf(scope)) scope = s;
  }
  return {
    audience: narrowest(AUDIENCES, windows.map((w) => w.audience)),
    rung: narrowest(PROXIMITY_RUNGS, windows.map((w) => w.rung)),
    scope,
  };
}

const NEAR: ReadonlySet<ProximityBucket> = new Set(["same_area", "nearby"]);
const FINER_THAN_REGION: ReadonlySet<ProximityBucket> = new Set(["same_area", "nearby", "same_city"]);

/** Steps 3–4: the bucket a viewer may be shown under a rung and a scope ("unknown" = none). */
export function bucketUnderSignal(bucket: ProximityBucket, rung: ProximityRung, scope: GeographyScope | null): ProximityBucket {
  if (bucket === "unknown") return "unknown";
  let b: ProximityBucket;
  switch (rung) {
    case "HIDDEN":
      return "unknown";
    case "NEARBY":
      b = NEAR.has(bucket) ? "nearby" : "unknown";
      break;
    case "DISTANCE_BUCKET":
    case "ETA_IF_MUTUAL":
      b = bucket;
      break;
    default:
      return "unknown";
  }
  if (b === "unknown") return b;
  if (scope === "city" && NEAR.has(b)) return "same_city";
  if (scope === "region" && FINER_THAN_REGION.has(b)) return "same_region";
  return b;
}

export interface ContractInputs {
  readonly optedIn: ReadonlySet<string>;
  readonly signals: ReadonlyMap<string, EffectiveSignal>;
  /** Person ids with a LIVE grant in BOTH directions with the viewer. */
  readonly mutualEta: ReadonlySet<string>;
}

/**
 * Apply the contract to one projected person. Pure. Null = not shown.
 */
export function applyContractToPerson(p: ReachablePersonProjection, c: ContractInputs): ReachablePersonProjection | null {
  if (!c.optedIn.has(p.personId)) return null; // step 1
  const signal = p.privacy.availabilityPublished ? (c.signals.get(p.personId) ?? null) : null;
  const admitted = signal !== null && audienceAdmits(signal.audience, p.relationship.tier); // step 2

  const availabilityPublished = p.privacy.availabilityPublished && admitted;
  const bucket = admitted ? bucketUnderSignal(p.proximity.bucket, signal!.rung, signal!.scope) : "unknown"; // steps 3-4
  const proximityPublished = bucket !== "unknown";
  if (!availabilityPublished && !proximityPublished) return null;

  const eta = admitted && proximityPublished && signal!.rung === "ETA_IF_MUTUAL" && c.mutualEta.has(p.personId); // step 5
  const travel = eta ? travelBandForBucket(bucket) : "unknown";
  const freshness = proximityPublished ? p.proximity.freshness : "stale";

  const availability = availabilityPublished
    ? p.availability
    : { state: "unknown" as const, intents: [] as string[], overlap: "unknown" as const, publishedUntil: null };

  // nearbyRank is a sum of independent terms; the intent term is the only one the projection does not
  // carry, so it is recovered as the remainder and dropped when availability is withheld.
  const base = {
    relationship: p.relationship.tier,
    sharedContextCount: p.sharedContext.trips + p.sharedContext.circles,
    safety: p.safety.state,
  };
  const before = nearbyRank({
    ...base, availability: p.availability.state, intentOverlap: 0, overlap: p.availability.overlap,
    travel: p.proximity.travel, proximity: p.proximity.bucket, freshness: p.proximity.freshness,
  });
  const intentTerm = p.rank - before;
  const rank = nearbyRank({
    ...base, availability: availability.state, intentOverlap: 0, overlap: availability.overlap,
    travel, proximity: bucket, freshness,
  }) + (availabilityPublished ? intentTerm : 0);

  return {
    ...p,
    availability,
    proximity: { bucket, precision: "bucket", travel, freshness },
    privacy: { availabilityPublished, proximityPublished, preciseShared: false },
    rank,
  };
}

// ── The reads ─────────────────────────────────────────────────────────────────

export type ContractResult =
  | { readonly ok: true; readonly people: ReachablePersonProjection[]; readonly dropped: number }
  | { readonly ok: false; readonly stage: string; readonly message: string };

function asAudience(v: unknown): Audience | null {
  return typeof v === "string" && (AUDIENCES as readonly string[]).includes(v) ? (v as Audience) : null;
}
function asRung(v: unknown): ProximityRung {
  return typeof v === "string" && (PROXIMITY_RUNGS as readonly string[]).includes(v) ? (v as ProximityRung) : "HIDDEN";
}
function asScope(v: unknown): GeographyScope | null {
  return typeof v === "string" && (GEOGRAPHY_SCOPES as readonly string[]).includes(v) ? (v as GeographyScope) : null;
}

/**
 * Read what the contract needs for `people` and apply it. Every read's error refuses the whole answer.
 */
export async function applyAvailabilitySignalContract(
  db: any,
  viewerId: string,
  people: readonly ReachablePersonProjection[],
  nowMs: number,
): Promise<ContractResult> {
  const ids = [...new Set(people.map((p) => p.personId))];
  if (ids.length === 0) return { ok: true, people: [], dropped: 0 };
  const nowIso = new Date(nowMs).toISOString();

  const consents = await db.from("nearby_consents").select("user_id, opted_in").in("user_id", ids);
  if (consents.error) return { ok: false, stage: "nearby_consents", message: String(consents.error.message ?? consents.error) };
  const optedIn = new Set<string>();
  for (const r of (consents.data ?? []) as any[]) if (r?.opted_in === true && typeof r.user_id === "string") optedIn.add(r.user_id);

  const windows = await db
    .from("availability_windows")
    .select("user_id, audience_policy_id, proximity_visibility, geography_scope, visibility, start_at, end_at, expires_at")
    .in("user_id", ids)
    .neq("visibility", "private")
    .lte("start_at", nowIso)
    .gt("end_at", nowIso);
  if (windows.error) return { ok: false, stage: "availability_windows", message: String(windows.error.message ?? windows.error) };
  const live = ((windows.data ?? []) as any[]).filter(
    (w) => typeof w?.user_id === "string" && (w.expires_at == null || Date.parse(String(w.expires_at)) > nowMs),
  );

  const policyIds = [...new Set(live.map((w) => w.audience_policy_id).filter((x): x is string => typeof x === "string"))];
  const policies = new Map<string, { owner: string; audience: Audience | null }>();
  if (policyIds.length > 0) {
    const pol = await db.from("availability_audience_policies").select("id, owner_id, audience").in("id", policyIds);
    if (pol.error) return { ok: false, stage: "availability_audience_policies", message: String(pol.error.message ?? pol.error) };
    for (const r of (pol.data ?? []) as any[]) policies.set(String(r.id), { owner: String(r.owner_id), audience: asAudience(r.audience) });
  }

  const perOwner = new Map<string, Array<{ audience: Audience; rung: ProximityRung; scope: GeographyScope | null }>>();
  for (const w of live) {
    let audience: Audience = DEFAULT_AUDIENCE;
    if (typeof w.audience_policy_id === "string") {
      const pol = policies.get(w.audience_policy_id);
      // A policy that cannot be found, belongs to someone else or names an unknown audience is read as
      // the narrowest audience — never as the default, and never as public.
      audience = pol && pol.owner === w.user_id && pol.audience ? pol.audience : "crew_only";
    }
    const list = perOwner.get(w.user_id) ?? [];
    list.push({ audience, rung: asRung(w.proximity_visibility), scope: asScope(w.geography_scope) });
    perOwner.set(w.user_id, list);
  }
  const signals = new Map<string, EffectiveSignal>();
  for (const [owner, list] of perOwner) {
    const s = effectiveSignal(list);
    if (s) signals.set(owner, s);
  }

  const [given, received] = await Promise.all([
    db.from("eta_coordination_grants").select("grantor_id, grantee_id, expires_at").eq("grantor_id", viewerId).in("grantee_id", ids).gt("expires_at", nowIso),
    db.from("eta_coordination_grants").select("grantor_id, grantee_id, expires_at").eq("grantee_id", viewerId).in("grantor_id", ids).gt("expires_at", nowIso),
  ]);
  if (given.error) return { ok: false, stage: "eta_coordination_grants", message: String(given.error.message ?? given.error) };
  if (received.error) return { ok: false, stage: "eta_coordination_grants", message: String(received.error.message ?? received.error) };
  const liveGrant = (r: any) => typeof r?.expires_at === "string" && Date.parse(r.expires_at) > nowMs;
  const iGranted = new Set(((given.data ?? []) as any[]).filter(liveGrant).map((r) => String(r.grantee_id)));
  const mutualEta = new Set(((received.data ?? []) as any[]).filter(liveGrant).map((r) => String(r.grantor_id)).filter((id) => iGranted.has(id)));

  const out: ReachablePersonProjection[] = [];
  let dropped = 0;
  for (const p of people) {
    const shown = applyContractToPerson(p, { optedIn, signals, mutualEta });
    if (shown) out.push(shown);
    else dropped++;
  }
  return { ok: true, people: orderReachablePeople(viewerId, out), dropped };
}

// ── The route's door ──────────────────────────────────────────────────────────

/**
 * GET /nearby/reachable wraps the loader's answer in this. Flag OFF (the seed) → the answer as it was.
 * Flag ON — or UNREADABLE, because the contract only ever narrows — → the contract applied; a person
 * it does not show is counted with the loader's own refusals (`signal_contract`), so the viewer's one
 * undifferentiated `notShown` count includes them and says nothing about why. A contract read that
 * fails refuses the answer through the route's existing refusal branch.
 */
export async function withSignalContract(
  db: any,
  viewerId: string,
  nowMs: number,
  loaded: ReachableLoadResult,
): Promise<ReachableLoadOk | { readonly ok: false; readonly stage: string; readonly message: string }> {
  if (!loaded.ok) return loaded;
  if ((await readFlagState(db, "availability_signal_contract_enabled")) === "off") return loaded; // SIGNAL_CONTRACT_FLAG, as a literal for check:flag-polarity
  const c = await applyAvailabilitySignalContract(db, viewerId, loaded.people, nowMs);
  if (!c.ok) return c;
  const refusals: Record<string, number> = { ...loaded.telemetry.refusals };
  if (c.dropped > 0) refusals.signal_contract = (refusals.signal_contract ?? 0) + c.dropped;
  return {
    ...loaded,
    people: c.people,
    telemetry: { ...loaded.telemetry, published: c.people.length, refusals },
    // T26 (§63): the held-back skeletons have not been through the contract (opt-in, audience, rung), so under
    // the contract none is served — fail closed; the proximity-only transition gap stays stated there.
    heldBack: undefined,
  };
}
