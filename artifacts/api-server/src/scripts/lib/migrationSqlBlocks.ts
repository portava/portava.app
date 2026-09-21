/**
 * migrationSqlBlocks.ts — the SQL text layer certifyMigrations.ts reads with.
 *
 * Lifted out of certifyMigrations.ts unchanged so it can be exercised directly.
 * That script's first import is the strict CI front door and its last line is
 * `await main()`, so nothing inside it could be imported and asserted on; the
 * classification rule that decides which of a migration's `DO` blocks get
 * re-run against a live database had therefore never been under test.
 *
 * ONE implementation, here. Anything needing these rules imports them rather
 * than restating them — a second copy of a parsing rule drifts, and the copy
 * that drifts quietly is the one that gets believed.
 */

// ─────────────────────────────────────────────────────────────────────────────
// SQL text helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Blank comments and quoted literals, KEEPING dollar-quoted bodies (which are
 * executable code). Used for every keyword scan below, so that a `CREATE TABLE`
 * inside a `DO $$ … $$` block is seen and a `'DELETE'` inside a string literal
 * is not.
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

/** Blank comments, literals AND dollar-quoted bodies, preserving offsets. */
export function maskNonCode(sql: string): string {
  const out = sql.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < sql.length; k++) {
      out[k] = sql[k] === "\n" ? "\n" : " ";
    }
  };
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "-" && sql[i + 1] === "-") {
      const s = i;
      while (i < sql.length && sql[i] !== "\n") i++;
      blank(s, i);
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      const s = i;
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
      blank(s, i);
      continue;
    }
    if (ch === "'") {
      const s = i;
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i] === "'") {
          i++;
          break;
        } else i++;
      }
      blank(s, i);
      continue;
    }
    if (ch === '"') {
      const s = i;
      i++;
      while (i < sql.length && sql[i] !== '"') i++;
      i++;
      blank(s, i);
      continue;
    }
    if (ch === "$") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const s = i;
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        i = end === -1 ? sql.length : end + tag.length;
        blank(s, i);
        continue;
      }
    }
    i++;
  }
  return out.join("");
}

export const MUTATION_KEYWORD_RE =
  /\b(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|TRUNCATE|GRANT|REVOKE|COMMENT|REFRESH|REINDEX|CALL|COPY|EXECUTE)\b/i;

/**
 * True when `stmt` is a `DO` block that raises and changes nothing.
 *
 * `EXECUTE` is on the mutation list even though it is not itself a change:
 * inside plpgsql it runs a string this scan cannot see, so a block containing
 * it is not something this script can certify as read-only.
 */
export function isAssertionOnlyDoBlock(stmt: string): boolean {
  const masked = maskForKeywordScan(stmt);
  if (!/^\s*DO\b/i.test(masked)) return false;
  if (!/\bRAISE\b/i.test(masked)) return false;
  return !MUTATION_KEYWORD_RE.test(masked);
}

/**
 * True when `stmt` is a `DO $pre$ … $pre$;` block — a PRECONDITION.
 *
 * WHY THESE ARE EXCLUDED FROM STAGE 4, AND WHY THAT IS NOT A WEAKENING
 * ===================================================================
 *
 * Stage 4's contract is in its own name: postconditions, re-run AFTER the
 * commit, "which is the only place they can observe what persisted". A
 * precondition observes the state BEFORE. Re-running one after the commit does
 * not ask a weaker version of stage 4's question — it asks a different
 * question, and for one whole family of preconditions it asks a question whose
 * answer must now be "no".
 *
 * That family is the house style here. Measured 2026-09-21 over 580 migration
 * files: 32 carry an assertion-only `DO $pre$` block, and 23 of those 32 RAISE
 * EXCEPTION on a second apply. 25 files in the tree say it in the same words,
 * "this migration is not idempotent by design":
 *
 *     2760  IF n <> 0 THEN RAISE EXCEPTION '2760: trip_stages already exists';
 *     2784  RAISE EXCEPTION '2784: trip_reservation_events already exists; …'
 *     2796  RAISE EXCEPTION '2796: … is already SECURITY DEFINER; this migration has run'
 *     2965  RAISE EXCEPTION '2965: the installed definition already qualifies …'
 *
 * Every one of those is FALSE before the apply and TRUE after it. Feeding them
 * to stage 4 means a migration that worked perfectly certifies as failed, and
 * the better the guard, the louder the false failure.
 *
 * THIS WAS LATENT UNTIL 2026-09-21, and the reason is NOT that it had never
 * been in scope — that was the first guess and the ledger refuted it. 16 of the
 * 23 were applied by CI with a `run=` tag, on run 34972255308, so they were in
 * scope that day. What saved that run is that certify STOPS AT THE FIRST FAILED
 * STAGE, and it failed at stage 1: twelve other files on that branch had no
 * ledger row at all, so stage 4 never executed.
 *
 * Run 35581577283 is simply the first run to reach stage 4 with such a file in
 * scope — stages 1-3 all passed, 580 files against 580 ledger rows — and it
 * failed on 2965's guard fourteen seconds after 2965 applied cleanly. The
 * landmine was always armed; a redder pipeline had been standing in front of
 * it.
 *
 * WHAT STILL HOLDS THESE BLOCKS. They are not unchecked, they are checked in
 * the only place they mean anything: the applier runs them inside the
 * migration's own transaction, before the change, and a raise there aborts the
 * apply. Excluding them here removes a re-run that could only ever have been a
 * tautology or a false alarm.
 *
 * WHY THE TAG IS THE SIGNAL. `$pre$` is the author's own declaration and an
 * established convention in this tree (32 files open a `DO $pre$` block, 53 a
 * `DO $post$`; 474 assertion blocks are still re-run after the split). Keying
 * on intent stated in the file beats inferring it from the assertion's text,
 * which would mean pattern-matching English. It is also not a new escape
 * hatch: a migration that declares no assertion blocks at all already passes
 * stage 4, whereas a `$pre$` block is COUNTED AND NAMED in the stage's report,
 * so an author who mis-tags a real postcondition is visible in the output
 * rather than silently exempt. `DO $$` is not a `$pre$` tag and is unaffected.
 */
export function isPreconditionDoBlock(stmt: string): boolean {
  return /^DO\s+\$pre\$/i.test(stripLeadingTrivia(stmt));
}

/**
 * Drop whitespace and comments from the FRONT of a statement, leaving the first
 * real token first.
 *
 * topLevelStatements() slices from just after the previous semicolon, so a
 * block written under a `-- ── Preconditions ──` banner arrives with the banner
 * attached and a bare `/^\s*DO/` never matches it. 12 of the 32 `$pre$` files
 * are written that way, among them 2779, 2789, 2791, 2793 and 2921 — every one
 * a second-apply guard that would then have failed certification exactly as
 * 2965 did.
 *
 * maskForKeywordScan() is the wrong tool for this and was tried first: it
 * replaces each dollar-quote DELIMITER with a single space (`out += " " + body
 * + " "`), so the `$pre$` tag it is being asked about does not survive it and
 * the predicate matched nothing at all.
 */
function stripLeadingTrivia(stmt: string): string {
  let s = stmt;
  for (;;) {
    const before = s;
    s = s.replace(/^\s+/, "").replace(/^--[^\n]*/, "").replace(/^\/\*[\s\S]*?\*\//, "");
    if (s === before) return s;
  }
}

/** Split into top-level statements (semicolons outside literals and bodies). */
export function topLevelStatements(sql: string): string[] {
  const masked = maskNonCode(sql);
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] !== ";") continue;
    const raw = sql.slice(start, i + 1);
    if (masked.slice(start, i).trim() !== "") out.push(raw);
    start = i + 1;
  }
  return out;
}
