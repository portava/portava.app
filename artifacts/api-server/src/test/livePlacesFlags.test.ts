import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  LIVE_PLACES_REQUIREMENTS,
  isLivePlacesCapabilityEnabled,
  resolveFeatureFlags,
} from "../lib/featureFlags.js";
import { isRentBuddyMasterEnabled, isWallRabEnabled } from "../services/wall/wallRabGate.js";

function flagClient(flags: Record<string, boolean>) {
  return {
    from(table: string) {
      assert.equal(table, "feature_flags");
      return {
        select() { return this; },
        eq(_column: string, flag: string) {
          return { maybeSingle: async () => ({ data: { enabled: flags[flag] === true }, error: null }) };
        },
      };
    },
  };
}

describe("Live Places flag hierarchy", () => {
  const enabled = {
    external_places_enabled: true,
    live_places_enabled: true,
    place_days_enabled: true,
    shared_moments_enabled: true,
    shared_moments_compass_suggestions_enabled: true,
    shared_moments_clustering_enabled: true,
    place_recaps_enabled: true,
    moment_recaps_enabled: true,
    live_places_world_feed_enabled: true,
    place_chat_enabled: true,
    shared_moments_chat_enabled: true,
  };

  it("declares prerequisites for every Phase 4 capability", () => {
    for (const [capability, requirements] of Object.entries(LIVE_PLACES_REQUIREMENTS)) {
      assert.ok(requirements.length > 0, `${capability} must declare prerequisites`);
    }
  });

  it("denies every dependent capability when the master kill switch is off", async () => {
    const client = flagClient({ ...enabled, live_places_enabled: false });
    for (const capability of Object.keys(LIVE_PLACES_REQUIREMENTS) as Array<keyof typeof LIVE_PLACES_REQUIREMENTS>) {
      assert.equal(await isLivePlacesCapabilityEnabled(client, capability), false, capability);
    }
  });

  it("publishes effective values rather than raw child values when parents are off", () => {
    const flags = resolveFeatureFlags({ ...enabled, live_places_enabled: false });
    assert.equal(flags.external_places_enabled, true, "canonical place discovery remains independent");
    assert.equal(flags.live_places_enabled, false);
    assert.equal(flags.place_days_enabled, false);
    assert.equal(flags.shared_moments_enabled, false);
    assert.equal(flags.place_recaps_enabled, false);
    assert.equal(flags.shared_moments_chat_enabled, false);
  });

  it("allows an enabled capability only when all declared parents are enabled", async () => {
    const client = flagClient(enabled);
    for (const capability of Object.keys(LIVE_PLACES_REQUIREMENTS) as Array<keyof typeof LIVE_PLACES_REQUIREMENTS>) {
      assert.equal(await isLivePlacesCapabilityEnabled(client, capability), true, capability);
    }
  });
});
// ── Rent-a-Buddy on the Wall — a two-flag capability ─────────────────────────

/**
 * The Wall surfaces RAB from three independent producers. Only one of the three
 * consulted the RAB master `rent_buddy_enabled`; the other two treated
 * `wall_rab_integration_enabled` as sufficient, so pressing the Wall flag would
 * have advertised a globally disabled product. These are the shared readers all
 * three now use.
 */
describe("Wall RAB gate — both flags, fail-closed", () => {
  it("is true only when the Wall flag AND the RAB master are both on", async () => {
    assert.equal(await isWallRabEnabled(flagClient({ wall_rab_integration_enabled: true,  rent_buddy_enabled: true  })), true);
    assert.equal(await isWallRabEnabled(flagClient({ wall_rab_integration_enabled: true,  rent_buddy_enabled: false })), false);
    assert.equal(await isWallRabEnabled(flagClient({ wall_rab_integration_enabled: false, rent_buddy_enabled: true  })), false);
    assert.equal(await isWallRabEnabled(flagClient({})), false, "absent rows are off");
  });

  it("fails closed when the flag table cannot be read", async () => {
    const detonator: any = { from() { throw new Error("flag table down"); } };
    assert.equal(await isWallRabEnabled(detonator), false);
    assert.equal(await isRentBuddyMasterEnabled(detonator), false);
  });

  it("isRentBuddyMasterEnabled reads the master alone", async () => {
    assert.equal(await isRentBuddyMasterEnabled(flagClient({ rent_buddy_enabled: true, wall_rab_integration_enabled: false })), true);
    assert.equal(await isRentBuddyMasterEnabled(flagClient({ rent_buddy_enabled: false, wall_rab_integration_enabled: true })), false);
  });
});
