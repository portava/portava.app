/**
 * §10 Privacy, consent and projection policy · §11 Sensitive context and
 * resurfacing controls — and the three-state distinction the whole thing rests
 * on: DEPLOYED-AND-SAYS-NO, NOT-DEPLOYED, and COULD-NOT-BE-READ.
 *
 * Highlights/Memories Development Architecture Spec v1 §10, §11, §28.11.
 *
 * WHAT ELSE COULD HAVE MADE THIS PASS — answered:
 *   • The two "table unreadable" cases and the two "table absent" cases use the
 *     SAME fixture and the SAME request, and produce DIFFERENT responses. A
 *     stub that always suppressed would fail the absent case; one that never
 *     suppressed would fail the unreadable case. Neither can pass both.
 *   • Failures key on the exact table under test. `profiles` is never failed —
 *     requireUser reads it and would refuse upstream with the same 503, so the
 *     guard under test would never run and the assertion would pass for free.
 *   • `highlights` is never failed either, for the mirror reason: the feed would
 *     refuse before the policy pass and the §10/§11 code would not execute.
 *   • Every suppression assertion is paired with a control on the same fixture
 *     where the row IS served, so "the fixture returns nothing anyway" is
 *     excluded.
 *   • Statuses are asserted exactly, and the harness installs `req.log`, so a
 *     crash-500 cannot pass as a deliberate refusal.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/highlightConsentPolicy.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MEMORY_CONSENT_DIMENSIONS,
  LOCATION_PRECISION_LADDER,
  PERSON_VISIBILITY_LADDER,
  consentFromRow,
  mayProject,
  clampLocationToPrecision,
  resolveLocationDisclosure,
  strictestPrecision,
  strictestPersonVisibility,
  discloseParticipant,
} from "../services/highlights/highlightProjectionPolicy.js";
import {
  RESURFACING_CONTROLS,
  SENSITIVE_CONTEXT_CATEGORIES,
  SENSITIVE_CATEGORY_REGISTRY_MAPPING,
  CONTROL_EFFECTS,
  suppressionFor,
  suppressions,
  isSuppressed,
  readResurfacingSuppressionsForOwners,
} from "../services/highlights/highlightResurfacing.js";
import { probeHighlightObject, resetHighlightSchemaMemo } from "../services/highlights/highlightSchemaAvailability.js";
import {
  startApp,
  call,
  listIds,
  feedIds,
  fixtureTables,
  makeFakeClient,
  VIEWER,
  OWNER,
  H_PUB,
  H_MINE,
} from "./highlightsSpecHarness.js";

// ── §10 vocabulary ───────────────────────────────────────────────────────────

describe("§10: the vocabulary is the spec's, in the spec's order", () => {
  it("five consent dimensions", () => {
    assert.deepEqual(
      [...MEMORY_CONSENT_DIMENSIONS],
      ["STORE", "RESURFACE", "PERSONALIZE", "SHARE", "CONTRIBUTE_TO_AGGREGATE_INTEL"],
    );
  });

  it("the location ladder is EXACT -> VENUE -> NEIGHBORHOOD -> CITY -> COUNTRY -> HIDDEN", () => {
    assert.deepEqual([...LOCATION_PRECISION_LADDER], ["EXACT", "VENUE", "NEIGHBORHOOD", "CITY", "COUNTRY", "HIDDEN"]);
  });

  it("the person ladder is NAMED -> PROFILE_LINKED -> CREW_ONLY -> ANONYMOUS_COUNT -> HIDDEN, all five rungs", () => {
    assert.deepEqual(
      [...PERSON_VISIBILITY_LADDER],
      ["NAMED", "PROFILE_LINKED", "CREW_ONLY", "ANONYMOUS_COUNT", "HIDDEN"],
    );
  });
});

describe("§10 consent is three-valued: only a stored true is consent", () => {
  it("CONTROL — a stored true grants, and mayProject agrees", () => {
    assert.equal(consentFromRow({ consent_share: true }, "SHARE"), "granted");
    assert.equal(mayProject("granted"), true);
  });

  it("a stored false is WITHHELD — distinct from unknown, and refused", () => {
    assert.equal(consentFromRow({ consent_share: false }, "SHARE"), "withheld");
    assert.equal(mayProject("withheld"), false);
  });

  it("a MISSING row, a null column and a non-boolean are all UNKNOWN, and unknown refuses", () => {
    for (const row of [null, undefined, {}, { consent_share: null }, { consent_share: "true" }, { consent_share: 1 }]) {
      assert.equal(consentFromRow(row, "SHARE"), "unknown", JSON.stringify(row));
    }
    assert.equal(mayProject("unknown"), false, "an unreadable consent must never render as consent given");
  });

  it("each dimension reads its own column — SHARE granted does not grant RESURFACE", () => {
    const row = { consent_share: true, consent_resurface: false };
    assert.equal(consentFromRow(row, "SHARE"), "granted");
    assert.equal(consentFromRow(row, "RESURFACE"), "withheld");
    assert.equal(consentFromRow(row, "PERSONALIZE"), "unknown");
  });
});

// ── §10 location precision ───────────────────────────────────────────────────

describe("§10: publishing location must never exceed the owner's selected precision", () => {
  const row = { location_name: "The Quiet Bar", location_city: "Da Nang", location_country: "Vietnam" };

  it("each rung discloses strictly less than the one above it", () => {
    assert.deepEqual(clampLocationToPrecision(row, "VENUE"), row);
    assert.deepEqual(clampLocationToPrecision(row, "NEIGHBORHOOD"), {
      location_name: null, location_city: "Da Nang", location_country: "Vietnam",
    });
    assert.deepEqual(clampLocationToPrecision(row, "CITY"), {
      location_name: null, location_city: "Da Nang", location_country: "Vietnam",
    });
    assert.deepEqual(clampLocationToPrecision(row, "COUNTRY"), {
      location_name: null, location_city: null, location_country: "Vietnam",
    });
    assert.deepEqual(clampLocationToPrecision(row, "HIDDEN"), {
      location_name: null, location_city: null, location_country: null,
    });
  });

  it("combining constraints may only move TOWARD hidden", () => {
    assert.equal(strictestPrecision("EXACT", "CITY"), "CITY");
    assert.equal(strictestPrecision("HIDDEN", "EXACT"), "HIDDEN");
    assert.equal(strictestPrecision("COUNTRY", "HIDDEN"), "HIDDEN");
    assert.equal(strictestPersonVisibility("NAMED", "CREW_ONLY"), "CREW_ONLY");
    assert.equal(strictestPersonVisibility("HIDDEN", "NAMED"), "HIDDEN");
  });

  it("an UNREADABLE policy clamps to HIDDEN — fail closed", () => {
    const d = resolveLocationDisclosure(row, "EXACT", { state: "unreadable", reason: "boom" });
    assert.equal(d.precision, "HIDDEN");
    assert.equal(d.location_name, null);
    assert.equal(d.location_city, null);
    assert.equal(d.location_country, null);
    assert.equal(d.applied, true);
  });

  it("a stored value outside the ladder clamps to HIDDEN rather than being passed through", () => {
    const d = resolveLocationDisclosure(row, "STREET", { state: "ready" });
    assert.equal(d.precision, "HIDDEN");
    assert.equal(d.location_country, null);
  });

  it("an ABSENT policy table leaves the row alone and SAYS SO — it does not invent a default", () => {
    const d = resolveLocationDisclosure(row, null, { state: "absent", reason: "no table" });
    assert.equal(d.applied, false);
    assert.equal(d.precision, null);
    assert.equal(d.location_name, "The Quiet Bar", "picking a default here is an OWNER decision, not this code's");
    assert.match(String(d.reason), /2721/);
  });

  it("a READY table with no row for this highlight also leaves it alone, with a DIFFERENT reason", () => {
    const d = resolveLocationDisclosure(row, null, { state: "ready" });
    assert.equal(d.applied, false);
    assert.match(String(d.reason), /LOCATION_PRECISION_DEFAULT/);
    assert.equal(/2721/.test(String(d.reason)), false, "'no row' and 'no table' must not report the same reason");
  });

  it("CONTROL — a stored rung IS applied", () => {
    const d = resolveLocationDisclosure(row, "COUNTRY", { state: "ready" });
    assert.equal(d.applied, true);
    assert.equal(d.precision, "COUNTRY");
    assert.equal(d.location_city, null);
    assert.equal(d.location_country, "Vietnam");
  });
});

// ── §10 person ladder ────────────────────────────────────────────────────────

describe("§10: the person visibility ladder, all five rungs", () => {
  const p = { userId: "u1", handle: "@nomad", name: "Real Name" };

  it("NAMED discloses the name; PROFILE_LINKED drops it and keeps the handle", () => {
    assert.deepEqual(discloseParticipant(p, "NAMED"), { rung: "NAMED", userId: "u1", handle: "@nomad", name: "Real Name" });
    assert.deepEqual(discloseParticipant(p, "PROFILE_LINKED"), { rung: "PROFILE_LINKED", userId: "u1", handle: "@nomad", name: null });
  });

  it("CREW_ONLY discloses to crew and HIDES from everyone else", () => {
    assert.equal(discloseParticipant(p, "CREW_ONLY", { viewerIsCrew: true }).rung, "CREW_ONLY");
    assert.deepEqual(discloseParticipant(p, "CREW_ONLY", { viewerIsCrew: false }), { rung: "HIDDEN" });
    assert.deepEqual(discloseParticipant(p, "CREW_ONLY"), { rung: "HIDDEN" }, "absent means not crew — fail closed");
  });

  it("ANONYMOUS_COUNT drops the USER ID too, not just the name", () => {
    const d = discloseParticipant(p, "ANONYMOUS_COUNT");
    assert.deepEqual(d, { rung: "ANONYMOUS_COUNT", userId: null, handle: null, name: null });
  });

  it("HIDDEN discloses nothing at all — not even a key to correlate on", () => {
    assert.deepEqual(discloseParticipant(p, "HIDDEN"), { rung: "HIDDEN" });
    assert.deepEqual(Object.keys(discloseParticipant(p, "HIDDEN")), ["rung"]);
  });
});

// ── §11 vocabulary and separation ────────────────────────────────────────────

describe("§11: the seven sensitive contexts and the six controls", () => {
  it("all seven §11 contexts are registered", () => {
    assert.equal(SENSITIVE_CONTEXT_CATEGORIES.length, 7);
    assert.ok(SENSITIVE_CONTEXT_CATEGORIES.includes("USER_MARKED_KEEP_PRIVATE_FOREVER"));
  });

  it("the mapping to the existing protected_zones registry is stated, INCLUDING the gaps", () => {
    const mapped = SENSITIVE_CONTEXT_CATEGORIES.filter(
      (c) => SENSITIVE_CATEGORY_REGISTRY_MAPPING[c].protectedZoneCategory !== null,
    );
    assert.equal(mapped.length, 3, "only 3 of 7 have a home in protected_zones — a partial adoption is not completion");
    for (const c of SENSITIVE_CONTEXT_CATEGORIES) {
      assert.ok(SENSITIVE_CATEGORY_REGISTRY_MAPPING[c].note.length > 20, `${c} must carry its reason`);
    }
  });

  it("all six §11 controls are registered", () => {
    assert.deepEqual(
      [...RESURFACING_CONTROLS],
      [
        "DO_NOT_RESURFACE",
        "DO_NOT_INCLUDE_IN_RECAPS",
        "HIDE_PERSON_FROM_RESURFACING",
        "HIDE_TRIP",
        "KEEP_PRIVATE_FOREVER",
        "RETAIN_BUT_DO_NOT_PERSONALIZE",
      ],
    );
  });

  it("RETAIN_BUT_DO_NOT_PERSONALIZE de-personalises WITHOUT hiding — census H92's collapse must not recur", () => {
    const s = suppressionFor(["RETAIN_BUT_DO_NOT_PERSONALIZE"]);
    assert.deepEqual([...s], ["personalization"]);
    assert.ok(!s.has("proactive_resurfacing"), "de-personalising must not also hide");
  });

  it("DO_NOT_RESURFACE hides from resurfacing WITHOUT de-personalising — the other half of the same separation", () => {
    const s = suppressionFor(["DO_NOT_RESURFACE"]);
    assert.deepEqual([...s], ["proactive_resurfacing"]);
    assert.ok(!s.has("personalization"));
  });

  it("DO_NOT_RESURFACE and DO_NOT_INCLUDE_IN_RECAPS act on DIFFERENT surfaces", () => {
    assert.notDeepEqual(
      [...CONTROL_EFFECTS.DO_NOT_RESURFACE.suppresses],
      [...CONTROL_EFFECTS.DO_NOT_INCLUDE_IN_RECAPS.suppresses],
    );
  });

  it("every control RETAINS the record — none of the six is a delete", () => {
    for (const c of RESURFACING_CONTROLS) assert.equal(CONTROL_EFFECTS[c].retainsRecord, true, c);
  });

  it("the union of several controls is the union of their surfaces", () => {
    const s = suppressionFor(["DO_NOT_RESURFACE", "RETAIN_BUT_DO_NOT_PERSONALIZE"]);
    assert.deepEqual([...s].sort(), ["personalization", "proactive_resurfacing"]);
    assert.deepEqual([...suppressionFor(["KEEP_PRIVATE_FOREVER"])].sort(), [
      "personalization", "proactive_resurfacing", "public_projection", "recap",
    ]);
  });
});

describe("§11: isSuppressed fails closed by construction", () => {
  it("CONTROL — a readable set suppresses exactly what it holds", () => {
    const s = suppressions([{ control: "DO_NOT_RESURFACE", subjectId: "h1" }]);
    assert.equal(isSuppressed(s, "DO_NOT_RESURFACE", "h1"), true);
    assert.equal(isSuppressed(s, "DO_NOT_RESURFACE", "h2"), false);
    assert.equal(isSuppressed(s, "KEEP_PRIVATE_FOREVER", "h1"), false, "a control is keyed per control, not per subject");
  });

  it("an UNREADABLE set suppresses EVERYTHING, including ids it has never seen", () => {
    const s = { state: "unreadable" as const, reason: "boom" };
    assert.equal(isSuppressed(s, "DO_NOT_RESURFACE", "anything"), true);
    assert.equal(isSuppressed(s, "HIDE_TRIP", null), true);
  });

  it("an ABSENT table suppresses NOTHING — a control that is not deployed cannot have been set", () => {
    const s = { state: "absent" as const, reason: "no table" };
    assert.equal(isSuppressed(s, "DO_NOT_RESURFACE", "h1"), false);
  });
});

// ── The three-state probe ────────────────────────────────────────────────────

describe("§28.11: absent, unreadable and readable are three different answers", () => {
  it("a table that answers is READY", async () => {
    resetHighlightSchemaMemo();
    const sc = makeFakeClient(fixtureTables());
    assert.deepEqual(await probeHighlightObject(sc, "highlight_resurfacing_preferences", ["id"]), { state: "ready" });
  });

  it("PostgREST's PGRST205 is ABSENT — the object does not exist", async () => {
    resetHighlightSchemaMemo();
    const sc = makeFakeClient(fixtureTables(), { absentTables: new Set(["highlight_resurfacing_preferences"]) });
    const v = await probeHighlightObject(sc, "highlight_resurfacing_preferences", ["id"]);
    assert.equal(v.state, "absent");
  });

  it("any OTHER error is UNREADABLE — a connection failure is not evidence the table is gone", async () => {
    resetHighlightSchemaMemo();
    const sc = makeFakeClient(fixtureTables(), { failTables: new Set(["highlight_resurfacing_preferences"]) });
    const v = await probeHighlightObject(sc, "highlight_resurfacing_preferences", ["id"]);
    assert.equal(v.state, "unreadable");
  });

  it("a client whose builder THROWS is UNREADABLE, never absent", async () => {
    resetHighlightSchemaMemo();
    const broken = { from() { throw new Error("no such method"); } };
    const v = await probeHighlightObject(broken as any, "highlight_resurfacing_preferences", ["id"]);
    assert.equal(v.state, "unreadable");
  });
});

describe("§11: readResurfacingSuppressionsForOwners refuses to enforce a policy it cannot parse", () => {
  it("CONTROL — well-formed rows load", async () => {
    resetHighlightSchemaMemo();
    const t = fixtureTables();
    t.highlight_resurfacing_preferences = [
      { id: "1", owner_id: OWNER, control: "DO_NOT_RESURFACE", subject_type: "highlight", subject_id: H_PUB },
    ];
    const s = await readResurfacingSuppressionsForOwners(makeFakeClient(t), [OWNER]);
    assert.equal(s.state, "ready");
    assert.equal(isSuppressed(s, "DO_NOT_RESURFACE", H_PUB), true);
  });

  it("an UNRECOGNISED control downgrades the WHOLE set to unreadable rather than enforcing part of it", async () => {
    resetHighlightSchemaMemo();
    const t = fixtureTables();
    t.highlight_resurfacing_preferences = [
      { id: "1", owner_id: OWNER, control: "DO_NOT_RESURFACE", subject_type: "highlight", subject_id: H_PUB },
      { id: "2", owner_id: OWNER, control: "DO_NOT_TELL_ANYONE", subject_type: "highlight", subject_id: "x" },
    ];
    const s = await readResurfacingSuppressionsForOwners(makeFakeClient(t), [OWNER]);
    assert.equal(s.state, "unreadable", "a partial policy that looks complete is the failure mode");
  });

  it("a row with no subject_id also downgrades the whole set", async () => {
    resetHighlightSchemaMemo();
    const t = fixtureTables();
    t.highlight_resurfacing_preferences = [
      { id: "1", owner_id: OWNER, control: "HIDE_TRIP", subject_type: "trip", subject_id: null },
    ];
    const s = await readResurfacingSuppressionsForOwners(makeFakeClient(t), [OWNER]);
    assert.equal(s.state, "unreadable");
  });

  it("an empty owner list is READY and empty — not a probe, not a refusal", async () => {
    resetHighlightSchemaMemo();
    const s = await readResurfacingSuppressionsForOwners(makeFakeClient(fixtureTables()), []);
    assert.equal(s.state, "ready");
  });
});

// ── Routes ───────────────────────────────────────────────────────────────────

describe("§11 on the feeds: DO_NOT_RESURFACE suppresses proactive surfaces", () => {
  function tablesWith(rows: any[]) {
    const t = fixtureTables();
    t.highlight_resurfacing_preferences = rows;
    return t;
  }

  it("CONTROL — with no controls set, the highlight is on both proactive feeds", async () => {
    const app = await startApp();
    try {
      const active = await call(app, "GET", "/api/highlights/active", VIEWER);
      assert.equal(active.status, 200);
      assert.ok(listIds(active.body).has(H_PUB), JSON.stringify(active.body));
      const feed = await call(app, "GET", "/api/highlights/following-feed", VIEWER);
      assert.ok(feedIds(feed.body).has(H_PUB), JSON.stringify(feed.body));
    } finally { await app.close(); }
  });

  it("DO_NOT_RESURFACE on one highlight removes it from both feeds and leaves the others", async () => {
    const app = await startApp({
      tables: tablesWith([
        { id: "1", owner_id: OWNER, control: "DO_NOT_RESURFACE", subject_type: "highlight", subject_id: H_PUB },
      ]),
    });
    try {
      const active = await call(app, "GET", "/api/highlights/active", VIEWER);
      assert.equal(active.status, 200);
      assert.ok(!listIds(active.body).has(H_PUB), `active still served it: ${JSON.stringify(active.body)}`);
      assert.ok(listIds(active.body).has(H_MINE), "the viewer's own unsuppressed highlight must survive");

      const feed = await call(app, "GET", "/api/highlights/following-feed", VIEWER);
      assert.ok(!feedIds(feed.body).has(H_PUB), `feed still served it: ${JSON.stringify(feed.body)}`);
    } finally { await app.close(); }
  });

  it("HIDE_PERSON_FROM_RESURFACING removes every highlight of that owner", async () => {
    const app = await startApp({
      tables: tablesWith([
        { id: "1", owner_id: OWNER, control: "HIDE_PERSON_FROM_RESURFACING", subject_type: "person", subject_id: OWNER },
      ]),
    });
    try {
      const active = await call(app, "GET", "/api/highlights/active", VIEWER);
      assert.equal(active.status, 200);
      assert.ok(!listIds(active.body).has(H_PUB), JSON.stringify(active.body));
      assert.ok(listIds(active.body).has(H_MINE), "a different owner's highlight is untouched");
    } finally { await app.close(); }
  });

  it("RETAIN_BUT_DO_NOT_PERSONALIZE does NOT remove it from the feed — that is the whole point of separating them", async () => {
    const app = await startApp({
      tables: tablesWith([
        { id: "1", owner_id: OWNER, control: "RETAIN_BUT_DO_NOT_PERSONALIZE", subject_type: "highlight", subject_id: H_PUB },
      ]),
    });
    try {
      const active = await call(app, "GET", "/api/highlights/active", VIEWER);
      assert.equal(active.status, 200);
      assert.ok(listIds(active.body).has(H_PUB), "de-personalising must not hide — census H92");
    } finally { await app.close(); }
  });

  it("an UNREADABLE control table empties the proactive feed and LOGS why", async () => {
    const app = await startApp({ failTables: new Set(["highlight_resurfacing_preferences"]) });
    try {
      const active = await call(app, "GET", "/api/highlights/active", VIEWER);
      assert.equal(active.status, 200, JSON.stringify(active.body));
      assert.deepEqual(active.body?.highlights, [], "an unreadable suppression list must not resurface anything");
      assert.ok(
        app.errors.some((e) => /resurfacing controls unreadable/.test(e.msg)),
        `the withholding must be logged; got ${JSON.stringify(app.errors.map((e) => e.msg))}`,
      );
    } finally { await app.close(); }
  });

  it("an ABSENT control table serves the feed UNCHANGED and logs 'not deployed' — the state that ships today", async () => {
    const app = await startApp({ absentTables: new Set(["highlight_resurfacing_preferences"]) });
    try {
      const active = await call(app, "GET", "/api/highlights/active", VIEWER);
      assert.equal(active.status, 200, JSON.stringify(active.body));
      assert.ok(listIds(active.body).has(H_PUB), "a migration nobody has run must not black out the surface");
      assert.ok(
        app.errors.some((e) => /NOT DEPLOYED/.test(e.msg)),
        `absence must be reported, never silent; got ${JSON.stringify(app.errors.map((e) => e.msg))}`,
      );
    } finally { await app.close(); }
  });
});

describe("§10 on the feeds: the owner's selected precision is applied to what ships", () => {
  it("CONTROL — with no policy row, the location text is served unchanged", async () => {
    const app = await startApp();
    try {
      const r = await call(app, "GET", "/api/highlights/active", VIEWER);
      const h = (r.body?.highlights ?? []).find((x: any) => x.id === H_PUB);
      assert.ok(h, JSON.stringify(r.body));
      assert.equal(h.location_name, "The Quiet Bar");
      assert.equal(h.location_city, "Da Nang");
    } finally { await app.close(); }
  });

  it("a stored precision of COUNTRY strips the venue and the city from the response", async () => {
    const t = fixtureTables();
    t.highlight_projection_policies = [
      { id: "p1", highlight_id: H_PUB, owner_id: OWNER, location_precision: "COUNTRY", person_visibility: "NAMED" },
    ];
    const app = await startApp({ tables: t });
    try {
      const r = await call(app, "GET", "/api/highlights/active", VIEWER);
      const h = (r.body?.highlights ?? []).find((x: any) => x.id === H_PUB);
      assert.ok(h, JSON.stringify(r.body));
      assert.equal(h.location_name, null, "§10: publishing must never exceed the owner's selected precision");
      assert.equal(h.location_city, null);
      assert.equal(h.location_country, "Vietnam");
      // Paired: a DIFFERENT highlight with no policy row is untouched, so the
      // clamp is per-highlight and not a blanket blanking.
      const mine = (r.body?.highlights ?? []).find((x: any) => x.id === H_MINE);
      assert.equal(mine?.location_name, "The Quiet Bar");
    } finally { await app.close(); }
  });

  it("an UNREADABLE policy table clamps every location to HIDDEN and logs it", async () => {
    const app = await startApp({ failTables: new Set(["highlight_projection_policies"]) });
    try {
      const r = await call(app, "GET", "/api/highlights/active", VIEWER);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.ok(listIds(r.body).has(H_PUB), "the highlights themselves are still served — only the location is withheld");
      for (const h of r.body?.highlights ?? []) {
        assert.equal(h.location_name, null, h.id);
        assert.equal(h.location_city, null, h.id);
        assert.equal(h.location_country, null, h.id);
      }
      assert.ok(
        app.errors.some((e) => /clamping every location to HIDDEN/.test(e.msg)),
        JSON.stringify(app.errors.map((e) => e.msg)),
      );
    } finally { await app.close(); }
  });

  it("an ABSENT policy table serves locations unclamped and logs 'not deployed'", async () => {
    const app = await startApp({ absentTables: new Set(["highlight_projection_policies"]) });
    try {
      const r = await call(app, "GET", "/api/highlights/active", VIEWER);
      const h = (r.body?.highlights ?? []).find((x: any) => x.id === H_PUB);
      assert.equal(h?.location_name, "The Quiet Bar", "LOCATION_PRECISION_DEFAULT is an owner decision, not this code's");
      assert.ok(
        app.errors.some((e) => /location precision is NOT DEPLOYED/.test(e.msg)),
        JSON.stringify(app.errors.map((e) => e.msg)),
      );
    } finally { await app.close(); }
  });
});
