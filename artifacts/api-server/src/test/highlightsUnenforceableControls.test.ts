/**
 * §11 on the proactive feeds, after migration 2720 LANDED.
 *
 * Highlights/Memories Development Architecture Spec v1 §11 / §21 —
 * the six resurfacing controls, and §28.11's rule that a failure must not be
 * served as a plausible-looking answer.
 *
 * WHY THIS IS NEW WORK AND NOT A SECOND COPY OF highlightConsentPolicy.test.ts
 * ===========================================================================
 * Every §11 assertion this repository had was written while
 * `highlight_resurfacing_preferences` did not exist in any database. Under that
 * condition `probeHighlightObject` answers `absent`, `isSuppressed` returns
 * false for everything, and the ONLY behaviour reachable in production was "the
 * control is not deployed". `production-applied-migrations.json` records 2720
 * applied to production on 2026-09-15 and
 * `snapshots/20260915-production-schema.json` holds the table, so every row a
 * user writes into it now REACHES `applyResurfacingControls` — and what that
 * function does with each control stopped being hypothetical on that date.
 *
 * TWO THINGS IT DID, AND ONE OF THEM WAS A SILENT FAIL-OPEN
 * ---------------------------------------------------------
 * `applyResurfacingControls` consulted a hand-written list:
 *
 *     const FEED_SUPPRESSING_CONTROLS = ["DO_NOT_RESURFACE", "KEEP_PRIVATE_FOREVER"];
 *     ...
 *     for (const c of FEED_SUPPRESSING_CONTROLS) if (isSuppressed(set, c, h.id)) return false;
 *     if (isSuppressed(set, "HIDE_PERSON_FROM_RESURFACING", h.owner_id)) return false;
 *
 * `CONTROL_EFFECTS` names a FOURTH control that suppresses
 * `proactive_resurfacing` — `HIDE_TRIP` — and that loop never asks about it.
 * The read layer loads a `HIDE_TRIP` row happily (`isResurfacingControl`
 * accepts it, so the set is `ready` and not downgraded), the filter never
 * consults it, and the Highlight is resurfaced. A user who asked that a whole
 * trip stop coming back at them got a 200 and their trip back.
 *
 * IT CANNOT BE FIXED BY LOOKING THE SUBJECT UP, AND THAT IS THE POINT.
 * `HIDE_TRIP`'s subject is a trip id. `public.highlights` in production carries
 * NO trip column at all — `snapshots/20260915-production-schema.json` lists 22
 * columns and none of them references a trip (asserted in
 * `src/test/highlightsMemoriesDeployedStorage.test.ts`). So there is no join,
 * no projection and no query that would tell this feed which trip a Highlight
 * belongs to. Census H90 records the blocker as "storage is 2720, unapplied";
 * that is no longer true, and the real blocker is a column on a different
 * table.
 *
 * So the choice is between serving a Highlight the owner asked to hide and
 * withholding more than they asked for, and this module has already made that
 * choice twice in the same direction: an `unreadable` set suppresses
 * EVERYTHING, and a set holding an unrecognised control is downgraded whole
 * rather than "enforcing a partial policy that looks complete". The same rule
 * is applied here to a control that is recognised and cannot be resolved.
 *
 * WHAT THIS SUITE DOES NOT PROVE. It does not prove `HIDE_TRIP` works — it
 * cannot, because §11 asks for ONE trip to be hidden and what happens instead
 * is that the owner's whole proactive surface is withheld. Census H90 stays
 * BUILT-BUT-WRONG on exactly that, and this suite is the evidence for the
 * grade, not an argument against it.
 *
 * Run: node --import tsx/esm --test src/test/highlightsUnenforceableControls.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  CONTROL_EFFECTS,
  RESURFACING_CONTROLS,
  suppressions,
  unenforceableControls,
  FEED_ENFORCEABLE_CONTROLS,
} from "../services/highlights/highlightResurfacing.js";
import {
  startApp, call, fixtureTables, listIds, feedIds,
  VIEWER, OWNER, H_PUB, H_MINE,
} from "./highlightsSpecHarness.js";

function tablesWith(rows: any[]) {
  const t = fixtureTables();
  t.highlight_resurfacing_preferences = rows;
  return t;
}

describe("the feed's enforceable set is DERIVED from CONTROL_EFFECTS, not retyped beside it", () => {
  it("every control that suppresses proactive_resurfacing is either enforceable or named unenforceable", () => {
    // The assertion that makes the derivation load-bearing: a seventh control
    // added to CONTROL_EFFECTS tomorrow cannot be silently unenforced, because
    // it has to land in one of these two sets and the second one is refused at
    // request time.
    const suppressing = RESURFACING_CONTROLS.filter((c) =>
      (CONTROL_EFFECTS[c].suppresses as readonly string[]).includes("proactive_resurfacing"),
    );
    assert.ok(suppressing.length >= 4, `expected at least four, got ${JSON.stringify(suppressing)}`);
    for (const c of suppressing) {
      const enforceable = (FEED_ENFORCEABLE_CONTROLS as readonly string[]).includes(c);
      const named = unenforceableControls(suppressions([{ control: c, subjectId: "x" }])).includes(c as any);
      assert.ok(
        enforceable !== named,
        `${c} must be exactly one of enforceable / named-unenforceable, not ${JSON.stringify({ enforceable, named })}`,
      );
    }
  });

  it("HIDE_TRIP is the unenforceable one, and nothing else is", () => {
    const set = suppressions(RESURFACING_CONTROLS.map((c) => ({ control: c, subjectId: "s" })));
    assert.deepEqual(unenforceableControls(set), ["HIDE_TRIP"]);
  });

  it("a set holding no unenforceable control names none", () => {
    // The negative control. Without it, `unenforceableControls` returning
    // ["HIDE_TRIP"] unconditionally would pass every other case in this file.
    const set = suppressions([{ control: "DO_NOT_RESURFACE", subjectId: H_PUB }]);
    assert.deepEqual(unenforceableControls(set), []);
  });
});

describe("§11 on the live feeds: a control that cannot be resolved is not silently ignored", () => {
  it("HIDE_TRIP withholds the owner's proactive surface rather than resurfacing what they hid", async () => {
    const app = await startApp({
      tables: tablesWith([
        { id: "1", owner_id: OWNER, control: "HIDE_TRIP", subject_type: "trip", subject_id: "77777777-0000-4000-8000-000000000001" },
      ]),
    });
    try {
      const active = await call(app, "GET", "/api/highlights/active", VIEWER);
      assert.equal(active.status, 200, JSON.stringify(active.body));
      assert.ok(!listIds(active.body).has(H_PUB), `HIDE_TRIP was ignored: ${JSON.stringify(active.body)}`);

      const feed = await call(app, "GET", "/api/highlights/following-feed", VIEWER);
      assert.ok(!feedIds(feed.body).has(H_PUB), `HIDE_TRIP was ignored on the following feed: ${JSON.stringify(feed.body)}`);
    } finally { await app.close(); }
  });

  it("and it SAYS SO, naming the control and the reason it cannot be resolved", async () => {
    // Asserted on SHAPE, not on wording: the log object must carry the control
    // name, so the assertion cannot be satisfied by the fix's own prose. A
    // withholding nobody can explain is indistinguishable from an empty feed.
    const app = await startApp({
      tables: tablesWith([
        { id: "1", owner_id: OWNER, control: "HIDE_TRIP", subject_type: "trip", subject_id: "77777777-0000-4000-8000-000000000001" },
      ]),
    });
    try {
      await call(app, "GET", "/api/highlights/active", VIEWER);
      assert.ok(
        app.errors.some((e) => Array.isArray((e.obj as any)?.unenforceable) && (e.obj as any).unenforceable.includes("HIDE_TRIP")),
        `no structured report of the unenforceable control; got ${JSON.stringify(app.errors.map((e) => e.obj))}`,
      );
    } finally { await app.close(); }
  });

  it("KEEP_PRIVATE_FOREVER removes the Highlight from both proactive feeds", async () => {
    // §11's strongest non-deleting control had NO route-level coverage before
    // this suite — it was in `FEED_SUPPRESSING_CONTROLS` and asserted only as a
    // vocabulary entry. With 2720 deployed, a row setting it is something a
    // production user can now write.
    const app = await startApp({
      tables: tablesWith([
        { id: "1", owner_id: OWNER, control: "KEEP_PRIVATE_FOREVER", subject_type: "highlight", subject_id: H_PUB },
      ]),
    });
    try {
      const active = await call(app, "GET", "/api/highlights/active", VIEWER);
      assert.equal(active.status, 200, JSON.stringify(active.body));
      assert.ok(!listIds(active.body).has(H_PUB), `active still served it: ${JSON.stringify(active.body)}`);
      assert.ok(listIds(active.body).has(H_MINE), "a Highlight nobody suppressed must survive");

      const feed = await call(app, "GET", "/api/highlights/following-feed", VIEWER);
      assert.ok(!feedIds(feed.body).has(H_PUB), `feed still served it: ${JSON.stringify(feed.body)}`);
    } finally { await app.close(); }
  });

  it("DO_NOT_INCLUDE_IN_RECAPS does NOT touch the proactive feeds", async () => {
    // The other half of the derivation: a control whose surfaces do not include
    // `proactive_resurfacing` must not be swept up by deriving from
    // CONTROL_EFFECTS. Without this case, "enforce everything in the table"
    // would pass every assertion above.
    const app = await startApp({
      tables: tablesWith([
        { id: "1", owner_id: OWNER, control: "DO_NOT_INCLUDE_IN_RECAPS", subject_type: "highlight", subject_id: H_PUB },
      ]),
    });
    try {
      const active = await call(app, "GET", "/api/highlights/active", VIEWER);
      assert.equal(active.status, 200, JSON.stringify(active.body));
      assert.ok(listIds(active.body).has(H_PUB), "a recap-only control must not empty the feed");
    } finally { await app.close(); }
  });

  it("an owner with no controls at all is unaffected by any of this", async () => {
    const app = await startApp({ tables: tablesWith([]) });
    try {
      const active = await call(app, "GET", "/api/highlights/active", VIEWER);
      assert.equal(active.status, 200, JSON.stringify(active.body));
      assert.ok(listIds(active.body).has(H_PUB), JSON.stringify(active.body));
      assert.equal(app.errors.filter((e) => (e.obj as any)?.unenforceable).length, 0, "nothing to report");
    } finally { await app.close(); }
  });
});
