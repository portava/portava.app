import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  LIVE_PLACES_REQUIREMENTS,
  isLivePlacesCapabilityEnabled,
  resolveFeatureFlags,
} from "../lib/featureFlags.js";

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