/**
 * Sumsub as the PRIMARY identity provider — the half that can be proven offline.
 *
 * Owner decision under test:
 *   "Use Sumsub as the primary identity provider behind the provider interface.
 *    Verify market coverage; fail closed and keep bookings unavailable where
 *    suitable verification is unsupported."
 *
 * WHAT THIS FILE MEASURES. Four things, none of which needs a Sumsub account:
 *
 *   1. MARKET COVERAGE FAILS CLOSED. Supported permits, unsupported refuses
 *      with a reason that says so, and every flavour of "we do not know" —
 *      unmounted, unreadable, malformed, empty, self-contradicting, for another
 *      vendor, a market not in the list, no market at all — refuses too. The
 *      empty/unreadable pair is the one that matters most: an unreadable list is
 *      NOT an empty list and neither is a permission.
 *   2. A COVERAGE REFUSAL AND A PROVIDER FAILURE ARE DIFFERENT OUTCOMES, all
 *      the way from a Sumsub reject label to the booking gate's response code.
 *   3. THE SIGNATURE HALF. Sumsub's keyed-digest scheme over real HMAC material,
 *      including the fact that the caller-supplied algorithm header is
 *      allowlisted rather than trusted.
 *   4. THE PROVIDER IS UNREACHABLE. `IMPLEMENTED_PROVIDERS` excludes `sumsub`,
 *      so the adapter exists, the factory returns it, and `identityProviderStatus`
 *      still reports it non-operational — which is what keeps all five booking
 *      paths at 503.
 *
 * WHAT THIS FILE DOES NOT CERTIFY. That Sumsub sends these shapes, or that the
 * app-token prefixes are what the vendor documents. Nothing here has spoken to
 * Sumsub and no credential exists in this repository. The payload half stays
 * uncertified until a sandbox transcript exists, exactly as for Stripe and
 * Persona.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/sumsubIdentityProvider.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import {
  SUMSUB_DIGEST_ALG_HEADER,
  SUMSUB_DIGEST_HEADER,
  mapSumsubRejectLabels,
  mapSumsubReviewStatus,
  normalizeSumsubCountry,
  normalizeSumsubReview,
  normalizeSumsubWebhook,
  signSumsubRequest,
  sumsubLevelName,
  sumsubStatusResultOrThrow,
} from "../services/identityVerification/sumsub.js";
import {
  type CoverageSourceIo,
  COVERAGE_MANIFEST_ENV,
  coverageRequirementFor,
  identityMarketAvailability,
  loadCoverageSource,
  normalizeMarket,
  parseCoverageManifest,
  resolveMarketCoverage,
} from "../services/identityVerification/marketCoverage.js";
import {
  REAL_PROVIDER_NAMES,
  WebhookSignatureError,
} from "../services/identityVerification/webhookSignature.js";
import { getIdentityProvider } from "../services/identityVerification/providers.js";
import { identityProviderStatus } from "../services/identityVerification/readiness.js";
import { toVerificationLevel } from "../services/identityVerification/types.js";
import type { VerificationResult } from "../services/identityVerification/types.js";
import { checkBookingKycGate, KYC_OVERRIDE_FLAG } from "../lib/rentBuddyKycGate.js";
import { mapStripeFailureCode } from "../services/identityVerification/stripeIdentity.js";

const SECRET = "whsec_test_sumsub_6b1f0a";
const MANIFEST_PATH = "/virtual/identity-market-coverage.json";
const MANIFEST_ENV = { [COVERAGE_MANIFEST_ENV]: MANIFEST_PATH } as NodeJS.ProcessEnv;

/** 2026-10-04T00:00:00Z — fixed so "is this person 18" is not a moving target. */
const NOW = Date.UTC(2026, 9, 4);

// ── fakes ────────────────────────────────────────────────────────────────────

/**
 * Filesystem seam. A key present with a string is a readable file; a key
 * present with an Error is a file that EXISTS AND CANNOT BE READ; an absent key
 * is a file that is not there. Those are three different answers and the whole
 * coverage module turns on telling them apart.
 */
function io(files: Record<string, string | Error>): CoverageSourceIo {
  return {
    exists: (p) => Object.prototype.hasOwnProperty.call(files, p),
    readText: (p) => {
      const v = files[p];
      if (v instanceof Error) throw v;
      if (typeof v !== "string") throw new Error("ENOENT");
      return v;
    },
  };
}

function manifest(body: unknown): Record<string, string> {
  return { [MANIFEST_PATH]: JSON.stringify(body) };
}

const GOOD_MANIFEST = {
  provider: "sumsub",
  level: "id_selfie",
  revision: "2026-10-04-test-fixture",
  retrievedAt: "2026-10-04T00:00:00.000Z",
  supported: ["PH", "US", "GB"],
  unsupported: ["KP"],
};

/** Feature-flag client, same shape as src/test/rentBuddyKycGate.test.ts. */
function flagClient(opts: { enabled?: boolean; error?: string; throws?: boolean } = {}) {
  const seen: string[] = [];
  return {
    _seen: seen,
    from() {
      const q: any = {
        select: () => q,
        eq: (_c: string, v: any) => {
          seen.push(v);
          return q;
        },
        maybeSingle: async () => {
          if (opts.throws) throw new Error("connection reset");
          if (opts.error) return { data: null, error: { message: opts.error } };
          return { data: opts.enabled === undefined ? null : { enabled: opts.enabled }, error: null };
        },
      };
      return q;
    },
  };
}

/** Gate probes: a provider that works, and coverage decided by an injected manifest. */
function probesFor(files: Record<string, string | Error>, provider = "sumsub") {
  return {
    status: () => ({ operational: true, provider, reason: "test: provider usable" }),
    marketAvailability: (p: string, m: unknown) => identityMarketAvailability(p, m, MANIFEST_ENV, io(files)),
  };
}

/** Sumsub's digest header pair for a body, under an arbitrary secret/algorithm. */
function digestHeaders(
  rawBody: string,
  secret: string,
  vendorAlg = "HMAC_SHA256_HEX",
  nodeAlg = "sha256",
): Record<string, string> {
  return {
    [SUMSUB_DIGEST_HEADER]: crypto.createHmac(nodeAlg, secret).update(rawBody, "utf8").digest("hex"),
    [SUMSUB_DIGEST_ALG_HEADER]: vendorAlg,
  };
}

async function thrown(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  return undefined;
}

const REVIEWED_GREEN = JSON.stringify({
  applicantId: "6410a1b2c3d4e5f60718293a",
  externalUserId: "portava-user-1",
  levelName: "portava-id-selfie",
  type: "applicantReviewed",
  reviewStatus: "completed",
  sandboxMode: true,
  reviewResult: { reviewAnswer: "GREEN" },
});

// ── env isolation ────────────────────────────────────────────────────────────

const ENV_KEYS = [
  "IDENTITY_PROVIDER",
  "IDENTITY_WEBHOOK_SECRET",
  "NODE_ENV",
  "SUMSUB_APP_TOKEN",
  "SUMSUB_SECRET_KEY",
  "SUMSUB_LEVEL_NAME_ID",
  "SUMSUB_LEVEL_NAME_ID_SELFIE",
  "PAYMENTS_ALLOW_LIVE",
] as const;
const saved: Record<string, string | undefined> = {};

before(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
});
after(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function useSumsub(extra: Record<string, string> = {}): void {
  process.env["IDENTITY_PROVIDER"] = "sumsub";
  process.env["IDENTITY_WEBHOOK_SECRET"] = SECRET;
  delete process.env["NODE_ENV"];
  for (const [k, v] of Object.entries(extra)) process.env[k] = v;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE MANIFEST: every way it can fail to be usable, and all of them refuse.
// ─────────────────────────────────────────────────────────────────────────────

describe("coverage source — an unreadable list is not an empty one, and neither is a pass", () => {
  it("UNMOUNTED is `absent`, not `empty`", () => {
    const out = loadCoverageSource("sumsub", MANIFEST_ENV, io({}));
    assert.equal(out.ok, false);
    assert.equal(out.ok === false && out.failure, "coverage_source_absent");
  });

  it("PRESENT BUT UNREADABLE is `unreadable` — distinct from absent, and refuses", () => {
    const out = loadCoverageSource(
      "sumsub",
      MANIFEST_ENV,
      io({ [MANIFEST_PATH]: Object.assign(new Error("EACCES"), { code: "EACCES" }) }),
    );
    assert.equal(out.ok, false);
    assert.equal(out.ok === false && out.failure, "coverage_source_unreadable");
  });

  it("a `supported: []` export is `empty`, NOT a readable list of nowhere", () => {
    const out = loadCoverageSource(
      "sumsub",
      MANIFEST_ENV,
      io(manifest({ ...GOOD_MANIFEST, supported: [] })),
    );
    assert.equal(out.ok, false);
    assert.equal(out.ok === false && out.failure, "coverage_source_empty");
  });

  it("non-JSON, a JSON array, and a missing field are all `malformed`", () => {
    for (const body of ["not json at all", "[]", '{"provider":"sumsub"}']) {
      const out = loadCoverageSource("sumsub", MANIFEST_ENV, io({ [MANIFEST_PATH]: body }));
      assert.equal(out.ok, false, body);
      assert.equal(out.ok === false && out.failure, "coverage_source_malformed", body);
    }
  });

  it("ONE bad country code refuses the WHOLE FILE — a skipped row is a silently narrowed list", () => {
    const out = parseCoverageManifest(
      JSON.stringify({ ...GOOD_MANIFEST, supported: ["PH", "USA", "GB"] }),
      "sumsub",
    );
    assert.equal(out.ok, false);
    assert.equal(out.ok === false && out.failure, "coverage_source_malformed");
  });

  it("a market in BOTH lists is `conflicting`, not resolved by precedence", () => {
    const out = parseCoverageManifest(
      JSON.stringify({ ...GOOD_MANIFEST, unsupported: ["PH"] }),
      "sumsub",
    );
    assert.equal(out.ok, false);
    assert.equal(out.ok === false && out.failure, "coverage_source_conflicting");
  });

  it("another vendor's manifest is a `provider_mismatch`, never read as ours", () => {
    const out = parseCoverageManifest(JSON.stringify({ ...GOOD_MANIFEST, provider: "stripe" }), "sumsub");
    assert.equal(out.ok, false);
    assert.equal(out.ok === false && out.failure, "coverage_source_provider_mismatch");
  });

  it("a good manifest parses, and lower-case / padded codes are accepted", () => {
    const out = parseCoverageManifest(
      JSON.stringify({ ...GOOD_MANIFEST, supported: ["ph", " us ", "GB"] }),
      "SUMSUB",
    );
    assert.equal(out.ok, true);
    assert.ok(out.ok && out.manifest.supported.has("PH"));
    assert.ok(out.ok && out.manifest.supported.has("US"));
    assert.equal(out.ok && out.manifest.revision, GOOD_MANIFEST.revision);
  });

  it("normalizeMarket refuses everything that is not alpha-2", () => {
    assert.equal(normalizeMarket("ph"), "PH");
    for (const bad of ["", "   ", "USA", "P", "P1", 42, null, undefined, {}, ["PH"]]) {
      assert.equal(normalizeMarket(bad), null, JSON.stringify(bad));
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. RESOLUTION: supported / unsupported / unknown.
// ─────────────────────────────────────────────────────────────────────────────

describe("market resolution — unknown and unsupported both refuse, for different reasons", () => {
  const good = () => loadCoverageSource("sumsub", MANIFEST_ENV, io(manifest(GOOD_MANIFEST)));

  it("a listed market is supported", () => {
    const d = resolveMarketCoverage("PH", good());
    assert.equal(d.status, "supported");
    assert.equal(d.code, "market_supported");
    assert.equal(d.revision, GOOD_MANIFEST.revision);
  });

  it("an excluded market is UNSUPPORTED and the reason names the market", () => {
    const d = resolveMarketCoverage("kp", good());
    assert.equal(d.status, "unsupported");
    assert.equal(d.code, "market_excluded");
    assert.match(d.reason, /KP/);
    assert.match(d.reason, /not supported/i);
  });

  it("A MARKET NOT IN THE LIST IS UNKNOWN — not supported by omission", () => {
    const d = resolveMarketCoverage("JP", good());
    assert.equal(d.status, "unknown");
    assert.equal(d.code, "market_not_listed");
  });

  it("NO MARKET SUPPLIED is unknown — `we did not ask` is not `it is fine`", () => {
    for (const absent of [undefined, null, "", "   "]) {
      const d = resolveMarketCoverage(absent, good());
      assert.equal(d.status, "unknown", JSON.stringify(absent));
      assert.equal(d.code, "market_not_supplied", JSON.stringify(absent));
      assert.equal(d.market, null);
    }
  });

  it("a malformed market is unknown, never looked up loosely", () => {
    const d = resolveMarketCoverage("USA", good());
    assert.equal(d.status, "unknown");
    assert.equal(d.code, "market_malformed");
  });

  it("an unusable SOURCE makes even a would-be-supported market unknown", () => {
    for (const files of [
      {},
      { [MANIFEST_PATH]: new Error("EACCES") },
      { [MANIFEST_PATH]: "{" },
      manifest({ ...GOOD_MANIFEST, supported: [] }),
    ]) {
      const d = resolveMarketCoverage("PH", loadCoverageSource("sumsub", MANIFEST_ENV, io(files)));
      assert.equal(d.status, "unknown", JSON.stringify(Object.keys(files)));
      assert.notEqual(d.status, "supported");
    }
  });

  it("a provider with NO declared coverage source refuses — stripe and persona included", () => {
    for (const p of ["stripe", "persona", "acme"]) {
      assert.equal(coverageRequirementFor(p), null, p);
      const a = identityMarketAvailability(p, "PH", MANIFEST_ENV, io(manifest(GOOD_MANIFEST)));
      assert.equal(a.available, false, p);
      assert.equal(a.code, "coverage_source_undeclared", p);
    }
  });

  it("the MOCK is not market-scoped, which is what keeps local runs working", () => {
    const a = identityMarketAvailability("mock", undefined, MANIFEST_ENV, io({}));
    assert.equal(a.available, true);
    assert.equal(a.code, "provider_not_market_scoped");
  });

  it("identityMarketAvailability is available ONLY for a supported market", () => {
    const files = manifest(GOOD_MANIFEST);
    assert.equal(identityMarketAvailability("sumsub", "PH", MANIFEST_ENV, io(files)).available, true);
    for (const market of ["KP", "JP", "USA", undefined, null, ""]) {
      assert.equal(
        identityMarketAvailability("sumsub", market, MANIFEST_ENV, io(files)).available,
        false,
        String(market),
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. THE BOOKING GATE. The owner's decision lands here or it lands nowhere.
// ─────────────────────────────────────────────────────────────────────────────

describe("booking gate — market coverage is a second, independent refusal", () => {
  it("a SUPPORTED market with a working provider PERMITS the booking", async () => {
    const gate = await checkBookingKycGate(flagClient(), "PH", probesFor(manifest(GOOD_MANIFEST)));
    assert.equal(gate.allowed, true);
  });

  it("an UNSUPPORTED market makes booking unavailable, with a reason that says so", async () => {
    const gate = await checkBookingKycGate(flagClient(), "KP", probesFor(manifest(GOOD_MANIFEST)));
    assert.equal(gate.allowed, false);
    assert.equal(gate.httpStatus, 503);
    assert.equal(gate.code, "verification_unsupported_market");
    // The person is told it is about the LOCATION, and is not invited to retry.
    assert.match(gate.message ?? "", /location/i);
    assert.match(gate.message ?? "", /verify identity/i);
  });

  it("an UNKNOWN market fails closed", async () => {
    const gate = await checkBookingKycGate(flagClient(), "JP", probesFor(manifest(GOOD_MANIFEST)));
    assert.equal(gate.allowed, false);
    assert.equal(gate.code, "verification_market_unknown");
  });

  it("NO MARKET at all fails closed for a market-scoped provider", async () => {
    const gate = await checkBookingKycGate(flagClient(), undefined, probesFor(manifest(GOOD_MANIFEST)));
    assert.equal(gate.allowed, false);
    assert.equal(gate.code, "verification_market_unknown");
  });

  it("an UNREADABLE coverage list refuses — it is not read as an empty one", async () => {
    const cases: Record<string, string | Error>[] = [
      {},
      { [MANIFEST_PATH]: new Error("EACCES") },
      { [MANIFEST_PATH]: "{" },
    ];
    for (const files of cases) {
      const gate = await checkBookingKycGate(flagClient(), "PH", probesFor(files));
      assert.equal(gate.allowed, false, JSON.stringify(Object.keys(files)));
      assert.equal(gate.code, "verification_market_unknown");
    }
  });

  it("a coverage refusal and a PROVIDER FAILURE are different outcomes", async () => {
    const coverage = await checkBookingKycGate(flagClient(), "KP", probesFor(manifest(GOOD_MANIFEST)));
    const failure = await checkBookingKycGate(flagClient(), "KP", {
      status: () => ({ operational: false, provider: "sumsub", reason: "test: provider broken" }),
      marketAvailability: () => {
        throw new Error("coverage must not be consulted when the provider itself is unusable");
      },
    });

    assert.equal(coverage.allowed, false);
    assert.equal(failure.allowed, false);
    assert.notEqual(coverage.code, failure.code);
    assert.equal(coverage.code, "verification_unsupported_market");
    assert.equal(failure.code, "verification_unavailable");
    assert.notEqual(coverage.message, failure.message);
  });

  it("a DB error on the override flag still refuses a coverage-blocked booking", async () => {
    for (const client of [flagClient({ error: "relation missing" }), flagClient({ throws: true })]) {
      const gate = await checkBookingKycGate(client, "KP", probesFor(manifest(GOOD_MANIFEST)));
      assert.equal(gate.allowed, false, "a DB error must not open bookings");
    }
  });

  it("the coverage refusal consults the override flag, and only an explicit true opens it", async () => {
    const off = flagClient({ enabled: false });
    assert.equal((await checkBookingKycGate(off, "KP", probesFor(manifest(GOOD_MANIFEST)))).allowed, false);
    assert.ok(off._seen.includes(KYC_OVERRIDE_FLAG), "must consult the override flag");
    const on = flagClient({ enabled: true });
    assert.equal((await checkBookingKycGate(on, "KP", probesFor(manifest(GOOD_MANIFEST)))).allowed, true);
  });

  it("neither coverage message leaks the vendor, the env var or the manifest path", async () => {
    for (const market of ["KP", "JP"]) {
      const gate = await checkBookingKycGate(flagClient(), market, probesFor(manifest(GOOD_MANIFEST)));
      const msg = gate.message ?? "";
      for (const leak of ["sumsub", "Sumsub", "stripe", "persona", "IDENTITY_PROVIDER", COVERAGE_MANIFEST_ENV, MANIFEST_PATH]) {
        assert.ok(!msg.includes(leak), `message leaked "${leak}": ${msg}`);
      }
    }
  });

  it("the mock provider needs no market — the existing five call sites are unaffected", async () => {
    const gate = await checkBookingKycGate(flagClient(), undefined, {
      status: () => ({ operational: true, provider: "mock", reason: "mock provider (non-production)" }),
      marketAvailability: (p, m) => identityMarketAvailability(p, m, MANIFEST_ENV, io({})),
    });
    assert.equal(gate.allowed, true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. NORMALIZATION. The dangerous default is `not verified`, everywhere.
// ─────────────────────────────────────────────────────────────────────────────

describe("sumsub normalization — no status Sumsub invents later may grant standing", () => {
  it("a GREEN completed review verifies, and the selfie level sets selfieMatch", () => {
    const r = normalizeSumsubReview(
      {
        applicantId: "app_1",
        reviewStatus: "completed",
        levelName: "portava-id-selfie",
        reviewResult: { reviewAnswer: "GREEN" },
        info: { dob: "1990-07-04", country: "PH" },
      },
      { selfieLevelName: "portava-id-selfie", nowMs: NOW },
    );
    assert.equal(r?.status, "verified");
    assert.equal(r?.selfieMatch, true);
    assert.equal(r?.isOver18, true);
    assert.equal(toVerificationLevel(r!), "id_selfie_verified");
  });

  it("a GREEN on a NON-selfie level leaves selfieMatch UNDEFINED, not false", () => {
    const r = normalizeSumsubReview(
      {
        applicantId: "app_1",
        reviewStatus: "completed",
        levelName: "portava-id-only",
        reviewResult: { reviewAnswer: "GREEN" },
      },
      { selfieLevelName: "portava-id-selfie", nowMs: NOW },
    );
    assert.equal(r?.selfieMatch, undefined, "false would read as `asked and did not match`");
    assert.equal(toVerificationLevel(r!), "id_verified");
  });

  it("`completed` with an UNREADABLE answer is NOT verified", () => {
    for (const answer of [undefined, null, "", "MAYBE", 1, {}]) {
      const r = normalizeSumsubReview(
        { applicantId: "app_1", reviewStatus: "completed", reviewResult: { reviewAnswer: answer } },
        { nowMs: NOW },
      );
      assert.notEqual(r?.status, "verified", JSON.stringify(answer));
      assert.equal(toVerificationLevel(r!), "none", JSON.stringify(answer));
    }
  });

  it("an unrecognised reviewStatus defaults to pending, never verified", () => {
    for (const s of ["somethingNew", "", undefined, null, 7]) {
      assert.equal(mapSumsubReviewStatus(s), "pending", JSON.stringify(s));
    }
    // `completed` on its own is not an outcome either — the answer decides.
    assert.equal(mapSumsubReviewStatus("completed"), "pending");
  });

  it("a RED answer fails even on a non-completed status", () => {
    const r = normalizeSumsubReview(
      { applicantId: "app_1", reviewStatus: "pending", reviewResult: { reviewAnswer: "RED" } },
      { nowMs: NOW },
    );
    assert.equal(r?.status, "failed");
  });

  it("the redaction handle is set for EVERY state — a rejected applicant still left an ID", () => {
    for (const [status, answer] of [
      ["init", undefined],
      ["pending", undefined],
      ["completed", "GREEN"],
      ["completed", "RED"],
    ] as const) {
      const r = normalizeSumsubReview(
        { applicantId: "app_handle", reviewStatus: status, reviewResult: { reviewAnswer: answer } },
        { nowMs: NOW },
      );
      assert.equal(r?.providerVerificationRef, "app_handle", `${status}/${String(answer)}`);
    }
  });

  it("no applicant id is null, never a blank result", () => {
    assert.equal(normalizeSumsubReview({ reviewStatus: "completed" }), null);
    assert.equal(normalizeSumsubReview({ applicantId: "   " }), null);
  });

  it("alpha-3 country codes are DROPPED, not truncated (AUT would become AU)", () => {
    assert.equal(normalizeSumsubCountry("AUT"), null);
    assert.equal(normalizeSumsubCountry("PHL"), null);
    assert.equal(normalizeSumsubCountry("ph"), "PH");
    const r = normalizeSumsubReview(
      {
        applicantId: "app_1",
        reviewStatus: "completed",
        reviewResult: { reviewAnswer: "GREEN" },
        info: { country: "AUT" },
      },
      { nowMs: NOW },
    );
    assert.equal(r?.documentCountry, undefined, "a wrong country is worse than no country");
  });

  it("PRIVACY: the date of birth never survives into the result", () => {
    const r = normalizeSumsubReview(
      {
        applicantId: "app_1",
        reviewStatus: "completed",
        reviewResult: { reviewAnswer: "GREEN" },
        info: { dob: "1990-07-04" },
      },
      { nowMs: NOW },
    );
    const blob = JSON.stringify(r);
    for (const part of ["1990", "07-04", "1990-07-04"]) {
      assert.equal(blob.includes(part), false, `DOB fragment "${part}" leaked into ${blob}`);
    }
    assert.equal(r?.isOver18, true, "the derived boolean IS kept — that is the point");
  });

  it("an unreadable STATUS BODY throws rather than resolving to a soft pending", () => {
    for (const body of [
      null,
      undefined,
      "a string",
      [],
      42,
      // `{}` is the dangerous one: the applicant id comes from US, so a naive
      // normalizer turns an empty body into a well-formed `pending` that gets
      // WRITTEN over whatever the row already said.
      {},
      { reviewStatus: "" },
      { reviewStatus: 7 },
      { reviewResult: { reviewAnswer: "GREEN" } },
    ]) {
      assert.throws(
        () => sumsubStatusResultOrThrow("app_1", body, {} as NodeJS.ProcessEnv),
        /unreadable applicant status/,
        JSON.stringify(body) ?? "undefined",
      );
    }
    // An UNRECOGNISED status string is readable, not unreadable: it resolves to
    // the safe `pending` default rather than throwing.
    assert.equal(
      sumsubStatusResultOrThrow("app_1", { reviewStatus: "somethingNew" }, {} as NodeJS.ProcessEnv).status,
      "pending",
    );
    // CONTROL: a readable body does NOT throw, so the assertions above are not
    // satisfied by a function that refuses everything.
    const ok = sumsubStatusResultOrThrow(
      "app_1",
      { reviewStatus: "completed", reviewResult: { reviewAnswer: "GREEN" } },
      {} as NodeJS.ProcessEnv,
    );
    assert.equal(ok.status, "verified");
    assert.equal(ok.providerSessionId, "app_1");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. COVERAGE vs FAILURE, preserved through the interface.
// ─────────────────────────────────────────────────────────────────────────────

describe("a coverage refusal is not a failed check", () => {
  it("a country/region/jurisdiction reject label normalizes to coverage_unsupported", () => {
    for (const label of [
      "COUNTRY_NOT_SUPPORTED",
      "UNSUPPORTED_COUNTRY",
      "RESTRICTED_JURISDICTION",
      "REGION_NOT_COVERED",
    ]) {
      assert.equal(mapSumsubRejectLabels([label]), "coverage_unsupported", label);
    }
  });

  it("coverage WINS over a co-occurring document label — the person cannot fix a market", () => {
    assert.equal(
      mapSumsubRejectLabels(["UNSATISFACTORY_PHOTOS", "COUNTRY_NOT_SUPPORTED"]),
      "coverage_unsupported",
    );
  });

  it("ordinary failures keep their ordinary reasons", () => {
    assert.equal(mapSumsubRejectLabels(["SELFIE_MISMATCH"]), "selfie_mismatch");
    assert.equal(mapSumsubRejectLabels(["FORGERY"]), "document_invalid");
    assert.equal(mapSumsubRejectLabels(["AGE_REQUIREMENT_MISMATCH"]), "underage");
    assert.equal(mapSumsubRejectLabels(["APPLICANT_INTERRUPTED_THE_INTERVIEW"]), "abandoned");
  });

  it("an UNRECOGNISED label is `other` — never a coverage claim invented from nothing", () => {
    for (const labels of [[], ["SOMETHING_NEW"], [null], [42]]) {
      assert.equal(mapSumsubRejectLabels(labels), "other", JSON.stringify(labels));
    }
  });

  it("the distinction survives the whole normalization, carrying no age or selfie finding", () => {
    const r = normalizeSumsubReview(
      {
        applicantId: "app_1",
        reviewStatus: "completed",
        reviewResult: { reviewAnswer: "RED", reviewRejectType: "FINAL", rejectLabels: ["COUNTRY_NOT_SUPPORTED"] },
      },
      { nowMs: NOW },
    );
    assert.equal(r?.status, "failed");
    assert.equal(r?.failureReason, "coverage_unsupported");
    assert.equal(r?.isOver18, undefined, "a coverage refusal says nothing about the person");
    assert.equal(r?.selfieMatch, undefined);

    const underage = normalizeSumsubReview(
      {
        applicantId: "app_2",
        reviewStatus: "completed",
        reviewResult: { reviewAnswer: "RED", rejectLabels: ["AGE_REQUIREMENT_MISMATCH"] },
      },
      { nowMs: NOW },
    );
    assert.equal(underage?.failureReason, "underage");
    assert.equal(underage?.isOver18, false, "underage IS a finding about the person");
    assert.notEqual(r?.failureReason, underage?.failureReason);
  });

  it("REPORTED, NOT FIXED: Stripe still flattens country_not_supported into `other`", () => {
    // This is a DELIBERATE record of an unfixed divergence, not an endorsement.
    // The Sumsub work was scoped to fix the flattening for Sumsub and to report
    // the Stripe path for an owner decision; `stripe` is also excluded from
    // IMPLEMENTED_PROVIDERS, so nothing reaches this mapping today.
    //
    // THE FOLLOW-UP IS ONE LINE in stripeIdentity.ts#mapStripeFailureCode:
    //   if (c.startsWith("country_not_supported")) return "coverage_unsupported";
    // Change that line and this assertion together.
    assert.equal(mapStripeFailureCode("country_not_supported"), "other");
    assert.equal(mapStripeFailureCode("device_not_supported"), "other");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. THE SIGNATURE HALF — provable without an account.
// ─────────────────────────────────────────────────────────────────────────────

describe("TV-P5 for sumsub: an unverified webhook throws, never silently accepts", () => {
  it("a correctly signed delivery is accepted and normalized", async () => {
    useSumsub({ SUMSUB_LEVEL_NAME_ID_SELFIE: "portava-id-selfie" });
    const provider = getIdentityProvider();
    const result = await provider.handleWebhook({
      headers: digestHeaders(REVIEWED_GREEN, SECRET),
      rawBody: REVIEWED_GREEN,
    });
    assert.ok(result, "a valid delivery must be accepted");
    assert.equal(result?.provider, "sumsub");
    assert.equal(result?.providerSessionId, "6410a1b2c3d4e5f60718293a");
    assert.equal(result?.status, "verified");
    assert.equal(result?.selfieMatch, true, "the configured selfie level must be read from env by the binding");
  });

  it("the digest header is read case-insensitively", async () => {
    useSumsub();
    const provider = getIdentityProvider();
    const signed = digestHeaders(REVIEWED_GREEN, SECRET);
    const result = await provider.handleWebhook({
      headers: {
        "X-Payload-Digest": signed[SUMSUB_DIGEST_HEADER],
        "X-Payload-Digest-Alg": signed[SUMSUB_DIGEST_ALG_HEADER],
      },
      rawBody: REVIEWED_GREEN,
    });
    assert.ok(result, "Express lowercases headers but WebhookEvent does not enforce it");
  });

  it("a forged digest is a signature_mismatch", async () => {
    useSumsub();
    const provider = getIdentityProvider();
    const err = await thrown(() =>
      provider.handleWebhook({
        headers: digestHeaders(REVIEWED_GREEN, "attacker-secret"),
        rawBody: REVIEWED_GREEN,
      }),
    );
    assert.ok(err instanceof WebhookSignatureError);
    assert.equal((err as WebhookSignatureError).code, "signature_mismatch");
  });

  it("a body changed after signing is a mismatch", async () => {
    useSumsub();
    const provider = getIdentityProvider();
    const tampered = REVIEWED_GREEN.replace("GREEN", "GREEN ");
    const err = await thrown(() =>
      provider.handleWebhook({ headers: digestHeaders(REVIEWED_GREEN, SECRET), rawBody: tampered }),
    );
    assert.equal((err as WebhookSignatureError)?.code, "signature_mismatch");
  });

  it("NO SECRET CONFIGURED is a throw, not a bypass", async () => {
    useSumsub();
    delete process.env["IDENTITY_WEBHOOK_SECRET"];
    const provider = getIdentityProvider();
    const err = await thrown(() =>
      provider.handleWebhook({ headers: digestHeaders(REVIEWED_GREEN, SECRET), rawBody: REVIEWED_GREEN }),
    );
    assert.equal((err as WebhookSignatureError)?.code, "secret_not_configured");
  });

  it("a MISSING algorithm header is unsupported, not a default", async () => {
    useSumsub();
    const provider = getIdentityProvider();
    const signed = digestHeaders(REVIEWED_GREEN, SECRET);
    const err = await thrown(() =>
      provider.handleWebhook({
        headers: { [SUMSUB_DIGEST_HEADER]: signed[SUMSUB_DIGEST_HEADER] },
        rawBody: REVIEWED_GREEN,
      }),
    );
    assert.equal((err as WebhookSignatureError)?.code, "signature_algorithm_unsupported");
  });

  it("the caller does NOT get to choose the primitive — only documented names pass", async () => {
    useSumsub();
    const provider = getIdentityProvider();
    for (const alg of ["md5", "none", "HMAC_MD5_HEX", "sha256", "../sha256"]) {
      const err = await thrown(() =>
        provider.handleWebhook({
          headers: {
            [SUMSUB_DIGEST_HEADER]: crypto.createHmac("sha256", SECRET).update(REVIEWED_GREEN).digest("hex"),
            [SUMSUB_DIGEST_ALG_HEADER]: alg,
          },
          rawBody: REVIEWED_GREEN,
        }),
      );
      assert.equal((err as WebhookSignatureError)?.code, "signature_algorithm_unsupported", alg);
    }
  });

  it("the three documented algorithms all work", async () => {
    useSumsub();
    const provider = getIdentityProvider();
    for (const [vendor, node] of [
      ["HMAC_SHA1_HEX", "sha1"],
      ["HMAC_SHA256_HEX", "sha256"],
      ["HMAC_SHA512_HEX", "sha512"],
    ] as const) {
      const result = await provider.handleWebhook({
        headers: digestHeaders(REVIEWED_GREEN, SECRET, vendor, node),
        rawBody: REVIEWED_GREEN,
      });
      assert.ok(result, vendor);
    }
  });

  it("a non-hex digest is malformed, and Buffer truncation cannot be used to shorten it", async () => {
    useSumsub();
    const provider = getIdentityProvider();
    const err = await thrown(() =>
      provider.handleWebhook({
        headers: { [SUMSUB_DIGEST_HEADER]: "zz".repeat(32), [SUMSUB_DIGEST_ALG_HEADER]: "HMAC_SHA256_HEX" },
        rawBody: REVIEWED_GREEN,
      }),
    );
    assert.equal((err as WebhookSignatureError)?.code, "signature_header_malformed");
  });

  it("no error message echoes the secret or the payload", async () => {
    useSumsub();
    const provider = getIdentityProvider();
    const err = await thrown(() =>
      provider.handleWebhook({
        headers: digestHeaders(REVIEWED_GREEN, "attacker-secret"),
        rawBody: REVIEWED_GREEN,
      }),
    );
    const msg = String((err as Error)?.message ?? "");
    assert.equal(msg.includes(SECRET), false);
    assert.equal(msg.includes("6410a1b2c3d4e5f60718293a"), false);
  });

  it("an irrelevant event type normalizes to null, and an unparseable body to null", async () => {
    useSumsub();
    const provider = getIdentityProvider();
    const other = JSON.stringify({ applicantId: "a", type: "applicantWorkflowCompleted", reviewStatus: "completed" });
    assert.equal(await provider.handleWebhook({ headers: digestHeaders(other, SECRET), rawBody: other }), null);
    const garbage = "{not json";
    assert.equal(
      await provider.handleWebhook({ headers: digestHeaders(garbage, SECRET), rawBody: garbage }),
      null,
    );
  });

  it("a LIVE (sandboxMode:false) event is refused unless live is explicitly allowed", () => {
    const live = { applicantId: "a", type: "applicantReviewed", reviewStatus: "completed", sandboxMode: false };
    delete process.env["PAYMENTS_ALLOW_LIVE"];
    assert.throws(() => normalizeSumsubWebhook(live), /payment|live/i);
    process.env["PAYMENTS_ALLOW_LIVE"] = "true";
    assert.doesNotThrow(() => normalizeSumsubWebhook(live));
    delete process.env["PAYMENTS_ALLOW_LIVE"];
    // An ABSENT flag is not a live claim.
    assert.doesNotThrow(() =>
      normalizeSumsubWebhook({ applicantId: "a", type: "applicantReviewed", reviewStatus: "completed" }),
    );
  });

  it("sumsub is in REAL_PROVIDER_NAMES, so the repo-wide TV-P5 suite quantifies over it", () => {
    assert.ok((REAL_PROVIDER_NAMES as readonly string[]).includes("sumsub"));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. INERT. The adapter exists and cannot be reached.
// ─────────────────────────────────────────────────────────────────────────────

describe("the provider is written, tested and UNREACHABLE", () => {
  it("the factory returns a sumsub adapter conforming to the shared interface", () => {
    useSumsub();
    const p = getIdentityProvider();
    assert.equal(p.name, "sumsub");
    for (const m of ["createSession", "handleWebhook", "getSessionStatus", "requestProviderDeletion"] as const) {
      assert.equal(typeof p[m], "function", m);
    }
  });

  it("…and identityProviderStatus still reports it NON-OPERATIONAL with a valid sandbox token", () => {
    const s = identityProviderStatus({
      IDENTITY_PROVIDER: "sumsub",
      SUMSUB_APP_TOKEN: "sbx:not-a-real-token",
      NODE_ENV: "production",
    } as any);
    assert.equal(s.operational, false, "IMPLEMENTED_PROVIDERS must still exclude sumsub");
    assert.equal(s.provider, "sumsub");
    assert.doesNotMatch(s.reason, /stub/i, "the adapter is not a stub — say what IS missing");
    assert.doesNotMatch(s.reason, /Unknown/i, "sumsub is a known provider, not a typo");
    assert.match(s.reason, /sandbox/i, "the reason must name the evidence that would open the gate");
    assert.match(s.reason, /IMPLEMENTED_PROVIDERS/, "and the switch that would open it");
  });

  it("…so every booking path is still refused with the global 503", async () => {
    const gate = await checkBookingKycGate(flagClient(), "PH", {
      status: () =>
        identityProviderStatus({
          IDENTITY_PROVIDER: "sumsub",
          SUMSUB_APP_TOKEN: "sbx:not-a-real-token",
          NODE_ENV: "production",
        } as any),
    });
    assert.equal(gate.allowed, false);
    assert.equal(gate.code, "verification_unavailable");
  });

  it("a LIVE app token is refused before certification is even considered", () => {
    const s = identityProviderStatus({
      IDENTITY_PROVIDER: "sumsub",
      SUMSUB_APP_TOKEN: "prd:a-production-token",
      NODE_ENV: "production",
    } as any);
    assert.equal(s.operational, false);
    assert.match(s.reason, /live key not allowed/i);
    assert.equal(s.reason.includes("prd:a-production-token"), false, "the key must never appear");
  });

  it("an UNRECOGNISED app-token prefix is refused too — being wrong about the format fails closed", () => {
    const s = identityProviderStatus({
      IDENTITY_PROVIDER: "sumsub",
      SUMSUB_APP_TOKEN: "sumsub_app_whatever",
      NODE_ENV: "production",
      PAYMENTS_ALLOW_LIVE: "true",
    } as any);
    assert.equal(s.operational, false);
    assert.match(s.reason, /unrecognised key/i);
  });

  it("no network and no credential: every REST path throws on the missing env first", async () => {
    useSumsub();
    delete process.env["SUMSUB_APP_TOKEN"];
    delete process.env["SUMSUB_SECRET_KEY"];
    delete process.env["SUMSUB_LEVEL_NAME_ID"];
    const p = getIdentityProvider();
    await assert.rejects(
      () => p.createSession({ userId: "u1", level: "id", returnUrl: "https://example.test/done" }),
      /SUMSUB_LEVEL_NAME_ID is not set/,
    );
    await assert.rejects(() => p.getSessionStatus("app_1"), /SUMSUB_APP_TOKEN is not set/);
    await assert.rejects(() => p.requestProviderDeletion("app_1"), /SUMSUB_APP_TOKEN is not set/);
    assert.throws(() => sumsubLevelName("id_selfie", {} as NodeJS.ProcessEnv), /SUMSUB_LEVEL_NAME_ID_SELFIE/);
  });

  it("the request signature is a pure function of its inputs (no env, no clock)", () => {
    const sig = signSumsubRequest({
      secret: "s3cr3t",
      timestampSeconds: 1_760_000_000,
      method: "post",
      pathWithQuery: "/resources/applicants?levelName=x",
      body: '{"externalUserId":"u1"}',
    });
    assert.equal(
      sig,
      crypto
        .createHmac("sha256", "s3cr3t")
        .update('1760000000POST/resources/applicants?levelName=x{"externalUserId":"u1"}', "utf8")
        .digest("hex"),
    );
    assert.match(sig, /^[0-9a-f]{64}$/);
  });
});

// A shape check that costs nothing and catches an accidental widening.
describe("the result shape is still the shared one", () => {
  it("VerificationResult gains no sumsub-specific field", () => {
    const r: VerificationResult = normalizeSumsubReview(
      { applicantId: "a", reviewStatus: "completed", reviewResult: { reviewAnswer: "GREEN" } },
      { nowMs: NOW },
    )!;
    const allowed = new Set([
      "provider",
      "providerSessionId",
      "providerVerificationRef",
      "status",
      "failureReason",
      "isOver18",
      "selfieMatch",
      "documentCountry",
      "verifiedAt",
    ]);
    for (const k of Object.keys(r)) {
      assert.ok(allowed.has(k), `unexpected field on the normalized result: ${k}`);
    }
  });
});
