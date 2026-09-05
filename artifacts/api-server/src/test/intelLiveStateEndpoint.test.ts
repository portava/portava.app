/**
 * §19 GET /v1/experiences/:id/live-state — the spec-literal read model.
 *
 * The property under test is ALIASING, not re-implementation: the endpoint must
 * agree, claim for claim, with lib/liveClaimRead.resolvePlaceIntelState (the
 * reader routes/placeLiving.ts serves the place card from) for every state, and
 * must inherit that reader's gates rather than carry a second copy of them. So
 * each gate case below is asserted TWICE — once through the reader and once
 * through the route, against the same fixture — which is what makes "no second
 * source of truth" a checkable property instead of a comment.
 *
 * Also covered: the §19 envelope (schema_version / source_label / generated_at /
 * valid_until / state_version), ETag revalidation (304 on If-None-Match), the
 * auth gate, and the privacy floor — no contributor id, no coordinate and no
 * exact k-anonymity cohort size may appear anywhere in the body.
 *
 * Runtime: node:test + node:assert/strict (no vitest / no supertest).
 * Run: node --import tsx/esm --test src/test/intelLiveStateEndpoint.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express, { type Express } from "express";
import { _setTestClient } from "../lib/http.js";
import { _clearPromotedScopeCache, resolvePlaceIntelState } from "../lib/liveClaimRead.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const PLACE_ID = "22222222-2222-4222-8222-222222222222";
const NOW = new Date();
const FUTURE = new Date(NOW.getTime() + 30 * 60_000).toISOString();
const PAST = new Date(NOW.getTime() - 30 * 60_000).toISOString();

interface FixtureOpts {
  /** intel_live_label_crowd + its upstream chain. */
  flag?: boolean;
  kill?: boolean;
  pilot?: boolean;
  promoted?: string[];
  snapshots?: any[];
  patterns?: any[];
}

/**
 * One fake client shared by the reader assertions and the route assertions, so
 * a divergence between them can only come from the code under test.
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
        // requireUser's account ban/suspend gate.
        const q: any = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: { account_status: "active" }, error: null }) };
        return q;
      }
      if (table === "intel_live_promoted_scopes") {
        const q: any = { select: () => q };
        return Object.assign(q, {
          then: (res: any) => res({ data: promoted.map((k) => ({ scope_key: k })), error: null }),
        });
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
        // The privacy_eligible and expires_at gates are enforced IN THE QUERY, so
        // the fixture applies them here — otherwise those two cases would prove
        // nothing about the route.
        const eqs: [string, unknown][] = [];
        const gts: [string, string][] = [];
        const q: any = {
          select: () => q,
          eq: (k: string, v: unknown) => { eqs.push([k, v]); return q; },
          gt: (k: string, v: string) => { gts.push([k, v]); return q; },
          in: () => q,
        };
        const rows = () => (opts.snapshots ?? []).filter((r) =>
          eqs.every(([k, v]) => (r as any)[k] === v)
          && gts.every(([k, v]) => typeof (r as any)[k] === "string" && (r as any)[k] > v));
        return Object.assign(q, { then: (res: any) => res({ data: rows(), error: null }) });
      }
      if (table === "intel_historical_patterns") {
        const q: any = {
          select: () => q, eq: () => q, order: () => q, in: () => q,
        };
        return Object.assign(q, { then: (res: any) => res({ data: opts.patterns ?? [], error: null }) });
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
}

/** A privacy-eligible, unexpired crowd snapshot in the promoted scope. */
const liveSnapshot = {
  id: "5c5c5c5c-5555-4555-8555-555555555555",
  subject_id: PLACE_ID,
  zone_id: null,
  claim_type: "crowd.level",
  value: { level: "busy" },
  confidence: 0.8,           // ≥ 0.75 ⇒ band 'live'
  source_count: 30,
  observed_at: PAST,
  expires_at: FUTURE,
  privacy_eligible: true,
  conflict_state: "none",
  computed_at: PAST,
};

/** A §12 pattern for the current UTC weekday/hour — the 'typical' rung. */
function patternForNow() {
  return {
    id: "6d6d6d6d-6666-4666-8666-666666666666",
    zone_id: null,
    claim_family: "crowd.level",
    pattern_kind: "median",
    time_band: `hour_${String(NOW.getUTCHours()).padStart(2, "0")}`,
    dow: NOW.getUTCDay(),
    value_json: { level: "quiet" },
    confidence: 0.6,
    cohort_size: 40,
    window_days: 30,
    is_invalidation: false,
    computed_at: PAST,
  };
}

async function makeApp(): Promise<Express> {
  const { default: readModelsRouter } = await import("../routes/intelReadModels.js");
  const app = express();
  app.use(express.json());
  app.use("/api", readModelsRouter);
  return app;
}

async function req(
  app: Express,
  path: string,
  opts: { token?: string; ifNoneMatch?: string } = {},
): Promise<{ status: number; body: any; etag: string | null }> {
  const server = createServer(app);
  // Bind loopback explicitly — a host-less listen(0) binds [::] and a foreign
  // IPv4 listener can steal the request (see check on the test harness).
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port as number;
  try {
    const headers: Record<string, string> = {};
    const token = opts.token === undefined ? "valid-token" : opts.token;
    if (token) headers.Authorization = `Bearer ${token}`;
    if (opts.ifNoneMatch) headers["If-None-Match"] = opts.ifNoneMatch;
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body, etag: res.headers.get("etag") };
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const PATH = `/api/v1/experiences/${PLACE_ID}/live-state`;

let app: Express;

describe("§19 GET /v1/experiences/:id/live-state — envelope + auth", () => {
  before(async () => { app = await makeApp(); });
  after(() => { _setTestClient(null, false); });

  it("requires a bearer token", async () => {
    _setTestClient(makeClient({ snapshots: [liveSnapshot] }), true);
    const { status } = await req(app, PATH, { token: "" });
    assert.equal(status, 401);
  });

  it("rejects a non-uuid experience id", async () => {
    _setTestClient(makeClient({}), true);
    const { status, body } = await req(app, "/api/v1/experiences/not-a-uuid/live-state");
    assert.equal(status, 400);
    assert.equal(body.error, "invalid_payload");
  });

  it("carries the §19 contract fields on a live answer", async () => {
    _setTestClient(makeClient({ snapshots: [liveSnapshot] }), true);
    const { status, body, etag } = await req(app, PATH);
    assert.equal(status, 200);
    assert.equal(body.schema_version, 1);
    assert.equal(body.source_label, "consensus");
    assert.equal(body.subject_id, PLACE_ID);
    assert.equal(body.state, "live");
    assert.ok(typeof body.generated_at === "string" && !Number.isNaN(Date.parse(body.generated_at)));
    // valid_until is the earliest horizon in the served set — when this answer
    // first stops being wholly current.
    assert.equal(body.valid_until, FUTURE);
    assert.ok(typeof body.state_version === "string" && body.state_version.length > 0);
    assert.equal(etag, `W/"${body.state_version}"`);
  });

  it("answers 304 to a matching If-None-Match and re-serves when the set changes", async () => {
    _setTestClient(makeClient({ snapshots: [liveSnapshot] }), true);
    const first = await req(app, PATH);
    const notMod = await req(app, PATH, { ifNoneMatch: first.etag ?? "" });
    assert.equal(notMod.status, 304);

    // A second claim changes the set ⇒ a different state_version ⇒ 200, not 304.
    const second = { ...liveSnapshot, id: "7e7e7e7e-7777-4777-8777-777777777777", claim_type: "queue.wait" };
    _setTestClient(makeClient({ snapshots: [liveSnapshot, second], promoted: ["|crowd.level", "|queue.wait"] }), true);
    const changed = await req(app, PATH, { ifNoneMatch: first.etag ?? "" });
    assert.equal(changed.status, 200);
    assert.notEqual(changed.body.state_version, first.body.state_version);
  });
});

describe("§19 live-state — the SAME reader, gate for gate (no second source of truth)", () => {
  before(async () => { app = await makeApp(); });
  after(() => { _setTestClient(null, false); });

  /** Assert the route body agrees with the reader run over the same fixture. */
  async function bothAgree(opts: FixtureOpts, expectState: string) {
    const viaReader = await resolvePlaceIntelState(makeClient(opts), PLACE_ID, { now: new Date() });
    assert.equal(viaReader.state, expectState, "reader state");

    _setTestClient(makeClient(opts), true);
    const { status, body } = await req(app, PATH);
    assert.equal(status, 200);
    assert.equal(body.state, expectState, "route state");
    assert.equal(body.claims.length, viaReader.claims.length, "claim count");
    assert.deepEqual(
      body.claims.map((c: any) => c.claimType).sort(),
      viaReader.claims.map((c) => c.claimType).sort(),
    );
  }

  it("live: a promoted, privacy-eligible, unexpired snapshot", async () => {
    await bothAgree({ snapshots: [liveSnapshot] }, "live");
  });

  it("emerging: the same snapshot below the live band but above the serve floor", async () => {
    await bothAgree({ snapshots: [{ ...liveSnapshot, confidence: 0.6 }] }, "emerging");
  });

  it("unknown: the intel_live_label_crowd chain is off", async () => {
    await bothAgree({ flag: false, snapshots: [liveSnapshot] }, "unknown");
  });

  it("unknown: the emergency kill switch is engaged", async () => {
    await bothAgree({ kill: true, snapshots: [liveSnapshot] }, "unknown");
  });

  it("unknown: the IG-09 pilot master switch is off", async () => {
    await bothAgree({ pilot: false, snapshots: [liveSnapshot] }, "unknown");
  });

  it("unknown: the (zone × claim) scope is not promoted", async () => {
    await bothAgree({ promoted: [], snapshots: [liveSnapshot] }, "unknown");
  });

  it("unknown: the snapshot failed the k-anonymity privacy gate", async () => {
    await bothAgree({ snapshots: [{ ...liveSnapshot, privacy_eligible: false }] }, "unknown");
  });

  it("unknown: the snapshot is past its TTL (AT-01 — expiry is not a stale Live label)", async () => {
    await bothAgree({ snapshots: [{ ...liveSnapshot, expires_at: PAST }] }, "unknown");
  });

  it("typical: no live evidence, a §12 pattern answers instead — labelled historical_pattern", async () => {
    await bothAgree({ snapshots: [], patterns: [patternForNow()] }, "typical");
    _setTestClient(makeClient({ snapshots: [], patterns: [patternForNow()] }), true);
    const { body } = await req(app, PATH);
    assert.equal(body.source_label, "historical_pattern");
    // §37: a Typical answer must never be dressed as a current observation.
    assert.equal(body.claims[0].sourceClass, "historical_pattern");
    assert.equal(body.claims[0].state, "typical");
  });

  it("a live answer OUTRANKS a pattern — typical is never returned over live", async () => {
    await bothAgree({ snapshots: [liveSnapshot], patterns: [patternForNow()] }, "live");
  });

  it("unknown: nothing at all ⇒ empty claims and source_label 'none'", async () => {
    _setTestClient(makeClient({ snapshots: [], patterns: [] }), true);
    const { body } = await req(app, PATH);
    assert.equal(body.state, "unknown");
    assert.deepEqual(body.claims, []);
    assert.equal(body.source_label, "none");
    assert.equal(body.valid_until, null);
  });
});

describe("§19 live-state — privacy floor of the served body", () => {
  before(async () => { app = await makeApp(); });
  after(() => { _setTestClient(null, false); });

  it("serves a coarse cohort bucket and never the exact k-anonymity cohort, an actor id or a coordinate", async () => {
    _setTestClient(makeClient({
      snapshots: [{
        ...liveSnapshot,
        // Columns the reader must not project into the envelope even if present.
        distinct_actors: 31,
        actor_id: USER_ID,
        lat: 16.05,
        lng: 108.2,
      }],
    }), true);
    const { body } = await req(app, PATH);
    assert.equal(body.state, "live");
    assert.equal(body.claims[0].sourceCountBucket, "several"); // 30 ⇒ 25..99
    const serialized = JSON.stringify(body);
    for (const forbidden of ["distinct_actors", "actor_id", "\"lat\"", "\"lng\"", "sourceCount\":", USER_ID]) {
      assert.ok(!serialized.includes(forbidden), `body must not carry ${forbidden}`);
    }
  });
});
