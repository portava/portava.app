/**
 * report:migration-inventory — LEDGER EVIDENCE AND OBSERVED STATE, SEPARATELY.
 *
 *
 * WHAT THIS REPLACES, AND WHY IT IS A NEW SCRIPT RATHER THAN AN EDIT
 * ==================================================================
 * An inventory reported that production carried ZERO `schema_migration_ledger`
 * rows at or above 2890. It carried 20 when this script was written, and 2950
 * is fully applied there. The owner's ruling was NOT to backfill "applied"
 * records on object-probe evidence, but to make the tooling report ledger
 * evidence and observed database state as SEPARATE dimensions that are never
 * collapsed. The two defects that produced the zero — two ledgers with disjoint
 * columns, and one text column holding two version formats — are refused in
 * code by src/scripts/lib/migrationInventoryCore.ts; its header carries the
 * reproduction, with the literal query results.
 *
 * This is an ADDITION. check:migration-ledger keeps its 0/1/2 contract and its
 * behaviour untouched, because CI reads it; nothing here repurposes its output.
 *
 *
 * WHAT IT REPORTS, IN TWO SECTIONS THAT NEVER MERGE
 * ================================================
 *   LEDGER EVIDENCE        per migration, from BOTH ledgers, each row placed in
 *                          exactly one of: verified execution (a real sha256
 *                          AND an applied_at), historical backfill (the
 *                          'backfill' sentinel — filename parity and nothing
 *                          more), or a row that verifies neither.
 *   OBSERVED SCHEMA STATE  the objects the migration declares, the subset a
 *                          probe actually examined, the properties compared,
 *                          and what is absent or the wrong shape.
 *
 * Two of every three findings in this repository's history are a DISAGREEMENT
 * between those sections, which is why they must be able to disagree:
 *   * 2298_dead_check_vocabularies.sql — a ledger row whose effects were absent.
 *   * 2890 / 2900 / 2958 — live in production with no hand-ledger row; 2958 has
 *     no row in EITHER ledger under its repository filename.
 *
 *
 * WHAT IT CANNOT TELL YOU
 * =======================
 * Whether every statement in a migration ran. It probes tables and columns
 * through information_schema; a migration that also creates an index, a
 * function, a policy or a trigger has those counted as DECLARED and listed as
 * NOT EXAMINED, and the report refuses to round "2 of 10 present" up to
 * "applied". certifyMigrations.ts stage 4 — which re-runs the migrations' own
 * postcondition DO blocks — is the stronger instrument; this is the cheap one
 * you can point at any database, and it says which it is.
 *
 *
 * READ-ONLY, AND NOTHING ELSE
 * ===========================
 * Every statement this script sends is a SELECT:
 *   1. to_regclass() existence probes for both ledger tables;
 *   2. `select filename, checksum, applied_by, applied_at, notes from
 *      public.schema_migration_ledger` (no WHERE — see below);
 *   3. `select version, name from supabase_migrations.schema_migrations`;
 *   4. `select table_schema, table_name, column_name, is_nullable,
 *      column_default, data_type from information_schema.columns` over every
 *      non-system schema — public AND authz, because reading only public would
 *      report every authz object absent and a false "missing" is as damaging
 *      here as a false "applied".
 * No INSERT, UPDATE, DELETE, DDL, RPC or auth-admin call. It never writes a
 * ledger row; when it finds something that needs writing it prints that fact
 * and exits, which is the whole of the owner's ruling.
 *
 * NO WHERE CLAUSE ON EITHER LEDGER READ, DELIBERATELY. A band filter cannot be
 * expressed in SQL over either table without falling into one of the two traps:
 * a text `>=` on the CLI table's mixed-format `version` excludes every
 * post-cutover row, and a numeric cast over the hand ledger's `filename`
 * scoops up imported files whose names begin with a 14-digit instant (47 rows
 * where the correct band filter returns 20). Both tables are a few hundred rows;
 * they come back whole and the banding happens in memory over PARSED serials.
 *
 *
 * Usage (from artifacts/api-server):
 *   pnpm run report:migration-inventory                 # whole chain
 *   pnpm run report:migration-inventory -- --from 2890  # a band
 *   pnpm run report:migration-inventory -- --from 2890 --to 2999
 *   pnpm run report:migration-inventory -- --file 2950_input_assistance_telemetry_events.sql
 *
 * Exit code 0 → a report was established and the two sections agree
 * Exit code 2 → environment / API error — CANNOT establish a result. Missing
 *               credentials land here, never on 0.
 * Exit code 3 → a report was established AND the sections DISAGREE: a ledger
 *               row records an apply whose objects are absent, or an object is
 *               present with no ledger row anywhere. Both need a human.
 *
 * 1 is deliberately unused. check:migration-ledger's 1 means "this database
 * does not represent this branch" and CI reads it; a report that reused the
 * number would be mistaken for that verdict.
 */

// ── THE TARGET ASSERTION, IN THE EXECUTION PATH ──────────────────────────────
//
// FIRST import, deliberately: ES modules evaluate imports in source order,
// before the importing module's body, so this runs before any credential is
// read and before any request is built.
//
// THE READ-ONLY DOOR, NOT THE STRICT ONE, AND WHY. The false zero was a claim
// about PRODUCTION, and a tool that cannot be pointed at production cannot
// settle it; check:migration-ledger takes the strict door and pays exactly that
// cost, stated in its own header. This script is therefore listed in
// READ_ONLY_AUDIT_ENTRY_POINTS in scripts/check-guard-coverage.mjs with the
// four SELECTs above written out, which is what makes the grant a reviewable
// diff rather than an import nobody notices. In CI the two doors behave
// identically — the sanctioned CI project, or exit 2. Outside CI, and only
// outside CI, this one additionally permits a read-only audit of declared
// production when the operator asks for it by name:
//
//   PORTAVA_PROD_READ_ONLY_AUDIT='read-only-audit-against-production'
//
// If this script ever gains a write, move this import back to
// ../lib/ciSupabaseGuard.mjs and delete its entry from that list, in the same
// change.
import "../lib/ciProdReadOnlyAuditGuard.mjs";

import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { stripSqlComments } from "./lib/canonicalSchema.js";
import { listMigrationFiles } from "./lib/migrationLedgerCore.js";
import {
  CLI_LEDGER,
  HAND_LEDGER,
  bandMembers,
  buildLedgerSelect,
  classifyMigration,
  decideInventoryExitCode,
  extractDeclaredObjects,
  formatInventoryReport,
  newestApply,
  newestApplyByInstant,
  profileVersionColumn,
  requireCredentials,
  serialFromCliRow,
  serialFromFilename,
  summariseInventory,
  type Attribution,
  type LedgerEvidence,
  type MigrationObservation,
  type ObjectProbe,
  type SerialBand,
  type VersionedApply,
} from "./lib/migrationInventoryCore.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dir, "../migrations");
const PKG_ROOT = resolve(__dir, "../..");

// ── Arguments ─────────────────────────────────────────────────────────────────

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

const onlyFile = argValue("--file");
const fromArg = argValue("--from");
const toArg = argValue("--to");

/** The default band is the whole canonical range; --from/--to narrow it. */
const band: SerialBand = {
  from: fromArg === undefined ? 0 : Number(fromArg),
  to: toArg === undefined ? 9999 : Number(toArg),
};
if (!Number.isInteger(band.from) || !Number.isInteger(band.to) || band.from > band.to) {
  console.error(
    `ERROR: --from/--to must be integers with from <= to; got from=${band.from} to=${band.to}.`,
  );
  process.exit(2);
}

// ── Environment ───────────────────────────────────────────────────────────────
//
// Same pair and same precedence as checkMigrationLedger.ts. The values are
// handed to requireCredentials() as plain strings; the pure core deliberately
// never learns the variable names.

const rawUrl = process.env.SUPABASE_URL;
const rawToken =
  process.env.SUPABASE_PROJECT_TOKEN || process.env.SUPABASE_ACCESS_TOKEN;

const creds = requireCredentials(rawUrl, rawToken);
if (!creds.ok) {
  const wanted = creds.missing
    .map((m) =>
      m === "url"
        ? "SUPABASE_URL"
        : "SUPABASE_PROJECT_TOKEN (project-scoped, preferred for CI) or SUPABASE_ACCESS_TOKEN",
    )
    .join(" and ");
  console.error(
    `ERROR: ${wanted} must be set.\n` +
      "       This reporter FAILS CLOSED: it cannot read either ledger, so it cannot say\n" +
      "       what this database has run, and it will not print a report it has no\n" +
      "       evidence for.",
  );
  process.exit(creds.exitCode);
}

const token = creds.token;

let projectRef: string;
try {
  projectRef = new URL(creds.url).hostname.split(".")[0];
} catch {
  console.error(
    "ERROR: SUPABASE_URL is not a URL, so no project ref can be resolved from it.\n" +
      "       Every observation this reporter prints names its target; without a ref there\n" +
      "       is nothing to name and the report would be unattributable.",
  );
  process.exit(2);
}

// ── Transport ─────────────────────────────────────────────────────────────────

async function liveQuery<T = Record<string, unknown>>(query: string): Promise<T[]> {
  const res = await fetch(
    `https://api.supabase.com/v1/projects/${projectRef}/database/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
    },
  );
  if (!res.ok) {
    throw new Error(`Management API ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T[];
}

function fail(message: string): never {
  console.error(`ERROR: ${message}`);
  process.exit(2);
}

// ── Read the files ────────────────────────────────────────────────────────────

const MIGRATIONS_LABEL = `${relative(PKG_ROOT, MIGRATIONS_DIR)}/`;

let filenames: string[];
try {
  filenames = listMigrationFiles(MIGRATIONS_DIR);
} catch (err) {
  fail(`could not read ${MIGRATIONS_DIR}: ${(err as Error).message}`);
}

if (filenames.length === 0) {
  fail(
    `no .sql files in ${MIGRATIONS_DIR}. An inventory over an empty file set establishes ` +
      "nothing and must not print a report.",
  );
}

// ── SELECTION, WHICH MUST NOT SILENTLY DROP WHAT IT CANNOT PARSE ────────────
//
// 27 of the files in src/migrations/ carry a DATE prefix rather than a 4-digit
// serial (20260720_compass_preference_columns.sql and friends), so
// serialFromFilename() returns null for them. Selecting only `inBand` would
// drop all 27 without a word — the same silent-drop that turns a count into a
// zero, reintroduced at the selection step instead of in the SQL.
//
// So: with no band asked for, EVERY file is examined, unattributable ones
// included. With a band asked for, the unattributable files are excluded (a
// band is a question about serials, and a file with no serial has no answer)
// and their number is PRINTED, so the reader knows the report is partial and by
// how much.
const bandTally = bandMembers(filenames, serialFromFilename, band);
const bandAsked = fromArg !== undefined || toArg !== undefined;
const selected = onlyFile
  ? filenames.filter((f) => f === onlyFile)
  : bandAsked
    ? bandTally.inBand
    : filenames;

if (selected.length === 0) {
  fail(
    onlyFile
      ? `${onlyFile} is not in ${MIGRATIONS_LABEL}.`
      : `no migration file in ${MIGRATIONS_LABEL} has a 4-digit serial in [${band.from}, ${band.to}] ` +
          `(${bandTally.outOfBand.length} out of band, ${bandTally.unattributable.length} with no ` +
          "4-digit serial at all). An empty selection is reported as an error, not as a clean report " +
          "over nothing — an inventory that examined nothing established nothing.",
  );
}

const observedAt = new Date().toISOString();

console.log(
  `report:migration-inventory — ${selected.length} of ${filenames.length} migration file(s) from ` +
    `${MIGRATIONS_LABEL} against project ${projectRef}, observed ${observedAt}.`,
);
if (bandAsked) {
  console.log(
    `  band [${band.from}, ${band.to}] over 4-digit serials: ${bandTally.inBand.length} in band, ` +
      `${bandTally.outOfBand.length} out of band, ${bandTally.unattributable.length} EXCLUDED because ` +
      "their filename carries no 4-digit serial (date-prefixed imports). A band is a question about " +
      "serials; a file without one has no answer, and its exclusion is printed rather than silent.",
  );
} else if (onlyFile === undefined) {
  console.log(
    `  no band asked for, so every file is examined — including the ${bandTally.unattributable.length} ` +
      "whose filename carries no 4-digit serial.",
  );
}
console.log("");

// ── Both ledgers, each read on its own terms ─────────────────────────────────
//
// buildLedgerSelect() refuses a column the named table does not have, so the
// two reads below CANNOT be written for the wrong table: asking the hand ledger
// for `version`, or the CLI table for `filename`, throws with the other table
// named rather than returning a confident wrong answer.

interface HandRow {
  filename: string;
  checksum: string | null;
  applied_by: string | null;
  applied_at: string | null;
  notes: string | null;
}

async function tableExists(qualified: string): Promise<boolean> {
  const rows = await liveQuery<{ present: boolean }>(
    `select (to_regclass('${qualified}') is not null) as present`,
  );
  return rows[0]?.present === true;
}

let handRows: HandRow[] = [];
let cliRows: VersionedApply[] = [];
let handPresent = false;
let cliPresent = false;

try {
  handPresent = await tableExists(HAND_LEDGER.table);
  cliPresent = await tableExists(CLI_LEDGER.table);
} catch (err) {
  fail(`could not query project ${projectRef}: ${(err as Error).message}`);
}

if (!handPresent && !cliPresent) {
  fail(
    `neither ${HAND_LEDGER.table} nor ${CLI_LEDGER.table} exists on ${projectRef}. With no ledger at ` +
      "all there is no ledger evidence to report, and observed schema state alone is NOT evidence that " +
      "anything ran — which is precisely the inference this reporter exists to refuse.",
  );
}

try {
  if (handPresent) {
    handRows = await liveQuery<HandRow>(
      buildLedgerSelect(HAND_LEDGER, [
        "filename",
        "checksum",
        "applied_by",
        "applied_at",
        "notes",
      ]),
    );
  }
  if (cliPresent) {
    const raw = await liveQuery<{ version: string; name: string | null }>(
      buildLedgerSelect(CLI_LEDGER, ["version", "name"]),
    );
    cliRows = raw.map((r) => ({ version: r.version, name: r.name, appliedAt: null }));
  }
} catch (err) {
  fail(`could not read a ledger on ${projectRef}: ${(err as Error).message}`);
}

// ── The version column, profiled before anything is asked of it ─────────────
//
// Printed FIRST, and unconditionally, because the reader who is about to
// believe a number needs to know that this column has no order. On production
// this prints two formats and the refusal below.

console.log("LEDGER SHAPE — both tables, and what their key columns can support:");
console.log(
  `  ${HAND_LEDGER.table}: ${handPresent ? `${handRows.length} row(s)` : "ABSENT"}` +
    `, keyed by ${HAND_LEDGER.identityColumn} (no '${CLI_LEDGER.identityColumn}' column)`,
);
console.log(
  `  ${CLI_LEDGER.table}: ${cliPresent ? `${cliRows.length} row(s)` : "ABSENT"}` +
    `, keyed by ${CLI_LEDGER.identityColumn} (no '${HAND_LEDGER.identityColumn}' column)`,
);

if (cliPresent) {
  const profile = profileVersionColumn(cliRows.map((r) => r.version));
  console.log(
    `  ${CLI_LEDGER.identityColumn} formats: ` +
      profile.formats.map((f) => `${f}=${profile.counts[f]}`).join(", ") +
      (profile.mixed ? "  ← MIXED" : ""),
  );
  const lexMax = newestApply(cliRows);
  if (!lexMax.ok) {
    console.log(`  MAX(${CLI_LEDGER.identityColumn}) REFUSED: ${lexMax.reason}`);
    // Named explicitly, because this is the number the false-zero inventory
    // trusted and scripts/refresh-production-snapshot.md still prints the query
    // for. Showing what it WOULD have said is what makes the refusal legible.
    const wouldHaveSaid = cliRows
      .map((r) => r.version)
      .reduce((a, b) => (b > a ? b : a), cliRows[0]?.version ?? "");
    console.log(
      `    a text MAX over this column would have answered '${wouldHaveSaid}' — quote that as a watermark ` +
        "and every freshness check built on it reports this database months behind.",
    );
  } else {
    console.log(
      `  newest ${CLI_LEDGER.identityColumn} (single format, so ordered): ${lexMax.value.version}`,
    );
  }
}

if (handPresent && handRows.length > 0) {
  const byInstant = newestApplyByInstant(
    handRows.map((r) => ({ version: r.filename, name: null, appliedAt: r.applied_at })),
  );
  console.log(
    byInstant.ok
      ? `  newest ${HAND_LEDGER.table} apply BY INSTANT: ${byInstant.value.appliedAt} (${byInstant.value.version})`
      : `  newest ${HAND_LEDGER.table} apply by instant REFUSED: ${byInstant.reason}`,
  );
}

// The band tally over the hand ledger, done in memory over parsed serials. This
// is the number the false zero got wrong, printed with the two wrong ways of
// getting it named alongside.
if (handPresent) {
  const tally = bandMembers(handRows, (r) => serialFromFilename(r.filename), band);
  console.log(
    `  ${HAND_LEDGER.table} rows with a 4-digit serial in [${band.from}, ${band.to}]: ` +
      `${tally.inBand.length}  (out of band ${tally.outOfBand.length}, ` +
      `serial unattributable ${tally.unattributable.length} — reported, never dropped)`,
  );
}
if (cliPresent) {
  const tally = bandMembers(cliRows, serialFromCliRow, band);
  console.log(
    `  ${CLI_LEDGER.table} rows whose serial (from ${CLI_LEDGER.identityColumn} OR from name) is in ` +
      `[${band.from}, ${band.to}]: ${tally.inBand.length}  (out of band ${tally.outOfBand.length}, ` +
      `serial unattributable ${tally.unattributable.length})`,
  );
}
console.log("");

// ── The live catalog, for the probes ────────────────────────────────────────

interface ColumnRow {
  table_schema: string;
  table_name: string;
  column_name: string;
  is_nullable: string;
  column_default: string | null;
  data_type: string;
}

// NOT `where table_schema = 'public'`. extractDeclaredObjects() keeps the
// schema a migration actually writes, and this repository puts real objects
// outside public — `authz.is_active_thread_member(uuid)` is 2402's central
// object. Reading only public would report every authz object ABSENT, which is
// a confident answer about the wrong thing: exactly the failure this whole
// script exists to stop, with the sign flipped.
let columnRows: ColumnRow[];
try {
  columnRows = await liveQuery<ColumnRow>(
    "select table_schema, table_name, column_name, is_nullable, column_default, data_type " +
      "from information_schema.columns " +
      "where table_schema not in ('pg_catalog', 'information_schema') " +
      "and table_schema not like 'pg_toast%' and table_schema not like 'pg_temp%'",
  );
} catch (err) {
  fail(`could not read information_schema.columns on ${projectRef}: ${(err as Error).message}`);
}

const liveTables = new Set(columnRows.map((r) => `${r.table_schema}.${r.table_name}`));
const liveColumns = new Map<string, ColumnRow>();
for (const r of columnRows) {
  liveColumns.set(`${r.table_schema}.${r.table_name}.${r.column_name}`, r);
}

/** The property this probe compares, named in the report. */
const TABLE_PROPERTY = "exists(information_schema.columns)";
const COLUMN_PROPERTY = "exists+data_type+is_nullable+column_default";

// ── Per migration ────────────────────────────────────────────────────────────

const handByFilename = new Map<string, HandRow>();
for (const r of handRows) handByFilename.set(r.filename, r);

const cliBySerial = new Map<number, VersionedApply[]>();
for (const r of cliRows) {
  const serial = serialFromCliRow(r);
  if (serial === null) continue;
  const list = cliBySerial.get(serial) ?? [];
  list.push(r);
  cliBySerial.set(serial, list);
}

// ── WHICH OBJECT IS UNIQUE TO WHICH FILE ────────────────────────────────────
//
// Without this, a shared object silently credits the wrong migration. 2402
// recreates 2401's `msg_select` policy, so observing `msg_select` is evidence
// for EITHER file; the one piece of 2401-specific evidence is
// `messages_hide_blocked_sender`, which no other migration in the tree
// declares. The index below is built over the WHOLE chain, not just the
// selection, because "no other migration declares this" is a claim about the
// tree and a claim over a --from band would be false by omission.
//
// It inherits extractDeclaredObjects()'s floor: an object declared only inside
// a DO block is invisible here, so an object this calls exclusive may in
// principle be declared elsewhere in a form this cannot see. That is stated in
// the method string the report prints, rather than left for the reader to
// discover.
const ATTRIBUTION_METHOD =
  `extractDeclaredObjects() over all ${filenames.length} file(s) in ${MIGRATIONS_LABEL}; an object is ` +
  "EXCLUSIVE when exactly one file declares it. Inherits that extractor's floor — DDL built inside a DO " +
  "block or a dynamic EXECUTE is not seen, so exclusivity is a claim about statements spelled in the " +
  "ordinary way.";

const filesByObject = new Map<string, string[]>();
for (const filename of filenames) {
  let sql: string;
  try {
    sql = stripSqlComments(readFileSync(join(MIGRATIONS_DIR, filename), "utf8"));
  } catch (err) {
    fail(`could not read ${filename}: ${(err as Error).message}`);
  }
  for (const key of extractDeclaredObjects(sql).map((d) => d.key)) {
    const owners = filesByObject.get(key) ?? [];
    owners.push(filename);
    filesByObject.set(key, owners);
  }
}

const observations: MigrationObservation[] = [];

for (const filename of selected) {
  let sql: string;
  try {
    sql = stripSqlComments(readFileSync(join(MIGRATIONS_DIR, filename), "utf8"));
  } catch (err) {
    fail(`could not read ${filename}: ${(err as Error).message}`);
  }

  const declared = extractDeclaredObjects(sql);
  const probes: ObjectProbe[] = [];

  for (const obj of declared) {
    if (!obj.probeable) continue;
    if (obj.kind === "table") {
      probes.push({
        object: obj.key,
        property: TABLE_PROPERTY,
        state: liveTables.has(obj.key) ? "present" : "absent",
      });
      continue;
    }
    const live = liveColumns.get(obj.key);
    if (!live) {
      // A column of a table that is itself absent is still reported as an
      // absent column: naming the column is what a reader can act on, and the
      // absent table appears in its own probe on the same migration.
      probes.push({ object: obj.key, property: COLUMN_PROPERTY, state: "absent" });
      continue;
    }
    probes.push({
      object: obj.key,
      property: COLUMN_PROPERTY,
      state: "present",
      found: `${live.data_type}, nullable=${live.is_nullable}, default=${live.column_default ?? "(none)"}`,
    });
  }

  const evidence: LedgerEvidence[] = [];
  const hand = handByFilename.get(filename);
  if (hand) {
    evidence.push({
      ledger: "hand",
      identity: hand.filename,
      checksum: hand.checksum,
      appliedBy: hand.applied_by,
      appliedAt: hand.applied_at,
      notes: hand.notes,
    });
  }
  const serial = serialFromFilename(filename);
  for (const cli of serial === null ? [] : (cliBySerial.get(serial) ?? [])) {
    evidence.push({
      ledger: "cli",
      identity: cli.version,
      // The CLI table HAS NO checksum column, so there is nothing to compare
      // and null is the honest value. Substituting the file's own hash here
      // would manufacture a verified execution out of a row that verifies
      // nothing — the exact fabrication the owner's ruling forbids.
      checksum: null,
      appliedBy: "supabase-cli-or-management-api",
      appliedAt: null,
      notes: cli.name ?? null,
    });
  }

  // Attribution is computed over the objects actually OBSERVED PRESENT: an
  // absent object attributes nothing to anybody.
  const observedPresent = probes.filter((p) => p.state === "present").map((p) => p.object);
  const attribution: Attribution = {
    exclusive: observedPresent.filter((o) => (filesByObject.get(o) ?? []).length === 1),
    shared: observedPresent
      .filter((o) => (filesByObject.get(o) ?? []).length > 1)
      .map((o) => ({
        object: o,
        alsoDeclaredBy: (filesByObject.get(o) ?? []).filter((f) => f !== filename),
      })),
    method: ATTRIBUTION_METHOD,
  };

  observations.push(
    classifyMigration(
      {
        filename,
        declaredObjects: declared.map((d) => d.key),
        probes,
        ledgerEvidence: evidence,
        // NO `statements` FIELD, DELIBERATELY. This transport checks tables and
        // columns through information_schema; it does not enumerate the file's
        // executable statements and cannot verify a policy qual, a function
        // body, a grant or a trigger. Supplying a statement count here without
        // a verifying check for each statement is how "partial coverage" would
        // become "full statement coverage" on evidence that does not support
        // it, so this script stays permanently in the partial grade — which is
        // the honest grade for it. A statement-complete reading, like the one
        // taken of 2401 and 2402 by hand, supplies `statements` itself.
        attribution,
      },
      { projectRef, observedAt, observedThrough: new Date().toISOString() },
    ),
  );
}

const observedThrough = new Date().toISOString();

console.log(formatInventoryReport(observations, { projectRef, observedAt, observedThrough }));

const summary = summariseInventory(observations, { projectRef, observedAt, observedThrough });
const exitCode = decideInventoryExitCode(summary);

console.log("");
if (exitCode === 3) {
  console.log(
    `EXIT 3 — the report is established and ${summary.contradictions} migration(s) have ledger evidence ` +
      "and observed state that DISAGREE. Nothing here may be written to a ledger to make them agree: a " +
      "row inserted on object-probe evidence would assert an apply nobody observed. Take each " +
      "disagreement to a human.",
  );
} else {
  console.log(
    "EXIT 0 — the report is established and the two sections agree on every migration examined. That is " +
      "NOT the same as 'every migration is applied': see the partial-probe and not-examined lines above.",
  );
}

process.exit(exitCode);

// This module exports nothing on purpose. The pure half lives in
// ./lib/migrationInventoryCore.ts, which is what
// src/test/migrationInventory.test.ts imports — importing THIS file runs the
// guard and then the reporter, which is exactly what a script should do and
// exactly what a unit test must not.
