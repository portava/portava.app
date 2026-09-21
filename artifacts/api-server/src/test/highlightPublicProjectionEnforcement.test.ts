/**
 * §10 / §11 — DOES A CONTROL THE OWNER SETS REACH EVERY NON-OWNER SURFACE?
 *
 * verifyFlowHighlightControls.test.ts proves that a §11 control set through
 * the writer is FELT on GET /highlights/active. This file asks the question
 * that flow left open, and that was answered "no" at HEAD before this suite:
 *
 *   KEEP_PRIVATE_FOREVER is declared (CONTROL_EFFECTS) to suppress
 *   `public_projection`, and highlightRevocation.ts names `public_projection`
 *   as a destination the owner is told the control reaches. Yet a stranger
 *   could still (a) list the Highlight on the owner's profile, (b) view, like,
 *   reply to and report it through the routes behind `resolveViewAccess`, and
 *   (c) share it into a Telegraph thread. The five §10 consent columns were
 *   stored and consulted by NO surface.
 *
 * Each surface is driven the way a client drives it. The fake is the one the
 * flow test uses, so a Highlight that is visible before the control is set is
 * visible for the same reasons it is in production: `visibility='public'`,
 * unexpired, not deleted, not archived, no block.
 *
 * ── WHAT THIS SUITE PINS THAT COULD GO WRONG IN THE OTHER DIRECTION ────────
 *
 *   • DO_NOT_RESURFACE does NOT hide the Highlight from a profile visit. §21:
 *     "Retain and search privately; suppress proactive resurfacing." A viewer
 *     who navigates to the owner's profile was not resurfaced anything.
 *   • consent_resurface=false does NOT hide it from a profile visit either;
 *     consent_share=false does.
 *   • A NULL consent column defers to the row's visibility. Explicit-false
 *     only — see highlightPublicProjection.ts for why this is not `mayProject`.
 *   • The OWNER is never refused their own record by any of this.
 *   • An UNREADABLE control table withholds for non-owners; an ABSENT one
 *     serves the surface and says so in the log.
 *
 * SHOWN RED BEFORE GREEN — mutation log at the foot of this file.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/highlightPublicProjectionEnforcement.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import highlightsRouter from "../routes/highlights.js";
import { resolveShareProjections } from "../services/telegraph/shareables.js";
import {
  CONTROL_EFFECTS,
  FEED_ENFORCEABLE_CONTROLS,
  RESURFACING_CONTROLS,
  RESURFACING_TABLE,
  suppressions,
  type ResurfacingSuppressions,
} from "../services/highlights/highlightResurfacing.js";
import {
  PROJECTION_POLICY_TABLE,
  mayProject,
  type ProjectionPolicyRead,
} from "../services/highlights/highlightProjectionPolicy.js";
import {
  NON_OWNER_SURFACES,
  SURFACE_CONSENT_DIMENSIONS,
  consentWithholds,
  controlsSuppressing,
  filterProjectable,
  projectionPostureNotes,
  publicProjectionVerdict,
  readProjectionInputs,
} from "../services/highlights/highlightPublicProjection.js";
import { makeClient, type FakeClient } from "./highlightRouteHarness.js";

const OWNER = "11111111-0000-4000-8000-000000000001";
const VIEWER = "22222222-0000-4000-8000-000000000002";
const H_KEPT = "aaaaaaaa-0000-4000-8000-00000000000a";
const H_HIDDEN = "bbbbbbbb-0000-4000-8000-00000000000b";
const THREAD = "dddddddd-0000-4000-8000-00000000000d";

const CONTROLS = "/api/highlights/resurfacing-controls";
const ACTIVE = "/api/highlights/active";
const PROFILE = `/api/users/${OWNER}/highlights`;
const policyPath = (id: string) => `/api/highlights/${id}/projection-policy`;

function highlightRow(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    owner_id: OWNER,
    media_url: `post-media/${OWNER}/highlights/${id}.jpg`,
    media_type: "image",
    caption: `caption ${id}`,
    visibility: "public",
    location_name: "Din Tai Fung, Xinyi",
    location_city: "Taipei",
    location_country: "Taiwan",
    created_at: "2026-09-10T00:00:00.000Z",
    updated_at: "2026-09-10T00:00:00.000Z",
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
    highlight_replies: [],
    highlight_reports: [],
    circle_memberships: [],
    trip_members: [],
    user_follows: [],
    [RESURFACING_TABLE]: [],
    [PROJECTION_POLICY_TABLE]: [],
  };
}

// ── PART A: the verdict, pure ────────────────────────────────────────────────

const H = { id: H_HIDDEN, owner_id: OWNER };
const READY_EMPTY: ResurfacingSuppressions = suppressions([]);
const NO_POLICY: ProjectionPolicyRead = { state: "ready", byHighlightId: new Map() };
const policyOf = (row: Record<string, unknown>): ProjectionPolicyRead => ({
  state: "ready",
  byHighlightId: new Map([[H_HIDDEN, { highlight_id: H_HIDDEN, owner_id: OWNER, ...row }]]),
});
const UNREADABLE = { state: "unreadable" as const, reason: "injected" };
const ABSENT = { state: "absent" as const, reason: "not deployed" };

describe("A. the enforceable-control sets are DERIVED from CONTROL_EFFECTS", () => {
  it("public_projection is suppressed by KEEP_PRIVATE_FOREVER and by nothing else", () => {
    assert.deepEqual(controlsSuppressing("public_projection"), ["KEEP_PRIVATE_FOREVER"]);
    // and that is CONTROL_EFFECTS' own claim, not this test's
    for (const c of RESURFACING_CONTROLS) {
      const declared = (CONTROL_EFFECTS[c].suppresses as readonly string[]).includes("public_projection");
      assert.equal(controlsSuppressing("public_projection").includes(c), declared && CONTROL_EFFECTS[c].scope !== "trip", c);
    }
  });

  it("proactive_resurfacing agrees with FEED_ENFORCEABLE_CONTROLS exactly", () => {
    assert.deepEqual([...controlsSuppressing("proactive_resurfacing")].sort(), [...FEED_ENFORCEABLE_CONTROLS].sort());
  });

  it("the feeds ask RESURFACE and SHARE; a navigated-to surface asks SHARE only", () => {
    assert.deepEqual(NON_OWNER_SURFACES, ["proactive_resurfacing", "public_projection"]);
    assert.deepEqual(SURFACE_CONSENT_DIMENSIONS.proactive_resurfacing, ["RESURFACE", "SHARE"]);
    assert.deepEqual(SURFACE_CONSENT_DIMENSIONS.public_projection, ["SHARE"]);
  });
});

describe("A. consentWithholds — explicit false only, and it is NOT mayProject", () => {
  it("false withholds; true, null, absent and the string 'false' do not", () => {
    assert.equal(consentWithholds({ consent_share: false }, "SHARE"), true);
    assert.equal(consentWithholds({ consent_share: true }, "SHARE"), false);
    assert.equal(consentWithholds({ consent_share: null }, "SHARE"), false);
    assert.equal(consentWithholds({}, "SHARE"), false);
    assert.equal(consentWithholds(undefined, "SHARE"), false);
    assert.equal(consentWithholds({ consent_share: "false" }, "SHARE"), false, "a mis-typed column is unknown, not a refusal");
  });

  it("mayProject still refuses unknown — the two rules coexist on purpose", () => {
    // If someone 'simplifies' this module to `!mayProject(...)`, every
    // Highlight with no policy row disappears from every non-owner surface.
    assert.equal(mayProject("unknown"), false);
    assert.equal(consentWithholds(undefined, "SHARE"), false);
  });
});

describe("A. publicProjectionVerdict", () => {
  it("the owner is never refused — not by a control, not by consent, not by an outage", () => {
    const worst = {
      controls: suppressions([{ control: "KEEP_PRIVATE_FOREVER", subjectId: H_HIDDEN }]),
      policies: policyOf({ consent_share: false, consent_resurface: false }),
    };
    for (const surface of NON_OWNER_SURFACES) {
      assert.deepEqual(publicProjectionVerdict(H, OWNER, surface, worst), { allow: true });
      assert.deepEqual(publicProjectionVerdict(H, OWNER, surface, { controls: UNREADABLE, policies: UNREADABLE }), { allow: true });
    }
  });

  it("POSITIVE CONTROL: nothing set, both tables ready → a stranger is allowed on both surfaces", () => {
    for (const surface of NON_OWNER_SURFACES) {
      assert.deepEqual(publicProjectionVerdict(H, VIEWER, surface, { controls: READY_EMPTY, policies: NO_POLICY }), { allow: true });
    }
  });

  it("KEEP_PRIVATE_FOREVER on the Highlight refuses a stranger on BOTH surfaces", () => {
    const controls = suppressions([{ control: "KEEP_PRIVATE_FOREVER", subjectId: H_HIDDEN }]);
    for (const surface of NON_OWNER_SURFACES) {
      const v = publicProjectionVerdict(H, VIEWER, surface, { controls, policies: NO_POLICY });
      assert.equal(v.allow, false);
      assert.equal(v.allow === false && v.kind, "suppressed");
    }
    // keyed on the Highlight: a control on a DIFFERENT Highlight does nothing
    const other = suppressions([{ control: "KEEP_PRIVATE_FOREVER", subjectId: H_KEPT }]);
    assert.deepEqual(publicProjectionVerdict(H, VIEWER, "public_projection", { controls: other, policies: NO_POLICY }), { allow: true });
  });

  it("DO_NOT_RESURFACE refuses the feed and NOT the navigated-to surface (§21)", () => {
    const controls = suppressions([{ control: "DO_NOT_RESURFACE", subjectId: H_HIDDEN }]);
    assert.equal(publicProjectionVerdict(H, VIEWER, "proactive_resurfacing", { controls, policies: NO_POLICY }).allow, false);
    assert.equal(publicProjectionVerdict(H, VIEWER, "public_projection", { controls, policies: NO_POLICY }).allow, true);
  });

  it("HIDE_PERSON_FROM_RESURFACING is keyed on the OWNER for the feed, and does not touch public_projection", () => {
    const controls = suppressions([{ control: "HIDE_PERSON_FROM_RESURFACING", subjectId: OWNER }]);
    assert.equal(publicProjectionVerdict(H, VIEWER, "proactive_resurfacing", { controls, policies: NO_POLICY }).allow, false);
    assert.equal(publicProjectionVerdict(H, VIEWER, "public_projection", { controls, policies: NO_POLICY }).allow, true);
  });

  it("consent_share=false refuses BOTH surfaces; consent_resurface=false refuses the feed only", () => {
    const share = policyOf({ consent_share: false });
    for (const surface of NON_OWNER_SURFACES) {
      const v = publicProjectionVerdict(H, VIEWER, surface, { controls: READY_EMPTY, policies: share });
      assert.equal(v.allow, false, surface);
      assert.equal(v.allow === false && v.kind, "withheld");
    }
    const resurface = policyOf({ consent_resurface: false });
    assert.equal(publicProjectionVerdict(H, VIEWER, "proactive_resurfacing", { controls: READY_EMPTY, policies: resurface }).allow, false);
    assert.equal(publicProjectionVerdict(H, VIEWER, "public_projection", { controls: READY_EMPTY, policies: resurface }).allow, true);
  });

  it("the other three dimensions do not gate a viewer: STORE, PERSONALIZE, AGGREGATE_INTEL are not audience decisions", () => {
    const p = policyOf({ consent_store: false, consent_personalize: false, consent_contribute_to_aggregate_intel: false });
    for (const surface of NON_OWNER_SURFACES) {
      assert.equal(publicProjectionVerdict(H, VIEWER, surface, { controls: READY_EMPTY, policies: p }).allow, true, surface);
    }
  });

  it("a NULL consent defers to the row's visibility (explicit-false only)", () => {
    const p = policyOf({ consent_share: null, consent_resurface: null });
    for (const surface of NON_OWNER_SURFACES) {
      assert.equal(publicProjectionVerdict(H, VIEWER, surface, { controls: READY_EMPTY, policies: p }).allow, true, surface);
    }
  });

  it("UNREADABLE (either table) refuses a stranger and says which; ABSENT (either) allows", () => {
    for (const surface of NON_OWNER_SURFACES) {
      const a = publicProjectionVerdict(H, VIEWER, surface, { controls: UNREADABLE, policies: NO_POLICY });
      assert.equal(a.allow === false && a.kind, "unreadable");
      assert.match(a.allow === false ? a.reason : "", /§11/);
      const b = publicProjectionVerdict(H, VIEWER, surface, { controls: READY_EMPTY, policies: UNREADABLE });
      assert.equal(b.allow === false && b.kind, "unreadable");
      assert.match(b.allow === false ? b.reason : "", /§10/);
      assert.deepEqual(publicProjectionVerdict(H, VIEWER, surface, { controls: ABSENT, policies: ABSENT }), { allow: true });
    }
  });

  it("filterProjectable logs a degraded posture once per call, and never when both reads are ready", () => {
    const logs: Array<{ obj: any; msg: string }> = [];
    const log = { error: (obj: unknown, msg: string) => logs.push({ obj, msg }) };
    const rows = [{ id: H_KEPT, owner_id: OWNER }, { id: H_HIDDEN, owner_id: OWNER }];

    assert.deepEqual(filterProjectable(rows, VIEWER, "public_projection", { controls: READY_EMPTY, policies: NO_POLICY }, log, "t"), rows);
    assert.equal(logs.length, 0);
    assert.deepEqual(projectionPostureNotes({ controls: READY_EMPTY, policies: NO_POLICY }), []);

    assert.deepEqual(filterProjectable(rows, VIEWER, "public_projection", { controls: ABSENT, policies: NO_POLICY }, log, "t"), rows);
    assert.equal(logs.length, 1);
    assert.match(logs[0]!.msg, /NOT DEPLOYED/);

    assert.deepEqual(filterProjectable(rows, VIEWER, "public_projection", { controls: READY_EMPTY, policies: UNREADABLE }, log, "t"), []);
    assert.equal(logs.length, 2);
    assert.match(logs[1]!.msg, /UNREADABLE — withholding/);

    // the owner's rows survive an outage
    assert.deepEqual(filterProjectable(rows, OWNER, "public_projection", { controls: UNREADABLE, policies: UNREADABLE }, log, "t"), rows);
  });

  it("readProjectionInputs with no client is unreadable on both, not absent", async () => {
    const r = await readProjectionInputs(null, [OWNER], [H_HIDDEN]);
    assert.equal(r.controls.state, "unreadable");
    assert.equal(r.policies.state, "unreadable");
  });
});

// ── PART B: the routes ───────────────────────────────────────────────────────

let server: Server;
let base = "";
let client: FakeClient;
let logs: Array<{ obj: any; msg: string }> = [];

function install(
  state: Record<string, any[]> = seed(),
  opts: { errors?: Record<string, { message: string; code?: string }> } = {},
): FakeClient {
  client = makeClient(state, opts);
  _setTestClient(client as any, true);
  return client;
}

async function req(
  method: "GET" | "POST" | "PUT" | "DELETE",
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

const ids = (body: any): string[] => (body?.highlights ?? []).map((h: any) => h.id).sort();
const BOTH = [H_HIDDEN, H_KEPT].sort();

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((rq: any, _res, next) => {
    rq.log = {
      error: (obj: unknown, msg: string) => logs.push({ obj, msg }),
      warn() {}, info() {}, debug() {},
    };
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
  logs = [];
  install();
});

async function keepPrivate(id: string) {
  const r = await req("PUT", CONTROLS, OWNER, { control: "KEEP_PRIVATE_FOREVER", subjectId: id });
  assert.equal(r.status, 200, r.raw);
}
async function setConsent(id: string, consent: Record<string, boolean | null>) {
  const r = await req("PUT", policyPath(id), OWNER, { consent });
  assert.equal(r.status, 200, r.raw);
}

/** The five routes behind resolveViewAccess, each driven as the VIEWER. */
const ENGAGEMENTS: Array<{ name: string; method: "POST" | "DELETE"; path: (id: string) => string; body?: unknown }> = [
  { name: "view", method: "POST", path: (id) => `/api/highlights/${id}/view` },
  { name: "like", method: "POST", path: (id) => `/api/highlights/${id}/like` },
  { name: "unlike", method: "DELETE", path: (id) => `/api/highlights/${id}/like` },
  { name: "reply", method: "POST", path: (id) => `/api/highlights/${id}/reply`, body: { message: "hi" } },
  { name: "report", method: "POST", path: (id) => `/api/highlights/${id}/report`, body: { reason: "test" } },
];

describe("B. POSITIVE CONTROL — with nothing set, a stranger reaches the Highlight on every surface", () => {
  it("profile listing shows both; the proactive feed shows both", async () => {
    const p = await req("GET", PROFILE, VIEWER);
    assert.equal(p.status, 200, p.raw);
    assert.deepEqual(ids(p.body), BOTH);
    const f = await req("GET", ACTIVE, VIEWER);
    assert.equal(f.status, 200, f.raw);
    assert.deepEqual(ids(f.body), BOTH);
  });

  it("every engagement route gets past the access gate (nothing answers not_found)", async () => {
    for (const e of ENGAGEMENTS) {
      const r = await req(e.method, e.path(H_HIDDEN), VIEWER, e.body);
      assert.notEqual(r.status, 404, `${e.name}: ${r.raw}`);
      assert.notEqual(r.body?.error?.code ?? r.body?.code, "not_found", `${e.name}: ${r.raw}`);
    }
  });
});

describe("B. KEEP_PRIVATE_FOREVER reaches public_projection — the destination the owner was promised", () => {
  it("the profile listing withholds it from a stranger and keeps the other Highlight", async () => {
    await keepPrivate(H_HIDDEN);
    const p = await req("GET", PROFILE, VIEWER);
    assert.equal(p.status, 200, p.raw);
    assert.deepEqual(ids(p.body), [H_KEPT]);
    assert.ok(!p.raw.includes(`caption ${H_HIDDEN}`), "the withheld Highlight's caption is still on the wire");
  });

  it("the owner still sees BOTH on their own profile — it is not a delete", async () => {
    await keepPrivate(H_HIDDEN);
    const p = await req("GET", PROFILE, OWNER);
    assert.equal(p.status, 200, p.raw);
    assert.deepEqual(ids(p.body), BOTH);
  });

  it("every engagement route answers not_found to a stranger, indistinguishable from a real absence", async () => {
    await keepPrivate(H_HIDDEN);
    const control = await req("POST", `/api/highlights/${H_KEPT}/view`, VIEWER);
    assert.equal(control.status, 200, `control: ${control.raw}`);
    for (const e of ENGAGEMENTS) {
      const r = await req(e.method, e.path(H_HIDDEN), VIEWER, e.body);
      assert.equal(r.status, 404, `${e.name}: ${r.raw}`);
      assert.match(r.raw, /Highlight not found/, e.name);
    }
    // and nothing was written on the way to the refusal
    assert.equal(client._store.highlight_views.length, 1, "only the control's view was recorded");
    assert.equal(client._store.highlight_likes.length, 0);
    assert.equal(client._store.highlight_reports.length, 0);
  });

  it("clearing it (with confirmation) restores the profile listing", async () => {
    await keepPrivate(H_HIDDEN);
    const del = await req("DELETE", CONTROLS, OWNER, { control: "KEEP_PRIVATE_FOREVER", subjectId: H_HIDDEN, confirm: true });
    assert.equal(del.status, 200, del.raw);
    assert.deepEqual(ids((await req("GET", PROFILE, VIEWER)).body), BOTH);
  });
});

describe("B. DO_NOT_RESURFACE does NOT reach public_projection — no over-suppression", () => {
  it("the feed drops it, the profile listing keeps it, engagement stays open", async () => {
    const r = await req("PUT", CONTROLS, OWNER, { control: "DO_NOT_RESURFACE", subjectId: H_HIDDEN });
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(ids((await req("GET", ACTIVE, VIEWER)).body), [H_KEPT]);
    assert.deepEqual(ids((await req("GET", PROFILE, VIEWER)).body), BOTH);
    const v = await req("POST", `/api/highlights/${H_HIDDEN}/view`, VIEWER);
    assert.equal(v.status, 200, v.raw);
  });
});

describe("B. §10 consent — stored by the writer, and now read", () => {
  it("consent SHARE=false withholds from the profile listing, the feed, and every engagement route", async () => {
    await setConsent(H_HIDDEN, { SHARE: false });
    assert.deepEqual(ids((await req("GET", PROFILE, VIEWER)).body), [H_KEPT]);
    assert.deepEqual(ids((await req("GET", ACTIVE, VIEWER)).body), [H_KEPT]);
    for (const e of ENGAGEMENTS) {
      const r = await req(e.method, e.path(H_HIDDEN), VIEWER, e.body);
      assert.equal(r.status, 404, `${e.name}: ${r.raw}`);
    }
    // the owner is unaffected
    assert.deepEqual(ids((await req("GET", PROFILE, OWNER)).body), BOTH);
  });

  it("consent RESURFACE=false withholds from the feed ONLY", async () => {
    await setConsent(H_HIDDEN, { RESURFACE: false });
    assert.deepEqual(ids((await req("GET", ACTIVE, VIEWER)).body), [H_KEPT]);
    assert.deepEqual(ids((await req("GET", PROFILE, VIEWER)).body), BOTH);
    const v = await req("POST", `/api/highlights/${H_HIDDEN}/view`, VIEWER);
    assert.equal(v.status, 200, v.raw);
  });

  it("consent SHARE=true, or SHARE unset (null), changes nothing", async () => {
    await setConsent(H_HIDDEN, { SHARE: true });
    await setConsent(H_KEPT, { SHARE: null });
    assert.deepEqual(ids((await req("GET", PROFILE, VIEWER)).body), BOTH);
    assert.deepEqual(ids((await req("GET", ACTIVE, VIEWER)).body), BOTH);
  });

  it("the following-feed enforces consent BEFORE the page is cut (cursor stays honest)", async () => {
    // Viewer follows owner; two Highlights; SHARE refused on one; page size 1.
    const state = seed();
    state.user_follows = [{ follower_id: VIEWER, following_id: OWNER, status: "accepted" }];
    state.circle_memberships = [{ user_id: OWNER, other_id: VIEWER }];
    state.feature_flags = [{ key: "highlights_feed_bounded_enabled", enabled: true }];
    install(state);
    await setConsent(H_HIDDEN, { SHARE: false });
    const r = await req("GET", "/api/highlights/following-feed?limit=1", VIEWER);
    assert.equal(r.status, 200, r.raw);
    const served = (r.body?.users ?? []).flatMap((u: any) => (u.highlights ?? []).map((h: any) => h.id));
    assert.ok(!served.includes(H_HIDDEN), `the refused Highlight was served: ${r.raw}`);
  });
});

describe("B. postures — unreadable withholds from strangers, absent serves and is logged", () => {
  it("an UNREADABLE controls table empties the stranger's profile view and refuses engagement; the owner is untouched", async () => {
    install(seed(), { errors: { [RESURFACING_TABLE]: { message: "injected outage" } } });
    const p = await req("GET", PROFILE, VIEWER);
    assert.equal(p.status, 200, p.raw);
    assert.deepEqual(ids(p.body), []);
    assert.ok(logs.some((l) => /UNREADABLE — withholding/.test(l.msg)), "the outage was not logged");
    const v = await req("POST", `/api/highlights/${H_HIDDEN}/view`, VIEWER);
    assert.equal(v.status, 404, v.raw);
    assert.deepEqual(ids((await req("GET", PROFILE, OWNER)).body), BOTH);
  });

  it("an UNREADABLE policy table does the same", async () => {
    install(seed(), { errors: { [PROJECTION_POLICY_TABLE]: { message: "injected outage" } } });
    assert.deepEqual(ids((await req("GET", PROFILE, VIEWER)).body), []);
    const v = await req("POST", `/api/highlights/${H_HIDDEN}/like`, VIEWER);
    assert.equal(v.status, 404, v.raw);
    assert.deepEqual(ids((await req("GET", PROFILE, OWNER)).body), BOTH);
  });

  it("an ABSENT controls table (not deployed) serves the stranger and logs NOT DEPLOYED", async () => {
    install(seed(), { errors: { [RESURFACING_TABLE]: { message: "relation does not exist", code: "42P01" } } });
    const p = await req("GET", PROFILE, VIEWER);
    assert.equal(p.status, 200, p.raw);
    assert.deepEqual(ids(p.body), BOTH);
    assert.ok(logs.some((l) => /NOT DEPLOYED/.test(l.msg) && /users\/:userId\/highlights/.test(String(l.obj?.where))), "absence was not logged for the profile surface");
    const v = await req("POST", `/api/highlights/${H_HIDDEN}/view`, VIEWER);
    assert.equal(v.status, 200, v.raw);
  });
});

// ── PART C: Telegraph share ──────────────────────────────────────────────────

async function resolveHighlight(
  state: Record<string, any[]>,
  viewer: string,
  opts: { errors?: Record<string, { message: string; code?: string }> } = {},
) {
  const c = makeClient(state, opts);
  const [r] = await resolveShareProjections(c as any, viewer, THREAD, [{ objectType: "HIGHLIGHT", objectId: H_HIDDEN }]);
  return r!;
}

describe("C. Telegraph share — dropping a Highlight into a thread is public_projection", () => {
  it("POSITIVE CONTROL: a live public Highlight resolves for a stranger", async () => {
    const r = await resolveHighlight(seed(), VIEWER);
    assert.equal(r.available, true, JSON.stringify(r));
    assert.equal(r.available === true && r.projection.title, `caption ${H_HIDDEN}`);
  });

  it("KEEP_PRIVATE_FOREVER makes it 'private' for a stranger and carries nothing; the owner can still share it", async () => {
    const state = seed();
    state[RESURFACING_TABLE] = [{ id: "r1", owner_id: OWNER, control: "KEEP_PRIVATE_FOREVER", subject_type: "highlight", subject_id: H_HIDDEN }];
    const r = await resolveHighlight(state, VIEWER);
    assert.equal(r.available, false);
    assert.equal(r.available === false && r.reason, "private");
    assert.ok(!JSON.stringify(r).includes(`caption ${H_HIDDEN}`), "the caption leaked through the refusal");
    const mine = await resolveHighlight(state, OWNER);
    assert.equal(mine.available, true);
  });

  it("consent SHARE=false is 'private' for a stranger; RESURFACE=false is not (a share is not a resurfacing)", async () => {
    const share = seed();
    share[PROJECTION_POLICY_TABLE] = [{ id: "p1", highlight_id: H_HIDDEN, owner_id: OWNER, consent_share: false }];
    const r = await resolveHighlight(share, VIEWER);
    assert.equal(r.available === false && r.reason, "private");

    const resurface = seed();
    resurface[PROJECTION_POLICY_TABLE] = [{ id: "p1", highlight_id: H_HIDDEN, owner_id: OWNER, consent_resurface: false }];
    assert.equal((await resolveHighlight(resurface, VIEWER)).available, true);
  });

  it("DO_NOT_RESURFACE does not block a share", async () => {
    const state = seed();
    state[RESURFACING_TABLE] = [{ id: "r1", owner_id: OWNER, control: "DO_NOT_RESURFACE", subject_type: "highlight", subject_id: H_HIDDEN }];
    assert.equal((await resolveHighlight(state, VIEWER)).available, true);
  });

  it("an UNREADABLE control table is 'unknown' for a stranger — not 'private', not available", async () => {
    const r = await resolveHighlight(seed(), VIEWER, { errors: { [RESURFACING_TABLE]: { message: "injected outage" } } });
    assert.equal(r.available, false);
    assert.equal(r.available === false && r.reason, "unknown");
    const mine = await resolveHighlight(seed(), OWNER, { errors: { [RESURFACING_TABLE]: { message: "injected outage" } } });
    assert.equal(mine.available, true, "the owner's own share does not depend on the control table");
  });

  it("an ABSENT policy table serves the share (nothing could have been set)", async () => {
    const r = await resolveHighlight(seed(), VIEWER, { errors: { [PROJECTION_POLICY_TABLE]: { message: "missing", code: "PGRST205" } } });
    assert.equal(r.available, true, JSON.stringify(r));
  });
});

describe("C. Telegraph share — the card's location is clamped to the owner's §10 rung (H81)", () => {
  // Found while wiring the gate: `loadHighlight` projected `location_name,
  // location_city` verbatim, so a share card published the venue of a Highlight
  // whose owner had clamped it to CITY. "Publishing location must never exceed
  // the owner's selected precision" (§10) — a thread is publishing.
  const subtitleOf = (r: any) => (r.available === true ? r.projection.subtitle : undefined);

  it("POSITIVE CONTROL: with no rung selected, venue and city ship", async () => {
    assert.equal(subtitleOf(await resolveHighlight(seed(), VIEWER)), "Din Tai Fung, Xinyi, Taipei");
  });

  it("CITY drops the venue; HIDDEN drops everything — for a stranger AND for the owner's own share", async () => {
    for (const who of [VIEWER, OWNER]) {
      const city = seed();
      city[PROJECTION_POLICY_TABLE] = [{ id: "p1", highlight_id: H_HIDDEN, owner_id: OWNER, location_precision: "CITY" }];
      assert.equal(subtitleOf(await resolveHighlight(city, who)), "Taipei", who);

      const hidden = seed();
      hidden[PROJECTION_POLICY_TABLE] = [{ id: "p1", highlight_id: H_HIDDEN, owner_id: OWNER, location_precision: "HIDDEN" }];
      const r = await resolveHighlight(hidden, who);
      assert.equal(r.available, true, who);
      assert.equal(subtitleOf(r), null, who);
      assert.ok(!JSON.stringify(r).includes("Din Tai Fung"), `${who}: the venue leaked through HIDDEN`);
    }
  });

  it("an UNREADABLE policy table clamps the OWNER's own share to HIDDEN rather than failing it", async () => {
    const r = await resolveHighlight(seed(), OWNER, { errors: { [PROJECTION_POLICY_TABLE]: { message: "injected outage" } } });
    assert.equal(r.available, true, JSON.stringify(r));
    assert.equal(subtitleOf(r), null);
  });
});

/*
 * ── MUTATION LOG (2026-09-18) ────────────────────────────────────────────────
 * Before the gate existed: 25 pass / 11 fail — every surface case red, every
 * pure case and both positive controls green. After wiring: 36 / 0. Then each
 * of the following was applied alone, the three suites (this file,
 * verifyFlowHighlightControls, telegraphShareFamilies) run, and the change
 * reverted. Each turned at least one case red:
 *
 *   M1  resolveViewAccess gate removed ............ 4 red (engagement, consent, unreadable)
 *   M2  profile listing filter skipped ............ 5 red
 *   M3  Telegraph gate removed .................... 3 red
 *   M4  consentWithholds always false ............. 6 red
 *   M5  owner bypass removed ...................... 2 red
 *   M6  unreadable §11 set → allow ................ 3 red
 *   M6b unreadable §10 policies → allow ........... 3 red
 *   M7  following-feed consent pass removed ....... 1 red (the pre-slice case)
 *   M8  /highlights/active consent pass removed ... 2 red
 *   M9  public_projection also asks RESURFACE ..... 4 red (over-suppression)
 *   M10 controls list hardcoded to the feed set ... 5 red (DO_NOT_RESURFACE would hide a profile)
 *   M11 degraded posture not logged ............... 3 red
 *
 * Two pre-existing cases moved with this change and were re-pinned rather
 * than deleted: highlightConsentPolicy "an UNREADABLE policy table …" and
 * highlightProfilePrecisionClamp "clamps to HIDDEN when … UNREADABLE". Both
 * said an unreadable policy table withholds the LOCATION and not the
 * Highlight; that was correct while the table carried only a precision rung,
 * and is not once its consent columns are enforced on the same surfaces.
 */
