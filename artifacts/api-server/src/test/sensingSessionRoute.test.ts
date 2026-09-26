/**
 * §3's ELIGIBILITY call — POST /v1/sensing/session — and the CONSENT it reads.
 *
 * The ingest (routes/sensingIngest.ts) authenticates an opaque credential and
 * nothing else. Until this route existed nothing issued one, so the ingest
 * could never receive a contribution. These cases pin the issuer's ladder and,
 * above all, what a person's recorded consent does and does not permit:
 *
 *   · the v1 disclosure ("Your Quick Signals can be combined…") describes no
 *     passive sensing, so it covers NO scope of the anonymous store — refused;
 *   · the v2 disclosure covers collect/retain/aggregate/surface, and the
 *     session carries its INTERSECTION with the policy in force — which today
 *     does not grant `surface`, so a v2 consenter still gets no `surface`;
 *   · a device may ask for fewer scopes than consented, never more;
 *   · the profile id authorises the call and is never written.
 *
 * RED WHEN the issuer admits a v1 consenter, stamps `surface` under a policy
 * that does not grant it, widens a request past consent, or writes an
 * identity onto the session row.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express, { type Express } from "express";

import sensingSessionRouter, { SENSING_SESSION_ISSUE_DAILY_LIMIT } from "../routes/sensingSession.js";
import { _setTestClient, _clearTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import { SENSING_PEPPER_ENV, SENSING_PEPPER_MIN_LENGTH } from "../lib/sensingAnonService.js";
import { deriveSensingCredentialHash } from "../lib/sensingAnonStore.js";
import {
  SENSING_ANON_GRANTED_SCOPES,
  SENSING_ANON_POLICY_V1,
  type IntelligenceContributionPolicy,
} from "../lib/sensingContributionPolicy.js";
import {
  SENSING_CONSENT_SCOPES,
  SENSING_CONSENT_V1,
  SENSING_CONSENT_V2,
  sensingScopesForConsent,
} from "../lib/sensingConsentScopes.js";
import { INTEL_CONSENT_DISCLOSURE_VERSION } from "../lib/intelConsent.js";

const USER = "5e5e5e5e-1111-4111-8111-111111111111";
const TOKEN = "account-token";
const GOOD_PEPPER = "p".repeat(SENSING_PEPPER_MIN_LENGTH);

type Consent = { enabled: boolean; consent_version: string | null; consented_at: string | null; withdrawn_at: string | null } | null;

function fakeClient(opts: { consent?: Consent; consentError?: boolean; insertError?: boolean } = {}) {
  const inserts: Array<Record<string, any>> = [];
  const tables: string[] = [];
  const client = {
    auth: {
      getUser: async (t: string) =>
        t === TOKEN ? { data: { user: { id: USER } }, error: null } : { data: { user: null }, error: { message: "Invalid" } },
    },
    from(table: string) {
      tables.push(table);
      const q: any = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => {
          if (table === "profiles") return { data: { account_status: "active" }, error: null };
          if (table === "intel_contribution_consent") {
            return opts.consentError ? { data: null, error: { message: "unreadable" } } : { data: opts.consent ?? null, error: null };
          }
          throw new Error(`the issuer read ${table}`);
        },
        insert: async (row: Record<string, any>) => {
          if (table !== "sensing_contribution_sessions") throw new Error(`the issuer wrote ${table}`);
          if (opts.insertError) return { data: null, error: { code: "42501", message: "denied" } };
          inserts.push(row);
          return { data: null, error: null };
        },
      };
      return q;
    },
  };
  return { client, inserts, tables };
}

const V1: Consent = { enabled: true, consent_version: SENSING_CONSENT_V1, consented_at: "2026-09-01T00:00:00.000Z", withdrawn_at: null };
const V2: Consent = { enabled: true, consent_version: SENSING_CONSENT_V2, consented_at: "2026-09-26T00:00:00.000Z", withdrawn_at: null };

function app(): Express {
  const a = express();
  a.use(express.json());
  a.use("/api", sensingSessionRouter);
  return a;
}

async function issue(body: unknown = {}, token: string | null = TOKEN): Promise<{ status: number; body: any }> {
  const server = createServer(app());
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port as number;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/sensing/session`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

let savedPepper: string | undefined;
function use(f: ReturnType<typeof fakeClient>) {
  _setTestClient(f.client, true);
  _setTestServiceClient(f.client as any);
}

beforeEach(() => {
  savedPepper = process.env[SENSING_PEPPER_ENV];
  process.env[SENSING_PEPPER_ENV] = GOOD_PEPPER;
  _resetRateLimit();
});
afterEach(() => {
  if (savedPepper === undefined) delete process.env[SENSING_PEPPER_ENV];
  else process.env[SENSING_PEPPER_ENV] = savedPepper;
  _clearTestClient();
  _setTestServiceClient(null);
});

describe("what a recorded consent covers (pure)", () => {
  const GRANTING: IntelligenceContributionPolicy = Object.freeze({
    ...SENSING_ANON_POLICY_V1,
    purposeScopes: [...SENSING_ANON_GRANTED_SCOPES, "surface"],
  }) as IntelligenceContributionPolicy;
  const state = (c: Consent) => (c ? { enabled: c.enabled, consentVersion: c.consent_version, withdrawnAt: c.withdrawn_at } : null);

  it("the v1 disclosure — Quick Signals only — covers NO passive-sensing scope", () => {
    assert.deepEqual([...SENSING_CONSENT_SCOPES[SENSING_CONSENT_V1]!], []);
    assert.deepEqual(sensingScopesForConsent(state(V1), GRANTING), { covered: false, reason: "disclosure_does_not_cover_passive_sensing" });
  });

  it("v2 under the policy IN FORCE: collect/retain/aggregate — `surface` is dropped because the policy does not grant it", () => {
    assert.deepEqual(sensingScopesForConsent(state(V2), SENSING_ANON_POLICY_V1), {
      covered: true, scopes: ["collect", "retain", "aggregate"], consentVersion: SENSING_CONSENT_V2,
    });
  });

  it("v2 under a policy that grants `surface`: surface is covered — BOTH the owner's policy and the person's consent permit it", () => {
    const r = sensingScopesForConsent(state(V2), GRANTING);
    assert.equal(r.covered, true);
    assert.deepEqual(r.covered && r.scopes, ["collect", "retain", "aggregate", "surface"]);
  });

  it("a granting POLICY does not rescue a v1 consenter: a policy is not consent", () => {
    assert.equal(sensingScopesForConsent(state(V1), GRANTING).covered, false);
  });

  it("withdrawn, disabled, absent and unknown-version consent cover nothing", () => {
    assert.deepEqual(sensingScopesForConsent(state({ ...V2!, withdrawn_at: "2026-09-26T01:00:00.000Z" }), GRANTING), { covered: false, reason: "withdrawn" });
    assert.deepEqual(sensingScopesForConsent(state({ ...V2!, enabled: false }), GRANTING), { covered: false, reason: "no_consent" });
    assert.deepEqual(sensingScopesForConsent(null, GRANTING), { covered: false, reason: "no_consent" });
    assert.equal(sensingScopesForConsent(state({ ...V2!, consent_version: "some_future_text" }), GRANTING).covered, false);
  });

  it("v2 is DEFINED, not in force: new grants are still stamped with v1, so nothing can record a v2 consent until the owner ships it", () => {
    assert.equal(INTEL_CONSENT_DISCLOSURE_VERSION, SENSING_CONSENT_V1);
  });
});

describe("POST /v1/sensing/session — the issuer's ladder", () => {
  it("refuses 503 and names the variable when the pepper is unset, before reading any identity", async () => {
    delete process.env[SENSING_PEPPER_ENV];
    const f = fakeClient({ consent: V2 });
    use(f);
    const r = await issue();
    assert.equal(r.status, 503);
    assert.match(JSON.stringify(r.body), new RegExp(SENSING_PEPPER_ENV));
    assert.equal(f.tables.length, 0);
    assert.equal(f.inserts.length, 0);
  });

  it("an unauthenticated caller is refused 401 and nothing is written", async () => {
    const f = fakeClient({ consent: V2 });
    use(f);
    assert.equal((await issue({}, null)).status, 401);
    assert.equal((await issue({}, "stranger")).status, 401);
    assert.equal(f.inserts.length, 0);
  });

  it("a v1 consenter — the ONLY consent anyone can hold today — is refused: the disclosure does not cover passive sensing", async () => {
    const f = fakeClient({ consent: V1 });
    use(f);
    const r = await issue();
    assert.equal(r.status, 403);
    assert.match(JSON.stringify(r.body), /disclosure_does_not_cover_passive_sensing/);
    assert.equal(f.inserts.length, 0);
  });

  it("no consent and withdrawn consent are refused; an unreadable consent is a db_error, never a grant", async () => {
    for (const [consent, reason] of [[null, "no_consent"], [{ ...V2!, withdrawn_at: "2026-09-26T02:00:00.000Z" }, "withdrawn"]] as const) {
      const f = fakeClient({ consent });
      use(f);
      const r = await issue();
      assert.equal(r.status, 403);
      assert.match(JSON.stringify(r.body), new RegExp(reason));
      assert.equal(f.inserts.length, 0);
    }
    const f = fakeClient({ consentError: true });
    use(f);
    const r = await issue();
    assert.equal(r.status, 500);
    assert.equal(f.inserts.length, 0);
  });

  it("a v2 consenter under the policy in force gets a session with collect/retain/aggregate — NOT surface — and the row names no one", async () => {
    const f = fakeClient({ consent: V2 });
    use(f);
    const r = await issue();
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(typeof r.body.credential, "string");
    assert.ok(r.body.credential.length >= 32);
    assert.deepEqual(r.body.purposeScopes, ["collect", "retain", "aggregate"]);
    assert.equal(f.inserts.length, 1);
    const row = f.inserts[0]!;
    assert.deepEqual(row.purpose_scopes, ["collect", "retain", "aggregate"]);
    assert.equal(row.credential_hash, deriveSensingCredentialHash(r.body.credential), "only the HMAC is stored");
    assert.equal(JSON.stringify(row).includes(r.body.credential), false, "the bearer itself is never stored");
    assert.equal(JSON.stringify(row).includes(USER), false, "the profile id authorises the call and is never written");
    for (const col of Object.keys(row)) assert.doesNotMatch(col, /user|profile|account|actor|device|issued_to/);
    assert.equal(row.issuance_class, "authenticated_profile");
  });

  it("a device may ask for FEWER scopes than consented, never more", async () => {
    const f = fakeClient({ consent: V2 });
    use(f);
    const fewer = await issue({ purposeScopes: ["collect", "retain"] });
    assert.equal(fewer.status, 201);
    assert.deepEqual(fewer.body.purposeScopes, ["collect", "retain"]);
    const more = await issue({ purposeScopes: ["collect", "surface"] });
    assert.equal(more.status, 403);
    assert.match(JSON.stringify(more.body), /scope_not_consented/);
    assert.equal(f.inserts.length, 1);
  });

  it("the per-profile budget bounds issuance", async () => {
    const f = fakeClient({ consent: V2 });
    use(f);
    for (let i = 0; i < SENSING_SESSION_ISSUE_DAILY_LIMIT; i++) assert.equal((await issue()).status, 201);
    const over = await issue();
    assert.equal(over.status, 429);
    assert.equal(f.inserts.length, SENSING_SESSION_ISSUE_DAILY_LIMIT);
  });

  it("a failed session write is a db_error and returns no credential", async () => {
    const f = fakeClient({ consent: V2, insertError: true });
    use(f);
    const r = await issue();
    assert.equal(r.status, 500);
    assert.equal(r.body?.credential, undefined);
  });
});
