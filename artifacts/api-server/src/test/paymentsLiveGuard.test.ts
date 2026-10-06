/**
 * Sandbox-only guard for every real payment / identity provider call.
 *
 * Owner requirement (2026-09-29): payment and identity flows must be testable
 * end to end with SANDBOX credentials, and no real charge, payout or billable
 * live provider call may ever execute in the testing environment.
 *
 * What this file pins, each against the real module (only `fetch` is stubbed):
 *   A. a live or unrecognised key makes ZERO fetch calls on every provider path
 *      (Stripe create / status / redact, Persona create / status / redact), and a
 *      test key proceeds; PAYMENTS_ALLOW_LIVE === "true" is the only override.
 *   B. provider erasure with a refused key records a clear RETRIABLE failure
 *      naming the refs, never a silent success, and makes no fetch.
 *   C. a signed Stripe webhook with `livemode: true` is refused (and nothing is
 *      written) unless live is allowed; signature is still verified first.
 *   D. readiness reports "not operational: live key not allowed".
 *   E. POST /api/verification/session answers 503 with a stable reason code on
 *      a refused key, before any provider call and before the rate limit.
 *   F. GET /api/verification/status refreshes a pending session from the
 *      provider (guarded by the same mode check, bounded per user).
 *   G. the unsigned mock provider cannot run in a hosted deployment, and its
 *      unsigned webhook needs an explicit IDENTITY_PROVIDER=mock.
 *   H. the default return URL uses the app's real scheme (travelbuddy://).
 *
 * The keys below are dummy strings with the documented prefixes; no real key
 * exists anywhere in this file.
 *
 * Run: node --import tsx/esm --test src/test/paymentsLiveGuard.test.ts
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import express from "express";

import { _setTestClient, _clearTestClient } from "../lib/http.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import verificationRouter, { webhookHandler, webhookRawParser } from "../routes/verification.js";
import { getIdentityProvider } from "../services/identityVerification/providers.js";
import { identityProviderStatus } from "../services/identityVerification/readiness.js";
import { requestProviderDeletionForUser } from "../services/identityVerification/providerErasure.js";

const ALICE_ID = "aaaaaaaa-0000-0000-0000-00000000p001";

// Dummy keys (documented prefixes, meaningless bodies).
const STRIPE_TEST = "sk_test_dummyDUMMYdummy";
const STRIPE_RESTRICTED_TEST = "rk_test_dummyDUMMYdummy";
const STRIPE_LIVE = "sk_live_dummyDUMMYdummy";
const STRIPE_RESTRICTED_LIVE = "rk_live_dummyDUMMYdummy";
const STRIPE_UNKNOWN = "pk_test_dummyDUMMYdummy"; // a publishable key is not a secret key
const PERSONA_SANDBOX = "persona_sandbox_dummyDUMMY";
const PERSONA_PRODUCTION = "persona_production_dummyDUMMY";
const WEBHOOK_SECRET = "whsec_test_p4y_guard_0001";

// ── env isolation ────────────────────────────────────────────────────────────

const ENV_KEYS = [
  "IDENTITY_PROVIDER",
  "STRIPE_IDENTITY_SECRET_KEY",
  "PERSONA_API_KEY",
  "PERSONA_TEMPLATE_ID",
  "PAYMENTS_ALLOW_LIVE",
  "IDENTITY_WEBHOOK_SECRET",
  "NODE_ENV",
  "REPLIT_DEPLOYMENT",
  "APP_RETURN_BASE_URL",
  "NODE_TEST_CONTEXT",
] as const;
const savedEnv: Record<string, string | undefined> = {};

function resetEnv(): void {
  for (const k of ENV_KEYS) {
    if (k === "NODE_TEST_CONTEXT") {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
      continue;
    }
    delete process.env[k];
  }
}

// ── fetch stub ───────────────────────────────────────────────────────────────

interface FetchCall { url: string; method: string; body: string }
const originalFetch = globalThis.fetch;
let fetchCalls: FetchCall[] = [];
let fetchResponder: (url: string, method: string) => { status: number; json: unknown } = () => ({
  status: 200,
  json: {},
});

function installFetchStub(): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    fetchCalls.push({ url, method, body: typeof init?.body === "string" ? init.body : "" });
    const r = fetchResponder(url, method);
    return new Response(JSON.stringify(r.json), {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
}

before(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  installFetchStub();
});

after(() => {
  globalThis.fetch = originalFetch;
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  _clearTestClient();
});

beforeEach(() => {
  resetEnv();
  fetchCalls = [];
  fetchResponder = (url, method) => {
    if (url.includes("api.stripe.com") && method === "POST" && url.endsWith("/verification_sessions")) {
      return { status: 200, json: { id: "vs_created_1", url: "https://verify.stripe.com/start/test_abc" } };
    }
    if (url.includes("api.stripe.com") && url.endsWith("/redact")) {
      return { status: 200, json: { id: "vs_x", status: "canceled" } };
    }
    if (url.includes("api.stripe.com")) {
      return { status: 200, json: { id: "vs_status_1", status: "processing" } };
    }
    if (url.includes("withpersona.com") && method === "POST" && url.endsWith("/inquiries")) {
      return { status: 200, json: { data: { id: "inq_new", attributes: { "one-time-link": "https://withpersona.com/verify?x" } } } };
    }
    if (url.includes("withpersona.com")) {
      return { status: 200, json: { data: { id: "inq_1", type: "inquiry", attributes: { status: "pending" } } } };
    }
    return { status: 404, json: {} };
  };
});

function useStripe(key: string): void {
  process.env["IDENTITY_PROVIDER"] = "stripe";
  process.env["STRIPE_IDENTITY_SECRET_KEY"] = key;
}

function usePersona(key: string): void {
  process.env["IDENTITY_PROVIDER"] = "persona";
  process.env["PERSONA_API_KEY"] = key;
  process.env["PERSONA_TEMPLATE_ID"] = "itmpl_dummy";
}

async function caught(fn: () => Promise<unknown>): Promise<any> {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  return undefined;
}

const REQ = { userId: ALICE_ID, level: "id" as const, returnUrl: "travelbuddy://profile/verification" };

// ─────────────────────────────────────────────────────────────────────────────
// A. every provider path
// ─────────────────────────────────────────────────────────────────────────────

describe("A. provider call sites refuse live and unrecognised keys BEFORE any fetch", () => {
  const PATHS: Array<[string, (p: ReturnType<typeof getIdentityProvider>) => Promise<unknown>]> = [
    ["createSession", (p) => p.createSession(REQ)],
    ["getSessionStatus", (p) => p.getSessionStatus("vs_or_inq_1")],
    ["requestProviderDeletion", (p) => p.requestProviderDeletion("vs_or_inq_1")],
  ];

  for (const [key, label] of [
    [STRIPE_LIVE, "sk_live_"],
    [STRIPE_RESTRICTED_LIVE, "rk_live_"],
    [STRIPE_UNKNOWN, "pk_test_ (unrecognised)"],
    ["garbage-key", "no prefix (unrecognised)"],
  ] as const) {
    for (const [name, call] of PATHS) {
      it(`stripe ${label}: ${name} throws the refusal and makes zero fetch calls`, async () => {
        useStripe(key);
        const err = await caught(() => call(getIdentityProvider()));
        assert.ok(err, "a refused key must throw");
        assert.equal(err.code, "payments_live_mode_refused", `expected the guard's refusal, got: ${err?.message}`);
        assert.equal(fetchCalls.length, 0, "no request may leave the process");
        assert.ok(!String(err.message).includes(key), "the refusal must never echo the key");
      });
    }
  }

  for (const [key, label] of [
    [PERSONA_PRODUCTION, "persona_production_"],
    ["pk_live_whatever", "unrecognised"],
  ] as const) {
    for (const [name, call] of PATHS) {
      it(`persona ${label}: ${name} throws the refusal and makes zero fetch calls`, async () => {
        usePersona(key);
        const err = await caught(() => call(getIdentityProvider()));
        assert.ok(err, "a refused key must throw");
        assert.equal(err.code, "payments_live_mode_refused", `expected the guard's refusal, got: ${err?.message}`);
        assert.equal(fetchCalls.length, 0);
        assert.ok(!String(err.message).includes(key));
      });
    }
  }

  for (const key of [STRIPE_TEST, STRIPE_RESTRICTED_TEST]) {
    it(`stripe ${key.slice(0, 8)}: every path proceeds to api.stripe.com`, async () => {
      useStripe(key);
      const p = getIdentityProvider();
      const s = await p.createSession(REQ);
      assert.equal(s.providerSessionId, "vs_created_1");
      await p.getSessionStatus("vs_status_1");
      await p.requestProviderDeletion("vs_status_1");
      assert.equal(fetchCalls.length, 3);
      assert.ok(fetchCalls.every((c) => c.url.startsWith("https://api.stripe.com/v1/identity/")));
    });
  }

  it("persona sandbox key: every path proceeds to withpersona.com", async () => {
    usePersona(PERSONA_SANDBOX);
    const p = getIdentityProvider();
    await p.createSession(REQ);
    await p.getSessionStatus("inq_1");
    await p.requestProviderDeletion("inq_1");
    assert.equal(fetchCalls.length, 3);
    assert.ok(fetchCalls.every((c) => c.url.startsWith("https://api.withpersona.com/api/v1/inquiries")));
  });

  it("a live key proceeds ONLY when PAYMENTS_ALLOW_LIVE is exactly \"true\"", async () => {
    useStripe(STRIPE_LIVE);
    for (const v of ["1", "TRUE", "yes", " true", ""]) {
      process.env["PAYMENTS_ALLOW_LIVE"] = v;
      const err = await caught(() => getIdentityProvider().getSessionStatus("vs_1"));
      assert.equal(err?.code, "payments_live_mode_refused", `PAYMENTS_ALLOW_LIVE=${JSON.stringify(v)} must not allow live`);
    }
    assert.equal(fetchCalls.length, 0);
    process.env["PAYMENTS_ALLOW_LIVE"] = "true";
    await getIdentityProvider().getSessionStatus("vs_1");
    assert.equal(fetchCalls.length, 1);
  });

  it("PAYMENTS_ALLOW_LIVE never rescues an UNRECOGNISED key", async () => {
    useStripe(STRIPE_UNKNOWN);
    process.env["PAYMENTS_ALLOW_LIVE"] = "true";
    const err = await caught(() => getIdentityProvider().createSession(REQ));
    assert.equal(err?.code, "payments_live_mode_refused");
    assert.equal(fetchCalls.length, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. provider erasure
// ─────────────────────────────────────────────────────────────────────────────

function erasureDb(refs: string[]) {
  const q: any = {
    select: () => q,
    eq: () => q,
    not: () => q,
    then: (resolve: (v: unknown) => void) =>
      resolve({ data: refs.map((r, i) => ({ id: `row-${i}`, provider_verification_ref: r })), error: null }),
  };
  return { from: () => q } as any;
}

describe("B. provider erasure (account deletion) under the guard", () => {
  it("a refused live key: RETRIABLE failure naming every ref, zero fetch", async () => {
    useStripe(STRIPE_LIVE);
    const err = await caught(() => requestProviderDeletionForUser(erasureDb(["vs_a", "vs_b"]), ALICE_ID));
    assert.ok(err, "erasure must not silently succeed");
    assert.equal(fetchCalls.length, 0);
    assert.match(err.message, /RETRIABLE/);
    assert.match(err.message, /live key not allowed/);
    assert.match(err.message, /vs_a/);
    assert.match(err.message, /vs_b/);
    assert.equal(err.retriable, true);
    assert.ok(!String(err.message).includes(STRIPE_LIVE));
  });

  it("a live key that is EXPLICITLY allowed still redacts the live session", async () => {
    useStripe(STRIPE_LIVE);
    process.env["PAYMENTS_ALLOW_LIVE"] = "true";
    const r = await requestProviderDeletionForUser(erasureDb(["vs_live_1"]), ALICE_ID);
    assert.equal(r.requested, 1);
    assert.equal(fetchCalls.length, 1);
    assert.ok(fetchCalls[0]!.url.endsWith("/identity/verification_sessions/vs_live_1/redact"));
  });

  it("a test key redacts normally", async () => {
    useStripe(STRIPE_TEST);
    const r = await requestProviderDeletionForUser(erasureDb(["vs_t"]), ALICE_ID);
    assert.equal(r.requested, 1);
    assert.equal(fetchCalls.length, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Route harness
// ─────────────────────────────────────────────────────────────────────────────

interface Db { identity_verifications: any[]; profiles: any[]; [t: string]: any[] }

function makeClient(db: Db, log: { updates: Array<{ table: string; patch: any }> }) {
  function builder(table: string) {
    const filters: Array<[string, any]> = [];
    let insertData: any = null;
    let updatePatch: any = null;
    let single = false;
    let maybe = false;
    const q: any = {
      select: () => q,
      insert: (d: any) => { insertData = Array.isArray(d) ? d[0] : d; return q; },
      update: (p: any) => { updatePatch = p; return q; },
      eq: (c: string, v: any) => { filters.push([c, v]); return q; },
      in: (c: string, v: any[]) => { filters.push([`${c}__in`, v]); return q; },
      not: () => q,
      order: () => q,
      limit: () => q,
      single: () => { single = true; return q; },
      maybeSingle: () => { maybe = true; return q; },
      then(resolve: (v: unknown) => void) {
        const rows = db[table] ?? (db[table] = []);
        const match = (r: any) =>
          filters.every(([k, v]) => (k.endsWith("__in") ? (v as any[]).includes(r[k.slice(0, -4)]) : r[k] === v));
        if (insertData) {
          const saved = { id: `row-${rows.length + 1}`, created_at: new Date().toISOString(), ...insertData };
          rows.push(saved);
          return resolve({ data: single || maybe ? saved : [saved], error: null });
        }
        if (updatePatch) {
          log.updates.push({ table, patch: updatePatch });
          for (let i = 0; i < rows.length; i++) if (match(rows[i])) rows[i] = { ...rows[i], ...updatePatch };
          return resolve({ data: null, error: null });
        }
        const found = rows.filter(match);
        if (single) return resolve(found.length ? { data: found[0], error: null } : { data: null, error: { message: "no rows" } });
        if (maybe) return resolve({ data: found[0] ?? null, error: null });
        return resolve({ data: found, error: null });
      },
    };
    return q;
  }
  return {
    auth: { getUser: () => Promise.resolve({ data: { user: { id: ALICE_ID } }, error: null }) },
    from: (t: string) => builder(t),
  };
}

function freshDb(rows: any[] = []): Db {
  return {
    identity_verifications: rows,
    profiles: [{ id: ALICE_ID, verification_level: "none", verified_at: null }],
    trust_events: [],
    feature_flags: [],
  };
}

function pendingRow(provider: string, sessionId: string, status = "processing") {
  const now = new Date().toISOString();
  return {
    id: "row-p1", user_id: ALICE_ID, provider, provider_session_id: sessionId, status,
    failure_reason: null, is_over_18: null, selfie_match: null, document_country: null,
    verified_at: null, expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    created_at: now, updated_at: now,
  };
}

let server: http.Server;

function request(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
  raw?: string,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const payload = raw ?? (body !== undefined ? JSON.stringify(body) : undefined);
    const hdrs: Record<string, string> = { "content-type": "application/json", ...headers };
    if (payload) hdrs["content-length"] = String(Buffer.byteLength(payload));
    const r = http.request({ hostname: "127.0.0.1", port: addr.port, path, method, headers: hdrs }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        let parsed: any;
        try { parsed = JSON.parse(data); } catch { parsed = data; }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

const AUTH = { authorization: "Bearer test-token" };

describe("route-level guards", () => {
  before(async () => {
    const app = express();
    app.use((req: any, _res, next) => {
      req.log = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };
      next();
    });
    app.post("/api/verification/webhook", webhookRawParser, webhookHandler as any);
    app.use(express.json());
    app.use("/api", verificationRouter);
    server = http.createServer(app);
    await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  });

  after(async () => {
    await new Promise<void>((res) => server.close(() => res()));
  });

  beforeEach(() => {
    _resetRateLimit();
  });

  afterEach(() => {
    _clearTestClient();
  });

  // ── C. webhooks ───────────────────────────────────────────────────────────

  describe("C. Stripe webhook livemode", () => {
    function signedEvent(livemode: boolean | undefined, sessionId: string) {
      const envelope: Record<string, unknown> = {
        id: "evt_1",
        type: "identity.verification_session.verified",
        data: { object: { id: sessionId, status: "verified", verified_outputs: { dob: { day: 1, month: 1, year: 1990 } } } },
      };
      if (livemode !== undefined) envelope["livemode"] = livemode;
      const raw = JSON.stringify(envelope);
      const t = Math.floor(Date.now() / 1000);
      const mac = crypto.createHmac("sha256", WEBHOOK_SECRET).update(`${t}.${raw}`, "utf8").digest("hex");
      return { raw, header: `t=${t},v1=${mac}` };
    }

    function setup(sessionId: string) {
      useStripe(STRIPE_TEST);
      process.env["IDENTITY_WEBHOOK_SECRET"] = WEBHOOK_SECRET;
      const db = freshDb([pendingRow("stripe", sessionId)]);
      const log = { updates: [] as Array<{ table: string; patch: any }> };
      _setTestClient(makeClient(db, log) as any, true);
      return { db, log };
    }

    it("refuses a correctly signed livemode:true event and writes nothing", async () => {
      const { db, log } = setup("vs_live_evt");
      const { raw, header } = signedEvent(true, "vs_live_evt");
      const res = await request("POST", "/api/verification/webhook", undefined, { "stripe-signature": header }, raw);
      assert.equal(res.status, 400);
      assert.equal(res.body?.error, "livemode_not_allowed");
      assert.equal(log.updates.length, 0, "a refused live event must not be persisted");
      assert.equal(db.identity_verifications[0].status, "processing");
    });

    it("still checks the signature first: an unsigned livemode event is invalid_signature", async () => {
      setup("vs_live_evt2");
      const { raw } = signedEvent(true, "vs_live_evt2");
      const res = await request("POST", "/api/verification/webhook", undefined, { "stripe-signature": "t=1,v1=00" }, raw);
      assert.equal(res.status, 400);
      assert.equal(res.body?.error, "invalid_signature");
    });

    it("accepts livemode:false (a test-mode event)", async () => {
      const { db } = setup("vs_test_evt");
      const { raw, header } = signedEvent(false, "vs_test_evt");
      const res = await request("POST", "/api/verification/webhook", undefined, { "stripe-signature": header }, raw);
      assert.equal(res.status, 200);
      assert.equal(db.identity_verifications[0].status, "verified");
    });

    it("accepts livemode:true only when PAYMENTS_ALLOW_LIVE is \"true\"", async () => {
      const { db } = setup("vs_live_ok");
      process.env["PAYMENTS_ALLOW_LIVE"] = "true";
      const { raw, header } = signedEvent(true, "vs_live_ok");
      const res = await request("POST", "/api/verification/webhook", undefined, { "stripe-signature": header }, raw);
      assert.equal(res.status, 200);
      assert.equal(db.identity_verifications[0].status, "verified");
    });
  });

  // ── E. POST /verification/session ─────────────────────────────────────────

  describe("E. POST /api/verification/session goes through the mode check", () => {
    for (const [key, reason] of [
      [STRIPE_LIVE, "payments_live_key_refused"],
      [STRIPE_UNKNOWN, "payments_unknown_key_refused"],
    ] as const) {
      it(`${reason}: 503 with a stable reason code, zero fetch, rate limit untouched`, async () => {
        useStripe(key);
        const db = freshDb();
        _setTestClient(makeClient(db, { updates: [] }) as any, true);
        for (let i = 0; i < 4; i++) {
          const res = await request("POST", "/api/verification/session", { level: "id" }, AUTH);
          assert.equal(res.status, 503, JSON.stringify(res.body));
          assert.equal(res.body.error, "server_not_configured");
          assert.equal(res.body.reason, reason);
          assert.ok(!JSON.stringify(res.body).includes(key));
        }
        assert.equal(fetchCalls.length, 0);
        assert.equal(db.identity_verifications.length, 0);
      });
    }

    it("persona production key: 503 payments_live_key_refused", async () => {
      usePersona(PERSONA_PRODUCTION);
      _setTestClient(makeClient(freshDb(), { updates: [] }) as any, true);
      const res = await request("POST", "/api/verification/session", { level: "id" }, AUTH);
      assert.equal(res.status, 503);
      assert.equal(res.body.reason, "payments_live_key_refused");
      assert.equal(fetchCalls.length, 0);
    });

    it("a test key creates a Stripe session with the app's real return URL", async () => {
      useStripe(STRIPE_TEST);
      const db = freshDb();
      _setTestClient(makeClient(db, { updates: [] }) as any, true);
      const res = await request("POST", "/api/verification/session", { level: "id" }, AUTH);
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.redirectUrl, "https://verify.stripe.com/start/test_abc");
      assert.equal(fetchCalls.length, 1);
      const form = new URLSearchParams(fetchCalls[0]!.body);
      assert.equal(form.get("return_url"), "travelbuddy://profile/verification");
    });
  });

  // ── F. GET /verification/status refresh ───────────────────────────────────

  describe("F. GET /api/verification/status refreshes a pending session", () => {
    it("a pending Stripe session that the provider reports verified completes without a webhook", async () => {
      useStripe(STRIPE_TEST);
      fetchResponder = () => ({
        status: 200,
        json: { id: "vs_pend", status: "verified", verified_outputs: { dob: { day: 2, month: 3, year: 1991 }, address: { country: "ph" } } },
      });
      const db = freshDb([pendingRow("stripe", "vs_pend")]);
      _setTestClient(makeClient(db, { updates: [] }) as any, true);
      const res = await request("GET", "/api/verification/status", undefined, AUTH);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(fetchCalls.length, 1);
      assert.equal(fetchCalls[0]!.method, "GET");
      assert.ok(fetchCalls[0]!.url.endsWith("/identity/verification_sessions/vs_pend"));
      assert.equal(res.body.verificationRow.status, "verified");
      assert.equal(res.body.verificationRow.is_over_18, true);
      assert.equal(res.body.verificationLevel, "id_verified");
      assert.equal(db.profiles[0].verification_level, "id_verified");
    });

    it("is bounded: a second poll inside the window does not call the provider again", async () => {
      useStripe(STRIPE_TEST);
      const db = freshDb([pendingRow("stripe", "vs_slow")]);
      fetchResponder = () => ({ status: 200, json: { id: "vs_slow", status: "processing" } });
      _setTestClient(makeClient(db, { updates: [] }) as any, true);
      await request("GET", "/api/verification/status", undefined, AUTH);
      await request("GET", "/api/verification/status", undefined, AUTH);
      await request("GET", "/api/verification/status", undefined, AUTH);
      assert.equal(fetchCalls.length, 1);
    });

    it("a refused (live) key never reaches the provider and the stored row is returned", async () => {
      useStripe(STRIPE_LIVE);
      const db = freshDb([pendingRow("stripe", "vs_pend2")]);
      _setTestClient(makeClient(db, { updates: [] }) as any, true);
      const res = await request("GET", "/api/verification/status", undefined, AUTH);
      assert.equal(res.status, 200);
      assert.equal(fetchCalls.length, 0);
      assert.equal(res.body.verificationRow.status, "processing");
    });

    it("a provider error degrades to the stored row (200), never a 5xx", async () => {
      useStripe(STRIPE_TEST);
      fetchResponder = () => ({ status: 500, json: { error: { code: "api_error" } } });
      const db = freshDb([pendingRow("stripe", "vs_err")]);
      _setTestClient(makeClient(db, { updates: [] }) as any, true);
      const res = await request("GET", "/api/verification/status", undefined, AUTH);
      assert.equal(res.status, 200);
      assert.equal(fetchCalls.length, 1);
      assert.equal(res.body.verificationRow.status, "processing");
    });

    it("terminal rows and rows from another provider are not refreshed", async () => {
      useStripe(STRIPE_TEST);
      const done = { ...pendingRow("stripe", "vs_done"), status: "verified" };
      _setTestClient(makeClient(freshDb([done]), { updates: [] }) as any, true);
      await request("GET", "/api/verification/status", undefined, AUTH);
      _resetRateLimit();
      _setTestClient(makeClient(freshDb([pendingRow("mock", "mock_1")]), { updates: [] }) as any, true);
      await request("GET", "/api/verification/status", undefined, AUTH);
      assert.equal(fetchCalls.length, 0);
    });
  });

  // ── G. unsigned mock webhook ──────────────────────────────────────────────

  describe("G. the unsigned mock webhook", () => {
    async function createMockSession(): Promise<string> {
      const db = freshDb();
      _setTestClient(makeClient(db, { updates: [] }) as any, true);
      const res = await request("POST", "/api/verification/session", { level: "id" }, AUTH);
      assert.ok(res.status === 201 || res.status === 200, JSON.stringify(res.body));
      return res.body.providerSessionId;
    }

    it("is refused when IDENTITY_PROVIDER is only DEFAULTED to mock", async () => {
      const sessionId = await createMockSession();
      const res = await request("POST", "/api/verification/webhook", { sessionId, outcome: "approve" });
      assert.equal(res.status, 400);
      assert.equal(res.body?.error, "mock_webhook_not_allowed");
    });

    it("is accepted when IDENTITY_PROVIDER=mock is explicit under the test runner", async () => {
      process.env["IDENTITY_PROVIDER"] = "mock";
      const sessionId = await createMockSession();
      const res = await request("POST", "/api/verification/webhook", { sessionId, outcome: "approve" });
      assert.equal(res.status, 200);
    });

    it("the mock provider is refused in a Replit deployment even without NODE_ENV", async () => {
      process.env["IDENTITY_PROVIDER"] = "mock";
      process.env["REPLIT_DEPLOYMENT"] = "1";
      assert.throws(() => getIdentityProvider(), /not allowed/);
      const res = await request("POST", "/api/verification/webhook", { sessionId: "mock_x", outcome: "approve" });
      assert.equal(res.status, 503);
      assert.equal(identityProviderStatus().operational, false);
    });

    it("the mock provider is refused with no local signal at all (bare `start`, no NODE_ENV)", () => {
      process.env["IDENTITY_PROVIDER"] = "mock";
      delete process.env["NODE_TEST_CONTEXT"];
      try {
        assert.throws(() => getIdentityProvider(), /not allowed/);
        assert.equal(identityProviderStatus().operational, false);
        process.env["NODE_ENV"] = "development";
        assert.throws(() => getIdentityProvider(), /not allowed/, "N-2: NODE_ENV=development is not the test runner");
      } finally {
        if (savedEnv["NODE_TEST_CONTEXT"] !== undefined) process.env["NODE_TEST_CONTEXT"] = savedEnv["NODE_TEST_CONTEXT"];
      }
    });

    it("N-2: a DEV HOST (pnpm dev, NODE_ENV=development, no test runner) gets no mock: no session, no webhook, readiness unavailable", async () => {
      process.env["IDENTITY_PROVIDER"] = "mock";
      process.env["NODE_ENV"] = "development";
      delete process.env["NODE_TEST_CONTEXT"];
      try {
        assert.throws(() => getIdentityProvider(), /not allowed/);
        const status = identityProviderStatus();
        assert.equal(status.operational, false, "readiness reports identity unavailable on a dev host");
        assert.match(status.reason, /test runner/);
        _setTestClient(makeClient(freshDb(), { updates: [] }) as any, true);
        const session = await request("POST", "/api/verification/session", { level: "id" }, AUTH);
        assert.equal(session.status, 503, `no mock session is created on a dev host: ${JSON.stringify(session.body)}`);
        const hook = await request("POST", "/api/verification/webhook", { sessionId: "mock_x", outcome: "approve" });
        assert.equal(hook.status, 503, "the unsigned mock webhook approves nothing on a dev host");
      } finally {
        if (savedEnv["NODE_TEST_CONTEXT"] !== undefined) process.env["NODE_TEST_CONTEXT"] = savedEnv["NODE_TEST_CONTEXT"];
      }
    });

    it("H. the mock redirect uses the app's scheme by default", async () => {
      process.env["IDENTITY_PROVIDER"] = "mock";
      _setTestClient(makeClient(freshDb(), { updates: [] }) as any, true);
      const res = await request("POST", "/api/verification/session", { level: "id" }, AUTH);
      assert.ok(String(res.body.redirectUrl).startsWith("travelbuddy://profile/verification?"), res.body.redirectUrl);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D. readiness
// ─────────────────────────────────────────────────────────────────────────────

describe("D. readiness reports a refused key", () => {
  for (const [env, label] of [
    [{ IDENTITY_PROVIDER: "stripe", STRIPE_IDENTITY_SECRET_KEY: STRIPE_LIVE }, "stripe live"],
    [{ IDENTITY_PROVIDER: "persona", PERSONA_API_KEY: PERSONA_PRODUCTION }, "persona production"],
  ] as const) {
    it(`${label}: not operational: live key not allowed`, () => {
      const s = identityProviderStatus(env as any);
      assert.equal(s.operational, false);
      assert.match(s.reason, /^not operational: live key not allowed/);
      assert.ok(!s.reason.includes(Object.values(env)[1] as string), "never the key");
    });
  }

  it("stripe unrecognised key: not operational, says unrecognised", () => {
    const s = identityProviderStatus({ IDENTITY_PROVIDER: "stripe", STRIPE_IDENTITY_SECRET_KEY: STRIPE_UNKNOWN } as any);
    assert.equal(s.operational, false);
    assert.match(s.reason, /^not operational: unrecognised key/);
  });

  it("a test key falls through to the existing certification reason", () => {
    const s = identityProviderStatus({ IDENTITY_PROVIDER: "stripe", STRIPE_IDENTITY_SECRET_KEY: STRIPE_TEST } as any);
    assert.equal(s.operational, false);
    assert.match(s.reason, /sandbox/);
    assert.doesNotMatch(s.reason, /live key/);
  });

  it("an allowed live key also falls through to the certification reason", () => {
    const s = identityProviderStatus({
      IDENTITY_PROVIDER: "stripe", STRIPE_IDENTITY_SECRET_KEY: STRIPE_LIVE, PAYMENTS_ALLOW_LIVE: "true",
    } as any);
    assert.doesNotMatch(s.reason, /live key not allowed/);
  });
});
