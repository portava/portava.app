/**
 * The stale-snapshot tripwire in checkFlagSchemaPrerequisites must actually fire.
 *
 * ── THE DEFECT CLASS ─────────────────────────────────────────────────────────
 * checkFlagSchemaPrerequisites grades production behaviour against a FROZEN
 * snapshot file. On 2026-09-08 it reported green while judging a capture taken
 * before eighteen migrations were applied: four of its KNOWN entries described
 * defects that had already been fixed, and it could not tell. A frozen file has
 * no way to notice the world moved underneath it.
 *
 * Two failures are now detected, and this file proves BOTH fire — a guard nobody
 * has seen fail is not a guard.
 *
 *   1. STALE — production-applied-migrations.json (committed alongside each
 *      apply) records a version newer than the snapshot's watermark.
 *   2. HAND-EDITED / PARTIALLY REFRESHED — the snapshot's recorded checksums do
 *      not match its own contents. This is the more dangerous of the two,
 *      because a partial refresh LOOKS current.
 *
 * Both checks are entirely OFFLINE: they compare two committed files and make no
 * database connection, so ordinary CI does not gain a production dependency.
 *
 * The control case matters as much as the failures. A tripwire that fired
 * unconditionally would pass both mutation cases below and break every build —
 * so the unmodified pair must still exit 0.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/snapshotFreshnessGuard.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const API_ROOT = resolve(HERE, "..", "..");
const CHECKER = join(API_ROOT, "src", "scripts", "checkFlagSchemaPrerequisites.ts");
const SNAPSHOT = join(API_ROOT, "src", "lib", "capability", "snapshots", "20260908-production-schema.json");
const APPLIED = join(API_ROOT, "src", "lib", "capability", "production-applied-migrations.json");

let tmp = "";
before(() => { tmp = mkdtempSync(join(tmpdir(), "snapfresh-")); });
after(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); });

/** Run the checker with optional file overrides; return its exit code + output. */
function runChecker(env: Record<string, string> = {}) {
  const r = spawnSync(
    process.execPath,
    ["--import", "tsx/esm", CHECKER],
    {
      cwd: API_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        SUPABASE_URL: "http://127.0.0.1:9",
        SUPABASE_SERVICE_ROLE_KEY: "dummy",
        ...env,
      },
      // The checker walks the whole tree; give it room.
      timeout: 180_000,
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

describe("snapshot freshness tripwire", () => {
  it("CONTROL — the committed snapshot and applied-list agree, so the check runs", () => {
    // Without this, a tripwire that fired unconditionally would pass both
    // mutation cases below while breaking every build.
    const { code } = runChecker();
    assert.equal(code, 0, "the unmodified snapshot/applied pair must not trip the guard");
  });

  it("FAILS when a migration is recorded as applied AFTER the snapshot was captured", () => {
    const applied = JSON.parse(readFileSync(APPLIED, "utf8"));
    applied.migrations.push({
      version: "20260909999999",
      name: "2999_a_migration_applied_after_the_snapshot",
    });
    const p = join(tmp, "applied-newer.json");
    writeFileSync(p, JSON.stringify(applied, null, 1));

    const { code, out } = runChecker({ FLAG_SCHEMA_APPLIED: p });
    assert.notEqual(code, 0, "a snapshot older than a recorded apply must not report green");
    assert.match(out, /STALE SNAPSHOT/);
    // It must name what is missing, or the operator cannot act on it.
    assert.match(out, /2999_a_migration_applied_after_the_snapshot/);
  });

  it("FAILS when the snapshot has been hand-edited (checksums no longer match)", () => {
    const snap = JSON.parse(readFileSync(SNAPSHOT, "utf8"));
    // Quietly drop the column migration 2420 added. This is exactly the shape of
    // a partial refresh — the file still parses and still looks plausible.
    snap.tables.trips = (snap.tables.trips as string[]).filter((c) => c !== "version");
    const p = join(tmp, "snap-edited.json");
    writeFileSync(p, JSON.stringify(snap, null, 1));

    const { code, out } = runChecker({ FLAG_SCHEMA_SNAPSHOT: p });
    assert.notEqual(code, 0, "a hand-edited snapshot must not be graded against");
    assert.match(out, /SNAPSHOT CHECKSUM MISMATCH \(tables\)/);
  });

  it("FAILS when a flag value is silently altered in the snapshot", () => {
    const snap = JSON.parse(readFileSync(SNAPSHOT, "utf8"));
    // Flipping a flag in the snapshot would change which capabilities the check
    // believes are live in production — the most consequential thing to fake.
    const someFlag = Object.keys(snap.flags)[0];
    snap.flags[someFlag] = !snap.flags[someFlag];
    const p = join(tmp, "snap-flagflip.json");
    writeFileSync(p, JSON.stringify(snap, null, 1));

    const { code, out } = runChecker({ FLAG_SCHEMA_SNAPSHOT: p });
    assert.notEqual(code, 0);
    assert.match(out, /SNAPSHOT CHECKSUM MISMATCH \(flags\)/);
  });

  it("only WARNS on a legacy snapshot that carries neither field", () => {
    // An old capture must not hard-fail a checkout that has not been refreshed
    // yet — the guard degrades to a warning rather than blocking work.
    const snap = JSON.parse(readFileSync(SNAPSHOT, "utf8"));
    delete snap.productionMigrationWatermark;
    delete snap.checksums;
    const p = join(tmp, "snap-legacy.json");
    writeFileSync(p, JSON.stringify(snap, null, 1));

    const { code, out } = runChecker({ FLAG_SCHEMA_SNAPSHOT: p });
    assert.equal(code, 0, "a legacy snapshot warns, it does not fail");
    assert.match(out, /legacy snapshot/);
  });
});
