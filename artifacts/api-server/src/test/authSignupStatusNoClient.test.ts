/**
 * GET /api/auth/signup-status with NO SERVICE CLIENT — "the stop could not be
 * read" is not "the stop is off".
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 * When `getServiceClient()` returns null, neither `disable_signups` (CLASSIFIED
 * STOP) nor `invite_only_beta` (CLASSIFIED CAPABILITY) can be consulted at all.
 * The handler answered `{ signupsEnabled: true, inviteOnly: false }` — the one
 * answer its own docblock forbids on both counts:
 *
 *   • It disengages an emergency stop precisely when nothing can be read, which
 *     is the failure mode isKillSwitchEngaged exists to close and which
 *     check-flag-polarity.mjs records `disable_signups` as STOP to prevent.
 *   • It contradicts the endpoint's stated contract — that it "matches what
 *     POST /auth/signup will actually do, so the app never shows a signup form
 *     that is about to 403". POST /auth/signup answers 503
 *     `service_unavailable` in this state, so the app rendered a signup form
 *     guaranteed to fail the moment the user pressed the button.
 *
 * ── WHY THIS IS ITS OWN FILE ────────────────────────────────────────────────
 * `lib/supabase.ts` computes `isServiceClientReady` from `process.env` ONCE, at
 * module evaluation. `_setTestServiceClient(null)` therefore does not reach the
 * `!client` branch: `getServiceClient()` falls through and builds a real client
 * against whatever SUPABASE_URL the runner set. The only way to exercise the
 * branch is to clear the env vars BEFORE the module graph loads — which means
 * no static import of anything that pulls in lib/supabase.ts, and a dynamic
 * `import()` afterwards. That cannot coexist in one process with
 * authSignupStatusFailClosed.test.ts, whose cases need a working client.
 *
 * ── PAIRING ─────────────────────────────────────────────────────────────────
 * The healthy direction — a readable flag row leaving signup OPEN — is asserted
 * in authSignupStatusFailClosed.test.ts. Without that half, a change that
 * simply hard-closed signup would satisfy every assertion in this file.
 *
 * Run: node --import tsx/esm --test src/test/authSignupStatusNoClient.test.ts
 * (deliberately WITHOUT SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — the file
 *  clears them itself, so the standard invocation works too.)
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";

// Cleared BEFORE the dynamic imports below so lib/supabase.ts evaluates
// `isServiceClientReady = false` and getServiceClient() genuinely returns null.
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

const express = (await import("express")).default;
const supabase = await import("../lib/supabase.js");
const authModule = await import("../routes/auth.js");
const authRouter = authModule.default;
const { _resetAuthRateLimits } = authModule;

let base = "";
let server: Server;

before(async () => {
  // The premise of every assertion below. If this ever stops holding, the
  // tests would be exercising the client path and passing for the wrong reason.
  assert.equal(
    supabase.isServiceClientReady,
    false,
    "env was not cleared before lib/supabase.ts evaluated — these cases would not reach the !client branch",
  );
  assert.equal(supabase.getServiceClient(), null, "getServiceClient() must return null for this suite");

  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.log = { info() {}, warn() {}, error() {}, debug() {} };
    next();
  });
  app.use("/api", authRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as any).port}/api`;
});

after(() => { server.close(); });

async function call(method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await res.text();
  let parsed: any;
  try { parsed = JSON.parse(raw); } catch { parsed = raw; }
  return { status: res.status, body: parsed };
}

describe("auth/signup-status with no service client", () => {
  it("does not report signups as enabled when neither flag can be read", async () => {
    const res = await call("GET", "/auth/signup-status");
    assert.equal(
      res.body.signupsEnabled,
      false,
      "answering true disengages the disable_signups STOP precisely when nothing is readable",
    );
    assert.equal(res.body.inviteOnly, false);
  });

  it("reports the unavailability with 503, matching POST /auth/signup", async () => {
    const res = await call("GET", "/auth/signup-status");
    assert.equal(res.status, 503, "assert the CODE — a 200 here is the app showing a form that cannot submit");
  });

  it("POST /auth/signup refuses with 503 service_unavailable in the same state", async () => {
    _resetAuthRateLimits();
    const res = await call("POST", "/auth/signup", { email: "nobody@example.com", password: "hunter2" });
    assert.equal(res.status, 503, "the contract signup-status claims to match");
    assert.equal(res.body.error, "service_unavailable");
  });
});
