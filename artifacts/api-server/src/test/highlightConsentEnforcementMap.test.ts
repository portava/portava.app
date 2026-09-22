/**
 * §10 — which consent dimensions actually BITE, served on the wire.
 *
 * Highlights/Memories Development Architecture Spec v1 §10: the five consent
 * dimensions STORE / RESURFACE / PERSONALIZE / SHARE /
 * CONTRIBUTE_TO_AGGREGATE_INTEL.
 *
 * WHY THIS EXISTS, AND WHOSE PROBLEM IT SOLVES
 * --------------------------------------------
 * `GET /highlights/:id/projection-policy` already publishes all five
 * dimensions (`consentDimensions: MEMORY_CONSENT_DIMENSIONS`) and `PUT`
 * already stores a patch for any of them. Census §P.2 and H75 record that only
 * TWO of the five are read by anything: `publicProjectionVerdict` asks
 * `SURFACE_CONSENT_DIMENSIONS`, which is RESURFACE + SHARE on a feed and SHARE
 * alone on a navigated-to surface. `mayProject` — the function that would ask
 * the other three — has no production caller at all.
 *
 * Re-measured here rather than taken from the census: `consentFromRow` has
 * exactly ONE non-test caller in the tree, `consentWithholds`, and that
 * function is only ever asked for the dimensions in SURFACE_CONSENT_DIMENSIONS.
 *
 * A client rendering the GET therefore had two bad options — ship five
 * switches of which three do nothing, or hard-code the enforced two and own a
 * second copy of a vocabulary the server defines. This suite pins the third
 * option: the server SAYS which bite, derived from the same table the gate
 * reads, so a sixth dimension or a newly-wired third one changes the wire
 * without anybody editing a client.
 *
 * THE ASSERTION MOST WORTH HAVING is the partition one. `enforced` and
 * `unenforced` must together be exactly §10's five, with no overlap and
 * nothing invented: a dimension that fell out of BOTH lists would be rendered
 * by nobody and enforced by nobody, and no test that only checked `enforced`
 * would notice.
 *
 * Run: node --import tsx/esm --test src/test/highlightConsentEnforcementMap.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { startApp, call, fixtureTables, VIEWER, H_MINE } from "./highlightsSpecHarness.js";
import {
  consentEnforcement,
  SURFACE_CONSENT_DIMENSIONS,
  NON_OWNER_SURFACES,
} from "../services/highlights/highlightPublicProjection.js";
import { MEMORY_CONSENT_DIMENSIONS } from "../services/highlights/highlightProjectionPolicy.js";

describe("§10 the enforcement map is DERIVED, never retyped", () => {
  it("enforced is exactly the union of SURFACE_CONSENT_DIMENSIONS", () => {
    const union = new Set(NON_OWNER_SURFACES.flatMap((s) => [...SURFACE_CONSENT_DIMENSIONS[s]]));
    assert.deepEqual([...consentEnforcement().enforced].sort(), [...union].sort());
  });

  it("enforced + unenforced PARTITION §10's five — no overlap, nothing invented, nothing dropped", () => {
    const { enforced, unenforced } = consentEnforcement();
    const all = [...enforced, ...unenforced].sort();
    assert.deepEqual(all, [...MEMORY_CONSENT_DIMENSIONS].sort(), "the two lists must cover §10 exactly");
    assert.equal(new Set(all).size, all.length, "a dimension may not be in both lists");
  });

  it("names the surfaces each enforced dimension is read on, so 'enforced' is not a bare claim", () => {
    const { bySurface } = consentEnforcement();
    assert.deepEqual(bySurface.public_projection, ["SHARE"]);
    assert.deepEqual([...bySurface.proactive_resurfacing].sort(), ["RESURFACE", "SHARE"]);
  });

  it("records the three that are stored and read by nothing, with the reason", () => {
    const { unenforced } = consentEnforcement();
    assert.deepEqual(
      [...unenforced].sort(),
      ["CONTRIBUTE_TO_AGGREGATE_INTEL", "PERSONALIZE", "STORE"],
      "census H75: stored by the writer, read by no surface",
    );
  });
});

describe("§10 GET /highlights/:id/projection-policy publishes it", () => {
  it("serves consentEnforcement beside consentDimensions", async () => {
    const t = fixtureTables();
    const app = await startApp({ tables: t });
    try {
      const r = await call(app, "GET", `/api/highlights/${H_MINE}/projection-policy`, VIEWER);
      assert.equal(r.status, 200);
      assert.deepEqual([...r.body.consentDimensions].sort(), [...MEMORY_CONSENT_DIMENSIONS].sort());
      assert.ok(r.body.consentEnforcement, "the client cannot tell a live switch from a dead one without this");
      assert.deepEqual([...r.body.consentEnforcement.enforced].sort(), ["RESURFACE", "SHARE"]);
      assert.deepEqual(
        [...r.body.consentEnforcement.unenforced].sort(),
        ["CONTRIBUTE_TO_AGGREGATE_INTEL", "PERSONALIZE", "STORE"],
      );
      assert.deepEqual(r.body.consentEnforcement.bySurface.public_projection, ["SHARE"]);
    } finally { await app.close(); }
  });

  it("the published map is the one the gate reads, not a literal in the route", async () => {
    // Asserted by comparing the WIRE against the module rather than against a
    // second hard-coded list here. A route that copied the answer would pass a
    // literal test and diverge the first time the gate changed.
    const app = await startApp({ tables: fixtureTables() });
    try {
      const r = await call(app, "GET", `/api/highlights/${H_MINE}/projection-policy`, VIEWER);
      assert.deepEqual(r.body.consentEnforcement, JSON.parse(JSON.stringify(consentEnforcement())));
    } finally { await app.close(); }
  });
});
