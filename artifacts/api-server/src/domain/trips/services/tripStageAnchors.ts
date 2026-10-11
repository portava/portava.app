/**
 * Trips v4 §5.1, the two `trips` key columns migration 3768 adds (census-trips
 * TR77): `current_stage_id` and `home_timezone`.
 *
 * WHO WRITES THEM: only the Trip Kernel. START_STAGE sets current_stage_id,
 * COMPLETE_STAGE clears it, and an UPDATE_STAGE `state` patch does the same.
 * REMOVE_STAGE clears it through the foreign key. UPDATE_TRIP sets
 * home_timezone, and the kernel refuses a zone name tzdata does not carry. No
 * server path writes either column directly; the PATCH route refuses
 * `homeTimezone` when the kernel is off rather than fall back to a direct
 * write.
 *
 * WHO READS THEM: this module, the one door. When 3768 is not applied to a
 * database, a select naming the columns fails with Postgres 42703 (PostgREST
 * PGRST204). That case is reported as `available: false`, NOT as an error and
 * NOT as a pair of nulls. A null pointer means "no stage started"; an absent
 * column means "this database cannot say". Callers that degrade (the Today
 * projection falls back to the interval rule) say which reading they used.
 * Any other failure is an error the caller must refuse on.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { isMissingColumnError } from "../../../lib/capability/schemaCapability.js";

export type TripStageAnchors =
  | { available: true; currentStageId: string | null; homeTimezone: string | null }
  | { available: false; reason: "TRIP_STAGE_ANCHORS_NOT_IN_SCHEMA" };

export type TripStageAnchorsRead =
  | { ok: true; anchors: TripStageAnchors }
  | { ok: false; message: string };

/** The select list, a same-file constant (check:write-path-columns resolves it). */
const TRIP_STAGE_ANCHOR_COLUMNS = "current_stage_id, home_timezone";

/**
 * 42703 / PGRST204 that names one of 3768's columns. Any other undefined-column
 * error is a defect somewhere else and is NOT swallowed here.
 */
export function isTripStageAnchorsAbsent(error: unknown): boolean {
  if (!isMissingColumnError(error)) return false;
  const message = String((error as { message?: unknown }).message ?? "");
  return message.includes("current_stage_id") || message.includes("home_timezone");
}

export async function readTripStageAnchors(sc: SupabaseClient, tripId: string): Promise<TripStageAnchorsRead> {
  const { data, error } = await sc.from("trips").select(TRIP_STAGE_ANCHOR_COLUMNS).eq("id", tripId).maybeSingle();
  if (error) {
    if (isTripStageAnchorsAbsent(error)) {
      return { ok: true, anchors: { available: false, reason: "TRIP_STAGE_ANCHORS_NOT_IN_SCHEMA" } };
    }
    return { ok: false, message: String(error.message ?? "trips unreadable") };
  }
  if (!data) return { ok: false, message: "trip not found" };
  const row = data as { current_stage_id?: unknown; home_timezone?: unknown };
  return {
    ok: true,
    anchors: {
      available: true,
      currentStageId: typeof row.current_stage_id === "string" ? row.current_stage_id : null,
      homeTimezone: typeof row.home_timezone === "string" ? row.home_timezone : null,
    },
  };
}

export interface TodayStageRow { id: unknown; starts_at?: string | null; ends_at?: string | null; sequence?: unknown }

/**
 * Which stage Today is in, and the sentence saying why.
 *
 *  1. The STARTED stage (trips.current_stage_id), when 3768 is applied and the
 *     crew started one. An explicit START_STAGE is a canonical fact. It
 *     outranks the interval rule, which cannot see a stage with no times or one
 *     that ran past its planned end.
 *  2. Otherwise the interval rule, unchanged: the stage whose [starts_at,
 *     ends_at) contains now. The reading names why the pointer did not decide:
 *     none started, the schema cannot say, or the pointer names a stage absent
 *     from this read. The last cannot happen under the composite FK, so it is
 *     reported rather than trusted.
 */
export function chooseTodayStage<S extends TodayStageRow>(
  stageRows: readonly S[],
  anchors: TripStageAnchors,
  nowMs: number,
): { stage: S | null; stageReading: string } {
  if (anchors.available && anchors.currentStageId !== null) {
    const started = stageRows.find((s) => String(s.id) === anchors.currentStageId) ?? null;
    if (started) {
      return { stage: started, stageReading: `stage ${String(started.id)} (sequence ${String(started.sequence)}) is the trip's started stage` };
    }
  }
  const byInterval = stageRows.find((s) => s.starts_at && s.ends_at && Date.parse(s.starts_at) <= nowMs && nowMs < Date.parse(s.ends_at)) ?? null;
  const why = !anchors.available ? "this database has no current-stage pointer (3768 unapplied); "
    : anchors.currentStageId !== null ? `the current-stage pointer names ${anchors.currentStageId}, which this read did not return; `
    : "";
  const base = byInterval ? `stage ${String(byInterval.id)} (sequence ${String(byInterval.sequence)}) contains now`
    : stageRows.length === 0 ? "the trip has no stages" : "no stage's interval contains now";
  return { stage: byInterval, stageReading: why + base };
}

/**
 * A time zone NAME the runtime's tz database resolves, in the shape 3768's
 * CHECK admits: letters, digits, '_' and '-' in the first segment, '+' allowed
 * only after a '/'. So 'Etc/GMT+5' passes and the POSIX offset 'UTC+3' does
 * not. Node (ICU) also accepts offsets such as '+05:00', which the shape
 * refuses. This is the route's early refusal; the kernel's check against
 * pg_timezone_names is the authority.
 */
const IANA_SHAPE = /^[A-Za-z][A-Za-z0-9_-]*(\/[A-Za-z0-9_+-]+)*$/;

export function isIanaTimeZoneName(value: string): boolean {
  if (value.length < 1 || value.length > 64 || !IANA_SHAPE.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
