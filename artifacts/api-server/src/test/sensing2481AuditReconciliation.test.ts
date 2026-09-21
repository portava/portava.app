/**
 * sensing2481AuditReconciliation.test.ts
 *
 * 2481_sensing_sessions_option_a_issuer.sql is a migration that MUST NEVER RUN
 * while the owner's Sensing posture is Option B. Its own first line says so.
 * Two auditors are name-keyed to files on disk and cannot know that, so both
 * report its objects as drift on every run — the standing red on `main` that
 * this reconciliation clears.
 *
 * Silencing a security-posture auditor is the kind of change that has to be
 * held shut afterwards, so these cases assert the three properties that make
 * the silence legitimate rather than convenient:
 *
 *   1. it is DERIVED from the posture, not pinned beside it, so it expires by
 *      itself if the owner ever returns to Option A;
 *   2. it FAILS CLOSED — a posture that cannot be established grants nothing;
 *   3. it did not widen the sensing stack's importer set, which §9.1 guards
 *      because a new importer is the signal that ingest has started to exist.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parsePostureSource,
  sensingPostureOnDisk,
  isOptionAInForce,
} from "../scripts/lib/sensingPostureOnDisk.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string => readFileSync(join(SRC, rel), "utf8");

const AUDIT = "scripts/auditMigrationsVsLive.ts";
const COLUMNS = "scripts/checkMissingLiveColumns.ts";
const MIGRATION = "2481_sensing_sessions_option_a_issuer.sql";
/** The gated form both auditors must use: the skip added inside the posture check. */
const GUARDED_SKIP = new RegExp(
  String.raw`if\s*\(\s*!isOptionAInForce\(\)\s*\)\s*\{[^}]*2481_sensing_sessions_option_a_issuer\.sql[^}]*\}`,
  "s",
);

describe("the 2481 auditor reconciliation is derived from the posture", () => {
  test("the reader agrees with what lib/sensingAuthPosture.ts actually declares", () => {
    // Read independently rather than trusting the helper's own answer: if the
    // regex ever stops matching the file it is pointed at, the helper silently
    // returns "undecided" and every allowance quietly evaporates. That is the
    // safe direction, but it should not happen unnoticed.
    const declared = /export\s+const\s+SENSING_AUTH_POSTURE\s*:[^=]*=\s*"([a-z_]+)"/.exec(
      read("lib/sensingAuthPosture.ts"),
    )?.[1];
    assert.equal(sensingPostureOnDisk(), declared);
  });

  test("Option B is in force today, so the allowances are active", () => {
    assert.equal(sensingPostureOnDisk(), "anonymous_capable");
    assert.equal(isOptionAInForce(), false);
  });

  test("Option A turns both allowances back off", () => {
    // The whole point of deriving rather than pinning. Nobody has to remember.
    assert.equal(
      parsePostureSource('export const SENSING_AUTH_POSTURE: SensingAuthPosture = "authenticated_only";'),
      "authenticated_only",
    );
  });

  test("anything unrecognisable is 'undecided', which grants nothing", () => {
    // Fail-closed: a posture that cannot be established must not silence a
    // security-posture auditor. Neither of these is Option A, so neither reports
    // isOptionAInForce() true — but neither is Option B either, and the
    // allowances below are written to require an ESTABLISHED Option B.
    for (const src of [
      "",
      "const SOMETHING_ELSE = \"authenticated_only\";",
      'export const SENSING_AUTH_POSTURE: SensingAuthPosture = "made_up";',
      'export const SENSING_AUTH_POSTURE_RENAMED: SensingAuthPosture = "anonymous_capable";',
    ]) {
      assert.equal(parsePostureSource(src), "undecided", `expected undecided for: ${src.slice(0, 40)}`);
    }
  });
});

describe("the reconciliation is exactly two entries, both conditional", () => {
  test("auditMigrationsVsLive skips 2481 only when Option A is not in force", () => {
    const src = read(AUDIT);
    assert.ok(src.includes(MIGRATION), "the auditor must name the file it skips");
    assert.match(src, GUARDED_SKIP, "2481's skip must be derived from the posture, not pinned");
  });

  // ── THE CASE THIS FILE WAS MISSING, AND THE REASON IT EXISTS ───────────────
  //
  // #511 and #512 fixed 2481 independently and merged within half an hour. Git
  // kept BOTH forms with no conflict: #512's permanent literal inside the
  // SKIP_FILES array, and #511's gated add. A Set add is idempotent, so the
  // duplication changed nothing at runtime — and it silently DEFEATED the gate.
  // Measured on the merge commit, posture flipped to `authenticated_only`:
  // isOptionAInForce() correctly withheld the add, and the auditor skipped 2481
  // anyway, on the one posture where those three objects MUST exist.
  //
  // The cases above could not see it. They assert the gated form is PRESENT;
  // none of them asserted nothing else also skips the file. That is the same
  // shape of hole this whole effort keeps finding — a passing test that means
  // less than it looks — so it is closed here by name.
  for (const [label, file] of [["auditMigrationsVsLive", AUDIT], ["checkMissingLiveColumns", COLUMNS]] as const) {
    test(`${label} carries NO unconditional 2481 skip alongside the gated one`, () => {
      const src = read(file);
      // A bare Set member: the filename as a quoted array element, at line
      // start, which is how both auditors' SKIP_FILES literals are written.
      const bareMember = new RegExp(String.raw`^\s*"${MIGRATION.replace(/\./g, "\\.")}",\s*$`, "m");
      assert.doesNotMatch(
        src,
        bareMember,
        "a permanent literal beside the gated add makes the gate a no-op — the skip would " +
          "survive a move to Option A and hide real drift",
      );
    });
  }

  test("checkMissingLiveColumns skips 2481 only when Option A is not in force", () => {
    // The mechanism changed after #511 and #512 merged in parallel. #512 was
    // right that the FILE is the unit: ALLOWLIST means "pending a live apply,
    // remove once certified", and 2481 is never to be applied. #511's ALLOWLIST
    // entry is gone; the surviving entry is #512's SKIP_FILES form, gated.
    const src = read(COLUMNS);
    assert.match(src, GUARDED_SKIP, "2481's skip must be derived from the posture");
    assert.doesNotMatch(
      src,
      /\bALLOWLIST\.add\(\s*"sensing_contribution_sessions\.issued_to_profile_id"/,
      "the column must NOT also sit in ALLOWLIST — that list is for pending applies",
    );
  });

  test("neither auditor IMPORTS the sensing stack — §9.1 stays meaningful", () => {
    // The first attempt at this reconciliation did import it, and §9.1 went red.
    // That guard reads a new importer as "the ingest the thirteen posture-blocked
    // rows wait on may have started to exist", and its own header says not to
    // allowlist your way past it. Reading the constant as text is the way through.
    const stack = /from\s+"[^"]*sensingAuthPosture\.js"/;
    for (const f of [AUDIT, COLUMNS, "scripts/lib/sensingPostureOnDisk.ts"]) {
      assert.doesNotMatch(read(f), stack, `${f} must not import the posture module`);
    }
  });

  test("anti-vacuity: 2481 really is Option-A-only, and really does claim that column", () => {
    // If 2481 were an ordinary pending migration, every case above would be a
    // well-tested excuse for hiding real drift.
    const sql = read(`migrations/${MIGRATION}`);
    assert.match(sql, /OPTION A ONLY/);
    assert.match(sql, /Do NOT apply under\n-- Option B/);
    assert.match(sql, /ADD COLUMN IF NOT EXISTS issued_to_profile_id uuid/);
  });
});
