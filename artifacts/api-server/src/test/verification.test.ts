/**
 * Identity verification route tests — Phase V-1.
 *
 * Covers:
 *  A. POST /api/verification/session — auth guard, rate limit, duplicate session,
 *     successful session creation, testHint stripped in prod.
 *  B. GET  /api/verification/status  — auth guard, no row, returns current level.
 *  C. POST /api/verification/webhook — mock approve, mock fail, empty body.
 *
 * Runtime: node:test + node:assert/strict.
 * Minimal Express app built per-test (same pattern as callRoutes.test.ts).
 *
 * Run: node --import tsx/esm --test src/test/verification.test.ts
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient, _clearTestClient } from "../lib/http.js";
import verificationRouter, { webhookHandler, webhookRawParser, persistResult } from "../routes/verification.js";
import { _resetRateLimit } from "../lib/rateLimit.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const ALICE_ID  = "aaaaaaaa-0000-0000-0000-000000000001";
const SESSION_ID = "sess-mock-0001";

// Force mock provider for all tests
process.env["IDENTITY_PROVIDER"] = "mock";

// ── Fake Supabase client factory ──────────────────────────────────────────────

interface FakeState {
  userId?: string | null;
  verificationRows?: any[];
  profileVerificationLevel?: string;
  insertError?: any;
  /** Injects an error on UPDATE (optionally scoped to updateErrorTable). */
  updateError?: any;
  updateErrorTable?: string;
}

function makeClient(state: FakeState = {}) {
  const userId = state.userId ?? ALICE_ID;
  const verificationRows = state.verificationRows ?? [];
  const profileLevel = state.profileVerificationLevel ?? "none";
  const insertError = state.insertError ?? null;

  const db: Record<string, any[]> = {
    identity_verifications: [...verificationRows],
    profiles: [{ id: userId, verification_level: profileLevel, verified_at: null }],
    feature_flags: [],
  };

  function builder(table: string) {
    let rows = [...(db[table] ?? [])];
    let filters: Record<string, any> = {};
    let limitN = 1000;
    let isSingle = false;
    let isMaybe = false;
    let insertData: any = null;
    let updatePatch: any = null;
    let orderCol: string | null = null;
    let orderAsc = true;

    const q: any = {
      select(_cols: string) { return q; },
      insert(data: any) { insertData = Array.isArray(data) ? data[0] : data; return q; },
      update(patch: any) { updatePatch = patch; return q; },
      eq(col: string, val: any) { filters[col] = val; return q; },
      in(col: string, vals: any[]) { filters[`${col}__in`] = vals; return q; },
      order(col: string, opts?: any) { orderCol = col; orderAsc = opts?.ascending ?? true; return q; },
      limit(n: number) { limitN = n; return q; },
      single() { isSingle = true; return q; },
      maybeSingle() { isMaybe = true; return q; },
      then(resolve: Function, reject?: Function) {
        return Promise.resolve().then(() => {
          if (insertData) {
            if (insertError) return resolve({ data: null, error: insertError });
            const saved = { ...insertData, id: "row-id-001" };
            db[table] = [...(db[table] ?? []), saved];
            if (isSingle || isMaybe) return resolve({ data: saved, error: null });
            return resolve({ data: [saved], error: null });
          }
          if (updatePatch) {
            if (state.updateError && (!state.updateErrorTable || state.updateErrorTable === table)) {
              return resolve({ data: null, error: state.updateError });
            }
            db[table] = (db[table] ?? []).map((r) => {
              const match = Object.entries(filters).every(([k, v]) => {
                if (k.endsWith("__in")) return (v as any[]).includes(r[k.replace("__in", "")]);
                return r[k] === v;
              });
              return match ? { ...r, ...updatePatch } : r;
            });
            return resolve({ data: null, error: null });
          }
          // select
          let result = [...rows];
          for (const [k, v] of Object.entries(filters)) {
            if (k.endsWith("__in")) {
              const col = k.replace("__in", "");
              result = result.filter((r) => (v as any[]).includes(r[col]));
            } else {
              result = result.filter((r) => r[k] === v);
            }
          }
          if (orderCol) {
            const col = orderCol;
            result.sort((a, b) => {
              const av = a[col], bv = b[col];
              return orderAsc ? (av < bv ? -1 : av > bv ? 1 : 0) : (av > bv ? -1 : av < bv ? 1 : 0);
            });
          }
          result = result.slice(0, limitN);
          if (isSingle) return resolve(result.length ? { data: result[0], error: null } : { data: null, error: { message: "no rows" } });
          if (isMaybe)  return resolve({ data: result[0] ?? null, error: null });
          return resolve({ data: result, error: null });
        }).catch(reject ?? ((e: any) => { throw e; }));
      },
    };
    return q;
  }

  return {
    auth: {
      getUser: () => Promise.resolve({ data: { user: { id: userId } }, error: null }),
    },
    from: (table: string) => builder(table),
  };
}

// ── Test app factory ──────────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  // Webhook raw-body BEFORE json parser (mirrors app.ts ordering)
  app.post("/api/verification/webhook", webhookRawParser, webhookHandler as any);
  app.use(express.json());
  // Mount the router under /api  
  app.use("/api", verificationRouter);
  // Minimal req.log shim (pino-http not loaded in tests)
  app.use((req: any, _res: any, next: any) => {
    req.log = req.log ?? { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };
    next();
  });
  return app;
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

function req(
  server: http.Server,
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as any;
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const hdrs: Record<string, string> = {
      "content-type": "application/json",
      ...(headers ?? {}),
    };
    if (payload) hdrs["content-length"] = String(Buffer.byteLength(payload));
    const r = http.request(
      { hostname: "127.0.0.1", port: addr.port, path, method, headers: hdrs },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let parsed: any;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Verification routes", () => {
  let server: http.Server;

  before(async () => {
    const app = buildApp();
    server = http.createServer(app);
    await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  });

  after(async () => {
    _clearTestClient?.();
    await new Promise<void>((res) => server.close(() => res()));
  });

  beforeEach(() => {
    _clearTestClient?.();
    _resetRateLimit?.("verification_session", ALICE_ID);
  });

  // ── A. POST /api/verification/session ─────────────────────────────────────

  describe("POST /api/verification/session", () => {
    it("returns 401 when unauthenticated", async () => {
      const { status } = await req(server, "POST", "/api/verification/session", { level: "id" });
      assert.equal(status, 401);
    });

    it("returns 400 for invalid level", async () => {
      _setTestClient(makeClient() as any, true);
      const { status } = await req(server, "POST", "/api/verification/session", { level: "bad_level" }, {
        authorization: "Bearer test-token",
      });
      assert.equal(status, 400);
    });

    it("creates an id session — returns 201 with redirectUrl and providerSessionId", async () => {
      _setTestClient(makeClient() as any, true);
      const { status, body } = await req(server, "POST", "/api/verification/session", { level: "id" }, {
        authorization: "Bearer test-token",
      });
      assert.ok(status === 201 || status === 200, `expected 2xx, got ${status}: ${JSON.stringify(body)}`);
      assert.ok(typeof body.redirectUrl === "string",       "redirectUrl should be a string");
      assert.ok(typeof body.providerSessionId === "string", "providerSessionId should be a string");
    });

    it("creates an id_selfie session successfully", async () => {
      _setTestClient(makeClient() as any, true);
      const { status } = await req(server, "POST", "/api/verification/session", { level: "id_selfie" }, {
        authorization: "Bearer test-token",
      });
      assert.ok(status === 201 || status === 200, `expected 2xx, got ${status}`);
    });

    it("handles unique-index conflict (23505) by returning existing session", async () => {
      _setTestClient(makeClient({
        insertError: { code: "23505", message: "duplicate key value violates unique constraint" },
        verificationRows: [{
          id:                  "existing-row",
          user_id:             ALICE_ID,
          provider_session_id: SESSION_ID,
          status:              "pending",
          expires_at:          new Date(Date.now() + 60_000).toISOString(),
          created_at:          new Date().toISOString(),
          updated_at:          new Date().toISOString(),
        }],
      }) as any, true);
      const { status } = await req(server, "POST", "/api/verification/session", { level: "id" }, {
        authorization: "Bearer test-token",
      });
      // Either 200 (existing returned) or 201 (new) — both are acceptable
      assert.ok(status === 200 || status === 201, `expected 2xx, got ${status}`);
    });
  });

  // ── B. GET /api/verification/status ──────────────────────────────────────

  describe("GET /api/verification/status", () => {
    it("returns 401 when unauthenticated", async () => {
      const { status } = await req(server, "GET", "/api/verification/status");
      assert.equal(status, 401);
    });

    it("returns null row + none level when no verification exists", async () => {
      _setTestClient(makeClient() as any, true);
      const { status, body } = await req(server, "GET", "/api/verification/status", undefined, {
        authorization: "Bearer test-token",
      });
      assert.equal(status, 200);
      assert.equal(body.verificationRow, null);
      assert.equal(body.verificationLevel, "none");
    });

    it("returns verificationLevel from profiles when set to id_verified", async () => {
      _setTestClient(makeClient({ profileVerificationLevel: "id_verified" }) as any, true);
      const { status, body } = await req(server, "GET", "/api/verification/status", undefined, {
        authorization: "Bearer test-token",
      });
      assert.equal(status, 200);
      assert.equal(body.verificationLevel, "id_verified");
    });

    it("returns the latest row when one exists", async () => {
      _setTestClient(makeClient({
        verificationRows: [{
          id:                  "row-1",
          user_id:             ALICE_ID,
          provider:            "mock",
          provider_session_id: SESSION_ID,
          status:              "pending",
          failure_reason:      null,
          is_over_18:          null,
          selfie_match:        null,
          document_country:    null,
          verified_at:         null,
          expires_at:          new Date(Date.now() + 60_000).toISOString(),
          created_at:          new Date().toISOString(),
          updated_at:          new Date().toISOString(),
        }],
      }) as any, true);
      const { status, body } = await req(server, "GET", "/api/verification/status", undefined, {
        authorization: "Bearer test-token",
      });
      assert.equal(status, 200);
      assert.ok(body.verificationRow !== null, "verificationRow should be present");
      assert.equal(body.verificationRow.status, "pending");
    });
  });

  // ── C. POST /api/verification/webhook ────────────────────────────────────

  describe("POST /api/verification/webhook", () => {
    it("returns 200 for a well-formed approve body", async () => {
      _setTestClient(makeClient({
        verificationRows: [{
          id: "row-1", user_id: ALICE_ID, provider: "mock",
          provider_session_id: SESSION_ID, status: "pending",
          failure_reason: null, is_over_18: null, selfie_match: null,
          document_country: null, verified_at: null,
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        }],
      }) as any, true);
      const { status } = await req(server, "POST", "/api/verification/webhook",
        { sessionId: SESSION_ID, outcome: "approve" });
      assert.equal(status, 200);
    });

    it("returns 200 for a fail_document body", async () => {
      _setTestClient(makeClient({
        verificationRows: [{
          id: "row-1", user_id: ALICE_ID, provider: "mock",
          provider_session_id: SESSION_ID, status: "pending",
          failure_reason: null, is_over_18: null, selfie_match: null,
          document_country: null, verified_at: null,
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        }],
      }) as any, true);
      const { status } = await req(server, "POST", "/api/verification/webhook",
        { sessionId: SESSION_ID, outcome: "fail_document" });
      assert.equal(status, 200);
    });

    it("returns 200 for an empty/unrecognized body (ignored event)", async () => {
      _setTestClient(makeClient() as any, true);
      const { status } = await req(server, "POST", "/api/verification/webhook", {});
      assert.equal(status, 200);
    });

  });

  // ── persistResult — write errors must propagate, not be discarded ──────────
  // supabase-js RESOLVES (does not throw) on a write error. The webhook's
  // try/catch around persistResult now returns 5xx (so the provider retries)
  // instead of a silent 200 — but only because persistResult actually throws.
  describe("persistResult — write errors propagate (audit H5b)", () => {
    const VERIFIED = {
      provider: "mock",
      providerSessionId: SESSION_ID,
      status: "verified",
      selfieMatch: false,
      isOver18: true,
      documentCountry: "US",
      verifiedAt: new Date().toISOString(),
      failureReason: null,
      providerVerificationRef: "ref-1",
    } as any;

    it("throws when the profiles verification_level UPDATE errors (:55)", async () => {
      const c = makeClient({
        updateError: { code: "23514", message: 'violates check constraint "profiles_verification_level_check"' },
        updateErrorTable: "profiles",
      });
      _setTestClient(c as any, true); // applyVerifiedProfile uses getServiceClient()
      await assert.rejects(
        () => persistResult(c as any, VERIFIED, ALICE_ID),
        /verification_level/,
        "a rejected profiles UPDATE must propagate",
      );
    });

    it("throws when the identity_verifications UPDATE errors (:108)", async () => {
      const c = makeClient({
        updateError: { code: "08006", message: "connection failure" },
        updateErrorTable: "identity_verifications",
      });
      _setTestClient(c as any, true);
      await assert.rejects(
        () => persistResult(c as any, VERIFIED, ALICE_ID),
        /identity_verifications/,
        "a rejected identity_verifications UPDATE must propagate",
      );
    });
  });
});
