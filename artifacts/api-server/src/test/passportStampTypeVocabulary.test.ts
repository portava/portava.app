/**
 * passport_stamps.stamp_type — the CHECK vocabulary and the two writers that
 * share it.
 *
 * WHAT THIS GUARDS
 * ================
 * `public.passport_stamps` has two writers with two different stamp_type
 * vocabularies:
 *
 *   1. StampAwardEngine copies `stamp_definitions.stamp_type` (the CATALOG
 *      vocabulary: verification | destination | event | trip | achievement |
 *      host | rent_a_buddy).
 *   2. services/passport/PassportStampService.createStamp declares its own
 *      `StampType` union (city | neighborhood | plan | host | hidden_gem |
 *      safe_return | activity | trip_crew | compass_ai | qr_checkin).
 *
 * Until migration 2309 the CHECK permitted only vocabulary (1), so every one of
 * the five production call sites of createStamp — routes/location.ts:333,
 * routes/hiddenGems.ts:924, routes/geofence.ts:633, routes/safeReturn.ts:401,
 * routes/airport.ts:456 — had its INSERT rejected 23514, silently, forever
 * (createStamp logs and returns null; every caller ignores the null).
 *
 * These tests read the LIVE constraint definition out of the migration tree the
 * same way the database would build it (baseline, then every migration that
 * redefines the constraint, in numeric order — last one wins) and assert that
 * every label either writer can emit is permitted.
 *
 * MUTATION PROOF. Delete any label from the ARRAY in
 * `2309_passport_stamp_type_vocabulary.sql` and the containment test goes RED
 * naming that label; add a member to `StampType` in PassportStampService
 * without adding it to the vocabulary and it goes RED too. The last test also
 * fails if the whole 2309 file is reverted.
 *
 * Run: node --import tsx/esm --test src/test/passportStampTypeVocabulary.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API_SERVER = path.resolve(HERE, "../..");
const MIGRATIONS = path.join(API_SERVER, "src/migrations");
const BASELINE = path.join(API_SERVER, "baseline/20260819_baseline_structure.sql");

const CONSTRAINT = "passport_stamps_stamp_type_check";

/**
 * The labels a CHECK definition permits. Handles both the baseline's dumped
 * form — `CHECK ((stamp_type = ANY (ARRAY['a'::text, 'b'::text])))` — and the
 * migration form `CHECK (stamp_type = ANY (ARRAY['a','b']::text[]))`.
 */
function labelsOf(constraintBody: string): string[] {
  const arr = /ARRAY\s*\[([\s\S]*?)\]/.exec(constraintBody);
  if (!arr) return [];
  return [...arr[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/** Numeric prefix of a migration filename, for ordering. */
function prefixOf(file: string): number {
  const m = /^(\d+)/.exec(file);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

/**
 * Rebuild the vocabulary the database ends up with: the baseline definition,
 * then every migration that re-adds the constraint, in numeric order.
 */
function liveVocabulary(): { labels: string[]; source: string } {
  let labels: string[] = [];
  let source = "(none)";

  const baseline = fs.readFileSync(BASELINE, "utf8");
  const baseMatch = new RegExp(`CONSTRAINT ${CONSTRAINT} (CHECK[\\s\\S]*?)\\n`).exec(baseline);
  if (baseMatch) {
    labels = labelsOf(baseMatch[1]);
    source = "baseline";
  }

  const files = fs
    .readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort((a, b) => prefixOf(a) - prefixOf(b) || a.localeCompare(b));

  for (const f of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS, f), "utf8");
    // Only real DDL: skip the commented-out ROLLBACK block every widening
    // migration carries, which restates the OLD narrower vocabulary.
    const ddl = sql
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    const re = new RegExp(`ADD CONSTRAINT\\s+${CONSTRAINT}\\s+(CHECK[\\s\\S]*?);`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(ddl))) {
      const found = labelsOf(m[1]);
      if (found.length) {
        labels = found;
        source = f;
      }
    }
  }
  return { labels, source };
}

/** The `StampType` union declared by PassportStampService, read from source. */
function declaredStampTypes(): string[] {
  const src = fs.readFileSync(
    path.join(API_SERVER, "src/services/passport/PassportStampService.ts"),
    "utf8",
  );
  const m = /export type StampType\s*=([\s\S]*?);/.exec(src);
  assert.ok(m, "PassportStampService must still declare `export type StampType`");
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

describe("passport_stamps.stamp_type vocabulary", () => {
  it("permits every label PassportStampService.createStamp can write", () => {
    const { labels, source } = liveVocabulary();
    assert.ok(labels.length > 0, "could not read the stamp_type CHECK vocabulary at all");

    const declared = declaredStampTypes();
    assert.ok(declared.length >= 10, `expected the full StampType union, got ${declared.join(",")}`);

    const missing = declared.filter((t) => !labels.includes(t));
    assert.deepEqual(
      missing,
      [],
      `stamp_type CHECK (last set by ${source}) rejects ${missing.length} label(s) ` +
        `createStamp writes: ${missing.join(", ")}. Every INSERT carrying one is ` +
        `rejected 23514 and silently swallowed by createStamp's null return.`,
    );
  });

  it("still permits every catalog label StampAwardEngine writes", () => {
    // The widening must never narrow: these seven are what the pre-2309
    // constraint allowed and what all 20 production rows carry.
    const { labels, source } = liveVocabulary();
    for (const catalogType of [
      "verification",
      "destination",
      "event",
      "trip",
      "achievement",
      "host",
      "rent_a_buddy",
    ]) {
      assert.ok(
        labels.includes(catalogType),
        `${source} dropped catalog label '${catalogType}' — existing rows would fail revalidation`,
      );
    }
  });

  it("permits the two labels the privacy guard redacts on (safe_return, hidden_gem)", () => {
    // PassportPrivacyGuard.guardStamp suppresses neighborhood/place_id for
    // these two. A vocabulary that rejects them turns those branches into dead
    // code that reads as a live privacy gate.
    const { labels, source } = liveVocabulary();
    for (const sensitive of ["safe_return", "hidden_gem"]) {
      assert.ok(
        labels.includes(sensitive),
        `${source} rejects '${sensitive}', so guardStamp's redaction branch for it can never fire`,
      );
    }
  });

  it("the widening migration exists in the 2100-2999 band and is transactional", () => {
    const file = path.join(MIGRATIONS, "2309_passport_stamp_type_vocabulary.sql");
    assert.ok(fs.existsSync(file), "2309_passport_stamp_type_vocabulary.sql is missing");
    const sql = fs.readFileSync(file, "utf8");
    assert.match(sql, /^BEGIN;/m, "ADD CONSTRAINT revalidates rows; it must be in a transaction");
    assert.match(sql, /^COMMIT;/m);
    assert.match(sql, /DROP CONSTRAINT IF EXISTS/, "must be re-runnable");
  });
});
