/**
 * The fusion layer's BEHAVIOUR. `presenceFusionUnrepresentable.test.ts` proves
 * nothing else can mint an estimate; this file proves the thing that does mint
 * them is worth having — that it fuses, narrows and decays rather than merely
 * storing what it was handed.
 *
 * Every property here is a spec line the four models used to each answer for
 * themselves:
 *
 *   §52  a consumer can never obtain more precision than policy allows
 *   §2.2 observation ≠ inference; freshness ≠ confidence
 *   §20  expired/stale ≠ current; prediction ≠ observation
 *   §20  anonymous intelligence may not be reverse-linked to an account
 *   §37  a stale pin must never render as a live one
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  PRESENCE_ESTIMATE_TTL_MS,
  PRESENCE_LIVE_WINDOW_MS,
  PRESENCE_WRITE_CAPABILITIES,
  PresenceFusionStore,
  isFused,
  type PresenceClaim,
} from "../presence/fusion/store.js";
import {
  PRESENCE_SOURCES,
  PRESENCE_SOURCE_CONTRACTS,
} from "../presence/fusion/sources.js";
import { PRECISION_LADDER, precisionRank } from "../presence/domain/types.js";

const T0 = 1_700_000_000_000;

function claim(over: Partial<PresenceClaim> = {}): PresenceClaim {
  return {
    subjectKey: "user-1",
    linkage: "account_scoped",
    requestedPrecision: "precise",
    observedAtMs: T0,
    state: "precise",
    confidence: 1,
    evidence: ["gps"],
    point: { lat: 51.5, lng: -0.12 },
    ...over,
  };
}

describe("presence fusion — §52, the ladder can only narrow", () => {
  test("no source can obtain more precision than its own contract ceiling", () => {
    for (const source of PRESENCE_SOURCES) {
      const ceiling = PRESENCE_SOURCE_CONTRACTS[source].ceiling;
      for (const requested of PRECISION_LADDER) {
        const store = new PresenceFusionStore();
        const r = store.admit(
          PRESENCE_WRITE_CAPABILITIES[source],
          claim({ requestedPrecision: requested }),
          T0,
        );
        if (!r.ok) {
          // The only legitimate refusal here is a fold that reached `none`.
          assert.equal(r.refusal, "suppressed", `${source}/${requested}: ${r.refusal}`);
          continue;
        }
        assert.ok(
          precisionRank(r.estimate.precision) <= precisionRank(ceiling),
          `${source} asked for ${requested} and got ${r.estimate.precision}, above its ceiling ${ceiling}`,
        );
        assert.ok(
          precisionRank(r.estimate.precision) <= precisionRank(requested),
          `${source} got ${r.estimate.precision}, MORE than it asked for (${requested})`,
        );
      }
    }
  });

  test("an unreadable ceiling is treated as `none`, not skipped", () => {
    const store = new PresenceFusionStore();
    const r = store.admit(
      PRESENCE_WRITE_CAPABILITIES.locate_friends_session,
      claim({ ceilings: ["not_a_rung"] }),
      T0,
    );
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.refusal, "suppressed");
  });

  test("every supplied ceiling is folded, not just the last one", () => {
    const store = new PresenceFusionStore();
    const r = store.admit(
      PRESENCE_WRITE_CAPABILITIES.locate_friends_session,
      claim({ requestedPrecision: "precise", ceilings: ["zone", "nearby", "approximate"] }),
      T0,
    );
    assert.ok(r.ok);
    assert.equal(r.estimate.precision, "zone");
    assert.equal(r.estimate.ceiling, "zone");
  });

  test("a coordinate is NEVER retained above the `precise` rung", () => {
    for (const rung of PRECISION_LADDER) {
      const store = new PresenceFusionStore();
      const r = store.admit(
        PRESENCE_WRITE_CAPABILITIES.locate_friends_session,
        claim({ requestedPrecision: rung }),
        T0,
      );
      if (!r.ok) continue;
      if (r.estimate.precision === "precise") {
        assert.deepEqual(r.estimate.position, { lat: 51.5, lng: -0.12 });
      } else {
        assert.equal(
          r.estimate.position,
          null,
          `a ${r.estimate.precision} estimate kept a coordinate — that is a location history, not a rung`,
        );
      }
    }
  });
});

describe("presence fusion — §20 and §37, stale is not current", () => {
  test("a live state past the live window is downgraded to `recent`", () => {
    const store = new PresenceFusionStore();
    const inside = store.admit(
      PRESENCE_WRITE_CAPABILITIES.locate_friends_session,
      claim(),
      T0 + PRESENCE_LIVE_WINDOW_MS - 1,
    );
    assert.ok(inside.ok);
    assert.equal(inside.estimate.state, "precise");
    assert.equal(inside.estimate.live(T0 + PRESENCE_LIVE_WINDOW_MS - 1), true);

    const outside = store.admit(
      PRESENCE_WRITE_CAPABILITIES.locate_friends_session,
      claim(),
      T0 + PRESENCE_LIVE_WINDOW_MS,
    );
    assert.ok(outside.ok);
    assert.equal(outside.estimate.state, "recent");
    assert.equal(outside.estimate.live(T0 + PRESENCE_LIVE_WINDOW_MS), false);
  });

  test("an observation past the TTL is refused, not served faintly", () => {
    const store = new PresenceFusionStore();
    const r = store.admit(
      PRESENCE_WRITE_CAPABILITIES.locate_friends_session,
      claim(),
      T0 + PRESENCE_ESTIMATE_TTL_MS,
    );
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.refusal, "expired");
  });

  test("an UNTIMED claim can never be live and carries freshness 0", () => {
    const store = new PresenceFusionStore();
    const r = store.admit(
      PRESENCE_WRITE_CAPABILITIES.map_social_presence,
      claim({ observedAtMs: null, state: "precise", linkage: "source_scoped" }),
      null,
    );
    assert.ok(r.ok);
    assert.equal(r.estimate.state, "unknown", "an untimed claim must not assert a live state");
    assert.equal(r.estimate.freshness, 0);
    assert.equal(r.estimate.observedAt, null);
    assert.equal(r.estimate.live(T0), false);
    assert.equal(
      r.estimate.toPresenceEstimate(),
      null,
      "an untimed estimate must NOT be handed out with a fabricated observedAt",
    );
  });

  test("freshness falls with age and is independent of confidence", () => {
    const store = new PresenceFusionStore();
    const fresh = store.admit(
      PRESENCE_WRITE_CAPABILITIES.locate_friends_session,
      claim({ confidence: 0.2 }),
      T0,
    );
    const old = store.admit(
      PRESENCE_WRITE_CAPABILITIES.locate_friends_session,
      claim({ confidence: 0.2 }),
      T0 + PRESENCE_ESTIMATE_TTL_MS / 2,
    );
    assert.ok(fresh.ok && old.ok);
    assert.equal(fresh.estimate.freshness, 1);
    assert.ok(Math.abs(old.estimate.freshness - 0.5) < 1e-9);
    // §2.2: a very confident reading can still be very old.
    assert.equal(fresh.estimate.confidence, 0.2);
    assert.equal(old.estimate.confidence, 0.2);
  });
});

describe("presence fusion — it actually FUSES", () => {
  test("one subject seen by two sources resolves to the most recent observation", () => {
    const store = new PresenceFusionStore();
    store.admit(
      PRESENCE_WRITE_CAPABILITIES.locate_friends_session,
      claim({ subjectKey: "acct-9", observedAtMs: T0 }),
      T0 + 1_000,
    );
    store.admit(
      PRESENCE_WRITE_CAPABILITIES.trip_crew_location_sessions,
      claim({ subjectKey: "acct-9", observedAtMs: T0 + 500 }),
      T0 + 1_000,
    );
    const fused = store.resolve("acct-9", "locate_friends_session", T0 + 1_000);
    assert.ok(fused);
    assert.equal(fused.observedAtMs, T0 + 500, "the newer observation must win");
    assert.equal(fused.source, "trip_crew_location_sessions");
    assert.equal(isFused(fused), true);
  });

  test("resolving FOR a narrower source re-narrows the answer to that source's ceiling", () => {
    const store = new PresenceFusionStore();
    store.admit(
      PRESENCE_WRITE_CAPABILITIES.trip_crew_location_sessions,
      claim({ subjectKey: "acct-9" }),
      T0,
    );
    const asCrew = store.resolve("acct-9", "trip_crew_location_sessions", T0);
    const asCircle = store.resolve("acct-9", "circle_presence", T0);
    assert.ok(asCrew && asCircle);
    assert.equal(asCrew.precision, "precise");
    assert.equal(
      asCircle.precision,
      PRESENCE_SOURCE_CONTRACTS.circle_presence.ceiling,
      "a circle consumer must not see the crew rung",
    );
    assert.equal(asCircle.position, null, "and must not be handed the coordinate either");
  });

  test("§20 — a source_scoped subject is NEVER fused with an account", () => {
    const store = new PresenceFusionStore();
    store.admit(
      PRESENCE_WRITE_CAPABILITIES.map_social_presence,
      claim({ subjectKey: "acct-9", linkage: "source_scoped", observedAtMs: T0 + 900 }),
      T0 + 1_000,
    );
    // Nothing account-scoped exists for that key, so there is nothing to fuse.
    assert.equal(store.resolve("acct-9", "locate_friends_session", T0 + 1_000), null);

    store.admit(
      PRESENCE_WRITE_CAPABILITIES.locate_friends_session,
      claim({ subjectKey: "acct-9", observedAtMs: T0 }),
      T0 + 1_000,
    );
    const fused = store.resolve("acct-9", "locate_friends_session", T0 + 1_000);
    assert.ok(fused);
    assert.equal(
      fused.source,
      "locate_friends_session",
      "the map's newer, source-scoped sighting must NOT have won — that would reverse-link " +
        "anonymous world intelligence to an account",
    );
    assert.equal(fused.observedAtMs, T0);
  });

  test("retention keeps the freshest per (source, subject) but admit still answers about THIS claim", () => {
    const store = new PresenceFusionStore();
    const newer = store.admit(
      PRESENCE_WRITE_CAPABILITIES.locate_friends_session,
      claim({ observedAtMs: T0 + 1_000, requestedPrecision: "precise" }),
      T0 + 2_000,
    );
    const older = store.admit(
      PRESENCE_WRITE_CAPABILITIES.locate_friends_session,
      claim({ observedAtMs: T0, requestedPrecision: "zone" }),
      T0 + 2_000,
    );
    assert.ok(newer.ok && older.ok);
    // The older claim still gets an honest answer about itself — projection is pure.
    assert.equal(older.estimate.precision, "zone");
    // But it did not displace the fresher retained one.
    const held = store.read("locate_friends_session", "user-1", T0 + 2_000);
    assert.ok(held);
    assert.equal(held.observedAtMs, T0 + 1_000);
  });

  test("an expired entry is not readable and sweeps away", () => {
    const store = new PresenceFusionStore();
    store.admit(PRESENCE_WRITE_CAPABILITIES.locate_friends_session, claim(), T0);
    assert.ok(store.read("locate_friends_session", "user-1", T0));
    assert.equal(store.read("locate_friends_session", "user-1", T0 + PRESENCE_ESTIMATE_TTL_MS), null);
    assert.equal(store.sweep(T0 + PRESENCE_ESTIMATE_TTL_MS), 1);
    assert.equal(store.size, 0);
  });

  test("the store is bounded — it cannot grow without limit in a long-lived process", () => {
    const store = new PresenceFusionStore({ maxEntries: 8 });
    for (let i = 0; i < 100; i += 1) {
      store.admit(
        PRESENCE_WRITE_CAPABILITIES.locate_friends_session,
        claim({ subjectKey: `u-${i}` }),
        T0,
      );
    }
    assert.ok(store.size <= 8, `store grew to ${store.size}`);
  });
});

describe("presence fusion — refusals are named, never silent", () => {
  test("an empty subject key is refused", () => {
    const store = new PresenceFusionStore();
    const r = store.admit(PRESENCE_WRITE_CAPABILITIES.locate_friends_session, claim({ subjectKey: "  " }), T0);
    assert.equal(r.ok === false && r.refusal, "no_subject");
  });

  test("a non-finite observedAt is refused as bad_clock", () => {
    const store = new PresenceFusionStore();
    const r = store.admit(
      PRESENCE_WRITE_CAPABILITIES.locate_friends_session,
      claim({ observedAtMs: Number.NaN }),
      T0,
    );
    assert.equal(r.ok === false && r.refusal, "bad_clock");
  });

  test("a state outside ESTIMATE_STATES is refused, not coerced", () => {
    const store = new PresenceFusionStore();
    const r = store.admit(
      PRESENCE_WRITE_CAPABILITIES.locate_friends_session,
      claim({ state: "definitely_here" as never }),
      T0,
    );
    assert.equal(r.ok === false && r.refusal, "unknown_state");
  });
});
