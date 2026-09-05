/**
 * §19 read models — the merge hop is a property of the FILE, not of one route.
 *
 * PR #391 taught GET /v1/experiences/:id/live-state to resolve a merged-away
 * place id to its surviving canonical id before reading, because the projection
 * writes intel snapshots and §12 patterns for the CANONICAL subject. Two sibling
 * routes in the very same file addressed the same subject and did NOT resolve:
 *
 *   GET /v1/experiences/:id/typical-patterns  — queried intel_historical_patterns
 *     on the requested id, so a merged-away id matched no rows. /live-state
 *     answered state 'typical' WITH patterns for that id while /typical-patterns
 *     answered []. Two §19 endpoints in one file, disagreeing about one
 *     experience — exactly what the file header promises cannot happen.
 *
 *   GET /v1/intel/prompt-eligibility — read this actor's recent observations and
 *     resolved intel state on the requested id. Worse than a disagreement: the
 *     throttle key and the observation rows then live in different id spaces, so
 *     shouldPrompt's `o.subjectId !== args.subjectId` match fails OPEN and a
 *     prompt we had already earned the right to suppress is emitted.
 *
 * These tests hold the property directly: for a merged id, each route must
 * answer about the SURVIVOR and name the survivor as subject_id. The fake client
 * applies eq/gte filters FOR REAL, so a route that forgot the hop cannot pass by
 * luck — which is what makes each case mutation-sensitive rather than decorative.
 *
 * Runtime: node:test + node:assert/strict (no vitest / no supertest).
 * Run: node --import tsx/esm --test src/test/intelReadModelSiblingMergeHop.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express, { type Express } from "express";
import { _setTestClient } from "../lib/http.js";
import { _clearPromotedScopeCache } from "../lib/liveClaimRead.js";
import { PRIVACY_THRESHOLD_V1 } from "../lib/intelContracts.js";

const USER_ID = "31111111-1111-4111-8111-111111111111";
/** The id the CLIENT asks about — merged away. */
const MERGED_ID = "32222222-2222-4222-8222-222222222222";
/** The surviving canonical id the projection actually writes for. */
const SURVIVOR_ID = "33333333-3333-4333-8333-333333333333";
/** A place that was never merged. */
const PLAIN_ID = "34444444-4444-4444-8444-444444444444";

const NOW = new Date();
const PAST = new Date(NOW.getTime() - 30 * 60_000).toISOString();
const FUTURE = new Date(NOW.getTime() + 30 * 60_000).toISOString();

/** places rows: MERGED_ID points at SURVIVOR_ID; the others are canonical. */
const PLACES = [
  { id: MERGED_ID, merged_into_place_id: SURVIVOR_ID },
  { id: SURVIVOR_ID, merged_into_place_id: null },
  { id: PLAIN_ID, merged_into_place_id: null },
];

/**
 * A §12 pattern for the survivor. distinct_contributors is derived from the
 * privacy constant, never a literal: the typical rung enforces the same
 * k-anonymity floor as the live rung, and a fixture that hard-codes a number
 * silently stops serving (and stops proving anything) the day the floor moves.
 */
function survivorPattern(over: Record<string, unknown> = {}) {
  return {
    id: "35555555-5555-4555-8555-555555555555",
    subject_id: SURVIVOR_ID,
    zone_id: null,
    claim_family: "crowd.level",
    pattern_kind: "typical_crowd_by_weekday_hour",
    time_band: `hour_${String(NOW.getUTCHours()).padStart(2, "0")}`,
    dow: NOW.getUTCDay(),
    value_json: { level: "quiet" },
    confidence: 0.6,
    cohort_size: 40,
    distinct_contributors: PRIVACY_THRESHOLD_V1.minUniqueActors,
    window_days: 30,
    is_invalidation: false,
    computed_at: PAST,
    source_label: "historical_pattern",
    ...over,
  };
}

interface FixtureOpts {
  patterns?: any[];
  observations?: any[];
  snapshots?: any[];
  flag?: boolean;
  kill?: boolean;
  pilot?: boolean;
  promoted?: string[];
  /** Force the places read to error, to exercise the fail-safe fallback. */
  placesError?: boolean;
}

/**
 * Fake Supabase client. Every filter a route applies is applied here for real,
 * so "the route read the wrong subject id" is observable as an empty result
 * rather than being masked by a fixture that returns its rows unconditionally.
 */
function makeClient(opts: FixtureOpts) {
  _clearPromotedScopeCache();
  const promoted = opts.promoted ?? ["|crowd.level"];
  return {
    auth: {
      // eslint-disable-next-line @typescript-eslint/require-await
      async getUser(token: string) {
        if (token === "valid-token") return { data: { user: { id: USER_ID } }, error: null };
        return { data: { user: null }, error: { message: "bad token" } };
      },
    },
    from(table: string) {
      if (table === "profiles") {
        const q: any = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: { account_status: "active" }, error: null }) };
        return q;
      }
      if (table === "places") {
        let wanted: unknown = undefined;
        const q: any = {
          select: () => q,
          eq: (k: string, v: unknown) => { if (k === "id") wanted = v; return q; },
          // eslint-disable-next-line @typescript-eslint/require-await
          maybeSingle: async () => (opts.placesError
            ? { data: null, error: { message: "places read failed" } }
            : { data: PLACES.find((p) => p.id === wanted) ?? null, error: null }),
        };
        return q;
      }
      if (table === "intel_live_promoted_scopes") {
        const q: any = { select: () => q };
        return Object.assign(q, { then: (res: any) => res({ data: promoted.map((k) => ({ scope_key: k })), error: null }) });
      }
      if (table === "feature_flags") {
        let flagName = "";
        const q: any = {
          select: () => q,
          eq: (k: string, v: unknown) => { if (k === "flag") flagName = String(v); return q; },
          maybeSingle: async () => {
            if (flagName === "disable_intel_live_labels") return { data: { enabled: opts.kill ?? false }, error: null };
            if (flagName === "intel_limited_live") return { data: { enabled: opts.pilot ?? true }, error: null };
            return { data: { enabled: opts.flag ?? true }, error: null };
          },
        };
        return q;
      }
      if (table === "intel_state_snapshots") {
        const eqs: [string, unknown][] = [];
        const gts: [string, string][] = [];
        const q: any = {
          select: () => q,
          eq: (k: string, v: unknown) => { eqs.push([k, v]); return q; },
          gt: (k: string, v: string) => { gts.push([k, v]); return q; },
          in: () => q, order: () => q, limit: () => q,
        };
        const rows = () => (opts.snapshots ?? []).filter((r) =>
          eqs.every(([k, v]) => (r as any)[k] === v)
          && gts.every(([k, v]) => typeof (r as any)[k] === "string" && (r as any)[k] > v));
        return Object.assign(q, { then: (res: any) => res({ data: rows(), error: null }) });
      }
      if (table === "intel_historical_patterns") {
        // eq('subject_id', …) is honoured FOR REAL — this is the whole point.
        const eqs: [string, unknown][] = [];
        const q: any = {
          select: () => q,
          eq: (k: string, v: unknown) => { eqs.push([k, v]); return q; },
          order: () => q, limit: () => q, in: () => q,
        };
        const rows = () => (opts.patterns ?? []).filter((r) => eqs.every(([k, v]) => (r as any)[k] === v));
        return Object.assign(q, { then: (res: any) => res({ data: rows(), error: null }) });
      }
      if (table === "intel_observations") {
        const eqs: [string, unknown][] = [];
        const gtes: [string, string][] = [];
        const q: any = {
          select: () => q,
          eq: (k: string, v: unknown) => { eqs.push([k, v]); return q; },
          gte: (k: string, v: string) => { gtes.push([k, v]); return q; },
        };
        const rows = () => (opts.observations ?? []).filter((r) =>
          eqs.every(([k, v]) => (r as any)[k] === v)
          && gtes.every(([k, v]) => typeof (r as any)[k] === "string" && (r as any)[k] >= v));
        return Object.assign(q, { then: (res: any) => res({ data: rows(), error: null }) });
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
}

async function makeApp(): Promise<Express> {
  const { default: readModelsRouter } = await import("../routes/intelReadModels.js");
  const app = express();
  app.use(express.json());
  app.use("/api", readModelsRouter);
  return app;
}

async function req(app: Express, path: string, opts: { token?: string } = {}): Promise<{ status: number; body: any }> {
  const server = createServer(app);
  // Bind loopback explicitly — a host-less listen(0) binds [::] and a foreign
  // IPv4 listener can steal the request.
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port as number;
  try {
    const headers: Record<string, string> = {};
    const token = opts.token === undefined ? "valid-token" : opts.token;
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const patternsPath = (id: string) => `/api/v1/experiences/${id}/typical-patterns`;
const eligibilityPath = (id: string) => `/api/v1/intel/prompt-eligibility?subjectId=${id}`;

let app: Express;

describe("§19 GET /v1/experiences/:id/typical-patterns — merged ids resolve to the survivor", () => {
  before(async () => { app = await makeApp(); });
  after(() => { _setTestClient(null, false); });

  it("serves the SURVIVOR's patterns for a merged-away id — and names the survivor as subject_id", async () => {
    _setTestClient(makeClient({ patterns: [survivorPattern()] }), true);
    const { status, body } = await req(app, patternsPath(MERGED_ID));
    assert.equal(status, 200);
    // Without the merge hop this is [] — the defect this test exists for.
    assert.equal(body.patterns.length, 1, "the survivor's pattern must be served for the merged id");
    assert.equal(body.patterns[0].claim_family, "crowd.level");
    assert.equal(body.subject_id, SURVIVOR_ID, "subject_id must name the canonical survivor, not the merged id");
    assert.equal(body.source_label, "historical_pattern");
  });

  it("does not disagree with /live-state about the same merged experience", async () => {
    // The disagreement the hop exists to prevent: one endpoint answering
    // 'typical' with patterns while its sibling answers [] for the same id.
    _setTestClient(makeClient({ patterns: [survivorPattern()], snapshots: [] }), true);
    const live = await req(app, `/api/v1/experiences/${MERGED_ID}/live-state`);
    const typical = await req(app, patternsPath(MERGED_ID));
    assert.equal(live.status, 200);
    assert.equal(typical.status, 200);
    assert.equal(live.body.state, "typical");
    assert.equal(live.body.subject_id, SURVIVOR_ID);
    assert.equal(typical.body.subject_id, live.body.subject_id, "both §19 endpoints must name one subject");
    assert.ok(
      live.body.claims.length > 0 && typical.body.patterns.length > 0,
      "a 'typical' live-state and an empty typical-patterns is the disagreement under test",
    );
  });

  it("changes nothing for an unmerged place", async () => {
    _setTestClient(makeClient({ patterns: [survivorPattern({ subject_id: PLAIN_ID })] }), true);
    const { status, body } = await req(app, patternsPath(PLAIN_ID));
    assert.equal(status, 200);
    assert.equal(body.patterns.length, 1);
    assert.equal(body.subject_id, PLAIN_ID);
  });

  it("falls back to the requested id when the places read fails — fail-safe, never a wrong subject", async () => {
    _setTestClient(makeClient({ placesError: true, patterns: [survivorPattern({ subject_id: PLAIN_ID })] }), true);
    const { status, body } = await req(app, patternsPath(PLAIN_ID));
    assert.equal(status, 200);
    assert.equal(body.subject_id, PLAIN_ID, "a failed resolution may only under-serve, never invent a subject");
    assert.equal(body.patterns.length, 1);
  });

  it("puts the resolved subject in state_version, so a cached 304 cannot outlive a merge", async () => {
    _setTestClient(makeClient({ patterns: [survivorPattern()] }), true);
    const merged = await req(app, patternsPath(MERGED_ID));
    _setTestClient(makeClient({ patterns: [survivorPattern({ subject_id: PLAIN_ID })] }), true);
    const plain = await req(app, patternsPath(PLAIN_ID));
    assert.notEqual(
      merged.body.state_version,
      plain.body.state_version,
      "two subjects with an identically-shaped pattern set must not share a state_version",
    );
  });
});

describe("§19 GET /v1/intel/prompt-eligibility — merged ids resolve to the survivor", () => {
  before(async () => { app = await makeApp(); });
  after(() => { _setTestClient(null, false); });

  it("honours the survivor's recent observation as the throttle — the merged id must not fail open", async () => {
    // The actor observed the SURVIVOR minutes ago. Asking about the merged id
    // must still be throttled; without the hop the subject_id filter matches
    // nothing, shouldPrompt sees no recent observation and answers prompt:true.
    _setTestClient(makeClient({
      observations: [{ subject_id: SURVIVOR_ID, actor_id: USER_ID, observed_at: PAST }],
    }), true);
    const { status, body } = await req(app, eligibilityPath(MERGED_ID));
    assert.equal(status, 200);
    assert.equal(body.prompt, false, "a recent observation on the survivor must throttle the merged id");
    assert.equal(body.reason, "throttled");
    assert.equal(body.subject_id, SURVIVOR_ID, "subject_id must name the canonical survivor");
  });

  it("reads fresh qualifying evidence from the survivor too", async () => {
    // A live claim exists on the SURVIVOR, so no prompt is needed. Without the
    // hop the reader sees nothing for the merged id and answers prompt:true.
    _setTestClient(makeClient({
      snapshots: [{
        id: "36666666-6666-4666-8666-666666666666",
        subject_id: SURVIVOR_ID,
        zone_id: null,
        claim_type: "crowd.level",
        value: { level: "busy" },
        confidence: 0.8,
        source_count: 30,
        observed_at: PAST,
        expires_at: FUTURE,
        privacy_eligible: true,
        conflict_state: "none",
        computed_at: PAST,
      }],
    }), true);
    const { status, body } = await req(app, eligibilityPath(MERGED_ID));
    assert.equal(status, 200);
    assert.equal(body.prompt, false, "the survivor's live evidence must suppress the prompt");
    assert.equal(body.reason, "fresh_evidence_exists");
    assert.equal(body.subject_id, SURVIVOR_ID);
  });

  it("still prompts when the survivor genuinely has neither evidence nor a recent observation", async () => {
    // The hop must not turn into a blanket suppression: with nothing on the
    // survivor the honest answer is still prompt:true, named for the survivor.
    _setTestClient(makeClient({}), true);
    const { status, body } = await req(app, eligibilityPath(MERGED_ID));
    assert.equal(status, 200);
    assert.equal(body.prompt, true);
    assert.equal(body.reason, "ok");
    assert.equal(body.subject_id, SURVIVOR_ID);
  });

  it("changes nothing for an unmerged place", async () => {
    _setTestClient(makeClient({
      observations: [{ subject_id: PLAIN_ID, actor_id: USER_ID, observed_at: PAST }],
    }), true);
    const { status, body } = await req(app, eligibilityPath(PLAIN_ID));
    assert.equal(status, 200);
    assert.equal(body.prompt, false);
    assert.equal(body.reason, "throttled");
    assert.equal(body.subject_id, PLAIN_ID);
  });

  it("does not borrow ANOTHER actor's observation as this actor's throttle", async () => {
    // Guards the actor_id filter while the subject filter is being changed —
    // resolving the subject must not quietly widen who the throttle counts.
    _setTestClient(makeClient({
      observations: [{ subject_id: SURVIVOR_ID, actor_id: "39999999-9999-4999-8999-999999999999", observed_at: PAST }],
    }), true);
    const { status, body } = await req(app, eligibilityPath(MERGED_ID));
    assert.equal(status, 200);
    assert.equal(body.prompt, true, "another actor's observation is not this actor's throttle");
    assert.equal(body.reason, "ok");
  });
});
