/**
 * §3's ELIGIBILITY call — POST /v1/sensing/session — and the CONSENT it reads.
 *
 * The ingest (routes/sensingIngest.ts) authenticates an opaque credential and
 * nothing else; this route is the only issuer of one. These cases pin the
 * issuer's ladder and, above all, what a person's consents do and do not
 * permit. Since wave 6 (OD-MAP-6, migration 3703) the consent is THREE
 * separate grants — capture, upload, surface — behind
 * `sensing_consent_split_enabled` (seeded FALSE):
 *
 *   · flag off or absent → refused, whatever is recorded; flag unreadable →
 *     "try again", never a session;
 *   · a session is permission to upload, so it needs capture AND upload, each
 *     granted under the wording in force; either missing → refused by name;
 *   · `surface` rides only on its own grant AND the policy in force, which
 *     today does not grant it;
 *   · a device may ask for fewer scopes than consented, never more;
 *   · the profile id authorises the call and is never written.
 *
 * The pure cases of lib/sensingConsentScopes (the bundled v1/v2 reading the
 * issuer USED to apply) stay below as a record of that module; the issuer no
 * longer reads it.
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
import { SENSING_CONSENT_DISCLOSURE_VERSIONS } from "../lib/sensingConsentGrants.js";

const USER = "5e5e5e5e-1111-4111-8111-111111111111";
const TOKEN = "account-token";
const GOOD_PEPPER = "p".repeat(SENSING_PEPPER_MIN_LENGTH);

type Consent = { enabled: boolean; consent_version: string | null; consented_at: string | null; withdrawn_at: string | null } | null;

type GrantRow = { scope: string; disclosure_version: string; granted_at: string; withdrawn_at: string | null };
const G = (scope: "capture" | "upload" | "surface", over: Partial<GrantRow> = {}): GrantRow => ({
  scope, disclosure_version: SENSING_CONSENT_DISCLOSURE_VERSIONS[scope], granted_at: "2026-10-06T00:00:00.000Z", withdrawn_at: null, ...over,
});
const CAPTURE_UPLOAD = [G("capture"), G("upload")];

function fakeClient(opts: { grants?: GrantRow[]; grantsError?: boolean; flag?: boolean | null | "error"; insertError?: boolean } = {}) {
  const inserts: Array<Record<string, any>> = [];
  const tables: string[] = [];
  const flag = opts.flag === undefined ? true : opts.flag;
  const client = {
    auth: {
      getUser: async (t: string) =>
        t === TOKEN ? { data: { user: { id: USER } }, error: null } : { data: { user: null }, error: { message: "Invalid" } },
    },
    from(table: string) {
      tables.push(table);
      const result = () => {
        if (table === "sensing_consent_grants") {
          return opts.grantsError ? { data: null, error: { message: "unreadable", code: "XX000" } } : { data: opts.grants ?? [], error: null };
        }
        throw new Error(`the issuer read ${table} as a list`);
      };
      const q: any = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => {
          if (table === "profiles") return { data: { account_status: "active" }, error: null };
          if (table === "feature_flags") {
            if (flag === "error") return { data: null, error: { message: "unreadable", code: "XX000" } };
            return { data: flag === null ? null : { enabled: flag }, error: null };
          }
          throw new Error(`the issuer read ${table}`);
        },
        then: (ok: any, bad: any) => Promise.resolve().then(result).then(ok, bad),
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
    const f = fakeClient({ grants: CAPTURE_UPLOAD });
    use(f);
    const r = await issue();
    assert.equal(r.status, 503);
    assert.match(JSON.stringify(r.body), new RegExp(SENSING_PEPPER_ENV));
    assert.equal(f.tables.length, 0);
    assert.equal(f.inserts.length, 0);
  });

  it("an unauthenticated caller is refused 401 and nothing is written", async () => {
    const f = fakeClient({ grants: CAPTURE_UPLOAD });
    use(f);
    assert.equal((await issue({}, null)).status, 401);
    assert.equal((await issue({}, "stranger")).status, 401);
    assert.equal(f.inserts.length, 0);
  });

  it("with the split flag OFF or ABSENT nothing is issued, whatever is recorded; an UNREADABLE flag is 'try again'", async () => {
    for (const flag of [false, null] as const) {
      const f = fakeClient({ grants: CAPTURE_UPLOAD, flag });
      use(f);
      const r = await issue();
      assert.equal(r.status, 404, `flag=${flag}`); // feature_disabled
      assert.equal(f.inserts.length, 0);
      assert.ok(!f.tables.includes("sensing_consent_grants"), "no consent is read while the feature is off");
    }
    const f = fakeClient({ grants: CAPTURE_UPLOAD, flag: "error" });
    use(f);
    const r = await issue();
    assert.equal(r.status, 503);
    assert.equal(f.inserts.length, 0);
  });

  it("the general intel consent grants nothing here: with no sensing grants the issuer refuses by name", async () => {
    const f = fakeClient({ grants: [] });
    use(f);
    const r = await issue();
    assert.equal(r.status, 403);
    assert.match(JSON.stringify(r.body), /capture_not_granted/);
    assert.ok(!f.tables.includes("intel_contribution_consent"), "the bundled intel consent is not consulted");
    assert.equal(f.inserts.length, 0);
  });

  it("capture without upload, upload without capture, a withdrawn grant and a grant under OLD wording are each refused", async () => {
    const cases: Array<[GrantRow[], RegExp]> = [
      [[G("capture")], /upload_not_granted/],
      [[G("upload")], /capture_not_granted/],
      [[G("capture"), G("upload", { withdrawn_at: "2026-10-06T01:00:00.000Z" })], /upload_not_granted/],
      [[G("capture", { disclosure_version: "sensing_capture_v0" }), G("upload")], /capture_not_granted/],
    ];
    for (const [grants, why] of cases) {
      const f = fakeClient({ grants });
      use(f);
      const r = await issue();
      assert.equal(r.status, 403, JSON.stringify(grants));
      assert.match(JSON.stringify(r.body), why);
      assert.equal(f.inserts.length, 0);
    }
  });

  it("an unreadable grants table is a db_error, never a session", async () => {
    const f = fakeClient({ grantsError: true });
    use(f);
    const r = await issue();
    assert.equal(r.status, 500);
    assert.equal(f.inserts.length, 0);
  });

  it("capture + upload under the policy in force gets collect/retain/aggregate — and the row names no one", async () => {
    const f = fakeClient({ grants: CAPTURE_UPLOAD });
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

  it("the SURFACE grant does not add `surface` while the policy in force does not grant it", async () => {
    const f = fakeClient({ grants: [...CAPTURE_UPLOAD, G("surface")] });
    use(f);
    const r = await issue();
    assert.equal(r.status, 201);
    assert.deepEqual(r.body.purposeScopes, ["collect", "retain", "aggregate"]);
    const asked = await issue({ purposeScopes: ["collect", "surface"] });
    assert.equal(asked.status, 403);
    assert.match(JSON.stringify(asked.body), /scope_not_consented/);
  });

  it("a device may ask for FEWER scopes than consented, never more", async () => {
    const f = fakeClient({ grants: CAPTURE_UPLOAD });
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
    const f = fakeClient({ grants: CAPTURE_UPLOAD });
    use(f);
    for (let i = 0; i < SENSING_SESSION_ISSUE_DAILY_LIMIT; i++) assert.equal((await issue()).status, 201);
    const over = await issue();
    assert.equal(over.status, 429);
    assert.equal(f.inserts.length, SENSING_SESSION_ISSUE_DAILY_LIMIT);
  });

  it("a failed session write is a db_error and returns no credential", async () => {
    const f = fakeClient({ grants: CAPTURE_UPLOAD, insertError: true });
    use(f);
    const r = await issue();
    assert.equal(r.status, 500);
    assert.equal(r.body?.credential, undefined);
  });
});
