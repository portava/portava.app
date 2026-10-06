/**
 * Step 5(d): the UNSIGNED mock identity provider is booking-grade only under
 * `node --test` (NODE_TEST_CONTEXT), never by NODE_ENV alone.
 *
 * The defect: `verificationIsBookingGrade` (lib/rentBuddyKycGate.ts) and
 * `providerModeCounts` (services/identityVerification/currentVerification.ts)
 * counted a mock approval as booking-grade wherever `mockIdentityPermitted`
 * allows the mock to RUN — that includes NODE_ENV=development (`pnpm dev`).
 * The workspace's environment points at the PRODUCTION Supabase project, so a
 * dev server could write self-approved `local_mock` rows into the table real
 * users' rows land in, and that same dev process would count them for
 * bookings.
 *
 * Wave 3 (N-2) then narrowed `mockIdentityPermitted` itself: a dev process may
 * not even RUN the mock now, so it can no longer write a self-approved row.
 *
 * Run: node --import tsx/esm --test src/test/mockIdentityBookingGrade.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { verificationIsBookingGrade } from "../lib/rentBuddyKycGate.js";
import { providerModeCounts, readCurrentIdentityVerification } from "../services/identityVerification/currentVerification.js";
import { mockIdentityPermitted } from "../lib/paymentsMode.js";

const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;
const DEV = env({ NODE_ENV: "development", IDENTITY_PROVIDER: "mock" });
const NODE_ENV_TEST = env({ NODE_ENV: "test", IDENTITY_PROVIDER: "mock" });
const UNDER_NODE_TEST = env({ NODE_TEST_CONTEXT: "child-v8", IDENTITY_PROVIDER: "mock" });

describe("the mock identity provider is booking-grade only under node --test", () => {
  it("pnpm dev (NODE_ENV=development) may not RUN the mock (N-2), and its approvals are not booking-grade", () => {
    assert.equal(mockIdentityPermitted(DEV), false, "N-2: a dev host is not the test runner");
    assert.equal(verificationIsBookingGrade(DEV), false);
    assert.equal(providerModeCounts("local_mock", DEV), false);
  });

  it("NODE_ENV=test alone is not enough either", () => {
    assert.equal(mockIdentityPermitted(NODE_ENV_TEST), false);
    assert.equal(verificationIsBookingGrade(NODE_ENV_TEST), false);
    assert.equal(providerModeCounts("local_mock", NODE_ENV_TEST), false);
  });

  it("under node --test (NODE_TEST_CONTEXT) the mock is booking-grade", () => {
    assert.equal(verificationIsBookingGrade(UNDER_NODE_TEST), true);
    assert.equal(providerModeCounts("local_mock", UNDER_NODE_TEST), true);
  });

  it("NODE_TEST_CONTEXT never overrides a hosted deployment or production", () => {
    assert.equal(verificationIsBookingGrade(env({ NODE_TEST_CONTEXT: "child-v8", IDENTITY_PROVIDER: "mock", REPLIT_DEPLOYMENT: "1" })), false);
    assert.equal(verificationIsBookingGrade(env({ NODE_TEST_CONTEXT: "child-v8", IDENTITY_PROVIDER: "mock", NODE_ENV: "production" })), false);
    assert.equal(providerModeCounts("local_mock", env({ NODE_TEST_CONTEXT: "child-v8", REPLIT_DEPLOYMENT: "" })), false);
  });

  it("a stored local_mock approval read by a dev process is NOT verified (reason mock_verification)", async () => {
    const row = {
      id: "iv-1", provider: "mock", provider_mode: "local_mock", status: "verified", is_over_18: true,
      document_country: "US", verified_at: "2026-09-01T00:00:00Z", created_at: "2026-09-01T00:00:00Z",
    };
    const q = (data: unknown) => {
      const b: any = { select: () => b, eq: () => b, in: () => b, order: () => b, limit: () => b,
        maybeSingle: async () => ({ data: Array.isArray(data) ? data[0] ?? null : data, error: null }),
        then: (res: (v: unknown) => unknown) => Promise.resolve({ data, error: null }).then(res) };
      return b;
    };
    const db = { from: (t: string) => (t === "identity_verifications" ? q([row]) : q({ verification_level: "id_verified" })) };
    const dev = await readCurrentIdentityVerification(db, "u-1", DEV);
    assert.deepEqual(dev, { state: "not_verified", reason: "mock_verification" });
    const underTest = await readCurrentIdentityVerification(db, "u-1", UNDER_NODE_TEST);
    assert.equal(underTest.state, "verified");
  });
});
