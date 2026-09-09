/**
 * sensingAnonService — the three service-role bindings the owner ruling permits,
 * and the two preconditions that stand in front of them.
 *
 * The ruling's enumeration, verbatim: the anonymous store "may only own
 * privacy-reduced sensor contributions, rotating IDs, TTL, cohort/coverage
 * aggregation and revocation". These tests assert that this module does those
 * three things and refuses to do anything else — in particular that no identity
 * reaches the database on any path, and that a contribution can never be written
 * under the session-signing secret.
 *
 * THE PEPPER IS THE SUBJECT OF HALF THIS FILE, and that is proportionate. The
 * store falls back SENSING_CONTRIBUTOR_PEPPER -> INTEL_GROUP_KEY_SECRET ->
 * SESSION_SECRET, and only the third is configured anywhere in this repository.
 * Rotating a session secret is routine; rotating the pepper makes every prior
 * row unrevokable until it expires. So the property under test is not "a pepper
 * exists" but "the LIVE path refuses unless the DEDICATED one is set", which is
 * what makes those two facts stop being connected.
 *
 * No database, and no Supabase credential env var is named in this file.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SENSING_PEPPER_ENV,
  SENSING_PEPPER_MIN_LENGTH,
  sensingPepperPosture,
  sensingStorePresent,
  recordAnonSensingContribution,
  revokeAnonSensingContributions,
  assessSensingCohortCoverage,
  _resetSensingStorePresence,
} from "../lib/sensingAnonService.js";
import {
  deriveContributorToken,
  deriveEpochSecret,
  revocationCommitment,
  rotationEpochFor,
  sensingCohortKey,
  sensingTimeBucket,
  SENSING_REDUCTION_VERSION,
  type SensingContributionRow,
} from "../lib/sensingAnonStore.js";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STORE_TS = readFileSync(join(SRC, "lib", "sensingAnonStore.ts"), "utf8");
const SERVICE_TS = readFileSync(join(SRC, "lib", "sensingAnonService.ts"), "utf8");

const GOOD_PEPPER = "x".repeat(SENSING_PEPPER_MIN_LENGTH);
const DEVICE_SECRET = "device-secret-that-never-leaves-the-device";

let _saved: string | undefined;
function setPepper(v: string | undefined): void {
  if (v === undefined) delete process.env[SENSING_PEPPER_ENV];
  else process.env[SENSING_PEPPER_ENV] = v;
}

beforeEach(() => {
  _saved = process.env[SENSING_PEPPER_ENV];
  _resetSensingStorePresence();
  setPepper(GOOD_PEPPER);
});
afterEach(() => {
  setPepper(_saved);
  _resetSensingStorePresence();
});

/**
 * A fake service-role client. The presence probe is the HEAD select; the cohort
 * read is the counted select; the write is an insert; revocation and the sweep
 * are RPCs. Everything the fake records is asserted on somewhere below.
 */
function client(
  opts: {
    present?: boolean;
    rows?: SensingContributionRow[];
    readError?: string;
    insertError?: string;
    revoked?: number | string;
    rpcError?: string;
  } = {},
) {
  const present = opts.present !== false;
  const state = { probes: 0, inserts: [] as any[], rpc: [] as Array<{ name: string; args: any }>, reads: [] as any[] };
  return {
    state,
    from(table: string) {
      assert.equal(table, "sensing_anon_contributions");
      return {
        select(_cols: string, options?: any) {
          if (options?.head === true) {
            return {
              limit: async () => {
                state.probes++;
                return present
                  ? { data: null, error: null }
                  : { data: null, error: { code: "PGRST205", message: "Could not find the table in the schema cache" } };
              },
            };
          }
          const q: any = {};
          q.eq = (col: string, val: any) => {
            state.reads.push({ col, val });
            return q;
          };
          q.gt = () => q;
          q.limit = async () =>
            opts.readError
              ? { data: null, error: { message: opts.readError }, count: 4242 }
              : { data: opts.rows ?? [], error: null, count: (opts.rows ?? []).length };
          return q;
        },
        insert: async (row: any) => {
          state.inserts.push(row);
          return opts.insertError ? { error: { message: opts.insertError } } : { error: null };
        },
      };
    },
    rpc: async (name: string, args: any) => {
      state.rpc.push({ name, args });
      if (opts.rpcError) return { data: null, error: { message: opts.rpcError } };
      return { data: opts.revoked ?? 0, error: null };
    },
  };
}

/** A valid contribution for `nowMs`, with the epoch the observation actually falls in. */
function contribution(nowMs: number, over: Partial<Record<string, any>> = {}) {
  const epoch = rotationEpochFor(nowMs);
  return {
    commitment: revocationCommitment(deriveEpochSecret(DEVICE_SECRET, epoch)),
    rotationEpoch: epoch,
    zoneId: "zone-alpha",
    observedAtMs: nowMs,
    signalBucket: 2,
    ...over,
  } as any;
}

// ── The pepper gate ──────────────────────────────────────────────────────────

describe("the pepper gate — the dedicated secret, or nothing is written", () => {
  it("the store really does read this variable first, so requiring it here binds the derivation", () => {
    // The whole equivalence argument is: SENSING_CONTRIBUTOR_PEPPER is FIRST in
    // the store's chain, so requiring it here means every token this server
    // derives is keyed under it. If the store stopped reading it first, that
    // argument would silently become false.
    const chain = STORE_TS.slice(STORE_TS.indexOf("function sensingPepper"));
    const first = chain.indexOf(SENSING_PEPPER_ENV);
    const session = chain.indexOf("SESSION_SECRET");
    const group = chain.indexOf("INTEL_GROUP_KEY_SECRET");
    assert.ok(first >= 0, "the store no longer reads the dedicated pepper at all");
    assert.ok(first < group && first < session, "the dedicated pepper is no longer first in the fallback chain");
  });

  it("the store's fail-closed throw is intact — there is still no constant fallback", () => {
    assert.match(STORE_TS, /throw new Error\([\s\S]{0,200}no fallback/);
  });

  it("refuses when the pepper is unset — and does not even build a client", async () => {
    setPepper(undefined);
    const c = client();
    const r = await recordAnonSensingContribution(contribution(Date.now()), { client: c });
    assert.deepEqual(r, { ok: false, reason: "pepper_unconfigured" });
    assert.equal(c.state.probes, 0, "it touched the database before checking the precondition");
    assert.deepEqual(c.state.inserts, []);
  });

  it("refuses a blank pepper — a whitespace secret is an unset one", async () => {
    setPepper("   ");
    const r = await recordAnonSensingContribution(contribution(Date.now()), { client: client() });
    assert.equal(r.ok, false);
    assert.equal((r as any).reason, "pepper_unconfigured");
  });

  it("refuses a pepper below the length floor — a guessable pepper is a forgeable token", async () => {
    setPepper("short");
    const r = await recordAnonSensingContribution(contribution(Date.now()), { client: client() });
    assert.equal((r as any).reason, "pepper_too_weak");
    assert.equal(sensingPepperPosture().ok, false);
  });

  it("does NOT accept the SESSION_SECRET fallback the store allows for its own tests", async () => {
    // This is the point of the gate. The store may fall back so a unit test can
    // derive a token; the live path may not, or an ordinary session-secret
    // rotation would silently make every prior contribution unrevokable.
    setPepper(undefined);
    const savedSession = process.env["SESSION_SECRET"];
    const savedGroup = process.env["INTEL_GROUP_KEY_SECRET"];
    process.env["SESSION_SECRET"] = "a".repeat(64);
    process.env["INTEL_GROUP_KEY_SECRET"] = "b".repeat(64);
    try {
      const c = client();
      assert.equal((await recordAnonSensingContribution(contribution(Date.now()), { client: c }) as any).reason, "pepper_unconfigured");
      assert.equal(
        (await revokeAnonSensingContributions({ rotationEpoch: 1, epochSecret: "s" }, { client: c }) as any).reason,
        "pepper_unconfigured",
      );
      assert.deepEqual(c.state.inserts, []);
      assert.deepEqual(c.state.rpc, []);
    } finally {
      if (savedSession === undefined) delete process.env["SESSION_SECRET"];
      else process.env["SESSION_SECRET"] = savedSession;
      if (savedGroup === undefined) delete process.env["INTEL_GROUP_KEY_SECRET"];
      else process.env["INTEL_GROUP_KEY_SECRET"] = savedGroup;
    }
  });

  it("aggregation does NOT require the pepper — it counts stored tokens and derives nothing", async () => {
    setPepper(undefined);
    const r = await assessSensingCohortCoverage(
      { zoneId: "zone-alpha", observedAtMs: Date.parse("2026-09-07T12:00:00.000Z") },
      { client: client() },
    );
    assert.equal(r.ok, true, "a coverage read failed for a reason that has nothing to do with it");
  });

  it("no log line anywhere in this module can carry a credential", () => {
    // A revocation secret in a log IS the credential, and a log is not a place a
    // contributor agreed their proof would be kept. Checked structurally rather
    // than by reading, because the hazard is a future `{ err }` that widens to
    // include the caller's input object.
    setPepper(GOOD_PEPPER);
    assert.deepEqual(sensingPepperPosture(), { ok: true });
    const calls = SERVICE_TS.match(/logger\.[a-z]+\([\s\S]*?\);/g) ?? [];
    assert.ok(calls.length > 0, "premise: this module logs at all");
    for (const call of calls) {
      for (const secret of ["epochSecret", "commitment", "contributor_token", "deviceSecret", "pepper"]) {
        assert.ok(!call.includes(secret), `a log line names ${secret}`);
      }
    }
  });
});

// ── The presence precondition ────────────────────────────────────────────────

describe("the store must exist — 2315 is applied to CI and not to production", () => {
  it("an absent store refuses every write and revocation without attempting one", async () => {
    const c = client({ present: false });
    assert.equal((await recordAnonSensingContribution(contribution(Date.now()), { client: c }) as any).reason, "store_absent");
    _resetSensingStorePresence();
    assert.equal(
      (await revokeAnonSensingContributions({ rotationEpoch: 1, epochSecret: "s" }, { client: c }) as any).reason,
      "store_absent",
    );
    assert.deepEqual(c.state.inserts, [], "inserted into a database with no such table");
    assert.deepEqual(c.state.rpc, [], "called an RPC that does not exist there");
  });

  it("no client is a distinct refusal from an absent store", async () => {
    assert.equal((await recordAnonSensingContribution(contribution(Date.now()), { client: null }) as any).reason, "no_client");
    assert.equal(await sensingStorePresent(null), false);
  });

  it("the probe returns no rows — looking for the table must not read anybody's data", async () => {
    // The fake asserts `head: true` on the probe path; reaching here at all
    // proves the select was a HEAD read.
    const c = client({ present: true });
    assert.equal(await sensingStorePresent(c), true);
    assert.equal(c.state.probes, 1);
  });

  it("a thrown probe answers absent rather than propagating", async () => {
    const throwing = { from: () => { throw new Error("network down"); } };
    assert.equal(await sensingStorePresent(throwing), false);
  });
});

// ── 1. Writing a contribution ────────────────────────────────────────────────

describe("recording a contribution from a service-role process", () => {
  const NOW = Date.parse("2026-09-07T12:34:56.000Z");

  it("writes exactly the ten columns it may write, and nothing that could be an identity", async () => {
    const c = client();
    const r = await recordAnonSensingContribution(contribution(NOW), { client: c, nowMs: NOW });
    assert.deepEqual(r, { ok: true, duplicate: false });
    assert.equal(c.state.inserts.length, 1);
    const row = c.state.inserts[0];
    assert.deepEqual(
      Object.keys(row).sort(),
      [
        "cohort_key", "contributor_token", "created_at", "expires_at", "group_token",
        "reduction_version", "rotation_epoch", "signal_bucket", "time_bucket", "zone_id",
      ],
    );
    for (const forbidden of ["user_id", "actor_id", "profile_id", "account_id", "device_id", "session_id", "installation_id"]) {
      assert.ok(!(forbidden in row), `${forbidden} reached the write payload`);
    }
    // Neither the device's secret nor the commitment it sent is stored.
    const serialised = JSON.stringify(row);
    assert.ok(!serialised.includes(DEVICE_SECRET), "a device secret reached the database");
    assert.ok(!serialised.includes(contribution(NOW).commitment), "the raw commitment was stored instead of the peppered token");
  });

  it("stores the peppered token, which the commitment alone cannot produce", async () => {
    const c = client();
    const input = contribution(NOW);
    await recordAnonSensingContribution(input, { client: c, nowMs: NOW });
    assert.equal(
      c.state.inserts[0].contributor_token,
      deriveContributorToken(input.rotationEpoch, input.commitment),
    );
    // A different pepper would produce a different token — that is the whole
    // reason the pepper must not be a rotating session secret.
    setPepper("z".repeat(SENSING_PEPPER_MIN_LENGTH));
    assert.notEqual(
      c.state.inserts[0].contributor_token,
      deriveContributorToken(input.rotationEpoch, input.commitment),
    );
  });

  it("earns no group credit without a group tag — a contributor is never inferred to be a party", async () => {
    const c = client();
    await recordAnonSensingContribution(contribution(NOW), { client: c, nowMs: NOW });
    assert.equal(c.state.inserts[0].group_token, null);
  });

  it("names an input refusal as invalid_input, distinct from a database failure", async () => {
    const c = client();
    const bad = await recordAnonSensingContribution(
      contribution(NOW, { ttlSeconds: 100 * 60 * 60 }),
      { client: c, nowMs: NOW },
    );
    assert.equal((bad as any).reason, "invalid_input");
    assert.equal((bad as any).error, "ttl_exceeds_maximum");
    assert.deepEqual(c.state.inserts, [], "a refused input still reached the database");

    _resetSensingStorePresence();
    const failing = client({ insertError: "23514 check constraint" });
    const r = await recordAnonSensingContribution(contribution(NOW), { client: failing, nowMs: NOW });
    assert.equal((r as any).reason, "error");
  });

  it("refuses an epoch that is not the epoch the observation falls in", async () => {
    const c = client();
    const r = await recordAnonSensingContribution(
      contribution(NOW, { rotationEpoch: rotationEpochFor(NOW) + 5 }),
      { client: c, nowMs: NOW },
    );
    assert.equal((r as any).error, "epoch_does_not_match_observation");
    assert.deepEqual(c.state.inserts, []);
  });
});

// ── 2. Revocation ────────────────────────────────────────────────────────────

describe("revocation — the proof is a preimage, never an identity", () => {
  const EPOCH = rotationEpochFor(Date.parse("2026-09-07T12:00:00.000Z"));
  const epochSecret = deriveEpochSecret(DEVICE_SECRET, EPOCH);

  it("re-derives the stored token server-side and deletes by (epoch, token)", async () => {
    const c = client({ revoked: 3 });
    const r = await revokeAnonSensingContributions({ rotationEpoch: EPOCH, epochSecret }, { client: c });
    assert.deepEqual(r, { ok: true, revoked: 3 });
    assert.equal(c.state.rpc.length, 1);
    assert.equal(c.state.rpc[0]!.name, "revoke_sensing_contributions");
    assert.deepEqual(c.state.rpc[0]!.args, {
      p_rotation_epoch: EPOCH,
      p_contributor_token: deriveContributorToken(EPOCH, revocationCommitment(epochSecret)),
    });
  });

  it("the revealed secret NEVER leaves the server — only the derived token is sent", async () => {
    const c = client({ revoked: 1 });
    await revokeAnonSensingContributions({ rotationEpoch: EPOCH, epochSecret }, { client: c });
    const sent = JSON.stringify(c.state.rpc[0]!.args);
    assert.ok(!sent.includes(epochSecret), "the epoch secret was transmitted to the database");
    assert.ok(!sent.includes(DEVICE_SECRET), "the device secret was transmitted to the database");
    assert.ok(!sent.includes(revocationCommitment(epochSecret)), "the raw commitment was sent instead of the token");
  });

  it("the payload has exactly two fields, and neither could hold an account", async () => {
    const c = client();
    await revokeAnonSensingContributions({ rotationEpoch: EPOCH, epochSecret }, { client: c });
    const args = c.state.rpc[0]!.args;
    assert.deepEqual(Object.keys(args).sort(), ["p_contributor_token", "p_rotation_epoch"]);
    for (const forbidden of ["user", "actor", "profile", "account", "auth", "device", "session"]) {
      assert.ok(!Object.keys(args).some((k) => k.toLowerCase().includes(forbidden)), `revocation carries a ${forbidden}`);
    }
  });

  it("knowing the STORED token is not enough — the credential is the preimage", async () => {
    // Hand the service the stored token where an epoch secret belongs. It hashes
    // whatever it is given, so the derived target does not match the stored row:
    // an attacker reading the table cannot erase anyone's contributions.
    const stored = deriveContributorToken(EPOCH, revocationCommitment(epochSecret));
    const c = client();
    await revokeAnonSensingContributions({ rotationEpoch: EPOCH, epochSecret: stored }, { client: c });
    assert.notEqual(c.state.rpc[0]!.args.p_contributor_token, stored);
  });

  it("revealing one epoch reveals no other — revocation is scoped, not total", () => {
    const other = deriveEpochSecret(DEVICE_SECRET, EPOCH + 1);
    assert.notEqual(
      deriveContributorToken(EPOCH, revocationCommitment(epochSecret)),
      deriveContributorToken(EPOCH + 1, revocationCommitment(other)),
    );
  });

  it("zero rows revoked is a SUCCESS — nothing of that device-epoch was still stored", async () => {
    const r = await revokeAnonSensingContributions({ rotationEpoch: EPOCH, epochSecret }, { client: client({ revoked: 0 }) });
    assert.deepEqual(r, { ok: true, revoked: 0 });
  });

  it("counts a bigint returned as a STRING — a contributor must not be told nothing was erased", async () => {
    // PostgREST does not always emit int8 as a JSON number; the store used to
    // type-check rather than coerce, which reported 0 for every successful
    // revocation. That is the worst possible direction for this particular
    // number: it tells someone their withdrawal did nothing.
    const r = await revokeAnonSensingContributions({ rotationEpoch: EPOCH, epochSecret }, { client: client({ revoked: "12" }) });
    assert.deepEqual(r, { ok: true, revoked: 12 });
  });

  it("a malformed revocation is refused before any RPC", async () => {
    const c = client();
    const r = await revokeAnonSensingContributions({ rotationEpoch: -1, epochSecret } as any, { client: c });
    assert.equal(r.ok, false);
    assert.deepEqual(c.state.rpc, []);
  });

  it("an rpc failure is an error, never a claimed revocation", async () => {
    const r = await revokeAnonSensingContributions(
      { rotationEpoch: EPOCH, epochSecret },
      { client: client({ rpcError: "permission denied" }) },
    );
    assert.equal(r.ok, false);
    assert.equal((r as any).reason, "error");
  });
});

// ── 3. Cohort / coverage aggregation ─────────────────────────────────────────

describe("cohort aggregation — a decision, and never a publication", () => {
  const NOW = Date.parse("2026-09-07T12:34:56.000Z");

  function row(token: string, group: string | null): SensingContributionRow {
    return {
      contributor_token: token,
      rotation_epoch: rotationEpochFor(NOW),
      group_token: group,
      zone_id: "zone-alpha",
      time_bucket: sensingTimeBucket(NOW),
      cohort_key: sensingCohortKey("zone-alpha", sensingTimeBucket(NOW), SENSING_REDUCTION_VERSION),
      signal_bucket: 2,
      reduction_version: SENSING_REDUCTION_VERSION,
      created_at: new Date(NOW - 60_000).toISOString(),
      expires_at: new Date(NOW + 3_600_000).toISOString(),
    };
  }

  it("reads the cohort the writer would have written, by the same derived key", async () => {
    const c = client({ rows: [] });
    const r = await assessSensingCohortCoverage({ zoneId: "Zone-Alpha", observedAtMs: NOW }, { client: c, nowMs: NOW });
    assert.equal(r.ok, true);
    const expected = sensingCohortKey("zone-alpha", sensingTimeBucket(NOW), SENSING_REDUCTION_VERSION);
    assert.equal((r as any).cohortKey, expected);
    assert.deepEqual(c.state.reads, [{ col: "cohort_key", val: expected }]);
  });

  it("counts CONTRIBUTORS, not rows — one device that sent forty readings is one person", async () => {
    const rows = [row("tok-a", null), row("tok-a", null), row("tok-a", null), row("tok-b", null)];
    const r = await assessSensingCohortCoverage({ zoneId: "zone-alpha", observedAtMs: NOW }, { client: client({ rows }), nowMs: NOW });
    assert.equal((r as any).aggregate.distinctActors, 2);
    assert.equal((r as any).aggregate.contributions, 4);
  });

  it("refuses a small cohort with the shared gate's own reason", async () => {
    const rows = [row("tok-a", null), row("tok-b", null)];
    const agg = (await assessSensingCohortCoverage({ zoneId: "zone-alpha", observedAtMs: NOW }, { client: client({ rows }), nowMs: NOW }) as any).aggregate;
    assert.equal(agg.publishable, false);
    assert.equal(agg.reason, "below_actor_threshold");
  });

  it('"we could not look" is never collapsed into "there were too few people"', async () => {
    // The distinction lib/sensingCoverageAggregate exists to preserve. A read
    // that FAILED still returns ok:true here, with the aggregation's own
    // read_failed reason — an outage must not hide behind a privacy suppression.
    const failed = await assessSensingCohortCoverage(
      { zoneId: "zone-alpha", observedAtMs: NOW },
      { client: client({ readError: "connection reset" }), nowMs: NOW },
    );
    assert.equal(failed.ok, true);
    assert.equal((failed as any).aggregate.reason, "read_failed");
    assert.equal((failed as any).aggregate.distinctActors, 0);

    // Whereas never having looked is ok:false, a different fact entirely.
    _resetSensingStorePresence();
    const absent = await assessSensingCohortCoverage({ zoneId: "zone-alpha", observedAtMs: NOW }, { client: client({ present: false }) });
    assert.equal(absent.ok, false);
    assert.equal((absent as any).reason, "store_absent");
  });

  it("never reads the transport's claimed count", async () => {
    // The fake returns count: 4242 alongside the failure. A cohort size that
    // describes rows nobody looked at is inflation in its purest form.
    const r = await assessSensingCohortCoverage(
      { zoneId: "zone-alpha", observedAtMs: NOW },
      { client: client({ readError: "boom" }), nowMs: NOW },
    );
    assert.equal((r as any).aggregate.distinctActors, 0);
    assert.equal((r as any).aggregate.contributions, 0);
  });

  it("publishes nothing — the module returns a decision and has no writer", () => {
    const section = SERVICE_TS.slice(SERVICE_TS.indexOf("export async function assessSensingCohortCoverage"));
    assert.ok(!/\.insert\(|\.upsert\(|\.update\(/.test(section), "the aggregation writes somewhere");
  });

  it("restates no threshold of its own", () => {
    const code = SERVICE_TS.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    for (const literal of ["minUniqueActors", "minIndependentGroups", "maxSingleGroupShare", "meetsKAnonymity"]) {
      assert.ok(!code.includes(literal), `the privacy threshold "${literal}" is restated here`);
    }
  });
});
