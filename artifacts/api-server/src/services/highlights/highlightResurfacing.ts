/**
 * highlightResurfacing — §11 "Sensitive Context and Resurfacing Controls".
 *
 * Highlights/Memories Development Architecture Spec v1 §11, in full:
 *
 *   "Some places or contexts require stricter defaults. Sensitivity policy
 *    should be deterministic and reviewable rather than generated ad hoc by an
 *    LLM."
 *      Hotels and precise lodging locations
 *      Private residences
 *      Medical or emergency locations
 *      Embassies and legal assistance
 *      Sensitive nightlife contexts
 *      Religious or intimate settings where exposure could create harm
 *      Any user-marked "keep private forever" Memory
 *
 *   User controls
 *      DO_NOT_RESURFACE
 *      DO_NOT_INCLUDE_IN_RECAPS
 *      HIDE_PERSON_FROM_RESURFACING
 *      HIDE_TRIP
 *      KEEP_PRIVATE_FOREVER
 *      RETAIN_BUT_DO_NOT_PERSONALIZE
 *
 * Census ids: H86 (the registry — a registry exists at lib/protectedLocations.ts
 * but it is the Map spec's §24 gate and NEITHER `memories` NOR `highlights`
 * consults it), H87-H92 (the six controls, five NOT-BUILT and one, H92,
 * recorded as inseparable from hiding).
 *
 * ── "DETERMINISTIC AND REVIEWABLE" IS THE REQUIREMENT, NOT A STYLE NOTE ─────
 * The categories below are a frozen literal list with a stated mapping to the
 * one registry this repository already has. Nothing here consults a model,
 * infers sensitivity from a caption, or scores a place. A category is asserted
 * by a policy row or it is not asserted.
 *
 * ── THE SIX CONTROLS ARE SIX CONTROLS ──────────────────────────────────────
 * §21 opens by insisting that Archive, Do-not-resurface, Do-not-personalize and
 * Delete "must remain separate in both data model and UX", and the census's H92
 * entry is precisely a case where two of them were collapsed
 * (`memory_projections.state='hidden'` hides AND de-personalises). So each
 * control here carries its own `suppresses` set naming the SURFACES it acts on,
 * and `suppressionFor` returns the union for a set of active controls. A caller
 * asks "is this Highlight suppressed on the RECAP surface", not "is it hidden".
 *
 * ── FAIL-CLOSED SHAPE FOR A SUPPRESSION LIST ───────────────────────────────
 * A suppression table is one where a ROW MEANS DENY, so emptiness means allow —
 * the exact shape lib/exclusionSet.ts exists to keep honest. Read it with an
 * unbound `.error` and a database outage becomes "nobody suppressed anything",
 * which on THIS surface means resurfacing a Memory somebody asked never to see
 * again. That is the failure §11 is written to prevent, so:
 *
 *   readable + empty  → nothing suppressed. A real answer.
 *   unreadable        → EVERYTHING in scope is suppressed. `isSuppressed`
 *                       returns true for an unreadable set by construction, so
 *                       a caller cannot forget.
 *   table absent      → the control is NOT DEPLOYED. Reported, logged, and NOT
 *                       enforced — see highlightSchemaAvailability.ts for why
 *                       this is a third state and not folded into either of the
 *                       first two.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { probeHighlightObject } from "./highlightSchemaAvailability.js";

// ── §11 sensitive context categories ─────────────────────────────────────────

export const SENSITIVE_CONTEXT_CATEGORIES = [
  "LODGING_PRECISE",
  "PRIVATE_RESIDENCE",
  "MEDICAL_OR_EMERGENCY",
  "EMBASSY_OR_LEGAL_ASSISTANCE",
  "SENSITIVE_NIGHTLIFE",
  "RELIGIOUS_OR_INTIMATE",
  "USER_MARKED_KEEP_PRIVATE_FOREVER",
] as const;
export type SensitiveContextCategory = (typeof SENSITIVE_CONTEXT_CATEGORIES)[number];

export function isSensitiveContextCategory(v: unknown): v is SensitiveContextCategory {
  return typeof v === "string" && (SENSITIVE_CONTEXT_CATEGORIES as readonly string[]).includes(v);
}

/**
 * How each §11 category relates to the ONE sensitive-place registry this
 * repository already has: `lib/protectedLocations.ts` PROTECTED_CATEGORIES =
 * private_residence | medical_facility | shelter | sensitive_government |
 * policy_defined, backed by table `protected_zones` (migration 2217, shipped
 * deliberately empty).
 *
 * Stating the mapping — including the three §11 categories with NO home in that
 * registry — is the point. A reader must be able to see that wiring
 * protectedLocations into this surface would cover two of seven categories, not
 * seven, so nobody reads a partial adoption as completion.
 */
export const SENSITIVE_CATEGORY_REGISTRY_MAPPING: Readonly<
  Record<SensitiveContextCategory, { readonly protectedZoneCategory: string | null; readonly note: string }>
> = Object.freeze({
  LODGING_PRECISE: {
    protectedZoneCategory: null,
    note:
      "no protected_zones category for lodging. The nearest existing treatment is services/passport/PassportPrivacyGuard.ts, which blurs hotel/home/private_stay STAMPS by nulling neighborhood and place_id — a per-row field blank on the Passport surface, not a zone and never applied to a Highlight",
  },
  PRIVATE_RESIDENCE: {
    protectedZoneCategory: "private_residence",
    note: "direct match; protected_zones holds 0 rows today, so the category is defined and unpopulated",
  },
  MEDICAL_OR_EMERGENCY: {
    protectedZoneCategory: "medical_facility",
    note: "direct match for medical; 'emergency locations' has no separate category",
  },
  EMBASSY_OR_LEGAL_ASSISTANCE: {
    protectedZoneCategory: "sensitive_government",
    note: "an embassy is plausibly sensitive_government; legal assistance is not covered and would need policy_defined",
  },
  SENSITIVE_NIGHTLIFE: {
    protectedZoneCategory: null,
    note: "no category. Would require policy_defined zones, which is a curation decision, not a code change",
  },
  RELIGIOUS_OR_INTIMATE: {
    protectedZoneCategory: null,
    note: "no category. Same as above",
  },
  USER_MARKED_KEEP_PRIVATE_FOREVER: {
    protectedZoneCategory: null,
    note: "not a place at all — it is the KEEP_PRIVATE_FOREVER user control below, asserted per Highlight rather than per location",
  },
});

// ── §11 user controls ────────────────────────────────────────────────────────

export const RESURFACING_CONTROLS = [
  "DO_NOT_RESURFACE",
  "DO_NOT_INCLUDE_IN_RECAPS",
  "HIDE_PERSON_FROM_RESURFACING",
  "HIDE_TRIP",
  "KEEP_PRIVATE_FOREVER",
  "RETAIN_BUT_DO_NOT_PERSONALIZE",
] as const;
export type ResurfacingControl = (typeof RESURFACING_CONTROLS)[number];

export function isResurfacingControl(v: unknown): v is ResurfacingControl {
  return typeof v === "string" && (RESURFACING_CONTROLS as readonly string[]).includes(v);
}

/** The surfaces a control can act on. Named so no two are collapsed. */
export const SUPPRESSIBLE_SURFACES = [
  "proactive_resurfacing",
  "recap",
  "personalization",
  "public_projection",
] as const;
export type SuppressibleSurface = (typeof SUPPRESSIBLE_SURFACES)[number];

/**
 * Which surfaces each control suppresses, and — just as important — which it
 * does NOT. Read the `retains` column against §21's table: every one of these
 * RETAINS the underlying record. None of them is a delete.
 */
export const CONTROL_EFFECTS: Readonly<
  Record<
    ResurfacingControl,
    {
      readonly suppresses: readonly SuppressibleSurface[];
      readonly scope: "highlight" | "person" | "trip" | "owner";
      readonly retainsRecord: true;
      readonly note: string;
    }
  >
> = Object.freeze({
  DO_NOT_RESURFACE: {
    suppresses: ["proactive_resurfacing"],
    scope: "highlight",
    retainsRecord: true,
    note: "§21: 'Retain and search privately; suppress proactive resurfacing.' Explicit retrieval by the owner is UNAFFECTED",
  },
  DO_NOT_INCLUDE_IN_RECAPS: {
    suppresses: ["recap"],
    scope: "highlight",
    retainsRecord: true,
    note: "distinct from DO_NOT_RESURFACE: a Memory may be resurfaceable one-off and still not belong in a Trip recap",
  },
  HIDE_PERSON_FROM_RESURFACING: {
    suppresses: ["proactive_resurfacing", "recap"],
    scope: "person",
    retainsRecord: true,
    note: "keyed on a participant id, not a Highlight id — one control removes one person from every resurfaced Highlight",
  },
  HIDE_TRIP: {
    suppresses: ["proactive_resurfacing", "recap"],
    scope: "trip",
    retainsRecord: true,
    note: "keyed on a trip id. Does NOT suppress public_projection: hiding a trip from your own resurfacing is not unpublishing it",
  },
  KEEP_PRIVATE_FOREVER: {
    suppresses: ["proactive_resurfacing", "recap", "personalization", "public_projection"],
    scope: "highlight",
    retainsRecord: true,
    note: "the strongest control that is still not a delete. §11 lists it as a sensitive-context trigger in its own right",
  },
  RETAIN_BUT_DO_NOT_PERSONALIZE: {
    suppresses: ["personalization"],
    scope: "highlight",
    retainsRecord: true,
    note:
      "§21: 'Retain Memory but exclude from preference/recommendation inference.' It must NOT hide the Highlight — census H92 records the existing memory_projections.state='hidden' collapsing these two, which is the defect this separation exists to avoid",
  },
});

/** The union of surfaces suppressed by a set of active controls. */
export function suppressionFor(controls: Iterable<ResurfacingControl>): Set<SuppressibleSurface> {
  const out = new Set<SuppressibleSurface>();
  for (const c of controls) for (const s of CONTROL_EFFECTS[c].suppresses) out.add(s);
  return out;
}

// ── The suppression set: fail-closed by construction ─────────────────────────

export interface SuppressionKey {
  readonly control: ResurfacingControl;
  /** highlight id, participant user id, trip id, or the owner id — per scope. */
  readonly subjectId: string;
}

export type ResurfacingSuppressions =
  | { readonly state: "ready"; readonly rows: ReadonlySet<string> }
  | { readonly state: "absent"; readonly reason: string }
  | { readonly state: "unreadable"; readonly reason: string };

function keyOf(control: ResurfacingControl, subjectId: string): string {
  return `${control}\u0000${subjectId}`;
}

/**
 * Is `subjectId` suppressed under `control`?
 *
 * **An unreadable set suppresses everything.** Same construction as
 * lib/exclusionSet.ts's `isExcluded`: the fail-closed answer is the DEFAULT of
 * the membership test, so a caller that only asks the question degrades
 * correctly with no per-site error handling to forget. A caller that needs to
 * tell "suppressed" from "unknown" must branch on `.state`, which makes the
 * exception visible in review.
 *
 * An ABSENT table does NOT suppress: the control is not deployed, there is
 * nothing for a user to have set, and suppressing on that basis would black out
 * a live surface on the strength of a migration nobody has run. It is reported
 * instead — see the header.
 */
export function isSuppressed(
  set: ResurfacingSuppressions,
  control: ResurfacingControl,
  subjectId: string | null | undefined,
): boolean {
  if (set.state === "unreadable") return true;
  if (set.state === "absent") return false;
  if (!subjectId) return false;
  return set.rows.has(keyOf(control, subjectId));
}

/** Build a readable set. Exported so tests and adapters can construct one. */
export function suppressions(keys: Iterable<SuppressionKey>): ResurfacingSuppressions {
  const rows = new Set<string>();
  for (const k of keys) rows.add(keyOf(k.control, k.subjectId));
  return { state: "ready", rows };
}

export const RESURFACING_TABLE = "highlight_resurfacing_preferences";
export const RESURFACING_COLUMNS = ["id", "owner_id", "control", "subject_type", "subject_id"] as const;

/**
 * Load one owner's §11 controls.
 *
 * Scoped to the OWNER because every control in §11 is a control the owner of the
 * Memory set — §10: "Being tagged or referenced does not make another user a
 * co-owner", and the converse is that a viewer cannot set suppressions on
 * somebody else's Highlight.
 *
 * The `.error` binding is load-bearing: supabase-js RESOLVES on a database
 * error, so an unbound one turns a failed read into an empty suppression set,
 * and this is the surface where an empty suppression set means "resurface the
 * thing they asked you to forget".
 */
export async function readResurfacingSuppressions(
  sc: SupabaseClient | any,
  ownerId: string,
): Promise<ResurfacingSuppressions> {
  return readResurfacingSuppressionsForOwners(sc, [ownerId]);
}

/**
 * The batch form, for a feed page spanning many owners. One read, not one per
 * owner — a per-owner loop on a 60-item page is 60 round trips and, worse, 60
 * independent chances to fail, each of which would have to fail closed on its
 * own or the page would be partly enforced and look whole.
 */
export async function readResurfacingSuppressionsForOwners(
  sc: SupabaseClient | any,
  ownerIds: readonly string[],
): Promise<ResurfacingSuppressions> {
  const owners = [...new Set(ownerIds.filter((id) => typeof id === "string" && id.length > 0))];
  if (owners.length === 0) return { state: "ready", rows: new Set<string>() };

  const availability = await probeHighlightObject(sc, RESURFACING_TABLE, RESURFACING_COLUMNS);
  if (availability.state !== "ready") return availability;

  try {
    const { data, error } = await sc
      .from(RESURFACING_TABLE)
      .select(RESURFACING_COLUMNS.join(", "))
      .in("owner_id", owners);
    if (error) {
      return { state: "unreadable", reason: `${RESURFACING_TABLE} read failed: ${String((error as any)?.message ?? error)}` };
    }
    const rows = new Set<string>();
    for (const r of (data ?? []) as Array<Record<string, unknown>>) {
      const control = r.control;
      const subjectId = r.subject_id;
      // A row whose control we do not recognise is NOT dropped silently: it is
      // a policy row that means something to whoever wrote it. It cannot be
      // enforced, so the whole set is downgraded to unreadable rather than
      // enforcing a partial policy that looks complete.
      if (!isResurfacingControl(control)) {
        return {
          state: "unreadable",
          reason: `${RESURFACING_TABLE} holds an unrecognised control ${JSON.stringify(control)}; refusing to enforce a partial policy`,
        };
      }
      if (typeof subjectId !== "string" || subjectId.length === 0) {
        return {
          state: "unreadable",
          reason: `${RESURFACING_TABLE} row for ${control} has no subject_id; refusing to enforce a partial policy`,
        };
      }
      rows.add(keyOf(control, subjectId));
    }
    return { state: "ready", rows };
  } catch (err) {
    return { state: "unreadable", reason: `${RESURFACING_TABLE} read threw: ${String((err as any)?.message ?? err)}` };
  }
}
