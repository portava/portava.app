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
import { createHash } from "node:crypto";
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

// ─────────────────────────────────────────────────────────────────────────────
// Postcondition supersession (certify:migrations stage 4)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A later migration that DELIBERATELY changes the end state an earlier
 * migration's postcondition pins declares it in its own header, one line per
 * earlier file:
 *
 *     -- certify:supersedes-postconditions 3362_posts_client_column_grants.sql
 *
 * WHY THIS EXISTS. Stage 4 re-runs every in-scope file's postconditions against
 * the committed database. On a full-chain build (the beta bootstrap applies the
 * whole chain under one run id) the earlier and the later file share a scope,
 * so the earlier block — "exactly these columns are client-readable" — is
 * re-run against the later file's narrower state and fails by construction.
 * That is the class that withdrew lead ruling G-2 (2955 against 3740). The
 * alternative to declaring it is never narrowing a grant an earlier
 * postcondition pins, which would leave a confirmed exposure open (census-media
 * §50.16, N2b) to keep a re-run green.
 *
 * WHY IT IS NOT A WEAKENING. A superseded block is held back ONLY while its
 * superseder is recorded applied, and the superseder's OWN postconditions are
 * re-run in its place even when the superseder is not otherwise in scope. A
 * superseder without a re-runnable postcondition is refused (the declaration
 * would then delete an assertion rather than replace it). Every held-back block
 * is counted and named in the stage's report, like a `$pre$` block. Once the
 * superseder is rolled back (its rollback deletes its ledger row), the earlier
 * block is re-run again.
 */
export const SUPERSEDES_POSTCONDITIONS_RE = /^--[ \t]*certify:supersedes-postconditions[ \t]+(\S+\.sql)[ \t]*$/;

/**
 * The earlier files whose postconditions `sql` declares it supersedes.
 *
 * Only the file's LEADING COMMENT HEADER is read: the lines before the first
 * line that is neither blank nor a `--` comment (verifier M4 F4). A marker
 * inside a dollar-quoted body, a block comment or a string literal, or anywhere
 * after the first statement, is not a declaration.
 */
export function supersededPostconditionFiles(sql: string): string[] {
  const out: string[] = [];
  for (const raw of sql.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.trim() === "") continue;
    if (!line.startsWith("--")) break;
    const m = SUPERSEDES_POSTCONDITIONS_RE.exec(line);
    if (m) out.push(m[1]!);
  }
  return out;
}

export interface PostconditionRerunPlan {
  /** Files whose postconditions stage 4 re-runs, in filename order. */
  run: string[];
  /** In-scope files whose postconditions are held back, and the applied file that supersedes each. */
  heldBack: Array<{ file: string; by: string }>;
  /**
   * Declarations REFUSED because the superseder has no re-runnable postcondition
   * of its own: a supersession must replace the assertion, not delete it. The
   * superseded file's postconditions are re-run as if nothing were declared,
   * and stage 4 fails on any entry here (verifier M4 F3).
   */
  refused: Array<{ file: string; by: string }>;
}

/**
 * Which files' postconditions stage 4 re-runs, given the run's scope, the files
 * the ledger records as applied, the supersession declarations on disk
 * (superseding file → the earlier files it names), and whether a file has a
 * re-runnable postcondition of its own.
 *
 * A declaration counts only when the superseding file is recorded applied and
 * sorts AFTER the file it names. Supersession is followed transitively: if the
 * superseder is itself superseded by a later applied file, that one's
 * postconditions run. A superseder without a postcondition is refused (and the
 * chain stops there), so a declaration can never make an assertion disappear.
 */
export function planPostconditionRerun(
  scope: readonly string[],
  applied: ReadonlySet<string>,
  declarations: ReadonlyMap<string, readonly string[]>,
  hasPostcondition: (file: string) => boolean,
): PostconditionRerunPlan {
  const supersededBy = new Map<string, string>();
  for (const [by, earlier] of declarations) {
    if (!applied.has(by)) continue;
    for (const f of earlier) {
      if (!(f < by)) continue;
      const prev = supersededBy.get(f);
      if (prev === undefined || by > prev) supersededBy.set(f, by);
    }
  }
  const refused: Array<{ file: string; by: string }> = [];
  const resolve = (f: string): string => {
    let cur = f;
    for (let hops = 0; supersededBy.has(cur) && hops < 1000; hops++) {
      const next = supersededBy.get(cur)!;
      if (!hasPostcondition(next)) {
        if (!refused.some((r) => r.file === cur && r.by === next)) refused.push({ file: cur, by: next });
        break;
      }
      cur = next;
    }
    return cur;
  };
  const run = new Set<string>();
  const heldBack: Array<{ file: string; by: string }> = [];
  for (const f of scope) {
    const by = resolve(f);
    if (by !== f) heldBack.push({ file: f, by });
    run.add(by);
  }
  return { run: [...run].sort(), heldBack, refused };
}

// ─────────────────────────────────────────────────────────────────────────────
// Postcondition AMENDMENTS (certify:migrations stage 4, whole-chain runs)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A re-runnable postcondition block exactly as stage 4 collects it (the
 * topLevelStatements() slice, leading trivia included), with its 1-based
 * ordinal among the file's re-runnable postconditions, the FILE line of its
 * first code token (`DO`) and of its terminating `;`.
 */
export interface PostconditionBlock {
  index: number;
  text: string;
  firstLine: number;
  lastLine: number;
}

/** Every re-runnable postcondition of `sql`, in file order — certify's stage-4 list, with positions. */
export function postconditionBlocks(sql: string): PostconditionBlock[] {
  const out: PostconditionBlock[] = [];
  let cursor = 0;
  for (const stmt of topLevelStatements(sql)) {
    const at = sql.indexOf(stmt, cursor);
    cursor = at + stmt.length;
    if (!isAssertionOnlyDoBlock(stmt) || isPreconditionDoBlock(stmt)) continue;
    const lead = stmt.length - stripLeadingTrivia(stmt).length;
    const lineAt = (offset: number) => sql.slice(0, offset).split("\n").length;
    out.push({ index: out.length + 1, text: stmt, firstLine: lineAt(at + lead), lastLine: lineAt(at + stmt.length - 1) });
  }
  return out;
}

/** sha256 of a block's exact text, first 16 hex — what an amendment pins. */
export function blockSha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

/** One statement (a whole-line span of the FILE) dropped from a block before stage 4 re-runs it. */
export interface AmendmentDrop {
  /** First and last FILE line, inclusive. Whole lines; inside the block; never overlapping another drop. */
  lines: readonly [number, number];
  /**
   * A substring of the error the block raises when THIS drop is the only one
   * not applied, at the chain end. db/postconditionAmendments.db.test.ts holds
   * every drop to it: a drop that is not necessary, or fails for another
   * reason, is a wrong declaration.
   */
  failsWith: string;
  /**
   * kind "superseded": the later migration after which this statement fails
   * and never passes again, measured on a whole-chain replay (the evidence is
   * the entry's `why`). The drop applies only while that file is recorded
   * applied in the ledger; otherwise the statement is re-run as written.
   */
  supersededBy?: string;
}

/**
 * A declaration that stage 4 re-runs a postcondition block WITHOUT named
 * statements — the statement-level form of `-- certify:supersedes-postconditions`,
 * for blocks in files that cannot carry a header line (every applied migration
 * is checksum-locked in the ledger, so a header would be an edit).
 *
 *   superseded     a LATER applied migration deliberately changed the object
 *                  the statement pins (a narrowed grant, a rewritten policy or
 *                  kernel body, a dropped function). The rest of the block is
 *                  still re-run, and the re-asserting migrations' own
 *                  postconditions are re-run in its place even when they are
 *                  not in scope — a supersession replaces an assertion, it
 *                  never deletes one.
 *   session-bound  the statement reads a temp table or session setting that
 *                  only the file's own apply transaction had (a KNOWN
 *                  check:migration-session-state finding). No separate request
 *                  can ever evaluate it; the applier did, inside the
 *                  transaction that also wrote the file's ledger row.
 */
export interface PostconditionAmendment {
  file: string;
  /** FILE line of the block's `DO` and the block's blockSha256(): the block this entry was written against. */
  blockLine: number;
  blockSha256: string;
  kind: "superseded" | "session-bound";
  drops: readonly AmendmentDrop[];
  /** superseded: migrations whose re-runnable postconditions assert the object's current state. Default: the drops' supersededBy. */
  reassertedBy?: readonly string[];
  /**
   * superseded: an assertion-only DO block re-asserting the dropped statement's
   * intent in its CURRENT form, for when no migration's postcondition does (the
   * superseding migration changed the object but asserted nothing about it).
   * Run in the block's place, beside reassertedBy's postconditions.
   */
  reassert?: string;
  /** session-bound: the temp table or setting the dropped statements read. */
  sessionState?: string;
  /** Why the statement no longer holds at the chain end, naming the superseding migration and the measurement. */
  why: string;
}

/** The text stage 4 sends for `block` once `drops` are removed, or why it refuses to narrow it. */
export function amendBlock(
  fileSql: string,
  block: PostconditionBlock,
  drops: readonly Pick<AmendmentDrop, "lines">[],
): { ok: true; text: string } | { ok: false; reason: string } {
  const fileLines = fileSql.split("\n");
  const sorted = [...drops].sort((a, b) => a.lines[0] - b.lines[0]);
  let prevEnd = 0;
  const spans: Array<{ at: number; len: number }> = [];
  for (const d of sorted) {
    const [a, z] = d.lines;
    if (!Number.isInteger(a) || !Number.isInteger(z) || a > z) return { ok: false, reason: `drop ${a}-${z} is not a line range` };
    if (a < block.firstLine || z > block.lastLine) {
      return { ok: false, reason: `drop ${a}-${z} is outside the block (lines ${block.firstLine}-${block.lastLine})` };
    }
    if (a <= prevEnd) return { ok: false, reason: `drop ${a}-${z} overlaps the previous drop` };
    prevEnd = z;
    const span = fileLines.slice(a - 1, z).join("\n");
    if (span.trim() === "") return { ok: false, reason: `drop ${a}-${z} is blank` };
    const at = block.text.indexOf(span);
    if (at < 0 || block.text.indexOf(span, at + 1) >= 0) {
      return { ok: false, reason: `drop ${a}-${z} is not exactly one span of the block's text` };
    }
    spans.push({ at, len: span.length });
  }
  let text = block.text;
  for (const s of spans.sort((x, y) => y.at - x.at)) text = text.slice(0, s.at) + text.slice(s.at + s.len);
  // Narrow, never delete: what is left must still be an assertion-only DO block that RAISEs.
  if (!isAssertionOnlyDoBlock(text)) {
    return { ok: false, reason: "the narrowed block is no longer an assertion-only DO block that raises; a declaration may narrow a block, never delete it" };
  }
  return { ok: true, text };
}

/** A block as stage 4 will send it, and what (if anything) was dropped from it and why. */
export interface PlannedBlock {
  file: string;
  /** FILE line of the block's `DO`. */
  line: number;
  text: string;
  dropped: Array<{ lines: readonly [number, number]; because: string }>;
}

export interface AmendmentPlan {
  /** Every block stage 4 re-runs, amended where a declaration applies, in (file, line) order. */
  blocks: PlannedBlock[];
  /** Files added to the run because a declaration names them as the re-assertion of an amended block. */
  reasserted: Array<{ file: string; for: string }>;
  /** Declarations refused; the block concerned is re-run as written, and stage 4 fails on every entry here. */
  refused: string[];
}

/**
 * Which postcondition text stage 4 sends, given the files it re-runs (after
 * header supersession), the files recorded applied, and the declarations.
 *
 *   * A block with no declaration is sent as written.
 *   * A declaration whose block text no longer matches (blockLine/blockSha256),
 *     or that cannot be applied (amendBlock refuses), is REFUSED: the block is
 *     sent as written and the refusal fails the stage.
 *   * A superseded drop applies only while its supersededBy is recorded
 *     applied; otherwise that statement is sent as written (fail closed).
 *   * Every re-asserting file of an applied supersession is added to the run
 *     (resolved through `resolveSuperseded`, then amended in turn); one with no
 *     re-runnable postcondition is REFUSED — a supersession must replace the
 *     assertion, not delete it.
 */
export function planPostconditionAmendments(args: {
  files: readonly string[];
  applied: ReadonlySet<string>;
  amendments: readonly PostconditionAmendment[];
  sqlOf: (file: string) => string | null;
  resolveSuperseded?: (file: string) => string;
}): AmendmentPlan {
  const resolve = args.resolveSuperseded ?? ((f: string) => f);
  const byBlock = new Map<string, PostconditionAmendment[]>();
  for (const a of args.amendments) {
    const k = `${a.file}:${a.blockLine}`;
    byBlock.set(k, [...(byBlock.get(k) ?? []), a]);
  }
  const blocks: PlannedBlock[] = [];
  const reasserted: Array<{ file: string; for: string }> = [];
  const refused: string[] = [];
  const inline = new Set<string>();
  const inlineBlocks: PlannedBlock[] = [];
  const queued = new Set<string>(args.files);
  const queue = [...args.files].sort();
  const enqueue = (file: string, reason: string) => {
    const r = resolve(file);
    if (queued.has(r)) return;
    queued.add(r);
    queue.push(r);
    reasserted.push({ file: r, for: reason });
  };

  for (let qi = 0; qi < queue.length; qi++) {
    const file = queue[qi]!;
    const sql = args.sqlOf(file);
    if (sql === null) {
      refused.push(`${file}: named as a re-assertion but not on disk.`);
      continue;
    }
    for (const b of postconditionBlocks(sql)) {
      const entries = byBlock.get(`${file}:${b.firstLine}`) ?? [];
      const asWritten: PlannedBlock = { file, line: b.firstLine, text: b.text, dropped: [] };
      if (entries.length === 0) {
        blocks.push(asWritten);
        continue;
      }
      if (entries.length > 1) {
        refused.push(`${file}:${b.firstLine}: ${entries.length} amendments name this block; exactly one may.`);
        blocks.push(asWritten);
        continue;
      }
      const a = entries[0]!;
      if (blockSha256(b.text) !== a.blockSha256) {
        refused.push(
          `${file}:${b.firstLine}: the amendment was written against different text (sha256 ${a.blockSha256}, ` +
            `the block is ${blockSha256(b.text)}); REFUSED, the block is re-run as written.`,
        );
        blocks.push(asWritten);
        continue;
      }
      const live = a.kind === "session-bound" ? [...a.drops] : a.drops.filter((d) => d.supersededBy !== undefined && args.applied.has(d.supersededBy));
      if (a.kind === "superseded" && a.drops.some((d) => d.supersededBy === undefined)) {
        refused.push(`${file}:${b.firstLine}: a superseded drop names no superseding migration; REFUSED.`);
        blocks.push(asWritten);
        continue;
      }
      if (live.length === 0) {
        blocks.push(asWritten);
        continue;
      }
      if (a.kind === "superseded") {
        const reasserting = a.reassertedBy ?? [...new Set(live.map((d) => d.supersededBy!))];
        let ok = true;
        if (reasserting.length === 0 && a.reassert === undefined) {
          refused.push(`${file}:${b.firstLine}: names nothing that re-asserts it; REFUSED — a supersession must replace the assertion, not delete it.`);
          ok = false;
        }
        if (a.reassert !== undefined && !isAssertionOnlyDoBlock(a.reassert)) {
          refused.push(`${file}:${b.firstLine}: its re-assertion is not an assertion-only DO block that raises; REFUSED.`);
          ok = false;
        }
        for (const r of reasserting) {
          const rs = args.sqlOf(resolve(r));
          if (rs === null || postconditionBlocks(rs).length === 0) {
            refused.push(
              `${file}:${b.firstLine}: re-assertion ${r} has no re-runnable postcondition; REFUSED — a supersession must replace the assertion, not delete it.`,
            );
            ok = false;
          }
        }
        if (!ok) {
          blocks.push(asWritten);
          continue;
        }
        for (const r of reasserting) enqueue(r, `${file}:${b.firstLine}`);
        if (a.reassert !== undefined && !inline.has(a.reassert)) {
          inline.add(a.reassert);
          inlineBlocks.push({ file: `${file} (re-assertion)`, line: b.firstLine, text: a.reassert, dropped: [] });
          reasserted.push({ file: `${file}:${b.firstLine} inline re-assertion`, for: `${file}:${b.firstLine}` });
        }
      }
      const narrowed = amendBlock(sql, b, live);
      if (!narrowed.ok) {
        refused.push(`${file}:${b.firstLine}: ${narrowed.reason}; REFUSED, the block is re-run as written.`);
        blocks.push(asWritten);
        continue;
      }
      blocks.push({
        file,
        line: b.firstLine,
        text: narrowed.text,
        dropped: live.map((d) => ({
          lines: d.lines,
          because: a.kind === "session-bound" ? `session-bound: reads ${a.sessionState ?? "state"} only its own apply transaction had` : `superseded by ${d.supersededBy}`,
        })),
      });
    }
  }
  blocks.push(...inlineBlocks);
  blocks.sort((x, y) => (x.file < y.file ? -1 : x.file > y.file ? 1 : x.line - y.line));
  return { blocks, reasserted, refused };
}
