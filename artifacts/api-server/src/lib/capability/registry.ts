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
import { SCHEMA_PROBE_SENTINEL_ID, type CapabilityDefinition } from "./schemaRequirement.js";
import { DISCOVERY_TRIP_PROJECTION } from "../discoveryTripProjectionConsumer.js";
import { TRIP_OPERATIONAL_PROJECTIONS } from "../tripOperationalProjections.js";

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

/**
 * The `locate_friends_members` columns the §5 crew-presence reader names.
 * Migration 2219 creates the table; nothing before it does.
 */
export const LOCATE_FRIENDS_MEMBER_COLUMNS = ["session_id", "user_id", "left_at"] as const;

/** The `locate_friends_sessions` columns that same reader names. */
export const LOCATE_FRIENDS_SESSION_COLUMNS = ["id", "started_at", "expires_at", "ended_at"] as const;

/**
 * Locate My Friends (Map spec §12) storage, read from OUTSIDE Locate My
 * Friends — by the Passport assembler's §5 `with_crew` traveler-state signal.
 *
 * WHY THIS ENTRY EXISTS
 * =====================
 * `services/passport/PassportProjectionService.ts` selected
 * `locate_friends_members` and `locate_friends_sessions` with NO consultation
 * of `locate_friends_enabled` and no schema probe. Because the Passport
 * assembler is shared, that read was on the path of every consumer variant —
 * including the Safe Return safety projection
 * (`routes/safeReturn.ts` → `buildConsumerProjection(db, "safety", …)`), which
 * projects handle/verified/blocked and DISCARDS the traveler state entirely.
 * Safe Return therefore carried a cross-feature read of a disabled feature's
 * storage whose result it could not use. Applying 2219 to production on
 * 2026-09-08 made that read succeed; it did not make it authorised.
 *
 * 2219's own header states the read contract this violated: "There is no view,
 * no RPC and no anon grant that lists sessions or finds members by proximity"
 * and "the API resolves the caller's membership per request before returning
 * anything." The Passport reader resolved no membership at all, and answered a
 * viewer who is not in the session.
 *
 * WHAT REFUSING PROTECTS. `with_crew` says "this person is, right now, inside a
 * temporary group location-sharing session, which started at X and expires at
 * Y". That is Map spec §23 purpose-bound Presence derived from Locate My
 * Friends storage. With the flag FALSE the feature is dark, so the only honest
 * answer is that Passport knows of no crew session — not a state read out of
 * storage the feature is not currently allowed to serve.
 *
 * NOT DECIDED HERE: whether Passport may surface crew membership to a viewer
 * who is NOT a member of that session once the flag is on at all
 * (OWNER DECISION REQUIRED: PASSPORT_CREW_PRESENCE_AUDIENCE — Passport spec §5
 * lists "With Crew" as a projected state; 2219 says every read resolves the
 * caller's membership first, and those do not agree). The consumer implements
 * the tighter of the two readings in the meantime: the signal is loaded only
 * for the owner's own view or a viewer who already clears the §23/TABLE 24
 * location gate, so neither eventual answer can be reached by accident.
 */
export const LOCATE_FRIENDS_CREW_PRESENCE: CapabilityDefinition = {
  flag: "locate_friends_enabled",
  providedBy: ["2219_locate_friends_sessions.sql"],
  requires: {
    tables: {
      // Keyed (session_id, user_id) — there is no `id`, so the default sentinel
      // probe would answer 42703 and the capability could never be ready.
      locate_friends_members: {
        columns: [...LOCATE_FRIENDS_MEMBER_COLUMNS],
        probe: { column: "session_id", value: SCHEMA_PROBE_SENTINEL_ID },
      },
      locate_friends_sessions: { columns: [...LOCATE_FRIENDS_SESSION_COLUMNS] },
    },
  },
  consumers: ["services/passport/PassportProjectionService.ts"],
  note:
    "A Passport read of Locate My Friends storage while that feature is dark discloses §23 " +
    "purpose-bound Presence the feature itself is not serving; refusing leaves the traveler " +
    "state to fall through to its non-crew derivation, which reads no Locate storage at all.",
};

/** flag → definition. The ratchet and the tests enumerate this. */
export const CAPABILITIES: Readonly<Record<string, CapabilityDefinition>> = Object.freeze({
  [MEDIA_CANONICAL.flag]: MEDIA_CANONICAL,
  // Registered because it has read sites the ratchet can SEE: scanFlagReads
  // resolves four (the isFlagEnabled call in the consumer, plus
  // discoveryTripProjectionGate followed into routes/discoverySearch.ts at both
  // the trips and plans surfaces). That is the difference from
  // MAP_TRIP_PROJECTION_CAPABILITY below, which reaches its flag only through
  // the definition and would trip "REGISTRY OVER A DEAD FLAG" at zero sites.
  [DISCOVERY_TRIP_PROJECTION.flag]: DISCOVERY_TRIP_PROJECTION,
  // Registered because routes/locateFriends.ts reads the flag by name at three
  // sites, so scanFlagReads resolves it and the entry cannot trip "REGISTRY
  // OVER A DEAD FLAG". The consumer that the entry is FOR is the Passport
  // assembler, which is the module that reads this feature's storage from
  // outside the feature.
  [LOCATE_FRIENDS_CREW_PRESENCE.flag]: LOCATE_FRIENDS_CREW_PRESENCE,
  // Registered because lib/tripOperationalProjections.ts reads the flag by
  // name (the gate every operational projection builder calls first), so
  // scanFlagReads resolves it. The consumers are the three builders; the
  // routes and Compass tools reach the schema only through them.
  [TRIP_OPERATIONAL_PROJECTIONS.flag]: TRIP_OPERATIONAL_PROJECTIONS,
  // NOT registered here, deliberately: MAP_TRIP_PROJECTION_CAPABILITY
  // (lib/mapProjectionTripContract.ts). resolveCapability takes the definition
  // directly, so the Map reader is fully guarded either way.
  //
  // Registering it was tried and reverted. checkFlagSchemaPrerequisites then
  // fails "REGISTRY OVER A DEAD FLAG: nothing in the tree reads it", because
  // its readSites counter looks for the flag NAME at a read site and the Map
  // reader reaches its flag through the capability definition instead. The
  // ratchet's badConsumers check does verify the consumer reaches
  // lib/capability, so the guard is seen; only the literal is not.
  //
  // The rule is right and was left alone rather than widened to admit the
  // entry. It is also accurate today: production has no row for
  // map_trip_projection_read_enabled and no trip_map_projections table, so the
  // capability can never be ready there yet. Unregistered, the flag classifies
  // as `latent`, which is what it is. Register it when 2520 -> 2610 are applied
  // and the flag has a row.
});

export function capabilityFor(flag: string): CapabilityDefinition | null {
  return CAPABILITIES[flag] ?? null;
}
