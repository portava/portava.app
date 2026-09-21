/**
 * Trips spec §9.3 — the `TripProposal` contract (census-trips TR153).
 *
 * The row said five of the eight fields "are not columns — they would have to
 * live in `payload_json`, which is a shape the contract does not specify."
 * 2774 made two of the five columns and documented the other three as payload
 * keys without ever naming them. These tests are that naming, made checkable:
 * the reader and the writer agree on one spelling, the reader still accepts
 * the camelCase one that was already in the wild, and the three fields the
 * governance turns on are ABSENT rather than defaulted when nobody recorded
 * them.
 *
 * Runtime: node:test + node:assert/strict. PURE — no client, no server.
 * Run: node --import tsx/esm --test src/test/tripProposalContract.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  TRIP_PROPOSAL_DECISION_RULES,
  TRIP_PROPOSAL_PAYLOAD_KEYS,
  readTripProposal,
  proposalContractPayload,
} from "../domain/trips/contracts/TripProposalContract.js";

const ROW = {
  id: "p1",
  trip_id: "t1",
  proposal_type: "move_plan",
  status: "pending",
  expires_at: "2026-08-14T23:59:59.000Z",
  affected_version: 7,
  decision_rule: "majority",
  proposed_by: "u1",
  payload_json: {
    op: "move",
    affected_objects: ["plan-1", "res-9"],
    rationale: "rain is forecast at 0.8 confidence over the hike",
    impact_summary: "1 booking at risk; deadline 2026-08-13",
  },
};

describe("§9.3 TripProposal — all eight fields, read from one row", () => {
  it("names every field §9.3 lists, from columns and documented payload keys together", () => {
    const c = readTripProposal(ROW);
    assert.equal(c.type, "move_plan");
    assert.equal(c.proposedBy, "u1");
    assert.deepEqual(c.affectedObjects, ["plan-1", "res-9"]);
    assert.equal(c.rationale, "rain is forecast at 0.8 confidence over the hike");
    assert.equal(c.impactSummary, "1 booking at risk; deadline 2026-08-13");
    assert.equal(c.decisionRule, "majority");
    assert.equal(c.status, "pending");
    assert.equal(c.expiresAt, "2026-08-14T23:59:59.000Z");
  });

  it("lifts the three contract fields OUT of `payload`, so a consumer cannot see two of each", () => {
    const c = readTripProposal(ROW);
    assert.deepEqual(c.payload, { op: "move" });
    assert.equal("rationale" in c.payload, false);
    assert.equal("affected_objects" in c.payload, false);
    assert.equal("impact_summary" in c.payload, false);
  });

  it("still reads the camelCase spellings §9.3 itself uses — rows already written that way are not dropped", () => {
    const c = readTripProposal({
      ...ROW,
      payload_json: { affectedObjects: ["plan-2"], impactSummary: "no bookings affected", rationale: "the museum is closed" },
    });
    assert.deepEqual(c.affectedObjects, ["plan-2"]);
    assert.equal(c.impactSummary, "no bookings affected");
    assert.equal(c.rationale, "the museum is closed");
    assert.deepEqual(c.payload, {}, "both spellings are lifted, not just the canonical one");
  });

  it("an unrecorded rationale or impact summary is NULL, never an empty string", () => {
    const c = readTripProposal({ ...ROW, payload_json: {} });
    assert.equal(c.rationale, null);
    assert.equal(c.impactSummary, null);
    assert.deepEqual(c.affectedObjects, []);
  });

  it("an UNREAD decision rule is null, and is never defaulted to 2774's column default", () => {
    // A pre-2774 database, or a select that did not name the column.
    const { decision_rule: _dropped, ...pre2774 } = ROW;
    assert.equal(readTripProposal(pre2774).decisionRule, null,
      "inventing `host` here would let a caller close a proposal under a rule nobody set");
  });

  it("an UNRECOGNISED decision rule is null too — an unknown rule is not a permissive one", () => {
    assert.equal(readTripProposal({ ...ROW, decision_rule: "whoever_shouts" }).decisionRule, null);
    for (const r of TRIP_PROPOSAL_DECISION_RULES) {
      assert.equal(readTripProposal({ ...ROW, decision_rule: r }).decisionRule, r);
    }
  });

  it("an unknown author stays unknown — it is never attributed to anyone", () => {
    assert.equal(readTripProposal({ ...ROW, proposed_by: null }).proposedBy, null);
  });

  it("is total: a malformed payload costs that proposal's payload fields, not the whole read", () => {
    for (const payload of [null, "a string", 42, ["an", "array"]]) {
      const c = readTripProposal({ ...ROW, payload_json: payload });
      assert.deepEqual(c.affectedObjects, []);
      assert.equal(c.rationale, null);
      assert.equal(c.type, "move_plan", "the columns still read");
    }
  });

  it("drops non-string entries from affectedObjects rather than stringifying them", () => {
    const c = readTripProposal({ ...ROW, payload_json: { affected_objects: ["plan-1", { id: "x" }, null, 3, ""] } });
    assert.deepEqual(c.affectedObjects, ["plan-1"]);
  });
});

describe("§9.3 TripProposal — the write half spells the keys once", () => {
  it("writes the canonical keys, and a round trip through the reader returns what went in", () => {
    const payload = proposalContractPayload({ op: "move", planId: "plan-1" }, {
      affectedObjects: ["plan-1"], rationale: "why", impactSummary: "what it costs",
    });
    assert.equal(payload[TRIP_PROPOSAL_PAYLOAD_KEYS.rationale], "why");
    assert.equal(payload[TRIP_PROPOSAL_PAYLOAD_KEYS.impactSummary], "what it costs");
    const back = readTripProposal({ ...ROW, payload_json: payload });
    assert.deepEqual(back.affectedObjects, ["plan-1"]);
    assert.equal(back.rationale, "why");
    assert.equal(back.impactSummary, "what it costs");
    assert.deepEqual(back.payload, { op: "move", planId: "plan-1" });
  });

  it("OMITS a field the caller did not supply — absent is 'not recorded', null would be a record", () => {
    const payload = proposalContractPayload({ op: "cancel" }, { rationale: null, impactSummary: "", affectedObjects: [] });
    assert.equal(TRIP_PROPOSAL_PAYLOAD_KEYS.rationale in payload, false);
    assert.equal(TRIP_PROPOSAL_PAYLOAD_KEYS.impactSummary in payload, false);
    assert.equal(TRIP_PROPOSAL_PAYLOAD_KEYS.affectedObjects in payload, false);
    assert.deepEqual(payload, { op: "cancel" });
  });

  it("a `change` carrying its own rationale cannot become a SECOND, disagreeing rationale", () => {
    const payload = proposalContractPayload({ op: "move", rationale: "the model's stray key", affectedObjects: ["nope"] }, {
      rationale: "the one the caller meant", affectedObjects: ["plan-1"],
    });
    assert.equal(payload.rationale, "the one the caller meant");
    assert.deepEqual(payload.affected_objects, ["plan-1"]);
    assert.equal("affectedObjects" in payload, false);
  });
});
