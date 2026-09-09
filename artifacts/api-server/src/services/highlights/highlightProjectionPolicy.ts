/**
 * highlightProjectionPolicy — §10 "Privacy, Consent, and Projection Policy",
 * applied to the Highlights surface.
 *
 * Highlights/Memories Development Architecture Spec v1 §10:
 *
 *   Memory consent dimensions
 *     STORE / RESURFACE / PERSONALIZE / SHARE / CONTRIBUTE_TO_AGGREGATE_INTEL
 *
 *   Location precision ladder
 *     EXACT -> VENUE -> NEIGHBORHOOD -> CITY -> COUNTRY -> HIDDEN
 *
 *   Person visibility ladder
 *     NAMED -> PROFILE_LINKED -> CREW_ONLY -> ANONYMOUS_COUNT -> HIDDEN
 *
 *   Policy invariants (the ones this file is responsible for):
 *     "Publishing location must never exceed the owner's selected precision."
 *     "Temporary operational location must not leak into durable public
 *      Highlights by default."
 *     "Being tagged or referenced does not make another user a co-owner."
 *
 * Census ids moved here: H75 (the five consent dimensions), H76 (the location
 * ladder as an OWNER-SELECTED precision rather than only a Hidden-Gem ceiling),
 * H77 (the full five-rung person ladder — lib/publicIdentity.ts implements two),
 * H81 (publishing must not exceed the owner's precision), H82 (operational
 * location must not leak into durable public Highlights).
 *
 * ── FAIL CLOSED, AND WHAT THAT MEANS FOR EACH LADDER ────────────────────────
 * The two ladders fail closed in OPPOSITE DIRECTIONS along their own axis, and
 * getting this backwards is the whole risk:
 *
 *   location  — the safe end is HIDDEN. An unreadable policy row must clamp
 *               DOWN, never leave the raw location in the response.
 *   person    — the safe end is HIDDEN. An unreadable row must not name anyone.
 *
 * `consentGiven` is a THREE-valued answer, never a boolean, because the boolean
 * spelling has an accidental value that means "yes": `!!row?.share`. A missing
 * row, a null column and a failed read all produce `false` there only if the
 * caller remembered the `!`; and every one of them is *different* from a stored
 * `false`. So: `granted` / `withheld` / `unknown`, and `unknown` is refused by
 * `mayProject`.
 *
 * ── WHAT THIS FILE DELIBERATELY DOES NOT DECIDE ─────────────────────────────
 * LOCATION_PRECISION_DEFAULT — what precision applies to a Highlight whose owner
 * has never chosen one — is an OWNER decision and is NOT taken here. Every
 * Highlight in production today is in exactly that state (there is no precision
 * column: see 2721). §10 says the default should be restrictive ("must not leak
 * … by default") but does not say which rung, and picking one would silently
 * strip `location_name` / `location_city` / `location_country` from every
 * Highlight now on the surface. So `resolveLocationDisclosure` reports
 * `applied: false` with `reason: "no owner-selected precision"` and returns the
 * row's location UNCHANGED, and the caller logs it. The clamp itself is built,
 * tested, and one stored value away from being live.
 *
 * PURE except `readProjectionPolicy`, which is the single I/O function and is
 * the only place a database is consulted.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { probeHighlightObject, type ObjectAvailability } from "./highlightSchemaAvailability.js";

// ── §10 consent dimensions ───────────────────────────────────────────────────

export const MEMORY_CONSENT_DIMENSIONS = [
  "STORE",
  "RESURFACE",
  "PERSONALIZE",
  "SHARE",
  "CONTRIBUTE_TO_AGGREGATE_INTEL",
] as const;
export type MemoryConsentDimension = (typeof MEMORY_CONSENT_DIMENSIONS)[number];

export function isConsentDimension(v: unknown): v is MemoryConsentDimension {
  return typeof v === "string" && (MEMORY_CONSENT_DIMENSIONS as readonly string[]).includes(v);
}

/** Three-valued. See the header for why this is not a boolean. */
export type ConsentState = "granted" | "withheld" | "unknown";

/**
 * Read one consent dimension out of a policy row.
 *
 * Only a stored `true` is `granted`. A stored `false` is `withheld`. Absent,
 * null, and anything that is not a boolean are `unknown` — including the string
 * "true", which is what a mis-typed column or a JSON round-trip produces and
 * which must never be coerced into consent.
 */
export function consentFromRow(row: unknown, dimension: MemoryConsentDimension): ConsentState {
  if (!row || typeof row !== "object") return "unknown";
  const v = (row as Record<string, unknown>)[`consent_${dimension.toLowerCase()}`];
  if (v === true) return "granted";
  if (v === false) return "withheld";
  return "unknown";
}

/**
 * §10. May this projection proceed?
 *
 * "unknown" refuses. This is the fail-closed rule stated once so that no caller
 * can spell it as a truthiness test.
 */
export function mayProject(state: ConsentState): boolean {
  return state === "granted";
}

// ── §10 location precision ladder ────────────────────────────────────────────

/**
 * Ordered COARSEST-LAST as the spec writes it (EXACT → … → HIDDEN). The rank
 * below is what code compares; the array is what a reader compares against §10.
 */
export const LOCATION_PRECISION_LADDER = [
  "EXACT",
  "VENUE",
  "NEIGHBORHOOD",
  "CITY",
  "COUNTRY",
  "HIDDEN",
] as const;
export type LocationPrecisionRung = (typeof LOCATION_PRECISION_LADDER)[number];

/** Higher = MORE PRIVATE. HIDDEN is the safe end. */
export function locationPrecisionRank(p: LocationPrecisionRung): number {
  return LOCATION_PRECISION_LADDER.indexOf(p);
}

export function isLocationPrecision(v: unknown): v is LocationPrecisionRung {
  return typeof v === "string" && (LOCATION_PRECISION_LADDER as readonly string[]).includes(v);
}

/**
 * §10: "Publishing location must never exceed the owner's selected precision."
 * Combining two constraints may only ever move TOWARD HIDDEN.
 */
export function strictestPrecision(a: LocationPrecisionRung, b: LocationPrecisionRung): LocationPrecisionRung {
  return locationPrecisionRank(a) >= locationPrecisionRank(b) ? a : b;
}

export interface HighlightLocationFields {
  readonly location_name?: string | null;
  readonly location_city?: string | null;
  readonly location_country?: string | null;
}

export interface LocationDisclosure {
  readonly location_name: string | null;
  readonly location_city: string | null;
  readonly location_country: string | null;
  /** True when a precision was actually selected and applied. */
  readonly applied: boolean;
  /** The rung applied, or null when none was. */
  readonly precision: LocationPrecisionRung | null;
  /** Present when `applied` is false; for logs, never for the client. */
  readonly reason?: string;
}

/**
 * Clamp a Highlight's location fields to a rung of the §10 ladder.
 *
 * The `highlights` table carries no coordinates — only three text fields — so
 * EXACT and VENUE are indistinguishable on this surface and both disclose
 * `location_name`. That is stated here rather than silently collapsed: if
 * coordinates are ever added, EXACT must gain a branch, and this comment is
 * where the reviewer will look.
 */
export function clampLocationToPrecision(
  row: HighlightLocationFields,
  precision: LocationPrecisionRung,
): Omit<LocationDisclosure, "applied" | "precision" | "reason"> {
  switch (precision) {
    case "EXACT":
    case "VENUE":
      return {
        location_name: row.location_name ?? null,
        location_city: row.location_city ?? null,
        location_country: row.location_country ?? null,
      };
    case "NEIGHBORHOOD":
      // No neighborhood column on `highlights`. The venue NAME is what would
      // identify the place, so it is the thing that must go; city and country
      // are coarser than a neighborhood and survive.
      return {
        location_name: null,
        location_city: row.location_city ?? null,
        location_country: row.location_country ?? null,
      };
    case "CITY":
      return { location_name: null, location_city: row.location_city ?? null, location_country: row.location_country ?? null };
    case "COUNTRY":
      return { location_name: null, location_city: null, location_country: row.location_country ?? null };
    case "HIDDEN":
      return { location_name: null, location_city: null, location_country: null };
    default:
      // Unreachable for a valid rung; an invalid one hides. Fail closed.
      return { location_name: null, location_city: null, location_country: null };
  }
}

/**
 * The full §10 / §81 decision for one Highlight.
 *
 * `stored` is the owner's selected precision as read from the policy row, or
 * `undefined` when the deployment has no such column. See the header for why
 * `undefined` does NOT become a default rung here.
 */
export function resolveLocationDisclosure(
  row: HighlightLocationFields,
  stored: unknown,
  policyAvailability: ObjectAvailability,
): LocationDisclosure {
  if (policyAvailability.state === "unreadable") {
    // The control is deployed and the read failed. FAIL CLOSED: we cannot show
    // that we are within the owner's selected precision, so we disclose nothing.
    return {
      ...clampLocationToPrecision(row, "HIDDEN"),
      applied: true,
      precision: "HIDDEN",
      reason: `projection policy unreadable — clamped to HIDDEN: ${policyAvailability.reason}`,
    };
  }
  if (policyAvailability.state === "absent") {
    return {
      location_name: row.location_name ?? null,
      location_city: row.location_city ?? null,
      location_country: row.location_country ?? null,
      applied: false,
      precision: null,
      reason:
        "highlight_projection_policies is not deployed (migration 2721 not applied); §10 location precision is UNENFORCED on this surface",
    };
  }
  if (stored == null) {
    return {
      location_name: row.location_name ?? null,
      location_city: row.location_city ?? null,
      location_country: row.location_country ?? null,
      applied: false,
      precision: null,
      reason:
        "no owner-selected precision for this Highlight; LOCATION_PRECISION_DEFAULT is an unmade owner decision and is not chosen here",
    };
  }
  if (!isLocationPrecision(stored)) {
    // A policy row we cannot parse is not permission. Fail closed.
    return {
      ...clampLocationToPrecision(row, "HIDDEN"),
      applied: true,
      precision: "HIDDEN",
      reason: `stored precision ${JSON.stringify(stored)} is not a §10 rung — clamped to HIDDEN`,
    };
  }
  return {
    ...clampLocationToPrecision(row, stored),
    applied: true,
    precision: stored,
  };
}

// ── §10 person visibility ladder ─────────────────────────────────────────────

/** NAMED -> PROFILE_LINKED -> CREW_ONLY -> ANONYMOUS_COUNT -> HIDDEN. */
export const PERSON_VISIBILITY_LADDER = [
  "NAMED",
  "PROFILE_LINKED",
  "CREW_ONLY",
  "ANONYMOUS_COUNT",
  "HIDDEN",
] as const;
export type PersonVisibilityRung = (typeof PERSON_VISIBILITY_LADDER)[number];

/** Higher = MORE PRIVATE. */
export function personVisibilityRank(p: PersonVisibilityRung): number {
  return PERSON_VISIBILITY_LADDER.indexOf(p);
}

export function isPersonVisibility(v: unknown): v is PersonVisibilityRung {
  return typeof v === "string" && (PERSON_VISIBILITY_LADDER as readonly string[]).includes(v);
}

export function strictestPersonVisibility(a: PersonVisibilityRung, b: PersonVisibilityRung): PersonVisibilityRung {
  return personVisibilityRank(a) >= personVisibilityRank(b) ? a : b;
}

export interface PersonRef {
  readonly userId: string;
  readonly handle: string | null;
  readonly name: string | null;
}

export type PersonDisclosure =
  | { readonly rung: "NAMED"; readonly userId: string; readonly handle: string | null; readonly name: string | null }
  | { readonly rung: "PROFILE_LINKED"; readonly userId: string; readonly handle: string | null; readonly name: null }
  | { readonly rung: "CREW_ONLY"; readonly userId: string; readonly handle: string | null; readonly name: null }
  | { readonly rung: "ANONYMOUS_COUNT"; readonly userId: null; readonly handle: null; readonly name: null }
  | { readonly rung: "HIDDEN" };

/**
 * §10 person ladder, applied to one referenced person.
 *
 * `viewerIsCrew` only matters at CREW_ONLY; at every other rung the answer does
 * not depend on the viewer, which is the point of a ladder rather than a
 * per-viewer switch.
 *
 * ANONYMOUS_COUNT deliberately drops the user id as well as the name: a rung
 * whose whole purpose is "somebody was here, you do not learn who" leaks the
 * identity if the id ships alongside the count.
 */
export function discloseParticipant(
  person: PersonRef,
  rung: PersonVisibilityRung,
  opts: { readonly viewerIsCrew?: boolean } = {},
): PersonDisclosure {
  switch (rung) {
    case "NAMED":
      return { rung: "NAMED", userId: person.userId, handle: person.handle, name: person.name };
    case "PROFILE_LINKED":
      return { rung: "PROFILE_LINKED", userId: person.userId, handle: person.handle, name: null };
    case "CREW_ONLY":
      return opts.viewerIsCrew === true
        ? { rung: "CREW_ONLY", userId: person.userId, handle: person.handle, name: null }
        : { rung: "HIDDEN" };
    case "ANONYMOUS_COUNT":
      return { rung: "ANONYMOUS_COUNT", userId: null, handle: null, name: null };
    case "HIDDEN":
    default:
      return { rung: "HIDDEN" };
  }
}

// ── I/O: the one function that touches a database ────────────────────────────

/** The columns migration 2721 provides. Probed as a set; a partial table is `absent`. */
export const PROJECTION_POLICY_TABLE = "highlight_projection_policies";
export const PROJECTION_POLICY_COLUMNS = [
  "id",
  "highlight_id",
  "owner_id",
  "location_precision",
  "person_visibility",
  "consent_store",
  "consent_resurface",
  "consent_personalize",
  "consent_share",
  "consent_contribute_to_aggregate_intel",
] as const;

export type ProjectionPolicyRead =
  | { readonly state: "ready"; readonly byHighlightId: ReadonlyMap<string, Record<string, unknown>> }
  | { readonly state: "absent"; readonly reason: string }
  | { readonly state: "unreadable"; readonly reason: string };

/**
 * Load the §10 policy rows for a batch of Highlights.
 *
 * THREE OUTCOMES, NOT TWO — see highlightSchemaAvailability.ts. In particular a
 * successful read that returns NO ROW for a Highlight is `ready` with that id
 * absent from the map; the caller then gets `unknown` consent and an unset
 * precision, which is not the same as a failed read and must not be conflated
 * with one.
 *
 * supabase-js RESOLVES on a database error, so the `.error` binding below is
 * load-bearing: without it a failed read is an empty array, every Highlight
 * looks policy-free, and §10 is unenforced with no trace.
 */
export async function readProjectionPolicies(
  sc: SupabaseClient | any,
  highlightIds: readonly string[],
): Promise<ProjectionPolicyRead> {
  if (highlightIds.length === 0) return { state: "ready", byHighlightId: new Map() };

  const availability = await probeHighlightObject(sc, PROJECTION_POLICY_TABLE, PROJECTION_POLICY_COLUMNS);
  if (availability.state !== "ready") return availability;

  try {
    const { data, error } = await sc
      .from(PROJECTION_POLICY_TABLE)
      .select(PROJECTION_POLICY_COLUMNS.join(", "))
      .in("highlight_id", [...highlightIds]);
    if (error) {
      return { state: "unreadable", reason: `${PROJECTION_POLICY_TABLE} read failed: ${String((error as any)?.message ?? error)}` };
    }
    const byHighlightId = new Map<string, Record<string, unknown>>();
    for (const r of (data ?? []) as Array<Record<string, unknown>>) {
      const hid = r.highlight_id;
      if (typeof hid === "string") byHighlightId.set(hid, r);
    }
    return { state: "ready", byHighlightId };
  } catch (err) {
    return { state: "unreadable", reason: `${PROJECTION_POLICY_TABLE} read threw: ${String((err as any)?.message ?? err)}` };
  }
}
