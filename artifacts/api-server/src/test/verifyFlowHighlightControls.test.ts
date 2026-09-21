/**
 * VERIFICATION LANE V3 — FLOW 3: THE §10/§11 CONTROL WRITER, SET AND FELT.
 *
 * This is the flow the highlights/memories lane was built to close. Census
 * §O.2, verbatim: "There is no route, no service and no script by which a user
 * can set a §11 resurfacing control or a §10 precision rung. Both tables are
 * deployed and EMPTY, and they will stay empty." The ENFORCEMENT was already
 * live and route-tested; the WRITER did not exist.
 *
 * So the question this file answers is not "does the writer write" — a unit
 * test of `highlightControlWrites.ts` answers that, and one exists. It is:
 *
 *   does a control a person SETS change what a person is SHOWN?
 *
 * Which is three routers' worth of distance, driven here over ONE express app
 * and ONE table-backed store:
 *
 *   PUT  /api/highlights/resurfacing-controls    → the row
 *   GET  /api/highlights/resurfacing-controls    → they can see it is set
 *   GET  /api/highlights/active                  → the Highlight is GONE
 *   DELETE /api/highlights/resurfacing-controls  → it comes BACK
 *
 *   PUT  /api/highlights/:id/projection-policy   → the §10 rung
 *   GET  /api/highlights/active                  → the location is CLAMPED
 *
 * ── THE TWO THINGS THAT MAKE THIS MORE THAN A ROUND TRIP ────────────────────
 *
 * 1. THE CONTROL AND THE FEED MUST AGREE ABOUT THE SUBJECT KEY. A control is
 *    stored as (owner_id, control, subject_type, subject_id) and the feed asks
 *    `isSuppressed(set, control, subjectId)` with either the Highlight's id or
 *    its owner's, per `feedSubjectScope`. Nothing forces the writer's
 *    `subjectTypeFor` and the reader's `feedSubjectScope` to agree; if they
 *    ever disagree the control is written, listed back to the person as SET,
 *    and enforces nothing. Both a highlight-scoped control and an
 *    owner/person-scoped one are exercised, because they take different keys.
 *
 * 2. UNDO HAS TO WORK. A privacy control you cannot turn off is a different and
 *    worse product than one that was never offered, and `KEEP_PRIVATE_FOREVER`
 *    additionally requires an explicit confirmation to clear — so the DELETE
 *    without `confirm` must refuse, and the one with it must actually restore
 *    the Highlight to the feed.
 *
 * ── WHAT IS NOT EXERCISED ──────────────────────────────────────────────────
 * Migration 2975 (`highlights.expires_at` nullable, so PERMANENT lifetimes can
 * exist) is UNAPPLIED. The store enforces no NOT NULL, so this file cannot tell
 * an applied 2975 from an unapplied one. 2720 and 2721 (the two control tables)
 * ARE recorded as applied to production on 2026-09-15; the store models neither
 * their unique indexes nor their RLS, so idempotency is observed through the
 * service's own upsert path and not through a real constraint, and "the write
 * path is service-role-only" is a property of the deployment rather than of
 * this test.
 *
 * SHOWN RED BEFORE GREEN — see the mutation log at the foot of this file.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/verifyFlowHighlightControls.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import highlightsRouter from "../routes/highlights.js";
import {
  CONTROL_EFFECTS,
  FEED_ENFORCEABLE_CONTROLS,
  RESURFACING_CONTROLS,
  RESURFACING_TABLE,
  feedSubjectScope,
} from "../services/highlights/highlightResurfacing.js";
import { PROJECTION_POLICY_TABLE } from "../services/highlights/highlightProjectionPolicy.js";
import { subjectTypeFor } from "../services/highlights/highlightControlWrites.js";
import { makeClient, type FakeClient } from "./highlightRouteHarness.js";

const OWNER = "11111111-0000-4000-8000-000000000001";
const VIEWER = "22222222-0000-4000-8000-000000000002";
const H_KEPT = "aaaaaaaa-0000-4000-8000-00000000000a";
const H_HIDDEN = "bbbbbbbb-0000-4000-8000-00000000000b";

const CONTROLS = "/api/highlights/resurfacing-controls";
const ACTIVE = "/api/highlights/active";

function highlightRow(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    owner_id: OWNER,
    media_url: `post-media/${OWNER}/highlights/${id}.jpg`,
    media_type: "image",
    caption: id,
    visibility: "public",
    location_name: "Din Tai Fung, Xinyi",
    location_city: "Taipei",
    location_country: "Taiwan",
    created_at: "2026-09-10T00:00:00.000Z",
    expires_at: "2099-01-01T00:00:00.000Z",
    deleted_at: null,
    archived_at: null,
    pinned_at: null,
    ...over,
  };
}

function seed(): Record<string, any[]> {
  return {
    feature_flags: [],
    profiles: [
      { id: OWNER, handle: "owner", name: "Owner", avatar_url: null, show_name_publicly: true },
      { id: VIEWER, handle: "viewer", name: "Viewer", avatar_url: null, show_name_publicly: true },
    ],
    blocks: [],
    highlights: [highlightRow(H_KEPT), highlightRow(H_HIDDEN)],
    highlight_views: [],
    highlight_likes: [],
    circle_memberships: [],
    trip_members: [],
    user_follows: [],
    // Both control tables exist and are EMPTY — the exact state census §O.2
    // described, and the state this flow has to move off.
    [RESURFACING_TABLE]: [],
    [PROJECTION_POLICY_TABLE]: [],
  };
}

// ── the fake lives in highlightRouteHarness.ts (shared with the public-projection suite) ──

let server: Server;
let base = "";
let client: FakeClient;

function install(
  state: Record<string, any[]> = seed(),
  opts: { errors?: Record<string, { message: string; code?: string }> } = {},
): FakeClient {
  client = makeClient(state, opts);
  _setTestClient(client as any, true);
  return client;
}

async function req(
  method: "GET" | "PUT" | "DELETE",
  path: string,
  asUser: string,
  body?: unknown,
): Promise<{ status: number; body: any; raw: string }> {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${asUser}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const raw = await r.text();
  let parsed: any = null;
  try { parsed = JSON.parse(raw); } catch { parsed = raw; }
  return { status: r.status, body: parsed, raw };
}

const feedIds = (body: any): string[] => (body?.highlights ?? []).map((h: any) => h.id);

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((rq: any, _res, next) => {
    rq.log = { error() {}, warn() {}, info() {}, debug() {} };
    next();
  });
  app.use("/api", highlightsRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  _setTestClient(null as any, false);
});

beforeEach(() => {
  install();
});

// ── LEG 0: the two halves of the vocabulary agree ────────────────────────────

describe("FLOW 3 leg 0 — the writer's subject key is the key the feed looks up", () => {
  it("every FEED-ENFORCEABLE control is written under a subject_type the feed can resolve", () => {
    // The seam, checked directly before it is checked through HTTP.
    // `subjectTypeFor` (writer) and `feedSubjectScope` (reader) are separate
    // functions over the same table. A control written as `person`-scoped and
    // looked up by Highlight id is stored, listed back as SET, and enforces
    // nothing — the worst outcome available, because the person is told it
    // worked.
    for (const control of FEED_ENFORCEABLE_CONTROLS) {
      const written = subjectTypeFor(control);
      const looked = feedSubjectScope(control);
      const agree = looked === "highlight" ? written === "highlight" : written !== "highlight";
      assert.ok(
        agree,
        `${control} is written under subject_type "${written}" and looked up by ` +
        `"${looked}" — the control would be stored, shown as set, and enforce nothing`,
      );
    }
  });

  it("HIDE_TRIP is NOT claimed as feed-enforceable, and the route says so on the wire", async () => {
    // Census H90: `public.highlights` carries no trip column, so the feed
    // cannot resolve a trip-scoped subject. Claiming it would promise a person
    // an effect the server does not deliver.
    assert.ok(
      (CONTROL_EFFECTS.HIDE_TRIP.suppresses as readonly string[]).includes("proactive_resurfacing"),
      "precondition: HIDE_TRIP is declared to suppress the proactive feed",
    );
    assert.ok(
      !(FEED_ENFORCEABLE_CONTROLS as readonly string[]).includes("HIDE_TRIP"),
      "HIDE_TRIP is claimed enforceable on a surface that cannot resolve a trip",
    );
    const listed = await req("GET", CONTROLS, OWNER);
    assert.equal(listed.status, 200, listed.raw);
    assert.ok(
      listed.body.unenforceableOnFeed.includes("HIDE_TRIP"),
      "the ceiling is not stated on the wire, so a client cannot render it differently",
    );
  });
});

// ── LEG 1 → 3: set → listed → felt ───────────────────────────────────────────

describe("FLOW 3 — DO_NOT_RESURFACE: set it, see it, and stop being resurfaced", () => {
  it("CONTROL: with nothing set, BOTH highlights are on the proactive feed", async () => {
    // Without this the suppression cases would pass against a feed that serves
    // nothing, or a fixture whose rows were never visible.
    const feed = await req("GET", ACTIVE, VIEWER);
    assert.equal(feed.status, 200, feed.raw);
    assert.deepEqual(feedIds(feed.body).sort(), [H_HIDDEN, H_KEPT].sort());
  });

  it("PUT stores the row under the owner, the control and the SUBJECT the feed will ask for", async () => {
    const set = await req("PUT", CONTROLS, OWNER, { control: "DO_NOT_RESURFACE", subjectId: H_HIDDEN });
    assert.equal(set.status, 200, set.raw);
    assert.equal(set.body.control, "DO_NOT_RESURFACE");
    assert.equal(set.body.subjectId, H_HIDDEN);
    assert.deepEqual(set.body.suppresses, CONTROL_EFFECTS.DO_NOT_RESURFACE.suppresses);

    const rows = client._store[RESURFACING_TABLE];
    assert.equal(rows.length, 1, "the control did not reach the store");
    assert.equal(rows[0].owner_id, OWNER);
    assert.equal(rows[0].control, "DO_NOT_RESURFACE");
    assert.equal(rows[0].subject_type, "highlight");
    assert.equal(rows[0].subject_id, H_HIDDEN);
  });

  it("GET lists it back with the surfaces it acts on — the person can see it is set", async () => {
    await req("PUT", CONTROLS, OWNER, { control: "DO_NOT_RESURFACE", subjectId: H_HIDDEN });
    const listed = await req("GET", CONTROLS, OWNER);
    assert.equal(listed.status, 200, listed.raw);
    const mine = listed.body.controls.find((c: any) => c.subjectId === H_HIDDEN);
    assert.ok(mine, "the control was written and does not list back — the screen would show it as off");
    assert.deepEqual(mine.suppresses, ["proactive_resurfacing"]);
    assert.equal(mine.retainsRecord, true, "§21: none of these controls is a delete");
    // The catalogue travels too, so a client never has to hard-code what a
    // control means — §21 insists these stay separate operations in the UX.
    assert.equal(listed.body.catalogue.length, RESURFACING_CONTROLS.length);
  });

  it("THE FEED HONOURS IT — the Highlight is gone, and the other one is not", async () => {
    await req("PUT", CONTROLS, OWNER, { control: "DO_NOT_RESURFACE", subjectId: H_HIDDEN });
    const feed = await req("GET", ACTIVE, VIEWER);
    assert.equal(feed.status, 200, feed.raw);
    const ids = feedIds(feed.body);
    assert.ok(!ids.includes(H_HIDDEN), `the control was set and enforced nothing: ${JSON.stringify(ids)}`);
    assert.ok(ids.includes(H_KEPT), "the control removed a Highlight it does not name");
  });

  it("it RETAINS the record — §21's whole point. The row is still there, undeleted", async () => {
    await req("PUT", CONTROLS, OWNER, { control: "DO_NOT_RESURFACE", subjectId: H_HIDDEN });
    const row = client._store.highlights.find((h: any) => h.id === H_HIDDEN);
    assert.ok(row, "the Highlight was deleted, not suppressed");
    assert.equal(row.deleted_at, null);
    assert.equal(row.archived_at, null, "do-not-resurface and archive are separate operations");
  });

  it("UNDO: clearing it puts the Highlight back on the feed", async () => {
    await req("PUT", CONTROLS, OWNER, { control: "DO_NOT_RESURFACE", subjectId: H_HIDDEN });
    assert.ok(!feedIds((await req("GET", ACTIVE, VIEWER)).body).includes(H_HIDDEN));

    const cleared = await req("DELETE", CONTROLS, OWNER, { control: "DO_NOT_RESURFACE", subjectId: H_HIDDEN });
    assert.equal(cleared.status, 200, cleared.raw);
    assert.equal(cleared.body.cleared, true);
    assert.deepEqual(client._store[RESURFACING_TABLE], [], "the row survived a clear");

    const back = await req("GET", ACTIVE, VIEWER);
    assert.ok(
      feedIds(back.body).includes(H_HIDDEN),
      "a control that cannot be turned off is worse than one never offered",
    );
  });

  it("setting the SAME control twice is one control, not two", async () => {
    // Migration 2720's unique index is (owner_id, control, subject_type,
    // subject_id) and the upsert names it. Two rows would make the clear
    // partial: one DELETE, one row left, the control still enforcing.
    await req("PUT", CONTROLS, OWNER, { control: "DO_NOT_RESURFACE", subjectId: H_HIDDEN });
    await req("PUT", CONTROLS, OWNER, { control: "DO_NOT_RESURFACE", subjectId: H_HIDDEN });
    assert.equal(client._store[RESURFACING_TABLE].length, 1);
  });
});

describe("FLOW 3 — KEEP_PRIVATE_FOREVER cannot be undone by a mis-tap", () => {
  it("clearing it WITHOUT confirmation is refused, and the control stays on", async () => {
    await req("PUT", CONTROLS, OWNER, { control: "KEEP_PRIVATE_FOREVER", subjectId: H_HIDDEN });
    const attempt = await req("DELETE", CONTROLS, OWNER, {
      control: "KEEP_PRIVATE_FOREVER", subjectId: H_HIDDEN, confirm: false,
    });
    assert.equal(attempt.status, 400, attempt.raw);
    assert.equal(client._store[RESURFACING_TABLE].length, 1, "the strongest control was cleared by a mis-tap");
    assert.ok(
      !feedIds((await req("GET", ACTIVE, VIEWER)).body).includes(H_HIDDEN),
      "the refused clear nevertheless un-suppressed the Highlight",
    );
  });

  it("clearing it WITH confirmation works — it is strong, not permanent", async () => {
    await req("PUT", CONTROLS, OWNER, { control: "KEEP_PRIVATE_FOREVER", subjectId: H_HIDDEN });
    const cleared = await req("DELETE", CONTROLS, OWNER, {
      control: "KEEP_PRIVATE_FOREVER", subjectId: H_HIDDEN, confirm: true,
    });
    assert.equal(cleared.status, 200, cleared.raw);
    assert.ok(feedIds((await req("GET", ACTIVE, VIEWER)).body).includes(H_HIDDEN));
  });
});

describe("FLOW 3 — an OWNER-scoped control takes a different key and must still be felt", () => {
  it("HIDE_PERSON_FROM_RESURFACING, set on the owner, removes EVERY one of their Highlights", async () => {
    // The second half of leg 0, through HTTP. This control's subject is a
    // PERSON, so the write stores the owner id and the feed looks it up by
    // owner id. A writer/reader disagreement here is invisible in the stored
    // row and invisible in the listing.
    const set = await req("PUT", CONTROLS, OWNER, {
      control: "HIDE_PERSON_FROM_RESURFACING", subjectId: OWNER,
    });
    assert.equal(set.status, 200, set.raw);
    assert.equal(set.body.subjectType, "person");

    const feed = await req("GET", ACTIVE, VIEWER);
    assert.deepEqual(
      feedIds(feed.body), [],
      "a person-scoped control was stored and enforced nothing on the proactive feed",
    );
  });

  it("RETAIN_BUT_DO_NOT_PERSONALIZE does NOT hide the Highlight — H92's collapse, refused", async () => {
    // §21: "Retain Memory but exclude from preference/recommendation
    // inference." Census H92 records `memory_projections.state='hidden'`
    // collapsing personalization and visibility into one flag. This control
    // suppresses `personalization` ONLY, and a feed that hid on it would be
    // making the same mistake in a new place.
    assert.deepEqual(CONTROL_EFFECTS.RETAIN_BUT_DO_NOT_PERSONALIZE.suppresses, ["personalization"]);
    await req("PUT", CONTROLS, OWNER, {
      control: "RETAIN_BUT_DO_NOT_PERSONALIZE", subjectId: H_HIDDEN,
    });
    const feed = await req("GET", ACTIVE, VIEWER);
    assert.ok(
      feedIds(feed.body).includes(H_HIDDEN),
      "do-not-personalize hid the Highlight — that is the H92 collapse, rebuilt",
    );
  });
});

describe("FLOW 3 — §10 location precision: the rung a person picks is the rung a stranger gets", () => {
  it("PUT stores the rung, GET reads it back, and the FEED clamps the location text", async () => {
    const saved = await req("PUT", `/api/highlights/${H_KEPT}/projection-policy`, OWNER, {
      locationPrecision: "COUNTRY",
    });
    assert.equal(saved.status, 200, saved.raw);
    assert.equal(saved.body.locationPrecision, "COUNTRY");

    const read = await req("GET", `/api/highlights/${H_KEPT}/projection-policy`, OWNER);
    assert.equal(read.status, 200, read.raw);
    assert.equal(read.body.locationPrecision, "COUNTRY");
    // The ladders travel with the policy: §10's rungs COARSEN left to right,
    // and a client that reordered them would render a tightening as a
    // loosening.
    assert.equal(read.body.locationPrecisionLadder[0], "EXACT");
    assert.equal(
      read.body.locationPrecisionLadder[read.body.locationPrecisionLadder.length - 1], "HIDDEN",
    );

    const feed = await req("GET", ACTIVE, VIEWER);
    const shown = (feed.body.highlights ?? []).find((h: any) => h.id === H_KEPT);
    assert.ok(shown, "precondition: the Highlight is still on the feed");
    assert.equal(shown.location_country, "Taiwan", "COUNTRY keeps the country");
    assert.equal(shown.location_city, null, "COUNTRY must drop the city");
    assert.equal(shown.location_name, null, "COUNTRY must drop the venue name");

    // The unclamped neighbour is the control: without it, a clamp applied to
    // every row would pass this case.
    const other = (feed.body.highlights ?? []).find((h: any) => h.id === H_HIDDEN);
    assert.equal(other.location_name, "Din Tai Fung, Xinyi", "the clamp reached a Highlight it does not name");
  });

  it("a Highlight with NO stored rung is served unclamped — a default is the OWNER's to pick", async () => {
    const feed = await req("GET", ACTIVE, VIEWER);
    const shown = (feed.body.highlights ?? []).find((h: any) => h.id === H_KEPT);
    assert.equal(shown.location_name, "Din Tai Fung, Xinyi");
  });

  it("an UNREADABLE policy table clamps every location to HIDDEN rather than serving them raw", async () => {
    // The fail-closed direction, and the one that matters: an outage must not
    // publish a venue name at a precision nobody chose.
    install(seed(), { errors: { [PROJECTION_POLICY_TABLE]: { message: "policy read failed", code: "XX000" } } });
    const feed = await req("GET", ACTIVE, VIEWER);
    assert.equal(feed.status, 200, "an unreadable precision table must not empty the feed");
    for (const h of feed.body.highlights ?? []) {
      assert.equal(h.location_name, null, "a venue name survived an unreadable precision policy");
      assert.equal(h.location_city, null);
      assert.equal(h.location_country, null);
    }
  });
});

describe("FLOW 3 — the control is the OWNER's, and the refusals do not leak", () => {
  it("a stranger cannot set a control on somebody else's Highlight, and gets NOT FOUND", async () => {
    // 404 rather than 403, deliberately: "that exists but is not yours" makes
    // this endpoint an existence oracle for other people's Highlight ids.
    const r = await req("PUT", CONTROLS, VIEWER, { control: "DO_NOT_RESURFACE", subjectId: H_HIDDEN });
    assert.equal(r.status, 404, r.raw);
    assert.equal(r.body.error, "not_found");
    assert.deepEqual(client._store[RESURFACING_TABLE], []);
    assert.ok(feedIds((await req("GET", ACTIVE, VIEWER)).body).includes(H_HIDDEN));
  });

  it("a control naming a Highlight that does not exist is refused the same way", async () => {
    const r = await req("PUT", CONTROLS, OWNER, {
      control: "DO_NOT_RESURFACE", subjectId: "99999999-0000-4000-8000-000000000099",
    });
    assert.equal(r.status, 404, r.raw);
    assert.deepEqual(client._store[RESURFACING_TABLE], []);
  });

  it("an UNKNOWN control is refused and nothing is stored", async () => {
    const r = await req("PUT", CONTROLS, OWNER, { control: "DELETE_EVERYTHING", subjectId: H_HIDDEN });
    assert.equal(r.status, 400, r.raw);
    assert.deepEqual(client._store[RESURFACING_TABLE], []);
  });

  it("an UNWRITABLE control table refuses rather than reporting a stored preference", async () => {
    // The worst available failure on this surface: a 200 here tells somebody
    // their Memory is protected when nothing was written.
    install(seed(), { errors: { [RESURFACING_TABLE]: { message: "permission denied", code: "42501" } } });
    const r = await req("PUT", CONTROLS, OWNER, { control: "DO_NOT_RESURFACE", subjectId: H_HIDDEN });
    assert.notEqual(r.status, 200, `an unwritable control table reported success: ${r.raw}`);
    assert.ok(
      r.body.error === "degraded_unavailable" || r.body.error === "feature_disabled",
      `expected a named refusal, got ${r.raw}`,
    );
  });

  it("an UNREADABLE control set SUPPRESSES the feed rather than resurfacing something asked to be hidden", async () => {
    // `isSuppressed` makes fail-closed the DEFAULT of the membership test. The
    // feed is withheld, and the reason is logged — it does not quietly serve
    // Highlights whose controls it could not read.
    install(seed(), { errors: { [RESURFACING_TABLE]: { message: "permission denied", code: "42501" } } });
    const feed = await req("GET", ACTIVE, VIEWER);
    assert.equal(feed.status, 200);
    assert.deepEqual(
      feedIds(feed.body), [],
      "an unreadable §11 control set resurfaced every Highlight it could not check",
    );
  });
});

/**
 * MUTATIONS RUN, WITH THE COUNTS THEY PRODUCED. Baseline 21/21. Every mutant
 * was applied to the tree, the suite re-run, and the file restored from a
 * byte-for-byte copy; `git status` was clean of source changes at the end.
 *
 *   • `routes/highlights.ts` — `applyResurfacingControls` dropped from
 *     `GET /highlights/active` (the page served as `visible` directly) → 16/5.
 *     Five of twenty-one. THE DEFECT THIS FILE EXISTS FOR: the writer still
 *     writes, the listing still lists, the person is still told the control is
 *     ON, and nothing is suppressed. Every unit test of
 *     `highlightControlWrites.ts` stays green through it.
 *   • `highlightControlWrites.ts` — `subjectTypeFor("DO_NOT_RESURFACE")`
 *     returning `"owner"` instead of `"highlight"` → 17/4. The writer/reader
 *     key disagreement, and it reddens BOTH the direct leg-0 case and the three
 *     HTTP cases that depend on it — which is the point of asserting it twice.
 *   • `routes/highlights.ts` — the `unreadable` arm of
 *     `applyResurfacingControls` returning `rows` instead of `[]` → 20/1. An
 *     outage on the control table resurfaces everything somebody asked to hide.
 *   • `highlightControlWrites.ts` — the `KEEP_PRIVATE_FOREVER` confirmation
 *     requirement bypassed → 20/1. The strongest control this product has
 *     becomes clearable by a mis-tap.
 *   • `highlightResurfacing.ts` — `RETAIN_BUT_DO_NOT_PERSONALIZE` given
 *     `proactive_resurfacing` alongside `personalization` → 20/1. Census H92's
 *     collapse (`memory_projections.state='hidden'` meaning both) rebuilt in a
 *     new place, and §21 is explicit that these stay separate operations.
 *   • `routes/highlights.ts` — `applyLocationPrecision` dropped from
 *     `GET /highlights/active` → 19/2: the clamp case and the fail-closed case.
 *     A venue name a person coarsened to COUNTRY is served in full to a
 *     stranger.
 *   • `highlightControlWrites.ts` — `ownsHighlight`'s owner comparison removed
 *     → 20/1. Anybody could set a §11 control on anybody else's Highlight, and
 *     the endpoint becomes an existence oracle for other people's ids.
 *
 * ONE MUTANT THAT DID NOT REDDEN, with what it taught:
 *
 *   • `highlightResurfacing.ts` — `isSuppressed`'s `unreadable` branch flipped
 *     from `true` to `false` (fail-OPEN) → 21/21. Not a gap: on THIS surface
 *     the unreadable case never reaches `isSuppressed`, because
 *     `applyResurfacingControls` short-circuits on `set.state` first (mutated
 *     separately, above, and it reddens). `isSuppressed`'s own default is the
 *     fail-closed construction for callers that ask the membership question
 *     WITHOUT branching on state, and no such caller is on this flow. Named so
 *     a reader does not conclude from a green run that the default is covered
 *     here — it is covered in `src/test/highlightsBlockFailClosed.test.ts`.
 */
