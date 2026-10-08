/**
 * P-5 (lead ruling 2026-10-07): identity-verification session create / poll
 * refuses (503, no outbound call) unless the keyed provider is OPERATIONAL — a
 * sandbox key in production never contacts the provider.
 *
 * ── THE DEFECT THIS PINS ───────────────────────────────────────────────────
 * `readiness.IMPLEMENTED_PROVIDERS` gated only `identityProviderStatus()`, and
 * that was read by the BOOKING gate and nothing else. `routes/verification.ts`
 * selected the adapter with `getIdentityProvider()` (by IDENTITY_PROVIDER alone)
 * and its only guard was the key-MODE check, which admits a sandbox token. The
 * verifier's probe (2026-10-08): NODE_ENV=production, IDENTITY_PROVIDER=sumsub,
 * SUMSUB_APP_TOKEN=sbx:…, secret and level names set — readiness said "not
 * certified", yet POST /verification/session issued two outbound POSTs to
 * api.sumsub.com carrying the app token and the user's id. Stripe and Persona
 * (also uncertified) had the same door.
 *
 * ── WHAT THIS FILE MEASURES (only `fetch` is stubbed; the real router runs) ─
 *   1. An uncertified KEYED provider on an allowed (sandbox) key: session create
 *      answers 503 `verification_unavailable`, makes ZERO fetch calls, writes no
 *      row and spends none of the 3/24 h budget — in a production process and
 *      under the test runner alike, for sumsub, stripe and persona.
 *   2. The status poll leaves an uncertified provider alone: the stored row is
 *      returned and ZERO fetch calls are made.
 *   3. CONTROLS (the gate is the operational check, not a blanket refusal): the
 *      same sumsub sandbox configuration, certified through the test-runner-only
 *      seam, creates a session (two calls to api.sumsub.com, row recorded as a
 *      `test`-mode attempt) and the poll calls the provider once; the mock, which
 *      is not keyed, still creates sessions under the test runner.
 *   4. Error text that reaches the logs carries no user id: Sumsub's websdkLink
 *      query (`externalUserId=<uuid>`) is stripped from the adapter's message.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/verificationRequiresOperationalProvider.test.ts
 */
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import { _setTestClient, _clearTestClient } from "../lib/http.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import verificationRouter from "../routes/verification.js";
import {
  _certifyIdentityProvidersForTest,
  identityProviderStatus,
} from "../services/identityVerification/readiness.js";
import { pathForLogs, sumsubCreateSession } from "../services/identityVerification/sumsub.js";

const ALICE_ID = "aaaaaaaa-0000-4000-8000-0000000000p5";

// Dummy values with the documented prefixes; no real key exists in this file.
const SUMSUB_SANDBOX = "sbx:p5-not-a-real-token";
const STRIPE_TEST = "sk_test_p5DUMMYdummy";
const PERSONA_SANDBOX = "persona_sandbox_p5DUMMY";

// ── env isolation ────────────────────────────────────────────────────────────

const ENV_KEYS = [
  "IDENTITY_PROVIDER",
  "SUMSUB_APP_TOKEN",
  "SUMSUB_SECRET_KEY",
  "SUMSUB_LEVEL_NAME_ID",
  "SUMSUB_LEVEL_NAME_ID_SELFIE",
  "STRIPE_IDENTITY_SECRET_KEY",
  "PERSONA_API_KEY",
  "PERSONA_TEMPLATE_ID",
  "PAYMENTS_ALLOW_LIVE",
  "IDENTITY_WEBHOOK_SECRET",
  "NODE_ENV",
  "REPLIT_DEPLOYMENT",
  "APP_RETURN_BASE_URL",
] as const;
const savedEnv: Record<string, string | undefined> = {};

function clearEnv(): void {
  for (const k of ENV_KEYS) delete process.env[k];
}

/** The verifier's exact probe configuration: everything Sumsub needs, on a SANDBOX token. */
function useSumsubSandbox(): void {
  process.env["IDENTITY_PROVIDER"] = "sumsub";
  process.env["SUMSUB_APP_TOKEN"] = SUMSUB_SANDBOX;
  process.env["SUMSUB_SECRET_KEY"] = "p5-not-a-real-secret";
  process.env["SUMSUB_LEVEL_NAME_ID"] = "id-only";
  process.env["SUMSUB_LEVEL_NAME_ID_SELFIE"] = "id-and-liveness";
  process.env["IDENTITY_WEBHOOK_SECRET"] = "p5-not-a-real-webhook-secret";
}

// ── fetch stub: every outbound request is recorded, none leaves the process ──

interface FetchCall { url: string; method: string }
const originalFetch = globalThis.fetch;
let fetchCalls: FetchCall[] = [];
let failWebsdkLink = false;

function installFetchStub(): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    fetchCalls.push({ url, method });
    let status = 200;
    let json: unknown = {};
    if (url.includes("api.sumsub.com/resources/applicants?")) json = { id: "applicant_p5_1" };
    else if (url.includes("/websdkLink")) {
      if (failWebsdkLink) { status = 500; json = { code: 500, description: "echo of the request" }; }
      else json = { url: "https://in.sumsub.com/websdk/p/p5-link" };
    } else if (url.includes("api.sumsub.com/resources/applicants/")) json = { reviewStatus: "pending" };
    else if (url.includes("api.stripe.com")) json = { id: "vs_p5", url: "https://verify.stripe.com/start/p5" };
    else if (url.includes("withpersona.com")) json = { data: { id: "inq_p5", attributes: { "one-time-link": "https://withpersona.com/verify?p5" } } };
    else status = 404;
    return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
}

// ── fake service client (the shape routes/verification.ts reads and writes) ──

interface Db { identity_verifications: any[]; profiles: any[]; [t: string]: any[] }

function makeClient(db: Db) {
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
      gte: () => q,
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

function inFlightRow(provider: string, sessionId: string) {
  const now = new Date().toISOString();
  return {
    id: "row-inflight", user_id: ALICE_ID, provider, provider_session_id: sessionId, status: "processing",
    failure_reason: null, is_over_18: null, selfie_match: null, document_country: null,
    verified_at: null, expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    created_at: now, updated_at: now,
  };
}

// ── server ───────────────────────────────────────────────────────────────────

let server: http.Server;
const logged: Array<{ level: string; obj: unknown; msg: string }> = [];

function request(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const headers: Record<string, string> = { "content-type": "application/json", authorization: "Bearer test-token" };
    if (payload) headers["content-length"] = String(Buffer.byteLength(payload));
    const r = http.request({ hostname: "127.0.0.1", port: addr.port, path, method, headers }, (res) => {
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

before(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  installFetchStub();
  const app = express();
  app.use((req: any, _res, next) => {
    const rec = (level: string) => (obj: unknown, msg?: string) => logged.push({ level, obj, msg: String(msg ?? "") });
    req.log = { error: rec("error"), warn: rec("warn"), info: rec("info"), debug: rec("debug") };
    next();
  });
  app.use(express.json());
  app.use("/api", verificationRouter);
  server = http.createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
});

after(async () => {
  globalThis.fetch = originalFetch;
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  _certifyIdentityProvidersForTest(null);
  _clearTestClient();
  await new Promise<void>((res) => server.close(() => res()));
});

beforeEach(() => {
  clearEnv();
  fetchCalls = [];
  failWebsdkLink = false;
  logged.length = 0;
  _resetRateLimit();
  _certifyIdentityProvidersForTest(null);
});

afterEach(() => {
  _certifyIdentityProvidersForTest(null);
  _clearTestClient();
});

/** Four attempts: a refusal that spent the 3/24 h budget would answer the 4th with `rate_limited`. */
async function assertSessionRefusedWithoutContact(label: string, secretsThatMustNotLeak: string[]): Promise<void> {
  const db = freshDb();
  _setTestClient(makeClient(db) as any, true);
  for (let i = 0; i < 4; i++) {
    const res = await request("POST", "/api/verification/session", { level: "id_selfie" });
    assert.equal(res.status, 503, `${label} attempt ${i + 1}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, "verification_unavailable", label);
    const text = JSON.stringify(res.body);
    for (const s of secretsThatMustNotLeak) assert.equal(text.includes(s), false, `${label}: the response must not name ${s}`);
  }
  assert.equal(fetchCalls.length, 0, `${label}: no request may leave the process (got ${JSON.stringify(fetchCalls)})`);
  assert.equal(db.identity_verifications.length, 0, `${label}: a refused session writes no row`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Session creation refuses an uncertified keyed provider, before any contact
// ─────────────────────────────────────────────────────────────────────────────

describe("P-5 — POST /api/verification/session refuses a keyed provider readiness does not report operational", () => {
  it("the verifier's probe: Sumsub on a SANDBOX token in a PRODUCTION process — 503 verification_unavailable, zero calls to api.sumsub.com", async () => {
    useSumsubSandbox();
    process.env["NODE_ENV"] = "production";
    const status = identityProviderStatus();
    assert.equal(status.operational, false, "premise: sumsub is not certified");
    assert.match(status.reason, /not been certified/);
    await assertSessionRefusedWithoutContact("sumsub sbx / production", ["sumsub", "SUMSUB", SUMSUB_SANDBOX, "IMPLEMENTED_PROVIDERS"]);
  });

  it("the same refusal under the test runner: it is the readiness answer, not an environment check", async () => {
    useSumsubSandbox();
    await assertSessionRefusedWithoutContact("sumsub sbx / test runner", ["sumsub", SUMSUB_SANDBOX]);
  });

  it("Stripe on a TEST key and Persona on a SANDBOX key are uncertified too — the same 503, zero calls", async () => {
    process.env["IDENTITY_PROVIDER"] = "stripe";
    process.env["STRIPE_IDENTITY_SECRET_KEY"] = STRIPE_TEST;
    await assertSessionRefusedWithoutContact("stripe test key", ["stripe", STRIPE_TEST]);

    clearEnv();
    _resetRateLimit();
    process.env["IDENTITY_PROVIDER"] = "persona";
    process.env["PERSONA_API_KEY"] = PERSONA_SANDBOX;
    process.env["PERSONA_TEMPLATE_ID"] = "itmpl_p5";
    await assertSessionRefusedWithoutContact("persona sandbox key", ["persona", PERSONA_SANDBOX]);
  });

  it("a CERTIFIED provider whose key is not set is not operational either — 503, not a provider-side failure", async () => {
    useSumsubSandbox();
    delete process.env["SUMSUB_APP_TOKEN"];
    _certifyIdentityProvidersForTest(["mock", "sumsub"]);
    assert.equal(identityProviderStatus().operational, false, "premise: REQUIRED_ENV is missing");
    await assertSessionRefusedWithoutContact("certified sumsub, no token", ["SUMSUB_APP_TOKEN"]);
  });

  it("the refusal is logged server-side with the readiness reason, and never the key", async () => {
    useSumsubSandbox();
    _setTestClient(makeClient(freshDb()) as any, true);
    await request("POST", "/api/verification/session", { level: "id" });
    const warn = logged.find((l) => l.level === "warn" && /not operational \(P-5\)/.test(l.msg));
    assert.ok(warn, `expected the P-5 warning, got ${JSON.stringify(logged)}`);
    assert.equal(JSON.stringify(warn).includes(SUMSUB_SANDBOX), false, "the token never reaches a log");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The status poll never contacts an uncertified provider
// ─────────────────────────────────────────────────────────────────────────────

describe("P-5 — GET /api/verification/status does not poll a provider that is not operational", () => {
  it("an in-flight Sumsub row under an uncertified Sumsub: the stored row is returned, zero calls", async () => {
    useSumsubSandbox();
    process.env["NODE_ENV"] = "production";
    const db = freshDb([inFlightRow("sumsub", "applicant_inflight")]);
    _setTestClient(makeClient(db) as any, true);
    const res = await request("GET", "/api/verification/status");
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.verificationRow.status, "processing", "the person's stored state is still answered");
    assert.equal(fetchCalls.length, 0, `no poll may leave the process (got ${JSON.stringify(fetchCalls)})`);
  });

  it("the same for an in-flight Stripe row on a test key", async () => {
    process.env["IDENTITY_PROVIDER"] = "stripe";
    process.env["STRIPE_IDENTITY_SECRET_KEY"] = STRIPE_TEST;
    _setTestClient(makeClient(freshDb([inFlightRow("stripe", "vs_inflight")])) as any, true);
    const res = await request("GET", "/api/verification/status");
    assert.equal(res.status, 200);
    assert.equal(fetchCalls.length, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Controls — the gate is the operational check, not a blanket refusal
// ─────────────────────────────────────────────────────────────────────────────

describe("P-5 controls — an OPERATIONAL provider still works, and the mock is not keyed", () => {
  it("Sumsub CERTIFIED (test-runner seam) on the same sandbox token: a session is created — two calls, a `test`-mode row", async () => {
    useSumsubSandbox();
    _certifyIdentityProvidersForTest(["mock", "sumsub"]);
    assert.equal(identityProviderStatus().operational, true, "premise: certified + key set = operational");
    const db = freshDb();
    _setTestClient(makeClient(db) as any, true);
    const res = await request("POST", "/api/verification/session", { level: "id" });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.redirectUrl, "https://in.sumsub.com/websdk/p/p5-link");
    assert.equal(fetchCalls.length, 2);
    assert.ok(fetchCalls.every((c) => c.url.startsWith("https://api.sumsub.com/") && c.method === "POST"));
    assert.equal(db.identity_verifications.length, 1);
    assert.equal(db.identity_verifications[0].provider, "sumsub");
    assert.equal(db.identity_verifications[0].provider_mode, "test", "a sandbox attempt is recorded as one (3930)");
  });

  it("…and the poll asks the certified provider once for an in-flight row", async () => {
    useSumsubSandbox();
    _certifyIdentityProvidersForTest(["mock", "sumsub"]);
    _setTestClient(makeClient(freshDb([inFlightRow("sumsub", "applicant_inflight")])) as any, true);
    const res = await request("GET", "/api/verification/status");
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0]!.method, "GET");
    assert.ok(fetchCalls[0]!.url.startsWith("https://api.sumsub.com/resources/applicants/applicant_inflight/status"));
  });

  it("the mock (not keyed) still creates a session under the test runner", async () => {
    process.env["IDENTITY_PROVIDER"] = "mock";
    const db = freshDb();
    _setTestClient(makeClient(db) as any, true);
    const res = await request("POST", "/api/verification/session", { level: "id" });
    assert.ok(res.status === 201 || res.status === 200, JSON.stringify(res.body));
    assert.equal(db.identity_verifications.length, 1);
    assert.equal(fetchCalls.length, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. No user id in Sumsub error text (it is logged as `{ err }`)
// ─────────────────────────────────────────────────────────────────────────────

describe("Sumsub error text that reaches the logs names no user", () => {
  it("pathForLogs drops the whole query and keeps the operation's path", () => {
    assert.equal(
      pathForLogs(`/resources/sdkIntegrations/levels/id-only/websdkLink?externalUserId=${ALICE_ID}`),
      "/resources/sdkIntegrations/levels/id-only/websdkLink",
    );
    assert.equal(pathForLogs("/resources/applicants?levelName=id-only"), "/resources/applicants");
    assert.equal(pathForLogs("/resources/applicants/app_1/status"), "/resources/applicants/app_1/status");
  });

  it("a failed websdkLink call throws a message with the status and path, and without externalUserId", async () => {
    useSumsubSandbox();
    failWebsdkLink = true;
    const err = await sumsubCreateSession({ userId: ALICE_ID, level: "id", returnUrl: "travelbuddy://profile/verification" }).then(
      () => null,
      (e: unknown) => e as Error,
    );
    assert.ok(err, "the failure must throw");
    assert.match(err.message, /Sumsub API 500 \(500\) on POST \/resources\/sdkIntegrations\/levels\/id-only\/websdkLink$/);
    assert.equal(err.message.includes(ALICE_ID), false, "the user id must not be in the message");
    assert.equal(err.message.includes("externalUserId"), false);
  });

  it("through the route: the logged createSession failure carries no user id", async () => {
    useSumsubSandbox();
    _certifyIdentityProvidersForTest(["mock", "sumsub"]);
    failWebsdkLink = true;
    _setTestClient(makeClient(freshDb()) as any, true);
    const res = await request("POST", "/api/verification/session", { level: "id" });
    assert.equal(res.status, 500, JSON.stringify(res.body));
    const entry = logged.find((l) => l.level === "error" && /createSession failed/.test(l.msg));
    assert.ok(entry, `expected the createSession failure log, got ${JSON.stringify(logged.map((l) => l.msg))}`);
    const errText = String((entry!.obj as { err?: Error }).err?.message ?? "");
    assert.match(errText, /websdkLink/, "the logged error is the adapter's");
    assert.equal(errText.includes(ALICE_ID), false, "no user id in the logged error");
  });
});
