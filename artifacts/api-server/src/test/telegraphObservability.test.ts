/**
 * Telegraph §28 / §30A.17 — the SLO registry, the middleware and the
 * diagnostics surface, executed.
 *
 * The census found nothing here at all: "No metric is emitted for messaging and
 * no target constant exists… Telegraph has no telemetry sink at all." What is
 * asserted below is the REAL middleware wrapped around the REAL messaging
 * router, the REAL block guard, and the REAL admin-gated diagnostics route —
 * not a model of any of them.
 *
 * SHOWN RED BEFORE GREEN — four deliberate, reverted mutations:
 *   1. middlewares/telegraphObservability.ts — `outcomeFor` changed so a 403
 *      counts as a violation. The "a refusal is not an availability failure"
 *      assertion failed, which is the whole design of that function.
 *   2. lib/blockGuard.ts — the fail-closed branch's
 *      recordTelegraphMetric("block_enforcement_failures", "violation") removed.
 *      The unreadable-blocks assertion failed.
 *   3. middlewares/telegraphObservability.ts — the duplicate window's
 *      `rememberClientId` made to always return false. The duplicate-send
 *      assertion failed.
 *   4. routes/telegraphDiagnostics.ts — the purpose-length check removed. The
 *      "an empty purpose is refused" assertion failed.
 *
 * Run: node --import tsx/esm --test src/test/telegraphObservability.test.ts
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer, type Server } from "node:http";

import { _setTestClient } from "../lib/http.js";
import messagingRouter from "../routes/messaging.js";
import telegraphDiagnosticsRouter from "../routes/telegraphDiagnostics.js";
import { telegraphObservability, _resetTelegraphDuplicateWindow } from "../middlewares/telegraphObservability.js";
import { isBlockedBetween } from "../lib/blockGuard.js";
import {
  TELEGRAPH_SLOS,
  telegraphSloSnapshot,
  recordTelegraphMetric,
  _resetTelegraphMetrics,
} from "../domain/telegraph/services/telegraphObservability.js";
import { TELEGRAPH_PROJECTIONS } from "../domain/telegraph/projections/projectionRegistry.js";
import { makeFakeClient, call, type FakeClient } from "./telegraphCertificationHarness.js";

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const DM = "00000000-0000-4000-8000-00000000000d";

function store(over: Partial<Record<string, any[]>> = {}): Record<string, any[]> {
  return {
    feature_flags: [],
    blocks: [],
    profiles: [{ id: A, handle: "a" }, { id: B, handle: "b" }],
    message_threads: [{
      id: DM, thread_type: "direct", trip_id: null, circle_owner_id: null, title: null,
      status: "active", is_e2ee: false, created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z", last_message_at: null,
    }],
    message_thread_members: [
      { thread_id: DM, user_id: A, role: "member", joined_at: "2026-01-01T00:00:00.000Z", left_at: null,
        last_read_at: null, muted_at: null, archived_at: null, visible_from_at: null },
      { thread_id: DM, user_id: B, role: "member", joined_at: "2026-01-01T00:00:00.000Z", left_at: null,
        last_read_at: null, muted_at: null, archived_at: null, visible_from_at: null },
    ],
    messages: [],
    message_translations: [],
    ...over,
  };
}

/** The app under test: the real middleware in front of the real messaging router. */
let server: Server;
let base = "";

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = { error() {}, warn() {}, info() {}, debug() {} }; next(); });
  app.use(telegraphObservability());
  app.use("/api", messagingRouter);
  app.use("/api", telegraphDiagnosticsRouter);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});
after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(() => {
  _resetTelegraphMetrics();
  _resetTelegraphDuplicateWindow();
});

function reading(metric: string) {
  const r = telegraphSloSnapshot().find((x) => x.metric === metric);
  assert.ok(r, `no reading for ${metric}`);
  return r!;
}

function use(s: Record<string, any[]>, opts?: Parameters<typeof makeFakeClient>[1]): FakeClient {
  const c = makeFakeClient(s, opts);
  _setTestClient(c, true);
  return c;
}

// ── The registry ──────────────────────────────────────────────────────────────

describe("§28 / §30A.17 registry — shape", () => {
  it("declares the spec's nine §28 metrics and eight §30A.17 SLOs, with unique keys", () => {
    assert.equal(TELEGRAPH_SLOS.filter((s) => s.specSection === "28").length, 9);
    assert.equal(TELEGRAPH_SLOS.filter((s) => s.specSection === "30A.17").length, 8);
    const keys = TELEGRAPH_SLOS.map((s) => s.metric);
    assert.equal(new Set(keys).size, keys.length, "two targets must never share one counter");
  });

  it("safety and privacy carry the strictest targets — an ordering, not a label", () => {
    const strictest = Math.min(
      ...TELEGRAPH_SLOS.filter((s) => s.severity === "safety" || s.severity === "privacy")
        .map((s) => (s.target.kind === "latency" ? s.target.maxMs : Number.POSITIVE_INFINITY)),
    );
    for (const s of TELEGRAPH_SLOS) {
      if (s.severity === "safety" || s.severity === "privacy") continue;
      if (s.target.kind !== "latency") continue;
      assert.ok(s.target.maxMs >= strictest,
        `${s.id} (${s.severity}) is tighter than the tightest safety/privacy budget`);
    }
  });

  it("an unbounded target carries the spec's own intent rather than an invented number", () => {
    for (const s of TELEGRAPH_SLOS) {
      if (s.target.kind !== "unbounded") continue;
      assert.ok(s.target.intent.length >= 10, `${s.id} has no stated intent`);
    }
  });

  it("a metric with no observation reads meetsTarget: null, never 'healthy'", () => {
    const r = reading("message_command_success");
    assert.equal(r.ok, 0);
    assert.equal(r.meetsTarget, null,
      "a system nobody is using must not report as meeting its availability target");
  });
});

// ── The recorder's privacy property ──────────────────────────────────────────

describe("the recorder cannot carry content", () => {
  it("ignores an undeclared metric key rather than accumulating it under a catch-all", () => {
    recordTelegraphMetric("not_a_declared_metric", "violation");
    const found = telegraphSloSnapshot().find((r) => r.metric === "not_a_declared_metric");
    assert.equal(found, undefined);
  });

  it("records only counts and a duration — the snapshot has no free-form field", () => {
    recordTelegraphMetric("message_command_success", "ok", 12);
    const r = reading("message_command_success");
    const serialised = JSON.stringify(r);
    assert.ok(serialised.includes('"ok":1'));
    // The shape is closed: id, metric, section, severity, status, target, three
    // counters, a percentile and a verdict. Nothing a body could travel in.
    assert.deepEqual(
      Object.keys(r).sort(),
      ["id", "meetsTarget", "metric", "ok", "p95Ms", "severity", "specSection", "status", "target", "unknown", "violations"],
    );
  });
});

// ── The middleware, against the real router ──────────────────────────────────

describe("SLO-01 / SLO-10 — command success and acceptance latency", () => {
  it("a successful send is counted as ok, with a latency sample", async () => {
    use(store());
    const r = await call(base, "POST", `/threads/${DM}/messages`, A, { body: "hello" });
    assert.equal(r.status, 201);
    const success = reading("message_command_success");
    assert.equal(success.ok, 1);
    assert.equal(success.violations, 0);
    assert.ok((reading("message_acceptance_latency_ms").p95Ms ?? -1) >= 0, "a duration was sampled");
  });

  it("A REFUSAL IS NOT AN AVAILABILITY FAILURE — a 403 is neither ok nor a violation", async () => {
    use(store({ blocks: [{ blocker_id: B, blocked_id: A }] }));
    const r = await call(base, "POST", `/threads/${DM}/messages`, A, { body: "hi" });
    assert.equal(r.status, 403);
    const success = reading("message_command_success");
    assert.equal(success.violations, 0,
      "counting a guard doing its job as an outage would make every hardening change look like one");
    assert.equal(success.ok, 0, "and it is not a success either");
    assert.equal(success.unknown, 1, "it is recorded, in its own column, so the denominator is honest");
  });

  it("a degraded_unavailable IS a violation — that is the event the target exists for", async () => {
    use(store({ blocks: [{ blocker_id: B, blocked_id: A }] }), {
      errors: { message_thread_members: { message: "roster down", afterOps: 1 } },
    });
    const r = await call(base, "POST", `/threads/${DM}/messages`, A, { body: "hi" });
    assert.equal(r.body.error, "degraded_unavailable");
    assert.equal(reading("message_command_success").violations, 1);
  });

  it("a non-Telegraph path is not classified and records nothing", async () => {
    use(store());
    await call(base, "GET", `/me/message-settings`, A);
    assert.equal(reading("message_command_success").ok, 0);
    assert.equal(reading("message_command_success").unknown, 0);
  });
});

describe("SLO-02 — duplicate canonical messages", () => {
  it("the same clientId accepted twice is counted as a violation of the zero target", async () => {
    use(store());
    const payload = { body: "did that send?", clientId: "offline-retry-7" };
    await call(base, "POST", `/threads/${DM}/messages`, A, payload);
    await call(base, "POST", `/threads/${DM}/messages`, A, payload);
    const dup = reading("duplicate_canonical_messages");
    assert.equal(dup.violations, 1, "the second acceptance is the duplicate");
    assert.equal(dup.ok, 1, "the first is not");
    assert.equal(dup.meetsTarget, false, "and the zero target is breached, visibly");
  });

  it("two REFUSED retries are not duplicates — nothing was written either time", async () => {
    use(store({ blocks: [{ blocker_id: B, blocked_id: A }] }));
    const payload = { body: "hi", clientId: "refused-retry" };
    await call(base, "POST", `/threads/${DM}/messages`, A, payload);
    await call(base, "POST", `/threads/${DM}/messages`, A, payload);
    assert.equal(reading("duplicate_canonical_messages").violations, 0);
  });

  it("distinct clientIds are not duplicates", async () => {
    use(store());
    await call(base, "POST", `/threads/${DM}/messages`, A, { body: "a", clientId: "c1" });
    await call(base, "POST", `/threads/${DM}/messages`, A, { body: "b", clientId: "c2" });
    assert.equal(reading("duplicate_canonical_messages").violations, 0);
    assert.equal(reading("duplicate_canonical_messages").ok, 2);
  });
});

describe("SLO-06 / SLO-17 — projection build latency", () => {
  it("a thread read samples both projection metrics", async () => {
    use(store());
    const r = await call(base, "GET", `/threads/${DM}/messages`, A);
    assert.equal(r.status, 200);
    assert.ok((reading("projection_lag_ms").p95Ms ?? -1) >= 0);
    assert.ok((reading("projection_freshness_ms").p95Ms ?? -1) >= 0);
  });
});

// ── The block guard emitter ──────────────────────────────────────────────────

describe("SLO-05 / SLO-14 — block enforcement", () => {
  it("a completed evaluation is ok for both metrics, whichever way it answers", async () => {
    const c = makeFakeClient({ blocks: [{ blocker_id: A, blocked_id: B }] });
    assert.equal(await isBlockedBetween(c as any, A, B), true);
    assert.equal(await isBlockedBetween(c as any, A, "cccccccc-0000-4000-8000-000000000003"), false);
    assert.equal(reading("blocked_direct_deliveries").ok, 2,
      "a refusal IS zero deliveries — the target is not breached by the guard working");
    assert.equal(reading("blocked_direct_deliveries").violations, 0);
    assert.equal(reading("block_enforcement_failures").violations, 0);
  });

  it("AN UNREADABLE BLOCKS TABLE IS AN ENFORCEMENT FAILURE, even though it denied", async () => {
    const c = makeFakeClient({ blocks: [] }, { errors: { blocks: { message: "down" } } });
    assert.equal(await isBlockedBetween(c as any, A, B), true, "it still fails closed");
    assert.equal(reading("block_enforcement_failures").violations, 1,
      "the denial was made without knowledge, which is the rate a leak would start as");
    assert.equal(reading("block_enforcement_failures").meetsTarget, false);
    assert.equal(reading("blocked_direct_deliveries").unknown, 1,
      "and it is 'unknown', not a delivery — nothing was delivered");
  });
});

// ── SLO-07 folds the bus's own counters ──────────────────────────────────────

describe("SLO-07 — realtime loss is folded from the bus, not re-counted", () => {
  it("emitter stats become the realtime reading", () => {
    const snapshot = telegraphSloSnapshot({
      delivered: 40,
      subscriberErrors: 2,
      broadcastErrors: 1,
      terminateBroadcastErrors: 0,
      eventsDroppedUnresolvedAudience: 3,
    });
    const r = snapshot.find((x) => x.metric === "realtime_delivery_loss")!;
    assert.equal(r.ok, 40);
    assert.equal(r.violations, 6, "2 subscriber + 1 broadcast + 0 terminate + 3 dropped audiences");
    assert.equal(r.meetsTarget, false);
  });
});

// ── The diagnostics surface ──────────────────────────────────────────────────

describe("§30A.17 — internal support tooling", () => {
  function adminStore(role: string): Record<string, any[]> {
    return { ...store(), profiles: [{ id: A, handle: "a", role }, { id: B, handle: "b", role: "user" }] };
  }

  it("a non-admin is refused", async () => {
    use(adminStore("user"));
    const r = await fetch(`${base}/telegraph/diagnostics`, {
      headers: { authorization: `Bearer ${A}`, "x-admin-access-reason": "investigating a realtime report" },
    });
    assert.ok(r.status === 403 || r.status === 401);
  });

  it("an admin with NO stated purpose is refused — purpose-scoped means scoped", async () => {
    use(adminStore("admin"));
    const r = await fetch(`${base}/telegraph/diagnostics`, { headers: { authorization: `Bearer ${A}` } });
    assert.equal(r.status, 400);
    const body = (await r.json()) as { message: string };
    assert.match(body.message, /X-Admin-Access-Reason/);
  });

  it("an admin with a TOO-SHORT purpose is refused — a field that accepts 'x' is not a scope", async () => {
    use(adminStore("admin"));
    const r = await fetch(`${base}/telegraph/diagnostics`, {
      headers: { authorization: `Bearer ${A}`, "x-admin-access-reason": "debug" },
    });
    assert.equal(r.status, 400);
  });

  it("an admin with a stated purpose is served every SLO and every projection", async () => {
    use(adminStore("admin"));
    const r = await fetch(`${base}/telegraph/diagnostics`, {
      headers: { authorization: `Bearer ${A}`, "x-admin-access-reason": "investigating a realtime delivery report" },
    });
    assert.equal(r.status, 200);
    const body = (await r.json()) as {
      slos: unknown[];
      projections: unknown[];
      realtimeEmitter: unknown;
      processUptimeMs: number;
      counterScope: string;
    };
    assert.equal(body.slos.length, TELEGRAPH_SLOS.length);
    assert.equal(body.projections.length, TELEGRAPH_PROJECTIONS.length);
    assert.ok(body.realtimeEmitter, "the bus counters nothing else could reach");
    assert.ok(typeof body.processUptimeMs === "number",
      "so a reader can tell a quiet hour from a restart");
    assert.match(body.counterScope, /in-process/,
      "and the surface says what its own numbers are worth");
  });

  it("the payload carries no conversation id, no user id and no message body", async () => {
    const c = use(adminStore("admin"));
    c._store.messages.push({
      id: "11111111-0000-4000-8000-000000000001", thread_id: DM, sender_id: A,
      body: "a private sentence", created_at: "2026-01-01T00:00:00.000Z", deleted_at: null,
      edited_at: null, original_language: null, msg_type: "text", subtype: null,
      media_url: null, media_type: null, media_thumbnail_url: null,
      media_duration_seconds: null, reply_to_id: null,
    });
    const r = await fetch(`${base}/telegraph/diagnostics`, {
      headers: { authorization: `Bearer ${A}`, "x-admin-access-reason": "checking projection freshness" },
    });
    const text = await r.text();
    assert.equal(text.includes("a private sentence"), false);
    assert.equal(text.includes(DM), false, "no conversation id");
    assert.equal(text.includes(A), false, "no user id");
  });
});
