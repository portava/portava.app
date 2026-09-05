/**
 * StampAwardEngine
 *
 * Server-side only. Never trust client-supplied eligibility.
 *
 * awardStamp       — idempotent award via (user_id:def_id:source_type:source_id) key
 * revokeStamp      — sets is_revoked + writes required audit event (fails if audit write fails)
 * restoreStamp     — clears is_revoked + writes required audit event (fails if audit write fails)
 * checkEligibility — dry-run without inserting
 * recalculateForUser — idempotent re-sync: ensures user_stamps match stamp_award_events
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Logger } from "pino";
import { resolveOrEnqueue, resolveOrEnqueueForDefinition } from "../../lib/stamps/StampCatalogService.js";
import { resolveCountry } from "../../lib/stamps/countryLookup.js";
import { resolveCountryWithGeocoding } from "../../lib/stamps/countryGeocoder.js";
import { criteriaGate } from "../../lib/stamps/criteria/index.js";
import { isFlagEnabled } from "../../lib/featureFlags.js";
import { recordPassportEvent } from "../../lib/passportTelemetry.js";

/**
 * §12/TABLE 16 provenance tier for a StampAwardEngine award. Everything the
 * engine awards is server-derived (trip/event/contribution/system/admin/…) and
 * therefore a VERIFIED travel fact — never a client self-reported decorative
 * badge, which flows through a different path. Only an explicitly self-reported
 * source is downgraded to 'reported'. Drives whether a `stamp_verified` §32
 * event fires alongside `stamp_issued`.
 */
const SELF_REPORTED_SOURCES = new Set(["self_reported", "self", "decorative"]);
function stampVerificationTier(sourceType: string): "verified" | "reported" {
  return SELF_REPORTED_SOURCES.has(String(sourceType).trim().toLowerCase()) ? "reported" : "verified";
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AwardInput {
  userId: string;
  definitionSlug: string;
  sourceType?: string;
  sourceId?: string;
  city?: string;
  country?: string;
  lat?: number;
  lng?: number;
  metadata?: Record<string, unknown>;
  awardReason?: string;
  adminId?: string;
  /**
   * Context metrics for the criteria engine (Wave 3): ground-truth values for
   * THIS action that can't be aggregated from tables (e.g. trip_member_count,
   * is_solo_trip). Ignored unless the definition has authored criteria and the
   * criteria engine flag is on. Optional — DB metrics resolve without it.
   */
  criteriaContext?: Record<string, number | boolean>;
}

export interface AwardResult {
  awarded: boolean;
  reason: string;
  userStampId?: string;
}

export interface EligibilityResult {
  eligible: boolean;
  reason: string;
  definition?: Record<string, unknown>;
}

export type StampLogger = Pick<Logger, "warn">;

// ── Source-state validation ───────────────────────────────────────────────────
// Checks that the triggering source entity is in an award-eligible state.
// Revoked/cancelled/draft source objects must be rejected.

//
// ⚠ EVERY literal below must be a real label of the corresponding Postgres
// enum, or the membership test can never fire and the guard silently passes an
// ineligible source through. The sets are the COMPLEMENT of the award-eligible
// states, derived from the enums in baseline/20260819_baseline_structure.sql:
//
//   trip_status  = draft | planning | upcoming | active | completed | cancelled | archived
//   post_status  = active | hidden | reported | deleted
//   event_state  = draft | open | full | waitlist | started | completed | cancelled | archived
//
// Before this was derived from the enums the sets carried three labels that no
// column can ever hold — `deleted` for trips and events, and `draft`/`removed`/
// `revoked` for posts — while omitting states that really are ineligible
// (`archived` trips and events; `hidden` and `reported` posts, which
// routes/posts.ts:1100 already documents as not-live content). Guarded by
// stampSourceStatusTruth.test.ts.
export const INVALID_TRIP_STATUSES  = new Set(["draft", "cancelled", "archived"]);
export const INVALID_POST_STATUSES  = new Set(["hidden", "reported", "deleted"]);
export const INVALID_EVENT_STATUSES = new Set(["draft", "cancelled", "archived"]);

async function validateSource(
  sc: SupabaseClient,
  sourceType: string,
  sourceId: string,
): Promise<{ valid: boolean; reason: string }> {
  if (!sourceId || sourceId === "none") return { valid: true, reason: "no_source_required" };

  try {
    if (sourceType === "trips") {
      const { data } = await sc.from("trips").select("status").eq("id", sourceId).maybeSingle();
      if (!data) return { valid: false, reason: "source_not_found" };
      if (INVALID_TRIP_STATUSES.has((data as any).status)) {
        return { valid: false, reason: `source_invalid_status:${(data as any).status}` };
      }
    } else if (sourceType === "posts") {
      const { data } = await sc.from("posts").select("status").eq("id", sourceId).maybeSingle();
      if (!data) return { valid: false, reason: "source_not_found" };
      if (INVALID_POST_STATUSES.has((data as any).status)) {
        return { valid: false, reason: `source_invalid_status:${(data as any).status}` };
      }
    } else if (sourceType === "events") {
      const { data } = await sc.from("events").select("state").eq("id", sourceId).maybeSingle();
      if (!data) return { valid: false, reason: "source_not_found" };
      if (INVALID_EVENT_STATUSES.has((data as any).state)) {
        return { valid: false, reason: `source_invalid_status:${(data as any).state}` };
      }
    }
    // Unknown source types (admin, system, recalculate, safe_return, rent_buddy)
    // pass through — their validation is caller-responsibility.
  } catch {
    // DB read failure → fail-closed (reject the award)
    return { valid: false, reason: "source_validation_failed" };
  }

  return { valid: true, reason: "ok" };
}

// ── Idempotency key ───────────────────────────────────────────────────────────

function buildIdempotencyKey(
  userId: string,
  definitionId: string,
  sourceType: string,
  sourceId: string,
): string {
  return `${userId}:${definitionId}:${sourceType}:${sourceId}`;
}

// ── Core award ────────────────────────────────────────────────────────────────

const WARN_REASONS = new Set([
  "feature_disabled",
  "definition_not_found",
  "source_validation_failed",
]);

async function _awardStampCore(
  sc: SupabaseClient,
  input: AwardInput,
): Promise<AwardResult> {
  // 0a. Fail-closed: stamp_system_v2_enabled must be explicitly true.
  // An absent row (migration not yet applied) is treated as disabled to avoid
  // crashing against non-existent tables. This mirrors the HTTP-router guard in
  // stamps.ts so that direct engine calls (e.g. awardTripCompletionStamps) are
  // also protected and cannot silently skip stamps.
  try {
    const { data: v2Flag } = await sc
      .from("feature_flags")
      .select("enabled")
      .eq("flag", "stamp_system_v2_enabled")
      .maybeSingle();
    if (v2Flag?.enabled !== true) {
      return { awarded: false, reason: "feature_disabled" };
    }
  } catch {
    // DB unavailable — fail-closed: do not award
    return { awarded: false, reason: "feature_disabled" };
  }

  // 0b. Global kill-switch: passport_stamps_enabled
  // Fail-open: if the feature_flags table is missing (dev / unmigrated) or the
  // row doesn't exist, the award proceeds so stamps work out-of-box without any
  // DB setup. Only an explicit `enabled = false` row suppresses all awards.
  try {
    const { data: flagRow } = await sc
      .from("feature_flags")
      .select("enabled")
      .eq("flag", "passport_stamps_enabled")
      .maybeSingle();
    if (flagRow !== null && (flagRow as any).enabled === false) {
      return { awarded: false, reason: "feature_disabled" };
    }
  } catch {
    // Fail-open: table might not exist in dev / before migrations are applied
  }

  const {
    userId,
    definitionSlug,
    sourceType = "system",
    sourceId = "none",
    city,
    country: rawCountry,
    lat,
    lng,
    metadata,
    awardReason,
    adminId,
  } = input;

  // Resolve real country info up front: if the caller passed only a city
  // (production trips often lack country), derive the country from a
  // well-known-city lookup so the stamp row and its canonical catalog key are
  // written with a *real* country code instead of "XX" or a spelling guess.
  const resolvedCountry = resolveCountry({ country: rawCountry, city });
  const country = rawCountry ?? resolvedCountry.country ?? undefined;

  // 1. Load definition
  const { data: def, error: defErr } = await sc
    .from("stamp_definitions")
    .select("id, slug, name, stamp_type, is_active, is_repeatable, max_awards_per_user, visibility_default, criteria_type, criteria")
    .eq("slug", definitionSlug)
    .maybeSingle();

  if (defErr || !def) {
    return { awarded: false, reason: "definition_not_found" };
  }

  const definition = def as any;

  if (!definition.is_active) {
    return { awarded: false, reason: "definition_inactive" };
  }

  // 2. Validate source-object state (reject revoked/cancelled/draft sources)
  const sourceCheck = await validateSource(sc, sourceType, sourceId);
  if (!sourceCheck.valid) {
    return { awarded: false, reason: sourceCheck.reason };
  }

  // 2b. Criteria engine gate (Wave 3, additive + flag-gated). Only bites when
  // the definition has authored `criteria` AND stamp_criteria_engine_enabled
  // is on; otherwise a no-op (legacy hard-coded award sites remain authority).
  const gate = await criteriaGate(sc, userId, definition, { context: input.criteriaContext });
  if (gate.blocked) {
    return { awarded: false, reason: gate.reason ?? "criteria_not_met" };
  }

  const idemKey = buildIdempotencyKey(userId, definition.id, sourceType, sourceId);

  // 3. Check idempotency — has this exact event already been awarded?
  const { data: existingEvent } = await sc
    .from("stamp_award_events")
    .select("id, status")
    .eq("idempotency_key", idemKey)
    .maybeSingle();

  // Recovery path: if the award event was committed but the user_stamp row is
  // missing (e.g. the DB went down between step 6 and step 7), skip directly to
  // the stamp insertion to heal the partial failure rather than returning
  // already_awarded with a missing passport row.
  //
  // For repeatable stamps we must match by (source_type, source_id) — not just
  // definition_id — so that an existing stamp from a different source does not
  // mask a missing stamp for this event's specific source.
  let skipToStampInsert = false;
  if (existingEvent && (existingEvent as any).status === "awarded") {
    const resolvedSourceId = sourceId !== "none" ? sourceId : null;
    // Match ANY stamp row for this event, revoked or not. The heal exists to
    // recover a PARTIAL failure (event committed, stamp insert crashed) — a
    // revoked row is not that: it means the stamp was fully awarded and then an
    // admin revoked it, so "healing" it would silently resurrect a revoked stamp.
    let stampQuery = sc
      .from("user_stamps")
      .select("id")
      .eq("user_id", userId)
      .eq("stamp_definition_id", definition.id)
      .eq("source_type", sourceType);

    // Use .is() for null comparisons; .eq() translates to = null which is always false in SQL.
    stampQuery = resolvedSourceId === null
      ? (stampQuery as any).is("source_id", null)
      : (stampQuery as any).eq("source_id", resolvedSourceId);

    const { data: existingStampForEvent } = await (stampQuery as any).maybeSingle();

    if (existingStampForEvent) {
      return { awarded: false, reason: "already_awarded" };
    }
    // Event row is committed but stamp row is missing — heal it.
    skipToStampInsert = true;
  }

  if (!skipToStampInsert) {
    // 4. For non-repeatable stamps: check if user already has one
    if (!definition.is_repeatable) {
      const { data: existingStamp } = await sc
        .from("user_stamps")
        .select("id")
        .eq("user_id", userId)
        .eq("stamp_definition_id", definition.id)
        .eq("is_revoked", false)
        .maybeSingle();

      if (existingStamp) {
        return { awarded: false, reason: "already_earned" };
      }
    }

    // 5. For repeatable stamps: check max_awards_per_user cap
    if (definition.is_repeatable && definition.max_awards_per_user != null) {
      const { count } = await sc
        .from("user_stamps")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("stamp_definition_id", definition.id)
        .eq("is_revoked", false);

      if ((count ?? 0) >= definition.max_awards_per_user) {
        return { awarded: false, reason: "max_awards_reached" };
      }
    }

    // 6. Insert award event (with idempotency key)
    const { error: eventErr } = await sc.from("stamp_award_events").insert({
      user_id:             userId,
      stamp_definition_id: definition.id,
      source_type:         sourceType,
      source_id:           sourceId !== "none" ? sourceId : null,
      award_reason:        awardReason ?? null,
      criteria_snapshot:   metadata ?? null,
      idempotency_key:     idemKey,
      status:              "awarded",
      admin_id:            adminId ?? null,
    });

    if (eventErr) {
      // Concurrent insert hit the unique constraint — treat as already awarded
      if ((eventErr as any).code === "23505") {
        return { awarded: false, reason: "already_awarded" };
      }
      return { awarded: false, reason: `event_insert_failed: ${eventErr.message}` };
    }
  }

  // 7. Insert user_stamp row (with exponential-backoff retry for transient failures).
  // If the DB goes down after step 6 commits the award event, up to 3 attempts are
  // made before giving up. On the next call to awardStamp with the same input the
  // recovery path above (skipToStampInsert) will attempt the insert again, so no
  // stamp is permanently lost.
  const STAMP_INSERT_MAX_ATTEMPTS = 3;
  let stampRow: any = null;
  let stampErr: any = null;
  for (let attempt = 0; attempt < STAMP_INSERT_MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      // Exponential backoff: 100 ms, 200 ms
      await new Promise<void>((r) => setTimeout(r, 100 * 2 ** (attempt - 1)));
    }
    const result = await sc
      .from("user_stamps")
      .insert({
        user_id:             userId,
        stamp_definition_id: definition.id,
        source_type:         sourceType,
        source_id:           sourceId !== "none" ? sourceId : null,
        city:                city ?? null,
        country:             country ?? null,
        lat:                 lat ?? null,
        lng:                 lng ?? null,
        metadata:            metadata ?? null,
        visibility:          definition.visibility_default ?? "public",
        display_on_passport: true,
        is_revoked:          false,
        awarded_by_admin_id: adminId ?? null,
      })
      .select("id")
      .single();
    stampRow = result.data;
    stampErr = result.error;
    if (!stampErr) break;
    // Do not retry unique-constraint violations — not transient.
    if ((stampErr as any).code === "23505") break;
  }

  if (stampErr) {
    // Unique-constraint violation (user_stamps_live_award_unique, migration 2072):
    // a concurrent process already inserted this stamp.
    //  - In the recovery path this means the missing stamp was healed elsewhere.
    //  - In the fresh-award path it means a concurrent award of the same
    //    (user, definition, source) won the race — the stamp is already earned.
    if ((stampErr as any).code === "23505") {
      return {
        awarded: false,
        reason: skipToStampInsert ? "already_awarded" : "already_earned",
      };
    }
    return { awarded: false, reason: `stamp_insert_failed: ${stampErr.message}` };
  }

  const newStampId = (stampRow as any).id;

  // 7b. Fire-and-forget: resolve universal catalog entry for this stamp location.
  // This never blocks the award or throws — any failure is logged and ignored.
  Promise.resolve().then(async () => {
    try {
      // Real ISO code only — never abbreviated from the country's spelling.
      // When the static lookup can't resolve the city, fall back to geocoding
      // (cached, rate-limited) so smaller cities also get a real code instead
      // of "XX". Geocoding failures still leave "XX" — never guessed.
      let countryCode = resolvedCountry.countryCode;
      let catalogCountry = country;
      if (countryCode === "XX" && (city || (lat != null && lng != null))) {
        const geocoded = await resolveCountryWithGeocoding({
          country: rawCountry, city, lat, lng,
        });
        if (geocoded.countryCode !== "XX") {
          countryCode    = geocoded.countryCode;
          catalogCountry = catalogCountry ?? geocoded.country ?? undefined;
          // Backfill the stamp row's country so ownership data matches.
          if (!country && geocoded.country) {
            await sc
              .from("user_stamps")
              .update({ country: geocoded.country })
              .eq("id", newStampId);
          }
        }
      }

      const displayName = city ?? catalogCountry ?? definitionSlug;
      // Use the definition's actual stamp_type column — never infer from slug.
      // Fall back to "city" only if the row somehow lacks the field.
      const defType: string = (definition as any).stamp_type ?? "city";

      let catalogEntry;
      if (!city && !catalogCountry) {
        // Location-less stamp (badge / social / safety / trip achievement):
        // resolve a definition-scoped catalog entry ("definition:{slug}") so
        // every award of this definition shares one entry and one artwork —
        // same behaviour as the reconciliation script.
        ({ catalogEntry } = await resolveOrEnqueueForDefinition(
          sc,
          { slug: definition.slug, name: definition.name ?? null, stamp_type: defType },
          `user_stamp:${newStampId}`,
        ));
      } else {
        ({ catalogEntry } = await resolveOrEnqueue(
          sc,
          {
            stampType:    defType,
            country:      catalogCountry ?? "Unknown",
            country_code: countryCode,
            city:         city ?? null,
            displayName,
          },
          defType,
          `user_stamp:${newStampId}`,
        ));
      }

      // Back-fill catalog_id on the newly inserted user_stamp row
      if (catalogEntry?.id) {
        await sc
          .from("user_stamps")
          .update({ catalog_id: catalogEntry.id })
          .eq("id", newStampId);

        console.log(JSON.stringify({
          event:      "stamp.award.catalog_linked",
          stamp_id:   newStampId,
          catalog_id: catalogEntry.id,
        }));
      }
    } catch (e: any) {
      console.error(JSON.stringify({
        event:    "stamp.award.catalog_link_failed",
        stamp_id: newStampId,
        error:    e?.message ?? String(e),
      }));
    }
  }).catch(() => {});

  // 8. Update stamp_progress for repeatable stamps (fire-and-forget, non-fatal)
  if (definition.is_repeatable) {
    // Atomic DB-side increment (migration 2071) — the previous read-modify-write
    // lost increments under concurrency. Wrapped in a real Promise so .catch() is valid.
    Promise.resolve().then(async () => {
      const { error: rpcErr } = await sc.rpc("increment_stamp_progress", {
        p_user_id:        userId,
        p_definition_id:  definition.id,
      });
      if (!rpcErr) return;

      // PGRST202 = function not found (migration 2071 not applied yet).
      // Degrade to the legacy read-modify-write upsert so progress still moves.
      // Any OTHER RPC failure means a progress increment was silently lost —
      // log it before bailing so the gap is visible in ops, not invisible.
      if ((rpcErr as any).code !== "PGRST202") {
        console.error(JSON.stringify({
          event:         "stamp.progress.increment_rpc_failed",
          user_id:       userId,
          definition_id: definition.id,
          code:          (rpcErr as any).code ?? null,
          error:         (rpcErr as any).message ?? String(rpcErr),
        }));
        return;
      }

      const { data: prog } = await sc
        .from("stamp_progress")
        .select("progress_count")
        .eq("user_id", userId)
        .eq("stamp_definition_id", definition.id)
        .maybeSingle();

      const newCount = ((prog as any)?.progress_count ?? 0) + 1;

      await sc
        .from("stamp_progress")
        .upsert(
          {
            user_id:             userId,
            stamp_definition_id: definition.id,
            progress_count:      newCount,
            updated_at:          new Date().toISOString(),
          },
          { onConflict: "user_id,stamp_definition_id" },
        );
    }).catch(() => {});
  }

  // 9. Fire-and-forget: check stamp milestones (100 / 1,000 / 10,000).
  // Inserts a stamp_milestones row and sends a push notification when a new
  // threshold is crossed.  Never blocks the award — all errors are logged then
  // swallowed so a DB hiccup never prevents the stamp from being recorded.
  Promise.resolve().then(async () => {
    let activeLevel: number | undefined;
    try {
      const MILESTONE_LEVELS = [10000, 1000, 100] as const;

      const { count: totalCount } = await sc
        .from("user_stamps")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("is_revoked", false);

      const total = totalCount ?? 0;

      for (const level of MILESTONE_LEVELS) {
        activeLevel = level;
        if (total < level) continue;

        // Check if this milestone was already recorded
        const { data: existing } = await sc
          .from("stamp_milestones")
          .select("user_id")
          .eq("user_id", userId)
          .eq("milestone_level", level)
          .maybeSingle();

        if (existing) break; // highest already-recorded milestone — nothing new

        // Insert new milestone row (ON CONFLICT DO NOTHING for safety)
        const { error: insertErr } = await sc
          .from("stamp_milestones")
          .insert({ user_id: userId, milestone_level: level });

        // If the insert failed for ANY reason — including 23505 (unique violation from a
        // concurrent award that raced past our select check) — do not send a push.  The
        // concurrent winner is responsible for delivering the notification.
        if (insertErr) break;

        // Fire push notification — only reached when we were the first to insert this milestone row.
        const { data: profileRow } = await sc
          .from("profiles")
          .select("expo_push_token")
          .eq("id", userId)
          .maybeSingle();

        const token = (profileRow as any)?.expo_push_token as string | null | undefined;
        if (token) {
          // Honor the global push_notifications_enabled gate before dispatching
          // the milestone push. isFlagEnabled returns false on DB error, which
          // suppresses the push conservatively — consistent with the other two
          // sendPushNotification call sites (pushWithRetry, NotificationRouter).
          if (!(await isFlagEnabled(sc, "push_notifications_enabled"))) {
            break;
          }
          const milestoneLabel =
            level >= 10000 ? "10,000" : level >= 1000 ? "1,000" : "100";
          const { sendPushNotification } = await import("../../lib/push.js");
          await sendPushNotification([token], {
            title: `${milestoneLabel} Stamps! ✨`,
            body: `You've earned ${milestoneLabel} Stamps on Portava. Keep exploring!`,
            data: { type: "stamp_milestone", level: String(level) },
          }).catch(() => {});
        }

        break; // only process the highest newly-crossed milestone per award
      }
    } catch (e: any) {
      // non-fatal: never block the award result, but surface the failure so it
      // appears in API-server workflow logs rather than disappearing silently.
      console.error(JSON.stringify({
        event:           "stamp.award.milestone_failed",
        user_id:         userId,
        milestone_level: activeLevel ?? null,
        error:           e?.message ?? String(e),
      }));
    }
  }).catch(() => {});

  // §32 telemetry: the stamp was issued (and, for a verified-provenance award,
  // verified). Fire-and-forget through the server telemetry sink — flag-gated
  // OFF, payload allow-listed, and it can never block or fail the award. Emitted
  // only on a genuine fresh award (this return), never on the already-earned /
  // recovery no-op paths above. `void` so the award result is not awaited on it.
  {
    const tier = stampVerificationTier(sourceType);
    const evtPayload = {
      source: sourceType,
      verification: tier,
      stamp_type: (definition as any).stamp_type ?? null,
      city: city ?? null,
      country: country ?? null,
    };
    void recordPassportEvent(sc, {
      event: "stamp_issued",
      actorId: userId,
      subjectId: newStampId,
      payload: evtPayload,
    });
    if (tier === "verified") {
      void recordPassportEvent(sc, {
        event: "stamp_verified",
        actorId: userId,
        subjectId: newStampId,
        payload: evtPayload,
      });
    }
  }

  return {
    awarded: true,
    reason: "awarded",
    userStampId: newStampId,
  };
}

export async function awardStamp(
  sc: SupabaseClient,
  input: AwardInput,
  log?: StampLogger,
): Promise<AwardResult> {
  const result = await _awardStampCore(sc, input);
  if (!result.awarded && log && WARN_REASONS.has(result.reason)) {
    log.warn(
      { userId: input.userId, definitionSlug: input.definitionSlug, reason: result.reason },
      "awardStamp: skipped",
    );
  }
  return result;
}

// ── Revoke ────────────────────────────────────────────────────────────────────
// IMPORTANT: Audit event write is required. Revoke fails if the audit write fails.

export async function revokeStamp(
  sc: SupabaseClient,
  userStampId: string,
  adminId: string,
  reason: string,
): Promise<{ revoked: boolean; reason: string }> {
  const nowMs = Date.now();
  const { data, error } = await sc
    .from("user_stamps")
    .update({
      is_revoked:     true,
      revoked_at:     new Date(nowMs).toISOString(),
      revoked_reason: reason,
    })
    .eq("id", userStampId)
    .eq("is_revoked", false)
    .select("id, user_id, stamp_definition_id")
    .maybeSingle();

  if (error) return { revoked: false, reason: error.message };
  if (!data) return { revoked: false, reason: "not_found_or_already_revoked" };

  const row = data as any;

  // Write required audit event. Failure here is fatal — revoke should not silently succeed
  // without an audit trail.
  const { error: auditErr } = await sc.from("stamp_award_events").insert({
    user_id:             row.user_id,
    stamp_definition_id: row.stamp_definition_id,
    source_type:         "admin",
    source_id:           null,
    award_reason:        reason,
    idempotency_key:     `revoke:${userStampId}:${nowMs}`,
    status:              "revoked",
    admin_id:            adminId,
  });

  if (auditErr) {
    // Roll back the revoke to keep data consistent
    await sc
      .from("user_stamps")
      .update({ is_revoked: false, revoked_at: null, revoked_reason: null })
      .eq("id", userStampId);
    return { revoked: false, reason: `audit_write_failed: ${auditErr.message}` };
  }

  // Charge the adjudicated finding: an admin has determined this stamp was not
  // legitimately earned. STAMP_DISPUTED was declared in TRUST_EVENT_TYPES and
  // emitted by nothing, so a revoked stamp cost its owner zero trust — while its
  // positive sibling (STAMP_VERIFIED) was wired.
  //
  // Emitted here rather than in the route so every caller of revokeStamp is
  // covered, and because row.user_id is only available at this level. Keyed on
  // userStampId so one revocation charges once, and fire-and-forget so trust
  // bookkeeping can never undo a completed revocation.
  //
  // Severity is moderate, so this applies immediately and imposes no ceiling —
  // this is the one adjudicated event that needs no auto-confirm.
  try {
    const { recordAdjudicatedTrustEvent, TRUST_EVENT_TYPES } =
      await import("../trust/TrustEventService.js");
    const t = TRUST_EVENT_TYPES.STAMP_DISPUTED;
    void recordAdjudicatedTrustEvent(sc, adminId, {
      userId: row.user_id,
      eventType: "stamp_disputed",
      category: t.category,
      delta: t.delta,
      severity: t.severity,
      sourceType: "moderation",
      sourceId: userStampId,
      dedupWindowHours: 24 * 365,
      metadata: { userStampId, stampDefinitionId: row.stamp_definition_id, reason },
    }).catch(() => {});
  } catch { /* non-fatal */ }

  return { revoked: true, reason: "revoked" };
}

// ── Restore ───────────────────────────────────────────────────────────────────
// IMPORTANT: Audit event write is required. Restore fails if the audit write fails.

export async function restoreStamp(
  sc: SupabaseClient,
  userStampId: string,
  adminId: string,
  reason: string,
): Promise<{ restored: boolean; reason: string }> {
  const nowMs = Date.now();
  const { data, error } = await sc
    .from("user_stamps")
    .update({
      is_revoked:     false,
      revoked_at:     null,
      revoked_reason: null,
    })
    .eq("id", userStampId)
    .eq("is_revoked", true)
    .select("id, user_id, stamp_definition_id")
    .maybeSingle();

  if (error) return { restored: false, reason: error.message };
  if (!data) return { restored: false, reason: "not_found_or_not_revoked" };

  const row = data as any;

  // Write required audit event. Failure here is fatal.
  const { error: auditErr } = await sc.from("stamp_award_events").insert({
    user_id:             row.user_id,
    stamp_definition_id: row.stamp_definition_id,
    source_type:         "admin",
    source_id:           null,
    award_reason:        reason,
    idempotency_key:     `restore:${userStampId}:${nowMs}`,
    status:              "restored",
    admin_id:            adminId,
  });

  if (auditErr) {
    // Roll back the restore to keep data consistent
    await sc
      .from("user_stamps")
      .update({
        is_revoked:     true,
        revoked_at:     new Date(nowMs).toISOString(),
        revoked_reason: "auto-rollback: audit write failed during restore",
      })
      .eq("id", userStampId);
    return { restored: false, reason: `audit_write_failed: ${auditErr.message}` };
  }

  return { restored: true, reason: "restored" };
}

// ── Eligibility check (dry-run) ───────────────────────────────────────────────

export async function checkEligibility(
  sc: SupabaseClient,
  userId: string,
  definitionSlug: string,
  sourceType = "system",
  sourceId = "none",
): Promise<EligibilityResult> {
  const { data: def } = await sc
    .from("stamp_definitions")
    .select("id, slug, name, is_active, is_repeatable, max_awards_per_user, criteria_type, criteria")
    .eq("slug", definitionSlug)
    .maybeSingle();

  if (!def) return { eligible: false, reason: "definition_not_found" };

  const definition = def as any;

  if (!definition.is_active) return { eligible: false, reason: "definition_inactive", definition };

  // Validate source state
  const sourceCheck = await validateSource(sc, sourceType, sourceId);
  if (!sourceCheck.valid) return { eligible: false, reason: sourceCheck.reason, definition };

  // Criteria engine gate (Wave 3) — additive, flag-gated, no-op when the
  // definition has no authored criteria or the engine flag is off.
  const gate = await criteriaGate(sc, userId, definition);
  if (gate.blocked) return { eligible: false, reason: gate.reason ?? "criteria_not_met", definition };

  const idemKey = buildIdempotencyKey(userId, definition.id, sourceType, sourceId);

  const { data: existingEvent } = await sc
    .from("stamp_award_events")
    .select("id, status")
    .eq("idempotency_key", idemKey)
    .maybeSingle();

  if (existingEvent && (existingEvent as any).status === "awarded") {
    return { eligible: false, reason: "already_awarded", definition };
  }

  if (!definition.is_repeatable) {
    const { data: existingStamp } = await sc
      .from("user_stamps")
      .select("id")
      .eq("user_id", userId)
      .eq("stamp_definition_id", definition.id)
      .eq("is_revoked", false)
      .maybeSingle();

    if (existingStamp) return { eligible: false, reason: "already_earned", definition };
  }

  if (definition.is_repeatable && definition.max_awards_per_user != null) {
    const { count } = await sc
      .from("user_stamps")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("stamp_definition_id", definition.id)
      .eq("is_revoked", false);

    if ((count ?? 0) >= definition.max_awards_per_user) {
      return { eligible: false, reason: "max_awards_reached", definition };
    }
  }

  return { eligible: true, reason: "eligible", definition };
}

// ── Recalculate (idempotent) ──────────────────────────────────────────────────
// Re-syncs user_stamps against stamp_award_events with status='awarded'.
// Each award event is identified by its idempotency_key. If an event has no
// corresponding user_stamp (after a partial failure), this re-creates the row.
//
// Repeatable stamps: each awarded event maps to its own user_stamp row.
// The idempotency_key is used as the reconciliation anchor so multiple awards
// of the same repeatable definition each produce a separate stamp (not one).
//
// This is fully idempotent — running it multiple times produces the same result.

export async function recalculateForUser(
  sc: SupabaseClient,
  userId: string,
): Promise<{ checked: number; awarded: number; skipped: number }> {
  // Load all awarded events for this user (including idempotency_key as anchor)
  const { data: events } = await sc
    .from("stamp_award_events")
    .select("id, idempotency_key, stamp_definition_id, source_type, source_id, award_reason, admin_id")
    .eq("user_id", userId)
    .eq("status", "awarded");

  if (!events || events.length === 0) return { checked: 0, awarded: 0, skipped: 0 };

  // Load existing user_stamps — INCLUDING revoked ones. Revoked rows must count
  // as "already exists" so a stamp an admin revoked is not treated as "missing"
  // and silently re-inserted by recalc: the awarded event survives revocation, so
  // filtering to is_revoked=false here let any user resurrect their own revoked
  // stamps via POST /stamps/recalculate/me (the partial live-unique index does not
  // collide with the revoked row, so the insert would succeed).
  // For repeatable stamps we reconcile by event (source_type, source_id) pair;
  // for non-repeatable, by definition_id.
  const { data: existingStamps } = await sc
    .from("user_stamps")
    .select("id, stamp_definition_id, source_type, source_id, is_revoked")
    .eq("user_id", userId);

  // Build a key set: "defId:sourceType:sourceId" → allows idempotent check per event
  const existingKeys = new Set(
    ((existingStamps ?? []) as any[]).map(
      (s: any) => `${s.stamp_definition_id}:${s.source_type ?? ""}:${s.source_id ?? ""}`,
    ),
  );

  // Also track definition_id → count for non-repeatable de-dup
  const existingDefIds = new Set(
    ((existingStamps ?? []) as any[]).map((s: any) => s.stamp_definition_id),
  );

  let awarded = 0;
  let skipped = 0;
  const checked = (events as any[]).length;

  // Cache definitions to avoid redundant DB queries
  const defCache: Map<string, any> = new Map();

  for (const event of events as any[]) {
    const eventKey = `${event.stamp_definition_id}:${event.source_type ?? ""}:${event.source_id ?? ""}`;

    // Load definition (cached)
    let definition = defCache.get(event.stamp_definition_id);
    if (!definition) {
      const { data: def } = await sc
        .from("stamp_definitions")
        .select("id, slug, name, stamp_type, is_active, visibility_default, is_repeatable")
        .eq("id", event.stamp_definition_id)
        .maybeSingle();

      if (!def || !(def as any).is_active) {
        skipped++;
        continue;
      }
      definition = def as any;
      defCache.set(event.stamp_definition_id, definition);
    }

    if (definition.is_repeatable) {
      // Repeatable: reconcile by event-level key (source_type + source_id + def_id)
      if (existingKeys.has(eventKey)) {
        skipped++;
        continue;
      }
    } else {
      // Non-repeatable: one stamp per definition_id maximum
      if (existingDefIds.has(event.stamp_definition_id)) {
        skipped++;
        continue;
      }
    }

    // Resolve the definition-scoped catalog entry up front. Rows re-created
    // here have no location, so they map to "definition:{slug}" — same as the
    // reconciliation script. Resolution failure never blocks the re-insert.
    let catalogId: string | null = null;
    if (definition.slug) {
      try {
        const { catalogEntry } = await resolveOrEnqueueForDefinition(
          sc,
          { slug: definition.slug, name: definition.name ?? null, stamp_type: definition.stamp_type ?? null },
          "recalculate",
        );
        catalogId = catalogEntry?.id ?? null;
      } catch (e: any) {
        console.error(JSON.stringify({
          event: "stamp.recalculate.catalog_link_failed",
          definition_id: event.stamp_definition_id,
          error: e?.message ?? String(e),
        }));
      }
    }

    // Re-create the missing user_stamp
    const { error: insertErr } = await sc.from("user_stamps").insert({
      user_id:             userId,
      stamp_definition_id: event.stamp_definition_id,
      source_type:         event.source_type,
      source_id:           event.source_id,
      catalog_id:          catalogId,
      metadata:            null,
      visibility:          definition.visibility_default ?? "public",
      display_on_passport: true,
      is_revoked:          false,
      awarded_by_admin_id: event.admin_id,
    });

    if (!insertErr) {
      awarded++;
      existingKeys.add(eventKey);
      existingDefIds.add(event.stamp_definition_id);
    } else {
      skipped++;
    }
  }

  return { checked, awarded, skipped };
}
