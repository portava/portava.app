/**
 * A labelled requirement id must not name another requirement's object.
 *
 * THE FAILURE, MEASURED
 * =====================
 * census-trips §29.4 restates rows it moved, labelling each id with the object
 * it is about. Its last two rows read `TR89 trip_snapshots` and
 * `TR90 trip_outcomes`. The census's own §5.1 body assigns TR89 `trip_events`,
 * TR90 `trip_snapshots` and TR91 `trip_outcomes`: from TR89 on, the ids ran one
 * ahead of the objects.
 *
 * checkCensusIntegrity takes the ID, correctly — the id is the requirement — so
 * the consequences were three different things and only one of them was
 * visible:
 *
 *   TR89  was ALREADY W. The row claiming to move it N->W moved nothing, and
 *         attached trip_snapshots' evidence to trip_events.
 *   TR90  received trip_outcomes' evidence. W happened to be right for
 *         trip_snapshots too, so it was accidentally correct.
 *   TR91  WAS NEVER MOVED. It kept NOT-BUILT with the evidence "Does not
 *         exist." while CREATE TABLE public.trip_outcomes sat in a migration on
 *         merged main.
 *
 * The error then propagated INTO THE CODE:
 * 2768_trip_kernel_presence_proposal_outcome_families.sql comments
 * `RECORD_OUTCOME -> trip_outcomes (TR90)`, citing the census's own off-by-one
 * back at it. Two documents agreeing on a wrong id is how a wrong id survives
 * review.
 *
 * WHAT THESE TESTS PIN
 * ====================
 * Mostly they pin the NARROWNESS. The obvious rule — "a label must match the
 * body" — fires on three legitimate refinements in the real corpus, and the
 * prefix scoping that keeps it honest is the kind of thing a later cleanup
 * deletes as redundant. The census-discovery case below is that scoping's
 * reason, kept as a test so deleting it fails rather than starts accusing a
 * document that is doing exactly the right thing.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { findMislabelledRows, leadingIdent, prefixOf } from "../scripts/lib/censusRowLabels.js";

/** The shape of the real defect, reduced to its four rows. */
const OFF_BY_ONE = [
  "| id | Requirement | V | Evidence |",
  "| --- | --- | --- | --- |",
  "| TR89 | `trip_events` | **W** | nearest deployed table. |",
  "| TR90 | `trip_snapshots` | **N** | Does not exist. |",
  "| TR91 | `trip_outcomes` | **N** | Does not exist. |",
  "",
  "### Row moves",
  "",
  "| id | was | now | why |",
  "|---|---|---|---|",
  "| TR89 `trip_snapshots` | N | **W** | 2773 fold/replay/verify. |",
  "| TR90 `trip_outcomes` | N | **W** | 2768 RECORD_OUTCOME. |",
].join("\n");

describe("findMislabelledRows — the defect", () => {
  it("flags both halves of the off-by-one and names the id each label belongs to", () => {
    const found = findMislabelledRows(OFF_BY_ONE);
    assert.equal(found.length, 2);

    assert.equal(found[0]!.id, "TR89");
    assert.equal(found[0]!.label, "trip_snapshots");
    assert.equal(found[0]!.belongsTo, "TR90");
    assert.equal(found[0]!.ownBody, "trip_events");

    assert.equal(found[1]!.id, "TR90");
    assert.equal(found[1]!.label, "trip_outcomes");
    assert.equal(found[1]!.belongsTo, "TR91");
    assert.equal(found[1]!.ownBody, "trip_snapshots");
  });

  it("goes green once the ids are corrected to the objects the evidence describes", () => {
    const fixed = OFF_BY_ONE
      .replace("| TR89 `trip_snapshots` |", "| TR90 `trip_snapshots` |")
      .replace("| TR90 `trip_outcomes` |", "| TR91 `trip_outcomes` |");
    assert.deepEqual(findMislabelledRows(fixed), []);
  });

  it("still flags a single half — the defect does not need a consecutive pair", () => {
    const halfFixed = OFF_BY_ONE.replace("| TR89 `trip_snapshots` |", "| TR90 `trip_snapshots` |");
    const found = findMislabelledRows(halfFixed);
    assert.equal(found.length, 1);
    assert.equal(found[0]!.id, "TR90");
    assert.equal(found[0]!.belongsTo, "TR91");
  });
});

describe("findMislabelledRows — what it must NOT accuse", () => {
  /**
   * THE FALSE POSITIVE THE FIRST RUN PRODUCED, TWICE, ON census-discovery.
   * That census keys requirements A/B/C, open decisions D1..D10, and the fixes
   * that closed them F1..F5. D2 is "migrate the community byline to
   * displayName"; F2 is "canonical displayName on the community byline" — F2
   * closes D2 and says so by reusing the word. Without prefix scoping the check
   * reported that as a mislabelled row.
   */
  it("does not cross id namespaces: a fix row may name the decision it closed", () => {
    const doc = [
      "| # | Decision | Where it bites |",
      "|---|---|---|",
      "| D2 | Migrate the community byline to `displayName`. | C19 |",
      "| D9 | Ratify the `DiscoveryCandidate` mapping defaults. | A25 |",
      "",
      "| Fix | Files | Rows closed |",
      "|---|---|---|",
      "| F2 — canonical `displayName` on the community byline | routes/discovery.ts | C19 |",
      "| F5 — server-built `DiscoveryCandidate` projection | lib/discoveryCandidate.ts | A25 |",
    ].join("\n");
    assert.deepEqual(findMislabelledRows(doc), []);
  });

  /**
   * The three legitimate refinements in the real corpus, in one document: a
   * label may name the TABLE behind a type, a COLUMN of the object, or a KEY
   * inside the function — as long as it is not another row's object.
   */
  it("allows a label that refines rather than renames", () => {
    const doc = [
      "| id | Requirement | V | Evidence |",
      "| --- | --- | --- | --- |",
      "| MD36 | `MediaAsset` canonical contract | **W** | the table is complete. |",
      "| C13 | `applyEventCaps` keys on the vocabulary emitters write | **W** | ... |",
      "",
      "| id | was | now | why |",
      "|---|---|---|---|",
      "| MD36 `media_assets` | W | **W** | the canonical store has no writer. |",
      "| C13 — cap map keys on `gps_coordinate_jump` | W | **C** | TrustCapService.ts:170. |",
    ].join("\n");
    assert.deepEqual(findMislabelledRows(doc), []);
  });

  it("says nothing about a prose label — there is no identifier to compare", () => {
    const doc = [
      "| id | Requirement | V | Evidence |",
      "| --- | --- | --- | --- |",
      "| TR136 | `stage_locality` check | **N** | no implementation. |",
      "| TR144 | `propagateRisks` | **N** | absent. |",
      "",
      "| id | was | now | why |",
      "|---|---|---|---|",
      "| TR136 stage-locality | N | **N** | still no implementation. |",
      "| TR144 risk propagation | N | **W** | served as elementRisks. |",
    ].join("\n");
    // TR144's label names TR136's... nothing: neither label is backticked, so
    // neither is comparable. This is the check's stated blind spot, pinned so it
    // is not mistaken for a pass.
    assert.deepEqual(findMislabelledRows(doc), []);
  });

  it("drops an identifier two body rows in the same sequence both claim, rather than guessing", () => {
    const doc = [
      "| id | Requirement | V | Evidence |",
      "| --- | --- | --- | --- |",
      "| TR1 | `trip_plan_items` shape | **W** | ... |",
      "| TR2 | `trip_plan_items` ordering | **W** | ... |",
      "",
      "| id | was | now | why |",
      "|---|---|---|---|",
      "| TR3 `trip_plan_items` | N | **W** | ambiguous owner: not an accusation. |",
    ].join("\n");
    assert.deepEqual(findMislabelledRows(doc), []);
  });
});

describe("leadingIdent / prefixOf", () => {
  it("takes the FIRST backticked identifier, because a body cell cites several", () => {
    // The real TR14 cell: the object, then the nearest existing table, then the
    // migration. Only the first is what the row is about.
    assert.equal(
      leadingIdent("`TripLeg` — movement transition. `route_legs` (`0058_trip_flow.sql`) is a geometry edge."),
      "TripLeg",
    );
    assert.equal(leadingIdent("no identifier here"), null);
    // Two characters is too short to be a meaningful object name and sweeps in
    // prose; the floor is three.
    assert.equal(leadingIdent("`ok`"), null);
  });

  it("reads the numbering sequence, hyphenated prefixes included", () => {
    assert.equal(prefixOf("TR91"), "TR");
    assert.equal(prefixOf("MD36"), "MD");
    assert.equal(prefixOf("C13"), "C");
    // census-compass numbers its rows CX-03, and a prefix reader without the
    // hyphen once parsed that whole census as empty.
    assert.equal(prefixOf("CX-03"), "CX-");
  });
});
