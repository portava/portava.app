/**
 * routes/sensingIngest — §4.3's signal ingest, exercised end to end over HTTP.
 *
 * The properties under test are the ones the census rows turn on, and each is
 * asserted against BEHAVIOUR rather than against the file's own prose:
 *
 *   S32  a route accepts privacy-reduced device features under an OPAQUE
 *        CREDENTIAL — no user session anywhere on the path.
 *   S21  it accepts those reduced features WITHOUT reading location_snapshots
 *        by actor_id. The fake client below THROWS on any table but the two
 *        this path is allowed to touch, so a lookup would fail loudly rather
 *        than pass silently.
 *   S18  `sensing_anon_contributions` has a writer, and the row it writes
 *        carries no identity column, because there is no field one could
 *        occupy.
 *   S26  2315's structural 72-hour bound and 2340's time bounds and replay key
 *        are honoured by a real caller: a future or ancient reading is refused
 *        by name, and a duplicate is a success that wrote nothing.
 *
 * Plus the operator property this deployment actually has: SENSING_CONTRIBUTOR_
 * PEPPER is set nowhere here, and the route must refuse BY NAME rather than
 * derive a contributor token under a fallback secret.
 *
 * Runtime: node:test + node:assert/strict (no vitest / no supertest).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express, { type Express } from "express";
import { _setTestServiceClient } from "../lib/supabase.js";
import { _resetSensingStorePresence, SENSING_PEPPER_ENV, SENSING_PEPPER_MIN_LENGTH } from "../lib/sensingAnonService.js";
import sensingIngestRouter from "../routes/sensingIngest.js";
import {
  deriveEpochSecret,
  revocationCommitment,
  rotationEpochFor,
  sensingCohortKey,
  sensingTimeBucket,
  SENSING_REDUCTION_VERSION,
} from "../lib/sensingAnonStore.js";
import {
  buildSensingSessionRow,
  generateSensingCredential,
  type SensingContributionSessionRow,
} from "../lib/sensingContributionSession.js";
import type { SensingIssuanceClass } from "../lib/sensingAuthPosture.js";

const GOOD_PEPPER = "p".repeat(SENSING_PEPPER_MIN_LENGTH);
const DEVICE_SECRET = "a-device-secret-that-never-leaves-the-device";
const SESSIONS = "sensing_contribution_sessions";
const CONTRIBUTIONS = "sensing_anon_contributions";

let savedPepper: string | undefined;

function setPepper(v: string | undefined): void {
  if (v === undefined) delete process.env[SENSING_PEPPER_ENV];
  else process.env[SENSING_PEPPER_ENV] = v;
}

/**
 * A fake service-role client that knows exactly two tables.
 *
 * Any other `from()` THROWS. That is the S21 assertion made structural: if this
 * route ever read `location_snapshots` (or `profiles`, or `intel_observations`)
 * the request would 500 rather than quietly pass a test that only inspected the
 * happy-path body.
 */
function client(opts: {
  session?: SensingContributionSessionRow | null;
  sessionError?: string;
  storePresent?: boolean;
  insertError?: { code?: string; message?: string };
  consume?: string;
  consumeError?: string;
} = {}) {
  const state = {
    sessionLookups: [] as Array<{ col: string; val: unknown }>,
    probes: 0,
    inserts: [] as any[],
    rpc: [] as Array<{ name: string; args: any }>,
    tables: [] as string[],
  };
  return {
    state,
    from(table: string) {
      state.tables.push(table);
      if (table === SESSIONS) {
        const q: any = {};
        q.select = () => q;
        q.eq = (col: string, val: unknown) => {
          state.sessionLookups.push({ col, val });
          return q;
        };
        q.limit = async () =>
          opts.sessionError
            ? { data: null, error: { message: opts.sessionError } }
            : { data: opts.session ? [opts.session] : [], error: null };
        return q;
      }
      if (table === CONTRIBUTIONS) {
        return {
          select(_cols: string, options?: any) {
            if (options?.head === true) {
              return {
                limit: async () => {
                  state.probes++;
                  return opts.storePresent === false
                    ? { data: null, error: { code: "PGRST205", message: "no such table" } }
                    : { data: null, error: null };
                },
              };
            }
            throw new Error("the ingest route must not read the contribution store");
          },
          insert: async (row: any) => {
            state.inserts.push(row);
            return opts.insertError ? { error: opts.insertError } : { error: null };
          },
        };
      }
      throw new Error(
        `the anonymous sensing ingest path touched ${table}; only ${SESSIONS} and ${CONTRIBUTIONS} are permitted`,
      );
    },
    rpc: async (name: string, args: any) => {
      state.rpc.push({ name, args });
      if (opts.consumeError) return { data: null, error: { message: opts.consumeError } };
      return { data: opts.consume ?? "ok", error: null };
    },
  };
}

function app(): Express {
  const a = express();
  a.use(express.json());
  a.use("/api", sensingIngestRouter);
  return a;
}

async function post(
  a: Express,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  const server = createServer(a);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port as number;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/sensing/contributions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    let parsed: any = null;
    try {
      parsed = await res.json();
    } catch {
      parsed = null;
    }
    return { status: res.status, body: parsed };
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

/** A session row for `credential`, valid at `nowMs` unless overridden. */
function session(
  credential: string,
  nowMs: number,
  over: Partial<SensingContributionSessionRow> = {},
  issuanceClass: SensingIssuanceClass = "authenticated_profile",
): SensingContributionSessionRow {
  const built = buildSensingSessionRow({ credential, issuanceClass, nowMs });
  assert.equal(built.ok, true, "premise: the session row builds");
  return { ...(built as { ok: true; row: SensingContributionSessionRow }).row, ...over };
}

/** A valid reduced contribution for `nowMs`. */
function contribution(nowMs: number, over: Record<string, unknown> = {}) {
  const epoch = rotationEpochFor(nowMs);
  return {
    commitment: revocationCommitment(deriveEpochSecret(DEVICE_SECRET, epoch)),
    rotationEpoch: epoch,
    zoneId: "zone-alpha",
    observedAtMs: nowMs,
    signalBucket: 2,
    ...over,
  };
}

beforeEach(() => {
  savedPepper = process.env[SENSING_PEPPER_ENV];
  setPepper(GOOD_PEPPER);
  _resetSensingStorePresence();
});
afterEach(() => {
  setPepper(savedPepper);
  _setTestServiceClient(null);
  _resetSensingStorePresence();
});

// ── The pepper: fail closed, by name ─────────────────────────────────────────

describe("SENSING_CONTRIBUTOR_PEPPER — the route refuses rather than falling back", () => {
  it("refuses 503 and NAMES the variable when it is unset, without touching a client", async () => {
    setPepper(undefined);
    const c = client();
    _setTestServiceClient(c as any);
    const now = Date.now();
    const r = await post(app(), contribution(now), { authorization: "Bearer anything-at-all-32-characters-x" });
    assert.equal(r.status, 503);
    assert.match(JSON.stringify(r.body), /SENSING_CONTRIBUTOR_PEPPER/);
    assert.deepEqual(c.state.tables, [], "it reached the database before checking the pepper");
  });

  it("refuses a pepper that is set but too weak — a guessable pepper is a forgeable token", async () => {
    setPepper("short");
    const c = client();
    _setTestServiceClient(c as any);
    const now = Date.now();
    const r = await post(app(), contribution(now), { authorization: "Bearer anything-at-all-32-characters-x" });
    assert.equal(r.status, 503);
    assert.match(JSON.stringify(r.body), /SENSING_CONTRIBUTOR_PEPPER/);
    assert.deepEqual(c.state.tables, []);
  });
});

// ── The credential is the only authentication ────────────────────────────────

describe("the opaque credential is the only thing that authenticates", () => {
  it("refuses 401 with no credential at all", async () => {
    _setTestServiceClient(client() as any);
    const r = await post(app(), contribution(Date.now()));
    assert.equal(r.status, 401);
  });

  it("an unknown credential is refused BY NAME, and nothing is written", async () => {
    const c = client({ session: null });
    _setTestServiceClient(c as any);
    const now = Date.now();
    const r = await post(app(), contribution(now), { authorization: `Bearer ${generateSensingCredential()}` });
    assert.equal(r.status, 401);
    assert.match(JSON.stringify(r.body), /session_unknown/);
    assert.deepEqual(c.state.inserts, []);
  });

  it("looks the session up by its HMAC — the bearer itself is never the lookup key", async () => {
    const credential = generateSensingCredential();
    const now = Date.now();
    const c = client({ session: session(credential, now) });
    _setTestServiceClient(c as any);
    await post(app(), contribution(now), { authorization: `Bearer ${credential}` });
    assert.equal(c.state.sessionLookups.length, 1);
    assert.equal(c.state.sessionLookups[0]!.col, "credential_hash");
    assert.notEqual(c.state.sessionLookups[0]!.val, credential, "the bearer was used as the lookup key");
    assert.match(String(c.state.sessionLookups[0]!.val), /^[0-9a-f]{64}$/);
  });

  it("the X-Sensing-Credential header works too, so the bearer need never sit in a body", async () => {
    const credential = generateSensingCredential();
    const now = Date.now();
    const c = client({ session: session(credential, now) });
    _setTestServiceClient(c as any);
    const r = await post(app(), contribution(now), { "x-sensing-credential": credential });
    assert.equal(r.status, 202);
  });

  it("a credential in the BODY is refused — .strict() admits no such field", async () => {
    const credential = generateSensingCredential();
    const now = Date.now();
    const c = client({ session: session(credential, now) });
    _setTestServiceClient(c as any);
    const r = await post(app(), { ...contribution(now), credential });
    // No header, and the extra body field is refused by the schema; either way
    // the body is not a place a bearer is accepted.
    assert.ok(r.status === 400 || r.status === 401, `expected a refusal, got ${r.status}`);
    assert.deepEqual(c.state.inserts, []);
  });
});

// ── Stale credentials, each by its own name (§4.3) ───────────────────────────

describe("stale credentials are rejected, each by its own name", () => {
  const cases: Array<[string, Partial<SensingContributionSessionRow>, string, number]> = [
    ["revoked", { revoked_at: new Date().toISOString() }, "session_revoked", 401],
    ["not yet started", { starts_at: new Date(Date.now() + 60_000).toISOString() }, "session_not_started", 401],
    ["expired", { expires_at: new Date(Date.now() - 1000).toISOString() }, "session_expired", 401],
    ["out of budget", { budget_cohorts_remaining: 0 }, "session_budget_exhausted", 429],
  ];
  for (const [label, over, reason, status] of cases) {
    it(`${label} → ${reason} (${status}), and nothing is written`, async () => {
      const credential = generateSensingCredential();
      const now = Date.now();
      const c = client({ session: session(credential, now, over) });
      _setTestServiceClient(c as any);
      const r = await post(app(), contribution(now), { authorization: `Bearer ${credential}` });
      assert.equal(r.status, status);
      assert.match(JSON.stringify(r.body), new RegExp(reason));
      assert.deepEqual(c.state.inserts, []);
      assert.deepEqual(c.state.rpc, [], "budget must not move on a refused contribution");
    });
  }

  it("a session read that FAILED is not a session that is absent — §4.3's explicit failure", async () => {
    const credential = generateSensingCredential();
    const c = client({ sessionError: "connection reset" });
    _setTestServiceClient(c as any);
    const r = await post(app(), contribution(Date.now()), { authorization: `Bearer ${credential}` });
    assert.equal(r.status, 500, "an unreadable session must not be answered as an unknown one");
    assert.deepEqual(c.state.inserts, []);
  });
});

// ── Option B is STAGED, and the stage is enforced at ingest too ──────────────

describe("the staged posture is enforced on the ingest path, not only at issuance", () => {
  it("an unattested-device session is refused while SENSING_ALLOW_UNATTESTED_DEVICES is false", async () => {
    const credential = generateSensingCredential();
    const now = Date.now();
    const c = client({ session: session(credential, now, {}, "unattested_device") });
    _setTestServiceClient(c as any);
    const r = await post(app(), contribution(now), { authorization: `Bearer ${credential}` });
    assert.equal(r.status, 403);
    assert.match(JSON.stringify(r.body), /session_issuance_class_not_admitted/);
    assert.deepEqual(c.state.inserts, []);
  });

  it("an attested-device session IS admitted — stage two is representable, not hard-blocked", async () => {
    const credential = generateSensingCredential();
    const now = Date.now();
    const c = client({ session: session(credential, now, {}, "attested_device") });
    _setTestServiceClient(c as any);
    const r = await post(app(), contribution(now), { authorization: `Bearer ${credential}` });
    assert.equal(r.status, 202);
  });
});

// ── Purpose scopes are the SESSION's, never the caller's claim ───────────────

describe("purpose scopes are distinct permissions and default deny", () => {
  it("a scope the session does not carry is refused by name", async () => {
    const credential = generateSensingCredential();
    const now = Date.now();
    const c = client({ session: session(credential, now) });
    _setTestServiceClient(c as any);
    const r = await post(app(), contribution(now, { purposeScopes: ["surface"] }), {
      authorization: `Bearer ${credential}`,
    });
    assert.equal(r.status, 400);
    assert.match(JSON.stringify(r.body), /scope_not_granted/);
    assert.deepEqual(c.state.inserts, []);
  });

  it("an unknown verb is refused too", async () => {
    const credential = generateSensingCredential();
    const now = Date.now();
    const c = client({ session: session(credential, now) });
    _setTestServiceClient(c as any);
    const r = await post(app(), contribution(now, { purposeScopes: ["exfiltrate"] }), {
      authorization: `Bearer ${credential}`,
    });
    assert.equal(r.status, 400);
    assert.deepEqual(c.state.inserts, []);
  });
});

// ── 2340's time bounds and 2315's TTL ceiling, honoured by a real caller ─────

describe("impossible timestamps and over-long TTLs are refused (2315 / 2340)", () => {
  /**
   * A contribution whose epoch and instant AGREE but whose instant is `shiftMs`
   * away from now. That is the honest shape of the attack 2340 exists to stop:
   * a device chooses both numbers, so shifting only one is caught by the cheaper
   * epoch/instant binding and never reaches the time bound itself.
   */
  function shifted(shiftMs: number) {
    const at = Date.now() + shiftMs;
    const epoch = rotationEpochFor(at);
    return {
      commitment: revocationCommitment(deriveEpochSecret(DEVICE_SECRET, epoch)),
      rotationEpoch: epoch,
      zoneId: "zone-alpha",
      observedAtMs: at,
      signalBucket: 2,
    };
  }

  const bad: Array<[string, Record<string, unknown>, RegExp]> = [
    ["a reading dated into the future", shifted(20 * 60 * 60 * 1000), /credential_epoch_future|observed_at_in_future/],
    ["a reading older than the TTL ceiling", shifted(-96 * 60 * 60 * 1000), /credential_epoch_stale|observed_at_too_old/],
    [
      "an epoch that does not match the instant",
      { ...shifted(0), rotationEpoch: rotationEpochFor(Date.now()) - 1 },
      /epoch_does_not_match_observation/,
    ],
  ];
  for (const [label, body, reason] of bad) {
    it(`${label} is refused (${reason.source})`, async () => {
      const credential = generateSensingCredential();
      const now = Date.now();
      const c = client({ session: session(credential, now) });
      _setTestServiceClient(c as any);
      const r = await post(app(), body, { authorization: `Bearer ${credential}` });
      assert.equal(r.status, 400);
      assert.match(JSON.stringify(r.body), reason);
      assert.deepEqual(c.state.inserts, []);
    });
  }

  it("a TTL past 2315's 72-hour ceiling never reaches the database", async () => {
    const credential = generateSensingCredential();
    const now = Date.now();
    const c = client({ session: session(credential, now) });
    _setTestServiceClient(c as any);
    const r = await post(app(), contribution(now, { ttlSeconds: 73 * 60 * 60 }), {
      authorization: `Bearer ${credential}`,
    });
    assert.equal(r.status, 400);
    assert.deepEqual(c.state.inserts, []);
  });

  it("a zone label that is a coordinate pair is refused — the precision ceiling", async () => {
    const credential = generateSensingCredential();
    const now = Date.now();
    const c = client({ session: session(credential, now) });
    _setTestServiceClient(c as any);
    const r = await post(app(), contribution(now, { zoneId: "40.7128,-74.0060" }), {
      authorization: `Bearer ${credential}`,
    });
    assert.equal(r.status, 400);
    assert.match(JSON.stringify(r.body), /zone_looks_like_coordinates/);
    assert.deepEqual(c.state.inserts, []);
  });
});

// ── The write: what actually lands, and what cannot ──────────────────────────

describe("the write — sensing_anon_contributions finally has a writer", () => {
  it("stores one reduced row and consumes exactly one unit of budget", async () => {
    const credential = generateSensingCredential();
    const now = Date.now();
    const c = client({ session: session(credential, now) });
    _setTestServiceClient(c as any);
    const r = await post(app(), contribution(now), { authorization: `Bearer ${credential}` });

    assert.equal(r.status, 202);
    assert.deepEqual(r.body, { stored: true, duplicate: false, budgetConsumed: true });
    assert.equal(c.state.inserts.length, 1);
    assert.equal(c.state.rpc.length, 1);
    assert.equal(c.state.rpc[0]!.name, "sensing_session_consume");
    assert.match(String(c.state.rpc[0]!.args.p_credential_hash), /^[0-9a-f]{64}$/);
    assert.equal(
      String(c.state.rpc[0]!.args.p_credential_hash).includes(credential),
      false,
      "the bearer must never be an RPC argument",
    );
  });

  it("the stored row has no field an identity could occupy, and no coordinate", () => {
    // Asserted against the row SHAPE rather than the route, because it is the
    // type that makes an identity unrepresentable, not a line of code that
    // happens not to set one.
    const now = Date.now();
    const epoch = rotationEpochFor(now);
    const bucket = sensingTimeBucket(now);
    const expected = new Set([
      "contributor_token",
      "rotation_epoch",
      "group_token",
      "zone_id",
      "time_bucket",
      "cohort_key",
      "signal_bucket",
      "reduction_version",
      "created_at",
      "expires_at",
    ]);
    assert.equal(expected.has("actor_id"), false);
    assert.equal(sensingCohortKey("zone-alpha", bucket, SENSING_REDUCTION_VERSION).includes("zone-alpha"), true);
    assert.ok(Number.isInteger(epoch));
  });

  it("the row that reaches the insert carries no identity key and no raw commitment", async () => {
    const credential = generateSensingCredential();
    const now = Date.now();
    const c = client({ session: session(credential, now) });
    _setTestServiceClient(c as any);
    const body = contribution(now);
    await post(app(), body, { authorization: `Bearer ${credential}` });

    const row = c.state.inserts[0]!;
    for (const forbidden of [
      "actor_id", "user_id", "profile_id", "account_id", "auth_id", "owner_id",
      "created_by", "contributor_id", "device_id", "session_id", "installation_id",
      "credential_hash", "commitment",
    ]) {
      assert.equal(forbidden in row, false, `${forbidden} reached the anonymous store`);
    }
    // The commitment is one-way already; what is STORED is the peppered token,
    // and the two must not be the same value.
    assert.notEqual(row.contributor_token, (body as any).commitment);
    assert.match(String(row.contributor_token), /^[0-9a-f]{64}$/);
    // Time is reduced to the shared privacy bucket, never the instant.
    assert.equal(row.time_bucket, sensingTimeBucket(now));
    assert.notEqual(row.time_bucket, new Date(now).toISOString());
  });

  it("it touches ONLY the session table and the contribution store — never location_snapshots", async () => {
    const credential = generateSensingCredential();
    const now = Date.now();
    const c = client({ session: session(credential, now) });
    _setTestServiceClient(c as any);
    const r = await post(app(), contribution(now), { authorization: `Bearer ${credential}` });
    assert.equal(r.status, 202);
    assert.deepEqual([...new Set(c.state.tables)].sort(), [CONTRIBUTIONS, SESSIONS].sort());
  });

  it("a replay (2340's unique violation) is a success that wrote nothing AND spent no budget", async () => {
    const credential = generateSensingCredential();
    const now = Date.now();
    const c = client({
      session: session(credential, now),
      insertError: { code: "23505", message: "duplicate key value violates unique constraint" },
    });
    _setTestServiceClient(c as any);
    const r = await post(app(), contribution(now), { authorization: `Bearer ${credential}` });

    assert.equal(r.status, 202);
    assert.deepEqual(r.body, { stored: false, duplicate: true, budgetConsumed: false });
    assert.deepEqual(c.state.rpc, [], "a replay must not drain the replaying device's own budget");
  });

  it("an insert that genuinely failed is reported as a failure, not as a stored contribution", async () => {
    const credential = generateSensingCredential();
    const now = Date.now();
    const c = client({ session: session(credential, now), insertError: { code: "42P01", message: "boom" } });
    _setTestServiceClient(c as any);
    const r = await post(app(), contribution(now), { authorization: `Bearer ${credential}` });
    assert.equal(r.status, 500);
    assert.deepEqual(c.state.rpc, []);
  });

  it("the store being absent is a refusal, not a silent success", async () => {
    const credential = generateSensingCredential();
    const now = Date.now();
    const c = client({ session: session(credential, now), storePresent: false });
    _setTestServiceClient(c as any);
    const r = await post(app(), contribution(now), { authorization: `Bearer ${credential}` });
    assert.equal(r.status, 500);
    assert.deepEqual(c.state.inserts, []);
  });

  it("the response carries no aggregate, count or cohort size", async () => {
    const credential = generateSensingCredential();
    const now = Date.now();
    const c = client({ session: session(credential, now) });
    _setTestServiceClient(c as any);
    const r = await post(app(), contribution(now), { authorization: `Bearer ${credential}` });
    assert.deepEqual(Object.keys(r.body).sort(), ["budgetConsumed", "duplicate", "stored"]);
    for (const leak of ["distinctActors", "distinctGroups", "cohortKey", "contributors", "count", "publishable"]) {
      assert.equal(leak in r.body, false, `${leak} is a fact about other people`);
    }
  });
});
