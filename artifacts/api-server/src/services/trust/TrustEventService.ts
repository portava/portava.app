/**
 * TrustEventService
 *
 * Records trust signals into trust_events with:
 * - Source deduplication (same user+type+source within window)
 * - Daily/weekly earning caps per event type (from trust_settings)
 * - Severity classification (minor / moderate / serious / severe)
 * - Automatic pending_review status for serious/severe events
 * - Feature-flag gating (trust_engine_enabled)
 *
 * Never auto-bans. Serious/severe events are queued for admin review.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger as rootLogger } from "../../lib/logger.js";

const logger = rootLogger.child({ service: "TrustEventService" });

export type TrustCategory =
  | "plan_attendance"
  | "host_quality"
  | "communication"
  | "respect_safety"
  | "location_honesty"
  | "content_quality"
  | "community_value"
  | "guide_accuracy"
  | "passport_authenticity";

export type TrustSeverity = "minor" | "moderate" | "serious" | "severe";
export type TrustEventStatus = "applied" | "pending_review" | "confirmed" | "dismissed";

/**
 * Metadata key carrying the OTHER USER an event was earned from.
 *
 * `source_id` cannot serve this purpose and never could: every production call
 * site sets it to the id of the OBJECT the event came from — a booking, a gem,
 * a review row, a geofence, a message request — because it is the dedup key.
 * The two sites that do put a user id there (events.ts first_event_joined /
 * first_event_hosted) put the SUBJECT's own id, not a counterpart's.
 *
 * The mutual-ring detector needs the counterpart, so it is recorded explicitly
 * here rather than inferred from a field that means something else.
 */
export const COUNTERPARTY_METADATA_KEY = "counterparty_user_id";

export interface TrustEventInput {
  userId: string;
  eventType: string;
  category: TrustCategory;
  delta: number;
  severity: TrustSeverity;
  sourceType?: string;
  sourceId?: string;
  /**
   * The other user this event was earned from, when there is one — the person
   * reviewed, or the person on the other side of an accepted connection.
   * Recorded into `metadata[COUNTERPARTY_METADATA_KEY]`; consumed by
   * TrustGamingDetectionService's mutual-ring scan. Omit when the event has no
   * counterpart (a GPS finding, a stamp, a solo milestone).
   */
  counterpartyUserId?: string;
  /** Dedup window in hours — default 24 */
  dedupWindowHours?: number;
  metadata?: Record<string, unknown>;
}

export interface RecordEventResult {
  ok: boolean;
  eventId?: string;
  skipped?: boolean;
  /**
   * `dedup_unverifiable` — the dedup read itself failed, so whether this event
   * is a repeat could not be established. The event is NOT written: with the
   * flag on, an unverifiable dedup that inserted anyway would turn every
   * transient trust_events read failure into a double award (see isDuplicate).
   */
  skipReason?: "dedup" | "daily_cap" | "flag_off" | "dedup_unverifiable";
  pendingReview?: boolean;
}

/**
 * Check if trust engine is enabled.
 *
 * Exported so the maintenance scheduler uses this exact gate rather than its own
 * copy: events and scoring must never disagree about whether the engine is on,
 * and a second direct feature_flags read would need its own DIRECT_READS entry
 * recording a separately-verified failure direction. One read, one judgement.
 */
export async function isTrustEnabled(db: SupabaseClient): Promise<boolean> {
  try {
    const { data, error } = await db
      .from("feature_flags")
      .select("enabled")
      .eq("flag", "trust_engine_enabled")
      .maybeSingle();
    if (error) {
      // Fail closed — but never silently. supabase-js resolves on a database
      // error, and an unread `error` here made a broken feature_flags read
      // indistinguishable from the flag being off: every emitter returned
      // `flag_off` and the ledger went quiet with nothing in the logs.
      logger.warn({ err: error }, "trust_engine_enabled read failed — treating the engine as OFF for this call");
      return false;
    }
    return Boolean((data as any)?.enabled);
  } catch (err) {
    logger.warn({ err }, "trust_engine_enabled read threw — treating the engine as OFF for this call");
    return false;
  }
}

/** Count events for a user across a set of event types within a time window.
 *  Fail-CLOSED: a read error returns Infinity (treated as "at cap"), so a
 *  transient trust_events failure can never open an uncapped earning window. */
async function countInWindow(
  db: SupabaseClient,
  userId: string,
  eventTypes: readonly string[],
  windowMs: number,
): Promise<number> {
  try {
    const since = new Date(Date.now() - windowMs).toISOString();
    const { data, error } = await db
      .from("trust_events")
      .select("id")
      .eq("user_id", userId)
      .in("event_type", eventTypes as string[])
      .gt("created_at", since);
    if (error) return Number.POSITIVE_INFINITY;
    return (data as any[])?.length ?? 0;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** All event types sharing an event's cap BUCKET, so the cap is enforced per
 *  bucket (its intent) rather than per exact type — otherwise two types in the
 *  same bucket each get an independent counter and double the cap. */
function eventTypesForCap(eventType: string): string[] {
  const bucket = EVENT_TYPE_CAP_BUCKET[eventType.toLowerCase()];
  if (!bucket) return [eventType];
  const siblings = Object.entries(EVENT_TYPE_CAP_BUCKET)
    .filter(([, b]) => b === bucket)
    .map(([t]) => t);
  // Include the raw event type too, in case a stored value is not lower-cased.
  return Array.from(new Set([eventType, eventType.toLowerCase(), ...siblings]));
}

interface EarningCaps { daily: number; weekly: number }

/**
 * Canonical event-type → cap bucket map.
 * Keys are lower-cased for case-insensitive matching.
 * "plan_attend" | "guide_verify" | "gem_save" — unlimited otherwise.
 */
const EVENT_TYPE_CAP_BUCKET: Record<string, "plan_attend" | "guide_verify" | "gem_save"> = {
  // Plan attendance
  plan_attended:           "plan_attend",
  plan_attend_positive:    "plan_attend",
  plan_attend_weekly:      "plan_attend",
  // Guide verification
  guide_verify_positive:   "guide_verify",
  gem_verified_by_guide:   "guide_verify",
  guide_verification:      "guide_verify",
  // Gem save
  gem_save_positive:       "gem_save",
  gem_saved:               "gem_save",
  checkin_verified:        "gem_save",
};

/**
 * Earning cap for positive event types with no explicit bucket.
 *
 * This used to be 999/999 — i.e. no cap at all. Only 9 literal event-type
 * strings are bucketed, but far more positive types are actually emitted
 * (event_attended, event_hosted, review_submitted, pulse_post_created,
 * passport_stamp_earned, rent_buddy_completed, telegraph_connection_accepted,
 * identity_verified, appeal_approved …), so in practice the main earning
 * surfaces were entirely uncapped.
 *
 * Chosen to sit at the most permissive existing bucket (gem_save, 10/40) so it
 * cannot bind ordinary heavy use — nobody legitimately completes more than ten
 * trust-earning actions of one type in a day — while still removing the
 * unbounded-accrual path. Naturally one-shot types (identity_verified,
 * first_event_joined) are unaffected: they fire once and never approach it.
 *
 * These are counts of EVENTS ACCEPTED, not score. The confidence ramp in
 * TrustScoreService is what actually governs how fast a score can rise; this
 * cap bounds ledger volume and the load a farming loop can generate.
 */
const DEFAULT_EARNING_CAP: EarningCaps = { daily: 10, weekly: 40 };

/** Returns daily and weekly caps for an event type from trust_settings */
async function getEarningCaps(
  db: SupabaseClient,
  eventType: string,
): Promise<EarningCaps> {
  try {
    const bucket = EVENT_TYPE_CAP_BUCKET[eventType.toLowerCase()];
    if (!bucket) return DEFAULT_EARNING_CAP;
    const { data } = await db.from("trust_settings").select(
      "daily_cap_plan_attend,daily_cap_guide_verify,daily_cap_gem_save," +
      "weekly_cap_plan_attend,weekly_cap_guide_verify,weekly_cap_gem_save",
    ).eq("id", 1).maybeSingle();
    if (!data) {
      const defaults = { plan_attend: { daily: 3, weekly: 10 }, guide_verify: { daily: 5, weekly: 20 }, gem_save: { daily: 10, weekly: 40 } };
      return defaults[bucket];
    }
    const s = data as any;
    if (bucket === "plan_attend")  return { daily: s.daily_cap_plan_attend  ?? 3,  weekly: s.weekly_cap_plan_attend  ?? 10 };
    if (bucket === "guide_verify") return { daily: s.daily_cap_guide_verify ?? 5,  weekly: s.weekly_cap_guide_verify ?? 20 };
    /* gem_save */                 return { daily: s.daily_cap_gem_save     ?? 10, weekly: s.weekly_cap_gem_save     ?? 40 };
  } catch {
    // Restrict rather than open on error. This path only ever delays ACCRUAL —
    // it can never reduce an existing score — so failing closed costs a user at
    // most a postponed positive event, whereas failing open (the previous
    // 999/999) turned any transient trust_settings read failure into an
    // uncapped earning window.
    return DEFAULT_EARNING_CAP;
  }
}

/**
 * Check the deduplication window.
 *
 * Returns `"duplicate"`, `"new"`, or `"unverifiable"`. The third answer is the
 * one that used to be missing: this read `const { data }` and ignored `error`,
 * and supabase-js RESOLVES on a database error — so a failed read looked like
 * "no prior event" and the insert went ahead. That is the idempotency key
 * failing open: a transient trust_events outage during a retry, a re-delivered
 * webhook, or a re-bridged intel row would have written the same event twice
 * and scored it twice. `countInWindow` already fails closed (Infinity = at
 * cap) for the same reason; dedup now does too.
 */
async function isDuplicate(
  db: SupabaseClient,
  userId: string,
  eventType: string,
  sourceType: string,
  sourceId: string | undefined,
  windowHours: number,
): Promise<"duplicate" | "new" | "unverifiable"> {
  if (!sourceId) return "new";
  try {
    const since = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();
    const { data, error } = await db
      .from("trust_events")
      .select("id")
      .eq("user_id", userId)
      .eq("event_type", eventType)
      .eq("source_type", sourceType)
      .eq("source_id", sourceId)
      .gt("created_at", since)
      .maybeSingle();
    if (error) {
      logger.warn({ err: error, userId, eventType, sourceType, sourceId }, "dedup read failed — event NOT recorded (fail-closed)");
      return "unverifiable";
    }
    return data ? "duplicate" : "new";
  } catch (err) {
    logger.warn({ err, userId, eventType, sourceType, sourceId }, "dedup read threw — event NOT recorded (fail-closed)");
    return "unverifiable";
  }
}

/** Record a trust event with dedup, cap, and severity checks */
export async function recordTrustEvent(
  db: SupabaseClient,
  input: TrustEventInput,
): Promise<RecordEventResult> {
  if (!await isTrustEnabled(db)) {
    return { ok: false, skipped: true, skipReason: "flag_off" };
  }

  const {
    userId, category, delta, severity,
    sourceType = "system", sourceId, counterpartyUserId, dedupWindowHours = 24,
    metadata: callerMetadata = {},
  } = input;
  // A counterpart never overwrites an explicit metadata value of the same key.
  const metadata: Record<string, unknown> =
    counterpartyUserId && callerMetadata[COUNTERPARTY_METADATA_KEY] === undefined
      ? { ...callerMetadata, [COUNTERPARTY_METADATA_KEY]: counterpartyUserId }
      : callerMetadata;
  // Normalize to lowercase so "PLAN_ATTENDED" and "plan_attended" are the same bucket
  const eventType = input.eventType.toLowerCase();

  // Deduplication check — fails CLOSED when it cannot be performed.
  const dup = await isDuplicate(db, userId, eventType, sourceType, sourceId, dedupWindowHours);
  if (dup === "duplicate")    return { ok: false, skipped: true, skipReason: "dedup" };
  if (dup === "unverifiable") return { ok: false, skipped: true, skipReason: "dedup_unverifiable" };

  // Daily and weekly cap checks (only for positive events)
  if (delta > 0) {
    const caps = await getEarningCaps(db, eventType);
    const capTypes = eventTypesForCap(eventType); // count the whole bucket, not one type
    const [dayCount, weekCount] = await Promise.all([
      countInWindow(db, userId, capTypes, 24 * 60 * 60 * 1000),
      countInWindow(db, userId, capTypes, 7 * 24 * 60 * 60 * 1000),
    ]);
    if (dayCount >= caps.daily || weekCount >= caps.weekly) {
      return { ok: false, skipped: true, skipReason: "daily_cap" };
    }
  }

  // Serious/severe → pending_review; others → applied
  const status: TrustEventStatus =
    (severity === "serious" || severity === "severe") ? "pending_review" : "applied";

  const { data, error } = await db
    .from("trust_events")
    .insert({
      user_id:     userId,
      event_type:  eventType,
      category,
      delta,
      severity,
      source_type: sourceType,
      source_id:   sourceId ?? null,
      status,
      metadata,
    })
    .select("id")
    .single();

  if (error) {
    // 23505 = unique_violation. Migration 2540 adds a partial UNIQUE index on
    // the dedup key for the one-shot event types; when two concurrent emitters
    // both pass the read-then-insert dedup above, the database refuses the
    // second insert. That is the same fact as `dup === "duplicate"` — the
    // event already exists — so it is reported as a dedup skip, not thrown.
    // Any other insert error is still a failure the caller must see.
    if ((error as any).code === "23505") {
      logger.info({ userId, eventType, sourceType, sourceId }, "trust_events insert refused by unique index — treated as dedup");
      return { ok: false, skipped: true, skipReason: "dedup" };
    }
    throw new Error(`recordTrustEvent DB error: ${error.message}`);
  }

  const eventId: string = (data as any).id;
  if (status === "pending_review") {
    await queueEventForReview(db, userId, eventId, { eventType, category, severity, sourceType });
  }

  return {
    ok: true,
    eventId,
    pendingReview: status === "pending_review",
  };
}

/**
 * Put a pending_review event on the admin review queue.
 *
 * The header of this module has always said "Serious/severe events are queued
 * for admin review". They were routed to status='pending_review' — and that
 * was the whole of the queueing. The queue an admin actually reads is
 * `trust_reviews` (GET /admin/trust/reviews), and nothing wrote a row there
 * for a pending event: recordAdjudicatedTrustEvent's own comment records the
 * gap ("nothing would prompt them to, since recordTrustEvent writes no
 * trust_reviews row"), and TrustAdminService.confirmEvent / dismissEvent both
 * close `trust_reviews WHERE source_event_id = eventId` — a row that never
 * existed. The schema was built for this: `review_type` admits 'event_review'
 * and `source_event_id` is a foreign key to trust_events. So an unattended
 * serious finding — an impossible-speed GPS trace, a host no-show — sat in
 * pending_review, excluded from the score by design, visible only to an admin
 * who happened to open that one user's page. Queued into a queue nobody could
 * list.
 *
 * One review per event, keyed by source_event_id; the event itself is already
 * deduplicated upstream. Non-fatal: the event is the record of the finding
 * and is already written; a failed review insert delays the adjudication
 * rather than losing the evidence, and is logged so it cannot fail silently.
 */
async function queueEventForReview(
  db: SupabaseClient,
  userId: string,
  eventId: string,
  facts: { eventType: string; category: TrustCategory; severity: TrustSeverity; sourceType: string },
): Promise<void> {
  try {
    const { error } = await db.from("trust_reviews").insert({
      user_id:         userId,
      review_type:     "event_review",
      source_event_id: eventId,
      status:          "open",
      metadata: {
        event_type:  facts.eventType,
        category:    facts.category,
        severity:    facts.severity,
        source_type: facts.sourceType,
      },
    });
    if (error) {
      logger.warn(
        { err: error, userId, eventId, eventType: facts.eventType },
        "pending_review event recorded but trust_reviews queue insert failed — adjudication delayed, not lost",
      );
    }
  } catch (err) {
    logger.warn(
      { err, userId, eventId, eventType: facts.eventType },
      "pending_review event recorded but trust_reviews queue insert threw — adjudication delayed, not lost",
    );
  }
}

/** Batch record multiple events (ignores individual failures) */
export async function recordTrustEvents(
  db: SupabaseClient,
  inputs: TrustEventInput[],
): Promise<RecordEventResult[]> {
  return Promise.all(inputs.map((i) => recordTrustEvent(db, i).catch(() => ({ ok: false }))));
}

/**
 * Wire location trust events into the engine.
 * Called from LocationSafetyService after suspicious GPS detected.
 */
export async function recordLocationTrustEvent(
  db: SupabaseClient,
  userId: string,
  suspicionReason: string,
  confidence: "low" | "medium" | "high",
): Promise<void> {
  const severity: TrustSeverity =
    confidence === "high" ? "serious" : confidence === "medium" ? "moderate" : "minor";
  const delta = confidence === "high" ? -8 : confidence === "medium" ? -4 : -1;

  await recordTrustEvent(db, {
    userId,
    eventType: `gps_${suspicionReason}`,
    category: "location_honesty",
    delta,
    severity,
    sourceType: "gps",
    sourceId: `${userId}:${suspicionReason}:${Math.floor(Date.now() / 86400000)}`, // daily dedup
    dedupWindowHours: 24,
    metadata: { suspicionReason, confidence },
  }).catch(() => {/* non-fatal */});
}

/**
 * Record a trust event for a finding a human admin has ALREADY adjudicated, and
 * confirm it in the same request, attributed to that admin.
 *
 * ── WHY THIS EXISTS, AND WHY IT IS NOT A CHANGE TO recordTrustEvent ─────────
 * recordTrustEvent routes serious/severe to 'pending_review', which the scorer
 * excludes — deliberately, because those events normally come from MACHINE
 * findings (GPS confidence, the gaming detector) where the premise is that
 * nobody has looked yet. On an admin moderation path someone has: the ban or the
 * content removal IS the finding, already written to moderation_actions.
 *
 * Leaving those events queued would ask a second admin to re-adjudicate a
 * decision rather than review evidence — and nothing would prompt them to, since
 * recordTrustEvent writes no trust_reviews row. So the queue is collapsed HERE,
 * at the call site, and recordTrustEvent's routing is left exactly as it is. An
 * unattended severe event must still queue.
 *
 * ── WHY NOT JUST LOWER THE SEVERITY ────────────────────────────────────────
 * Because severity is a ROUTE, not a magnitude. It decides pending_review vs
 * applied AND whether applyEventCaps ever runs. Emitting a ban as 'moderate'
 * would apply its -20 immediately and forfeit the respect_safety ceiling and the
 * 30-day probation — and the repo's own test proves the delta alone barely moves
 * a well-regarded account (ten +3 events against one -20 still lands above
 * neutral). That would look wired while doing almost nothing, which is worse
 * than being visibly unwired.
 *
 * ── SAFETY PROPERTIES ──────────────────────────────────────────────────────
 * - Only ever called for ADJUDICATED actions. A dismissed report, an unverify,
 *   or a host muting a guest in their own room must never reach this — that is
 *   the same rule that keeps reportGem free of consequence.
 * - `sourceId` should be the moderation_actions row id, so one adjudication
 *   charges once no matter how many times the admin clicks.
 * - Confirmation failure is NON-FATAL: the event stays recorded and queued, so a
 *   transient error delays the penalty rather than losing the finding.
 * - The reversal path (TrustAdminService.revokeModerationTrustConsequences)
 *   exists BEFORE this does, because confirming applies caps and a
 *   behavior_report_confirmed ceiling has no expiry.
 */
export async function recordAdjudicatedTrustEvent(
  db: SupabaseClient,
  adminId: string,
  input: TrustEventInput,
  reason = "Adjudicated by admin moderation action",
): Promise<RecordEventResult & { confirmed?: boolean }> {
  const result = await recordTrustEvent(db, { ...input, sourceType: input.sourceType ?? "moderation" });
  if (!result.ok || !result.eventId) return result;

  // Only serious/severe land in pending_review; minor/moderate are already applied.
  if (!result.pendingReview) return { ...result, confirmed: true };

  try {
    const { confirmEvent } = await import("./TrustAdminService.js");
    await confirmEvent(db, adminId, result.eventId, reason);
    return { ...result, confirmed: true };
  } catch {
    // Degrades to the queue rather than losing the event.
    return { ...result, confirmed: false };
  }
}


/**
 * The Trust-owned half of STAMP_VERIFIED.
 *
 * ── WHAT WAS MEASURED ────────────────────────────────────────────────────────
 * `STAMP_VERIFIED` (+3 passport_authenticity) has been declared below since the
 * vocabulary was written and emitted by nothing. In production, every
 * `user_stamps` row awarded since `trust_engine_enabled` went TRUE on
 * 2026-07-17 (18 rows by earned_at, 23 stamp_award_events by created_at, read
 * 2026-09-07) produced ZERO trust events. The live award path is
 * `services/passport/StampAwardEngine.awardStamp`, which already classifies
 * every award by provenance tier (`stampVerificationTier`: everything
 * server-derived is "verified"; only self_reported/self/decorative is
 * "reported") and emits the §32 `stamp_verified` TELEMETRY event on that tier —
 * but never the trust event. `passport_authenticity` can therefore only go DOWN
 * on the live pipeline (`stamp_disputed`, StampAwardEngine.revokeStamp).
 *
 * ── WHY THE CALL IS NOT MADE HERE ────────────────────────────────────────────
 * The triggering action — a fresh, non-recovery stamp award — happens inside
 * StampAwardEngine, which is Passport-owned (services/passport/**, §12/§32 of
 * the Passport spec, `recordPassportEvent` telemetry). Trust does not reach
 * into another surface's award path. This function is the exact one-line call
 * that path needs to make, on its `awarded: true` return only, so the delta,
 * severity, category, provenance and idempotency key are fixed HERE, in the
 * vocabulary's own file, and the Passport change is a call, not a decision.
 *
 * ── PROVENANCE AND IDEMPOTENCY ───────────────────────────────────────────────
 *   user_id     — the stamp OWNER (the actor whose travel fact was verified);
 *                 an admin-awarded stamp still credits the owner, and the admin
 *                 is recorded in metadata, never as the subject.
 *   source_type — 'passport'; source_id — the user_stamps row id. One stamp can
 *                 pay once, ever (365-day dedup window; recordTrustEvent's
 *                 dedup fails closed).
 *   tier        — only 'verified' provenance emits. A 'reported' (self-declared)
 *                 stamp is a decoration, not evidence; nothing is written and
 *                 `{ ok: false, skipped: true, skipReason: "not_verified" }` is
 *                 returned so the caller can tell "skipped by rule" from
 *                 "skipped by the engine".
 *   recovery    — awardStamp's recovery path (`skipToStampInsert`) re-inserts a
 *                 user_stamps row for an award event that already exists; the
 *                 caller must pass the SAME userStampId semantics it uses for
 *                 the §32 telemetry (fresh award only), and the dedup key
 *                 catches the rest.
 *
 * Never throws: an award must not fail because trust bookkeeping did.
 */
export async function recordStampVerifiedTrustEvent(
  db: SupabaseClient,
  input: {
    /** The stamp owner — the subject of the evidence. */
    userId: string;
    /** user_stamps.id of the FRESH award (never a recovery/no-op result). */
    userStampId: string;
    /** StampAwardEngine's provenance tier for this award. */
    tier: "verified" | "reported";
    /** user_stamps.source_type — trips | events | posts | admin | … */
    stampSourceType: string;
    stampDefinitionId?: string | null;
    /** Present only for admin-awarded stamps; recorded, never made the subject. */
    awardedByAdminId?: string | null;
  },
): Promise<Omit<RecordEventResult, "skipReason"> & { skipReason?: NonNullable<RecordEventResult["skipReason"]> | "not_verified" }> {
  if (input.tier !== "verified") {
    return { ok: false, skipped: true, skipReason: "not_verified" };
  }
  const t = TRUST_EVENT_TYPES.STAMP_VERIFIED;
  try {
    return await recordTrustEvent(db, {
      userId: input.userId,
      eventType: "stamp_verified",
      category: t.category,
      delta: t.delta,
      severity: t.severity,
      sourceType: "passport",
      sourceId: input.userStampId,
      dedupWindowHours: 24 * 365,
      metadata: {
        userStampId:       input.userStampId,
        stampSourceType:   input.stampSourceType,
        stampDefinitionId: input.stampDefinitionId ?? null,
        awardedByAdminId:  input.awardedByAdminId ?? null,
        tier:              input.tier,
      },
    });
  } catch (err) {
    logger.warn({ err, userId: input.userId, userStampId: input.userStampId }, "stamp_verified trust event failed (non-fatal to the award)");
    return { ok: false };
  }
}

/**
 * Host-cancel trigger conditions. Trust-owned POLICY surface (like the review
 * bands below): the vocabulary fixes the delta and severity of
 * EVENT_HOST_CANCELLED; it does not say WHICH cancellations count. These two
 * constants do, and they are exported so the rule is inspectable and testable
 * rather than buried in a route.
 *
 *   - Only a PUBLISHED event can be broken: a draft was never a commitment to
 *     anyone, and a completed/archived event has nothing left to cancel.
 *   - Only a cancellation that lets somebody down is host-quality evidence: at
 *     least one OTHER user must have committed ("going") to it. Cancelling an
 *     empty event — a mistake, a test, a change of plan nobody had joined — is
 *     recorded as a skip with a reason, never as a penalty.
 *
 * Both are the conservative subset. Whether a far-in-advance cancellation
 * should be exempt, or a "maybe" should count as commitment, is an owner
 * decision; the facts needed to decide it (lead time, counts) are written into
 * the event's metadata so the policy can be tightened or loosened later
 * without losing the evidence.
 */
export const EVENT_HOST_CANCEL_TRIGGER_STATES: readonly string[] = ["open", "started"];
export const EVENT_HOST_CANCEL_MIN_COMMITTED_ATTENDEES = 1;

/**
 * The Trust-owned half of EVENT_HOST_CANCELLED.
 *
 * Called by routes/events.ts from BOTH host-cancel routes (DELETE /events/:id
 * and POST /events/:id/cancel — the same action behind two verbs) AFTER the
 * state transition to 'cancelled' has been written. Never for an admin cancel
 * (routes/admin.ts `event_cancel`): that is the admin's act, not the host's.
 *
 *   user_id     — the HOST (the actor whose commitment was broken).
 *   source_type — 'event'; source_id — the event id. One event can charge its
 *                 host once (365-day dedup; recordTrustEvent's dedup fails
 *                 closed; migration 2540 makes the key unique in the database).
 *                 Two routes, one key: the second route hitting the same event
 *                 is a dedup skip, not a second penalty.
 *
 * Returns `{ skipReason: "not_published" | "no_committed_attendees" }` when the
 * trigger conditions above are not met, so the caller (and a test) can tell
 * "skipped by rule" from "skipped by the engine". Never throws.
 */
export async function recordEventHostCancelledTrustEvent(
  db: SupabaseClient,
  input: {
    hostId: string;
    eventId: string;
    /** events.state BEFORE the transition to 'cancelled'. */
    priorState: string;
    /** Live count of event_rsvps with status='going' for users OTHER than the host. */
    committedAttendees: number;
    startsAt?: string | null;
    reason?: string | null;
  },
): Promise<Omit<RecordEventResult, "skipReason"> & { skipReason?: NonNullable<RecordEventResult["skipReason"]> | "not_published" | "no_committed_attendees" }> {
  if (!EVENT_HOST_CANCEL_TRIGGER_STATES.includes(input.priorState)) {
    return { ok: false, skipped: true, skipReason: "not_published" };
  }
  if (input.committedAttendees < EVENT_HOST_CANCEL_MIN_COMMITTED_ATTENDEES) {
    return { ok: false, skipped: true, skipReason: "no_committed_attendees" };
  }
  const t = TRUST_EVENT_TYPES.EVENT_HOST_CANCELLED;
  const startsAtMs = input.startsAt ? Date.parse(input.startsAt) : NaN;
  const leadTimeHours = Number.isFinite(startsAtMs) ? Math.round((startsAtMs - Date.now()) / 36e5) : null;
  try {
    return await recordTrustEvent(db, {
      userId: input.hostId,
      eventType: "event_host_cancelled",
      category: t.category,
      delta: t.delta,
      severity: t.severity,
      sourceType: "event",
      sourceId: input.eventId,
      dedupWindowHours: 24 * 365,
      metadata: {
        eventId:            input.eventId,
        priorState:         input.priorState,
        committedAttendees: input.committedAttendees,
        startsAt:           input.startsAt ?? null,
        leadTimeHours,
        reason:             input.reason ?? null,
      },
    });
  } catch (err) {
    logger.warn({ err, hostId: input.hostId, eventId: input.eventId }, "event_host_cancelled trust event failed (non-fatal to the cancel)");
    return { ok: false };
  }
}

/**
 * Rating bands for event reviews. Trust-owned POLICY surface.
 *
 * The vocabulary fixes EVENT_POSITIVE_REVIEW (+3 minor) and
 * EVENT_NEGATIVE_REVIEW (-6 moderate) but not where on a 1–5 scale "positive"
 * and "negative" begin. This follows the one precedent already in the tree —
 * routes/rentABuddy.ts treats `rating >= 4` as the positive band — and mirrors
 * it for the negative side. A 3 is neutral and emits NOTHING: a middling
 * review is not evidence of host quality in either direction. Owner decision
 * to confirm; see the report.
 */
export const EVENT_REVIEW_RATING_BANDS = { positiveMin: 4, negativeMax: 2 } as const;

/**
 * The Trust-owned half of EVENT_POSITIVE_REVIEW / EVENT_NEGATIVE_REVIEW.
 *
 * Called by routes/events.ts POST /events/:id/reviews on the FIRST submission
 * of a review only. That route already guarantees the trigger is real: the
 * event is 'completed', the reviewer is a confirmed attendee, and the host
 * cannot review their own event.
 *
 *   user_id       — the HOST (the subject of the review; the person being
 *                   rated). The reviewer is the counterparty, never the subject.
 *   source_type   — 'event_review'; source_id — the event_reviews row id. One
 *                   review can charge or credit once (365-day dedup; 2540
 *                   makes the key unique). The route upserts on
 *                   (event_id, reviewer_id), so an EDITED review keeps its id —
 *                   the caller must pass `isFirstSubmission: false` for an edit
 *                   and nothing is written: otherwise a 5 edited to a 1 would
 *                   stand as +3 AND -6 for one review. Whether an edit that
 *                   flips sentiment should re-score is an owner decision.
 *   counterparty  — the reviewer, for the mutual-ring scan — EXCEPT when the
 *                   review is anonymous. `trust_events` carries an RLS policy
 *                   (te_select_own) that lets the subject read their own
 *                   applied rows including metadata until migration 2370 is on
 *                   production; recording an anonymous reviewer's id there
 *                   would let the host unmask them with one PostgREST call.
 *                   The ring scan is therefore blind to anonymous reviews for
 *                   now; `reviewerAnonymous: true` is recorded so the gap is
 *                   visible. Flip when 2370 is live — owner decision.
 *
 * Never throws: a review must not fail because trust bookkeeping did.
 */
export async function recordEventReviewTrustEvent(
  db: SupabaseClient,
  input: {
    hostId: string;
    reviewerId: string;
    eventId: string;
    reviewId: string;
    rating: number;
    anonymous: boolean;
    isFirstSubmission: boolean;
  },
): Promise<Omit<RecordEventResult, "skipReason"> & { skipReason?: NonNullable<RecordEventResult["skipReason"]> | "review_edit" | "neutral_rating" | "self_review" }> {
  if (input.hostId === input.reviewerId) return { ok: false, skipped: true, skipReason: "self_review" };
  if (!input.isFirstSubmission)          return { ok: false, skipped: true, skipReason: "review_edit" };
  const positive = input.rating >= EVENT_REVIEW_RATING_BANDS.positiveMin;
  const negative = input.rating <= EVENT_REVIEW_RATING_BANDS.negativeMax;
  if (!positive && !negative)            return { ok: false, skipped: true, skipReason: "neutral_rating" };
  const t = positive ? TRUST_EVENT_TYPES.EVENT_POSITIVE_REVIEW : TRUST_EVENT_TYPES.EVENT_NEGATIVE_REVIEW;
  try {
    return await recordTrustEvent(db, {
      userId: input.hostId,
      eventType: positive ? "event_positive_review" : "event_negative_review",
      category: t.category,
      delta: t.delta,
      severity: t.severity,
      sourceType: "event_review",
      sourceId: input.reviewId,
      counterpartyUserId: input.anonymous ? undefined : input.reviewerId,
      dedupWindowHours: 24 * 365,
      metadata: {
        eventId:           input.eventId,
        reviewId:          input.reviewId,
        rating:            input.rating,
        reviewerAnonymous: input.anonymous,
      },
    });
  } catch (err) {
    logger.warn({ err, hostId: input.hostId, reviewId: input.reviewId }, "event review trust event failed (non-fatal to the review)");
    return { ok: false };
  }
}

/** All event types by source system */
export const TRUST_EVENT_TYPES = {
  // Plans
  PLAN_ATTENDED:            { category: "plan_attendance" as TrustCategory, delta: 5,  severity: "minor" as TrustSeverity },
  PLAN_NO_SHOW:             { category: "plan_attendance" as TrustCategory, delta: -10, severity: "moderate" as TrustSeverity },
  PLAN_LATE_CANCEL:         { category: "plan_attendance" as TrustCategory, delta: -5,  severity: "minor" as TrustSeverity },
  HOST_POSITIVE_REVIEW:     { category: "host_quality" as TrustCategory,    delta: 6,  severity: "minor" as TrustSeverity },
  HOST_NEGATIVE_REVIEW:     { category: "host_quality" as TrustCategory,    delta: -8, severity: "moderate" as TrustSeverity },
  // Communication
  RESPONDED_PROMPTLY:       { category: "communication" as TrustCategory,   delta: 2,  severity: "minor" as TrustSeverity },
  MESSAGE_REPORT_CONFIRMED: { category: "communication" as TrustCategory,   delta: -15, severity: "serious" as TrustSeverity },
  // Respect & Safety
  SAFE_RETURN_COMPLETED:    { category: "respect_safety" as TrustCategory,  delta: 3,  severity: "minor" as TrustSeverity },
  BEHAVIOR_REPORT_CONFIRMED:{ category: "respect_safety" as TrustCategory,  delta: -20, severity: "severe" as TrustSeverity },
  // Location
  GPS_COORDINATE_JUMP:      { category: "location_honesty" as TrustCategory,delta: -4, severity: "moderate" as TrustSeverity },
  GPS_IMPOSSIBLE_SPEED:     { category: "location_honesty" as TrustCategory,delta: -8, severity: "serious" as TrustSeverity },
  CHECKIN_VERIFIED:         { category: "location_honesty" as TrustCategory,delta: 2,  severity: "minor" as TrustSeverity },
  FAKE_GPS_CONFIRMED:       { category: "location_honesty" as TrustCategory,delta: -20, severity: "severe" as TrustSeverity },
  // Content
  PULSE_POST_REPORTED:      { category: "content_quality" as TrustCategory, delta: -5, severity: "moderate" as TrustSeverity },
  CONTENT_REMOVED:          { category: "content_quality" as TrustCategory, delta: -10, severity: "serious" as TrustSeverity },
  // Community
  TRAVEL_CIRCLE_JOIN:       { category: "community_value" as TrustCategory, delta: 1,  severity: "minor" as TrustSeverity },
  MUTUAL_REPORT:            { category: "community_value" as TrustCategory, delta: -3, severity: "minor" as TrustSeverity },
  // Local Guide / Hidden Gems
  GEM_VERIFIED_BY_GUIDE:    { category: "guide_accuracy" as TrustCategory,  delta: 4,  severity: "minor" as TrustSeverity },

  /** Emitted when a user completes Portava Verified (id or id_selfie tier). */
  IDENTITY_VERIFIED:        { category: "respect_safety" as TrustCategory,  delta: 10, severity: "minor" as TrustSeverity },
  GEM_DISPUTED:             { category: "guide_accuracy" as TrustCategory,  delta: -5, severity: "moderate" as TrustSeverity },
  // Passport
  STAMP_VERIFIED:           { category: "passport_authenticity" as TrustCategory, delta: 3,  severity: "minor" as TrustSeverity },
  STAMP_DISPUTED:           { category: "passport_authenticity" as TrustCategory, delta: -6, severity: "moderate" as TrustSeverity },
  // Reviews & Appeals
  REVIEW_SUBMITTED:         { category: "community_value" as TrustCategory,  delta: 2,  severity: "minor" as TrustSeverity },
  APPEAL_APPROVED_REVERSAL: { category: "community_value" as TrustCategory,  delta: 2,  severity: "minor" as TrustSeverity },
  // Events
  EVENT_HOSTED:             { category: "host_quality" as TrustCategory,     delta: 5,  severity: "minor" as TrustSeverity },
  EVENT_ATTENDED:           { category: "plan_attendance" as TrustCategory,  delta: 5,  severity: "minor" as TrustSeverity },
  EVENT_HOST_CANCELLED:     { category: "host_quality" as TrustCategory,     delta: -8, severity: "moderate" as TrustSeverity },
  EVENT_HOST_NO_SHOW:       { category: "host_quality" as TrustCategory,     delta: -15, severity: "serious" as TrustSeverity },
  EVENT_ATTENDEE_NO_SHOW:   { category: "plan_attendance" as TrustCategory,  delta: -5, severity: "minor" as TrustSeverity },
  EVENT_POSITIVE_REVIEW:    { category: "host_quality" as TrustCategory,     delta: 3,  severity: "minor" as TrustSeverity },
  EVENT_NEGATIVE_REVIEW:    { category: "host_quality" as TrustCategory,     delta: -6, severity: "moderate" as TrustSeverity },
} as const;
