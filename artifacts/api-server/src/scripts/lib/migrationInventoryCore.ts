/**
 * migrationInventoryCore — WHAT IS APPLIED, ANSWERED WITHOUT GUESSING.
 *
 * PURE, and deliberately guard-free, for the same reason
 * src/scripts/lib/migrationLedgerCore.ts is: every function here is a function
 * of its arguments, no database, no environment, and NO Supabase credential
 * environment variable is named anywhere in this file. Its I/O shell,
 * src/scripts/reportMigrationInventory.ts, imports a guard front door as its
 * FIRST import, and that guard exits the PROCESS when it does not like the
 * target — so a unit test that imported the shell would die at import time
 * under the loopback target `pnpm run test` pins. The split is what makes this
 * testable at all.
 *
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE FALSE ZERO THIS FILE EXISTS TO MAKE IMPOSSIBLE  (2026-09-22)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * An inventory reported that production (ajrurzioarfkagpuxfnb) carried ZERO
 * `schema_migration_ledger` rows at or above 2890. It carried 19 at the time of
 * the ruling and 20 when this file was written, and 2950 is fully applied there
 * with a real checksum, a real applied_at and independently verified privacy
 * constraints. Two separate defects produced that zero, and BOTH of them
 * produce a confident, well-formed, wrong answer rather than an error:
 *
 * ── TRAP 1. TWO LEDGERS, DISJOINT COLUMNS ─────────────────────────────────
 *
 *   public.schema_migration_ledger          has `filename`, and NO `version`
 *   supabase_migrations.schema_migrations   has `version`,  and NO `filename`
 *
 * A predicate written for one, run against the other, does not fail: it
 * answers about a different column of a different table. Reproduced on
 * production, read-only, 2026-09-22:
 *
 *   select count(*) from supabase_migrations.schema_migrations
 *    where version >= '2890';                                    -> 0
 *   select count(*) from public.schema_migration_ledger
 *    where filename ~ '^[0-9]{4}_'
 *      and (substring(filename from '^[0-9]{4}'))::int >= 2890;   -> 20
 *
 * THE DEFENCE IN CODE: a ledger is a value here (HAND_LEDGER / CLI_LEDGER)
 * carrying the columns it actually has, and every query the shell builds goes
 * through buildLedgerSelect(), which REFUSES a column the named table does not
 * have and, when the other ledger has it, says so by name. There is no way to
 * spell `version` at the hand ledger and get a result.
 *
 * ── TRAP 2. ONE TEXT COLUMN, TWO FORMATS ──────────────────────────────────
 *
 * The CLI table's `version` is text and holds BOTH bare repo serials and
 * 14-digit timestamps. Read from production, read-only, 2026-09-22 — 7 serial
 * rows and 96 timestamp rows in one column:
 *
 *   version  | name
 *   ---------+------------------------------------
 *   2198     | feature_flag_metadata_audit
 *   2272     | wall_context_thread_flags
 *   20260823171308 | 2142_phone_verification
 *   20260914193139 | 2890_rank_events_behavior_engine_columns
 *
 * Three consequences, each of which has already been believed:
 *
 *   a. TEXT `>=` IS NOT A BAND FILTER. Text order sorts every 14-digit
 *      timestamp BELOW the four-digit cutoff: the third character decides it,
 *      '0' against '9', and the remaining ten digits are never looked at. So
 *      `version >= '2890'` excludes EVERY post-cutover row no matter what is
 *      applied. That is the zero. Re-established on production (datcollate
 *      en_US.UTF-8), 2026-09-22, rather than reasoned about:
 *        select '2890' <= '20260915123045';      -> false
 *        select '20260915123045' < '2950';       -> true
 *      Note that the intuitive form of this claim, `'289' < '20260915123045'`,
 *      is FALSE — the trap is not that timestamps sort in the middle of the
 *      serials, it is that they sort below the cutoff.
 *   b. `MAX(version)` IS NOT THE NEWEST APPLY. On production it returns
 *      '2272' — a PRE-cutover serial — so a freshness check built on it
 *      reports the database months behind. `scripts/refresh-production-
 *      snapshot.md` still prints that query for an operator to run.
 *   c. THE SERIAL IS IN `name`, NOT `version`, for every timestamp row. So
 *      "which repo migration is this" cannot be read off `version` at all.
 *
 * The hand ledger has the INVERSE hazard: a naive numeric-prefix cast over
 * `filename` scoops up imported files whose names begin with a 14-digit
 * instant, so `substring(filename from '^[0-9]+')::int >= 2890` returned 47
 * where the correct 4-digit band filter returns 20.
 *
 * THE DEFENCE IN CODE: versionFormat() classifies a single value,
 * profileVersionColumn() classifies a COLUMN, and the two functions that
 * consumers actually want — newestApply() and inBand() — REFUSE rather than
 * answer when the input cannot support the question. compareVersions() refuses
 * a cross-format comparison instead of falling back to string order.
 *
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE FOUR DIMENSIONS, WHICH ARE NEVER COLLAPSED INTO "APPLIED"
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   VERIFIED EXECUTION           an OBSERVED apply: a ledger row carrying a
 *                                real sha256 AND an applied_at instant.
 *                                Canonical: 2950_input_assistance_telemetry_
 *                                events.sql, checksum 42072bcd…, applied_at
 *                                2026-09-21 12:11:18.092654+00.
 *
 *   HISTORICAL BACKFILL          a row asserting PARITY OF FILENAME and
 *                                nothing more. Canonical: 2201_map_projection_
 *                                flag.sql, whose checksum is the literal
 *                                string 'backfill' and whose own notes read
 *                                "Asserts only that this filename existed in
 *                                src/migrations/ when 2254 ran. NOT evidence
 *                                that it was applied to this database; nothing
 *                                verified that it was." 378 of production's 465
 *                                rows are this kind. Counting them as applies
 *                                IS the core error.
 *
 *   OBSERVED SCHEMA COMPATIBLE   the objects the migration would create are
 *                                present, with the properties that were
 *                                checked. NOT proof the migration ran. It
 *                                carries a REQUIRED grade — see
 *                                SchemaCoverageGrade — that says how much of
 *                                the file the observation accounts for:
 *                                PARTIAL COVERAGE (some effects observed,
 *                                statements unchecked: the 2890 / 2900 / 2958
 *                                class) or FULL STATEMENT COVERAGE (every
 *                                executable statement has an observable effect
 *                                and all of them verify: the 2402 class).
 *                                Flattening the two throws away the difference
 *                                a reader needs most — whether anything in the
 *                                file remains unaccounted for — so nothing here
 *                                prints the bare dimension for a compatible
 *                                observation.
 *
 *   SCHEMA MISSING/INCOMPATIBLE  absent, or present with the wrong shape.
 *
 * They are a SET, not an enum-valued field, because a real migration lands in
 * several at once and the cases that matter are precisely the disagreements:
 *
 *   * 2298_dead_check_vocabularies.sql — the local precedent for a ledger row
 *     whose effects were ABSENT. Ledger evidence without schema evidence.
 *   * 2890, 2900 and 2958 — the inverse. All three are live in production with
 *     NO hand-ledger row; 2890's five rank_events columns are all present.
 *     2958 has no row in EITHER ledger under its repository filename (its CLI
 *     row is keyed `coverage_state`, the stem it arrived under) while
 *     intel_coverage_snapshots.coverage_state exists with the declared default.
 *   * 2400 / 2401 / 2402 — three files in NEITHER ledger that are three
 *     different answers, which is why the grade above exists. 2400's every
 *     effect is absent (schema missing). 2402's nine executable statements ALL
 *     verify, checked individually rather than by object existence — SECURITY
 *     DEFINER, the pinned search_path, the owner, the comment, EXECUTE for
 *     anon/authenticated/service_role, schema USAGE for the same three, and
 *     policy counts 2/4/1 (full statement coverage). 2401 looks like 2402's
 *     case and is NOT: its own postcondition requires msg_select's qual to
 *     contain `mtm.thread_id = messages.thread_id`, production's qual is
 *     `authz.is_active_thread_member(thread_id)` — 2402 recreated that policy
 *     — so ONE of its two statements verifies and the file is incompatible,
 *     not compatible. That is also why attribution is a field rather than a
 *     footnote: `msg_select` is declared by both files and credits neither,
 *     and the only 2401-specific evidence is `messages_hide_blocked_sender`,
 *     which extractDeclaredObjects() confirms exactly one file in the tree
 *     CREATEs (a plain grep names three — 2182 only mentions it in a comment
 *     and 2402 only reads it in a precondition).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE RULE THIS FILE ENFORCES RATHER THAN DOCUMENTS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Never infer that every statement in a migration ran from object existence
 * alone. A migration can create ten objects while a probe checks two, and "2
 * of 10 present" must never round up to "applied". classifyMigration()
 * therefore cannot produce "verified-execution" from probes — the only code
 * path that adds it reads a ledger row's checksum and applied_at — and
 * assertNoAppliedInference() re-checks that invariant on the finished
 * observation so a future edit that crosses the wires fails loudly.
 *
 * Every observation records the target database (project ref), the observation
 * time, the objects AND properties actually checked, and its uncertainty.
 * requireObservationContext() refuses an observation with no project ref or no
 * timestamp, because an unattributed measurement is how "production carries
 * zero" outlives the database it was taken from.
 */

// ═══════════════════════════════════════════════════════════════════════════
// 1. THE TWO LEDGERS
// ═══════════════════════════════════════════════════════════════════════════

/** Which of the two migration records a row came from. */
export type LedgerKind = "hand" | "cli";

export interface LedgerDescriptor {
  kind: LedgerKind;
  /** Fully-qualified table name, as it is spelled in SQL. */
  table: string;
  /** The columns the table ACTUALLY has. */
  columns: readonly string[];
  /** The column that names a migration in this table. */
  identityColumn: string;
  /** One sentence on what a row here does and does not establish. */
  meaning: string;
}

/**
 * public.schema_migration_ledger — this repository's own ledger, created by
 * 2254_schema_migration_ledger.sql. Keyed by FILENAME. There is no `version`.
 */
export const HAND_LEDGER: LedgerDescriptor = {
  kind: "hand",
  table: "public.schema_migration_ledger",
  columns: ["filename", "checksum", "applied_by", "applied_at", "notes"],
  identityColumn: "filename",
  meaning:
    "Written by this repository's apply discipline. A row with a real sha256 and an applied_at is an " +
    "observed apply; a row whose checksum is 'backfill' asserts only that the filename existed when 2254 ran.",
};

/**
 * supabase_migrations.schema_migrations — the Supabase CLI / Management API
 * table. Keyed by VERSION, a text column holding two different formats. There
 * is no `filename`; the repository serial, when it is recorded at all, is in
 * `name`.
 */
export const CLI_LEDGER: LedgerDescriptor = {
  kind: "cli",
  table: "supabase_migrations.schema_migrations",
  columns: ["version", "name", "statements"],
  identityColumn: "version",
  meaning:
    "Written by the Supabase CLI and the Management API. A row proves those statements were sent, but the " +
    "table is not an inventory: a dashboard apply writes no row here, and `name` is not reliably the repository filename.",
};

export const LEDGERS: readonly LedgerDescriptor[] = [HAND_LEDGER, CLI_LEDGER];

/** Thrown when a query names a column the target table does not have. */
export class LedgerColumnError extends Error {
  readonly ledger: LedgerKind;
  readonly column: string;
  /** The OTHER ledger, when it is the one that has this column. */
  readonly belongsTo: LedgerKind | null;

  constructor(ledger: LedgerDescriptor, column: string, belongsTo: LedgerKind | null) {
    const owner = belongsTo
      ? ` That column belongs to ${belongsTo === "hand" ? HAND_LEDGER.table : CLI_LEDGER.table}, which is a ` +
        "DIFFERENT table with a DIFFERENT key. A predicate written for one ledger and run against the other " +
        "does not fail — it answers about something else, which is how production came to be reported as " +
        "carrying zero migrations at or above 2890."
      : "";
    super(
      `${ledger.table} has no column '${column}'. It has: ${ledger.columns.join(", ")}.${owner}`,
    );
    this.name = "LedgerColumnError";
    this.ledger = ledger.kind;
    this.column = column;
    this.belongsTo = belongsTo;
  }
}

/** Which ledger, if any, has a column of this name. */
export function ledgerOwningColumn(column: string): LedgerKind | null {
  for (const l of LEDGERS) if (l.columns.includes(column)) return l.kind;
  return null;
}

/**
 * Assert that `column` exists on `ledger`, naming the other ledger when the
 * column is really the other one's. THE defence against trap 1.
 */
export function ledgerColumn(ledger: LedgerDescriptor, column: string): string {
  if (ledger.columns.includes(column)) return column;
  const owner = ledgerOwningColumn(column);
  throw new LedgerColumnError(ledger, column, owner === ledger.kind ? null : owner);
}

/**
 * The only way this tooling is allowed to spell a ledger read.
 *
 * Deliberately has no WHERE clause. A band filter over either ledger cannot be
 * expressed in SQL without falling into trap 2 (text `>=` on a mixed-format
 * column, or a numeric cast over a filename that may begin with a 14-digit
 * instant), so the rows come back whole and inBand() does the banding in
 * memory over PARSED values. That costs one full table read of a table with a
 * few hundred rows and buys an answer that is not wrong.
 */
export function buildLedgerSelect(
  ledger: LedgerDescriptor,
  columns: readonly string[],
): string {
  if (columns.length === 0) {
    throw new Error(
      `buildLedgerSelect(${ledger.table}) was given no columns. A select of nothing establishes nothing.`,
    );
  }
  const checked = columns.map((c) => ledgerColumn(ledger, c));
  return `select ${checked.join(", ")} from ${ledger.table}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. THE VERSION COLUMN, AND WHY IT CANNOT BE COMPARED AS TEXT
// ═══════════════════════════════════════════════════════════════════════════

/** A bare repository serial: 3-5 digits. Pre-cutover rows carry these. */
export const SERIAL_RE = /^[0-9]{3,5}$/;
/** A CLI timestamp: exactly 14 digits, YYYYMMDDHHMMSS. */
export const TIMESTAMP14_RE = /^[0-9]{14}$/;
/** A repository migration filename: a FOUR-digit serial, an underscore, a name. */
export const MIGRATION_FILENAME_RE = /^([0-9]{4})_[^/]*\.sql$/;

export type VersionFormat = "serial" | "timestamp14" | "unrecognized";

/** Classify ONE version string. Never guesses. */
export function versionFormat(value: string): VersionFormat {
  if (TIMESTAMP14_RE.test(value)) return "timestamp14";
  if (SERIAL_RE.test(value)) return "serial";
  return "unrecognized";
}

export interface VersionColumnProfile {
  /** Every format present, sorted, so the set is printable. */
  formats: VersionFormat[];
  counts: Record<VersionFormat, number>;
  /**
   * TRUE when more than one format is present. A mixed column cannot be
   * ordered, banded or maximised as text, and every function below that would
   * need to refuses while this is true.
   */
  mixed: boolean;
  total: number;
}

/** Classify a whole column of version strings. */
export function profileVersionColumn(values: readonly string[]): VersionColumnProfile {
  const counts: Record<VersionFormat, number> = {
    serial: 0,
    timestamp14: 0,
    unrecognized: 0,
  };
  for (const v of values) counts[versionFormat(v)]++;
  const formats = (["serial", "timestamp14", "unrecognized"] as const).filter(
    (f) => counts[f] > 0,
  );
  return { formats: [...formats], counts, mixed: formats.length > 1, total: values.length };
}

/** A question this module declines to answer, with the reason. */
export interface Refusal {
  ok: false;
  reason: string;
}
export type Answer<T> = { ok: true; value: T } | Refusal;

/**
 * Order two version strings, or refuse.
 *
 * Same format → compare as text, which IS chronological inside a format
 * because both are fixed-width zero-padded digits. Different formats → REFUSE.
 * There is no total order across the two: '2272' is older than every timestamp
 * row and sorts after most of them.
 */
export function compareVersions(a: string, b: string): Answer<number> {
  const fa = versionFormat(a);
  const fb = versionFormat(b);
  if (fa === "unrecognized" || fb === "unrecognized") {
    return {
      ok: false,
      reason:
        `cannot order version ${JSON.stringify(fa === "unrecognized" ? a : b)}: it is neither a ` +
        "3-5 digit repository serial nor a 14-digit CLI timestamp, so nothing establishes where it sits.",
    };
  }
  if (fa !== fb) {
    return {
      ok: false,
      reason:
        `cannot order ${JSON.stringify(a)} (${fa}) against ${JSON.stringify(b)} (${fb}): the two formats ` +
        "share one text column and have no common order. Text comparison sorts every 14-digit timestamp " +
        "BELOW the four-digit cutoff '2890' — the third character decides it, '0' against '9' — so " +
        "`version >= '2890'` excludes every post-cutover row no matter what is applied. Verified on " +
        "production (datcollate en_US.UTF-8): `'2890' <= '20260915123045'` is FALSE and " +
        "`'20260915123045' < '2950'` is TRUE.",
    };
  }
  return { ok: true, value: a < b ? -1 : a > b ? 1 : 0 };
}

/** One row of either ledger, reduced to what the freshness question needs. */
export interface VersionedApply {
  version: string;
  /** The CLI table's `name`. The repository serial lives HERE for timestamp rows. */
  name?: string | null;
  /** An instant, when the row carries one. The hand ledger's applied_at. */
  appliedAt?: string | null;
}

/**
 * The newest apply, or a refusal.
 *
 * REFUSES on a mixed-format column instead of returning MAX(version). On
 * production that max is '2272', a pre-cutover serial that predates 96
 * timestamp rows, and a freshness check built on it reports the database
 * months behind while every gate stays green. When the caller has an instant
 * for every row, newestApplyByInstant() answers the same question honestly.
 */
export function newestApply(rows: readonly VersionedApply[]): Answer<VersionedApply> {
  if (rows.length === 0) {
    return { ok: false, reason: "no rows: an empty ledger read establishes no watermark." };
  }
  const profile = profileVersionColumn(rows.map((r) => r.version));
  if (profile.mixed) {
    return {
      ok: false,
      reason:
        `the version column holds ${profile.formats.length} formats (` +
        profile.formats.map((f) => `${f}=${profile.counts[f]}`).join(", ") +
        `) across ${profile.total} row(s), so it has no maximum. MAX(version) over this column returns a ` +
        "bare serial — on production, '2272' — which is OLDER than almost every row it was asked to " +
        "dominate. Use the applied_at instant, or ask for one format explicitly.",
    };
  }
  if (profile.counts.unrecognized > 0) {
    return {
      ok: false,
      reason:
        `${profile.counts.unrecognized} of ${profile.total} version(s) match neither the serial nor the ` +
        "timestamp shape, so their place in the order is unknown.",
    };
  }
  let best = rows[0];
  for (const row of rows.slice(1)) {
    const cmp = compareVersions(row.version, best.version);
    if (!cmp.ok) return cmp;
    if (cmp.value > 0) best = row;
  }
  return { ok: true, value: best };
}

/**
 * The newest apply by INSTANT, which is the question a freshness check really
 * wants. Refuses when any row lacks an instant — a partial answer here reads
 * as a complete one.
 */
export function newestApplyByInstant(rows: readonly VersionedApply[]): Answer<VersionedApply> {
  if (rows.length === 0) {
    return { ok: false, reason: "no rows: an empty ledger read establishes no watermark." };
  }
  const missing = rows.filter((r) => !r.appliedAt || r.appliedAt.trim() === "");
  if (missing.length > 0) {
    return {
      ok: false,
      reason:
        `${missing.length} of ${rows.length} row(s) carry no applied_at instant, so the newest cannot be ` +
        "established by time. A max over the rows that DO carry one would silently be a max over a subset.",
    };
  }
  let best = rows[0];
  for (const row of rows.slice(1)) {
    if ((row.appliedAt as string) > (best.appliedAt as string)) best = row;
  }
  return { ok: true, value: best };
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. THE REPOSITORY SERIAL, AND THE BAND FILTER THAT IS NOT A TEXT COMPARE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The repository serial of a migration FILENAME.
 *
 * Requires exactly four leading digits followed by an underscore. A filename
 * beginning with a 14-digit instant is NOT a serial and returns null — the
 * naive `substring(filename from '^[0-9]+')::int` cast that does accept one
 * returned 47 rows for the >= 2890 band where the correct filter returns 20.
 */
export function serialFromFilename(filename: string): number | null {
  const m = MIGRATION_FILENAME_RE.exec(filename);
  if (!m) return null;
  return Number(m[1]);
}

/**
 * The repository serial a CLI row refers to, if any.
 *
 * Tries `version` when it is a bare serial (pre-cutover rows), then the
 * leading serial of `name` (post-cutover rows keep it there, e.g. version
 * 20260914193139 / name '2890_rank_events_behavior_engine_columns'). Returns
 * null when neither says — production's 2958 row is named `coverage_state`,
 * the stem the file arrived under, and nothing in that row names 2958.
 */
export function serialFromCliRow(row: VersionedApply): number | null {
  if (SERIAL_RE.test(row.version)) {
    const n = Number(row.version);
    return n >= 1000 && n <= 9999 ? n : null;
  }
  const name = row.name ?? "";
  const m = /^([0-9]{4})(?:_|$)/.exec(name);
  return m ? Number(m[1]) : null;
}

export interface SerialBand {
  /** Inclusive. */
  from: number;
  /** Inclusive. */
  to: number;
}

/**
 * Is this serial in the band? Numeric, over a PARSED serial, never text.
 *
 * A null serial is NOT in the band and is NOT out of it — it is unknown, and
 * bandMembers() below counts it separately rather than dropping it. Silently
 * dropping the rows you could not parse is how a count becomes a zero.
 */
export function inBand(serial: number | null, band: SerialBand): boolean {
  if (serial === null) return false;
  return serial >= band.from && serial <= band.to;
}

export interface BandTally<T> {
  inBand: T[];
  outOfBand: T[];
  /** Rows whose serial could not be established. Reported, never dropped. */
  unattributable: T[];
  band: SerialBand;
}

/** Partition rows into in-band, out-of-band and unattributable. */
export function bandMembers<T>(
  rows: readonly T[],
  serialOf: (row: T) => number | null,
  band: SerialBand,
): BandTally<T> {
  const tally: BandTally<T> = { inBand: [], outOfBand: [], unattributable: [], band };
  for (const row of rows) {
    const serial = serialOf(row);
    if (serial === null) tally.unattributable.push(row);
    else if (inBand(serial, band)) tally.inBand.push(row);
    else tally.outOfBand.push(row);
  }
  return tally;
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. LEDGER EVIDENCE: VERIFIED EXECUTION vs HISTORICAL BACKFILL
// ═══════════════════════════════════════════════════════════════════════════

/** The checksum 2254's backfill wrote. A word, not a hash, and that is the point. */
export const BACKFILL_CHECKSUM = "backfill";
/** A well-formed sha256 as this repo writes it: 64 lowercase hex characters. */
export const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/** One row of either ledger, as the classifier needs it. */
export interface LedgerEvidence {
  ledger: LedgerKind;
  /** filename (hand) or version (cli) — whatever that ledger keys on. */
  identity: string;
  /** The hand ledger's checksum. The CLI table has no checksum column: null. */
  checksum: string | null;
  appliedBy: string | null;
  appliedAt: string | null;
  notes: string | null;
}

export type LedgerEvidenceClass =
  /** Real sha256 AND an applied_at instant: an observed apply. */
  | "verified-execution"
  /** checksum === 'backfill': asserts filename parity and nothing more. */
  | "historical-backfill"
  /**
   * A row that is neither. The CLI table's rows land here — they prove
   * statements were SENT under some version, with no checksum to compare and
   * (in that table) no applied_at — as do hand rows with a hash but no
   * instant, or an instant but no hash.
   */
  | "row-without-verification";

/**
 * Classify ONE ledger row.
 *
 * Both halves are required for "verified-execution" and neither is optional.
 * A checksum with no instant does not say WHEN, and an instant with no
 * checksum does not say WHAT — and the whole defect class is a row that says
 * neither being read as if it said both.
 */
export function classifyLedgerEvidence(row: LedgerEvidence): LedgerEvidenceClass {
  const checksum = (row.checksum ?? "").trim();
  if (checksum === BACKFILL_CHECKSUM) return "historical-backfill";
  const hasHash = SHA256_HEX_RE.test(checksum);
  const hasInstant = typeof row.appliedAt === "string" && row.appliedAt.trim() !== "";
  if (hasHash && hasInstant) return "verified-execution";
  return "row-without-verification";
}

/**
 * Does this row assert parity of filename and nothing more?
 *
 * TRUE for the 'backfill' checksum and for applied_by='backfill'. The second
 * is not redundant: a future backfill that forgot the sentinel checksum would
 * still be a backfill, and this must not read it as an apply.
 */
export function isHistoricalBackfill(row: LedgerEvidence): boolean {
  if ((row.checksum ?? "").trim() === BACKFILL_CHECKSUM) return true;
  return (row.appliedBy ?? "").trim() === "backfill";
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. OBJECT PROBES: COMPATIBLE, MISSING, OR NEVER LOOKED AT
// ═══════════════════════════════════════════════════════════════════════════

export type ProbeState =
  /** Present, and every property this probe compared matched. */
  | "present"
  /** Not there at all. */
  | "absent"
  /** There, with a different shape than the migration declares. */
  | "different-shape";

/**
 * One thing that was actually looked at.
 *
 * `property` is not decoration. The report prints it, because "the column
 * exists" and "the column exists, is NOT NULL and defaults to 'unknown'" are
 * different observations and only one of them was made.
 */
export interface ObjectProbe {
  /** Fully qualified: "public.rank_events.dwell_ms", "public.layover_crews". */
  object: string;
  /** What was compared, e.g. "exists", "exists+not_null+default". */
  property: string;
  state: ProbeState;
  /** What the migration declares, when the probe compared a shape. */
  expected?: string;
  /** What the catalog actually holds. */
  found?: string;
}

/**
 * HOW MUCH OF THE FILE THE OBSERVATION ACCOUNTS FOR.
 *
 * This refinement exists because two production cases that both look like
 * "the objects are there" are not the same evidence at all, and the difference
 * is the one a reader needs most — whether anything in the file remains
 * unaccounted for.
 *
 *   "partial-coverage"  — some effects observed; statements exist whose effects
 *                         were not checked, or cannot be. THE 2890 / 2900 /
 *                         2958 CLASS: some probed objects exist, which is
 *                         equally consistent with the migration running, with a
 *                         later migration creating the same object, and with a
 *                         hand edit. The unchecked statements are named.
 *
 *   "full-statement-coverage"
 *                       — every executable statement in the file has an
 *                         observable effect and every one of them verifies,
 *                         against the properties the file itself asserts. THE
 *                         2401 / 2402 CLASS, measured on ajrurzioarfkagpuxfnb
 *                         between 04:22:25 and 04:24:23 UTC on 2026-09-22: 2401
 *                         has exactly 2 executable statements and 2402 has 9,
 *                         and all 11 were checked individually — policy quals
 *                         compared as text, `permissive` = RESTRICTIVE where
 *                         required, policy counts 4/2/1, and for
 *                         authz.is_active_thread_member(uuid) the SECURITY
 *                         DEFINER bit, the pinned search_path, the owner, the
 *                         comment string, the function body character for
 *                         character, EXECUTE for anon/authenticated/
 *                         service_role and schema USAGE for the same three.
 *
 * FULL COVERAGE IS STILL NOT AN APPLY, and the rule does not bend for it. A
 * statement-complete observation cannot distinguish "2402 ran" from "someone
 * ran 2402's statements by hand" or "a later migration reproduced them"; for
 * 2402's `msg_select` it cannot even distinguish 2401-then-2402 from
 * 2402-alone, because 2402 recreates that policy. What remains unknown is what
 * always remains unknown from a probe: WHETHER THE FILE EXECUTED, AND WHEN.
 * So this grade sits strictly below verified-execution, it never prints as
 * "applied", and it is never rendered as a green tick in a summary line.
 */
export type SchemaCoverageGrade =
  | "full-statement-coverage"
  | "partial-coverage"
  | "not-probed";

/**
 * One executable statement of the file, and whether its effect verifies.
 *
 * Statement-level, not object-level, deliberately: "the column exists" is an
 * object fact, while "statement 7 of 9 — CREATE POLICY msg_select … — verifies,
 * qual compared as text and permissive=RESTRICTIVE" accounts for a statement.
 * Only an enumeration of ALL of them can support a claim of full coverage, so
 * the count the caller declares is checked against the checks it supplies.
 */
export interface StatementCheck {
  /** 1-based index within the file's executable statements. */
  index: number;
  /** A short rendering of the statement, for the report. */
  statement: string;
  /** Exactly what was compared, e.g. "qual as text + permissive=RESTRICTIVE". */
  property: string;
  /** TRUE only when the observed state matched what the file asserts. */
  verified: boolean;
  /**
   * The observed object this statement's effect lives in, when there is one.
   * Used for the exclusivity question below.
   */
  object?: string;
}

/**
 * WHICH OBSERVED OBJECT IS UNIQUE TO THIS FILE.
 *
 * Without this, a shared object silently credits the wrong migration. 2402
 * recreates 2401's `msg_select` policy, so observing `msg_select` is evidence
 * for EITHER file; the one piece of 2401-specific evidence is
 * `messages_hide_blocked_sender`, which no other migration in the tree creates.
 * An observation with no exclusive object cannot be attributed to its file at
 * all, and buildUncertainty() says so.
 */
export interface Attribution {
  /** Observed objects that only THIS migration in the tree declares. */
  exclusive: string[];
  /** Observed objects some other migration also declares, with the others named. */
  shared: { object: string; alsoDeclaredBy: string[] }[];
  /** How the exclusivity was established, so the claim can be re-run. */
  method: string;
}

export interface SchemaObservation {
  /**
   * "not-probed" is a first-class answer, not a missing value. A migration
   * nobody looked at is not compatible and not incompatible.
   */
  dimension:
    | "observed-schema-compatible"
    | "schema-missing-or-incompatible"
    | "not-probed";
  /**
   * How much of the FILE the observation accounts for. Always set, and always
   * printed next to the dimension: "observed-schema-compatible" alone is the
   * flattening this field exists to prevent.
   */
  coverageGrade: SchemaCoverageGrade;
  /** The file's total count of executable statements, when the caller knows it. */
  executableStatementCount: number | null;
  /** The per-statement checks actually made. */
  statementChecks: StatementCheck[];
  /** Which observed objects are unique to this file, when that was established. */
  attribution: Attribution | null;
  /** How many objects the migration's SQL declares. */
  declaredCount: number;
  /** How many of them a probe actually examined. */
  probedCount: number;
  presentCount: number;
  absent: ObjectProbe[];
  differentShape: ObjectProbe[];
  /** Every distinct property that was compared, so the report can name them. */
  propertiesChecked: string[];
  /** Declared objects with NO probe. The gap, named. */
  unprobed: string[];
  /** probedCount / declaredCount, or null when nothing is declared. */
  coverage: number | null;
}

/**
 * Turn declared objects + the probes actually run into an observation.
 *
 * "2 of 10 present" NEVER rounds up. When probedCount < declaredCount the
 * observation is still at best "observed-schema-compatible" — a claim about
 * the objects that were checked, with the unchecked ones listed by name — and
 * classifyMigration() copies that gap into the uncertainty list. Nothing here
 * can produce "verified-execution"; there is no code path from a probe to that
 * value, by construction.
 */
export interface StatementEvidence {
  /** The file's TOTAL number of executable statements. Not "the ones we checked". */
  executableStatementCount: number;
  /** One entry per statement the observer actually accounted for. */
  checks: readonly StatementCheck[];
}

export function observeSchema(
  declaredObjects: readonly string[],
  probes: readonly ObjectProbe[],
  statements?: StatementEvidence,
  attribution?: Attribution,
): SchemaObservation {
  const declared = [...new Set(declaredObjects)];
  const probed = new Set(probes.map((p) => p.object));
  const absent = probes.filter((p) => p.state === "absent");
  const differentShape = probes.filter((p) => p.state === "different-shape");
  const presentCount = probes.filter((p) => p.state === "present").length;
  const statementChecks = [...(statements?.checks ?? [])];
  const propertiesChecked = [
    ...new Set([...probes.map((p) => p.property), ...statementChecks.map((c) => c.property)]),
  ].sort();
  const unprobed = declared.filter((o) => !probed.has(o)).sort();

  const anythingObserved = probes.length > 0 || statementChecks.length > 0;
  const anythingFailed =
    absent.length > 0 ||
    differentShape.length > 0 ||
    statementChecks.some((c) => !c.verified);

  const dimension: SchemaObservation["dimension"] = !anythingObserved
    ? "not-probed"
    : anythingFailed
      ? "schema-missing-or-incompatible"
      : "observed-schema-compatible";

  // ── THE COVERAGE GRADE ────────────────────────────────────────────────────
  //
  // "full-statement-coverage" is granted ONLY when the caller declared the
  // file's total executable-statement count AND supplied a verifying check for
  // every one of them. Three separate conditions, all required, because each
  // one alone has already been mistaken for the claim:
  //
  //   * a count with no checks is a claim about the file, not about the database;
  //   * checks with no declared total is "we checked what we checked";
  //   * a check that did not verify is not coverage, it is a finding.
  //
  // Object probes alone can NEVER reach this grade: an ObjectProbe is not a
  // StatementCheck and nothing here converts one into the other. That is what
  // keeps the transport in reportMigrationInventory.ts — which checks tables
  // and columns through information_schema — permanently in "partial-coverage",
  // which is the honest grade for it.
  const total = statements?.executableStatementCount ?? null;
  const distinctChecked = new Set(statementChecks.map((c) => c.index)).size;
  const coverageGrade: SchemaCoverageGrade = !anythingObserved
    ? "not-probed"
    : total !== null &&
        total > 0 &&
        distinctChecked === total &&
        statementChecks.every((c) => c.verified)
      ? "full-statement-coverage"
      : "partial-coverage";

  return {
    dimension,
    coverageGrade,
    executableStatementCount: total,
    statementChecks,
    attribution: attribution ?? null,
    declaredCount: declared.length,
    probedCount: probed.size,
    presentCount,
    absent,
    differentShape,
    propertiesChecked,
    unprobed,
    coverage: declared.length === 0 ? null : probed.size / declared.length,
  };
}

/**
 * The dimension and its grade, as one string, for anything that prints a label.
 *
 * Nothing in this module prints the bare dimension for a compatible
 * observation: "observed-schema-compatible" on its own is exactly the
 * flattening that loses the 2401/2402-versus-2890 difference.
 */
export function dimensionLabel(schema: SchemaObservation): string {
  if (schema.dimension !== "observed-schema-compatible") return schema.dimension;
  return schema.coverageGrade === "full-statement-coverage"
    ? `observed-schema-compatible (FULL STATEMENT COVERAGE, ${schema.executableStatementCount ?? "?"} of ${schema.executableStatementCount ?? "?"} statements — still not an apply)`
    : "observed-schema-compatible (PARTIAL COVERAGE)";
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. THE CLASSIFIER
// ═══════════════════════════════════════════════════════════════════════════

/** The four dimensions. A migration lands in a SET of them, never exactly one. */
export type EvidenceDimension =
  | "verified-execution"
  | "historical-backfill"
  | "observed-schema-compatible"
  | "schema-missing-or-incompatible";

export const EVIDENCE_DIMENSIONS: readonly EvidenceDimension[] = [
  "verified-execution",
  "historical-backfill",
  "observed-schema-compatible",
  "schema-missing-or-incompatible",
];

/** Where and when an observation was taken. Never optional. */
export interface ObservationContext {
  /** The Supabase project ref. "production" is not a project ref. */
  projectRef: string;
  /** ISO-8601 instant: when the observation STARTED. */
  observedAt: string;
  /**
   * When the observation FINISHED, when it took long enough to matter.
   *
   * A reading of eleven statements took from 04:22:25 to 04:24:23 UTC on
   * 2026-09-22, and a database can move inside two minutes. A window is the
   * honest rendering of a measurement that was not instantaneous; an instant
   * would claim a simultaneity the reading did not have.
   */
  observedThrough?: string;
}

/** "2026-09-22T04:22:25Z" or "2026-09-22T04:22:25Z → 2026-09-22T04:24:23Z". */
export function formatObservationWindow(ctx: ObservationContext): string {
  const through = (ctx.observedThrough ?? "").trim();
  return through === "" || through === ctx.observedAt
    ? ctx.observedAt
    : `${ctx.observedAt} → ${through}`;
}

/**
 * Refuse an unattributed observation.
 *
 * A measurement with no target and no time outlives the database it was taken
 * from, which is exactly what "production carries zero rows at or above 2890"
 * did: true of a capture, quoted as a standing fact for a week.
 */
export function requireObservationContext(ctx: ObservationContext): ObservationContext {
  const ref = (ctx.projectRef ?? "").trim();
  const at = (ctx.observedAt ?? "").trim();
  if (ref === "") {
    throw new Error(
      "an observation needs a project ref: an unattributed measurement of 'the database' cannot be " +
        "re-established and cannot expire.",
    );
  }
  if (at === "") {
    throw new Error(
      `an observation of ${ref} needs an observation time: without one it reads as a standing fact rather ` +
        "than as a reading taken at an instant.",
    );
  }
  const through = (ctx.observedThrough ?? "").trim();
  if (through !== "" && through < at) {
    throw new Error(
      `an observation window of ${ref} ends (${through}) before it begins (${at}).`,
    );
  }
  return {
    projectRef: ref,
    observedAt: at,
    ...(through === "" ? {} : { observedThrough: through }),
  };
}

export interface MigrationObservationInput {
  filename: string;
  /**
   * Every object the migration's SQL declares. Counted even when nothing
   * probes it, because the count is half of the coverage statement.
   */
  declaredObjects: readonly string[];
  /** The probes actually run. */
  probes: readonly ObjectProbe[];
  /** Every ledger row found for this migration, from EITHER ledger. */
  ledgerEvidence: readonly LedgerEvidence[];
  /**
   * The file's executable-statement total and the per-statement checks made
   * against it. Omit it and the observation is partial-coverage by
   * construction, which is the correct grade for an object-probe transport.
   */
  statements?: StatementEvidence;
  /** Which observed objects are unique to this file. Omit when not established. */
  attribution?: Attribution;
}

export interface LedgerEvidenceSummary {
  verifiedExecution: LedgerEvidence[];
  historicalBackfill: LedgerEvidence[];
  rowsWithoutVerification: LedgerEvidence[];
  /** How many rows came from each ledger. Both, separately, always. */
  rowsByLedger: Record<LedgerKind, number>;
}

export interface MigrationObservation {
  filename: string;
  serial: number | null;
  projectRef: string;
  observedAt: string;
  observedThrough?: string;
  /** Ledger evidence, on its own, never merged with the probe result. */
  ledger: LedgerEvidenceSummary;
  /** Observed database state, on its own, never merged with the ledger. */
  schema: SchemaObservation;
  /** The dimensions this migration lands in. */
  dimensions: EvidenceDimension[];
  /** What this observation does NOT establish. Never silently empty. */
  uncertainty: string[];
}

/**
 * Classify one migration against one database.
 *
 * The two halves are computed independently and NEVER consulted by each other:
 * `ledger` is a function of ledger rows alone and `schema` of probes alone. The
 * disagreements are the findings, so they must be able to disagree.
 */
export function classifyMigration(
  input: MigrationObservationInput,
  rawCtx: ObservationContext,
): MigrationObservation {
  const ctx = requireObservationContext(rawCtx);

  const verifiedExecution: LedgerEvidence[] = [];
  const historicalBackfill: LedgerEvidence[] = [];
  const rowsWithoutVerification: LedgerEvidence[] = [];
  const rowsByLedger: Record<LedgerKind, number> = { hand: 0, cli: 0 };

  for (const row of input.ledgerEvidence) {
    rowsByLedger[row.ledger]++;
    if (isHistoricalBackfill(row)) {
      historicalBackfill.push(row);
      continue;
    }
    switch (classifyLedgerEvidence(row)) {
      case "verified-execution":
        verifiedExecution.push(row);
        break;
      case "historical-backfill":
        historicalBackfill.push(row);
        break;
      default:
        rowsWithoutVerification.push(row);
    }
  }

  const schema = observeSchema(
    input.declaredObjects,
    input.probes,
    input.statements,
    input.attribution,
  );

  const dimensions: EvidenceDimension[] = [];
  if (verifiedExecution.length > 0) dimensions.push("verified-execution");
  if (historicalBackfill.length > 0) dimensions.push("historical-backfill");
  if (schema.dimension === "observed-schema-compatible") {
    dimensions.push("observed-schema-compatible");
  }
  if (schema.dimension === "schema-missing-or-incompatible") {
    dimensions.push("schema-missing-or-incompatible");
  }

  const uncertainty = buildUncertainty(input, schema, {
    verifiedExecution,
    historicalBackfill,
    rowsWithoutVerification,
    rowsByLedger,
  });

  const observation: MigrationObservation = {
    filename: input.filename,
    serial: serialFromFilename(input.filename),
    projectRef: ctx.projectRef,
    observedAt: ctx.observedAt,
    ...(ctx.observedThrough === undefined ? {} : { observedThrough: ctx.observedThrough }),
    ledger: {
      verifiedExecution,
      historicalBackfill,
      rowsWithoutVerification,
      rowsByLedger,
    },
    schema,
    dimensions,
    uncertainty,
  };

  assertNoAppliedInference(observation);
  return observation;
}

/**
 * Everything this observation does not establish, spelled out.
 *
 * The partial-probe sentence is mandatory and is phrased as a refusal rather
 * than a caveat, because the failure mode is a reader who sees a green line
 * and stops.
 */
function buildUncertainty(
  input: MigrationObservationInput,
  schema: SchemaObservation,
  ledger: LedgerEvidenceSummary,
): string[] {
  const out: string[] = [];

  // The object-probe gap is only a gap when the STATEMENTS did not account for
  // the file. Under full statement coverage every statement is verified, so the
  // statement that creates an unprobed object was itself checked and "object X
  // was not probed" names no unknown — printing it there would be noise beside
  // a stronger statement, and noise beside a strong claim is how the strong
  // claim stops being read.
  if (
    schema.declaredCount > 0 &&
    schema.probedCount < schema.declaredCount &&
    schema.coverageGrade !== "full-statement-coverage"
  ) {
    const gap = schema.declaredCount - schema.probedCount;
    out.push(
      `PARTIAL PROBE: ${schema.probedCount} of ${schema.declaredCount} declared object(s) were examined. ` +
        `${gap} ${gap === 1 ? "was" : "were"} NOT looked at (${schema.unprobed.join(", ")}). ` +
        "This cannot be read as 'the migration ran': a migration can create ten objects while a probe " +
        "checks two, and the unchecked ones are unknown, not present.",
    );
  }
  if (schema.probedCount > 0) {
    out.push(
      `PROPERTIES COMPARED: ${schema.propertiesChecked.join(", ")}. Anything this migration declares that is ` +
        "not one of these properties — a grant, a policy predicate, a trigger body, seeded rows — was not " +
        "observed here.",
    );
  }
  if (schema.dimension === "not-probed") {
    out.push(
      "NOT PROBED: no object of this migration was examined against the database, so its schema state is " +
        "neither compatible nor incompatible — it is unmeasured.",
    );
  }

  // ── The coverage grade, said out loud in BOTH directions ──────────────────
  if (schema.coverageGrade === "full-statement-coverage") {
    out.push(
      `FULL STATEMENT COVERAGE, AND STILL NOT AN APPLY: all ${schema.executableStatementCount} executable ` +
        "statement(s) in this file have an observable effect and every one of them verifies against what " +
        "the file asserts. That is strictly stronger than 'some objects exist' — nothing in the file is " +
        "unaccounted for — and it is strictly weaker than an apply record. It cannot distinguish 'this " +
        "file ran' from 'someone ran these statements by hand' or 'a later migration reproduced them'. " +
        "WHAT REMAINS UNKNOWN IS WHAT ALWAYS REMAINS UNKNOWN FROM A PROBE: whether the file executed, and when.",
    );
  } else if (schema.dimension === "observed-schema-compatible") {
    out.push(
      "PARTIAL COVERAGE: the objects that were checked are present, and statements of this file were not " +
        "checked or cannot be. This is the weaker of the two compatible grades — it is equally consistent " +
        "with the migration running, with a later migration creating the same object, and with a hand edit.",
    );
  }
  if (schema.statementChecks.length > 0 && schema.executableStatementCount !== null) {
    const verified = schema.statementChecks.filter((c) => c.verified).length;
    out.push(
      `STATEMENTS ACCOUNTED FOR: ${verified} verified of ${schema.statementChecks.length} checked, out of ` +
        `${schema.executableStatementCount} executable statement(s) in the file.`,
    );
  }

  // ── Attribution: which observed object is unique to THIS file ─────────────
  if (schema.attribution) {
    const { exclusive, shared, method } = schema.attribution;
    if (exclusive.length === 0 && shared.length === 0) {
      // Nothing was observed PRESENT, so there is nothing to attribute to
      // anybody. Saying "not attributable" here would read as a finding about
      // this file when it is only a consequence of an empty observation — and
      // the earlier version of this branch printed an empty parenthesis for
      // 2400, whose every object is absent.
      out.push(
        "ATTRIBUTION NOT APPLICABLE: no object of this migration was observed present, so no observed " +
          "object credits it or any other file. Attribution is a question about evidence that exists.",
      );
    } else if (exclusive.length === 0) {
      out.push(
        "NOT ATTRIBUTABLE TO THIS FILE: no observed object is unique to it. Every object checked is also " +
          `declared elsewhere (${shared.map((s) => `${s.object} ← ${s.alsoDeclaredBy.join(", ")}`).join("; ")}), ` +
          "so the observation credits this file no more than it credits those. 2402 recreates 2401's " +
          "`msg_select` policy, which is exactly how a shared object silently credits the wrong migration.",
      );
    } else {
      out.push(
        `ATTRIBUTABLE VIA ${exclusive.join(", ")}: object(s) no other migration in the tree declares, so the ` +
          `observation is evidence about THIS file rather than about a family of files. Established by: ${method}.`,
      );
    }
    if (exclusive.length > 0 && shared.length > 0) {
      out.push(
        `SHARED OBJECTS, which credit this file no more than another: ` +
          shared.map((s) => `${s.object} ← also ${s.alsoDeclaredBy.join(", ")}`).join("; "),
      );
    }
  }
  if (ledger.verifiedExecution.length === 0 && ledger.historicalBackfill.length > 0) {
    out.push(
      "LEDGER EVIDENCE IS BACKFILL ONLY: the row(s) found assert that this filename existed when 2254 ran " +
        "and nothing else. Nothing verified that this file was applied to this database.",
    );
  }
  if (ledger.rowsByLedger.hand === 0 && ledger.rowsByLedger.cli === 0) {
    out.push(
      "NO LEDGER ROW IN EITHER TABLE under this filename. That is not evidence it never ran: a Supabase " +
        "dashboard apply writes no row anywhere, a CLI apply writes only supabase_migrations, and that " +
        "table's `name` is not reliably the repository filename — production's 2958 row is keyed " +
        "`coverage_state`, the stem the file arrived under.",
    );
  }
  if (ledger.rowsWithoutVerification.length > 0) {
    out.push(
      `${ledger.rowsWithoutVerification.length} ledger row(s) carry neither a comparable sha256 nor an ` +
        "applied_at instant, so they establish that something was recorded, not what ran or when.",
    );
  }
  if (
    ledger.verifiedExecution.length > 0 &&
    schema.dimension === "schema-missing-or-incompatible"
  ) {
    out.push(
      "CONTRADICTION: a ledger row records an observed apply while declared objects are absent or the wrong " +
        "shape. 2298_dead_check_vocabularies.sql is the local precedent for a ledger row whose effects were " +
        "ABSENT. Neither half may be dropped to make the other consistent.",
    );
  }
  return out;
}

/**
 * The invariant, re-checked on the finished observation.
 *
 * "verified-execution" may only ever come from a ledger row carrying BOTH a
 * real sha256 and an applied_at. If a future edit ever routes a probe result
 * into that dimension, this throws at the point of the mistake rather than
 * letting the number ship.
 */
export function assertNoAppliedInference(obs: MigrationObservation): void {
  if (!obs.dimensions.includes("verified-execution")) return;
  const honest = obs.ledger.verifiedExecution.filter(
    (row) => classifyLedgerEvidence(row) === "verified-execution",
  );
  if (honest.length === 0) {
    throw new Error(
      `${obs.filename} was classified 'verified-execution' on ${obs.projectRef} with no ledger row carrying ` +
        "both a sha256 checksum and an applied_at instant. Object existence is NOT evidence that a migration " +
        "ran; this dimension may only come from an observed apply record.",
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 7. THE REPORT — FOUR SECTIONS, NEVER ONE NUMBER
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Per-dimension counts.
 *
 * There is deliberately NO `applied` field. Adding one is the change this
 * whole file exists to prevent, and a reviewer should have to argue for it
 * against this comment.
 */
export interface InventorySummary {
  projectRef: string;
  observedAt: string;
  total: number;
  verifiedExecution: number;
  historicalBackfill: number;
  /**
   * DELIBERATELY NOT A SINGLE NUMBER. The two grades are reported apart,
   * because flattening them throws away the difference a reader needs most —
   * whether anything in the file remains unaccounted for.
   */
  observedSchemaCompatibleFullStatementCoverage: number;
  observedSchemaCompatiblePartialCoverage: number;
  schemaMissingOrIncompatible: number;
  notProbed: number;
  /** Compatible observations that no unique object attributes to their file. */
  notAttributable: number;
  /** Ledger says applied, objects say otherwise — or the reverse. */
  contradictions: number;
  /** No row under this filename in EITHER ledger. */
  noLedgerRowEither: number;
  /** Observations whose probe covered only some of the declared objects. */
  partialProbes: number;
}

export function summariseInventory(
  observations: readonly MigrationObservation[],
  ctx: ObservationContext,
): InventorySummary {
  const c = requireObservationContext(ctx);
  let contradictions = 0;
  let noLedgerRowEither = 0;
  let partialProbes = 0;
  let notAttributable = 0;
  for (const o of observations) {
    if (
      o.schema.dimension === "observed-schema-compatible" &&
      o.schema.attribution !== null &&
      o.schema.attribution.exclusive.length === 0 &&
      // An empty attribution is the vacuous case (nothing observed present),
      // not a finding that this file cannot be told apart from another.
      o.schema.attribution.shared.length > 0
    ) {
      notAttributable++;
    }
    const ledgerSaysApplied = o.dimensions.includes("verified-execution");
    if (ledgerSaysApplied && o.schema.dimension === "schema-missing-or-incompatible") {
      contradictions++;
    } else if (
      !ledgerSaysApplied &&
      o.ledger.rowsByLedger.hand === 0 &&
      o.ledger.rowsByLedger.cli === 0 &&
      o.schema.dimension === "observed-schema-compatible"
    ) {
      contradictions++;
    }
    if (o.ledger.rowsByLedger.hand === 0 && o.ledger.rowsByLedger.cli === 0) {
      noLedgerRowEither++;
    }
    if (o.schema.declaredCount > 0 && o.schema.probedCount < o.schema.declaredCount) {
      partialProbes++;
    }
  }
  const compatible = observations.filter(
    (o) => o.schema.dimension === "observed-schema-compatible",
  );
  return {
    projectRef: c.projectRef,
    observedAt: c.observedAt,
    total: observations.length,
    verifiedExecution: observations.filter((o) => o.dimensions.includes("verified-execution"))
      .length,
    historicalBackfill: observations.filter((o) =>
      o.dimensions.includes("historical-backfill"),
    ).length,
    observedSchemaCompatibleFullStatementCoverage: compatible.filter(
      (o) => o.schema.coverageGrade === "full-statement-coverage",
    ).length,
    observedSchemaCompatiblePartialCoverage: compatible.filter(
      (o) => o.schema.coverageGrade !== "full-statement-coverage",
    ).length,
    schemaMissingOrIncompatible: observations.filter(
      (o) => o.schema.dimension === "schema-missing-or-incompatible",
    ).length,
    notProbed: observations.filter((o) => o.schema.dimension === "not-probed").length,
    notAttributable,
    contradictions,
    noLedgerRowEither,
    partialProbes,
  };
}

/**
 * The report a person reads once and does not misquote.
 *
 * LEDGER EVIDENCE and OBSERVED DATABASE STATE are separate sections with
 * separate counts. There is no combined total, on purpose: the sentence "N
 * migrations are applied" is not derivable from anything here, and the
 * inventory that produced the false zero was believed precisely because it
 * printed one number.
 */
export function formatInventoryReport(
  observations: readonly MigrationObservation[],
  ctx: ObservationContext,
): string {
  const s = summariseInventory(observations, ctx);
  const out: string[] = [];

  out.push(
    `MIGRATION INVENTORY — target ${s.projectRef}, observed ${formatObservationWindow(ctx)}, ` +
      `${s.total} migration(s) examined.`,
  );
  out.push("");
  out.push("LEDGER EVIDENCE (what a record says) — read from both ledgers, kept apart:");
  out.push(`  ${HAND_LEDGER.table}  keyed by ${HAND_LEDGER.identityColumn}`);
  out.push(`  ${CLI_LEDGER.table}  keyed by ${CLI_LEDGER.identityColumn}`);
  out.push(
    `  verified execution  ${s.verifiedExecution}  (a row with a real sha256 AND an applied_at)`,
  );
  out.push(
    `  historical backfill ${s.historicalBackfill}  (asserts the filename existed when 2254 ran; NOT an apply)`,
  );
  out.push(
    `  no row in EITHER ledger under this filename ${s.noLedgerRowEither}  (not evidence it never ran)`,
  );
  out.push("");
  out.push("OBSERVED DATABASE STATE (what the catalog holds) — NOT proof anything ran:");
  out.push(
    `  compatible, FULL statement coverage ${s.observedSchemaCompatibleFullStatementCoverage}  ` +
      "(every executable statement in the file has an observable effect and all of them verify — " +
      "nothing in the file is unaccounted for, and it is STILL NOT AN APPLY)",
  );
  out.push(
    `  compatible, PARTIAL coverage        ${s.observedSchemaCompatiblePartialCoverage}  ` +
      "(the objects checked are present; statements were not or cannot be checked)",
  );
  out.push(`  schema missing / incompatible       ${s.schemaMissingOrIncompatible}`);
  out.push(`  not probed                          ${s.notProbed}`);
  out.push(
    `  partial probes                      ${s.partialProbes}  (fewer objects examined than declared)`,
  );
  out.push(
    `  NOT attributable to their own file  ${s.notAttributable}  (no observed object is unique to the ` +
      "file — a shared object credits this migration no more than the one that also declares it)",
  );
  out.push("");
  out.push(
    `DISAGREEMENTS between the two ${s.contradictions} — these are the findings, not noise. A ledger row ` +
      "whose objects are absent (2298's class) and a live object with no ledger row (2890 / 2900 / 2958's " +
      "class) are BOTH real and neither may be resolved by trusting the other.",
  );

  for (const o of observations) {
    out.push("");
    out.push(`── ${o.filename}${o.serial === null ? "" : `  (serial ${o.serial})`}`);
    out.push(
      `   target ${o.projectRef}  observed ${formatObservationWindow({
        projectRef: o.projectRef,
        observedAt: o.observedAt,
        ...(o.observedThrough === undefined ? {} : { observedThrough: o.observedThrough }),
      })}`,
    );
    out.push(
      `   dimensions: ${o.dimensions.length === 0 ? "(none established)" : o.dimensions.join(" + ")}`,
    );
    out.push(
      `   ledger: hand=${o.ledger.rowsByLedger.hand} cli=${o.ledger.rowsByLedger.cli}` +
        `  verified=${o.ledger.verifiedExecution.length}` +
        ` backfill=${o.ledger.historicalBackfill.length}` +
        ` unverifiable=${o.ledger.rowsWithoutVerification.length}`,
    );
    for (const row of o.ledger.verifiedExecution) {
      out.push(
        `     ✓ ${row.ledger}:${row.identity} checksum=${(row.checksum ?? "").slice(0, 12)}… applied_at=${row.appliedAt}`,
      );
    }
    for (const row of o.ledger.historicalBackfill) {
      out.push(
        `     ~ ${row.ledger}:${row.identity} checksum=${row.checksum ?? "(none)"} — filename parity only`,
      );
    }
    out.push(
      `   schema: ${dimensionLabel(o.schema)}  probed ${o.schema.probedCount}/${o.schema.declaredCount} declared` +
        `  present=${o.schema.presentCount} absent=${o.schema.absent.length} wrong-shape=${o.schema.differentShape.length}`,
    );
    if (o.schema.executableStatementCount !== null) {
      out.push(
        `   statements: ${o.schema.statementChecks.filter((c) => c.verified).length} verified of ` +
          `${o.schema.statementChecks.length} checked, out of ${o.schema.executableStatementCount} in the file`,
      );
      for (const c of o.schema.statementChecks) {
        out.push(
          `     ${c.verified ? "✓" : "✗"} stmt ${c.index}/${o.schema.executableStatementCount}: ${c.statement}` +
            `  (checked: ${c.property})`,
        );
      }
    }
    if (o.schema.attribution) {
      const { exclusive, shared } = o.schema.attribution;
      out.push(
        `   attribution: ${
          exclusive.length > 0
            ? `unique to this file: ${exclusive.join(", ")}`
            : shared.length > 0
              ? "NONE — every observed object is also declared elsewhere"
              : "n/a — nothing was observed present"
        }`,
      );
    }
    if (o.schema.propertiesChecked.length > 0) {
      out.push(`   properties compared: ${o.schema.propertiesChecked.join(", ")}`);
    }
    if (o.schema.unprobed.length > 0) {
      out.push(`   NOT examined: ${o.schema.unprobed.join(", ")}`);
    }
    for (const p of o.schema.absent) {
      out.push(`     ✗ ${p.object} ABSENT (checked: ${p.property})`);
    }
    for (const p of o.schema.differentShape) {
      out.push(
        `     ! ${p.object} WRONG SHAPE (checked: ${p.property}; declared ${p.expected ?? "?"}, found ${p.found ?? "?"})`,
      );
    }
    for (const u of o.uncertainty) out.push(`   ? ${u}`);
  }

  out.push("");
  out.push(
    "NOTHING HERE SAYS 'N MIGRATIONS ARE APPLIED', and no number above may be added to another to produce " +
      "that sentence. Ledger evidence and observed state are different measurements of different things. " +
      "In particular FULL STATEMENT COVERAGE IS NOT A GREEN TICK: it says nothing in the file is " +
      "unaccounted for, which is strictly stronger than 'some objects exist' and strictly weaker than an " +
      "apply record. It leaves unknown what every probe leaves unknown — whether the file executed, and when.",
  );
  return out.join("\n");
}

/**
 * 0 = a report was established. 3 = established, and it contains a
 * disagreement a human must look at. 2 is the shell's "cannot establish".
 *
 * 1 is NOT used and never will be: this reporter shares no exit-code contract
 * with check:migration-ledger, whose 0/1/2 CI depends on, and reusing 1 here
 * would make a report look like that gate's verdict.
 */
export function decideInventoryExitCode(summary: InventorySummary): 0 | 3 {
  return summary.contradictions > 0 ? 3 : 0;
}

/** Why a credential check refused. Rendered by the shell, which knows the names. */
export type MissingCredential = "url" | "token";

export type CredentialCheck =
  | { ok: true; url: string; token: string }
  | { ok: false; exitCode: 2; missing: MissingCredential[] };

/**
 * Fail closed on absent credentials. Never "skip", never pass.
 *
 * Same shape and same reasoning as migrationLedgerCore.requireCredentials():
 * a reporter that cannot reach the database has established nothing, and the
 * empty string counts as absent because an unset secret in a workflow expands
 * to "" rather than disappearing.
 */
export function requireCredentials(
  url: string | undefined,
  token: string | undefined,
): CredentialCheck {
  const missing: MissingCredential[] = [];
  if (typeof url !== "string" || url.trim() === "") missing.push("url");
  if (typeof token !== "string" || token.trim() === "") missing.push("token");
  if (missing.length > 0) return { ok: false, exitCode: 2, missing };
  return { ok: true, url: (url as string).trim(), token: (token as string).trim() };
}

// ═══════════════════════════════════════════════════════════════════════════
// 8. WHAT A MIGRATION DECLARES — the denominator of every coverage statement
// ═══════════════════════════════════════════════════════════════════════════
//
// THIS IS A FLOOR, AND THE FLOOR IS THE POINT. The patterns below recognise the
// object kinds this repository's migrations spell in the ordinary way. Anything
// spelled another way — DDL built inside a DO block, a dynamic EXECUTE, a
// grant, seeded rows — is NOT seen, and a declaration this cannot see cannot
// appear in the unprobed list either.
//
// So the coverage ratio is an upper bound on how much was checked and a lower
// bound on how much there was. It is reported as a ratio of NAMED OBJECTS and
// never as a percentage of "the migration", because a migration is not a set of
// objects — it is a sequence of statements, and only the statements' own
// postconditions can speak for all of them. That is what certifyMigrations.ts
// stage 4 is for. This is deliberately the weaker, cheaper instrument, and its
// output says so rather than implying otherwise.

/** A thing a migration declares, tagged by kind so the report can say what was skipped. */
export interface DeclaredObject {
  kind:
    | "table"
    | "column"
    | "index"
    | "function"
    | "policy"
    | "trigger"
    | "constraint"
    | "enum";
  /** The key used everywhere else: "public.rank_events.dwell_ms", "public.layover_crews". */
  key: string;
  /**
   * TRUE when the probe transport in reportMigrationInventory.ts can actually
   * check this kind. Today: tables and columns, through information_schema.
   * Everything else is declared-and-unprobed BY CONSTRUCTION, which is why the
   * partial-probe path is the normal case here rather than an edge case.
   */
  probeable: boolean;
}

/** `schema.name` or `name`, quoted or not; captures the bare name. */
const QUALIFIED = '(?:"?[a-z_][a-z0-9_]*"?\\.)?"?([a-z_][a-z0-9_]*)"?';

/**
 * Objects a migration's SQL names, as a floor.
 *
 * COMMENTS MUST ALREADY BE STRIPPED by the caller (canonicalSchema's
 * stripSqlComments). A commented-out statement is not a declaration, and this
 * is not hypothetical: 2890's header carries a complete rollback script of
 * `ALTER TABLE … DROP COLUMN` lines inside `--` comments, which a raw scan
 * would read as claims about five columns.
 */
export function extractDeclaredObjects(sqlWithoutComments: string): DeclaredObject[] {
  const sql = sqlWithoutComments;
  const found = new Map<string, DeclaredObject>();
  const add = (kind: DeclaredObject["kind"], key: string, probeable: boolean): void => {
    const id = `${kind}:${key}`;
    if (!found.has(id)) found.set(id, { kind, key, probeable });
  };

  const tableRe = new RegExp(
    `create\\s+(?:unlogged\\s+)?table\\s+(?:if\\s+not\\s+exists\\s+)?${QUALIFIED}`,
    "gi",
  );
  for (const m of sql.matchAll(tableRe)) add("table", `public.${m[1]}`, true);

  // ALTER TABLE <t> … ; — one statement may carry several ADD COLUMN clauses,
  // so the table is captured first and its body scanned for the clauses.
  const alterRe = new RegExp(
    `alter\\s+table\\s+(?:if\\s+exists\\s+)?${QUALIFIED}([\\s\\S]*?);`,
    "gi",
  );
  for (const m of sql.matchAll(alterRe)) {
    const table = m[1];
    const body = m[2] ?? "";
    for (const c of body.matchAll(
      /add\s+column\s+(?:if\s+not\s+exists\s+)?"?([a-z_][a-z0-9_]*)"?/gi,
    )) {
      add("column", `public.${table}.${c[1]}`, true);
    }
    for (const c of body.matchAll(/add\s+constraint\s+"?([a-z_][a-z0-9_]*)"?/gi)) {
      add("constraint", c[1], false);
    }
  }

  // Columns declared INSIDE a CREATE TABLE body are deliberately not
  // enumerated: the table probe already answers for them, and listing them
  // would inflate the denominator with objects that are not separately checked.

  for (const m of sql.matchAll(
    /create\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?"?([a-z_][a-z0-9_]*)"?/gi,
  )) {
    add("index", m[1], false);
  }
  for (const m of sql.matchAll(
    /create\s+(?:or\s+replace\s+)?function\s+(?:[a-z_][a-z0-9_]*\.)?"?([a-z_][a-z0-9_]*)"?/gi,
  )) {
    add("function", m[1], false);
  }
  for (const m of sql.matchAll(/create\s+policy\s+"?([^"\n]+?)"?\s+on\s/gi)) {
    add("policy", m[1].trim(), false);
  }
  for (const m of sql.matchAll(
    /create\s+(?:or\s+replace\s+)?trigger\s+"?([a-z_][a-z0-9_]*)"?/gi,
  )) {
    add("trigger", m[1], false);
  }
  for (const m of sql.matchAll(
    /create\s+type\s+(?:[a-z_][a-z0-9_]*\.)?"?([a-z_][a-z0-9_]*)"?/gi,
  )) {
    add("enum", m[1], false);
  }

  return [...found.values()].sort((a, b) =>
    a.key < b.key ? -1 : a.key > b.key ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0,
  );
}

/** The subset the probe transport can actually check. */
export function probeableObjects(declared: readonly DeclaredObject[]): DeclaredObject[] {
  return declared.filter((d) => d.probeable);
}
