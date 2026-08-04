/**
 * Place Day lifecycle and local-calendar helpers. A Place Day is an anchor over
 * existing source activity, never a copied post or a check-in record.
 */
import { cityTimezone, timezoneFromCoords } from "../../compass/CompassGraphEngine.js";
import { isLivePlacesCapabilityEnabled } from "../featureFlags.js";
import { logger } from "../logger.js";

export type PlaceDayStatus = "active" | "closing" | "archived";

export function validIanaTimezone(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return value;
  } catch {
    return null;
  }
}

export function localDateFor(at: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(at);
  const part = (type: string) => parts.find((p) => p.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function isValidLocalDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** Calendar arithmetic deliberately operates on date components, not 24-hour
 * durations, so a DST transition cannot shorten or extend lifecycle grace. */
export function shiftLocalDate(localDate: string, days: number): string {
  const [year, month, day] = localDate.split("-").map(Number);
  const result = new Date(Date.UTC(year, month - 1, day + days));
  return result.toISOString().slice(0, 10);
}

/**
 * Convert a place-local calendar date into a half-open UTC range. Iterating the
 * formatter projection makes this correct on offset changes without treating a
 * local day as a fixed 24-hour duration.
 */
export function utcRangeForLocalDate(localDate: string, timezone: string): { start: string; end: string } {
  if (!isValidLocalDate(localDate)) throw new Error("invalid local date");
  const toUtcMidnight = (date: string): Date => {
    const [year, month, day] = date.split("-").map(Number);
    const target = Date.UTC(year, month - 1, day, 0, 0, 0);
    let instant = target;
    for (let attempt = 0; attempt < 3; attempt++) {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
      }).formatToParts(new Date(instant));
      const part = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
      const projected = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second"));
      const correction = target - projected;
      if (correction === 0) break;
      instant += correction;
    }
    return new Date(instant);
  };
  return {
    start: toUtcMidnight(localDate).toISOString(),
    end: toUtcMidnight(shiftLocalDate(localDate, 1)).toISOString(),
  };
}

export function isEligiblePlaceDayPost(post: any, nowMs = Date.now()): boolean {
  return Boolean(
    post &&
    post.visibility === "public" &&
    post.status === "active" &&
    (!post.post_status || post.post_status === "published") &&
    (!post.publish_at || new Date(post.publish_at).getTime() <= nowMs),
  );
}

export function resolvePlaceTimezone(place: any): string {
  const explicit = validIanaTimezone(place?.timezone);
  if (explicit) return explicit;
  return cityTimezone(place?.city ?? null, {
    lat: place?.latitude ?? null, lng: place?.longitude ?? null,
  }) ?? timezoneFromCoords(place?.latitude ?? null, place?.longitude ?? null) ?? "UTC";
}

export async function arePlaceDaysEnabled(sc: any): Promise<boolean> {
  return isLivePlacesCapabilityEnabled(sc, "place_days_enabled");
}

/** Upserts the local day exactly once, even under concurrent eligible activity. */
export async function ensurePlaceDay(
  sc: any,
  placeId: string,
  at: Date = new Date(),
): Promise<any | null> {
  if (!(await arePlaceDaysEnabled(sc))) return null;
  const { data: requestedPlace, error: placeError } = await sc
    .from("places").select("id, city, latitude, longitude, merged_into_place_id")
    .eq("id", placeId).maybeSingle();
  if (placeError || !requestedPlace) return null;
  const canonicalId = (requestedPlace as any).merged_into_place_id ?? placeId;
  let place = requestedPlace;
  if (canonicalId !== placeId) {
    const { data } = await sc.from("places")
      .select("id, city, latitude, longitude").eq("id", canonicalId).maybeSingle();
    if (!data) return null;
    place = data;
  }
  const timezone = resolvePlaceTimezone(place);
  const localDate = localDateFor(at, timezone);
  const { data, error } = await sc.from("place_days").upsert(
    { place_id: canonicalId, local_date: localDate, timezone, status: "active" },
    { onConflict: "place_id,local_date", ignoreDuplicates: true },
  );
  if (error) {
    logger.warn({ err: error, placeId: canonicalId }, "place-day creation failed");
    return null;
  }
  if (data) return data;
  const { data: existing } = await sc.from("place_days").select("*")
    .eq("place_id", canonicalId).eq("local_date", localDate).maybeSingle();
  return existing ?? null;
}

/** Advances lifecycle from local-date boundaries; safe to run repeatedly. */
export async function runPlaceDayLifecycleTick(sc: any): Promise<{ closing: number; archived: number }> {
  if (!sc || !(await arePlaceDaysEnabled(sc))) return { closing: 0, archived: 0 };
  const { data: rows, error } = await sc.from("place_days")
    .select("id, place_id, local_date, timezone, status").in("status", ["active", "closing"]).limit(1000);
  if (error) {
    logger.warn({ err: error }, "place-day lifecycle select failed");
    return { closing: 0, archived: 0 };
  }
  let closing = 0, archived = 0;
  for (const row of (rows ?? []) as any[]) {
    const today = localDateFor(new Date(), validIanaTimezone(row.timezone) ?? "UTC");
    // A past local day closes first; it remains readable and eligible for
    // late-arriving canonicalization for one complete local day before archive.
    const archiveBefore = shiftLocalDate(today, -1);
    if (row.status === "active" && row.local_date < today) {
      const { error: updateError } = await sc.from("place_days")
        .update({ status: "closing", closing_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq("id", row.id).eq("status", "active");
      if (!updateError) closing++;
    } else if (row.status === "closing" && row.local_date < archiveBefore) {
      const { error: updateError } = await sc.from("place_days")
        .update({ status: "archived", archived_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq("id", row.id).eq("status", "closing");
      if (!updateError) archived++;
    }
  }
  return { closing, archived };
}