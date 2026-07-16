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
import { resolveOrEnqueue } from "../../lib/stamps/StampCatalogService.js";
import { canonicalLocationKeyFromStrings } from "../../lib/stamps/locationKey.js";
import { resolveCountry } from "../../lib/stamps/countryLookup.js";

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

const INVALID_TRIP_STATUSES   = new Set(["cancelled", "draft", "deleted"]);
const INVALID_POST_STATUSES   = new Set(["draft", "deleted", "removed", "revoked"]);
const INVALID_EVENT_STATUSES  = new Set(["cancelled", "draft", "deleted"]);

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
      const { data } = await sc.from("events").select("status").eq("id", sourceId).maybeSingle();
      if (!data) return { valid: false, reason: "source_not_found" };
      if (INVALID_EVENT_STATUSES.has((data as any).status)) {
        return { valid: false, reason: `source_invalid_status:${(data as any).status}` };
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
    .select("id, slug, stamp_type, is_active, is_repeatable, max_awards_per_user, visibility_default, criteria_type")
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
    let stampQuery = sc
      .from("user_stamps")
      .select("id")
      .eq("user_id", userId)
      .eq("stamp_definition_id", definition.id)
      .eq("source_type", sourceType)
      .eq("is_revoked", false);

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
    // A unique-constraint violation in the recovery path means a concurrent process
    // already inserted the missing stamp — treat as a successful heal.
    if (skipToStampInsert && (stampErr as any).code === "23505") {
      return { awarded: false, reason: "already_awarded" };
    }
    return { awarded: false, reason: `stamp_insert_failed: ${stampErr.message}` };
  }

  const newStampId = (stampRow as any).id;

  // 7b. Fire-and-forget: resolve universal catalog entry for this stamp location.
  // This never blocks the award or throws — any failure is logged and ignored.
  Promise.resolve().then(async () => {
    try {
      // Real ISO code only — never abbreviated from the country's spelling.
      const countryCode = resolvedCountry.countryCode;

      const displayName = city ?? country ?? definitionSlug;
      // Use the definition's actual stamp_type column — never infer from slug.
      // Fall back to "city" only if the row somehow lacks the field.
      const defType: string = (definition as any).stamp_type ?? "city";

      const canonKey = canonicalLocationKeyFromStrings({
        stampType: defType,
        country,
        city,
      });

      const { catalogEntry } = await resolveOrEnqueue(
        sc,
        {
          stampType:    defType,
          country:      country ?? "Unknown",
          country_code: countryCode,
          city:         city ?? null,
          displayName,
        },
        defType,
        `user_stamp:${newStampId}`,
      );

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
    // Read current count, increment, and upsert — wrapped in a real Promise so .catch() is valid.
    Promise.resolve().then(async () => {
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
  const { data, error } = await sc
    .from("user_stamps")
    .update({
      is_revoked:     true,
      revoked_at:     new Date().toISOString(),
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
    idempotency_key:     `revoke:${userStampId}:${Date.now()}`,
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
    idempotency_key:     `restore:${userStampId}:${Date.now()}`,
    status:              "restored",
    admin_id:            adminId,
  });

  if (auditErr) {
    // Roll back the restore to keep data consistent
    await sc
      .from("user_stamps")
      .update({
        is_revoked:     true,
        revoked_at:     new Date().toISOString(),
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
    .select("id, slug, name, is_active, is_repeatable, max_awards_per_user, criteria_type")
    .eq("slug", definitionSlug)
    .maybeSingle();

  if (!def) return { eligible: false, reason: "definition_not_found" };

  const definition = def as any;

  if (!definition.is_active) return { eligible: false, reason: "definition_inactive", definition };

  // Validate source state
  const sourceCheck = await validateSource(sc, sourceType, sourceId);
  if (!sourceCheck.valid) return { eligible: false, reason: sourceCheck.reason, definition };

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

  // Load existing non-revoked user_stamps.
  // For repeatable stamps we must reconcile by event, not just definition_id.
  // We track both the set of (source_type, source_id) pairs per definition AND
  // a count per definition to detect missing repeatable rows.
  const { data: existingStamps } = await sc
    .from("user_stamps")
    .select("id, stamp_definition_id, source_type, source_id")
    .eq("user_id", userId)
    .eq("is_revoked", false);

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
        .select("id, is_active, visibility_default, is_repeatable")
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

    // Re-create the missing user_stamp
    const { error: insertErr } = await sc.from("user_stamps").insert({
      user_id:             userId,
      stamp_definition_id: event.stamp_definition_id,
      source_type:         event.source_type,
      source_id:           event.source_id,
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
