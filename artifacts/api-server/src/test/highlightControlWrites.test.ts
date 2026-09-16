/**
 * §10 / §11 — the CONTROL SURFACE, end to end.
 *
 * Highlights/Memories Development Architecture Spec v1 §10 (an owner's selected
 * location precision, person visibility and consent) and §11 (the six
 * resurfacing controls).
 *
 * WHY THIS SUITE EXISTS. Census §O.2 of
 * docs/architecture/census-highlights-memories.md recorded the finding that
 * kept every §10/§11 row BUILT-BUT-WRONG after migrations 2720 and 2721 were
 * applied to production on 2026-09-15:
 *
 *     "A repository-wide grep for insert, upsert or update against
 *      highlight_resurfacing_preferences and highlight_projection_policies
 *      returns nothing outside src/test/. There is no route, no service and no
 *      script by which a user can set a §11 resurfacing control or a §10
 *      precision rung. Both tables are deployed and EMPTY, and they will stay
 *      empty."
 *
 * The assertions below are therefore not about the enforcement — that was
 * already correct and is covered by highlightConsentPolicy.test.ts and
 * highlightsUnenforceableControls.test.ts. They are about the half that did not
 * exist: that a user can SET a control, that the control they set is the one
 * the live feed then enforces, and that every way the write can fail is a
 * refusal rather than a 200.
 *
 * THE LOAD-BEARING TEST IS `a control set through the route suppresses the
 * highlight on the live feed`. It writes through PUT and reads through
 * GET /highlights/following-feed against the same store, so a route that
 * pretended to save, or saved into a shape the reader does not key on, fails
 * here and nowhere else.
 *
 * Run: node --import tsx/esm --test src/test/highlightControlWrites.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  startApp, call, fixtureTables, feedIds, listIds,
  VIEWER, OWNER, OTHER, H_PUB, H_MINE,
} from "./highlightsSpecHarness.js";
import { CONTROL_EFFECTS, RESURFACING_CONTROLS } from "../services/highlights/highlightResurfacing.js";
import { LOCATION_PRECISION_LADDER } from "../services/highlights/highlightProjectionPolicy.js";

const PREFS = "highlight_resurfacing_preferences";
const POLICIES = "highlight_projection_policies";

/* ══════════════════════════════════════════════════════════════════════════
 * §11 — setting a control
 * ════════════════════════════════════════════════════════════════════════*/

describe("§11 PUT /highlights/resurfacing-controls stores a control the reader can key on", () => {
  it("stores DO_NOT_RESURFACE with the scope CONTROL_EFFECTS declares, not one the caller chose", async () => {
    const app = await startApp();
    try {
      const r = await call(app, "PUT", "/api/highlights/resurfacing-controls", VIEWER, {
        control: "DO_NOT_RESURFACE",
        subjectId: H_MINE,
        // A caller-supplied scope is IGNORED. Migration 2720's CHECK pins
        // (control, subject_type); if this were honoured, a DO_NOT_RESURFACE
        // row could claim subject_type='trip' and the reader would key it
        // under a trip id, suppressing nothing while looking set.
        subjectType: "trip",
      });
      assert.equal(r.status, 200);
      assert.equal(r.body.subjectType, "highlight");

      const rows = app.tables[PREFS];
      assert.equal(rows.length, 1);
      assert.equal(rows[0].owner_id, VIEWER);
      assert.equal(rows[0].control, "DO_NOT_RESURFACE");
      assert.equal(rows[0].subject_type, "highlight");
      assert.equal(rows[0].subject_id, H_MINE);
    } finally { await app.close(); }
  });

  it("is idempotent: setting the same control twice leaves ONE row", async () => {
    const app = await startApp();
    try {
      const body = { control: "DO_NOT_RESURFACE", subjectId: H_MINE };
      assert.equal((await call(app, "PUT", "/api/highlights/resurfacing-controls", VIEWER, body)).status, 200);
      assert.equal((await call(app, "PUT", "/api/highlights/resurfacing-controls", VIEWER, body)).status, 200);
      assert.equal(app.tables[PREFS].length, 1);
    } finally { await app.close(); }
  });

  it("stores HIDE_PERSON_FROM_RESURFACING against a PERSON, and does not demand the person be a highlight", async () => {
    const app = await startApp();
    try {
      const r = await call(app, "PUT", "/api/highlights/resurfacing-controls", VIEWER, {
        control: "HIDE_PERSON_FROM_RESURFACING",
        subjectId: OWNER,
      });
      assert.equal(r.status, 200);
      assert.equal(r.body.subjectType, "person");
      assert.equal(app.tables[PREFS][0].subject_id, OWNER);
    } finally { await app.close(); }
  });

  it("refuses a control that is not one of the six", async () => {
    const app = await startApp();
    try {
      const r = await call(app, "PUT", "/api/highlights/resurfacing-controls", VIEWER, {
        control: "HIDE_EVERYTHING", subjectId: H_MINE,
      });
      assert.equal(r.status, 400);
      assert.equal(app.tables[PREFS].length, 0);
    } finally { await app.close(); }
  });

  it("refuses a subjectId that is not a UUID rather than storing an unkeyable row", async () => {
    const app = await startApp();
    try {
      const r = await call(app, "PUT", "/api/highlights/resurfacing-controls", VIEWER, {
        control: "DO_NOT_RESURFACE", subjectId: "the-one-from-hanoi",
      });
      assert.equal(r.status, 400);
      assert.equal(app.tables[PREFS].length, 0);
    } finally { await app.close(); }
  });
});

describe("§11 the control surface is OWNER-ONLY, and requireUser hands it the service client", () => {
  it("refuses a highlight-scoped control naming somebody else's Highlight", async () => {
    // THE DENIAL-OF-SERVICE THIS BLOCKS. The reader keys suppression on
    // (control, subject_id) across a batch of owners, so a KEEP_PRIVATE_FOREVER
    // row VIEWER wrote naming OWNER's Highlight would suppress that Highlight
    // on OWNER's own feed. RLS does not stop it: requireUser returns the
    // SERVICE client.
    const app = await startApp();
    try {
      const r = await call(app, "PUT", "/api/highlights/resurfacing-controls", VIEWER, {
        control: "KEEP_PRIVATE_FOREVER", subjectId: H_PUB,
      });
      assert.equal(r.status, 404);
      assert.equal(app.tables[PREFS].length, 0);
    } finally { await app.close(); }
  });

  it("answers 404 — not 403 — so the endpoint is not an existence oracle for other people's ids", async () => {
    const app = await startApp();
    const real = await call(app, "PUT", "/api/highlights/resurfacing-controls", VIEWER, {
      control: "DO_NOT_RESURFACE", subjectId: H_PUB,             // exists, not mine
    });
    const fake = await call(app, "PUT", "/api/highlights/resurfacing-controls", VIEWER, {
      control: "DO_NOT_RESURFACE", subjectId: "40000000-0000-4000-8000-0000000000ff", // does not exist
    });
    try {
      assert.equal(real.status, fake.status);
      assert.deepEqual(real.body, fake.body);
    } finally { await app.close(); }
  });

  it("refuses a control on a soft-deleted Highlight", async () => {
    const t = fixtureTables();
    t.highlights.find((h: any) => h.id === H_MINE)!.deleted_at = "2026-03-01T00:00:00.000Z";
    const app = await startApp({ tables: t });
    try {
      const r = await call(app, "PUT", "/api/highlights/resurfacing-controls", VIEWER, {
        control: "DO_NOT_RESURFACE", subjectId: H_MINE,
      });
      assert.equal(r.status, 404);
      assert.equal(app.tables[PREFS].length, 0);
    } finally { await app.close(); }
  });

  it("GET lists only the caller's own controls", async () => {
    const t = fixtureTables();
    t[PREFS] = [
      { id: "p1", owner_id: VIEWER, control: "DO_NOT_RESURFACE", subject_type: "highlight", subject_id: H_MINE, created_at: "2026-01-01T00:00:00.000Z" },
      { id: "p2", owner_id: OTHER,  control: "KEEP_PRIVATE_FOREVER", subject_type: "highlight", subject_id: H_PUB, created_at: "2026-01-01T00:00:00.000Z" },
    ];
    const app = await startApp({ tables: t });
    try {
      const r = await call(app, "GET", "/api/highlights/resurfacing-controls", VIEWER);
      assert.equal(r.status, 200);
      assert.equal(r.body.controls.length, 1);
      assert.equal(r.body.controls[0].subjectId, H_MINE);
    } finally { await app.close(); }
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * THE ONE THAT MATTERS: written here, enforced there
 * ════════════════════════════════════════════════════════════════════════*/

describe("§11 a control set through the route is the control the live feed enforces", () => {
  it("DO_NOT_RESURFACE written by PUT removes the Highlight from the owner's own following-feed", async () => {
    const app = await startApp();
    try {
      const before = await call(app, "GET", "/api/highlights/following-feed", VIEWER);
      assert.equal(before.status, 200);
      assert.ok(feedIds(before.body).has(H_MINE), "positive control: the Highlight is on the feed to begin with");

      const set = await call(app, "PUT", "/api/highlights/resurfacing-controls", VIEWER, {
        control: "DO_NOT_RESURFACE", subjectId: H_MINE,
      });
      assert.equal(set.status, 200);

      const after = await call(app, "GET", "/api/highlights/following-feed", VIEWER);
      assert.equal(after.status, 200);
      assert.ok(!feedIds(after.body).has(H_MINE), "the control a user set must suppress the Highlight");
    } finally { await app.close(); }
  });

  it("clearing it through DELETE brings the Highlight back", async () => {
    const app = await startApp();
    try {
      await call(app, "PUT", "/api/highlights/resurfacing-controls", VIEWER, {
        control: "DO_NOT_RESURFACE", subjectId: H_MINE,
      });
      const hidden = await call(app, "GET", "/api/highlights/following-feed", VIEWER);
      assert.ok(!feedIds(hidden.body).has(H_MINE));

      const cleared = await call(app, "DELETE", "/api/highlights/resurfacing-controls", VIEWER, {
        control: "DO_NOT_RESURFACE", subjectId: H_MINE,
      });
      assert.equal(cleared.status, 200);
      assert.equal(cleared.body.cleared, true);
      assert.equal(app.tables[PREFS].length, 0);

      const back = await call(app, "GET", "/api/highlights/following-feed", VIEWER);
      assert.ok(feedIds(back.body).has(H_MINE), "a cleared control must stop suppressing");
    } finally { await app.close(); }
  });

  it("DELETE is scoped to the owner: it cannot clear somebody else's identical control", async () => {
    const t = fixtureTables();
    t[PREFS] = [
      { id: "p2", owner_id: OTHER, control: "DO_NOT_RESURFACE", subject_type: "highlight", subject_id: H_MINE, created_at: "2026-01-01T00:00:00.000Z" },
    ];
    const app = await startApp({ tables: t });
    try {
      const r = await call(app, "DELETE", "/api/highlights/resurfacing-controls", VIEWER, {
        control: "DO_NOT_RESURFACE", subjectId: H_MINE,
      });
      assert.equal(r.status, 200);
      assert.equal(r.body.cleared, false);
      assert.equal(app.tables[PREFS].length, 1, "another owner's control must survive");
    } finally { await app.close(); }
  });

  it("clearing KEEP_PRIVATE_FOREVER without an explicit confirmation is refused", async () => {
    const t = fixtureTables();
    t[PREFS] = [
      { id: "p1", owner_id: VIEWER, control: "KEEP_PRIVATE_FOREVER", subject_type: "highlight", subject_id: H_MINE, created_at: "2026-01-01T00:00:00.000Z" },
    ];
    const app = await startApp({ tables: t });
    try {
      const unconfirmed = await call(app, "DELETE", "/api/highlights/resurfacing-controls", VIEWER, {
        control: "KEEP_PRIVATE_FOREVER", subjectId: H_MINE,
      });
      assert.equal(unconfirmed.status, 400);
      assert.equal(app.tables[PREFS].length, 1, "the strongest control must not be cleared by a mistap");

      const confirmed = await call(app, "DELETE", "/api/highlights/resurfacing-controls", VIEWER, {
        control: "KEEP_PRIVATE_FOREVER", subjectId: H_MINE, confirm: true,
      });
      assert.equal(confirmed.status, 200);
      assert.equal(app.tables[PREFS].length, 0);
    } finally { await app.close(); }
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * Failure shapes. Each one is a refusal, none of them is a 200.
 * ════════════════════════════════════════════════════════════════════════*/

describe("§11 a write that did not store is never reported as stored", () => {
  it("an ABSENT table refuses with feature_disabled and says so in the log", async () => {
    const app = await startApp({ absentTables: new Set([PREFS]) });
    try {
      const r = await call(app, "PUT", "/api/highlights/resurfacing-controls", VIEWER, {
        control: "DO_NOT_RESURFACE", subjectId: H_MINE,
      });
      assert.equal(r.status, 404);
      assert.equal(r.body.error, "feature_disabled");
      assert.ok(
        app.errors.some((e) => /not deployed/i.test(e.msg)),
        "a control that is not deployed must be logged, not silently reported as saved",
      );
    } finally { await app.close(); }
  });

  it("an UNREADABLE table refuses with degraded_unavailable rather than 200", async () => {
    const app = await startApp({ failTables: new Set([PREFS]) });
    try {
      const r = await call(app, "PUT", "/api/highlights/resurfacing-controls", VIEWER, {
        control: "DO_NOT_RESURFACE", subjectId: H_MINE,
      });
      assert.equal(r.status, 503);
      assert.equal(r.body.error, "degraded_unavailable");
    } finally { await app.close(); }
  });

  it("a FAILED WRITE refuses rather than reporting the preference as stored", async () => {
    const app = await startApp({ failWrites: new Set([PREFS]) });
    try {
      const r = await call(app, "PUT", "/api/highlights/resurfacing-controls", VIEWER, {
        control: "DO_NOT_RESURFACE", subjectId: H_MINE,
      });
      assert.notEqual(r.status, 200);
      assert.equal(app.tables[PREFS].length, 0);
    } finally { await app.close(); }
  });

  it("GET refuses an unreadable list rather than answering 'you have set no controls'", async () => {
    const app = await startApp({ failTables: new Set([PREFS]) });
    try {
      const r = await call(app, "GET", "/api/highlights/resurfacing-controls", VIEWER);
      assert.equal(r.status, 503, "an outage must not read as an empty preference list");
    } finally { await app.close(); }
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * §10 — the projection policy
 * ════════════════════════════════════════════════════════════════════════*/

describe("§10 PUT /highlights/:id/projection-policy stores the owner's selected rung", () => {
  it("a rung set through the route CLAMPS the location on the live read", async () => {
    const app = await startApp();
    try {
      const before = await call(app, "GET", `/api/users/${VIEWER}/highlights`, VIEWER);
      assert.equal(before.status, 200);
      const shown = (before.body.highlights as any[]).find((h) => h.id === H_MINE);
      assert.equal(shown.location_name, "The Quiet Bar", "positive control: the venue is published to begin with");

      const set = await call(app, "PUT", `/api/highlights/${H_MINE}/projection-policy`, VIEWER, {
        locationPrecision: "COUNTRY",
      });
      assert.equal(set.status, 200);
      assert.equal(set.body.locationPrecision, "COUNTRY");

      const after = await call(app, "GET", `/api/users/${VIEWER}/highlights`, VIEWER);
      const clamped = (after.body.highlights as any[]).find((h) => h.id === H_MINE);
      assert.equal(clamped.location_name, null, "COUNTRY must strip the venue");
      assert.equal(clamped.location_city, null, "COUNTRY must strip the city");
      assert.equal(clamped.location_country, "Vietnam");
    } finally { await app.close(); }
  });

  it("is PARTIAL: naming one field does not reset the others to unknown", async () => {
    const app = await startApp();
    try {
      await call(app, "PUT", `/api/highlights/${H_MINE}/projection-policy`, VIEWER, {
        locationPrecision: "CITY",
        consent: { RESURFACE: true, PERSONALIZE: false },
      });
      const second = await call(app, "PUT", `/api/highlights/${H_MINE}/projection-policy`, VIEWER, {
        personVisibility: "CREW_ONLY",
      });
      assert.equal(second.status, 200);
      // THE REGRESSION THIS BLOCKS: a whole-object write would send the six
      // fields the second call did not name as NULL, and `unknown` consent
      // REFUSES, so the Highlight would quietly stop being projectable with
      // nobody having chosen that.
      assert.equal(second.body.locationPrecision, "CITY");
      assert.equal(second.body.consent.RESURFACE, true);
      assert.equal(second.body.consent.PERSONALIZE, false);
      assert.equal(second.body.personVisibility, "CREW_ONLY");
      assert.equal(app.tables[POLICIES].length, 1, "the policy is upserted on highlight_id, not appended");
    } finally { await app.close(); }
  });

  it("distinguishes 'leave it alone' from 'unset it'", async () => {
    const app = await startApp();
    try {
      await call(app, "PUT", `/api/highlights/${H_MINE}/projection-policy`, VIEWER, { locationPrecision: "CITY" });
      const untouched = await call(app, "PUT", `/api/highlights/${H_MINE}/projection-policy`, VIEWER, { personVisibility: "NAMED" });
      assert.equal(untouched.body.locationPrecision, "CITY");
      const unset = await call(app, "PUT", `/api/highlights/${H_MINE}/projection-policy`, VIEWER, { locationPrecision: null });
      assert.equal(unset.body.locationPrecision, null);
    } finally { await app.close(); }
  });

  it("refuses a rung outside §10's ladder", async () => {
    const app = await startApp();
    try {
      const r = await call(app, "PUT", `/api/highlights/${H_MINE}/projection-policy`, VIEWER, {
        locationPrecision: "STREET",
      });
      assert.equal(r.status, 400);
      assert.equal(app.tables[POLICIES].length, 0);
    } finally { await app.close(); }
  });

  it("refuses a consent value that is not one of the three states", async () => {
    const app = await startApp();
    try {
      const r = await call(app, "PUT", `/api/highlights/${H_MINE}/projection-policy`, VIEWER, {
        consent: { RESURFACE: "maybe" },
      });
      assert.equal(r.status, 400);
      assert.equal(app.tables[POLICIES].length, 0);
    } finally { await app.close(); }
  });

  it("refuses a policy on somebody else's Highlight", async () => {
    const app = await startApp();
    try {
      const r = await call(app, "PUT", `/api/highlights/${H_PUB}/projection-policy`, VIEWER, {
        locationPrecision: "HIDDEN",
      });
      assert.equal(r.status, 404);
      assert.equal(app.tables[POLICIES].length, 0);
    } finally { await app.close(); }
  });

  it("GET answers every field null for a Highlight with no policy row — unset, not defaulted", async () => {
    const app = await startApp();
    try {
      const r = await call(app, "GET", `/api/highlights/${H_MINE}/projection-policy`, VIEWER);
      assert.equal(r.status, 200);
      assert.equal(r.body.locationPrecision, null);
      assert.equal(r.body.personVisibility, null);
      for (const v of Object.values(r.body.consent)) assert.equal(v, null);
      assert.equal(app.tables[POLICIES].length, 0, "a READ must not create a row full of defaults nobody chose");
    } finally { await app.close(); }
  });

  it("GET refuses somebody else's policy", async () => {
    const app = await startApp();
    try {
      const r = await call(app, "GET", `/api/highlights/${H_PUB}/projection-policy`, VIEWER);
      assert.equal(r.status, 404);
    } finally { await app.close(); }
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * The vocabulary on the wire is DERIVED, not retyped
 * ════════════════════════════════════════════════════════════════════════*/

describe("the client is told what each control does rather than hard-coding it", () => {
  it("GET returns the full catalogue with each control's declared scope and suppressed surfaces", async () => {
    const app = await startApp();
    try {
      const r = await call(app, "GET", "/api/highlights/resurfacing-controls", VIEWER);
      assert.equal(r.body.catalogue.length, RESURFACING_CONTROLS.length);
      for (const entry of r.body.catalogue) {
        assert.deepEqual(entry.suppresses, CONTROL_EFFECTS[entry.control as keyof typeof CONTROL_EFFECTS].suppresses);
        assert.equal(entry.scope, CONTROL_EFFECTS[entry.control as keyof typeof CONTROL_EFFECTS].scope);
      }
    } finally { await app.close(); }
  });

  it("names HIDE_TRIP as unenforceable on the feed rather than promising an effect it does not deliver", async () => {
    // Census H90: `public.highlights` carries NO trip reference, so the feed
    // cannot resolve a trip-scoped control's subject. The route above withholds
    // on it; this asserts the CLIENT is told, so a settings screen can say so
    // instead of showing a switch that silently does something else.
    const app = await startApp();
    try {
      const r = await call(app, "GET", "/api/highlights/resurfacing-controls", VIEWER);
      assert.ok(r.body.unenforceableOnFeed.includes("HIDE_TRIP"));
      assert.ok(!r.body.unenforceableOnFeed.includes("DO_NOT_RESURFACE"));
    } finally { await app.close(); }
  });

  it("GET on a policy returns §10's ladders in COARSENING order", async () => {
    const app = await startApp();
    try {
      const r = await call(app, "GET", `/api/highlights/${H_MINE}/projection-policy`, VIEWER);
      assert.deepEqual(r.body.locationPrecisionLadder, [...LOCATION_PRECISION_LADDER]);
      assert.equal(r.body.locationPrecisionLadder[0], "EXACT");
      assert.equal(r.body.locationPrecisionLadder.at(-1), "HIDDEN");
    } finally { await app.close(); }
  });
});
