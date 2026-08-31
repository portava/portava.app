/**
 * apply-migrations.ts — the ORDERED, IDEMPOTENT, ATOMIC migration applier.
 *
 * WHY THIS EXISTS
 * ===============
 *
 * Five migrations reached `main` and were never applied to the CI database
 * (`portava-ci`, ref hwokxgbmezheskbzskfr): 2220, 2223, 2224, 2250, 2252.
 * Nothing in the merge path applied them, so `CI (live DB)` went red ON MAIN
 * ITSELF, and the repair each time was a later contributor hand-applying old
 * migrations through the Management API — unordered, unrecorded, and dependent
 * on somebody noticing.
 *
 * Every one of those three words names a property this script has:
 *
 *   ORDERED   — the canonical chain order, established below, not "whatever the
 *               operator pasted next".
 *   RECORDED  — the ledger row is written INSIDE the same transaction as the
 *               migration. "Applied but not recorded" is precisely the state
 *               that produced the mess, and it is unreachable here.
 *   AUTOMATIC — invoked by .github/workflows/live-db.yml, so nobody has to
 *               notice.
 *
 * THE ORDER, AND HOW IT WAS ESTABLISHED (not assumed)
 * ==================================================
 *
 * The canonical order is a PLAIN BYTE-WISE COMPARISON OF THE WHOLE FILENAME.
 * That was checked rather than taken on faith, because the repo has two
 * filename conventions and two documented prefix collisions:
 *
 *   1. docs/migrations.md § "Prefix collisions" states it outright: "Migration
 *      files are applied in lexicographic order".
 *   2. Every existing reader agrees, in code: checkMigrationPrefixes.ts,
 *      checkMissingLiveColumns.ts and auditMigrationsVsLive.ts each do
 *      `readdirSync(dir).filter(f => f.endsWith('.sql')).sort()`. Introducing a
 *      DIFFERENT order here would mean the applier and every auditor disagreed
 *      about what the chain is.
 *   3. The one thing that could make lexicographic order WRONG is closed by
 *      construction. The chain mixes 4-digit numeric prefixes (0010_, 2059_,
 *      2253_) with 8-digit dated ones (20260720_), and "20270101" sorts BELOW
 *      "2100" under a length-blind string compare. src/scripts/
 *      migrationPrefixRules.ts exists for exactly that: it reserves 2096-2099
 *      as a permanently unusable buffer and confines every NEW 4-digit prefix
 *      to 2100-2999 (/^2[1-9]\d{2}_/), a range whose second digit can never
 *      appear in a YYYYMMDD prefix in this century. The two conventions
 *      therefore cannot interleave ambiguously, and check:migration-prefixes
 *      enforces it on every build.
 *   4. Ambiguity WITHIN a prefix is the remaining case, and this script refuses
 *      it rather than picking a side — see assertUnambiguousOrder() below. The
 *      two documented collisions (2059, 2089) are both fully applied, so they
 *      are in the ledger and never enter the pending set.
 *
 * So: lexicographic IS correct, and it is correct because of (3), not by luck.
 * The comparator below is written out explicitly instead of calling `.sort()`
 * so that it is a byte-order comparison on purpose rather than by default, and
 * so no locale can ever be consulted.
 *
 * MIGRATIONS THAT CARRY THEIR OWN BEGIN/COMMIT
 * ============================================
 *
 * 109 of the 381 canonical files open with `BEGIN;` and close with `COMMIT;`.
 * Sending such a file inside an outer transaction is NOT harmless, and the way
 * it fails is the specific way that matters here:
 *
 *   * the inner `BEGIN;` is merely a warning ("there is already a transaction
 *     in progress") — that part is survivable;
 *   * the inner `COMMIT;` is NOT. It commits the OUTER transaction at that
 *     point. Everything after it — including our ledger INSERT — then runs in a
 *     separate implicit transaction. A failure after that point leaves the
 *     migration COMMITTED AND UNRECORDED, which is the exact state this script
 *     exists to make unreachable.
 *
 * So the body is PARSED (comment-, string- and dollar-quote-aware) for
 * top-level transaction-control statements, and exactly two shapes are
 * accepted:
 *
 *   * NONE at all                      -> wrap as-is.
 *   * exactly `BEGIN` first and `COMMIT` last, with nothing but comments after
 *                                      -> strip both and wrap. Semantics are
 *                                         preserved: the file asked to be
 *                                         atomic, and it is — plus the ledger
 *                                         row, in the same transaction.
 *
 * ANYTHING ELSE IS REFUSED BY NAME. An interior COMMIT, a second BEGIN block, a
 * ROLLBACK (2182_close_authz_rpc_oracle.sql has a BEGIN/ROLLBACK verification
 * block after its body), or SQL following the final COMMIT — each of those
 * makes "one transaction per migration" a false claim, and a false claim is
 * worse than a refusal. The refusal names the file, the offending statement and
 * its line.
 *
 * CREATE INDEX CONCURRENTLY is refused for the same reason from the other
 * direction: Postgres cannot run it inside a transaction block at all, so it
 * can never be atomic with its ledger row. 0186_geo_indexes.sql is the one such
 * file, and it has been applied for months. A new one must be applied by hand
 * and its ledger row inserted with applied_by='manual'.
 *
 * TARGET GUARD
 * ============
 *
 * THIS SCRIPT WRITES DDL. It asserts its target with the repo's strict front
 * door, artifacts/api-server/src/lib/ciSupabaseGuard.mjs, which runs
 * .github/scripts/assert-nonprod-supabase.sh in-process and exits 2. It fails
 * closed on an unset CI_SUPABASE_PROJECT_REF, an unset or malformed
 * KNOWN_PROD_PROJECT_REF, an unparseable SUPABASE_URL, any ref that is not the
 * sanctioned CI project, and on the production ref (ajrurzioarfkagpuxfnb) even
 * if somebody sanctions it.
 *
 * WHY IT IS AN ENTRY-POINT IMPORT RATHER THAN THE USUAL STATIC FIRST IMPORT.
 * Everywhere else in this repo the guard is `import "…/ciSupabaseGuard.mjs";`
 * at the top of the file, so module evaluation order makes it unskippable.
 * Here it is a dynamic import at the bottom, under RUN_DIRECTLY. The property
 * that matters is preserved exactly:
 *
 *   * NOTHING in this module's body reaches a network. Every top-level
 *     statement is a constant or a function declaration; `fetch` appears only
 *     inside main(), which is called on the line after the guard is awaited.
 *     The guard therefore still runs before any client is constructed and
 *     before any query — the claim the static form makes.
 *   * A workflow author still cannot skip it: it is in the execution path, not
 *     in YAML.
 *
 * What it buys is that the PURE half of this file — ordering, planning,
 * classification — is importable by a unit test with no credentials and no
 * mention of a credential variable, which is what
 * artifacts/api-server/scripts/check-guard-coverage.mjs requires of a test it
 * scans. The repo's other answer to that is a separate guard-free `*Core.ts`
 * module; this reaches the same separation without splitting the reasoning
 * across two files. IF A MODULE-SCOPE STATEMENT EVER REACHES A DATABASE, this
 * arrangement stops being equivalent and the guard must move back to a static
 * first import.
 *
 * THE LEDGER'S BACKFILL ROWS ARE NOT PROOF OF AN APPLY
 * ===================================================
 *
 * See isProofOfApply(). 2254 seeds a row for every filename that existed when
 * it ran, including the six that had never been applied. Treating "a row
 * exists" as "it was applied" would make this script a no-op forever.
 *
 * USAGE
 * =====
 *   pnpm --filter @workspace/scripts run db:apply-migrations -- --dry-run
 *   pnpm --filter @workspace/scripts run db:apply-migrations
 *   pnpm --filter @workspace/scripts run db:apply-migrations -- \
 *     --apply-unproven 2220_canonical_locations_search_key.sql,2223_map_media_evidence.sql
 *
 * (In CI, always through .github/scripts/pnpm-run.sh.)
 *
 * EXIT CODES
 *   0  every pending migration applied, or there were none
 *   1  a migration failed, or a file was refused; apply STOPPED at that file
 *   2  environment / precondition failure (no token, no ledger table, …)
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ─────────────────────────────────────────────────────────────────────────────
// Locations
// ─────────────────────────────────────────────────────────────────────────────

const __dir = dirname(fileURLToPath(import.meta.url));

/**
 * The CANONICAL tree, and only that tree. docs/migrations.md § "Migration
 * directory map": artifacts/api-server/migrations/ is frozen legacy and
 * migrations/ at the repo root is archived history. Neither is replayable and
 * neither is applied here.
 */
export const MIGRATIONS_DIR = resolve(
  __dir,
  "..",
  "..",
  "artifacts",
  "api-server",
  "src",
  "migrations",
);

export const LEDGER_TABLE = "public.schema_migration_ledger";

// ─────────────────────────────────────────────────────────────────────────────
// ORDER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Byte-wise comparison of two migration filenames.
 *
 * Deliberately not `String.prototype.localeCompare` (locale-dependent, and
 * under some collations punctuation and case are ignored entirely — "2100_a"
 * and "2100-a" could compare equal) and deliberately not the implicit
 * comparator of a bare `.sort()`. Both of the alternatives could produce an
 * order that differs from what every auditor in this repo computes.
 */
export function compareMigrationFilenames(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** The canonical chain, in apply order. */
export function orderMigrations(filenames: readonly string[]): string[] {
  return [...filenames].sort(compareMigrationFilenames);
}

/** Every `.sql` file in the canonical tree, in apply order. */
export function listMigrationFiles(dir: string = MIGRATIONS_DIR): string[] {
  return orderMigrations(
    readdirSync(dir).filter((f) => f.endsWith(".sql")),
  );
}

/** The leading numeric prefix of a migration filename, or null. */
export function prefixOf(filename: string): string | null {
  const m = /^(\d+)_/.exec(filename);
  return m ? m[1] : null;
}

/**
 * Refuse to apply a set whose relative order is undefined.
 *
 * check:migration-prefixes already fails the build on any undocumented
 * collision, and the two DOCUMENTED collisions (2059, 2089) are both fully
 * applied — so they sit in the ledger and never reach the pending set. This is
 * therefore not a duplicate of that check: it is the applier refusing to act on
 * an order it cannot justify, scoped to exactly the files it is about to write.
 *
 * Returns a list of human-readable problems; empty means the order is defined.
 */
export function assertUnambiguousOrder(pending: readonly string[]): string[] {
  const byPrefix = new Map<string, string[]>();
  for (const f of pending) {
    const p = prefixOf(f);
    if (p === null) continue;
    const bucket = byPrefix.get(p);
    if (bucket) bucket.push(f);
    else byPrefix.set(p, [f]);
  }
  const problems: string[] = [];
  for (const [prefix, files] of byPrefix) {
    if (files.length > 1) {
      problems.push(
        `prefix ${prefix} is shared by ${files.length} PENDING files (${files.join(", ")}). ` +
          "Their relative order is undefined, and this script will not pick one. " +
          "Renumber the one that has not been applied (see docs/migrations.md " +
          '§ "Prefix collisions"), or apply them by hand in a deliberate order ' +
          "and record both in the ledger with applied_by='manual'.",
      );
    }
  }
  return problems;
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECKSUM
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The ledger checksum: SHA-256 of the file's exact bytes, lowercase hex.
 *
 * Stated here because it is a CONTRACT with whatever backfills the ledger. A
 * backfill that writes a different digest makes every row look like drift, and
 * this script fails closed on drift rather than re-applying over the top of a
 * schema it cannot account for.
 */
export function checksumOf(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

// ─────────────────────────────────────────────────────────────────────────────
// SQL PARSING — comment-, string- and dollar-quote-aware
// ─────────────────────────────────────────────────────────────────────────────

export interface SqlToken {
  /** Uppercased keyword, e.g. "BEGIN". */
  keyword: string;
  /** 1-based line number in the original text. */
  line: number;
}

/**
 * Return every TOP-LEVEL transaction-control statement in `sql`, in order.
 *
 * "Top level" means: not inside a line comment, a block comment, a single- or
 * double-quoted literal, or a dollar-quoted body. That last one matters — the
 * word COMMIT appears inside plpgsql function bodies in this tree, and a naive
 * line grep would refuse perfectly good migrations because of a comment or a
 * function that mentions it.
 *
 * Only statements that begin a statement (i.e. follow a `;` or the start of
 * input) are reported, so `EXCEPTION WHEN ... END` inside a DO block and the
 * `END` that closes a plpgsql body are not mistaken for `END TRANSACTION`.
 */
export function findTransactionStatements(sql: string): SqlToken[] {
  const out: SqlToken[] = [];
  let i = 0;
  let line = 1;
  // True when the next non-whitespace, non-comment token starts a statement.
  let atStatementStart = true;

  const advance = (n: number) => {
    for (let k = 0; k < n && i < sql.length; k++, i++) {
      if (sql[i] === "\n") line++;
    }
  };

  while (i < sql.length) {
    const ch = sql[i];

    // Line comment
    if (ch === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") advance(1);
      continue;
    }
    // Block comment (Postgres nests them)
    if (ch === "/" && sql[i + 1] === "*") {
      let depth = 0;
      do {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth++;
          advance(2);
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth--;
          advance(2);
        } else {
          advance(1);
        }
      } while (i < sql.length && depth > 0);
      continue;
    }
    // Single-quoted literal ('' escapes a quote)
    if (ch === "'") {
      advance(1);
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") advance(2);
        else if (sql[i] === "'") {
          advance(1);
          break;
        } else advance(1);
      }
      atStatementStart = false;
      continue;
    }
    // Double-quoted identifier
    if (ch === '"') {
      advance(1);
      while (i < sql.length && sql[i] !== '"') advance(1);
      advance(1);
      atStatementStart = false;
      continue;
    }
    // Dollar-quoted body: $tag$ ... $tag$
    if (ch === "$") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        advance(tag.length);
        const end = sql.indexOf(tag, i);
        if (end === -1) advance(sql.length - i);
        else advance(end - i + tag.length);
        atStatementStart = false;
        continue;
      }
    }
    if (ch === ";") {
      advance(1);
      atStatementStart = true;
      continue;
    }
    if (/\s/.test(ch)) {
      advance(1);
      continue;
    }

    // A word.
    const wm = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(i));
    if (!wm) {
      advance(1);
      atStatementStart = false;
      continue;
    }
    const word = wm[0].toUpperCase();
    if (atStatementStart) {
      if (
        word === "BEGIN" ||
        word === "COMMIT" ||
        word === "ROLLBACK" ||
        word === "START" ||
        word === "ABORT" ||
        word === "SAVEPOINT"
      ) {
        out.push({ keyword: word, line });
      }
    }
    advance(wm[0].length);
    atStatementStart = false;
  }

  return out;
}

/** True when nothing but whitespace and comments remains. */
export function isEffectivelyEmpty(sql: string): boolean {
  return findFirstCodeOffset(sql) === -1;
}

/** Offset of the first non-comment, non-whitespace character, or -1. */
function findFirstCodeOffset(sql: string): number {
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      let depth = 0;
      do {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth--;
          i += 2;
        } else i++;
      } while (i < sql.length && depth > 0);
      continue;
    }
    return i;
  }
  return -1;
}

/**
 * `CREATE INDEX CONCURRENTLY` cannot run inside a transaction block, so it can
 * never be atomic with its own ledger row.
 */
export function usesConcurrently(sql: string): boolean {
  return /\bCONCURRENTLY\b/i.test(maskForKeywordScan(sql));
}

/**
 * Blank out comments and quoted literals so a keyword scan reads code, not
 * prose — but KEEP the contents of dollar-quoted bodies, because a plpgsql
 * body is executable code and a `CREATE TABLE` inside one is a schema change.
 *
 * This is deliberately different from maskNonCode(), which blanks dollar-quoted
 * bodies wholesale. That is right for finding statement boundaries (a `;`
 * inside a function body must not split a statement) and wrong for asking "does
 * this statement change anything". Using maskNonCode() for the second question
 * was a real bug: `DO $$ BEGIN CREATE TABLE t (id int); END $$;` after a COMMIT
 * read as a harmless assertion.
 */
export function maskForKeywordScan(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      out += " ";
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      let depth = 0;
      do {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth--;
          i += 2;
        } else i++;
      } while (i < sql.length && depth > 0);
      out += " ";
      continue;
    }
    if (ch === "'") {
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i] === "'") {
          i++;
          break;
        } else i++;
      }
      out += " ";
      continue;
    }
    if (ch === "$") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const bodyStart = i + tag.length;
        const end = sql.indexOf(tag, bodyStart);
        const bodyEnd = end === -1 ? sql.length : end;
        // Recurse INTO the body: it is code, and its own comments and string
        // literals still must not be read as keywords.
        out += " " + maskForKeywordScan(sql.slice(bodyStart, bodyEnd)) + " ";
        i = end === -1 ? sql.length : end + tag.length;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// CLASSIFICATION — what shape is this migration, and can it be applied
// atomically together with its ledger row?
// ─────────────────────────────────────────────────────────────────────────────

export type Classification =
  | { kind: "bare"; body: string; postconditions: string }
  | { kind: "unwrapped"; body: string; postconditions: string }
  | { kind: "refuse"; reason: string };

/**
 * Mutation keywords. A trailing `DO` block containing any of these is a schema
 * change, not an assertion, and must stay inside the applying transaction.
 */
const MUTATION_KEYWORD_RE =
  /\b(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|TRUNCATE|GRANT|REVOKE|COMMENT|REFRESH|REINDEX|SECURITY\s+LABEL)\b/i;

/**
 * Split the text after the closing COMMIT into its top-level statements and
 * decide whether every one of them is a pure ASSERTION.
 *
 * THE CONVENTION THIS EXISTS FOR, quoted from 2224_route_hop_signal.sql:
 *
 *     -- ── Postconditions (separate transaction: an assertion inside the
 *     --    transaction it is verifying proves nothing about what persisted
 *     --    — see 2195). ────────────────────────────────────────────────────
 *
 * That is deliberate and correct, so refusing it wholesale would refuse one of
 * the five migrations this script was written to apply. But "there is SQL after
 * the COMMIT" is not by itself evidence that the SQL is an assertion:
 * 2190_memory_lifecycle_fixes.sql opens a SECOND `BEGIN … COMMIT` after its
 * first one and creates a function inside it. Splitting that off would apply
 * half the file inside the ledger's transaction and half outside it.
 *
 * So the tail is accepted only when every top-level statement in it is a `DO`
 * block whose body raises and mutates nothing.
 */
export function analyseTail(tail: string): { ok: true } | { ok: false; reason: string } {
  const masked = maskNonCode(tail);
  // Top-level statements, by masked semicolons.
  let start = 0;
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] !== ";") continue;
    const stmtMasked = masked.slice(start, i);
    const stmtRaw = tail.slice(start, i);
    start = i + 1;
    if (stmtMasked.trim() === "") continue;
    if (!/^\s*DO\b/i.test(stmtMasked)) {
      return {
        ok: false,
        reason:
          `a statement after the closing COMMIT is not a DO assertion block: ` +
          `"${stmtMasked.trim().slice(0, 80)}…". Only postcondition DO blocks may ` +
          "follow the COMMIT. Anything else would run in a second transaction, " +
          "outside the one carrying the ledger row — so a failure there would " +
          "leave the file half-applied with a ledger row claiming all of it.",
      };
    }
    if (MUTATION_KEYWORD_RE.test(maskForKeywordScan(stmtRaw))) {
      return {
        ok: false,
        reason:
          "a DO block after the closing COMMIT contains a schema-changing " +
          "statement, so it is not a postcondition. It must run inside the " +
          "applying transaction: move it above the COMMIT.",
      };
    }
  }
  if (masked.slice(start).trim() !== "") {
    return {
      ok: false,
      reason:
        "the text after the closing COMMIT ends without a semicolon, so its " +
        "final statement cannot be identified. Refusing rather than guessing.",
    };
  }
  return { ok: true };
}

/**
 * Decide how to embed `sql` in our transaction, or refuse it by name.
 *
 *   "bare"      — no top-level transaction control; the whole file, including
 *                 any trailing DO assertions, goes in ONE transaction with the
 *                 ledger row. Assertions there see the uncommitted state, which
 *                 is weaker than asserting what persisted — that is what
 *                 certifyMigrations.ts's postcondition stage re-establishes
 *                 after the fact. A file that wants the stronger property
 *                 should use the BEGIN/COMMIT + trailing-DO shape below.
 *   "unwrapped" — `BEGIN; … COMMIT;` with an optional tail of postcondition DO
 *                 blocks. The wrapper is stripped and the body is re-wrapped
 *                 around the ledger INSERT; the tail runs afterwards, in its
 *                 own transaction, exactly as the file intends.
 *   "refuse"    — any other shape. See the header for why guessing is worse
 *                 than refusing.
 */
export function classifyMigration(sql: string, filename: string): Classification {
  if (isEffectivelyEmpty(sql)) {
    return {
      kind: "refuse",
      reason:
        `${filename} contains no SQL (only comments and whitespace). An empty ` +
        "migration would write a ledger row asserting that something ran when " +
        "nothing did. Delete the file or give it a body.",
    };
  }

  if (usesConcurrently(sql)) {
    return {
      kind: "refuse",
      reason:
        `${filename} uses CONCURRENTLY. Postgres cannot run CREATE/DROP INDEX ` +
        "CONCURRENTLY inside a transaction block, so it cannot be applied in " +
        "the same transaction as its ledger row — and an apply that is not " +
        "atomic with its ledger row is the exact 'applied but unrecorded' " +
        "state this script exists to make unreachable. Apply it by hand, " +
        `verify it, then INSERT its ledger row with applied_by='manual'.`,
    };
  }

  const tcl = findTransactionStatements(sql);

  if (tcl.length === 0) {
    return { kind: "bare", body: sql, postconditions: "" };
  }

  const offenders = tcl.filter(
    (t) => t.keyword === "ROLLBACK" || t.keyword === "ABORT" || t.keyword === "SAVEPOINT",
  );
  if (offenders.length > 0) {
    const o = offenders[0];
    return {
      kind: "refuse",
      reason:
        `${filename} contains a top-level ${o.keyword} at line ${o.line}. This ` +
        "script wraps each migration in ONE transaction and writes the ledger " +
        "row inside it; a ROLLBACK, ABORT or SAVEPOINT in the body makes that " +
        "claim false. Files that carry a post-apply verification block (e.g. " +
        "2182_close_authz_rpc_oracle.sql's BEGIN/…/ROLLBACK probe) are not " +
        "replayable and must be applied by hand.",
    };
  }

  const isWrapper =
    tcl.length === 2 &&
    tcl[0].keyword === "BEGIN" &&
    tcl[1].keyword === "COMMIT";

  if (!isWrapper) {
    const shape = tcl.map((t) => `${t.keyword}@${t.line}`).join(", ");
    return {
      kind: "refuse",
      reason:
        `${filename} has transaction-control statements this script will not ` +
        `interpret: ${shape}. Exactly two shapes are accepted — no transaction ` +
        "control at all, or a single leading BEGIN with a single trailing " +
        "COMMIT. Anything else (an interior COMMIT, a second block, START " +
        "TRANSACTION) would commit the outer transaction early and leave the " +
        "ledger row outside it, which is the failure mode this script exists " +
        "to prevent.",
    };
  }

  // The wrapper must actually wrap: BEGIN first, COMMIT last, nothing after.
  const beginIdx = indexOfTopLevelKeyword(sql, "BEGIN");
  const commitIdx = lastIndexOfTopLevelKeyword(sql, "COMMIT");
  if (beginIdx === -1 || commitIdx === -1 || commitIdx < beginIdx) {
    return {
      kind: "refuse",
      reason: `${filename}: could not locate the BEGIN/COMMIT wrapper offsets. Refusing rather than guessing.`,
    };
  }

  const before = sql.slice(0, beginIdx);
  if (!isEffectivelyEmpty(before)) {
    return {
      kind: "refuse",
      reason:
        `${filename} has SQL BEFORE its opening BEGIN (line ${tcl[0].line}). ` +
        "That statement would run outside the file's own transaction, so the " +
        "file is not the single atomic unit it appears to be. Refusing.",
    };
  }

  // Body runs from just past `BEGIN;` to just before `COMMIT`.
  const afterBegin = sql.indexOf(";", beginIdx);
  if (afterBegin === -1 || afterBegin > commitIdx) {
    return {
      kind: "refuse",
      reason: `${filename}: opening BEGIN is not terminated by a semicolon. Refusing.`,
    };
  }

  const commitEnd = sql.indexOf(";", commitIdx);
  const after = commitEnd === -1 ? "" : sql.slice(commitEnd + 1);
  let postconditions = "";
  if (!isEffectivelyEmpty(after)) {
    const verdict = analyseTail(after);
    if (!verdict.ok) {
      return {
        kind: "refuse",
        reason:
          `${filename} has SQL AFTER its closing COMMIT (line ${tcl[1].line}) that ` +
          `is not a postcondition: ${verdict.reason}`,
      };
    }
    postconditions = after;
  }

  return {
    kind: "unwrapped",
    body: sql.slice(afterBegin + 1, commitIdx),
    postconditions,
  };
}

function indexOfTopLevelKeyword(sql: string, keyword: string): number {
  return scanForKeyword(sql, keyword, false);
}
function lastIndexOfTopLevelKeyword(sql: string, keyword: string): number {
  return scanForKeyword(sql, keyword, true);
}

/**
 * Offset of the first (or last) statement-initial occurrence of `keyword`,
 * using the same comment/literal/dollar-quote skipping as
 * findTransactionStatements. -1 when absent.
 */
function scanForKeyword(sql: string, keyword: string, last: boolean): number {
  const masked = maskNonCode(sql);
  const re = new RegExp(`\\b${keyword}\\b`, "gi");
  let found = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) {
    // statement-initial: only whitespace back to the previous `;` or BOF
    const before = masked.slice(0, m.index);
    const lastSemi = before.lastIndexOf(";");
    if (before.slice(lastSemi + 1).trim() === "") {
      found = m.index;
      if (!last) return found;
    }
  }
  return found;
}

/**
 * Replace every comment, literal and dollar-quoted body with spaces of the SAME
 * LENGTH, so offsets in the masked text are offsets in the original.
 */
export function maskNonCode(sql: string): string {
  const out = new Array<string>(sql.length);
  for (let k = 0; k < sql.length; k++) out[k] = sql[k];
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < sql.length; k++) {
      out[k] = sql[k] === "\n" ? "\n" : " ";
    }
  };

  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "-" && sql[i + 1] === "-") {
      const start = i;
      while (i < sql.length && sql[i] !== "\n") i++;
      blank(start, i);
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      const start = i;
      let depth = 0;
      do {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth--;
          i += 2;
        } else i++;
      } while (i < sql.length && depth > 0);
      blank(start, i);
      continue;
    }
    if (ch === "'") {
      const start = i;
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i] === "'") {
          i++;
          break;
        } else i++;
      }
      blank(start, i);
      continue;
    }
    if (ch === '"') {
      const start = i;
      i++;
      while (i < sql.length && sql[i] !== '"') i++;
      i++;
      blank(start, i);
      continue;
    }
    if (ch === "$") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const start = i;
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        i = end === -1 ? sql.length : end + tag.length;
        blank(start, i);
        continue;
      }
    }
    i++;
  }
  return out.join("");
}

// ─────────────────────────────────────────────────────────────────────────────
// PLANNING — ordered + idempotent
// ─────────────────────────────────────────────────────────────────────────────

export interface LedgerRow {
  filename: string;
  checksum: string;
  /** 'ci' | 'manual' | 'backfill' — constrained by a CHECK in migration 2254. */
  applied_by: string;
}

/** A real sha256, as opposed to 2254's `'backfill'` sentinel. */
export const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/**
 * IS THIS ROW EVIDENCE THAT THE FILE WAS APPLIED?
 *
 * THIS IS THE MOST IMPORTANT PREDICATE IN THIS FILE, AND GETTING IT WRONG THE
 * OBVIOUS WAY REPRODUCES THE ENTIRE DEFECT.
 *
 * 2254_schema_migration_ledger.sql seeds a row for EVERY filename that existed
 * in src/migrations/ when it ran — all ~380 of them, including 2220, 2222,
 * 2223, 2224, 2250, 2251, 2252 and 2253, the very files that had never been
 * applied. It seeds them with applied_by='backfill' and the literal string
 * 'backfill' in place of a checksum, and its own table comment says why:
 *
 *     "Rows with applied_by = 'backfill' … assert ONLY that the filename
 *      existed in src/migrations/ when 2254 ran; they are NOT evidence that the
 *      file was applied, and nothing verified that it was."
 *
 * An applier that skips on "there is a row" would therefore skip the six
 * unapplied migrations FOREVER, apply nothing, and leave `CI (live DB)` red on
 * main for exactly the original reason. So presence of a row is not the test.
 * Provenance is: a row proves an apply only when the applier wrote it —
 * applied_by 'ci' or 'manual' AND a real sha256, which is precisely what 2254's
 * backfill rows deliberately are not.
 */
export function isProofOfApply(row: LedgerRow): boolean {
  if (row.applied_by !== "ci" && row.applied_by !== "manual") return false;
  return SHA256_HEX_RE.test(row.checksum);
}

export interface MigrationOnDisk {
  filename: string;
  sql: string;
}

export interface ApplyPlan {
  /** Files to apply, in canonical order. */
  pending: string[];
  /** Files with a PROVEN ledger row whose checksum matches the file on disk. */
  skipped: string[];
  /**
   * Files whose ledger row is not proof of an apply — 2254's backfill rows.
   * Neither applied nor proven-applied. Not touched by default; see
   * `applyUnproven` and the --apply-unproven flag.
   */
  unproven: string[];
  /**
   * Files with a PROVEN ledger row whose recorded checksum differs from the
   * file on disk. A hard failure: the applied SQL and the committed SQL are not
   * the same text, and re-applying is not a safe repair. Unproven rows never
   * land here — comparing a hash against the literal 'backfill' would report
   * 380 false mismatches.
   */
  drifted: Array<{ filename: string; ledger: string; disk: string }>;
  /** Ledger rows naming files that no longer exist on disk. */
  orphaned: string[];
}

/**
 * Decide, purely, what to apply. No I/O — every input is passed in, which is
 * what makes ordering, skip-if-in-ledger and stop-on-failure unit-testable
 * without a database.
 */
export function planApply(
  onDisk: readonly MigrationOnDisk[],
  ledger: readonly LedgerRow[],
  /**
   * Files with an UNPROVEN ledger row that the caller has explicitly named for
   * application anyway (the --apply-unproven flag). Deliberately an explicit
   * list and never a mode: replaying a migration that WAS in fact applied is
   * the destructive direction, and nothing in the ledger can tell the two
   * apart, so a human decides per file.
   */
  applyUnproven: readonly string[] = [],
): ApplyPlan {
  const byName = new Map(ledger.map((r) => [r.filename, r]));
  const diskNames = new Set(onDisk.map((m) => m.filename));
  const forced = new Set(applyUnproven);

  const ordered = orderMigrations(onDisk.map((m) => m.filename));
  const sqlByName = new Map(onDisk.map((m) => [m.filename, m.sql]));

  const pending: string[] = [];
  const skipped: string[] = [];
  const unproven: string[] = [];
  const drifted: ApplyPlan["drifted"] = [];

  for (const filename of ordered) {
    const row = byName.get(filename);
    if (row === undefined) {
      pending.push(filename);
      continue;
    }
    if (!isProofOfApply(row)) {
      // A row exists, but it does not say the file ran.
      if (forced.has(filename)) pending.push(filename);
      else unproven.push(filename);
      continue;
    }
    const disk = checksumOf(sqlByName.get(filename)!);
    if (row.checksum === disk) skipped.push(filename);
    else drifted.push({ filename, ledger: row.checksum, disk });
  }

  const orphaned = ledger
    .map((r) => r.filename)
    .filter((f) => !diskNames.has(f))
    .sort(compareMigrationFilenames);

  return { pending, skipped, unproven, drifted, orphaned };
}

/**
 * The apply statement for ONE migration: the body and the ledger row, in ONE
 * transaction.
 *
 * The INSERT sits between the migration's last statement and the COMMIT, so the
 * two either both land or neither does. If any statement raises, Postgres
 * aborts the transaction and the trailing COMMIT behaves as a ROLLBACK — there
 * is no reachable state in which the schema changed and the ledger did not.
 *
 * ON CONFLICT DO UPDATE, not DO NOTHING. There are exactly two ways to reach
 * this function, and the conflict clause has to be right for both:
 *
 *   * the file has NO ledger row     -> the INSERT is the whole story.
 *   * the file has an UNPROVEN row (2254's backfill) and the operator named it
 *     with --apply-unproven          -> the row must be UPGRADED in place, to
 *     applied_by='ci'|'manual' with a real sha256, because that is now a record
 *     of an apply rather than a record of a filename.
 *
 * DO NOTHING would leave the backfill row standing after a real apply, so the
 * next run would see the same unproven row and the same file would be offered
 * for application forever. The UPDATE happens inside the same transaction as
 * the migration, so the atomicity guarantee is unchanged.
 *
 * applied_by is constrained by schema_migration_ledger_applied_by_check to
 * ('ci','manual','backfill'); anything else raises, which is the correct
 * outcome for a caller that invented a provenance.
 */
export function buildApplyStatement(args: {
  filename: string;
  body: string;
  checksum: string;
  appliedBy: string;
  notes: string;
}): string {
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  return [
    "BEGIN;",
    args.body.trim(),
    "",
    `INSERT INTO ${LEDGER_TABLE} (filename, checksum, applied_by, notes)`,
    `VALUES (${q(args.filename)}, ${q(args.checksum)}, ${q(args.appliedBy)}, ${q(args.notes)})`,
    "ON CONFLICT (filename) DO UPDATE SET",
    "  checksum   = EXCLUDED.checksum,",
    "  applied_at = now(),",
    "  applied_by = EXCLUDED.applied_by,",
    "  notes      = EXCLUDED.notes;",
    "COMMIT;",
  ].join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// STOP-AT-FIRST-FAILURE
// ─────────────────────────────────────────────────────────────────────────────

export interface StepOutcome {
  filename: string;
  /**
   * "postcondition-failed" is deliberately distinct from "failed". The
   * migration DID apply and IS recorded — that part is atomic and true — but
   * the file's own assertion about the persisted result did not hold. Reporting
   * it as a plain failure would imply nothing landed, which is false and would
   * send the next operator looking for a rollback that is not needed.
   */
  status: "applied" | "failed" | "refused" | "postcondition-failed";
  detail?: string;
}

/**
 * The exit code for a completed (or aborted) run.
 *
 * Anything other than "every attempted file applied" is a non-zero exit. There
 * is deliberately no partial-success code: a run that stopped halfway left the
 * database in a state no environment has ever had until someone finishes the
 * job, and calling that anything but a failure is how it gets ignored.
 */
export function decideExitCode(outcomes: readonly StepOutcome[]): number {
  return outcomes.some((o) => o.status !== "applied") ? 1 : 0;
}

/**
 * Run the ordered plan, stopping at the FIRST failure or refusal.
 *
 * Later migrations routinely depend on earlier ones (2093 and 2094 both alter
 * the table 2092 creates). Continuing past a failure would invent a schema
 * state no environment has ever had, and would do it silently. `apply` is
 * injected so this is testable without a database.
 */
export async function runPlan(
  pending: readonly string[],
  read: (filename: string) => string,
  apply: (filename: string, statement: string, phase: "apply" | "postcondition") => Promise<void>,
  meta: { appliedBy: string; notes: string },
): Promise<StepOutcome[]> {
  const outcomes: StepOutcome[] = [];
  for (const filename of pending) {
    const sql = read(filename);
    const cls = classifyMigration(sql, filename);
    if (cls.kind === "refuse") {
      outcomes.push({ filename, status: "refused", detail: cls.reason });
      return outcomes; // STOP.
    }
    const statement = buildApplyStatement({
      filename,
      body: cls.body,
      checksum: checksumOf(sql),
      appliedBy: meta.appliedBy,
      notes: meta.notes,
    });
    try {
      await apply(filename, statement, "apply");
    } catch (err) {
      outcomes.push({
        filename,
        status: "failed",
        detail: (err as Error).message,
      });
      return outcomes; // STOP.
    }

    // Phase 2: the file's own postconditions, in their own transaction, which
    // is the only place they can observe what actually persisted.
    if (cls.postconditions.trim() !== "") {
      try {
        await apply(filename, cls.postconditions, "postcondition");
      } catch (err) {
        outcomes.push({
          filename,
          status: "postcondition-failed",
          detail: (err as Error).message,
        });
        return outcomes; // STOP.
      }
    }
    outcomes.push({ filename, status: "applied" });
  }
  return outcomes;
}

// ─────────────────────────────────────────────────────────────────────────────
// REPORTING
// ─────────────────────────────────────────────────────────────────────────────

export function formatDryRun(plan: ApplyPlan, classify: (f: string) => Classification): string {
  const lines: string[] = [];
  lines.push("apply-migrations --dry-run — NOTHING IS WRITTEN.");
  lines.push("");
  lines.push(`Proven applied, skipped: ${plan.skipped.length}`);
  if (plan.unproven.length > 0) {
    lines.push(
      `Ledger row present but NOT proof of an apply (2254 backfill): ${plan.unproven.length}. ` +
        "Not applied. Name one with --apply-unproven to apply it deliberately.",
    );
  }
  if (plan.orphaned.length > 0) {
    lines.push(
      `Ledger rows with no file on disk: ${plan.orphaned.length} (${plan.orphaned.join(", ")})`,
    );
  }
  lines.push("");
  if (plan.pending.length === 0) {
    lines.push("Would apply: NOTHING. The ledger already accounts for every file on disk.");
  } else {
    lines.push(`Would apply ${plan.pending.length} migration(s), IN THIS ORDER:`);
    plan.pending.forEach((f, idx) => {
      const cls = classify(f);
      const shape =
        cls.kind === "refuse"
          ? `REFUSED — ${cls.reason}`
          : `shape=${cls.kind}${cls.postconditions.trim() ? " +postconditions" : ""}`;
      lines.push(`  ${String(idx + 1).padStart(3, " ")}. ${f}   [${shape}]`);
    });
  }
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────

/**
 * True only when this module is the process entry point. The test suite imports
 * this file for its pure functions; without this it would apply migrations.
 */
const RUN_DIRECTLY =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

/** `--apply-unproven a.sql,b.sql` — an explicit list, never a mode. */
export function parseApplyUnproven(argv: readonly string[]): string[] {
  const idx = argv.indexOf("--apply-unproven");
  if (idx === -1) return [];
  const raw = argv[idx + 1];
  if (!raw || raw.startsWith("--")) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

async function main(): Promise<never> {
  const dryRun = process.argv.includes("--dry-run");
  const applyUnproven = parseApplyUnproven(process.argv);
  if (process.argv.includes("--apply-unproven") && applyUnproven.length === 0) {
    console.error(
      "::error::apply-migrations: --apply-unproven needs a comma-separated list " +
        "of filenames. It is deliberately not a bare switch: replaying a " +
        "migration that WAS in fact applied is the destructive direction, and " +
        "nothing in the ledger can tell an applied backfill row from an " +
        "unapplied one — so a human names the files.",
    );
    process.exit(2);
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const ACCESS_TOKEN =
    process.env.SUPABASE_PROJECT_TOKEN || process.env.SUPABASE_ACCESS_TOKEN;

  if (!SUPABASE_URL) {
    console.error(
      "::error::apply-migrations: SUPABASE_URL is not set. There is no target " +
        "to resolve a project ref from, and an unresolvable target is not a " +
        "safe target. This is a failure, not a skip.",
    );
    process.exit(2);
  }
  if (!ACCESS_TOKEN) {
    console.error(
      "::error::apply-migrations: no Supabase Management API token. Set " +
        "SUPABASE_PROJECT_TOKEN (the name this repo's CI already uses, " +
        "configured on the 'ci-nonprod-supabase' environment) or " +
        "SUPABASE_ACCESS_TOKEN. This script does NOT degrade to a skip when " +
        "the token is absent: a migration apply that silently did not happen " +
        "is the entire defect it exists to fix.",
    );
    process.exit(2);
  }

  const projectRef = new URL(SUPABASE_URL).hostname.split(".")[0];
  const endpoint = `https://api.supabase.com/v1/projects/${projectRef}/database/query`;

  async function query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: sql }),
    });
    if (!res.ok) {
      throw new Error(`Management API ${res.status}: ${await res.text()}`);
    }
    return (await res.json()) as T[];
  }

  console.log(
    `apply-migrations: canonical tree ${MIGRATIONS_DIR}\n` +
      `                  target project ${projectRef}\n` +
      `                  mode ${dryRun ? "DRY RUN (writes nothing)" : "APPLY"}`,
  );

  // ── The ledger must exist. Applying without it is applying unrecorded. ────
  let ledger: LedgerRow[];
  try {
    ledger = await query<LedgerRow>(
      `select filename, checksum, applied_by from ${LEDGER_TABLE} order by filename`,
    );
  } catch (err) {
    console.error(
      `::error::apply-migrations: could not read ${LEDGER_TABLE}: ` +
        `${(err as Error).message}\n` +
        `The ledger is what makes this script idempotent and what makes an ` +
        `apply RECORDED. Without it every run would re-apply the whole chain ` +
        `and record nothing — the state this script exists to eliminate. ` +
        `Apply the migration that creates ${LEDGER_TABLE} first, then re-run.`,
    );
    process.exit(2);
  }

  let files: string[];
  try {
    files = listMigrationFiles();
  } catch (err) {
    console.error(
      `::error::apply-migrations: cannot read ${MIGRATIONS_DIR}: ${(err as Error).message}`,
    );
    process.exit(2);
  }

  const read = (f: string) => readFileSync(join(MIGRATIONS_DIR, f), "utf8");
  const onDisk: MigrationOnDisk[] = files.map((filename) => ({
    filename,
    sql: read(filename),
  }));

  const plan = planApply(onDisk, ledger, applyUnproven);

  const unknownForced = applyUnproven.filter((f) => !plan.pending.includes(f));
  if (unknownForced.length > 0) {
    console.error(
      `::error::apply-migrations: --apply-unproven names ${unknownForced.length} ` +
        `file(s) that are not unproven-and-on-disk: ${unknownForced.join(", ")}. ` +
        "Either the filename is wrong, the file is not in the canonical tree, or " +
        "its ledger row is already proof of an apply. Refusing rather than " +
        "silently applying a different set than was asked for.",
    );
    process.exit(2);
  }

  // ── Drift: the ledger says applied, the file says something else. ─────────
  if (plan.drifted.length > 0) {
    console.error(
      "::error::apply-migrations: the ledger records these files as applied, " +
        "but their contents on disk no longer match the recorded checksum. The " +
        "SQL that ran and the SQL in this commit are not the same text, so the " +
        "live schema cannot be derived from the tree. Re-applying is NOT a safe " +
        "repair (a migration is not necessarily re-runnable). Reconcile by hand.",
    );
    for (const d of plan.drifted) {
      console.error(`  ✖ ${d.filename}\n      ledger ${d.ledger}\n      disk   ${d.disk}`);
    }
    console.error(
      "\nNOTE ON THE ALGORITHM, because a mismatch here is as likely to be a " +
        "backfill disagreement as a real edit: this script writes and compares " +
        "the SHA-256 of the file's exact bytes, lowercase hex. A backfill that " +
        "used a different digest will look exactly like drift.",
    );
    process.exit(1);
  }

  const orderProblems = assertUnambiguousOrder(plan.pending);
  if (orderProblems.length > 0) {
    console.error("::error::apply-migrations: the pending set has no defined order.");
    for (const p of orderProblems) console.error(`  ✖ ${p}`);
    process.exit(1);
  }

  const classify = (f: string) => classifyMigration(read(f), f);

  if (dryRun) {
    console.log("");
    console.log(formatDryRun(plan, classify));
    console.log("");
    const refusals = plan.pending.filter((f) => classify(f).kind === "refuse");
    if (refusals.length > 0) {
      console.error(
        `::error::apply-migrations --dry-run: ${refusals.length} pending file(s) ` +
          "would be REFUSED (see above). A dry run that reports a refusal is a " +
          "failure, not an advisory: the real run would stop at the same file.",
      );
      process.exit(1);
    }
    console.log(
      `apply-migrations --dry-run PASSED — ${plan.pending.length} pending, ` +
        `${plan.skipped.length} already recorded, nothing written.`,
    );
    process.exit(0);
  }

  if (plan.unproven.length > 0) {
    console.log(
      `\napply-migrations NOTE: ${plan.unproven.length} file(s) have a ledger row ` +
        "that is NOT proof of an apply (2254 seeded them with " +
        "applied_by='backfill' and no real checksum, and its own table comment " +
        "says those rows assert only that the filename existed). They are not " +
        "applied here, because replaying a migration that DID run is the " +
        "destructive direction and the ledger cannot tell the two apart. " +
        "`audit:schema` and `check:missing-live-columns` answer whether their " +
        "objects are actually present; apply a specific one with " +
        "--apply-unproven <file>.",
    );
  }

  if (plan.pending.length === 0) {
    console.log(
      `apply-migrations: NOTHING TO DO — ${plan.skipped.length} canonical ` +
        "migration(s) carry a ledger row that proves they were applied, and no " +
        "file lacks a row. This is what a re-run looks like; the script is " +
        "idempotent by construction, because every proven file is skipped by name.",
    );
    process.exit(0);
  }

  const appliedBy = process.env.GITHUB_ACTIONS ? "ci" : "manual";
  const notes = [
    "scripts/src/apply-migrations.ts",
    process.env.GITHUB_SHA ? `sha=${process.env.GITHUB_SHA}` : null,
    process.env.GITHUB_RUN_ID ? `run=${process.env.GITHUB_RUN_ID}` : null,
  ]
    .filter(Boolean)
    .join(" ");

  console.log(`\nApplying ${plan.pending.length} migration(s), in canonical order:`);
  for (const f of plan.pending) console.log(`  · ${f}`);
  console.log("");

  const outcomes = await runPlan(
    plan.pending,
    read,
    async (filename, statement, phase) => {
      await query(statement);
      console.log(
        phase === "apply"
          ? `  → ${filename}: applied + recorded (one transaction)`
          : `  → ${filename}: postconditions verified (separate transaction)`,
      );
    },
    { appliedBy, notes },
  );

  const code = decideExitCode(outcomes);
  const bad = outcomes.find((o) => o.status !== "applied");
  if (bad) {
    console.error("");
    console.error(
      `::error::apply-migrations STOPPED at ${bad.filename} (${bad.status}). ` +
        `${bad.detail ?? ""}\n` +
        "Later migrations were NOT attempted, on purpose: they routinely " +
        "depend on earlier ones, and applying past a failure invents a schema " +
        "state no environment has ever had.",
    );
    if (bad.status === "postcondition-failed") {
      console.error(
        `  NOTE: ${bad.filename} DID apply and IS recorded in the ledger — that ` +
          "transaction committed. What failed is the file's own assertion about " +
          "the persisted result. Do not look for a rollback; look at the " +
          "assertion and at what the migration actually produced.",
      );
    }
    const appliedCount = outcomes.filter((o) => o.status === "applied").length;
    console.error(
      `  applied before the stop : ${appliedCount}\n` +
        `  not attempted           : ${plan.pending.length - outcomes.length}`,
    );
  } else {
    console.log(
      `\napply-migrations PASSED — ${outcomes.length} migration(s) applied and ` +
        `recorded in ${LEDGER_TABLE}, each in one transaction with its ledger row.`,
    );
  }
  process.exit(code);
}

if (RUN_DIRECTLY) {
  // THE TARGET GUARD. The first thing this PROCESS does, and it is awaited
  // before main() so no client is constructed and no query is issued until the
  // allowlist has been asserted. See "TARGET GUARD" in the header for why this
  // is a dynamic entry-point import rather than a static first import, and for
  // the invariant that keeps the two equivalent.
  await import("../../artifacts/api-server/src/lib/ciSupabaseGuard.mjs");
  await main();
}
