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
    const fused = store.resolve("acct-9", "locate_friends_session", "precise", T0 + 1_000);
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
    const asCrew = store.resolve("acct-9", "trip_crew_location_sessions", "precise", T0);
    const asCircle = store.resolve("acct-9", "circle_presence", "precise", T0);
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
    assert.equal(store.resolve("acct-9", "locate_friends_session", "precise", T0 + 1_000), null);

    store.admit(
      PRESENCE_WRITE_CAPABILITIES.locate_friends_session,
      claim({ subjectKey: "acct-9", observedAtMs: T0 }),
      T0 + 1_000,
    );
    const fused = store.resolve("acct-9", "locate_friends_session", "precise", T0 + 1_000);
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
    const held = store.read("locate_friends_session", "user-1", "precise", T0 + 2_000);
    assert.ok(held);
    assert.equal(held.observedAtMs, T0 + 1_000);
  });

  test("an expired entry is not readable and sweeps away", () => {
    const store = new PresenceFusionStore();
    store.admit(PRESENCE_WRITE_CAPABILITIES.locate_friends_session, claim(), T0);
    assert.ok(store.read("locate_friends_session", "user-1", "precise", T0));
    assert.equal(store.read("locate_friends_session", "user-1", "precise", T0 + PRESENCE_ESTIMATE_TTL_MS), null);
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

/**
 * ── THE AUDIENCE, WHICH RETENTION DOES NOT CARRY ─────────────────────────────
 *
 * Retention is keyed `(source, subject)`. That is right about the OBSERVATION
 * and wrong about the DISCLOSURE, because one estimate object carries both, and
 * `precision`/`ceiling`/`position` are folded from bounds that belong to the
 * VIEWER: the live-share grant (`allowed_member_ids`), the Locate-My-Friends
 * session ceiling, the circle visibility mode.
 *
 * These cases pin the egress rule that makes that safe: every read states the
 * rung the ASKER holds, both ladders apply, and both only tighten. Before the
 * fix the asking ceiling came from the source CONTRACT — statically `precise`
 * for the crew and locate models — so an ungranted viewer's `resolve` returned
 * a granted viewer's coordinate in full.
 */
describe("presence fusion — one viewer never reads another viewer's entitlement", () => {
  // Both viewers see the SAME sighting, so the clocks tie and `#retain`'s
  // strictly-newer rule keeps the WIDER one. That is the common case, not a
  // corner: it is one subject observed once and looked at by two people.
  function twoViewers() {
    const store = new PresenceFusionStore();
    const granted = store.admit(
      PRESENCE_WRITE_CAPABILITIES.locate_friends_session,
      claim({ subjectKey: "acct-9", ceilings: ["precise"], observedAtMs: T0 }),
      T0 + 1_000,
    );
    const ungranted = store.admit(
      PRESENCE_WRITE_CAPABILITIES.locate_friends_session,
      claim({ subjectKey: "acct-9", ceilings: ["venue"], observedAtMs: T0 }),
      T0 + 1_000,
    );
    return { store, granted, ungranted };
  }

  test("admit still answers honestly about each viewer's own claim", () => {
    const { granted, ungranted } = twoViewers();
    assert.ok(granted.ok && ungranted.ok);
    assert.equal(granted.estimate.precision, "precise");
    assert.notEqual(granted.estimate.position, null);
    assert.equal(ungranted.estimate.precision, "venue");
    assert.equal(ungranted.estimate.position, null, "the write path was never the defect");
  });

  test("the retained entry is the WIDER one — the narrower admission does not displace it", () => {
    const { store } = twoViewers();
    const held = store.read("locate_friends_session", "acct-9", "precise", T0 + 1_000);
    assert.ok(held);
    assert.equal(held.precision, "precise", "this is exactly why egress must narrow");
  });

  test("read on behalf of the UNGRANTED viewer yields no coordinate", () => {
    const { store } = twoViewers();
    const seen = store.read("locate_friends_session", "acct-9", "venue", T0 + 1_000);
    assert.ok(seen);
    assert.equal(seen.precision, "venue");
    assert.equal(seen.position, null);
  });

  test("resolve on behalf of the UNGRANTED viewer yields no coordinate", () => {
    const { store } = twoViewers();
    const fused = store.resolve("acct-9", "locate_friends_session", "venue", T0 + 1_000);
    assert.ok(fused);
    assert.equal(fused.precision, "venue");
    assert.equal(fused.position, null);
  });

  test("a `none` audience is told nothing at all — existence is withheld, not just the point", () => {
    const { store } = twoViewers();
    assert.equal(store.read("locate_friends_session", "acct-9", "none", T0 + 1_000), null);
    assert.equal(store.resolve("acct-9", "locate_friends_session", "none", T0 + 1_000), null);
  });

  test("§52 has one direction — a generous audience cannot widen a narrowly retained estimate", () => {
    const store = new PresenceFusionStore();
    store.admit(
      PRESENCE_WRITE_CAPABILITIES.locate_friends_session,
      claim({ subjectKey: "acct-9", ceilings: ["venue"] }),
      T0,
    );
    for (const asking of ["precise", "nearby", "approximate"] as const) {
      const seen = store.read("locate_friends_session", "acct-9", asking, T0);
      assert.ok(seen);
      assert.equal(seen.precision, "venue", `asking for ${asking} must not raise the rung`);
      assert.equal(seen.position, null);
    }
  });

  test("an audience ceiling the ladder does not contain is treated as `none`, not ignored", () => {
    const { store } = twoViewers();
    assert.equal(
      store.read("locate_friends_session", "acct-9", "street-level" as never, T0 + 1_000),
      null,
      "a bound we cannot read is not a bound we get to ignore",
    );
    assert.equal(
      store.resolve("acct-9", "locate_friends_session", undefined as never, T0 + 1_000),
      null,
    );
  });

  test("the audience ceiling composes WITH the source ceiling — the narrower of the two wins", () => {
    const store = new PresenceFusionStore();
    store.admit(
      PRESENCE_WRITE_CAPABILITIES.trip_crew_location_sessions,
      claim({ subjectKey: "acct-9", ceilings: ["precise"] }),
      T0,
    );
    // circle_presence's CONTRACT ceiling is the narrower bound here...
    const bySource = store.resolve("acct-9", "circle_presence", "precise", T0);
    assert.ok(bySource);
    assert.equal(bySource.precision, PRESENCE_SOURCE_CONTRACTS.circle_presence.ceiling);
    // ...and here the AUDIENCE is, through a source whose contract permits more.
    const byAudience = store.resolve("acct-9", "trip_crew_location_sessions", "zone", T0);
    assert.ok(byAudience);
    assert.equal(byAudience.precision, "zone");
    assert.equal(byAudience.position, null);
  });
});
