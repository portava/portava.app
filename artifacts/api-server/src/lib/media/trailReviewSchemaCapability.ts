/**
 * trailReviewSchemaCapability — the lib/capability guard for the one column the
 * media side names out of migration 3977 (lead ruling D-66, "review before
 * visible"): `trails.review_state`.
 *
 * THE STATE IT GUARDS
 * ===================
 * services/media/MediaActionResolver.ts reads a Trail's review state at two
 * doors, because D-66 lets only an APPROVED Trail reach a viewer:
 *   - `compileExperiencePlan` (the plan compiler behind
 *     GET /media/experiences/:id/plan?compile=1 and the Compass tool
 *     compile_plan_from_experience), and
 *   - `withTrailDoThisAction` (the "Do this trail" action on the media rail).
 * 3977 is applied on portava-ci and on NO production database (the committed
 * snapshot has `trails` without the column, and production-applied-migrations
 * does not list 3977). On such a database a select naming `review_state` is
 * rejected whole (42703 / PGRST204): the rail's action vanished without a word
 * and the compiler answered db_error. check:flag-schema-prerequisites charges
 * both doors to COMPASS_ENABLED, which is ON in production.
 *
 * THE GUARD
 * =========
 * Each door asks `probeTrailReviewState(sc)` BEFORE it names the column:
 *   ready       — name it, and serve only a Trail that trailIsPublic() admits;
 *   absent      — refuse: no action on the rail, `source_unavailable` from the
 *                 compiler (the probe found the column, or the table, missing);
 *   unreadable  — refuse: no action, `source_unreadable` (the probe failed for
 *                 any other reason).
 * A Trail whose review state cannot be read is never treated as approved:
 * D-66 fails CLOSED. The probe is lib/capability's (one sentinel SELECT,
 * memoised per client: `ready` for 5 minutes, the refusals for 30 seconds, and
 * every refusal logged at ERROR naming 3977), so a database that gains 3977 is
 * picked up without a restart and a database without it is not re-asked on
 * every request.
 *
 * SCHEMA HALF ONLY
 * ================
 * Reading a Trail's review state is behind no flag of its own: an approved
 * Trail is visible whether or not new Trails can be started. So this capability
 * is consulted through `probeSchemaReadiness` and NEVER through
 * resolveCapability / requireCapability, which would add a flag read.
 * `flag` names 3977's own seeded flag (`trail_creation_enabled`) only because
 * the contract's id is a flag name: it keys the memo and labels the log line,
 * and it is unique among the capability definitions in the tree.
 *
 * NOT IN THE REGISTRY, deliberately (the MAP_TRIP_PROJECTION_CAPABILITY
 * precedent in lib/capability/registry.ts). The registry is keyed by flag. The
 * flag both doors sit under is COMPASS_ENABLED, and that key belongs to
 * COMPASS_CONVERSATION_PHASE1, whose probe must not couple Compass
 * conversations to Trails: adding `trails.review_state` there would put every
 * conversation on the legacy shape on a database without 3977, and a second
 * definition keyed COMPASS_ENABLED would share its memo slot. The ratchet
 * records the state instead as KNOWN.COMPASS_ENABLED, `guarded`, and reports it
 * STALE the day 3977 reaches production — the only way that entry may go.
 *
 * It adds nothing of its own: the wrapper is a rename over the generic probe,
 * as lib/media/mediaSchemaCapability.ts is for the canonical media writer.
 */
import { probeSchemaReadiness } from "../capability/schemaCapability.js";
import type { CapabilityDefinition } from "../capability/schemaRequirement.js";

/** The `trails` column migration 3977 adds that the media doors name. */
export const TRAIL_REVIEW_STATE_COLUMNS = ["review_state"] as const;

export const TRAIL_REVIEW_STATE: CapabilityDefinition = {
  flag: "trail_creation_enabled",
  providedBy: ["3977_trail_review_before_visible.sql"],
  requires: {
    tables: {
      trails: { columns: TRAIL_REVIEW_STATE_COLUMNS },
    },
  },
  consumers: ["services/media/MediaActionResolver.ts"],
  note:
    "A Trail whose review state cannot be read is not known to be approved (lead ruling D-66, review before visible); " +
    "refusing keeps every Trail off the media rail and out of the plan compiler on a database without 3977, " +
    "instead of a rejected select that dropped the action silently and answered db_error.",
};

export type TrailReviewSchema = "ready" | "absent" | "unreadable";

/**
 * May a door name `trails.review_state` on the database behind `sc`?
 * NEVER THROWS (probeSchemaReadiness never does). Only `ready` permits the
 * read; `absent` and `unreadable` both refuse.
 */
export async function probeTrailReviewState(sc: any): Promise<TrailReviewSchema> {
  const r = await probeSchemaReadiness(sc, TRAIL_REVIEW_STATE);
  if (r.state === "ready") return "ready";
  return r.state === "missing" ? "absent" : "unreadable";
}
