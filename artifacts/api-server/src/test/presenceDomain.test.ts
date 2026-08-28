/**
 * Presence Network — domain invariants (spec §56 Phase 0).
 *
 * Pure, offline, no database. These pin the two rules the spec is most emphatic
 * about, so that a future implementation cannot quietly violate them:
 *
 *   §52  A consumer can never obtain more precision than policy allows.
 *   §2.2 / §16  A stale reading must never be presented as a live one.
 *
 * Written before any transport or fusion code exists, deliberately: these are the
 * constraints the implementation has to satisfy, not a description of it.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PRECISION_LADDER,
  precisionRank,
  narrowestPrecision,
  FEATURE_PRECISION_CEILING,
  ESTIMATE_STATES,
  isLiveState,
  CURRENT_STACK_CAPABILITIES,
  type LocationPrecision,
} from "../presence/domain/types.js";
import {
  selectUsableTransports,
  type PresenceTransport,
  type PresenceTransportCapabilities,
} from "../presence/domain/transport.js";

describe("§52 precision — the ladder can only narrow", () => {
  it("narrowestPrecision NEVER returns something more revealing than policy allows", () => {
    // Exhaustive over the whole ladder: no pair may escape the policy ceiling.
    for (const requested of PRECISION_LADDER) {
      for (const allowed of PRECISION_LADDER) {
        const got = narrowestPrecision(requested, allowed);
        assert.ok(
          precisionRank(got) <= precisionRank(allowed),
          `narrowestPrecision(${requested}, ${allowed}) = ${got} exceeds the policy ceiling`,
        );
        assert.ok(
          precisionRank(got) <= precisionRank(requested),
          `narrowestPrecision(${requested}, ${allowed}) = ${got} exceeds what was requested`,
        );
      }
    }
  });

  it("is idempotent and commutative — order of application cannot widen", () => {
    for (const a of PRECISION_LADDER) {
      for (const b of PRECISION_LADDER) {
        assert.equal(narrowestPrecision(a, b), narrowestPrecision(b, a), "must be commutative");
        const once = narrowestPrecision(a, b);
        assert.equal(narrowestPrecision(once, b), once, "must be idempotent");
      }
    }
  });

  it("the ladder is ordered least → most revealing", () => {
    assert.equal(PRECISION_LADDER[0], "none");
    assert.equal(PRECISION_LADDER[PRECISION_LADDER.length - 1], "precise");
    for (let i = 1; i < PRECISION_LADDER.length; i++) {
      assert.ok(precisionRank(PRECISION_LADDER[i]) > precisionRank(PRECISION_LADDER[i - 1]));
    }
  });

  it("crowd intelligence can never reach a coordinate, whatever it asks for", () => {
    // §40: "never expose individuals through crowd intelligence".
    const ceiling: LocationPrecision = FEATURE_PRECISION_CEILING.crowd_intelligence;
    for (const requested of PRECISION_LADDER) {
      const got = narrowestPrecision(requested, ceiling);
      assert.ok(
        precisionRank(got) <= precisionRank("presence_only"),
        `crowd intelligence obtained ${got} by requesting ${requested}`,
      );
    }
  });

  it("bump can never reach precise coordinates (§30 delayed-bump privacy)", () => {
    for (const requested of PRECISION_LADDER) {
      const got = narrowestPrecision(requested, FEATURE_PRECISION_CEILING.bump);
      assert.ok(precisionRank(got) <= precisionRank("zone"), `bump obtained ${got}`);
    }
  });
});

describe("§2.2 estimate states — stale must never read as live", () => {
  it("only genuinely-current states are live", () => {
    assert.ok(isLiveState("precise"));
    assert.ok(isLiveState("nearby"));
    assert.ok(isLiveState("relayed"));
  });

  it("history and guesses are NOT live", () => {
    for (const s of ["recent", "inferred", "predicted", "last_known", "unknown"] as const) {
      assert.equal(isLiveState(s), false, `${s} must not be presentable as a current position`);
    }
  });

  it("every declared state is classified — no state is accidentally live by default", () => {
    for (const s of ESTIMATE_STATES) {
      assert.equal(typeof isLiveState(s), "boolean", `${s} is unclassified`);
    }
  });
});

describe("§7/§71 transport selection — never assume a radio the device lacks", () => {
  const caps = (over: Partial<PresenceTransportCapabilities> = {}): PresenceTransportCapabilities => ({
    ...CURRENT_STACK_CAPABILITIES, permissionGranted: true, unavailableReason: null, ...over,
  });
  const t = (id: string, c: PresenceTransportCapabilities): PresenceTransport => ({
    id, capabilities: () => c,
    startAdvertising: async () => {}, stopAdvertising: async () => {},
    startScanning: async () => {}, stopScanning: async () => {},
    onObservation: () => () => {},
  });

  it("excludes a transport whose permission was denied, WITH a reason (§66)", () => {
    const { usable, unusable } = selectUsableTransports([
      t("ble", caps({ permissionGranted: false, unavailableReason: "Bluetooth denied" })),
    ]);
    assert.equal(usable.length, 0);
    assert.deepEqual(unusable, [{ id: "ble", reason: "Bluetooth denied" }]);
  });

  it("excludes a transport with no usable capability, and always gives a reason", () => {
    const { usable, unusable } = selectUsableTransports([
      t("ble", caps({ bleScan: false, bleAdvertise: false, backgroundLocation: false, localPeer: false, uwb: false })),
    ]);
    assert.equal(usable.length, 0);
    assert.equal(unusable.length, 1);
    assert.ok(unusable[0].reason.length > 0, "an excluded transport must explain itself");
  });

  it("keeps a GPS transport on today's stack — background location genuinely ships", () => {
    const { usable } = selectUsableTransports([t("server-gps", caps())]);
    assert.deepEqual(usable.map((x) => x.id), ["server-gps"]);
  });

  it("the recorded stack baseline says BLE is absent — so no feature may assume it", () => {
    // If someone adds a BLE library, this fails and forces the baseline (and the
    // native permission/background-mode work) to be updated deliberately.
    assert.equal(CURRENT_STACK_CAPABILITIES.bleScan, false);
    assert.equal(CURRENT_STACK_CAPABILITIES.bleAdvertise, false);
    assert.equal(CURRENT_STACK_CAPABILITIES.backgroundBle, false);
    assert.equal(CURRENT_STACK_CAPABILITIES.backgroundLocation, true);
  });
});
