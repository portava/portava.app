/**
 * S39 — the consumer for `buildSensingPresenceState`, and the decision that
 * keeps it dark.
 *
 * The census: the presence aggregate is correct and *"no surface consumes it.
 * RED WHEN decision #9 is taken and a surface reads
 * `buildSensingPresenceState`"*.
 *
 * DECISION #9 IS NOT TAKEN. It is the ninth row of
 * `docs/architecture/sensing-input-gap.md` §3.2 — "Publishing any aggregate to
 * a user-visible surface" — and this file asserts that state of affairs rather
 * than assuming it, so the day it changes this test says so.
 *
 * So the row is NOT closed here, and this suite is careful about what it does
 * claim. It proves three things:
 *
 *   1. `compass/CompassSensingPresence` really does consume what
 *      `lib/sensingPresenceState.buildSensingPresenceState` really produces —
 *      a REAL state, built from a REAL k-gated aggregate, goes through it.
 *   2. The consumer preserves the invariants a consumer usually loses: no
 *      coverage ≠ quiet, busy ≠ good, no person named.
 *   3. It is inert: the flag is fail-closed and there is no producer.
 *
 * WHY THE CONSUMER DOES NOT IMPORT THE STATE MODULE, tested here rather than
 * only explained: §9.1 of `sensingCensusRederivation` asserts that nothing
 * outside the sensing stack imports it, because a new importer is how an
 * ingest would first appear. A test file is outside that walk, so the coupling
 * is proven HERE and the production import that would falsely signal an ingest
 * is not written.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SENSING_PRESENCE_CONTEXT_FLAG,
  SENSING_PRESENCE_HEADER,
  buildSensingPresenceLines,
  isConsumablePresenceState,
  readSensingPresenceGate,
  type ConsumablePresenceState,
} from "../compass/CompassSensingPresence.js";
import { buildSensingPresenceState } from "../lib/sensingPresenceState.js";
import { aggregateSensingCohort } from "../lib/sensingCoverageAggregate.js";
import {
  deriveContributorToken,
  deriveEpochSecret,
  revocationCommitment,
  rotationEpochFor,
  sensingTimeBucket,
  type SensingContributionRow,
} from "../lib/sensingAnonStore.js";

process.env.SENSING_CONTRIBUTOR_PEPPER ??= "p".repeat(40);

/**
 * A gate that PERMITS, obtained the only way one can be: by asking a database
 * that says the flag is on. There is no literal to write here — the gate
 * carries a private brand precisely so a caller cannot mint permission — which
 * is the property that makes the flag load-bearing rather than advisory.
 */
const flagClient = (enabled: boolean): any => ({
  from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { enabled }, error: null }) }) }) }),
});
const PERMITTED = await readSensingPresenceGate(flagClient(true));

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NOW = Date.UTC(2026, 8, 20, 22, 0, 0);
const EPOCH = rotationEpochFor(NOW);
const BUCKET = sensingTimeBucket(NOW - 20 * 60_000);

/** A real cohort, as the lineage suite builds one. */
function cohort(n: number, groups: number): SensingContributionRow[] {
  const rows: SensingContributionRow[] = [];
  for (let i = 0; i < n; i++) {
    rows.push({
      contributor_token: deriveContributorToken(EPOCH, revocationCommitment(deriveEpochSecret(`device-${i}`, EPOCH))),
      rotation_epoch: EPOCH,
      group_token: `grp-${i % groups}-${"y".repeat(16)}`,
      zone_id: "zone-alpha",
      time_bucket: BUCKET,
      cohort_key: "v1|zone-alpha|bucket",
      signal_bucket: i % 5,
      reduction_version: 1,
      created_at: new Date(NOW - 15 * 60_000).toISOString(),
      expires_at: new Date(NOW + 3600_000).toISOString(),
    });
  }
  return rows;
}

/** A REAL presence state for a cohort of `n` contributors across `groups` groups. */
function realState(n: number, groups: number) {
  const rows = cohort(n, groups);
  const aggregate = aggregateSensingCohort({ ok: true, complete: true, rows }, { nowMs: NOW });
  return { rows, state: buildSensingPresenceState({ zoneId: "zone-alpha", timeBucket: BUCKET, aggregate, nowMs: NOW }) };
}

describe("S39 — the consumer really consumes what the engine really produces", () => {
  it("a REAL buildSensingPresenceState output satisfies the consumer's shape", () => {
    const { state } = realState(30, 6);
    assert.equal(state.presence, "observed", "fixture cohort must clear the gate");
    assert.ok(isConsumablePresenceState(state), "the consumed shape has drifted from the produced one");
    const lines = buildSensingPresenceLines([state as unknown as ConsumablePresenceState], PERMITTED);
    assert.equal(lines[0], SENSING_PRESENCE_HEADER);
    assert.match(lines[1], /activity OBSERVED/);
    assert.match(lines[1], new RegExp(`truth ${state.truthClass}`));
    assert.match(lines[1], new RegExp(`coverage ${state.coverage}`));
  });

  it("a SUB-K cohort renders as NOT KNOWN, never as quiet", () => {
    // One contributor below the floor: the gate refuses, and the consumer must
    // not turn that refusal into a statement about the world.
    const { state } = realState(3, 3);
    assert.equal(state.presence, "unknown", "fixture must be refused by the gate");
    const line = buildSensingPresenceLines([state as unknown as ConsumablePresenceState], PERMITTED)[1];
    assert.match(line, /activity NOT KNOWN/);
    assert.match(line, /Do not say it is quiet, empty or dead/);
    // No number of any kind appears for an unknown cohort.
    assert.equal(/bucket \d/.test(line), false);
    assert.equal(/\b0\b/.test(line), false);
  });

  it("the ordinal stays UNLABELLED — busy ≠ good", () => {
    const { state } = realState(30, 6);
    const line = buildSensingPresenceLines([state as unknown as ConsumablePresenceState], PERMITTED)[1];
    assert.match(line, /activity bucket \d of 4 \(unlabelled; reduction v1\)/);
    for (const invented of ["busy", "quiet", "packed", "lively", "dead", "heaving"]) {
      assert.equal(new RegExp(`\\b${invented}\\b`, "i").test(line), false, `invented the word "${invented}"`);
    }
  });

  it("names no person: no contributor token, group token or count survives", () => {
    const { rows, state } = realState(37, 6);
    const rendered = buildSensingPresenceLines([state as unknown as ConsumablePresenceState], PERMITTED).join("\n");
    for (const r of rows) {
      assert.equal(rendered.includes(r.contributor_token), false, "a contributor token reached the prompt");
      if (r.group_token) assert.equal(rendered.includes(r.group_token), false, "a group token reached the prompt");
    }
    // 37 is chosen so the check cannot be satisfied by accident: it is not a
    // substring of any timestamp in the line, unlike a round number would be.
    assert.equal(/\b37\b/.test(rendered), false, "the exact cohort count reached the prompt");
    assert.equal(/distinctActors|source_count|cohort/i.test(rendered), false);
  });

  it("the withholding REASON is not rendered — which gate refused is itself information", () => {
    const { state } = realState(3, 3);
    const rendered = buildSensingPresenceLines([state as unknown as ConsumablePresenceState], PERMITTED).join("\n");
    assert.ok(state.provenance.withheld, "fixture must carry a reason");
    assert.equal(rendered.includes(String(state.provenance.withheld)), false);
  });
});

describe("S39 — it is inert, and decision #9 is why", () => {
  it("the READ and the SEED exist together, or neither does", () => {
    // WHAT THIS CASE USED TO SAY, and why it says something stronger now.
    //
    // It asserted the flag was read by NOTHING and seeded by NO migration,
    // because check-flag-polarity refuses a read of a name no migration seeds
    // ("PHANTOM FLAG — READ BUT NEVER SEEDED … the gate LOOKS deliberate and is
    // not"). Its own instruction was: "If a read appears here, a migration
    // seeding the flag must appear with it."
    //
    // 3004 seeds it FALSE, so the read appeared with it — and the SAME guard
    // catches the mirror failure from the other side: "SEEDED BUT NEVER READ".
    // A switch nothing reads is as dead as a gate nothing can flip. So the
    // invariant is the PAIR, which fails on either half alone.
    assert.equal(SENSING_PRESENCE_CONTEXT_FLAG, "sensing_presence_context_enabled");
    const code = readFileSync(join(SRC, "compass", "CompassSensingPresence.ts"), "utf8");
    const reads = /isFlagEnabled/.test(code);
    const migrations = readdirSync(join(SRC, "migrations"));
    const seeded = migrations.some((f) => {
      try { return readFileSync(join(SRC, "migrations", f), "utf8").includes("sensing_presence_context_enabled"); }
      catch { return false; }
    });
    assert.equal(reads, seeded, reads
      ? "the module reads the flag but no migration seeds it — a phantom gate"
      : "a migration seeds the flag but nothing reads it — a dead switch");
    assert.equal(reads, true, "3004 shipped, so both halves must be present");
  });

  it("PERMISSION CANNOT BE MINTED — only a database that says yes produces it", async () => {
    // The whole reason the gate is a branded object and not a boolean. A
    // future producer cannot forget to consult the flag, because the formatter
    // will not accept anything a flag read did not return.
    const off = await readSensingPresenceGate(flagClient(false));
    assert.equal(off.enabled, false);
    assert.equal(off.reason, "flag_off");
    const { state } = realState(30, 6);
    assert.deepEqual(
      buildSensingPresenceLines([state as unknown as ConsumablePresenceState], off),
      [],
      "a k-CLEARED cohort still renders nothing while decision #9 stands",
    );
  });

  it("the gate FAILS CLOSED on every path that is not an explicit true", async () => {
    const noClient = await readSensingPresenceGate(null);
    assert.equal(noClient.enabled, false);
    assert.equal(noClient.reason, "no_client");

    const thrower: any = { from: () => { throw new Error("boom"); } };
    const unreadable = await readSensingPresenceGate(thrower);
    assert.equal(unreadable.enabled, false, "an unreadable flag is OFF, never ON");
    // `flag_off` rather than a distinct reason: isFlagEnabled folds every error
    // into false before this module sees it, and telling the two apart would
    // need a SECOND flag reader in the tree. The enabled decision — the one
    // that matters — is the safe one either way.
    assert.equal(unreadable.reason, "flag_off");

    const absent: any = {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
    };
    assert.equal((await readSensingPresenceGate(absent)).enabled, false, "an absent row is OFF");
  });

  it("the gate is checked BEFORE the states are inspected", async () => {
    // A rendering decision that depended on what the cohort contained would
    // leak the cohort: "nothing rendered" would mean something different for a
    // refused cohort than for a refused flag.
    const off = await readSensingPresenceGate(flagClient(false));
    assert.deepEqual(buildSensingPresenceLines([], off), []);
    assert.deepEqual(buildSensingPresenceLines([{ kind: "nope" } as never], off), []);
    const { state } = realState(3, 3);
    assert.deepEqual(buildSensingPresenceLines([state as unknown as ConsumablePresenceState], off), []);
  });

  it("THE ROW'S SHAPE NOW: the formatter still reads no store; the route reaches it ONLY through the producer, whose scope gate precedes its flag read", () => {
    // Decision #9's producer exists and IS wired (census-sensing §26): the
    // route hands the producer the device's own zone refs and pushes whatever
    // it renders. What keeps this consent-safe is structural and is asserted
    // here rather than assumed: (1) this formatter still imports no store and
    // builds no state — it can only render what a producer hands it; (2) the
    // route imports the producer, not the stores, and calls no reader of its
    // own; (3) in the producer's source the `surface` scope check comes BEFORE
    // the flag read, so a flipped flag cannot surface anything the policy
    // does not permit. Comments are stripped before matching.
    const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    const code = strip(readFileSync(join(SRC, "compass", "CompassSensingPresence.ts"), "utf8"));
    assert.doesNotMatch(code, /sensingAnonStore|sensingCoverageAggregate|buildSensingPresenceState/);

    const routes = strip(readFileSync(join(SRC, "routes", "compass.ts"), "utf8"));
    assert.match(routes, /from "\.\.\/compass\/CompassSensingPresenceProducer\.js"/, "the route reaches presence through the producer");
    assert.match(routes, /buildSensingPresenceContext\(/);
    assert.doesNotMatch(routes, /sensingAnonStore|sensingCoverageAggregate|readLastPublishedAggregate|readSensingPresenceGate/, "the route reads no sensing store and no gate of its own");

    const producer = strip(readFileSync(join(SRC, "compass", "CompassSensingPresenceProducer.ts"), "utf8"));
    const fnStart = producer.indexOf("export async function buildSensingPresenceContext(");
    assert.ok(fnStart > 0);
    const body = producer.slice(fnStart);
    const scopeAt = body.indexOf("sensingSurfaceScopeGranted(");
    const flagAt = body.indexOf("readSensingPresenceGate(");
    assert.ok(scopeAt > 0 && flagAt > 0 && scopeAt < flagAt, "the scope is decided before the flag is read");
  });

  it("an empty or unusable input renders nothing rather than an empty header", () => {
    assert.deepEqual(buildSensingPresenceLines([], PERMITTED), []);
    assert.deepEqual(buildSensingPresenceLines([{ kind: "nope" } as never], PERMITTED), []);
  });
});
