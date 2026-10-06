/**
 * census-telegraph T435 — §30A.17's support tooling is audited by a DURABLE row.
 *
 * The ceiling the census recorded: the audit of GET /api/telegraph/diagnostics
 * was a structured log line, because admin_access_log's record_type CHECK had no
 * value for it. Migration 3761 adds 'telegraph_diagnostics' behind
 * telegraph_diagnostics_durable_audit_enabled (seeded FALSE). This suite drives
 * the real route through the real requireAdmin:
 *
 *   - flag ON: one admin_access_log row per served read — the admin, the stated
 *     purpose, record_type 'telegraph_diagnostics', record_id 'snapshot', no
 *     private content — written BEFORE anything is served;
 *   - flag ON and the row cannot be written: the read is REFUSED (503), the
 *     payload never leaves the server;
 *   - flag OFF (the seed): served with the log line only, no row, exactly as
 *     before 3761 — a database without the value is never asked to store it;
 *   - the purpose gate still runs first: no purpose, no row and no read.
 *   - (verifier finding 2, 2026-10-05) the FLAG cannot be read: refused (503)
 *     whatever the audit table would have done — an unreadable stricter-path
 *     flag used to read as OFF and serve with no durable row.
 *
 * SHOWN RED (T2 lane report): the insert's error branch dropped turns the
 * refusal case red; the insert removed turns the row case red.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *        node --import tsx/esm --test src/test/telegraphDiagnosticsDurableAudit.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { _setTestClient } from "../lib/http.js";
import diagnosticsRouter, { DIAGNOSTICS_DURABLE_AUDIT_FLAG } from "../routes/telegraphDiagnostics.js";
import { makeFakeClient, startRouter, type FakeClient, type RouterHarness } from "./telegraphCertificationHarness.js";

const ADMIN = "aaaaaaaa-0000-4000-8000-0000000000ad";
const PURPOSE = "investigating a realtime delivery report";

function seed(flagOn: boolean): Record<string, Record<string, unknown>[]> {
  return {
    feature_flags: flagOn ? [{ flag: DIAGNOSTICS_DURABLE_AUDIT_FLAG, enabled: true }] : [],
    profiles: [{ id: ADMIN, handle: "ops", role: "admin" }],
    admin_access_log: [],
  };
}

let h: RouterHarness;
before(async () => { h = await startRouter(diagnosticsRouter); });
after(async () => { _setTestClient(null, false); await h.close(); });

function use(state: Record<string, Record<string, unknown>[]>, opts?: Parameters<typeof makeFakeClient>[1]): FakeClient {
  const c = makeFakeClient(state as Record<string, any[]>, opts);
  _setTestClient(c, true);
  return c;
}
const read = (purpose: string | null) =>
  fetch(`${h.base}/telegraph/diagnostics`, {
    headers: { authorization: `Bearer ${ADMIN}`, ...(purpose ? { "x-admin-access-reason": purpose } : {}) },
  });
const auditRows = (c: FakeClient) =>
  c._observed.inserts.filter((w) => w.table === "admin_access_log").flatMap((w) => w.rows);

describe("§30A.17 — the durable audit of the support tooling (T435)", () => {
  it("flag ON: one row per served read, naming the admin and the purpose and nothing private", async () => {
    const c = use(seed(true));
    const r = await read(PURPOSE);
    assert.equal(r.status, 200);
    const rows = auditRows(c);
    assert.equal(rows.length, 1);
    const row = rows[0] as Record<string, unknown>;
    assert.equal(row.admin_id, ADMIN);
    assert.equal(row.record_type, "telegraph_diagnostics");
    assert.equal(row.record_id, "snapshot");
    assert.equal(row.reason, PURPOSE);
    assert.equal(row.action_taken, "view");
  });

  it("flag ON and the row cannot be written: the read is REFUSED and nothing is served", async () => {
    use(seed(true), { errors: { admin_access_log: { message: "new row violates check constraint", code: "23514", ops: ["insert"] } } });
    const r = await read(PURPOSE);
    assert.equal(r.status, 503);
    const body = (await r.json()) as Record<string, unknown>;
    assert.equal(body.error, "degraded_unavailable");
    assert.equal("slos" in body, false, "diagnostics leaked past a failed audit");
  });

  it("flag OFF (the seed): served with the log line only — no row is asked of a database without 3761", async () => {
    const c = use(seed(false));
    const r = await read(PURPOSE);
    assert.equal(r.status, 200);
    assert.equal(auditRows(c).length, 0);
  });

  it("no stated purpose: refused before any row or read", async () => {
    const c = use(seed(true));
    const r = await read(null);
    assert.equal(r.status, 400);
    assert.equal(auditRows(c).length, 0);
  });
});

describe("verifier finding 2 — the durable-audit flag itself cannot be read", () => {
  const flagsDown = { message: "flags unreadable", code: "57014", ops: ["select" as const] };

  it("flag row ON, the flag read fails, the audit insert would fail too: REFUSED, nothing served, no row attempted", async () => {
    // The verifier's reproduction: before the fix this answered 200 with the
    // SLOs and made 0 audit inserts.
    const c = use(seed(true), { errors: {
      feature_flags: flagsDown,
      admin_access_log: { message: "audit table down", code: "57014", ops: ["insert"] },
    } });
    const r = await read(PURPOSE);
    assert.equal(r.status, 503);
    const body = (await r.json()) as Record<string, unknown>;
    assert.equal(body.error, "degraded_unavailable");
    assert.equal("slos" in body, false, "diagnostics served on an unreadable audit flag");
    assert.equal(auditRows(c).length, 0);
  });

  it("the flag read fails even where the row COULD be written: still refused — 'unknown' is not 'on' either", async () => {
    const c = use(seed(true), { errors: { feature_flags: flagsDown } });
    const r = await read(PURPOSE);
    assert.equal(r.status, 503);
    assert.equal(auditRows(c).length, 0);
  });
});
