/**
 * sensingSubjectReconciliation — §18.3 / §14: an observed cluster resolves to
 * Place / Event / temporary world object / unknown, and NEVER to the nearest
 * place merely to satisfy a foreign key. Census S111 (two of four outcomes
 * unrepresentable on the intel path) and S97 (no nearest-place snapping —
 * previously an unguarded absence).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  OWNERSHIP_EVIDENCE,
  SUBJECT_EVIDENCE_KINDS,
  isOwnershipEvidence,
  reconcileSensingSubject,
  subjectMayBeNamed,
} from "../lib/sensingSubjectReconciliation.js";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MODULE_TS = readFileSync(join(SRC, "lib", "sensingSubjectReconciliation.ts"), "utf8");
/** Comment-stripped: prose may name what code may not contain. */
const CODE = MODULE_TS.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

describe("never the nearest place", () => {
  it("a cluster with only a PROXIMITY candidate is unknown, however near", () => {
    const r = reconcileSensingSubject({ zoneId: "z1", candidates: [{ kind: "place", id: "p1", evidence: "proximity" }] });
    assert.deepEqual(r, { kind: "unknown", zoneId: "z1" });
    assert.equal(subjectMayBeNamed(r), false);
  });

  it("a name match is not ownership either", () => {
    const r = reconcileSensingSubject({ zoneId: "z1", candidates: [{ kind: "event", id: "e1", evidence: "name_match" }] });
    assert.equal(r.kind, "unknown");
  });

  it("the module has no distance threshold — 'close enough' cannot become ownership", () => {
    assert.doesNotMatch(CODE, /distance|radius|haversine|meters|metres/i);
    assert.doesNotMatch(CODE, /Math\.(min|hypot|sqrt)/);
  });
});

describe("all four §18.3 outcomes are representable", () => {
  it("place, on an ownership signal", () => {
    const r = reconcileSensingSubject({ zoneId: "z1", candidates: [{ kind: "place", id: "p1", evidence: "venue_anchor" }] });
    assert.deepEqual(r, { kind: "place", id: "p1", evidence: "venue_anchor" });
    assert.equal(subjectMayBeNamed(r), true);
  });
  it("event, on an event QR", () => {
    const r = reconcileSensingSubject({ zoneId: "z1", candidates: [{ kind: "event", id: "e1", evidence: "event_qr" }] });
    assert.deepEqual(r, { kind: "event", id: "e1", evidence: "event_qr" });
  });
  it("temporary world object, when a persistent cluster has no owner — keyed on the zone, never a place row", () => {
    const r = reconcileSensingSubject({ zoneId: "z9", candidates: [{ kind: "place", id: "p1", evidence: "proximity" }], persistent: true });
    assert.deepEqual(r, { kind: "temporary_world_object", zoneId: "z9" });
    assert.equal(subjectMayBeNamed(r), false);
  });
  it("unknown, by default", () => {
    assert.deepEqual(reconcileSensingSubject({ zoneId: "z1", candidates: [] }), { kind: "unknown", zoneId: "z1" });
  });
});

describe("ownership evidence", () => {
  it("is exactly anchor / check-in / event QR / operator, and proximity and name match are excluded", () => {
    assert.deepEqual([...OWNERSHIP_EVIDENCE], ["venue_anchor", "checkin", "event_qr", "operator_assignment"]);
    for (const k of SUBJECT_EVIDENCE_KINDS) {
      assert.equal(isOwnershipEvidence(k), OWNERSHIP_EVIDENCE.includes(k), k);
    }
    assert.equal(isOwnershipEvidence("proximity"), false);
    assert.equal(isOwnershipEvidence("name_match"), false);
  });

  it("an operator assignment outranks an anchor; otherwise the first owned candidate wins — never the nearer", () => {
    const r = reconcileSensingSubject({
      zoneId: "z1",
      candidates: [
        { kind: "place", id: "anchor", evidence: "venue_anchor" },
        { kind: "place", id: "assigned", evidence: "operator_assignment" },
      ],
    });
    assert.equal(r.kind === "place" && r.id, "assigned");
    const r2 = reconcileSensingSubject({
      zoneId: "z1",
      candidates: [
        { kind: "place", id: "near", evidence: "proximity" },
        { kind: "event", id: "qr", evidence: "event_qr" },
      ],
    });
    assert.equal(r2.kind === "event" && r2.id, "qr");
  });

  it("a malformed candidate (no id / unknown kind) is not ownership", () => {
    const r = reconcileSensingSubject({ zoneId: "z1", candidates: [{ kind: "place", id: "", evidence: "venue_anchor" }] });
    assert.equal(r.kind, "unknown");
    assert.throws(() => reconcileSensingSubject({ zoneId: "", candidates: [] }));
  });

  it("reads no store and no clock", () => {
    assert.doesNotMatch(MODULE_TS, /supabase|getServiceClient|\.from\(|Date\.now/);
  });
});
