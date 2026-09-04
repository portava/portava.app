/**
 * §21 Intelligence-Gathering DOMAIN events (spec Table 29) — the emitters that
 * ride the two autonomous passes and file pipeline transitions onto the ONE
 * canonical spine (canonical_events, the 2130 ruling).
 *
 * THREE VERBS, TWO PASSES
 * =======================
 *   intel.observation.recorded  — an admissible observation entered the active
 *                                  pipeline (the anchor of a system promotion).
 *   intel.claim.promoted        — a candidate became an active anchor claim
 *                                  (promotion_source='system', migration 2174).
 *     ↑ both emitted by the PROMOTION pass (lib/intelPromotionScheduler).
 *   intel.state.changed         — a subject's live state changed semantic value
 *                                  or confidence band, or its snapshot went dark.
 *     ↑ emitted by the PROJECTION pass (lib/intelProjectionScheduler).
 *
 * IDEMPOTENCY. observation.recorded is unique per observation_id and
 * claim.promoted unique per claim_id, enforced by the two partial UNIQUE indexes
 * migration 2278 puts on canonical_events. Every emitter (a) pre-filters the
 * candidates against events that already exist, so a steady-state pass inserts
 * nothing, and (b) tolerates 23505 per row, so a concurrent pass never dupes and
 * never aborts a batch. intel.state.changed legitimately repeats per snapshot and
 * carries no unique index — the projection pass emits it only on a real diff.
 *
 * PRIVACY. These are SYSTEM transitions, not traveler interactions: actor_id is
 * null on every domain event, so the `authenticated_read_own_canonical_events`
 * policy (2120) never matches one and only service_role reads them. Identifying
 * ids ride inside the `intel` envelope, which the canonicalEvents sanitizer keeps
 * (allow-listed) but deep-strips of any raw-GPS key at every depth. No emitter
 * ever throws into the pass it rides — a failed insert is logged and dropped.
 */
import { logger } from "./logger.js";
import { projectEvent, type CanonicalEventInput } from "./canonicalEvents.js";

/** Bound each pass's candidate read (house pattern; prod volume is ~0 pre-launch). */
const MAX_PER_PASS = 2000;

// ── Row shapes read from the DB (only the columns each emitter needs) ────────
export interface PromotedClaimRow {
  id: string;
  subject_id: string;
  zone_id: string | null;
  claim_type: string;
  confidence: number | null;
  confidence_band: string | null;
  observed_at: string;
}
export interface AnchorObservationRow {
  id: string;
  subject_id: string;
  zone_id: string | null;
  claim_type: string;
  observed_at: string;
  source_class: string | null;
  presence_level: string | null;
  actor_id: string | null;
}
export interface SnapshotRow {
  id: string;
  subject_id: string;
  zone_id: string | null;
  claim_type: string;
  value: unknown;
  confidence: number | null;
  confidence_band: string | null;
  privacy_eligible: boolean;
  observed_at: string;
  expires_at: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Pure builders — one CanonicalEventInput per transition. actor_id is always
// null (a system/domain transition), so these rows are service-role-only.
// ═══════════════════════════════════════════════════════════════════════════
export function buildObservationRecordedEvent(obs: AnchorObservationRow, now: Date): CanonicalEventInput {
  return {
    verb: "intel.observation.recorded",
    actorId: null,
    subjectKind: "place",
    subjectId: obs.subject_id,
    occurredAt: now.toISOString(),
    payload: {
      intel: {
        observation_id: obs.id,
        subject_id: obs.subject_id,
        zone_id: obs.zone_id ?? null,
        claim_type: obs.claim_type,
        source_class: obs.source_class ?? null,
        presence_level: obs.presence_level ?? null,
        observed_at: obs.observed_at,
        // service-only (actor_id null ⇒ no authenticated read); attribution/
        // trust is actor-scoped, so a service consumer needs the contributor.
        actor_id: obs.actor_id ?? null,
      },
    },
  };
}

export function buildClaimPromotedEvent(claim: PromotedClaimRow, now: Date): CanonicalEventInput {
  return {
    verb: "intel.claim.promoted",
    actorId: null,
    subjectKind: "place",
    subjectId: claim.subject_id,
    occurredAt: now.toISOString(),
    confidence: typeof claim.confidence === "number" ? claim.confidence : null,
    payload: {
      intel: {
        claim_id: claim.id,
        subject_id: claim.subject_id,
        zone_id: claim.zone_id ?? null,
        claim_type: claim.claim_type,
        confidence_band: claim.confidence_band ?? null,
        observed_at: claim.observed_at,
        promotion_source: "system",
      },
    },
  };
}

export type StateTransition = "appeared" | "changed" | "expired";

export function buildStateChangedEvent(
  snap: Pick<SnapshotRow, "id" | "subject_id" | "zone_id" | "claim_type" | "confidence" | "confidence_band" | "privacy_eligible"> & { value?: unknown },
  transition: StateTransition,
  now: Date,
): CanonicalEventInput {
  return {
    verb: "intel.state.changed",
    actorId: null,
    subjectKind: "place",
    subjectId: snap.subject_id,
    occurredAt: now.toISOString(),
    confidence: typeof snap.confidence === "number" ? snap.confidence : null,
    privacyEligible: snap.privacy_eligible,
    payload: {
      intel: {
        snapshot_id: snap.id,
        subject_id: snap.subject_id,
        zone_id: snap.zone_id ?? null,
        claim_type: snap.claim_type,
        confidence_band: snap.confidence_band ?? null,
        privacy_eligible: snap.privacy_eligible,
        transition,
        // The normalized registry value (Compass/place-card consumers). GPS is
        // deep-stripped by the sanitizer; on an "expired" transition it is absent.
        ...(transition === "expired" ? {} : { value: snap.value ?? null }),
      },
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Pure diff — the spec §11 trigger: "publish state-changed only when semantic
// state or confidence band changes". A snapshot with no prior "appeared"; a
// changed value/band/eligibility "changed"; an unchanged one emits nothing.
// ═══════════════════════════════════════════════════════════════════════════
export interface SnapshotSemState {
  value: unknown;
  confidence_band: string | null;
  privacy_eligible: boolean;
}
function stableValue(v: unknown): string {
  try { return JSON.stringify(v ?? null); } catch { return "__unserializable__"; }
}
export function snapshotTransition(prior: SnapshotSemState | undefined, next: SnapshotSemState): StateTransition | null {
  if (!prior) return "appeared";
  if (
    stableValue(prior.value) !== stableValue(next.value)
    || (prior.confidence_band ?? null) !== (next.confidence_band ?? null)
    || Boolean(prior.privacy_eligible) !== Boolean(next.privacy_eligible)
  ) {
    return "changed";
  }
  return null;
}

/** (subject_id, zone_id||'', claim_type) — the snapshot's natural key. */
export function snapshotKey(r: { subject_id: string; zone_id: string | null; claim_type: string }): string {
  return JSON.stringify([r.subject_id, r.zone_id ?? "", r.claim_type]);
}

// ═══════════════════════════════════════════════════════════════════════════
// DB helpers — all fully fail-closed: never throw into the pass they ride.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Insert each projected row, tolerating a unique-violation (23505 ⇒ "already
 * recorded"). Per-row so one conflict never aborts the rest. Returns how many
 * rows were newly written.
 */
async function insertEventsTolerant(sc: any, inputs: readonly CanonicalEventInput[]): Promise<number> {
  let written = 0;
  for (const input of inputs) {
    const row = projectEvent(input);
    if (!row) continue; // a non-canonical verb is dropped before insert
    try {
      const { error } = await sc.from("canonical_events").insert(row);
      if (error) {
        if (error.code === "23505") continue; // already recorded (idempotent)
        logger.warn({ err: error, verb: input.verb }, "intelDomainEvents: insert rejected");
        continue;
      }
      written += 1;
    } catch (err) {
      logger.warn({ err, verb: input.verb }, "intelDomainEvents: insert threw");
    }
  }
  return written;
}

/** Read the already-emitted values of one deduped verb for a set of ids. */
async function existingIntelIds(sc: any, verb: string, jsonKey: "observation_id" | "claim_id", ids: string[]): Promise<Set<string>> {
  const seen = new Set<string>();
  if (ids.length === 0) return seen;
  try {
    const { data, error } = await sc
      .from("canonical_events")
      .select("payload")
      .eq("verb", verb)
      .in(`payload->intel->>${jsonKey}`, ids);
    if (error) {
      // Fail-closed against DUPLICATES: if we cannot tell what already exists,
      // do NOT emit — the dedup index would reject a real dup anyway, but a
      // silent re-emit storm is avoided. Return a sentinel by marking all ids
      // as "seen" so this pass emits nothing for them.
      logger.warn({ err: error, verb }, "intelDomainEvents: dedup read failed; skipping emit this pass");
      for (const id of ids) seen.add(id);
      return seen;
    }
    for (const r of (data as any[]) ?? []) {
      const id = r?.payload?.intel?.[jsonKey];
      if (typeof id === "string") seen.add(id);
    }
  } catch (err) {
    logger.warn({ err, verb }, "intelDomainEvents: dedup read threw; skipping emit this pass");
    for (const id of ids) seen.add(id);
  }
  return seen;
}

export interface PromotionEmitResult {
  observationsRecorded: number;
  claimsPromoted: number;
}

/**
 * Emit intel.claim.promoted for every system-promoted live claim not yet
 * recorded, and intel.observation.recorded for the observation that anchored
 * each such claim. Called by the promotion pass AFTER the RPC; a catch-up
 * emitter, so it is correct whether or not this pass promoted anything.
 */
export async function emitPromotionDomainEvents(sc: any, opts: { now?: Date } = {}): Promise<PromotionEmitResult> {
  const now = opts.now ?? new Date();
  const nil: PromotionEmitResult = { observationsRecorded: 0, claimsPromoted: 0 };
  if (!sc) return nil;
  try {
    // 1. System-promoted live claims (2174 provenance). Bounded; newest first so
    //    a bounded pass catches recent promotions, older ones already emitted.
    const { data: claimData, error: claimErr } = await sc
      .from("intel_claims")
      .select("id, subject_id, zone_id, claim_type, confidence, confidence_band, observed_at, created_at")
      .eq("promotion_source", "system")
      .in("status", ["active", "conflicting"])
      .order("created_at", { ascending: false })
      .limit(MAX_PER_PASS);
    if (claimErr) {
      logger.warn({ err: claimErr }, "intelDomainEvents: promoted-claim read failed");
      return nil;
    }
    const claims = ((claimData as PromotedClaimRow[]) ?? []).filter((c) => c.id && c.subject_id && c.claim_type);
    if (claims.length === 0) return nil;

    // 2. Skip claims whose promoted event already exists.
    const already = await existingIntelIds(sc, "intel.claim.promoted", "claim_id", claims.map((c) => c.id));
    const newClaims = claims.filter((c) => !already.has(c.id));
    if (newClaims.length === 0) return nil;

    // 3. Anchor observation per new claim: same natural key + observed_at the
    //    promote function (DISTINCT ON latest observed_at) copied onto the claim.
    const subjectIds = [...new Set(newClaims.map((c) => c.subject_id))];
    const claimTypes = [...new Set(newClaims.map((c) => c.claim_type))];
    let anchors: AnchorObservationRow[] = [];
    try {
      const { data: obsData, error: obsErr } = await sc
        .from("intel_observations")
        .select("id, subject_id, zone_id, claim_type, observed_at, source_class, presence_level, actor_id")
        .in("subject_id", subjectIds)
        .in("claim_type", claimTypes)
        .limit(MAX_PER_PASS);
      if (obsErr) logger.warn({ err: obsErr }, "intelDomainEvents: anchor-observation read failed");
      else anchors = ((obsData as AnchorObservationRow[]) ?? []);
    } catch (err) {
      logger.warn({ err }, "intelDomainEvents: anchor-observation read threw");
    }
    const anchorByKey = new Map<string, AnchorObservationRow>();
    for (const o of anchors) {
      if (!o.id) continue;
      const k = JSON.stringify([o.subject_id, o.zone_id ?? "", o.claim_type, o.observed_at]);
      if (!anchorByKey.has(k)) anchorByKey.set(k, o); // first match is enough
    }

    const claimEvents: CanonicalEventInput[] = [];
    const anchorObs: AnchorObservationRow[] = [];
    for (const c of newClaims) {
      claimEvents.push(buildClaimPromotedEvent(c, now));
      const anchor = anchorByKey.get(JSON.stringify([c.subject_id, c.zone_id ?? "", c.claim_type, c.observed_at]));
      if (anchor) anchorObs.push(anchor);
    }

    // 4. observation.recorded for anchors not yet recorded (deduped per obs id).
    const obsIds = [...new Set(anchorObs.map((o) => o.id))];
    const obsAlready = await existingIntelIds(sc, "intel.observation.recorded", "observation_id", obsIds);
    const seenObs = new Set<string>();
    const obsEvents: CanonicalEventInput[] = [];
    for (const o of anchorObs) {
      if (obsAlready.has(o.id) || seenObs.has(o.id)) continue;
      seenObs.add(o.id);
      obsEvents.push(buildObservationRecordedEvent(o, now));
    }

    const claimsPromoted = await insertEventsTolerant(sc, claimEvents);
    const observationsRecorded = await insertEventsTolerant(sc, obsEvents);
    if (claimsPromoted > 0 || observationsRecorded > 0) {
      logger.info({ claimsPromoted, observationsRecorded }, "intelDomainEvents: promotion transitions recorded");
    }
    return { observationsRecorded, claimsPromoted };
  } catch (err) {
    logger.warn({ err }, "intelDomainEvents: emitPromotionDomainEvents threw");
    return nil;
  }
}

export interface StateChangedEmitResult {
  stateChanged: number;
}

/**
 * Emit intel.state.changed for the projection pass. `prior`/`post` are the
 * snapshot semantic state, keyed by snapshotKey, captured before and after the
 * pass over the projected group subjects. `wentDark` are snapshots the pass
 * force-expired whose subject was NOT projected (a subject whose claims all left
 * live-eligibility) — emitted as an "expired" transition, deduped by snapshot id
 * against the diff so a group-subject orphan is never counted twice.
 */
export async function emitStateChangedEvents(
  sc: any,
  prior: Map<string, SnapshotRow>,
  post: Map<string, SnapshotRow>,
  wentDark: readonly Pick<SnapshotRow, "id" | "subject_id" | "zone_id" | "claim_type">[],
  opts: { now?: Date } = {},
): Promise<StateChangedEmitResult> {
  const now = opts.now ?? new Date();
  if (!sc) return { stateChanged: 0 };
  try {
    const events: CanonicalEventInput[] = [];
    const emittedSnapIds = new Set<string>();
    for (const [key, next] of post) {
      const p = prior.get(key);
      const t = snapshotTransition(
        p ? { value: p.value, confidence_band: p.confidence_band, privacy_eligible: p.privacy_eligible } : undefined,
        { value: next.value, confidence_band: next.confidence_band, privacy_eligible: next.privacy_eligible },
      );
      if (!t) continue;
      events.push(buildStateChangedEvent(next, t, now));
      emittedSnapIds.add(next.id);
    }
    for (const d of wentDark) {
      if (!d.id || emittedSnapIds.has(d.id)) continue;
      emittedSnapIds.add(d.id);
      events.push(buildStateChangedEvent({ ...d, confidence: null, confidence_band: null, privacy_eligible: false }, "expired", now));
    }
    const stateChanged = await insertEventsTolerant(sc, events);
    if (stateChanged > 0) logger.info({ stateChanged }, "intelDomainEvents: state transitions recorded");
    return { stateChanged };
  } catch (err) {
    logger.warn({ err }, "intelDomainEvents: emitStateChangedEvents threw");
    return { stateChanged: 0 };
  }
}

/** Read snapshot semantic state for a set of subjects, keyed by snapshotKey. */
export async function captureSnapshotStates(sc: any, subjectIds: readonly string[]): Promise<Map<string, SnapshotRow>> {
  const out = new Map<string, SnapshotRow>();
  if (!sc || subjectIds.length === 0) return out;
  try {
    const { data, error } = await sc
      .from("intel_state_snapshots")
      .select("id, subject_id, zone_id, claim_type, value, confidence, confidence_band, privacy_eligible, observed_at, expires_at")
      .in("subject_id", subjectIds as string[])
      .limit(MAX_PER_PASS);
    if (error) {
      logger.warn({ err: error }, "intelDomainEvents: snapshot-state read failed");
      return out;
    }
    for (const r of ((data as SnapshotRow[]) ?? [])) {
      if (!r.id || !r.subject_id || !r.claim_type) continue;
      out.set(snapshotKey(r), r);
    }
  } catch (err) {
    logger.warn({ err }, "intelDomainEvents: snapshot-state read threw");
  }
  return out;
}
