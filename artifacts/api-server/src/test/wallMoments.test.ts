/**
 * Sensing §9 — WallMoment transitions (census-sensing S73, S74, S76).
 *
 * A moment is a CHANGE. The same value projected again is not one; a change
 * with no recorded previous value is not one; a sub-k previous is never read
 * (that is the reader's job, pinned in wallMomentsRoute.test.ts). Each kind
 * comes from its own claim family; a safety activation only from a served
 * unsafe_density. Every moment carries the eight fields §9 names, and the
 * truth block of the envelope that evidences it.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  WALL_TRANSITIONS,
  buildWallMoment,
  buildWallMoments,
  claimScalar,
  detectTransitions,
  type PreviousReading,
} from "../lib/wallMoments.js";
import type { LiveClaimEnvelope } from "../lib/liveClaimRead.js";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NOW = Date.parse("2026-09-12T20:00:00.000Z");
const iso = (offsetMinutes: number) => new Date(NOW + offsetMinutes * 60_000).toISOString();
const PLACE = "88888888-bbbb-4bbb-8bbb-888888888888";

let seq = 0;
function env(over: Partial<LiveClaimEnvelope> = {}): LiveClaimEnvelope {
  seq += 1;
  return {
    id: `snap-${seq}`,
    claimType: "crowd.level",
    value: { level: "packed" },
    confidence: 0.85,
    band: "live",
    sourceClass: "firsthand_unverified",
    sourceCountBucket: "few",
    observedAt: iso(-3),
    validUntil: iso(27),
    state: "live",
    conflictState: "none",
    conflict: null,
    ...over,
  };
}
const prev = (claimType: string, value: unknown, generatedMinutes: number): PreviousReading => ({
  claimType,
  value,
  observedAt: iso(generatedMinutes - 1),
  generatedAt: iso(generatedMinutes),
});

describe("vocabulary", () => {
  it("is §9's place-state transitions", () => {
    assert.deepEqual([...WALL_TRANSITIONS], ["warming", "building", "peaking", "cooling", "crowd_shift", "vibe_change", "queue_change", "safety_notice_activated", "safety_notice_cleared"]);
  });
  it("reads no clock and no database", () => {
    const code = readFileSync(join(SRC, "lib", "wallMoments.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    assert.doesNotMatch(code, /Date\.now\(|new Date\(\)/);
    assert.doesNotMatch(code, /supabase|getServiceClient|\.from\(/);
  });
});

describe("a moment is a change, not a snapshot (S73)", () => {
  it("the same value projected again is NOT a transition", () => {
    const t = detectTransitions([env({ value: { level: "busy" } })], [prev("crowd.level", { level: "busy" }, -30), prev("crowd.level", { level: "busy" }, -15)]);
    assert.deepEqual(t, []);
  });
  it("no recorded previous value is NOT a transition — a first reading is not a change", () => {
    assert.deepEqual(detectTransitions([env()], []), []);
  });
  it("a changed value IS a transition, from the last differing value, dated when the current value became current", () => {
    const t = detectTransitions(
      [env({ value: { level: "packed" }, observedAt: iso(-3) })],
      [prev("crowd.level", { level: "quiet" }, -60), prev("crowd.level", { level: "busy" }, -40), prev("crowd.level", { level: "packed" }, -20), prev("crowd.level", { level: "packed" }, -10)],
    );
    assert.equal(t.length, 1);
    assert.equal(t[0]!.kind, "crowd_shift");
    assert.equal(t[0]!.from, "busy");
    assert.equal(t[0]!.to, "packed");
    assert.equal(t[0]!.occurredAt, iso(-20), "the FIRST version that carried the current value after the last differing one");
  });
  it("history order does not matter — the reader hands rows newest first", () => {
    const t = detectTransitions([env({ value: { level: "packed" } })], [prev("crowd.level", { level: "packed" }, -10), prev("crowd.level", { level: "busy" }, -40)]);
    assert.equal(t.length, 1);
    assert.equal(t[0]!.from, "busy");
  });
  it("when no version yet carries the current value, the change is dated at the current observation", () => {
    const t = detectTransitions([env({ value: { level: "packed" }, observedAt: iso(-3) })], [prev("crowd.level", { level: "busy" }, -40)]);
    assert.equal(t[0]!.occurredAt, iso(-3));
  });
  it("one transition at most per claim type; other claim types' history is ignored", () => {
    const t = detectTransitions([env({ value: { level: "packed" } })], [prev("vibe.state", { state: "dead" }, -30), prev("crowd.level", { level: "busy" }, -30)]);
    assert.equal(t.length, 1);
    assert.equal(t[0]!.claimType, "crowd.level");
  });
});

describe("each kind from its own evidence", () => {
  it("a safety activation ONLY from a served unsafe_density, and the clearing when it goes", () => {
    const on = detectTransitions([env({ value: { level: "unsafe_density" } })], [prev("crowd.level", { level: "packed" }, -30)]);
    assert.equal(on[0]!.kind, "safety_notice_activated");
    const off = detectTransitions([env({ value: { level: "busy" } })], [prev("crowd.level", { level: "unsafe_density" }, -30)]);
    assert.equal(off[0]!.kind, "safety_notice_cleared");
    const ordinary = detectTransitions([env({ value: { level: "packed" } })], [prev("crowd.level", { level: "busy" }, -30)]);
    assert.equal(ordinary[0]!.kind, "crowd_shift");
  });
  it("trajectory: emerging is warming, building is building, peaking is peaking, declining is cooling, stable is no moment", () => {
    const kinds = (to: string) => detectTransitions([env({ claimType: "crowd.trajectory", value: { trajectory: to } })], [prev("crowd.trajectory", { trajectory: "quiet_start" }, -30)]).map((t) => t.kind);
    assert.deepEqual(kinds("emerging"), ["warming"]);
    assert.deepEqual(kinds("building"), ["building"]);
    assert.deepEqual(kinds("peaking"), ["peaking"]);
    assert.deepEqual(kinds("declining"), ["cooling"]);
    assert.deepEqual(kinds("stable"), []);
  });
  it("vibe and queue changes", () => {
    const v = detectTransitions([env({ claimType: "vibe.state", value: { state: "going_off" } })], [prev("vibe.state", { state: "social" }, -30)]);
    assert.equal(v[0]!.kind, "vibe_change");
    const q = detectTransitions([env({ claimType: "queue.wait", value: { minMinutes: 40, maxMinutes: null } })], [prev("queue.wait", { minMinutes: 10, maxMinutes: null }, -30)]);
    assert.equal(q[0]!.kind, "queue_change");
    assert.equal(q[0]!.from, "10");
    assert.equal(q[0]!.to, "40");
  });
  it("a claim type with no comparable scalar yields nothing", () => {
    assert.equal(claimScalar("access.walk_in", { accepted: true }), null);
    assert.deepEqual(detectTransitions([env({ claimType: "access.walk_in", value: { accepted: true } })], [prev("access.walk_in", { accepted: false }, -30)]), []);
  });
});

describe("the WallMoment (S74)", () => {
  it("carries subject, transition, occurred_at, relevance window, reason, truth class, freshness and expiry", () => {
    const [t] = detectTransitions([env({ value: { level: "packed" }, id: "snap-x", observedAt: iso(-3), validUntil: iso(27), sourceCountBucket: "several" })], [prev("crowd.level", { level: "busy" }, -40), prev("crowd.level", { level: "packed" }, -20)]);
    const m = buildWallMoment(PLACE, t!, NOW);
    assert.deepEqual(m.subject, { kind: "place", id: PLACE });
    assert.deepEqual(m.transition, { kind: "crowd_shift", claimType: "crowd.level", from: "busy", to: "packed" });
    assert.equal(m.occurredAt, iso(-20));
    assert.deepEqual(m.relevanceWindow, { from: iso(-20), until: iso(27) });
    assert.equal(m.reason.code, "crowd_shift");
    assert.equal(m.reason.text, "Crowd busy → packed");
    assert.equal(m.truthClass, "corroborated");
    assert.equal(m.confidence, "live");
    assert.equal(m.freshness, "live");
    assert.equal(m.coverage, "several");
    assert.equal(m.expiresAt, iso(27));
    assert.equal(m.claimRef, "snap-x");
    assert.equal(m.id, `moment:${PLACE}:crowd.level:${iso(-20)}:packed`);
  });
  it("the truth block is the evidencing envelope's — a sponsored change is inferred, a stale one stale", () => {
    const [s] = detectTransitions([env({ sourceClass: "sponsored" })], [prev("crowd.level", { level: "busy" }, -30)]);
    assert.equal(buildWallMoment(PLACE, s!, NOW).truthClass, "inferred");
  });
  it("names no contributor, no coordinate and no count", () => {
    const [t] = detectTransitions([env()], [prev("crowd.level", { level: "busy" }, -30)]);
    const json = JSON.stringify(buildWallMoment(PLACE, t!, NOW));
    assert.doesNotMatch(json, /actor|contributor|latitude|longitude|distinct/i);
  });
  it("buildWallMoments drops expired moments and orders newest change first", () => {
    const current = [
      env({ claimType: "crowd.level", value: { level: "packed" }, validUntil: iso(27) }),
      env({ claimType: "vibe.state", value: { state: "going_off" }, validUntil: iso(-1) }),
      env({ claimType: "crowd.trajectory", value: { trajectory: "peaking" }, validUntil: iso(20) }),
    ];
    const previous = [
      prev("crowd.level", { level: "busy" }, -50), prev("crowd.level", { level: "packed" }, -30),
      prev("vibe.state", { state: "social" }, -50), prev("vibe.state", { state: "going_off" }, -5),
      prev("crowd.trajectory", { trajectory: "building" }, -50), prev("crowd.trajectory", { trajectory: "peaking" }, -10),
    ];
    const ms = buildWallMoments(PLACE, current, previous, NOW);
    assert.deepEqual(ms.map((m) => m.transition.kind), ["peaking", "crowd_shift"], "the expired vibe moment is gone; newest first");
  });
});
