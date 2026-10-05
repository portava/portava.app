/**
 * check-block-list-fail-open — the `blocks` read path cannot be re-opened.
 *
 * ── WHY THIS GUARD AND NOT ANOTHER FIX ──────────────────────────────────────
 * The block-list read path decides whether a person who blocked someone STAYS
 * blocked. It has been closed and re-opened TWICE in four weeks:
 *
 *   2026-09-06, PR #469  — fifteen hand-rolled fail-open block reads were
 *       routed through `lib/blocks.ts#fetchBlockedSet` (null on failure) and
 *       `lib/blockGuard.ts#isBlockedBetween` (true on failure). Shipped.
 *   2026-10-04, PR #530  — found it re-opened. A `{ count: "exact" }` fast
 *       path had been added to `fetchBlockedSet`, and the wholeness test it
 *       leaned on scored a NON-ARRAY `data` as "whole". An unread block list
 *       therefore became an EMPTY block set, and a blocked user was served as
 *       a tag suggestion. The suite's own fake Supabase client was unfaithful
 *       in the same direction (it answered `data: null` for a `{ count }`
 *       request, treating it as HEAD), so no test could have caught it.
 *
 * Two re-openings on the same path means the defect is not a site, it is a
 * SHAPE that keeps being re-typed. A one-site fix does not hold it closed; a
 * static rule that fails the build does.
 *
 * ── THE TABLE ───────────────────────────────────────────────────────────────
 * `public.blocks` — `src/migrations/0015_blocks.sql`: `(id, blocker_id,
 * blocked_id, created_at)`, `blocks_pair_unique (blocker_id, blocked_id)`.
 * There is no `user_blocks` table in this tree; the only occurrences of that
 * name are keys in four test fixtures' fake row maps.
 *
 * A block is SYMMETRIC for visibility, so "is X blocked from Y" is a read of
 * both directions, and the table is an EXCLUSION table: a ROW means DENY, so
 * EMPTINESS means ALLOW. That is the whole reason a failed read is dangerous
 * here and merely annoying elsewhere — the failure's natural coercion (`data
 * ?? []`, `count ?? 0`, `Boolean(data)`) is the PERMISSIVE answer, every time,
 * with no direction to argue about.
 *
 * ── THE THREE RULES ─────────────────────────────────────────────────────────
 * R1 `direct-read` — CENTRALISATION. A `blocks` read lives in one of the
 *     sanctioned modules (`BLOCK_READ_MODULES` below) or nowhere. Fifteen
 *     hand-rolled copies were what #469 had to sweep up; a sixteenth must fail
 *     the build instead of being found by the next audit. R1 is about WHERE the
 *     read is written and nothing else — R2 and R3 apply everywhere, including
 *     inside the sanctioned modules, because that is where #530's defect was.
 *
 * R2 `three-state` — THE DISTINCTION MUST SURVIVE THE CALL SITE. A `blocks`
 *     read has three outcomes and they are not two:
 *
 *       SUCCESS_WITH_DATA  rows came back      → those ids are excluded
 *       SUCCESS_EMPTY      proved zero rows    → nobody is excluded
 *       FAILURE            could not be read   → NOT "nobody is excluded"
 *
 *     supabase-js RESOLVES `{ data, error }` rather than throwing, so FAILURE
 *     arrives looking exactly like SUCCESS_EMPTY. A site that coerces the
 *     answer to an empty collection, a zero or a boolean WITHOUT having
 *     consulted the error first has collapsed three states into two, and the
 *     state it lost is the only unsafe one.
 *
 * R2b `error-inert` — THE FAILURE BRANCH MUST NOT ANSWER "NOBODY". R2's
 *     sibling, for the sites where the error IS consulted and the branch it
 *     leads to answers with the same emptiness an unread list would:
 *     `blockedRes.error ? (profile?.blockedUserIds ?? []) : …`. The error was
 *     observed, every error-observed guard passes, and the block set is empty
 *     anyway. `checkUncheckedSupabaseReads` names this class in its own header
 *     as one it cannot see — "the error is observed, the guard passes, and an
 *     unreadable restrictions table still reports NOT RESTRICTED" — and notes
 *     that scoped to an EXCLUSION table the direction needs no judgement. That
 *     scoping is this rule. The fail-CLOSED answers (`null` for
 *     `fetchBlockedSet`, `true` for `isBlockedBetween`, a NON-empty set for
 *     "drop every author that could be blocked") are not flagged.
 *
 * R3 `empty-without-proof` — EMPTINESS NEEDS A POSITIVE PROOF. "Nobody is
 *     blocked" may be concluded only from an ACTUAL empty array
 *     (`Array.isArray(data) && data.length === 0`) or an EXACT count of zero
 *     (`count === 0` from `{ count: "exact" }`). Never from the ABSENCE of
 *     data: not from `!data`, not from a non-array `data`, not from a missing
 *     count. This is #530's defect stated as a rule: the predicate
 *     `blocksAnswerIsWhole` answered "whole" for a non-array `data`, which is
 *     precisely "I have no data, therefore there is nothing".
 *
 * ── THE SANCTIONED SHAPES (what a clean site looks like) ────────────────────
 *     if (error) return null;                            // FAILURE, distinct
 *     const blocked = Array.isArray(data) && data.length > 0;
 *     if (!Array.isArray(data)) return count === 0;      // defers to the count
 *     if (blockErr || (blockCount ?? 0) > 0) deny();     // error tested FIRST
 *     isExcluded(set, id)                                // unreadable ⇒ true
 *
 * ── LIMITS, STATED RATHER THAN IMPLIED ──────────────────────────────────────
 *   * Text-level, not type-level and not data-flow, like its two siblings
 *     (`checkSilentSupabaseWrites`, `checkSilentSupabaseReads`) and built on
 *     the same `lib/supabaseCallScan` primitives. A `blocks` read reached
 *     through a helper is invisible here; the helper's own body is scanned.
 *   * R2's "consulted the error" is SYNTACTIC: the error identifier (or a
 *     `.error` member access) is MENTIONED in the window at an offset at or
 *     before the coercion. It does not prove the branch taken on it was
 *     correct — the same limit `checkSilentSupabaseReads` states for its S1.
 *     What it does prove is the thing that was false at both re-openings: that
 *     the failure was looked at AT ALL before the answer was flattened.
 *   * R2b reaches only the ERROR-INERT shapes with a syntactic signature: a
 *     failure branch whose answer is an empty literal, or a coalesce whose
 *     fallback is one. An error branch that returns a VARIABLE which happens to
 *     be empty is invisible to it, and so is one whose emptiness depends on a
 *     callee. The rule narrows the hole; it does not close it.
 *   * Attribution is per-READ, from the binding at the site, and a
 *     `Promise.all` element is matched POSITIONALLY to the name it was
 *     destructured into. Where the position cannot be determined — a `.map`
 *     normaliser, a slice, a spread — the guard attributes NOTHING rather than
 *     everything, so a site it cannot follow goes unjudged rather than
 *     misjudged. `compass/CompassProfileService.ts` is such a site today.
 *   * One escape hatch, and it must carry a reason:
 *
 *         // block-read-ok: <why this site is correct as written>
 *
 *     It is a DIFFERENT token from the siblings' `resolves-not-throws-ok` on
 *     purpose: a waiver of "the error may be dropped" must not silently also
 *     waive "the block list may be assumed empty".
 *
 * ── WHERE THIS IS ENFORCED ──────────────────────────────────────────────────
 * In `pnpm test`, via `src/test/blockListFailOpenGuard.test.ts`, which runs in
 * ci.yml's `api-server-tests` job (`needs: preflight`, no `environment:`, no
 * secrets). NOT in `check:all`: that is only reached through live-db.yml, the
 * credentialed tier that goes missing from a rollup when runs are cancelled or
 * slot-starved, and NOT in unwired-checks.yml's probation tier. This guard
 * reads .ts files off disk and needs no database, so it has no business in a
 * tier a database can starve — the same move the silent-write guard's
 * enforcement cases document.
 *
 * Run: node --import tsx/esm src/scripts/checkBlockListFailOpen.ts
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { sanitize, matchBrace, matchParen, lineOf, compareToBaseline } from "./lib/supabaseCallScan.js";

const __dir = dirname(fileURLToPath(import.meta.url));

/** Scan root. The env seam exists for the mutation fixtures; nothing in CI sets it. */
export const SRC_ROOT = process.env.BLOCK_FAIL_OPEN_SRC_ROOT
  ? resolve(process.env.BLOCK_FAIL_OPEN_SRC_ROOT)
  : resolve(__dir, "..");

export const BASELINE_PATH = process.env.BLOCK_FAIL_OPEN_BASELINE
  ? resolve(process.env.BLOCK_FAIL_OPEN_BASELINE)
  : resolve(__dir, "../../scripts/BLOCK_LIST_FAIL_OPEN_BASELINE.json");

/** The table. Established from src/migrations/0015_blocks.sql — see the header. */
export const BLOCKS_TABLE = "blocks";

/**
 * The only modules that may read `blocks` directly (R1).
 *
 *   lib/blocks.ts       `fetchBlockedSet` — the `Set | null` form, honoured by
 *                       `submitterIsVisible`.
 *   lib/blockGuard.ts   `isBlockedBetween` — the two-party gate, fail-closed.
 *   lib/exclusionSet.ts `readBlockExclusions` / `readPairExclusion` /
 *                       `readGroupBlockExclusions` — the `ExclusionSet` form,
 *                       whose `isExcluded` makes an unreadable set exclude
 *                       everybody by construction.
 *   routes/blocks.ts    the table's OWNING route. It must reach the table
 *                       directly to write it, and its reads serve the owner
 *                       their own block list rather than deciding a third
 *                       party's visibility. R2 and R3 still judge it.
 */
export const BLOCK_READ_MODULES: readonly string[] = [
  "lib/blocks.ts",
  "lib/blockGuard.ts",
  "lib/exclusionSet.ts",
  "routes/blocks.ts",
];

export const ESCAPE_HATCH = "block-read-ok";

/** Directories whose contents are not product code. */
const SKIP_DIRS = new Set(["test", "__tests__", "node_modules", "migrations"]);
const SKIP_FILES = new Set([
  "database.types.ts",
  // This guard's own pattern literals would self-match.
  "checkBlockListFailOpen.ts",
  // The sibling guards quote the defect shapes in prose and in pattern
  // literals; sanitize() blanks comments but not the literals.
  "checkSilentSupabaseReads.ts",
  "checkSilentSupabaseWrites.ts",
  "checkUncheckedSupabaseReads.ts",
]);

export type Rule = "direct-read" | "three-state" | "error-inert" | "empty-without-proof";

export interface BlockReadFinding {
  file: string;
  /** 1-indexed line of the offending construct. */
  line: number;
  rule: Rule;
  /** Short excerpt, for a reader of the failure message. */
  excerpt: string;
}

export interface ScanResult {
  findings: BlockReadFinding[];
  /** Files opened. */
  filesScanned: number;
  /** `blocks` read chains found — the guard's SUBJECT. */
  readSites: number;
}

// ── Shapes ──────────────────────────────────────────────────────────────────

/**
 * A coercion that turns an absent answer into a confident one. Each of these,
 * applied to a `blocks` answer, yields the PERMISSIVE result on FAILURE.
 */
const COERCIONS: ReadonlyArray<{ re: RegExp; what: string; side: "left" | "right" }> = [
  { re: /\?\?\s*\[\s*\]/g, what: "?? []", side: "left" },
  { re: /\|\|\s*\[\s*\]/g, what: "|| []", side: "left" },
  { re: /\?\?\s*new\s+Set\s*\(/g, what: "?? new Set()", side: "left" },
  { re: /\|\|\s*new\s+Set\s*\(/g, what: "|| new Set()", side: "left" },
  { re: /\?\?\s*0\b/g, what: "?? 0", side: "left" },
  { re: /\|\|\s*0\b/g, what: "|| 0", side: "left" },
  { re: /\?\?\s*false\b/g, what: "?? false", side: "left" },
  { re: /\|\|\s*false\b/g, what: "|| false", side: "left" },
  // The operand of `Boolean(…)` is its ARGUMENT, to the RIGHT. Looking left
  // here is how `return Boolean(data);` — the #469 shape, verbatim — went
  // unseen: the answer's name never appears before the opening paren.
  { re: /\bBoolean\s*\(/g, what: "Boolean(…)", side: "right" },
];

/**
 * R3: emptiness or wholeness concluded from the ABSENCE of an array.
 *
 * `Array.isArray(x) ? x : []` and `if (!Array.isArray(x)) return true;` are the
 * same sentence: "I did not get rows, so there are none". The permitted form
 * hands the question to an exact count instead — `return count === 0;` — which
 * is why the second pattern's consequent is inspected rather than assumed.
 */
const ARRAY_FALLBACK = /Array\s*\.\s*isArray\s*\([^()]*\)\s*\?[^;?]*?:\s*(\[\s*\]|new\s+Set\s*\()/g;
const NEGATED_ARRAY_TEST = /if\s*\(\s*!\s*Array\s*\.\s*isArray\s*\([^()]*\)\s*\)\s*(?:\{\s*)?return\s+([^;]{0,60});/g;
/** Answers that assert emptiness/wholeness rather than deferring to a proof. */
const POSITIVE_ANSWER = /^(?:true|\[\s*\]|new\s+Set\s*\(|0)\b|^\{\s*ok\s*:\s*true/;

/**
 * R2b: an answer that MEANS "nobody is blocked", written in a branch reached
 * because the read FAILED. Either a bare empty literal, or a coalesce whose
 * fallback is one — `profile?.blockedUserIds ?? []` is an empty block list
 * whenever the thing on the left is absent, and nothing at that site knows
 * whether it is.
 */
const PERMISSIVE_EMPTY =
  /^\s*\(?\s*(?:\[\s*\]|new\s+Set\s*\(\s*\)|false|0)\s*\)?\s*$|(?:\?\?|\|\|)\s*(?:\[\s*\]|new\s+Set\s*\(\s*\))/;

/** For `attributable`: the identifiers appearing to the left of a coercion. */
const IDENT = /[A-Za-z_$][\w$]*/g;

// ── Window helpers ──────────────────────────────────────────────────────────

/** The innermost brace block containing `idx`: [open, close]. */
export function enclosingBlock(code: string, idx: number): { start: number; end: number } {
  let depth = 0;
  for (let i = Math.min(idx, code.length - 1); i >= 0; i--) {
    const c = code[i];
    if (c === "}") depth++;
    else if (c === "{") {
      if (depth === 0) {
        const end = matchBrace(code, i);
        return { start: i, end: end === -1 ? code.length : end };
      }
      depth--;
    }
  }
  return { start: 0, end: code.length };
}

/**
 * The STATEMENT containing `idx`, as text: where the read's binding is written.
 *
 * The backward scan is delimiter-aware, and that is not a nicety. A naive
 * "scan back to the previous `;`, `{` or `}`" stops at the destructuring brace
 * of `const { data, error } = await sc.from("blocks")…` — the closing `}` sits
 * between the statement's start and the `.from(` — and returns a statement with
 * no binding in it, so every R2/R3 rule silently found nothing. `(` and `[` at
 * depth zero are stepped OVER rather than stopped at, which is what carries a
 * `Promise.all([ … ])` element back out to the `const [a, b] =` that names it.
 */
export function enclosingStatement(code: string, idx: number): { start: number; end: number } {
  let start = 0;
  let net = 0; // closers seen minus openers matched, scanning backwards
  for (let i = Math.min(idx, code.length - 1); i >= 0; i--) {
    const c = code[i];
    if (c === "}" || c === ")" || c === "]") net++;
    else if (c === "{" || c === "(" || c === "[") {
      if (net === 0) {
        if (c === "{") { start = i + 1; break; } // a block (or object literal) opens here
        continue;                                // inside a call or array: keep going out
      }
      net--;
    } else if (c === ";" && net === 0) { start = i + 1; break; }
  }
  const semi = code.indexOf(";", idx);
  return { start, end: semi === -1 ? code.length : semi };
}

/**
 * Just THIS chain, for deciding read-vs-write: from the site to whichever comes
 * first of the next `;`, the next `.from(` (a sibling element of the same
 * `Promise.all`, whose methods are not this chain's) and a 400-char cap.
 */
function chainTail(code: string, site: number): string {
  const semi = code.indexOf(";", site);
  const next = code.indexOf(".from(", site + 1);
  const ends = [semi, next, site + 400].filter((n) => n > site);
  return code.slice(site, Math.min(...ends));
}

/**
 * Which element of the array literal directly containing `site` that site is,
 * counting top-level commas. `null` when the site is not inside an array
 * literal that opens after `afterLhs` (so a destructure's own brackets, and any
 * array written before the `=`, cannot be mistaken for the results array).
 */
export function elementIndex(code: string, site: number, afterLhs: number): number | null {
  // The innermost `[` the site sits inside, found with the same
  // delimiter-aware backward walk `enclosingStatement` uses — `(` at depth zero
  // is stepped OVER, which is what reaches the array through a wrapper call.
  // PR #530 replaces `sc.from("blocks")…` with `wholeListResult(() =>
  // sc.from("blocks")…)` at several of these sites; stopping at the wrapper's
  // own paren would have made those reads unattributable, so the guard would
  // have gone quiet on them and its baseline entry would have read as fixed.
  // Quiet is not clean.
  let net = 0;
  let open = -1;
  for (let i = site; i >= 0; i--) {
    const c = code[i];
    if (c === "}" || c === ")" || c === "]") net++;
    else if (c === "{" || c === "(" || c === "[") {
      if (net === 0) {
        if (c === "[") { open = i; break; }
        if (c === "{") break;
        continue;
      }
      net--;
    } else if (c === ";" && net === 0) break;
  }
  if (open < afterLhs) return null;
  let depth = 0;
  let idx = 0;
  for (let i = open + 1; i < site; i++) {
    const c = code[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) idx++;
  }
  return idx;
}

/**
 * What the read's answer and its failure are CALLED at this site.
 *
 * This is what makes R2 precise rather than a window-wide grep. A route handler
 * body holds a dozen unrelated `?? []`s; only the ones applied to THIS read's
 * answer are this guard's business, and only this read's error counts as having
 * consulted this read's failure.
 *
 *   `const { data, error } = await sc.from("blocks")…`   answer `data`,  failure `error`
 *   `const { data: rows, error: e } = await …`           answer `rows`,  failure `e`
 *   `const [a, b] = await Promise.all([…blocks…])`        answer `a`/`b`, failure `a.error`
 *   `const r = await sc.from("blocks")…`                 answer `r`,     failure `r.error`
 */
export interface SiteBinding {
  /** Identifiers a coercion must mention to be attributable to this read. */
  answerNames: string[];
  /** Local names bound to the read's `error`, if the site destructured one. */
  errorNames: string[];
  /** Names whose `.error` member access counts as consulting the failure. */
  memberNames: string[];
  /**
   * Absolute offset just past the binding's `=`. Mentions of a bound name
   * BEFORE this are the binding writing the name down, not code using it.
   */
  lhsEnd: number;
}

export function bindingAt(code: string, site: number): SiteBinding {
  const { start, end } = enclosingStatement(code, site);
  const stmt = code.slice(start, end);
  const answerNames: string[] = [];
  const errorNames: string[] = [];
  const memberNames: string[] = [];
  let lhsEnd = start;

  // `{ data, error, count }` — a destructure, possibly a reassignment `({…} = await …)`.
  const obj = /\{([^{}]*)\}\s*=/.exec(stmt);
  if (obj) {
    lhsEnd = start + obj.index + obj[0].length;
    for (const part of obj[1].split(",")) {
      const kv = /^\s*([A-Za-z_$][\w$]*)\s*(?::\s*([A-Za-z_$][\w$]*))?\s*$/.exec(part);
      if (!kv) continue;
      const key = kv[1];
      const local = kv[2] ?? kv[1];
      if (key === "data" || key === "count") answerNames.push(local);
      else if (key === "error") errorNames.push(local);
    }
    if (answerNames.length > 0 || errorNames.length > 0) return { answerNames, errorNames, memberNames, lhsEnd };
  }

  // `[a, b] = await Promise.all([…])` — POSITIONAL results, errors read as
  // members. The position matters and is computed, not approximated: a batch
  // over five tables destructures five names, and attributing all five to the
  // one `blocks` element made this guard report `user_account_states` and
  // `circle_presence` coercions as fail-open block reads. A guard that blames
  // the wrong table is a guard people stop believing.
  const arr = /\[([^\]\[]*)\]\s*=/.exec(stmt);
  if (arr) {
    lhsEnd = start + arr.index + arr[0].length;
    const names = arr[1]
      .split(",")
      .map((part) => /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(part)?.[1] ?? null);
    const pos = elementIndex(code, site, start + arr.index + arr[0].length);
    const mine = pos !== null ? names[pos] ?? null : null;
    if (mine) return { answerNames: [mine], errorNames, memberNames: [mine], lhsEnd };
    // Position not determinable (an intervening `.map` normaliser, a slice, a
    // spread): attribute NOTHING rather than everything. A false negative here
    // is a site this guard does not judge; a false positive is a site it
    // misjudges, and only one of those degrades gracefully.
    return { answerNames: [], errorNames, memberNames: [], lhsEnd };
  }

  // `const r = await …` / `const r = sc.from("blocks")…`
  const one = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=/.exec(stmt);
  if (one) {
    lhsEnd = start + one.index + one[0].length;
    answerNames.push(one[1]);
    memberNames.push(one[1]);
  }
  return { answerNames, errorNames, memberNames, lhsEnd };
}

/** Regex-source alternatives that name THIS read's error, for R2b. */
export function errorRefSources(b: SiteBinding): string[] {
  const alts: string[] = [];
  for (const n of b.errorNames) alts.push(`\\b${n}\\b`);
  for (const n of b.memberNames) {
    alts.push(`\\b${n}\\b(?:\\s+as\\s+[\\w.<>\\[\\]|]+)?\\s*\\)?\\s*\\??\\s*\\.\\s*error\\b`);
  }
  return alts;
}

/**
 * Offset of the first place in `window` where THIS read's failure is consulted,
 * or Infinity if nowhere.
 *
 * Deliberately syntactic — see the header's LIMITS. A binding's own
 * `{ data, error }` is excluded, so writing the word down and never using it is
 * not evidence; the first USE is what a coercion must come after.
 */
export function firstErrorConsultation(window: string, b: SiteBinding, windowStart = 0): number {
  let best = Number.POSITIVE_INFINITY;
  const past = (at: number) => windowStart + at >= b.lhsEnd; // not the binding itself

  if (b.errorNames.length > 0) {
    const re = new RegExp(`\\b(?:${b.errorNames.join("|")})\\b`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(window)) !== null) {
      if (!past(m.index)) continue;
      const after = window.slice(m.index + m[0].length, m.index + m[0].length + 2);
      const before = window.slice(Math.max(0, m.index - 2), m.index);
      if (/^\s*\(/.test(after) && /\.\s*$/.test(before)) continue; // `log.error(…)`, the logger
      best = Math.min(best, m.index);
      break;
    }
  }

  for (const n of b.memberNames) {
    // `r.error`, `r?.error`, `(r as any).error` — the member form, with room for a cast.
    const member = new RegExp(`\\b${n}\\b(?:\\s+as\\s+[\\w.<>\\[\\]|]+)?\\s*\\)?\\s*\\??\\s*\\.\\s*error\\b`, "g");
    let m: RegExpExecArray | null;
    while ((m = member.exec(window)) !== null) {
      if (!past(m.index)) continue;
      best = Math.min(best, m.index);
      break;
    }
    // THE WHOLE RESULT HANDED TO SOMETHING ELSE. `failedModerationReads([…,
    // ["blockCount", blocksRes], …])` consults the error without ever writing
    // `.error`: the `{ data, error }` object went with it. A bare mention —
    // the name not followed by `.`, `?.` or `[` — is that shape, and counting
    // it is what keeps routes/admin.ts off a debt ledger it does not belong on.
    // The cost is stated plainly: a site that passes its result onward and is
    // mishandled by the CALLEE is beyond a text-level guard either way.
    const bare = new RegExp(`\\b${n}\\b(?!\\s*(?:\\.|\\?\\.|\\[))`, "g");
    while ((m = bare.exec(window)) !== null) {
      if (!past(m.index)) continue;
      best = Math.min(best, m.index);
      break;
    }
  }
  return best;
}

// ── The scanner ─────────────────────────────────────────────────────────────

/** Is `rel` one of the modules allowed to read `blocks` directly? */
export function isSanctionedModule(rel: string): boolean {
  const norm = rel.split("\\").join("/");
  return BLOCK_READ_MODULES.some((m) => norm === m || norm.endsWith(`/${m}`));
}

/**
 * Every `blocks` READ chain: the offset of a `.from("blocks")` whose chain, to
 * the end of its statement, selects rather than writes.
 *
 * The table name is matched in the ORIGINAL text and the CHAIN in the sanitized
 * copy, which is not a detail: `sanitize` blanks string CONTENTS, so
 * `.from("blocks")` reads as `.from("      ")` in the sanitized copy and a
 * scanner that looked there found nothing at all and said the tree was clean.
 * That is the vacuity this guard refuses, met while writing the guard. A match
 * whose `.from(` did NOT survive sanitisation was inside a comment — prose
 * about the defect, of which this tree has a great deal — and is skipped.
 */
export function blockReadSites(src: string, code: string = sanitize(src)): number[] {
  const out: number[] = [];
  const re = new RegExp(`\\.\\s*from\\s*\\(\\s*(["'\`])${BLOCKS_TABLE}\\1\\s*\\)`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    if (!/^\.\s*from\s*\(/.test(code.slice(m.index, m.index + m[0].length))) continue; // comment
    const tail = chainTail(code, m.index);
    if (/\.\s*(?:insert|update|upsert|delete)\s*\(/.test(tail)) continue;
    if (!/\.\s*(?:select|rpc)\s*\(/.test(tail)) continue;
    out.push(m.index);
  }
  return out;
}

/**
 * The coercion's OPERAND, as text.
 *
 * Narrow on purpose. Reading a flat 90 characters to the left attributed
 * `muteCount: mutesRes.count ?? 0` to the `blocks` read on the line above it,
 * which is a guard blaming the wrong table. The operand ends at the nearest
 * enclosing delimiter — and for `Boolean(…)` it is the ARGUMENT, so the scan
 * runs forward to the matching paren instead.
 */
export function operandOf(window: string, at: number, side: "left" | "right"): string {
  if (side === "right") {
    const open = window.indexOf("(", at);
    if (open === -1) return "";
    const close = matchParen(window, open);
    return window.slice(open, close === -1 ? Math.min(window.length, at + 90) : close + 1);
  }
  const left = window.slice(Math.max(0, at - 160), at);
  const cut = Math.max(...[",", ";", "(", ")", "{", "}", "[", "]", "\n", ":"].map((d) => left.lastIndexOf(d)));
  return cut === -1 ? left : left.slice(cut + 1);
}

/**
 * Identifiers that are the ROOT of an expression — not a property of something
 * else. `out?.data` roots at `out`, and `data` in it is a PROPERTY.
 *
 * This distinction is load-bearing and it was found the hard way. The bodies of
 * `lib/exclusionSet.ts` hold one read bound as `const { data, error } = …` at
 * function level and another bound as `const [out, inb] = …` inside an `if`;
 * the function-level window contains both, and `out?.data` tokenizes to include
 * `data`, so the second read's correct, error-checked coalesce was reported as
 * the first read's fail-open. A guard that reports a correct site is a guard
 * that gets a baseline entry it can never burn down.
 */
export function rootIdents(text: string): Set<string> {
  const roots = new Set<string>();
  IDENT.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IDENT.exec(text)) !== null) {
    const before = text.slice(0, m.index).replace(/\s+$/, "");
    if (before.endsWith(".")) continue; // a property, not a root
    roots.add(m[0]);
  }
  return roots;
}

/** Does the coercion's operand name this read's answer (and not its error)? */
function attributable(
  window: string,
  at: number,
  b: SiteBinding,
  side: "left" | "right" = "left",
): boolean {
  if (b.answerNames.length === 0) return false;
  const text = operandOf(window, at, side);
  // `Boolean((blocksRes as any).error)` is the error being CONSULTED, not the
  // answer being flattened. Coercing an error is never this guard's finding.
  if (/\.\s*error\b/.test(text) || b.errorNames.some((n) => new RegExp(`\\b${n}\\b`).test(text))) return false;
  const roots = rootIdents(text);
  return b.answerNames.some((n) => roots.has(n));
}

/**
 * THE DECISION, for one file. Pure: source text in, findings out.
 *
 * Exported and driven directly by the test suite. A guard whose helper is
 * correct while the script never calls it has shipped here twice; so the test
 * drives THIS, and `decide()` below, and the real tree through `scanTree()`.
 */
export function findBlockListFailOpen(src: string, file: string): BlockReadFinding[] {
  const code = sanitize(src);
  const found: BlockReadFinding[] = [];
  const sites = blockReadSites(src, code);

  const waived = (at: number) =>
    src.slice(Math.max(0, at - 400), Math.min(src.length, at + 200)).includes(ESCAPE_HATCH);

  // ── R1: the read is written somewhere it may not be ───────────────────────
  if (!isSanctionedModule(file)) {
    for (const at of sites) {
      if (waived(at)) continue;
      found.push({
        file,
        line: lineOf(src, at),
        rule: "direct-read",
        // From the ORIGINAL text: the sanitized copy has the table and column
        // names blanked, which makes every excerpt read `.from(" ").select(" ")`.
        excerpt: src.slice(at, at + 72).replace(/\s+/g, " ").trim(),
      });
    }
  }

  // ── R2 + R3a: judged per read site, everywhere ────────────────────────────
  const reported = new Set<number>();
  for (const at of sites) {
    const { start, end } = enclosingBlock(code, at);
    const window = code.slice(start, end);
    const b = bindingAt(code, at);
    const errAt = firstErrorConsultation(window, b, start);

    // R2 — a coercion of THIS read's answer that precedes any look at the failure.
    for (const { re, what, side } of COERCIONS) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(window)) !== null) {
        if (m.index >= errAt) continue;                        // the failure was consulted first
        if (!attributable(window, m.index, b, side)) continue;
        const abs = start + m.index;
        if (waived(abs) || reported.has(abs)) continue;
        reported.add(abs);
        found.push({
          file,
          line: lineOf(src, abs),
          rule: "three-state",
          excerpt:
            `\`${what}\` flattens the blocks answer ` +
            (errAt === Number.POSITIVE_INFINITY
              ? "and its error is never consulted"
              : "before its error is consulted"),
        });
      }
    }

    // R2b — ERROR-INERT: the failure IS consulted, and the branch it leads to
    // answers with the same emptiness an unread list would. This is the class
    // `checkUncheckedSupabaseReads` names in its own header as one it cannot
    // see ("the error is observed, the guard passes, and an unreadable
    // restrictions table still reports NOT RESTRICTED"), together with the
    // observation that scoped to an EXCLUSION table the direction needs no
    // judgement: a row means DENY, so a permissive error branch is fail-open
    // with nothing to argue about. Scoped to `blocks`, that is this guard.
    for (const alt of errorRefSources(b)) {
      for (const shape of [
        new RegExp(`${alt}\\s*\\?([^:;]{0,120}):`, "g"),                            // err ? <answer> : …
        new RegExp(`if\\s*\\(\\s*${alt}\\s*\\)\\s*\\{?\\s*return\\s+([^;]{0,80});`, "g"), // if (err) return <answer>;
      ]) {
        let em: RegExpExecArray | null;
        while ((em = shape.exec(window)) !== null) {
          if (!PERMISSIVE_EMPTY.test(em[1])) continue;
          const abs = start + em.index;
          if (waived(abs) || reported.has(abs)) continue;
          reported.add(abs);
          found.push({
            file,
            line: lineOf(src, abs),
            rule: "error-inert",
            excerpt: `the FAILURE branch answers \`${em[1].trim()}\` — an empty block list from a read that did not answer`,
          });
        }
      }
    }

    // R3a — `Array.isArray(x) ? x : []` on this read's answer.
    ARRAY_FALLBACK.lastIndex = 0;
    let fm: RegExpExecArray | null;
    while ((fm = ARRAY_FALLBACK.exec(window)) !== null) {
      // Attributed from the MATCH, whose own text holds the value being
      // defaulted: `Array.isArray(rows) ? rows : []` names `rows` twice and
      // nothing to its left names it at all.
      if (!b.answerNames.some((n) => rootIdents(fm![0]).has(n))) continue;
      const abs = start + fm.index;
      if (waived(abs) || reported.has(abs)) continue;
      reported.add(abs);
      found.push({
        file,
        line: lineOf(src, abs),
        rule: "empty-without-proof",
        excerpt: "a non-array blocks answer becomes an empty collection",
      });
    }
  }

  // ── R3b — a wholeness/emptiness PREDICATE that answers from a non-array ───
  // #530's defect exactly: `if (!Array.isArray(data)) return true;` scored an
  // unread answer as whole, so an unreadable block list became an empty block
  // set and a blocked user was served as a tag suggestion. Judged file-wide
  // (not per window) because the predicate is declared BESIDE the read, not
  // inside it, and only in files that read `blocks` — the same table scoping
  // that keeps R1 and R2 about this path and not about every list in the tree.
  if (sites.length > 0) {
    NEGATED_ARRAY_TEST.lastIndex = 0;
    let nm: RegExpExecArray | null;
    while ((nm = NEGATED_ARRAY_TEST.exec(code)) !== null) {
      const answer = nm[1].trim();
      if (!POSITIVE_ANSWER.test(answer)) continue; // defers to a proof, e.g. `count === 0`
      if (waived(nm.index)) continue;
      found.push({
        file,
        line: lineOf(src, nm.index),
        rule: "empty-without-proof",
        excerpt: `a non-array answer is reported as \`${answer}\` — absence of data is not proof of emptiness`,
      });
    }
  }

  return found;
}

// ── Tree walk ───────────────────────────────────────────────────────────────

export function scanTree(root: string = SRC_ROOT): ScanResult {
  const findings: BlockReadFinding[] = [];
  let filesScanned = 0;
  let readSites = 0;
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        walk(p);
      } else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !SKIP_FILES.has(name)) {
        const rel = relative(root, p).split("\\").join("/");
        const src = readFileSync(p, "utf8");
        filesScanned++;
        readSites += blockReadSites(src).length;
        findings.push(...findBlockListFailOpen(src, rel));
      }
    }
  };
  walk(root);
  return { findings, filesScanned, readSites };
}

// ── Vacuity refusal ─────────────────────────────────────────────────────────
/**
 * A guard whose subject has vanished must FAIL, not report success.
 *
 * This repo has been bitten by exactly that, repeatedly: a scan that stops
 * seeing files prints the same clean line it prints when there is nothing
 * wrong, and `newViolations: []` passes trivially. So the floors below are
 * asserted on every run. They are SHRINK-ONLY in the sense that matters: they
 * may be RAISED as the tree grows, and lowering one is a claim that the
 * subject really did shrink, which belongs in a PR description.
 *
 * Measured on origin/main @ f71cfb85f: 1,307 files scanned, 72 `blocks` read
 * chains. The floors sit below those with room for ordinary deletion but far
 * above a collapsed walk.
 */
export const MIN_FILES_SCANNED = 1000;
export const MIN_READ_SITES = 50;

export interface Verdict {
  ok: boolean;
  /** Fatal reasons, each printed. Empty when ok. */
  problems: string[];
  newViolations: BlockReadFinding[];
  staleEntries: Array<{ file: string; baselined: number; found: number }>;
}

/** Baseline key: `<file>::<rule>`, so fixing one rule cannot pay for another. */
export const keyOf = (f: BlockReadFinding): string => `${f.file}::${f.rule}`;

/**
 * THE DECISION, for the whole run. Pure: a scan result and a baseline in, a
 * verdict out. The CLI below is a thin printer over this, and the test drives
 * THIS rather than the printer — a guard whose helper is right while the script
 * never consults it is the mistake that shipped on this path twice.
 *
 * The baseline is a TWO-SIDED shrink-only ratchet, exactly like
 * SILENT_SUPABASE_WRITES_BASELINE.json: above the count is a NEW violation and
 * fails; BELOW it is a STALE entry and also fails, because a count left high
 * after a site is fixed re-admits the defect for free. There is no amnesty
 * mechanism and deliberately so — see the baseline file's `__notes` for why one
 * was considered for PR #530 and then found unnecessary.
 */
export function decide(scan: ScanResult, baseline: Record<string, number>): Verdict {
  const problems: string[] = [];

  // Vacuity FIRST: every assertion below is meaningless if nothing was read.
  if (scan.filesScanned < MIN_FILES_SCANNED) {
    problems.push(
      `VACUOUS SCAN: ${scan.filesScanned} file(s) scanned, floor ${MIN_FILES_SCANNED}. A guard whose ` +
        `subject vanished must not pass green — this is a broken walk or a moved tree, not a clean repository.`,
    );
  }
  if (scan.readSites < MIN_READ_SITES) {
    problems.push(
      `VACUOUS SCAN: ${scan.readSites} \`${BLOCKS_TABLE}\` read chain(s) found, floor ${MIN_READ_SITES}. ` +
        `The block-list read path cannot have disappeared; the scanner has stopped recognising it.`,
    );
  }

  const { newViolations, staleEntries } = compareToBaseline(scan.findings, baseline, keyOf);

  if (newViolations.length > 0) {
    problems.push(
      `${newViolations.length} NEW fail-open block-list read(s). \`${BLOCKS_TABLE}\` is an EXCLUSION table: a ` +
        `ROW means DENY, so EMPTINESS means ALLOW, and a read that failed coerces to the PERMISSIVE answer.`,
    );
  }
  if (staleEntries.length > 0) {
    problems.push(
      `${staleEntries.length} STALE baseline entr(ies) — a site was fixed without lowering its count. The ` +
        `ratchet is shrink-only; leaving the count high re-admits the defect.`,
    );
  }

  return { ok: problems.length === 0, problems, newViolations, staleEntries };
}

export function readBaseline(path: string = BASELINE_PATH): Record<string, number> {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, number>;
  } catch {
    return {}; // no baseline — every finding is new
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const scan = scanTree();
  const verdict = decide(scan, readBaseline());
  const baselined = scan.findings.length - verdict.newViolations.length;

  if (verdict.ok) {
    console.log(
      `✅ check-block-list-fail-open: no NEW fail-open \`${BLOCKS_TABLE}\` read across ` +
        `${scan.filesScanned} files and ${scan.readSites} read chains` +
        (baselined > 0 ? ` (${baselined} pre-existing site(s) baselined for burn-down).` : "."),
    );
    process.exit(0);
  }

  console.error(`\n✘ check-block-list-fail-open\n`);
  for (const p of verdict.problems) console.error(`  • ${p}`);
  if (verdict.newViolations.length > 0) {
    console.error(
      `\nR1 direct-read         — read \`${BLOCKS_TABLE}\` only from: ${BLOCK_READ_MODULES.join(", ")}.` +
        `\nR2 three-state         — consult the error BEFORE flattening the answer; FAILURE is not SUCCESS_EMPTY.` +
        `\nR3 empty-without-proof — conclude emptiness only from an actual empty array or an exact count of zero.` +
        `\nWaiver (needs a reason): // ${ESCAPE_HATCH}: <why this site is correct as written>\n`,
    );
    for (const v of verdict.newViolations) {
      console.error(`  ${v.file}:${v.line}  [${v.rule}]  ${v.excerpt}`);
    }
  }
  if (verdict.staleEntries.length > 0) {
    console.error(`\nstale baseline entries (lower the count in ${relative(process.cwd(), BASELINE_PATH)}):`);
    for (const s of verdict.staleEntries) {
      console.error(`  ${s.file}: baselined ${s.baselined}, found ${s.found}`);
    }
  }
  process.exit(1);
}
