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
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SENSING_PRESENCE_CONTEXT_FLAG,
  SENSING_PRESENCE_HEADER,
  buildSensingPresenceLines,
  isConsumablePresenceState,
  readSensingPresenceContext,
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
    const lines = buildSensingPresenceLines([state as unknown as ConsumablePresenceState]);
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
    const line = buildSensingPresenceLines([state as unknown as ConsumablePresenceState])[1];
    assert.match(line, /activity NOT KNOWN/);
    assert.match(line, /Do not say it is quiet, empty or dead/);
    // No number of any kind appears for an unknown cohort.
    assert.equal(/bucket \d/.test(line), false);
    assert.equal(/\b0\b/.test(line), false);
  });

  it("the ordinal stays UNLABELLED — busy ≠ good", () => {
    const { state } = realState(30, 6);
    const line = buildSensingPresenceLines([state as unknown as ConsumablePresenceState])[1];
    assert.match(line, /activity bucket \d of 4 \(unlabelled; reduction v1\)/);
    for (const invented of ["busy", "quiet", "packed", "lively", "dead", "heaving"]) {
      assert.equal(new RegExp(`\\b${invented}\\b`, "i").test(line), false, `invented the word "${invented}"`);
    }
  });

  it("names no person: no contributor token, group token or count survives", () => {
    const { rows, state } = realState(37, 6);
    const rendered = buildSensingPresenceLines([state as unknown as ConsumablePresenceState]).join("\n");
    for (const r of rows) {
      assert.equal(rendered.includes(r.contributor_token), false, "a contributor token reached the prompt");
      assert.equal(rendered.includes(r.group_token), false, "a group token reached the prompt");
    }
    // 37 is chosen so the check cannot be satisfied by accident: it is not a
    // substring of any timestamp in the line, unlike a round number would be.
    assert.equal(/\b37\b/.test(rendered), false, "the exact cohort count reached the prompt");
    assert.equal(/distinctActors|source_count|cohort/i.test(rendered), false);
  });

  it("the withholding REASON is not rendered — which gate refused is itself information", () => {
    const { state } = realState(3, 3);
    const rendered = buildSensingPresenceLines([state as unknown as ConsumablePresenceState]).join("\n");
    assert.ok(state.provenance.withheld, "fixture must carry a reason");
    assert.equal(rendered.includes(String(state.provenance.withheld)), false);
  });
});

describe("S39 — it is inert, and decision #9 is why", () => {
  it("the flag is fail-closed: absent, false or unreadable is OFF", async () => {
    const { state } = realState(30, 6);
    const states = [state as unknown as ConsumablePresenceState];
    const client = (value: unknown, error: unknown = null) => ({
      from: () => {
        const self: Record<string, unknown> = {};
        for (const m of ["select", "eq", "in", "limit", "order"]) self[m] = () => self;
        self.maybeSingle = async () => ({ data: value, error });
        self.single = async () => ({ data: value, error });
        self.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: value, error }).then(ok);
        return self;
      },
    });
    // No client at all.
    assert.deepEqual(await readSensingPresenceContext(null, states), []);
    // Flag row absent.
    assert.deepEqual(await readSensingPresenceContext(client(null), states), []);
    // Flag unreadable.
    assert.deepEqual(await readSensingPresenceContext(client(null, { message: "boom" }), states), []);
    // Flag explicitly false.
    assert.deepEqual(await readSensingPresenceContext(client({ enabled: false }), states), []);
  });

  it("the flag is spelled literally, as `*_enabled`, so check-flag-polarity resolves it", () => {
    assert.equal(SENSING_PRESENCE_CONTEXT_FLAG, "sensing_presence_context_enabled");
    const code = readFileSync(join(SRC, "compass", "CompassSensingPresence.ts"), "utf8");
    assert.match(code, /"sensing_presence_context_enabled"/);
  });

  it("THE ROW IS BLOCKED: no route builds a presence state, because nothing may read the store", () => {
    // Decision #9 — "Publishing any aggregate to a user-visible surface" — has
    // not been taken, and the structural consequence is that nothing can hand
    // this consumer a state. If this assertion ever fails, a producer has
    // appeared and S39 should be re-derived rather than this test relaxed.
    // Comments are stripped first: this module EXPLAINS at length why it does
    // not import those things, and naming them in prose is the opposite of
    // importing them.
    const code = readFileSync(join(SRC, "compass", "CompassSensingPresence.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    assert.doesNotMatch(code, /sensingAnonStore|sensingCoverageAggregate|buildSensingPresenceState/);
    // And no route calls the consumer at all yet.
    const routes = readFileSync(join(SRC, "routes", "compass.ts"), "utf8");
    assert.doesNotMatch(routes, /readSensingPresenceContext/);
  });

  it("an empty or unusable input renders nothing rather than an empty header", () => {
    assert.deepEqual(buildSensingPresenceLines([]), []);
    assert.deepEqual(buildSensingPresenceLines([{ kind: "nope" } as never]), []);
  });
});
