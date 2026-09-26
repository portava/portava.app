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
  type PresenceConsentScope,
  type PresenceSourceId,
} from "../presence/fusion/sources.js";
import { PRECISION_LADDER, precisionRank, type LocationPrecision } from "../presence/domain/types.js";

const T0 = 1_700_000_000_000;

/**
 * One consent scope per source, of the kind that source's contract declares
 * (owner decision A). Every claim in this file carries one, and every read
 * names the same set, so the cases below stay about what they were about —
 * ceilings, decay, class — and `presenceFusionConsent.test.ts` is where the
 * scope itself is exercised.
 */
const SCOPE: Readonly<Record<PresenceSourceId, PresenceConsentScope>> = Object.freeze({
  locate_friends_session: { kind: "locate_session", id: "session-1" },
  circle_presence: { kind: "circle", id: "trip:trip-1" },
  trip_crew_location_sessions: { kind: "trip_crew", id: "trip-1" },
  map_social_presence: { kind: "map_public", id: "social_zone" },
});
const ALL_SCOPES: readonly PresenceConsentScope[] = Object.freeze(Object.values(SCOPE));

/** An audience holding every scope above at `ceiling` — the pre-decision-A read, restated. */
function aud(ceiling: LocationPrecision): { ceiling: LocationPrecision; scopes: readonly PresenceConsentScope[] } {
  return { ceiling, scopes: ALL_SCOPES };
}

function claim(over: Partial<PresenceClaim> = {}, source: PresenceSourceId = "locate_friends_session"): PresenceClaim {
  return {
    subjectKey: "user-1",
    linkage: "account_scoped",
    scope: SCOPE[source],
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
          claim({ requestedPrecision: requested }, source),
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
      claim({ observedAtMs: null, state: "precise", linkage: "source_scoped" }, "map_social_presence"),
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
  // RE-AIMED 2026-09-26. This case previously admitted through
  // locate_friends_session (`social`) and trip_crew_location_sessions
  // (`trip_crew`) and required the CREW estimate to win a SOCIAL ask — i.e. it
  // asserted cross-class fusion on purpose. The owner settled §19 the other way
  // (census-sensing §20: distinct classes may not fuse), so the property was
  // re-proved WITHIN one class, using the two sources that genuinely share
  // `social`. RE-AIMED AGAIN 2026-09-26 (owner decision A, census-sensing
  // §25): "the NEWEST observation wins" was the rule §24.3 measured as unsafe —
  // a newer `recent` assertion downgraded a live position. The rule is now
  // `competePresence`: live beats not-live, then state strength, THEN recency.
  // So the same two admissions now resolve to the LIVE position, and recency
  // decides only between estimates of the same strength — both proved here.
  test("one subject seen by two SAME-CLASS sources resolves to the CURRENT position, not merely the newest assertion", () => {
    const store = new PresenceFusionStore();
    store.admit(
      PRESENCE_WRITE_CAPABILITIES.locate_friends_session,
      claim({ subjectKey: "acct-9", observedAtMs: T0 }),
      T0 + 1_000,
    );
    store.admit(
      PRESENCE_WRITE_CAPABILITIES.circle_presence,
      claim({ subjectKey: "acct-9", observedAtMs: T0 + 500, state: "recent" }, "circle_presence"),
      T0 + 1_000,
    );
    assert.equal(
      PRESENCE_SOURCE_CONTRACTS.locate_friends_session.presenceClass,
      PRESENCE_SOURCE_CONTRACTS.circle_presence.presenceClass,
      "this case is only meaningful while these two sources share a class",
    );
    const fused = store.resolve("acct-9", "locate_friends_session", aud("precise"), T0 + 1_000);
    assert.ok(fused);
    assert.equal(fused.source, "locate_friends_session", "a live position outranks a newer non-live assertion");
    assert.equal(fused.observedAtMs, T0);
    assert.equal(fused.live(T0 + 1_000), true);
    assert.equal(isFused(fused), true);
  });

  test("…and between two estimates of the SAME strength, the newer observation wins", () => {
    const store = new PresenceFusionStore();
    // Both non-live `recent`: the session position aged out of the live window,
    // the circle assertion newer. Same strength, so recency decides.
    store.admit(
      PRESENCE_WRITE_CAPABILITIES.locate_friends_session,
      claim({ subjectKey: "acct-9", observedAtMs: T0, state: "recent" }),
      T0 + 1_000,
    );
    store.admit(
      PRESENCE_WRITE_CAPABILITIES.circle_presence,
      claim({ subjectKey: "acct-9", observedAtMs: T0 + 500, state: "recent" }, "circle_presence"),
      T0 + 1_000,
    );
    const fused = store.resolve("acct-9", "locate_friends_session", aud("precise"), T0 + 1_000);
    assert.ok(fused);
    assert.equal(fused.source, "circle_presence");
    assert.equal(fused.observedAtMs, T0 + 500, "same strength: the newer observation must win");
  });

  test("resolving FOR a narrower source re-narrows the answer to that source's ceiling", () => {
    // RE-AIMED 2026-09-26 to a SAME-CLASS pair. It previously admitted through
    // trip_crew and asked as circle_presence, which the owner's §19 ruling now
    // refuses outright — the answer would be null and the ceiling property it
    // exists to prove would go untested. `locate_friends_session` (ceiling
    // `crew`/precise) and `circle_presence` (ceiling `venue`) are both `social`,
    // so the narrowing is still demonstrated across a real ceiling gap.
    const store = new PresenceFusionStore();
    store.admit(
      PRESENCE_WRITE_CAPABILITIES.locate_friends_session,
      claim({ subjectKey: "acct-9" }),
      T0,
    );
    const asLocate = store.resolve("acct-9", "locate_friends_session", aud("precise"), T0);
    const asCircle = store.resolve("acct-9", "circle_presence", aud("precise"), T0);
    assert.ok(asLocate && asCircle);
    assert.equal(asLocate.precision, "precise");
    assert.equal(
      asCircle.precision,
      PRESENCE_SOURCE_CONTRACTS.circle_presence.ceiling,
      "a circle consumer must not see the locate rung",
    );
    assert.equal(asCircle.position, null, "and must not be handed the coordinate either");
  });

  test("§20 — a source_scoped subject is NEVER fused with an account", () => {
    const store = new PresenceFusionStore();
    store.admit(
      PRESENCE_WRITE_CAPABILITIES.map_social_presence,
      claim({ subjectKey: "acct-9", linkage: "source_scoped", observedAtMs: T0 + 900 }, "map_social_presence"),
      T0 + 1_000,
    );
    // Nothing account-scoped exists for that key, so there is nothing to fuse.
    assert.equal(store.resolve("acct-9", "locate_friends_session", aud("precise"), T0 + 1_000), null);

    store.admit(
      PRESENCE_WRITE_CAPABILITIES.locate_friends_session,
      claim({ subjectKey: "acct-9", observedAtMs: T0 }),
      T0 + 1_000,
    );
    const fused = store.resolve("acct-9", "locate_friends_session", aud("precise"), T0 + 1_000);
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
    const held = store.read("locate_friends_session", "user-1", aud("precise"), T0 + 2_000);
    assert.ok(held);
    assert.equal(held.observedAtMs, T0 + 1_000);
  });

  test("an expired entry is not readable and sweeps away", () => {
    const store = new PresenceFusionStore();
    store.admit(PRESENCE_WRITE_CAPABILITIES.locate_friends_session, claim(), T0);
    assert.ok(store.read("locate_friends_session", "user-1", aud("precise"), T0));
    assert.equal(store.read("locate_friends_session", "user-1", aud("precise"), T0 + PRESENCE_ESTIMATE_TTL_MS), null);
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
    const held = store.read("locate_friends_session", "acct-9", aud("precise"), T0 + 1_000);
    assert.ok(held);
    assert.equal(held.precision, "precise", "this is exactly why egress must narrow");
  });

  test("read on behalf of the UNGRANTED viewer yields no coordinate", () => {
    const { store } = twoViewers();
    const seen = store.read("locate_friends_session", "acct-9", aud("venue"), T0 + 1_000);
    assert.ok(seen);
    assert.equal(seen.precision, "venue");
    assert.equal(seen.position, null);
  });

  test("resolve on behalf of the UNGRANTED viewer yields no coordinate", () => {
    const { store } = twoViewers();
    const fused = store.resolve("acct-9", "locate_friends_session", aud("venue"), T0 + 1_000);
    assert.ok(fused);
    assert.equal(fused.precision, "venue");
    assert.equal(fused.position, null);
  });

  test("a `none` audience is told nothing at all — existence is withheld, not just the point", () => {
    const { store } = twoViewers();
    assert.equal(store.read("locate_friends_session", "acct-9", aud("none"), T0 + 1_000), null);
    assert.equal(store.resolve("acct-9", "locate_friends_session", aud("none"), T0 + 1_000), null);
  });

  test("§52 has one direction — a generous audience cannot widen a narrowly retained estimate", () => {
    const store = new PresenceFusionStore();
    store.admit(
      PRESENCE_WRITE_CAPABILITIES.locate_friends_session,
      claim({ subjectKey: "acct-9", ceilings: ["venue"] }),
      T0,
    );
    for (const asking of ["precise", "nearby", "approximate"] as const) {
      const seen = store.read("locate_friends_session", "acct-9", aud(asking), T0);
      assert.ok(seen);
      assert.equal(seen.precision, "venue", `asking for ${asking} must not raise the rung`);
      assert.equal(seen.position, null);
    }
  });

  test("an audience ceiling the ladder does not contain is treated as `none`, not ignored", () => {
    const { store } = twoViewers();
    assert.equal(
      store.read("locate_friends_session", "acct-9", aud("street-level" as never), T0 + 1_000),
      null,
      "a bound we cannot read is not a bound we get to ignore",
    );
    assert.equal(
      store.resolve("acct-9", "locate_friends_session", aud(undefined as never), T0 + 1_000),
      null,
    );
  });

  test("the audience ceiling composes WITH the source ceiling — the narrower of the two wins", () => {
    // RE-AIMED 2026-09-26: admits through locate_friends_session rather than
    // trip_crew so both asks below stay INSIDE the `social` class. The §19
    // ruling would refuse a cross-class ask before either ceiling was folded,
    // and this case is about the fold, not the class.
    const store = new PresenceFusionStore();
    store.admit(
      PRESENCE_WRITE_CAPABILITIES.locate_friends_session,
      claim({ subjectKey: "acct-9", ceilings: ["precise"] }),
      T0,
    );
    // circle_presence's CONTRACT ceiling is the narrower bound here...
    const bySource = store.resolve("acct-9", "circle_presence", aud("precise"), T0);
    assert.ok(bySource);
    assert.equal(bySource.precision, PRESENCE_SOURCE_CONTRACTS.circle_presence.ceiling);
    // ...and here the AUDIENCE is, through a source whose contract permits more.
    const byAudience = store.resolve("acct-9", "locate_friends_session", aud("zone"), T0);
    assert.ok(byAudience);
    assert.equal(byAudience.precision, "zone");
    assert.equal(byAudience.position, null);
  });
});

/**
 * ── §17's CLASS BOUNDARY — OWNER DECISION, 2026-09-26 ────────────────────────
 *
 * The spec: "keep privacy classes distinct: private device presence, aggregate
 * intelligence presence, social presence, Trip crew, Buddy, public discovery"
 * and "Reuse low-level sensor/proximity infrastructure where possible, NOT
 * consent/policy semantics."
 *
 * Two readings were put to the owner — (A) distinct classes may not FUSE, and
 * (B) they merely may not MERGE identity, since the estimate keeps its
 * `source`. The owner settled on A, to be enforced CENTRALLY, reading class
 * from trusted source configuration, refusing missing or unknown classes, and
 * mandatory for every caller. These cases are that decision's regression net.
 *
 * Sharing a position with a trip crew is a different consent grant from
 * appearing in a circle's presence view. Serving one through the other is
 * exactly the consent/policy reuse §17 excludes.
 */
describe("presence fusion — distinct privacy classes may not fuse (§17, owner decision)", () => {
  test("the three account-scoped sources do not all share a class — the premise, measured", () => {
    assert.equal(PRESENCE_SOURCE_CONTRACTS.circle_presence.presenceClass, "social");
    assert.equal(PRESENCE_SOURCE_CONTRACTS.locate_friends_session.presenceClass, "social");
    assert.equal(PRESENCE_SOURCE_CONTRACTS.trip_crew_location_sessions.presenceClass, "trip_crew");
  });

  test("a trip_crew estimate does NOT answer a social ask, even when it is newer", () => {
    const store = new PresenceFusionStore();
    store.admit(
      PRESENCE_WRITE_CAPABILITIES.trip_crew_location_sessions,
      claim({ subjectKey: "acct-9", observedAtMs: T0 + 5_000 }, "trip_crew_location_sessions"),
      T0 + 6_000,
    );
    assert.equal(
      store.resolve("acct-9", "locate_friends_session", aud("precise"), T0 + 6_000),
      null,
      "a crew position reaching a social surface is the §17 violation",
    );
    assert.equal(store.resolve("acct-9", "circle_presence", aud("precise"), T0 + 6_000), null);
  });

  test("a social estimate does NOT answer a trip_crew ask either — the rule is symmetric", () => {
    const store = new PresenceFusionStore();
    store.admit(
      PRESENCE_WRITE_CAPABILITIES.locate_friends_session,
      claim({ subjectKey: "acct-9", observedAtMs: T0 }),
      T0 + 1_000,
    );
    assert.equal(
      store.resolve("acct-9", "trip_crew_location_sessions", aud("precise"), T0 + 1_000),
      null,
    );
  });

  // The rule must NARROW answers, never destroy correct ones. If the class
  // filter ran only at egress, the newer cross-class estimate would win `best`
  // and then be refused, returning null where an eligible same-class estimate
  // existed. Selection-time filtering is what makes this case pass.
  test("an eligible same-class estimate still answers even when a NEWER cross-class one exists", () => {
    const store = new PresenceFusionStore();
    store.admit(
      PRESENCE_WRITE_CAPABILITIES.locate_friends_session,
      claim({ subjectKey: "acct-9", observedAtMs: T0 }),
      T0 + 9_000,
    );
    store.admit(
      PRESENCE_WRITE_CAPABILITIES.trip_crew_location_sessions,
      claim({ subjectKey: "acct-9", observedAtMs: T0 + 5_000 }, "trip_crew_location_sessions"),
      T0 + 9_000,
    );
    const fused = store.resolve("acct-9", "locate_friends_session", aud("precise"), T0 + 9_000);
    assert.ok(fused, "the same-class estimate must still be served, not swallowed");
    assert.equal(fused.source, "locate_friends_session");
    assert.equal(fused.observedAtMs, T0);
  });

  test("read() is bound by the same rule — the central check catches the direct path", () => {
    const store = new PresenceFusionStore();
    store.admit(
      PRESENCE_WRITE_CAPABILITIES.trip_crew_location_sessions,
      claim({ subjectKey: "acct-9" }, "trip_crew_location_sessions"),
      T0,
    );
    // Same class as itself: served.
    assert.ok(store.read("trip_crew_location_sessions", "acct-9", aud("precise"), T0));
  });

  test("an unknown asking source is REFUSED, not treated as compatible", () => {
    const store = new PresenceFusionStore();
    store.admit(
      PRESENCE_WRITE_CAPABILITIES.locate_friends_session,
      claim({ subjectKey: "acct-9" }),
      T0,
    );
    assert.equal(
      store.resolve("acct-9", "not_a_source" as never, aud("precise"), T0),
      null,
      "an unreadable class is not a matching class",
    );
    assert.equal(store.read("not_a_source" as never, "acct-9", aud("precise"), T0), null);
  });

  test("same-class fusion is still permitted — the rule narrows, it is not a blanket ban", () => {
    const store = new PresenceFusionStore();
    store.admit(
      PRESENCE_WRITE_CAPABILITIES.circle_presence,
      claim({ subjectKey: "acct-9", observedAtMs: T0 + 500, state: "recent" }, "circle_presence"),
      T0 + 1_000,
    );
    const fused = store.resolve("acct-9", "locate_friends_session", aud("precise"), T0 + 1_000);
    assert.ok(fused, "circle_presence and locate_friends_session are both `social`");
    assert.equal(fused.source, "circle_presence");
  });
});
