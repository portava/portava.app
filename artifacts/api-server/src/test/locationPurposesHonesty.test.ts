/**
 * Privacy-documentation honesty guard.
 *
 * WHY THIS EXISTS
 * ---------------
 * `lib/locationPurposes.ts` is the user-facing purpose registry: it states, per
 * purpose, what Portava retains and what control bounds it. On 2026-08-28 an
 * audit found it claimed `circle_presence` was "a TTL'd projection … WITH A
 * SWEEPER". There is no sweeper: `POST /circle/internal/cleanup-presence` is
 * defined in routes/circle.ts and has no caller anywhere — no scheduler, no
 * cron, no job — so TRIP_PRESENCE_TTL_HOURS / EVENT_PRESENCE_TTL_HOURS are
 * enforced by nothing.
 *
 * A privacy registry that describes a control which does not run is worse than
 * one that says nothing, because it is the artifact a reviewer (or a user, or a
 * regulator) would be shown as evidence of the control. This guard fails if the
 * registry claims an automatic retention mechanism that no code drives.
 *
 * It deliberately checks the CLAIM against the CODE, not against a hard-coded
 * list, so it keeps biting as the registry changes.
 *
 * Pure and offline — no database required.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LOCATION_PURPOSES } from "../lib/locationPurposes.js";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Words that assert an AUTOMATIC, running retention mechanism.
 *
 * Detecting a CLAIM is not the same as detecting a MENTION, and the first
 * version of this guard got that wrong: it flagged the corrected note, which
 * says "…but NO sweeper runs". A registry entry that explicitly DENIES a
 * mechanism is the honest case this guard exists to encourage, so denials are
 * stripped before the claim test runs.
 */
const NEGATED_MECHANISM =
  /\b(?:no|not|never|without|lacks?|absent)\b[^.;]{0,40}?\b(sweeper|cron|scheduled job|scheduler)\b/gi;
const AUTOMATIC_MECHANISM = /\b(sweeper|swept automatically|cron|scheduled job|scheduler runs)\b/i;

/** True when the note ASSERTS a mechanism, rather than mentioning or denying one. */
function claimsAutomaticMechanism(note: string): boolean {
  return AUTOMATIC_MECHANISM.test(note.replace(NEGATED_MECHANISM, ""));
}

/** Recursively collect every .ts file under src/, excluding tests. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (entry === "test" || entry === "__tests__" || entry === "node_modules") continue;
      sourceFiles(p, out);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      out.push(p);
    }
  }
  return out;
}

describe("location purposes — the registry must not claim protection that does not run", () => {
  it("no purpose claims an automatic sweeper/cron mechanism", () => {
    const offenders = LOCATION_PURPOSES
      .filter((p) => typeof p.retentionNote === "string" && claimsAutomaticMechanism(p.retentionNote))
      .map((p) => `${p.id}: "${p.retentionNote}"`);

    assert.deepEqual(
      offenders,
      [],
      "A purpose claims an automatic retention mechanism. If one genuinely runs, wire it and \n" +
        "narrow this guard to name it explicitly; otherwise correct the note. Privacy documentation \n" +
        "must never be stronger than the code:\n  " + offenders.join("\n  "),
    );
  });

  it("distinguishes a CLAIM from a DENIAL — the guard's own logic", () => {
    // The first version of this guard failed on the corrected note because it
    // matched the word rather than the claim. Pin both directions.
    assert.equal(claimsAutomaticMechanism("is a TTL'd projection with a sweeper"), true);
    assert.equal(claimsAutomaticMechanism("swept automatically every hour"), true);
    assert.equal(claimsAutomaticMechanism("a cron job removes expired rows"), true);
    assert.equal(claimsAutomaticMechanism("carries TTL columns but NO sweeper runs"), false);
    assert.equal(claimsAutomaticMechanism("there is no cron for this table"), false);
    assert.equal(claimsAutomaticMechanism("rows are deleted with the account"), false);
  });

  it("the circle_presence cleanup route still has no scheduler — the note stays accurate", () => {
    // If someone wires the route, this test fails and the registry note SHOULD be
    // updated to claim the control. That is the intended direction of change.
    const files = sourceFiles(SRC);
    const callers = files.filter((f) => {
      if (f.endsWith("routes/circle.ts")) return false;      // the definition itself
      if (f.endsWith("lib/locationPurposes.ts")) return false; // the note describing it
      return readFileSync(f, "utf8").includes("cleanup-presence");
    });

    assert.deepEqual(
      callers.map((f) => f.replace(SRC, "src")),
      [],
      "POST /circle/internal/cleanup-presence now has a caller. Update the presence_in_context \n" +
        "retentionNote in lib/locationPurposes.ts to describe the control that now runs.",
    );
  });

  it("every purpose that declares a finite retention bound explains how it is enforced", () => {
    for (const p of LOCATION_PURPOSES) {
      if (p.retentionSeconds !== null && p.retentionSeconds !== undefined) {
        assert.ok(
          typeof p.retentionNote === "string" && p.retentionNote.trim().length > 0,
          `purpose "${p.id}" declares retentionSeconds=${p.retentionSeconds} but no retentionNote explaining enforcement`,
        );
      }
    }
  });
});
