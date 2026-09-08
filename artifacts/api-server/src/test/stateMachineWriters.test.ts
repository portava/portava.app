/**
 * Proof for `src/scripts/checkStateMachineWriters.ts`.
 *
 * A guard nobody has watched fail is not a guard. While the real registry is
 * correct every failure path in the checker is unreachable, so each rule is
 * driven here through the `STATE_MACHINE_REGISTRY` seam — the same seam
 * `PROJECTION_REGISTRY` gives checkProjectionConsumers.ts — with a DEEP COPY of
 * the real registry mutated in exactly one place. Copying the real one matters:
 * a hand-built minimal fixture would trip the vacuity floor instead of the rule
 * under test, and the test would pass for the wrong reason.
 *
 * Judged by EXIT CODE and by the specific message, never by "it printed
 * something".
 */
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { STATE_MACHINES } from "../lib/stateMachines/registry.js";
import { callsFunction, enumStates, checkStates, mirrorStates } from "../scripts/checkStateMachineWriters.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const API_ROOT = resolve(HERE, "..", "..");
const SCRIPT = join(API_ROOT, "src", "scripts", "checkStateMachineWriters.ts");
const TMP = mkdtempSync(join(tmpdir(), "state-machines-"));

type Registry = any[];

/** A structural deep copy, so a mutation cannot leak into another case. */
function copy(): Registry {
  return JSON.parse(JSON.stringify(STATE_MACHINES));
}

function machine(reg: Registry, key: string): any {
  const m = reg.find((x) => x.key === key);
  assert.ok(m, `fixture is stale: no machine ${key}`);
  return m;
}

function state(reg: Registry, key: string, name: string): any {
  const s = machine(reg, key).states.find((x: any) => x.name === name);
  assert.ok(s, `fixture is stale: no state ${key}.${name}`);
  return s;
}

let seq = 0;
function run(reg: Registry | null, env: Record<string, string> = {}): { code: number; out: string } {
  const e: Record<string, string> = { ...process.env as any, ...env };
  if (reg) {
    const f = join(TMP, `registry-${seq++}.json`);
    writeFileSync(f, JSON.stringify(reg));
    e.STATE_MACHINE_REGISTRY = f;
  }
  const r = spawnSync(process.execPath, ["--import", "tsx/esm", SCRIPT], { env: e, encoding: "utf8" });
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** Every mutation must FAIL, and fail for the stated reason — not by accident. */
function expectFailure(reg: Registry, needle: string, env: Record<string, string> = {}): void {
  const r = run(reg, env);
  assert.equal(r.code, 1, `expected exit 1, got ${r.code}. Output:\n${r.out}`);
  assert.ok(
    r.out.includes(needle),
    `expected the failure to mention ${JSON.stringify(needle)}. Output:\n${r.out}`,
  );
}

// ── the baseline: the real tree, and the seam itself ─────────────────────────

test("the real registry passes against the real tree", () => {
  const r = run(null);
  assert.equal(r.code, 0, `the checker must pass on an unmodified tree. Output:\n${r.out}`);
  assert.ok(r.out.includes("0 MISSING_WRITER"));
});

test("the crafted-registry seam is faithful: an unmutated copy also passes", () => {
  const r = run(copy());
  assert.equal(r.code, 0, `a deep copy of the real registry must behave identically. Output:\n${r.out}`);
});

// ── 1/2. vocabulary parity, both directions ──────────────────────────────────

test("a registered state the schema cannot hold FAILS", () => {
  const reg = copy();
  machine(reg, "EVENTS_STATE").states.push({ name: "suspended", classification: "REACHABLE" });
  expectFailure(reg, `registered state "suspended" is NOT in events.state's vocabulary`);
});

test("a schema state the registry omits FAILS — the registry cannot hide a state", () => {
  const reg = copy();
  const m = machine(reg, "EVENTS_STATE");
  m.states = m.states.filter((s: any) => s.name !== "archived");
  m.transitions = m.transitions.filter((t: any) => t.to !== "archived");
  expectFailure(reg, `events.state admits "archived" and the registry does not mention it`);
});

test("a vocabulary anchor that matches more than once FAILS rather than reading the wrong constraint", () => {
  const reg = copy();
  machine(reg, "TRUST_EVENTS_STATUS").vocabulary.anchor = "status";
  expectFailure(reg, "must occur exactly once");
});

test("a missing vocabulary source FAILS", () => {
  const reg = copy();
  machine(reg, "TRIPS_STATUS").vocabulary.file = "baseline/does_not_exist.sql";
  expectFailure(reg, "vocabulary source baseline/does_not_exist.sql does not exist");
});

// ── 3. the TS mirror ─────────────────────────────────────────────────────────

test("a TS mirror that has drifted from the SQL vocabulary FAILS", () => {
  const reg = copy();
  // A real constant in the same file with a genuinely different membership.
  machine(reg, "INTEL_CLAIMS_STATUS").mirror.symbol = "LIVE_ELIGIBLE_CLAIM_STATUSES";
  expectFailure(reg, "has drifted from");
});

// ── 4. the writer ────────────────────────────────────────────────────────────

test("a declared writer file that does not exist FAILS", () => {
  const reg = copy();
  machine(reg, "EVENTS_STATE").transitions.find((t: any) => t.to === "cancelled").writer.file =
    "routes/eventsGone.ts";
  expectFailure(reg, "declared writer routes/eventsGone.ts does not exist");
});

test("a writer that no longer contains the write it is cited for FAILS", () => {
  const reg = copy();
  machine(reg, "EVENTS_STATE").transitions.find((t: any) => t.to === "cancelled").writer.evidence = [
    '.update({ state: "cancelled_by_a_writer_that_was_deleted" })',
  ];
  expectFailure(reg, "no longer contains");
});

test("evidence that never names the state it claims to write FAILS", () => {
  const reg = copy();
  machine(reg, "TRIPS_STATUS").transitions.find((t: any) => t.to === "completed").writer.evidence = [
    'import { computeTripStatus }',
  ];
  expectFailure(reg, 'no evidence line mentions "completed"');
});

test("an RPC writer whose SQL function never writes the state FAILS", () => {
  const reg = copy();
  const t = machine(reg, "INTEL_CLAIMS_STATUS").transitions.find(
    (x: any) => x.to === "active" && x.writer.via,
  );
  // A real migration that really defines a promotion function — for a different table.
  t.writer.via = "system_promote_intel_live_scope";
  t.writer.evidence = ['db.rpc("system_promote_admissible_intel_claims")'];
  expectFailure(reg, "evidence must cite the producer function system_promote_intel_live_scope");
});

test("a derived lifecycle whose evidence touches none of its derivation columns FAILS", () => {
  const reg = copy();
  machine(reg, "TRUST_RESTRICTION_LIFECYCLE").transitions.find((t: any) => t.to === "expired").writer.evidence = [
    "export async function expireOldRestrictions(",
  ];
  expectFailure(reg, "evidence must cite one of the columns the derivation reads");
});

// ── 5. consumers ─────────────────────────────────────────────────────────────

test("a declared consumer that never mentions the state FAILS", () => {
  const reg = copy();
  state(reg, "EVENTS_STATE", "started").consumers = ["lib/tripStatus.ts"];
  expectFailure(reg, 'declared consumer lib/tripStatus.ts never mentions "started"');
});

test("an unreachable state with no consumer list FAILS — the cost must be named", () => {
  const reg = copy();
  state(reg, "INTEL_CLAIMS_STATUS", "conflicting").consumers = [];
  expectFailure(reg, "must list the files that CONSUME the state");
});

// ── 6. substance ─────────────────────────────────────────────────────────────

test("a non-REACHABLE state with no substantive reason FAILS", () => {
  const reg = copy();
  state(reg, "INTEL_CLAIMS_STATUS", "expired").reason = "nothing writes it";
  expectFailure(reg, "requires a substantive reason");
});

// ── 7. OWNER_BLOCKED ─────────────────────────────────────────────────────────

test("OWNER_BLOCKED with no owner decision FAILS", () => {
  const reg = copy();
  delete state(reg, "EVENTS_STATE", "completed").ownerDecision;
  expectFailure(reg, "OWNER_BLOCKED with no ownerDecision");
});

test("an owner decision recorded in a doc that does not exist FAILS", () => {
  const reg = copy();
  state(reg, "EVENTS_STATE", "completed").ownerDecision.docs = ["docs/architecture/not-a-real-doc.md"];
  expectFailure(reg, "docs/architecture/not-a-real-doc.md does not exist");
});

test("an owner decision whose doc never names it FAILS", () => {
  const reg = copy();
  state(reg, "EVENTS_STATE", "completed").ownerDecision.docs = ["docs/architecture/00_README.md"];
  expectFailure(reg, "never names EVENT_START_TRANSITION");
});

// ── 8. HOLD ──────────────────────────────────────────────────────────────────

test("HOLD whose flag is not actually seeded FALSE by the cited migration FAILS", () => {
  const reg = copy();
  // A real flag, seeded FALSE — but by 2570, not by the migration this cites.
  state(reg, "INTEL_LIVE_SCOPE_LIFECYCLE", "promoted").hold.flag = "intel_live_scope_admin_surface_enabled";
  expectFailure(reg, "does not seed intel_live_scope_admin_surface_enabled FALSE");
});

test("HOLD with no gate at all FAILS — a hold is a switch, not a nicer word", () => {
  const reg = copy();
  delete state(reg, "INTEL_LIVE_SCOPE_LIFECYCLE", "withdrawn").hold;
  expectFailure(reg, "HOLD with no gate");
});

// ── 9. a state is only as reachable as its best writer ───────────────────────

test("a state classified more reachable than its own best writer FAILS", () => {
  const reg = copy();
  state(reg, "TRUST_EVENTS_STATUS", "confirmed").classification = "REACHABLE";
  expectFailure(reg, "its most reachable writer is OPS_DRIVEN");
});

test("removing the only transition into a REACHABLE state FAILS", () => {
  const reg = copy();
  const m = machine(reg, "TRIPS_STATUS");
  m.transitions = m.transitions.filter((t: any) => t.to !== "cancelled");
  expectFailure(reg, "classified REACHABLE with NO transition into it");
});

test("DECLARED_UNUSED with a writer FAILS — a state with a producer is used", () => {
  const reg = copy();
  state(reg, "TRIPS_STATUS", "archived").classification = "DECLARED_UNUSED";
  state(reg, "TRIPS_STATUS", "archived").reason =
    "a reason long enough to clear the substance floor but wrong about the facts";
  state(reg, "TRIPS_STATUS", "archived").consumers = ["routes/trips-expansion.ts"];
  expectFailure(reg, "DECLARED_UNUSED but 1 transition(s) write it");
});

test("MISSING_WRITER FAILS — it is how a finding is reported, not how it is silenced", () => {
  const reg = copy();
  const s = state(reg, "INTEL_CLAIMS_STATUS", "conflicting");
  s.classification = "MISSING_WRITER";
  expectFailure(reg, "MISSING_WRITER — intel_claims.status can hold \"conflicting\"");
});

// ── 10. schedulers ───────────────────────────────────────────────────────────

test("a time-driven transition whose scheduler is never started FAILS", () => {
  const reg = copy();
  machine(reg, "TRUST_RESTRICTION_LIFECYCLE").transitions.find((t: any) => t.to === "expired").scheduler.from =
    "lib/tripStatus.ts";
  expectFailure(reg, "startTrustMaintenanceScheduler is never CALLED from lib/tripStatus.ts");
});

// ── 11. the pin ──────────────────────────────────────────────────────────────

test("PIN: events.state='started' cannot be reclassified REACHABLE, even with a real writer", () => {
  const reg = copy();
  const s = state(reg, "EVENTS_STATE", "started");
  s.classification = "REACHABLE";
  delete s.ownerDecision;
  const t = machine(reg, "EVENTS_STATE").transitions.find((x: any) => x.to === "started");
  t.classification = "REACHABLE";
  delete t.reason;
  // The writer really does exist and really does contain the write; the pin
  // still refuses, because implementing it is not the same as deciding it.
  const r = run(reg);
  assert.equal(r.code, 1, `the pin must refuse. Output:\n${r.out}`);
  assert.ok(r.out.includes("PIN VIOLATED"), r.out);
  assert.ok(r.out.includes("TAKES the owner's decision"), r.out);
});

test("PIN: deleting the started state does not take the decision either", () => {
  const reg = copy();
  const m = machine(reg, "EVENTS_STATE");
  m.states = m.states.filter((s: any) => s.name !== "started");
  m.transitions = m.transitions.filter((t: any) => t.to !== "started");
  expectFailure(reg, 'PINNED state "started" is no longer registered');
});

test("PIN: moving started onto some other owner decision FAILS", () => {
  const reg = copy();
  state(reg, "EVENTS_STATE", "started").ownerDecision.id = "MEDIA_CANONICAL_FLAG";
  expectFailure(reg, "must be OWNER_BLOCKED on EVENT_START_TRANSITION");
});

// ── 12. non-vacuity ──────────────────────────────────────────────────────────

test("a registry too small to prove anything FAILS as VACUOUS", () => {
  expectFailure(copy().slice(0, 2), "FAIL — VACUOUS");
});

test("an empty registry FAILS as VACUOUS", () => {
  expectFailure([], "FAIL — VACUOUS");
});

test("a scan that finds no files FAILS as VACUOUS", () => {
  const empty = join(TMP, "empty-tree");
  mkdirSync(empty, { recursive: true });
  const r = run(null, { STATE_MACHINE_SRC: empty });
  assert.equal(r.code, 1, `an empty tree must not report success. Output:\n${r.out}`);
  assert.ok(r.out.includes("FAIL — VACUOUS"), r.out);
});

// ── the vocabulary parsers, directly ─────────────────────────────────────────

test("enumStates reads a pg enum and answers null for a type that is not there", () => {
  const sql = readFileSync(join(API_ROOT, "baseline/20260819_baseline_structure.sql"), "utf8");
  assert.deepEqual(enumStates(sql, "public.event_state"), [
    "draft", "open", "full", "waitlist", "started", "completed", "cancelled", "archived",
  ]);
  assert.equal(enumStates(sql, "public.no_such_enum"), null);
});

test("checkStates reads the constraint after its anchor, and refuses an ambiguous anchor", () => {
  const sql = readFileSync(join(API_ROOT, "src/migrations/2130_intel_storage.sql"), "utf8");
  const ok = checkStates(sql, "CONSTRAINT intel_claims_status_check");
  assert.equal(ok.occurrences, 1);
  assert.deepEqual(ok.states, [
    "candidate", "active", "conflicting", "superseded", "expired", "retracted", "rejected",
  ]);
  // "status" appears many times: reading whichever came first is exactly how a
  // check ends up validating the wrong constraint and passing.
  const ambiguous = checkStates(sql, "status");
  assert.equal(ambiguous.states, null);
  assert.ok(ambiguous.occurrences > 1);
  assert.equal(checkStates(sql, "CONSTRAINT no_such_constraint").occurrences, 0);
});

test("mirrorStates reads a TS `as const` vocabulary", () => {
  const ts = readFileSync(join(API_ROOT, "src/lib/intelContracts.ts"), "utf8");
  assert.deepEqual(mirrorStates(ts, "CLAIM_STATUSES"), [
    "candidate", "active", "conflicting", "superseded", "expired", "retracted", "rejected",
  ]);
  assert.equal(mirrorStates(ts, "NO_SUCH_CONSTANT"), null);
});

test("callsFunction ignores a call that has been commented out", () => {
  // Measured, not imagined: with a raw regex over the file, commenting out
  // `startTrustMaintenanceScheduler();` in index.ts left the whole check GREEN
  // while `expired` became unreachable — the regression the rule exists to
  // catch, passing.
  const index = readFileSync(join(API_ROOT, "src/index.ts"), "utf8");
  assert.equal(callsFunction(index, "startTrustMaintenanceScheduler"), true);
  assert.equal(callsFunction(index, "startEventLifecycleScheduler"), true);

  assert.equal(callsFunction("  // startX();", "startX"), false);
  assert.equal(callsFunction("  /* startX(); */", "startX"), false);
  assert.equal(callsFunction("/*\n  startX();\n*/", "startX"), false);
  assert.equal(callsFunction("  startX(); // was: startY()", "startX"), true);
  // The import alone is not a call.
  assert.equal(callsFunction('import { startX } from "./x.js";', "startX"), false);
});
