/**
 * Regression: the Rent-a-Buddy master switch `rent_buddy_enabled` must default OFF
 * after a clean migration run, and the gate must be unbypassable.
 *
 * Owner decision 2026-08-31: RaB stays unavailable until an admin explicitly
 * enables it post-launch-readiness. A latent defect had it default ON:
 * 0050 seeds it FALSE, but 0090 FORCES it TRUE (ON CONFLICT DO UPDATE SET
 * enabled = TRUE), so every fresh install / restore ended with the switch on
 * (prod carried true). Migration 2210 reasserts the safe default by forcing FALSE.
 *
 * This test is a STATIC migration scan (no DB): it simulates the seed/upsert of
 * `rent_buddy_enabled` across all migrations, in migration-number order, and
 * asserts the effective value ends FALSE — so a clean migration or a restore
 * cannot silently re-enable the feature. It also asserts the flag is actually
 * read by the access gate (so the default is not a dead default).
 *
 * Run: node --import tsx/esm --test src/test/rentBuddyMasterFlagDefaultOff.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), "../migrations");
const FLAG = "rent_buddy_enabled";

interface FlagWrite {
  file: string;
  num: number;
  insertedEnabled: boolean | null; // value in the INSERT ... VALUES for this flag
  onConflict: "do_nothing" | "do_update_true" | "do_update_false" | "none";
}

/**
 * Find every INSERT INTO feature_flags statement that writes `rent_buddy_enabled`
 * and extract its inserted value + ON CONFLICT behaviour. Deliberately simple: it
 * relies on the migrations' consistent `('rent_buddy_enabled', <bool>, …)` row
 * shape and a statement-level `ON CONFLICT … (DO NOTHING | DO UPDATE SET enabled = <bool>)`.
 */
function scanFlagWrites(): FlagWrite[] {
  const files = readdirSync(MIGRATIONS)
    .filter((f) => /^\d{4}.*\.sql$/.test(f))
    .sort();
  const writes: FlagWrite[] = [];
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS, file), "utf8");
    // Split into statements on semicolons; keep only ones touching the flag +
    // feature_flags. (Comments mentioning the flag are ignored because they carry
    // no INSERT INTO feature_flags.)
    for (const stmt of sql.split(";")) {
      if (!/insert\s+into\s+(public\.)?feature_flags/i.test(stmt)) continue;
      const rowRe = new RegExp(`\\(\\s*'${FLAG}'\\s*,\\s*(true|false)`, "i");
      const m = stmt.match(rowRe);
      if (!m) continue;
      const insertedEnabled = m[1].toLowerCase() === "true";
      let onConflict: FlagWrite["onConflict"] = "none";
      if (/on\s+conflict[\s\S]*do\s+nothing/i.test(stmt)) onConflict = "do_nothing";
      else if (/on\s+conflict[\s\S]*do\s+update\s+set\s+enabled\s*=\s*true/i.test(stmt)) onConflict = "do_update_true";
      else if (/on\s+conflict[\s\S]*do\s+update\s+set\s+enabled\s*=\s*false/i.test(stmt)) onConflict = "do_update_false";
      writes.push({ file, num: parseInt(file.slice(0, 4), 10), insertedEnabled, onConflict });
    }
  }
  return writes.sort((a, b) => a.num - b.num);
}

/** Simulate the writes in order against an empty feature_flags table. */
function effectiveDefault(writes: FlagWrite[]): boolean | null {
  let value: boolean | null = null; // null = row absent
  for (const w of writes) {
    if (value === null) {
      value = w.insertedEnabled; // first insert lands regardless of ON CONFLICT
    } else if (w.onConflict === "do_update_true") {
      value = true;
    } else if (w.onConflict === "do_update_false") {
      value = false;
    } // do_nothing / none on an existing row: no change
  }
  return value;
}

describe("rent_buddy_enabled defaults OFF after a clean migration", () => {
  const writes = scanFlagWrites();

  it("the migration scan actually found the flag's writes (guard against scanning nothing)", () => {
    assert.ok(writes.length >= 2, `expected multiple rent_buddy_enabled seeds, found ${writes.length}`);
  });

  it("a clean migration / restore leaves the master switch FALSE", () => {
    assert.equal(
      effectiveDefault(writes),
      false,
      `clean-migration default must be false; sequence was ${JSON.stringify(writes.map((w) => [w.file, w.insertedEnabled, w.onConflict]))}`,
    );
  });

  it("the LAST write to the flag forces it FALSE (so a restore cannot re-enable it)", () => {
    const last = writes[writes.length - 1];
    assert.equal(last.onConflict, "do_update_false", `the final rent_buddy_enabled write (${last.file}) must force it false`);
    assert.equal(last.insertedEnabled, false);
  });

  it("no migration re-forces the flag TRUE after the final FALSE (regression: 0090 was overridden)", () => {
    const lastFalseIdx = writes.map((w) => w.onConflict).lastIndexOf("do_update_false");
    const forcedTrueAfter = writes.slice(lastFalseIdx + 1).some((w) => w.onConflict === "do_update_true" || (w.insertedEnabled === true && w.onConflict === "none"));
    assert.equal(forcedTrueAfter, false, "nothing may force rent_buddy_enabled true after the final false");
  });

  it("0117's TRUE seed is an inert no-op (ON CONFLICT DO NOTHING), never a force", () => {
    const w0117 = writes.find((w) => w.file.startsWith("0117"));
    assert.ok(w0117, "0117 should still seed the flag");
    assert.equal(w0117!.onConflict, "do_nothing", "0117 must not force the flag on");
  });

  it("the flag is actually read by the access gate (not a dead default)", () => {
    const rollout = readFileSync(resolve(MIGRATIONS, "../routes/rentABuddyRollout.ts"), "utf8");
    assert.match(rollout, /getFlag\([^)]*,\s*["']rent_buddy_enabled["']\)/, "checkRentBuddyAccess must read rent_buddy_enabled so the OFF default gates access");
  });
});
