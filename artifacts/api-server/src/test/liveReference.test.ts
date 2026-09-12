/**
 * Sensing §12 — lib/liveReference: a canonical reference to a server-built
 * live object, and "changed since sharing" measured against it.
 *
 * Pins: a reference carries ids, the value at share time and the truth
 * block, and its one human line carries NO value; the kinds are the three
 * objects with a producer and Opportunity is refused by name; a version pins
 * only when its value is the served value; a stored body parses back and a
 * foreign body does not; and the comparison tells unchanged / reaffirmed /
 * changed / expired / withdrawn / added apart, with changedSinceShare NULL —
 * never false — when the current state could not be read.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  CHANGES_THAT_DIFFER,
  EXPERIENCE_REFERENCE_CLAIM_TYPES,
  LIVE_REFERENCE_CLAIM_TYPES,
  LIVE_REFERENCE_KINDS,
  LIVE_REFERENCE_MSG_SUBTYPE,
  LIVE_REFERENCE_MSG_TYPE,
  LIVE_REFERENCE_NOTE_MAX,
  SAFETY_REFERENCE_CLAIM_TYPE,
  SAFETY_REFERENCE_LEVEL,
  UNREFERENCEABLE_SPEC_OBJECTS,
  buildLiveReference,
  compareLiveReference,
  liveReferenceBody,
  parseLiveReference,
  pinVersionId,
  referenceText,
  refusedComparison,
  selectReferenceEnvelopes,
  type LiveReference,
} from "../lib/liveReference.js";
import { SAFETY_CLAIM_LEVEL, SAFETY_CLAIM_TYPE } from "../lib/mapProducers/safetyNoticeProducer.js";
import { WALL_MOMENT_CLAIM_TYPES } from "../routes/wallMoments.js";
import { detectTransitions } from "../lib/wallMoments.js";
import type { LiveClaimEnvelope } from "../lib/liveClaimRead.js";

const NOW = Date.parse("2026-09-12T10:00:00.000Z");
const iso = (offsetMinutes: number) => new Date(NOW + offsetMinutes * 60_000).toISOString();
const PLACE = "88888888-bbbb-4bbb-8bbb-888888888888";

function env(claimType: string, value: unknown, over: Partial<LiveClaimEnvelope> = {}): LiveClaimEnvelope {
  return {
    id: `snap-${claimType}`,
    claimType,
    value,
    confidence: 0.85,
    band: "live",
    sourceClass: "firsthand_unverified",
    sourceCountBucket: "many",
    observedAt: iso(-3),
    validUntil: iso(27),
    state: "live",
    conflictState: "none",
    conflict: null,
    ...over,
  };
}

const CROWD = env("crowd.level", { level: "packed" });
const TRAJ = env("crowd.trajectory", { trajectory: "building" });
const VIBE = env("vibe.state", { state: "high_energy" });
const SAFETY = env("crowd.level", { level: "unsafe_density" }, { id: "snap-safety" });

function share(kind: LiveReference["kind"], envelopes: LiveClaimEnvelope[], over: Record<string, unknown> = {}): LiveReference {
  const r = buildLiveReference({ kind, subject: { id: PLACE, name: "Han Market" }, envelopes, versions: null, nowMs: NOW, ...over });
  assert.equal(r.ok, true, "fixture must build");
  return (r as { ok: true; reference: LiveReference }).reference;
}

describe("lib/liveReference — the kinds", () => {
  it("names exactly the three objects with a canonical producer, and refuses Opportunity by name", () => {
    assert.deepEqual([...LIVE_REFERENCE_KINDS], ["experience_state", "world_moment", "safety_notice"]);
    assert.deepEqual([...UNREFERENCEABLE_SPEC_OBJECTS], ["opportunity"]);
    assert.equal((LIVE_REFERENCE_KINDS as readonly string[]).includes("opportunity"), false);
  });

  it("the experience types are the Wall's set, and the safety pair is the map producer's", () => {
    assert.deepEqual([...EXPERIENCE_REFERENCE_CLAIM_TYPES], [...WALL_MOMENT_CLAIM_TYPES]);
    assert.equal(SAFETY_REFERENCE_CLAIM_TYPE, SAFETY_CLAIM_TYPE);
    assert.equal(SAFETY_REFERENCE_LEVEL, SAFETY_CLAIM_LEVEL);
    assert.deepEqual([...LIVE_REFERENCE_CLAIM_TYPES.safety_notice], [SAFETY_CLAIM_TYPE]);
  });

  it("rides in a card message of its own subtype", () => {
    assert.equal(LIVE_REFERENCE_MSG_TYPE, "card");
    assert.equal(LIVE_REFERENCE_MSG_SUBTYPE, "live_reference");
  });
});

describe("lib/liveReference — selecting what a kind points at", () => {
  it("experience_state takes the comparable claims and nothing else", () => {
    const picked = selectReferenceEnvelopes("experience_state", [CROWD, TRAJ, VIBE, env("event.status", { status: "live" })]);
    assert.deepEqual(picked.map((e) => e.claimType), ["crowd.level", "crowd.trajectory", "vibe.state"]);
  });
  it("safety_notice takes only an unsafe_density crowd claim", () => {
    assert.deepEqual(selectReferenceEnvelopes("safety_notice", [CROWD, TRAJ]), []);
    assert.deepEqual(selectReferenceEnvelopes("safety_notice", [CROWD, SAFETY]).map((e) => e.id), ["snap-safety"]);
  });
  it("world_moment takes the transition's envelope, and nothing without a transition", () => {
    assert.deepEqual(selectReferenceEnvelopes("world_moment", [CROWD, TRAJ], null), []);
    const [t] = detectTransitions([CROWD], [{ claimType: "crowd.level", value: { level: "busy" }, observedAt: iso(-40), generatedAt: iso(-40) }]);
    assert.ok(t);
    assert.deepEqual(selectReferenceEnvelopes("world_moment", [CROWD, TRAJ], t).map((e) => e.id), [CROWD.id]);
  });
});

describe("lib/liveReference — building", () => {
  it("carries subject, per-claim snapshot id, value at share time, horizon and the truth block", () => {
    const ref = share("experience_state", [CROWD, TRAJ]);
    assert.equal(ref.type, "live_reference");
    assert.equal(ref.schemaVersion, 1);
    assert.deepEqual(ref.subject, { type: "place", id: PLACE, name: "Han Market" });
    assert.equal(ref.claims.length, 2);
    const crowd = ref.claims.find((c) => c.claimType === "crowd.level")!;
    assert.equal(crowd.snapshotId, CROWD.id);
    assert.equal(crowd.value, "packed");
    assert.equal(crowd.observedAt, CROWD.observedAt);
    assert.equal(crowd.validUntil, CROWD.validUntil);
    assert.equal(crowd.versionId, null);
    assert.equal(ref.moment, null);
    assert.equal(ref.sharedAt, new Date(NOW).toISOString());
    assert.equal(ref.truth.truthClass, "corroborated", "many independent sources ⇒ corroborated (lib/liveEnvelopeTruth)");
    assert.ok(ref.truth.confidence);
    assert.ok(ref.truth.freshness);
    assert.ok(ref.truth.coverage);
  });

  it("the human line names subject and kind and never a value", () => {
    const ref = share("experience_state", [CROWD, TRAJ, VIBE]);
    assert.equal(ref.text, "Live state of Han Market");
    for (const c of ref.claims) assert.equal(ref.text.includes(String(c.value)), false, `text must not carry ${c.value}`);
    assert.equal(referenceText("safety_notice", null), "Safety notice of a place");
    assert.equal(referenceText("world_moment", "  "), "Live moment of a place");
  });

  it("nothing to point at is a named refusal, not an empty reference", () => {
    assert.deepEqual(buildLiveReference({ kind: "safety_notice", subject: { id: PLACE, name: null }, envelopes: [CROWD], versions: null, nowMs: NOW }), {
      ok: false,
      refusal: "nothing_to_reference",
    });
    assert.deepEqual(buildLiveReference({ kind: "experience_state", subject: { id: PLACE, name: null }, envelopes: [], versions: null, nowMs: NOW }), {
      ok: false,
      refusal: "nothing_to_reference",
    });
    assert.deepEqual(buildLiveReference({ kind: "world_moment", subject: { id: PLACE, name: null }, envelopes: [CROWD], versions: null, transition: null, nowMs: NOW }), {
      ok: false,
      refusal: "nothing_to_reference",
    });
  });

  it("a world_moment reference carries the transition as detected", () => {
    const [t] = detectTransitions([CROWD], [{ claimType: "crowd.level", value: { level: "busy" }, observedAt: iso(-40), generatedAt: iso(-40) }]);
    const ref = share("world_moment", [CROWD], { transition: t });
    assert.deepEqual(ref.moment, { kind: "crowd_shift", claimType: "crowd.level", from: "busy", to: "packed", occurredAt: t.occurredAt });
    assert.equal(ref.claims.length, 1);
  });

  it("the note is the sender's, trimmed and bounded; the state's words never enter it", () => {
    assert.equal(share("experience_state", [CROWD], { note: "  see you there  " }).note, "see you there");
    assert.equal(share("experience_state", [CROWD], { note: "   " }).note, null);
    assert.equal(share("experience_state", [CROWD], { note: "x".repeat(LIVE_REFERENCE_NOTE_MAX + 40) }).note?.length, LIVE_REFERENCE_NOTE_MAX);
  });

  it("pins a version only when its value IS the served value", () => {
    const versions = new Map([
      ["crowd.level", { id: "ver-packed", value: { level: "packed" } }],
      ["crowd.trajectory", { id: "ver-stale", value: { trajectory: "emerging" } }],
    ]);
    assert.equal(pinVersionId(CROWD, versions), "ver-packed");
    assert.equal(pinVersionId(TRAJ, versions), null, "a record that has not caught up pins nothing");
    assert.equal(pinVersionId(VIBE, versions), null);
    assert.equal(pinVersionId(CROWD, null), null);
    const ref = share("experience_state", [CROWD, TRAJ], { versions });
    assert.equal(ref.claims.find((c) => c.claimType === "crowd.level")!.versionId, "ver-packed");
    assert.equal(ref.claims.find((c) => c.claimType === "crowd.trajectory")!.versionId, null);
  });
});

describe("lib/liveReference — the stored body", () => {
  it("round-trips through the message body", () => {
    const ref = share("experience_state", [CROWD, TRAJ], { note: "look" });
    const body = liveReferenceBody(ref);
    assert.equal(typeof body, "string");
    assert.deepEqual(parseLiveReference(body), ref);
    assert.deepEqual(parseLiveReference(JSON.parse(body)), ref);
  });

  it("refuses what it did not write", () => {
    assert.equal(parseLiveReference("not json"), null);
    assert.equal(parseLiveReference(JSON.stringify({ type: "hidden_gem", gemId: "x" })), null);
    const ref = share("experience_state", [CROWD]);
    assert.equal(parseLiveReference({ ...ref, kind: "opportunity" }), null);
    assert.equal(parseLiveReference({ ...ref, claims: [] }), null);
    assert.equal(parseLiveReference({ ...ref, subject: { ...ref.subject, id: "not-a-uuid" } }), null);
    assert.equal(parseLiveReference({ ...ref, schemaVersion: 2 }), null);
  });
});

describe("lib/liveReference — changed since sharing", () => {
  const LATER = NOW + 10 * 60_000;

  it("the same value on the same evidence is unchanged; on newer evidence it is reaffirmed", () => {
    const ref = share("experience_state", [CROWD, TRAJ]);
    const same = compareLiveReference(ref, [CROWD, TRAJ], LATER);
    assert.equal(same.readable, true);
    assert.equal(same.changedSinceShare, false);
    assert.deepEqual(same.claims.map((c) => c.change), ["unchanged", "unchanged"]);
    assert.equal(same.ageMinutes, 10);

    const reaffirmed = compareLiveReference(ref, [{ ...CROWD, observedAt: iso(5) }, TRAJ], LATER);
    assert.equal(reaffirmed.changedSinceShare, false);
    assert.equal(reaffirmed.claims.find((c) => c.claimType === "crowd.level")!.change, "reaffirmed");
  });

  it("a different value is changed, and flips changedSinceShare", () => {
    const ref = share("experience_state", [CROWD, TRAJ]);
    const c = compareLiveReference(ref, [{ ...CROWD, value: { level: "quiet" }, observedAt: iso(5) }, TRAJ], LATER);
    assert.equal(c.changedSinceShare, true);
    const crowd = c.claims.find((x) => x.claimType === "crowd.level")!;
    assert.equal(crowd.change, "changed");
    assert.equal(crowd.sharedValue, "packed");
    assert.equal(crowd.currentValue, "quiet");
    assert.equal(crowd.currentSnapshotId, CROWD.id);
  });

  it("no current claim is withdrawn before the shared horizon and expired after it", () => {
    const ref = share("experience_state", [CROWD]);
    const before = compareLiveReference(ref, [], LATER);
    assert.equal(before.claims[0]!.change, "withdrawn");
    assert.equal(before.changedSinceShare, true);
    const after = compareLiveReference(ref, [], Date.parse(CROWD.validUntil) + 60_000);
    assert.equal(after.claims[0]!.change, "expired");
    assert.equal(after.changedSinceShare, true);
  });

  it("a claim the reference did not carry, within the kind's types, is added", () => {
    const ref = share("experience_state", [CROWD]);
    const c = compareLiveReference(ref, [CROWD, VIBE, env("event.status", { status: "live" })], LATER);
    assert.deepEqual(
      c.claims.map((x) => [x.claimType, x.change]),
      [
        ["crowd.level", "unchanged"],
        ["vibe.state", "added"],
      ],
    );
    assert.equal(c.changedSinceShare, true);
  });

  it("a safety reference: the notice cleared is changed; a non-safety crowd claim is not added", () => {
    const ref = share("safety_notice", [SAFETY]);
    const cleared = compareLiveReference(ref, [CROWD], LATER);
    assert.equal(cleared.claims[0]!.change, "changed");
    assert.equal(cleared.claims[0]!.currentValue, "packed");
    assert.equal(cleared.changedSinceShare, true);
    const still = compareLiveReference(ref, [{ ...SAFETY, observedAt: iso(4) }], LATER);
    assert.equal(still.claims[0]!.change, "reaffirmed");
    assert.equal(still.changedSinceShare, false);
  });

  it("a world_moment reference says whether the transition's value is still current", () => {
    const [t] = detectTransitions([CROWD], [{ claimType: "crowd.level", value: { level: "busy" }, observedAt: iso(-40), generatedAt: iso(-40) }]);
    const ref = share("world_moment", [CROWD], { transition: t });
    assert.equal(compareLiveReference(ref, [CROWD], LATER).momentStillCurrent, true);
    assert.equal(compareLiveReference(ref, [{ ...CROWD, value: { level: "busy" } }], LATER).momentStillCurrent, false);
    assert.equal(compareLiveReference(ref, [], LATER).momentStillCurrent, false);
    assert.equal(compareLiveReference(ref, [CROWD, VIBE], LATER).changedSinceShare, false, "a moment is one transition; other claims are not its business");
  });

  it("when the current state cannot be read the answer is NULL, never false", () => {
    const ref = share("experience_state", [CROWD]);
    const r = refusedComparison(ref, "live_intelligence_unavailable", LATER);
    assert.equal(r.readable, false);
    assert.equal(r.changedSinceShare, null);
    assert.equal(r.refusal, "live_intelligence_unavailable");
    assert.deepEqual(r.claims, []);
    assert.equal(r.ageMinutes, 10);
  });

  it("the changes that mean 'not what was shared' are exactly four", () => {
    assert.deepEqual([...CHANGES_THAT_DIFFER], ["changed", "expired", "withdrawn", "added"]);
  });
});
