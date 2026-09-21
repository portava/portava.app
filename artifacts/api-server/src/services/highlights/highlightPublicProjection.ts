/**
 * §10 / §11 — THE NON-OWNER GATE.
 *
 * Before this module, two of the owner's stored decisions were enforced on the
 * two proactive feeds and NOWHERE ELSE:
 *
 *   - `KEEP_PRIVATE_FOREVER`, which CONTROL_EFFECTS declares to suppress
 *     `public_projection`, was consulted by GET /highlights/active and
 *     GET /highlights/following-feed only. A stranger could still list the
 *     Highlight on the owner's profile (GET /users/:userId/highlights), reach it
 *     through every engagement route behind `resolveViewAccess` (view, like,
 *     unlike, reply, report), and share it into a Telegraph thread.
 *   - The five §10 consent columns migration 2721 provides were STORED by the
 *     writer and READ by no surface at all: `mayProject` had zero callers.
 *
 * `highlightRevocation.ts` names `public_projection` as a revocation
 * DESTINATION — the owner is told that the control reaches it. This module is
 * what makes that true. It is the single place a non-owner surface asks
 * "may this Highlight be shown to this viewer, given the owner's controls and
 * consent?", so that the three surface families cannot drift apart.
 *
 * ── TWO SURFACES, TWO CONSENT DIMENSIONS ───────────────────────────────────
 *
 * `proactive_resurfacing` — the feeds. Portava chose to show the Highlight; the
 * viewer did not ask for it. Both RESURFACE and SHARE consent apply: a feed
 * resurfaces, and it resurfaces TO OTHER PEOPLE.
 *
 * `public_projection` — a viewer who navigated to the owner's profile, acted on
 * a specific Highlight, or dropped it into a thread. Only SHARE applies:
 * nothing was resurfaced, the viewer went and got it.
 *
 * ── EXPLICIT-FALSE-ONLY, AND WHY THIS IS NOT `mayProject` ──────────────────
 *
 * `mayProject(state)` in highlightProjectionPolicy.ts refuses on `unknown`, and
 * that is pinned by test: for a projection DERIVED from the private record
 * (aggregate intelligence, a public derivative) silence is not consent. This
 * module deliberately does NOT apply that rule, and the difference is what
 * `highlights.visibility` already is. The owner chose `public` on the row: that
 * IS the audience decision for the row as stored. A NULL consent column means
 * the owner has not been asked the finer question, and answering it for them
 * with "no" would blank every Highlight in production off every non-owner
 * surface the day this shipped — 2721 was applied on 2026-09-15 to a table
 * with zero rows. So here: a stored `false` WITHHOLDS; a stored `true` or a
 * NULL defers to the row's visibility, which the caller has already checked.
 * `consentWithholds` is that rule stated once.
 *
 * ── POSTURES, THE SAME THREE THE READ LAYER HAS ────────────────────────────
 *
 * `unreadable` (either table) → REFUSE for a non-owner. A `consent_share=false`
 * or a `KEEP_PRIVATE_FOREVER` we cannot read is a refusal we would be
 * overriding, and `isSuppressed` already answers `true` on an unreadable set
 * for exactly that reason. `absent` → UNENFORCED, and the caller is handed the
 * fact so it can log it: the control is not deployed, nothing could have been
 * set, and blacking out a live surface on the strength of a migration nobody
 * ran is the over-suppression `applyResurfacingControls` refuses too.
 *
 * THE OWNER IS NEVER REFUSED. Every §11 control retains the record (CONTROL_EFFECTS
 * `retainsRecord: true`), §21 keeps explicit retrieval by the owner unaffected,
 * and consent is the owner's decision about OTHER people.
 *
 * Trip-scoped controls (HIDE_TRIP) are not resolvable on `public.highlights`
 * (no trip column — census H90) and are excluded the same way
 * FEED_ENFORCEABLE_CONTROLS excludes them. HIDE_TRIP does not suppress
 * `public_projection` in any case.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CONTROL_EFFECTS,
  RESURFACING_CONTROLS,
  feedSubjectScope,
  isSuppressed,
  readResurfacingSuppressionsForOwners,
  type ResurfacingControl,
  type ResurfacingSuppressions,
  type SuppressibleSurface,
} from "./highlightResurfacing.js";
import {
  consentFromRow,
  readProjectionPolicies,
  type MemoryConsentDimension,
  type ProjectionPolicyRead,
} from "./highlightProjectionPolicy.js";

/** The two ways a Highlight reaches somebody who does not own it. */
export const NON_OWNER_SURFACES = ["proactive_resurfacing", "public_projection"] as const;
export type NonOwnerSurface = (typeof NON_OWNER_SURFACES)[number];

/** Which §10 consent dimensions each surface must not have been refused. */
export const SURFACE_CONSENT_DIMENSIONS: Readonly<Record<NonOwnerSurface, readonly MemoryConsentDimension[]>> =
  Object.freeze({
    proactive_resurfacing: ["RESURFACE", "SHARE"],
    public_projection: ["SHARE"],
  });

/**
 * The §11 controls a surface over `public.highlights` can enforce for this
 * suppressible surface. DERIVED from CONTROL_EFFECTS, for the reason
 * FEED_ENFORCEABLE_CONTROLS gives: a list retyped beside the table was wrong
 * once already.
 */
export function controlsSuppressing(surface: SuppressibleSurface): readonly ResurfacingControl[] {
  return RESURFACING_CONTROLS.filter(
    (c) =>
      (CONTROL_EFFECTS[c].suppresses as readonly SuppressibleSurface[]).includes(surface) &&
      CONTROL_EFFECTS[c].scope !== "trip",
  );
}

/**
 * Does a stored policy row REFUSE this dimension? Only an explicit `false`.
 * See the header: this is deliberately not `!mayProject(...)`.
 */
export function consentWithholds(row: unknown, dimension: MemoryConsentDimension): boolean {
  return consentFromRow(row, dimension) === "withheld";
}

export type ProjectionVerdict =
  | { readonly allow: true }
  | {
      readonly allow: false;
      /** `suppressed`: a §11 control. `withheld`: a §10 consent. `unreadable`: could not tell. */
      readonly kind: "suppressed" | "withheld" | "unreadable";
      readonly reason: string;
    };

export interface ProjectionInputs {
  readonly controls: ResurfacingSuppressions;
  readonly policies: ProjectionPolicyRead;
}

/**
 * May `h` be shown to `viewerId` on `surface`?
 *
 * Pure. The caller has ALREADY applied blocks, `canViewHighlight` and the
 * lifetime filters; this answers only the question those do not ask.
 */
export function publicProjectionVerdict(
  h: { readonly id: string; readonly owner_id: string },
  viewerId: string | null | undefined,
  surface: NonOwnerSurface,
  inputs: ProjectionInputs,
): ProjectionVerdict {
  if (viewerId != null && viewerId === h.owner_id) return { allow: true };

  const { controls, policies } = inputs;

  if (controls.state === "unreadable") {
    return { allow: false, kind: "unreadable", reason: `§11 controls unreadable: ${controls.reason}` };
  }
  if (controls.state === "ready") {
    for (const c of controlsSuppressing(surface)) {
      const subject = feedSubjectScope(c) === "highlight" ? h.id : h.owner_id;
      if (isSuppressed(controls, c, subject)) {
        return { allow: false, kind: "suppressed", reason: `${c} is set on ${feedSubjectScope(c)} ${subject}` };
      }
    }
  }

  if (policies.state === "unreadable") {
    return { allow: false, kind: "unreadable", reason: `§10 policy unreadable: ${policies.reason}` };
  }
  if (policies.state === "ready") {
    const row = policies.byHighlightId.get(h.id);
    for (const d of SURFACE_CONSENT_DIMENSIONS[surface]) {
      if (consentWithholds(row, d)) {
        return { allow: false, kind: "withheld", reason: `consent_${d.toLowerCase()} is false on ${h.id}` };
      }
    }
  }

  return { allow: true };
}

/** The degraded postures a caller should log. Empty when both reads were `ready`. */
export function projectionPostureNotes(inputs: ProjectionInputs): readonly string[] {
  const out: string[] = [];
  if (inputs.controls.state !== "ready") out.push(`§11 controls ${inputs.controls.state}: ${inputs.controls.reason}`);
  if (inputs.policies.state !== "ready") out.push(`§10 policies ${inputs.policies.state}: ${inputs.policies.reason}`);
  return out;
}

type Log = { error: (obj: unknown, msg: string) => void } | undefined;

/**
 * Filter a page. Logs each degraded posture ONCE per call — `absent` because
 * the surface is being served without a control the code believes in, and
 * `unreadable` because every non-owner row on the page is about to be
 * withheld and the operator should know why.
 */
export function filterProjectable<T extends { id: string; owner_id: string }>(
  rows: readonly T[],
  viewerId: string | null | undefined,
  surface: NonOwnerSurface,
  inputs: ProjectionInputs,
  log: Log,
  where: string,
): T[] {
  const notes = projectionPostureNotes(inputs);
  if (notes.length > 0) {
    const withholding = inputs.controls.state === "unreadable" || inputs.policies.state === "unreadable";
    log?.error(
      { notes, where, surface },
      withholding
        ? "highlights: §10/§11 owner decisions UNREADABLE — withholding every Highlight the viewer does not own rather than overriding a refusal we cannot see"
        : "highlights: §10/§11 owner decisions NOT DEPLOYED on this database — surface served without them",
    );
  }
  return rows.filter((h) => publicProjectionVerdict(h, viewerId, surface, inputs).allow);
}

/**
 * Both reads, in parallel. `sc == null` is `unreadable` on both, for the reason
 * `readProjectionPolicies` gives: there IS a control and we cannot see it.
 */
export async function readProjectionInputs(
  sc: SupabaseClient | any | null,
  ownerIds: readonly string[],
  highlightIds: readonly string[],
): Promise<ProjectionInputs> {
  if (sc == null) {
    const reason = "no service client is configured";
    return {
      controls: { state: "unreadable", reason },
      policies: { state: "unreadable", reason },
    };
  }
  const [controls, policies] = await Promise.all([
    readResurfacingSuppressionsForOwners(sc, ownerIds),
    readProjectionPolicies(sc, highlightIds),
  ]);
  return { controls, policies };
}
