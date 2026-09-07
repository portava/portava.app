/**
 * The capability registry — the ONE place a flag's schema requirement is
 * declared. See `schemaRequirement.ts` for why a registry and not the call
 * site.
 *
 * RULES FOR AN ENTRY (each is enforced by `capabilityRegistry.test.ts` or by
 * `scripts/checkFlagSchemaPrerequisites.ts`, not by convention):
 *
 *   1. `flag` is seeded by a migration. A capability over a phantom flag is a
 *      wall, not a gate (see flagPhantomReads.test.ts).
 *   2. Every required table/column/function is declared by a migration in
 *      the tree, and `providedBy` names the file(s). The refusal message
 *      tells the operator what to apply.
 *   3. `consumers` is non-empty and every listed file both names the flag and
 *      reaches this registry (directly or through a per-feature wrapper such
 *      as lib/media/mediaSchemaCapability.ts). A capability nobody consults
 *      is a producer with no consumer — the mistake this contract exists to
 *      end, and one this repository has already made several times.
 *   4. The requirement is what the guarded code ACTUALLY names. The ratchet
 *      compares the registry against the flag reads it finds in the tree and
 *      against the production snapshot; an entry whose requirement is already
 *      satisfied in production is fine (the probe answers `ready`), an entry
 *      that omits an object the code needs is the gap the ratchet reports.
 *
 * ADDING ONE. Copy the media entry. Then wire the consumer — the path that
 * would otherwise fail silently must call `resolveCapability` /
 * `requireCapability` (or a wrapper over `probeSchemaReadiness`) BEFORE it
 * builds a payload. Then add a test showing the refusal firing with the flag
 * ON and the schema absent. An entry without all three is not a capability;
 * it is a comment.
 */
import type { CapabilityDefinition } from "./schemaRequirement.js";

/** The `media_assets` columns migration 2250 adds. Nothing before it does. */
export const MEDIA_CANONICAL_ASSET_COLUMNS = [
  "captured_at",
  "location_visibility",
  "provenance",
  "intelligence_eligibility",
] as const;

/**
 * The canonical media writer (spec §6). THE founding case: TRUE in production
 * over a `media_assets` without 2250's columns; every upsert PGRST204, every
 * rejection swallowed, three weeks. Consumed by lib/mediaAssets.ts through
 * lib/media/mediaSchemaCapability.ts, which refuses before building a payload.
 *
 * NOT DECIDED HERE: whether production should get 2250/2470 or have the flag
 * turned off (OWNER DECISION REQUIRED: MEDIA_CANONICAL_FLAG). This entry makes
 * either order safe by making the dead-writer path unreachable and loud.
 */
export const MEDIA_CANONICAL: CapabilityDefinition = {
  flag: "media_canonical_enabled",
  providedBy: [
    "2250_media_asset_canonical_model.sql",
    "2470_media_asset_canonical_columns_flag_agnostic.sql (the same DDL without 2250's flag postcondition)",
  ],
  requires: {
    tables: {
      media_assets: { columns: MEDIA_CANONICAL_ASSET_COLUMNS },
    },
  },
  consumers: ["lib/mediaAssets.ts"],
  note:
    "A canonical media write that vanishes costs the user their upload's §6 record; " +
    "refusing keeps the legacy post_media/media_urls path authoritative until the columns exist.",
};

/** flag → definition. The ratchet and the tests enumerate this. */
export const CAPABILITIES: Readonly<Record<string, CapabilityDefinition>> = Object.freeze({
  [MEDIA_CANONICAL.flag]: MEDIA_CANONICAL,
});

export function capabilityFor(flag: string): CapabilityDefinition | null {
  return CAPABILITIES[flag] ?? null;
}
