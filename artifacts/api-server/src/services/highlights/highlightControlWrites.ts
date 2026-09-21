/**
 * highlightControlWrites — the WRITE half of §10 and §11.
 *
 * Highlights/Memories Development Architecture Spec v1:
 *   §10 "Publishing location must never exceed the owner's SELECTED precision"
 *   §11 the six resurfacing controls, which are things a USER SETS
 *   §21 "delete, archive, do-not-resurface, and 'keep but do not personalize'
 *       are different operations and must remain separate in both data model
 *       and UX"
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 * `highlightResurfacing.ts` and `highlightProjectionPolicy.ts` READ
 * `highlight_resurfacing_preferences` and `highlight_projection_policies`, and
 * both tables were applied to production on 2026-09-15. The census then
 * recorded, at §O.2 of docs/architecture/census-highlights-memories.md, the
 * finding that made every §10/§11 row stay BUILT-BUT-WRONG after the migration
 * landed:
 *
 *     "A repository-wide grep for `insert`, `upsert` or `update` against
 *      highlight_resurfacing_preferences and highlight_projection_policies
 *      returns nothing outside src/test/. There is no route, no service and no
 *      script by which a user can set a §11 resurfacing control or a §10
 *      precision rung. Both tables are deployed and EMPTY, and they will stay
 *      empty."
 *
 * This module is the writer. Enforcement was already correct and already
 * route-tested; what it lacked was any way for the person it protects to say
 * what they wanted. A control nobody can set is not a control.
 *
 * ── THE FOUR RULES THIS MODULE ENFORCES, AND WHY EACH IS HERE ───────────────
 *
 * 1. OWNER-ONLY, CHECKED APP-SIDE. `requireUser` hands routes the SERVICE
 *    client, which bypasses RLS. The owner-scoping policies migration 2720 and
 *    2721 install are therefore NOT what protects these tables on this path,
 *    and every write below filters on `owner_id` explicitly. A
 *    `highlight`-scoped control additionally re-reads the Highlight and refuses
 *    unless the caller owns it: without that, any authenticated user could
 *    write a KEEP_PRIVATE_FOREVER row naming somebody else's Highlight and,
 *    because `readResurfacingSuppressions` keys on (control, subject_id) for a
 *    batch of owners, that row would suppress a stranger's Highlight on the
 *    stranger's own feed. That is a denial-of-service written as a preference.
 *
 * 2. SCOPE IS DERIVED FROM `CONTROL_EFFECTS`, NEVER PASSED IN. Migration 2720's
 *    CHECK constraint pins (control, subject_type) in the database; deriving
 *    the same pairing here from the one table that already declares it means a
 *    seventh control added tomorrow cannot be written with the wrong scope by
 *    a caller that forgot to update a second list. The database CHECK stays the
 *    backstop, and this is the thing that makes the error a 400 with a sentence
 *    rather than a 500 with a constraint name.
 *
 * 3. AN ABSENT TABLE IS NOT A FAILED WRITE. `probeHighlightObject` answers
 *    three ways, and the read side already treats `absent` as "this control is
 *    not deployed" rather than "nothing is suppressed". The write side needs
 *    the same distinction for the opposite reason: reporting 200 for a control
 *    that was never stored would tell a user their Memory is protected when it
 *    is not. `absent` refuses with `feature_disabled`, `unreadable` refuses
 *    with `degraded_unavailable`, and neither is reported as success.
 *
 * 4. A WRITE THAT AFFECTS NO ROW IS NOT A SUCCESS. supabase-js resolves an
 *    RLS-filtered or predicate-missed write as `{ data: null, error: null }`,
 *    which is indistinguishable from a completed one unless the caller asked
 *    for the row back. Every write here `.select()`s and treats an empty result
 *    as a refusal — the same rule `rebuildProjection` already applies at
 *    services/memoryProjections/derivativeRegistry.ts for the same reason.
 *
 * ── WHAT THIS MODULE DELIBERATELY DOES NOT DO ──────────────────────────────
 * It does not invent a default. A Highlight with no policy row has `unknown`
 * consent and an unset precision rung, which `highlightProjectionPolicy.ts`
 * already distinguishes from a stored value, and writing a row full of
 * defaults the user never chose would destroy that distinction on the very
 * first save. A field the caller does not name is left exactly as it was.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { probeHighlightObject, type ObjectAvailability } from "./highlightSchemaAvailability.js";
import {
  CONTROL_EFFECTS,
  RESURFACING_TABLE,
  RESURFACING_COLUMNS,
  isResurfacingControl,
  type ResurfacingControl,
} from "./highlightResurfacing.js";
import {
  PROJECTION_POLICY_TABLE,
  PROJECTION_POLICY_COLUMNS,
  isLocationPrecision,
  isPersonVisibility,
  MEMORY_CONSENT_DIMENSIONS,
  type LocationPrecisionRung,
  type PersonVisibilityRung,
  type MemoryConsentDimension,
} from "./highlightProjectionPolicy.js";

/* ============================================================================
 * The result shape.
 *
 * A discriminated refusal rather than a thrown error or a boolean, because the
 * route has to tell four outcomes apart and map each to a DIFFERENT status:
 * "you do not own that" (403) is not "that does not exist" (404) is not "this
 * control is not deployed" (404 feature_disabled) is not "the database is
 * unreachable" (503). Collapsing any pair would make one of them silently
 * retryable or silently permanent.
 * ==========================================================================*/

export type ControlWriteFailure =
  | "not_deployed"
  | "unavailable"
  | "invalid"
  | "not_owned"
  | "write_unconfirmed";

export type ControlWriteResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: ControlWriteFailure; readonly detail: string };

function fail(reason: ControlWriteFailure, detail: string): ControlWriteResult<never> {
  return { ok: false, reason, detail };
}

/** `absent` and `unreadable` are different refusals. Mapped once, here. */
function refusalFor(table: string, availability: ObjectAvailability): ControlWriteResult<never> | null {
  if (availability.state === "ready") return null;
  if (availability.state === "absent") {
    return fail("not_deployed", `${table} is not deployed on this database: ${availability.reason}`);
  }
  return fail("unavailable", availability.reason);
}

/* ============================================================================
 * §11 — the six resurfacing controls
 * ==========================================================================*/

export interface StoredControl {
  readonly control: ResurfacingControl;
  readonly subjectType: "highlight" | "person" | "trip" | "owner";
  readonly subjectId: string;
  readonly createdAt: string | null;
}

/**
 * The scope migration 2720's CHECK constraint requires for a control, derived
 * from the same declaration the read path uses.
 */
export function subjectTypeFor(control: ResurfacingControl): "highlight" | "person" | "trip" | "owner" {
  return CONTROL_EFFECTS[control].scope;
}

/**
 * Every control this owner has set, with the surfaces each suppresses.
 *
 * The `.error` binding is load-bearing for the same reason it is on the read
 * path: an unbound one answers "you have set no controls" for an outage, and a
 * user who then sets the control again gets a duplicate-key error for a row
 * they were just told does not exist.
 */
export async function listResurfacingControls(
  sc: SupabaseClient | any,
  ownerId: string,
): Promise<ControlWriteResult<readonly StoredControl[]>> {
  const availability = await probeHighlightObject(sc, RESURFACING_TABLE, RESURFACING_COLUMNS);
  const refused = refusalFor(RESURFACING_TABLE, availability);
  if (refused) return refused;

  try {
    const { data, error } = await sc
      .from("highlight_resurfacing_preferences")
      .select([...RESURFACING_COLUMNS, "created_at"].join(", "))
      .eq("owner_id", ownerId);
    if (error) return fail("unavailable", `${RESURFACING_TABLE} read failed: ${String(error?.message ?? error)}`);
    const out: StoredControl[] = [];
    for (const r of (data ?? []) as Array<Record<string, unknown>>) {
      const control = r.control;
      if (!isResurfacingControl(control)) {
        // Same posture as the read path: an unrecognised control is a policy
        // row that means something to whoever wrote it. Returning a partial
        // list that LOOKS complete would let a user conclude they had cleared
        // something they had not.
        return fail("unavailable", `${RESURFACING_TABLE} holds an unrecognised control ${JSON.stringify(control)}`);
      }
      out.push({
        control,
        subjectType: String(r.subject_type) as StoredControl["subjectType"],
        subjectId: String(r.subject_id),
        createdAt: typeof r.created_at === "string" ? r.created_at : null,
      });
    }
    return { ok: true, value: out };
  } catch (err) {
    return fail("unavailable", `${RESURFACING_TABLE} read threw: ${String((err as any)?.message ?? err)}`);
  }
}

/**
 * Does `ownerId` own Highlight `highlightId`, and is it still there?
 *
 * Deleted rows do NOT count. A control naming a deleted Highlight is a row that
 * can never suppress anything and can never be cleared through the surface that
 * lists live Highlights, so it would accumulate silently.
 */
async function ownsHighlight(
  sc: SupabaseClient | any,
  ownerId: string,
  highlightId: string,
): Promise<ControlWriteResult<true>> {
  try {
    const { data, error } = await sc
      .from("highlights")
      .select("id, owner_id, deleted_at")
      .eq("id", highlightId)
      .is("deleted_at", null)
      .limit(1);
    if (error) return fail("unavailable", `highlights read failed: ${String(error?.message ?? error)}`);
    const rows = (data ?? []) as Array<Record<string, unknown>>;
    if (rows.length === 0) return fail("not_owned", "highlight not found");
    // "Not yours" and "not there" are the SAME answer to this caller on
    // purpose: distinguishing them turns this endpoint into an oracle for
    // whether an arbitrary UUID is a live Highlight belonging to somebody else.
    if (rows[0].owner_id !== ownerId) return fail("not_owned", "highlight not found");
    return { ok: true, value: true };
  } catch (err) {
    return fail("unavailable", `highlights read threw: ${String((err as any)?.message ?? err)}`);
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Set one §11 control.
 *
 * Idempotent by construction: migration 2720's unique index is
 * (owner_id, control, subject_type, subject_id), so setting the same control
 * twice is the same control. The upsert names that index rather than relying on
 * the primary key, because the primary key is a generated UUID and an upsert
 * keyed on it would insert a duplicate every time.
 */
export async function setResurfacingControl(
  sc: SupabaseClient | any,
  ownerId: string,
  control: unknown,
  subjectId: unknown,
): Promise<ControlWriteResult<StoredControl>> {
  if (!isResurfacingControl(control)) {
    return fail("invalid", `unknown control ${JSON.stringify(control)}`);
  }
  if (typeof subjectId !== "string" || !UUID_RE.test(subjectId)) {
    return fail("invalid", "subjectId must be a UUID");
  }
  const subjectType = subjectTypeFor(control);

  const availability = await probeHighlightObject(sc, RESURFACING_TABLE, RESURFACING_COLUMNS);
  const refused = refusalFor(RESURFACING_TABLE, availability);
  if (refused) return refused;

  // A highlight-scoped control names a Highlight, so the Highlight is checked.
  // A person- or trip-scoped control names somebody else's id and is a
  // statement about the OWNER'S OWN surfaces — "stop showing me this person" —
  // so there is nothing of theirs to own and nothing to verify beyond the
  // shape. Checking a person id against `profiles` here would turn the
  // endpoint into a user-existence oracle and buy nothing: a control naming a
  // person who does not exist suppresses nothing.
  if (subjectType === "highlight") {
    const owned = await ownsHighlight(sc, ownerId, subjectId);
    if (!owned.ok) return owned;
  }

  const row = { owner_id: ownerId, control, subject_type: subjectType, subject_id: subjectId };
  try {
    const { data, error } = await sc
      .from("highlight_resurfacing_preferences")
      .upsert(row, { onConflict: "owner_id,control,subject_type,subject_id" })
      .select([...RESURFACING_COLUMNS, "created_at"].join(", "));
    if (error) return fail("unavailable", `${RESURFACING_TABLE} write failed: ${String(error?.message ?? error)}`);
    const written = (data ?? []) as Array<Record<string, unknown>>;
    if (written.length === 0) {
      // No error and no row. See rule 4 in the header: this is what an
      // RLS-filtered write looks like, and reporting it as stored would tell a
      // user their Memory is protected when nothing was written.
      return fail("write_unconfirmed", `${RESURFACING_TABLE} upsert affected no rows`);
    }
    return {
      ok: true,
      value: {
        control,
        subjectType,
        subjectId,
        createdAt: typeof written[0].created_at === "string" ? (written[0].created_at as string) : null,
      },
    };
  } catch (err) {
    return fail("unavailable", `${RESURFACING_TABLE} write threw: ${String((err as any)?.message ?? err)}`);
  }
}

/**
 * Clear one §11 control.
 *
 * §21 lists these as RETAIN operations, all of which are reversible — none of
 * them is a delete, and a control a user cannot undo is a trap rather than a
 * preference. KEEP_PRIVATE_FOREVER is the one whose NAME argues otherwise, so
 * clearing it requires `confirmed`, which the route only sets when the caller
 * sent it explicitly. That is a speed bump on the strongest control, not a
 * different rule: the alternative — an irreversible control set by one tap —
 * would make a mistap permanent.
 *
 * The delete is SCOPED TO THE OWNER as well as to the subject. Without the
 * `owner_id` filter this would clear a matching control belonging to anybody,
 * because (control, subject_id) is not unique across owners.
 */
export async function clearResurfacingControl(
  sc: SupabaseClient | any,
  ownerId: string,
  control: unknown,
  subjectId: unknown,
  opts: { readonly confirmed?: boolean } = {},
): Promise<ControlWriteResult<{ readonly cleared: boolean }>> {
  if (!isResurfacingControl(control)) {
    return fail("invalid", `unknown control ${JSON.stringify(control)}`);
  }
  if (typeof subjectId !== "string" || !UUID_RE.test(subjectId)) {
    return fail("invalid", "subjectId must be a UUID");
  }
  if (control === "KEEP_PRIVATE_FOREVER" && opts.confirmed !== true) {
    return fail("invalid", "clearing KEEP_PRIVATE_FOREVER requires an explicit confirmation");
  }
  const subjectType = subjectTypeFor(control);

  const availability = await probeHighlightObject(sc, RESURFACING_TABLE, RESURFACING_COLUMNS);
  const refused = refusalFor(RESURFACING_TABLE, availability);
  if (refused) return refused;

  try {
    const { data, error } = await sc
      .from("highlight_resurfacing_preferences")
      .delete()
      .eq("owner_id", ownerId)
      .eq("control", control)
      .eq("subject_type", subjectType)
      .eq("subject_id", subjectId)
      .select("id");
    if (error) return fail("unavailable", `${RESURFACING_TABLE} delete failed: ${String(error?.message ?? error)}`);
    const removed = (data ?? []) as unknown[];
    // Zero rows is reported as `cleared: false` rather than as a failure. The
    // control is not set, which is the state the caller asked for; a 404 would
    // make "clear" non-idempotent and a retry after a dropped response would
    // look like an error.
    return { ok: true, value: { cleared: removed.length > 0 } };
  } catch (err) {
    return fail("unavailable", `${RESURFACING_TABLE} delete threw: ${String((err as any)?.message ?? err)}`);
  }
}

/* ============================================================================
 * §10 — the projection policy: location precision, person visibility, consent
 * ==========================================================================*/

export interface ProjectionPolicyPatch {
  readonly locationPrecision?: LocationPrecisionRung | null;
  readonly personVisibility?: PersonVisibilityRung | null;
  readonly consent?: Partial<Record<MemoryConsentDimension, boolean | null>>;
}

export interface StoredProjectionPolicy {
  readonly highlightId: string;
  readonly locationPrecision: LocationPrecisionRung | null;
  readonly personVisibility: PersonVisibilityRung | null;
  readonly consent: Record<MemoryConsentDimension, boolean | null>;
}

function policyFromRow(highlightId: string, row: Record<string, unknown> | null): StoredProjectionPolicy {
  const consent = {} as Record<MemoryConsentDimension, boolean | null>;
  for (const d of MEMORY_CONSENT_DIMENSIONS) {
    // The column is `consent_store`, the dimension is `STORE`. The casing is
    // `consentFromRow`'s and is reproduced here from the same source rather
    // than retyped, so a dimension added tomorrow lands in the same column the
    // reader looks in. Getting this wrong is silent: an unknown column name
    // reads as `undefined`, which becomes `null`, which is `unknown`, which
    // REFUSES — a policy that looks stored and denies everything.
    const v = row?.[`consent_${d.toLowerCase()}`];
    consent[d] = typeof v === "boolean" ? v : null;
  }
  const lp = row?.location_precision;
  const pv = row?.person_visibility;
  return {
    highlightId,
    locationPrecision: isLocationPrecision(lp) ? lp : null,
    personVisibility: isPersonVisibility(pv) ? pv : null,
    consent,
  };
}

/**
 * Read one Highlight's §10 policy, owner-scoped.
 *
 * A Highlight with NO row answers with every field null, which is the honest
 * answer and is exactly what the read path treats as "unset" — not as a stored
 * default. A missing row and a row of nulls are the same policy; a missing row
 * and a failed read are not, and the second refuses.
 */
export async function readProjectionPolicyForOwner(
  sc: SupabaseClient | any,
  ownerId: string,
  highlightId: string,
): Promise<ControlWriteResult<StoredProjectionPolicy>> {
  if (typeof highlightId !== "string" || !UUID_RE.test(highlightId)) {
    return fail("invalid", "highlightId must be a UUID");
  }
  const owned = await ownsHighlight(sc, ownerId, highlightId);
  if (!owned.ok) return owned;

  const availability = await probeHighlightObject(sc, PROJECTION_POLICY_TABLE, PROJECTION_POLICY_COLUMNS);
  const refused = refusalFor(PROJECTION_POLICY_TABLE, availability);
  if (refused) return refused;

  try {
    const { data, error } = await sc
      .from("highlight_projection_policies")
      .select(PROJECTION_POLICY_COLUMNS.join(", "))
      .eq("highlight_id", highlightId)
      .eq("owner_id", ownerId)
      .limit(1);
    if (error) return fail("unavailable", `${PROJECTION_POLICY_TABLE} read failed: ${String(error?.message ?? error)}`);
    const rows = (data ?? []) as Array<Record<string, unknown>>;
    return { ok: true, value: policyFromRow(highlightId, rows[0] ?? null) };
  } catch (err) {
    return fail("unavailable", `${PROJECTION_POLICY_TABLE} read threw: ${String((err as any)?.message ?? err)}`);
  }
}

/**
 * Set the §10 policy for one Highlight the caller owns.
 *
 * PARTIAL BY DESIGN. Only the fields the caller NAMED are written. The
 * alternative — send the whole policy every time — means a client built before
 * a seventh consent dimension existed silently resets it to `unknown` on every
 * save, and `unknown` REFUSES (`mayProject` returns false only for `granted`),
 * so the bug would present as a Highlight that quietly stopped being
 * projectable with nobody having chosen that.
 *
 * Validation is by the same predicates the read path uses. A rung outside the
 * ladder is a 400 here rather than a CHECK violation at the database, and the
 * ladders are imported rather than retyped so that adding a rung cannot leave
 * the writer rejecting a value the reader understands.
 */
export async function setProjectionPolicy(
  sc: SupabaseClient | any,
  ownerId: string,
  highlightId: string,
  patch: ProjectionPolicyPatch,
): Promise<ControlWriteResult<StoredProjectionPolicy>> {
  if (typeof highlightId !== "string" || !UUID_RE.test(highlightId)) {
    return fail("invalid", "highlightId must be a UUID");
  }

  const update: Record<string, unknown> = {};
  if (patch.locationPrecision !== undefined) {
    if (patch.locationPrecision !== null && !isLocationPrecision(patch.locationPrecision)) {
      return fail("invalid", `unknown location precision ${JSON.stringify(patch.locationPrecision)}`);
    }
    update.location_precision = patch.locationPrecision;
  }
  if (patch.personVisibility !== undefined) {
    if (patch.personVisibility !== null && !isPersonVisibility(patch.personVisibility)) {
      return fail("invalid", `unknown person visibility ${JSON.stringify(patch.personVisibility)}`);
    }
    update.person_visibility = patch.personVisibility;
  }
  for (const [dimension, value] of Object.entries(patch.consent ?? {})) {
    if (!(MEMORY_CONSENT_DIMENSIONS as readonly string[]).includes(dimension)) {
      return fail("invalid", `unknown consent dimension ${JSON.stringify(dimension)}`);
    }
    if (value !== null && typeof value !== "boolean") {
      // Three states, and the third one is spelled `null`. A string "unknown"
      // or a missing key would both land in the column as NULL by accident
      // rather than by decision.
      return fail("invalid", `consent.${dimension} must be true, false or null`);
    }
    update[`consent_${dimension.toLowerCase()}`] = value;
  }
  if (Object.keys(update).length === 0) {
    return fail("invalid", "no policy field was named; send at least one");
  }

  const owned = await ownsHighlight(sc, ownerId, highlightId);
  if (!owned.ok) return owned;

  const availability = await probeHighlightObject(sc, PROJECTION_POLICY_TABLE, PROJECTION_POLICY_COLUMNS);
  const refused = refusalFor(PROJECTION_POLICY_TABLE, availability);
  if (refused) return refused;

  // Read-modify-write against the UNIQUE highlight_id, because the patch is
  // partial and an upsert of only the named columns would null every column the
  // caller did not send. The existing row is read first and merged here, so a
  // save that names one field leaves the other six exactly as they were.
  const existing = await readProjectionPolicyForOwner(sc, ownerId, highlightId);
  if (!existing.ok) return existing;

  const merged: Record<string, unknown> = {
    highlight_id: highlightId,
    owner_id: ownerId,
    location_precision: existing.value.locationPrecision,
    person_visibility: existing.value.personVisibility,
    updated_at: new Date().toISOString(),
  };
  for (const d of MEMORY_CONSENT_DIMENSIONS) merged[`consent_${d.toLowerCase()}`] = existing.value.consent[d];
  Object.assign(merged, update);

  try {
    const { data, error } = await sc
      .from("highlight_projection_policies")
      .upsert(merged, { onConflict: "highlight_id" })
      .select(PROJECTION_POLICY_COLUMNS.join(", "));
    if (error) return fail("unavailable", `${PROJECTION_POLICY_TABLE} write failed: ${String(error?.message ?? error)}`);
    const written = (data ?? []) as Array<Record<string, unknown>>;
    if (written.length === 0) return fail("write_unconfirmed", `${PROJECTION_POLICY_TABLE} upsert affected no rows`);
    return { ok: true, value: policyFromRow(highlightId, written[0]) };
  } catch (err) {
    return fail("unavailable", `${PROJECTION_POLICY_TABLE} write threw: ${String((err as any)?.message ?? err)}`);
  }
}
