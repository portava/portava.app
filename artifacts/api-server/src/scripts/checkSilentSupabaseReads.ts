/**
 * check-silent-supabase-reads — no supabase READ may turn a database failure
 * into confident product state.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * supabase-js RESOLVES `{ data, error }`; it does not throw. Everything follows
 * from that one fact:
 *
 *   * A `try/catch` wrapped around a read never runs for the DB failure it
 *     appears to handle. The code READS as handled and the failure is already
 *     gone by the time control reaches the catch.
 *   * `data ?? []` / `?? 0` / `?? false` then converts `data: null` — which on
 *     a failure means "we could not find out" — into a positive claim: an empty
 *     list, a zero, a "no".
 *
 * That is not a hypothetical. Each of these shipped, and each was found by
 * reading code rather than by a test:
 *
 *   * a trust score of 50.00 presented as measured, computed from a read that
 *     had failed;
 *   * "you're all caught up" shown to a user whose follow graph could not be
 *     read at all;
 *   * a safety hazard suppressed because the hazard query errored and the
 *     empty result read as "no hazards";
 *   * a journey rated safe that had never been measured;
 *   * privacy settings reset to public — and then PERSISTED at that value;
 *   * curated airport buffers overwritten by an empty read.
 *
 * The through-line is not "the read failed". It is that the failure became
 * INDISTINGUISHABLE from a real, benign answer, and then the product spoke with
 * confidence. This guard demands only that the two be distinguishable: bind the
 * `error` and look at it, or say in writing why silence is correct here.
 *
 * ── THE FOUR SHAPES, IN DESCENDING CONFIDENCE ───────────────────────────────
 * S1  ORPHANED ERROR BINDING. `const { data, error } = await sc.from(…)
 *     .select(…)` where `error` is never referenced again in its block. The
 *     highest-confidence shape in the whole guard: the author wrote down the
 *     intention to check and then did not. There is no reading of this that is
 *     deliberate.
 *
 * S2  DEAD CATCH AROUND A CONSEQUENTIAL READ. The write guard's try/catch shape
 *     with the call widened to `.select/.single/.maybeSingle/.rpc`, PLUS the
 *     mandatory extra condition that NO `error` identifier is bound anywhere in
 *     the (nested-try-stripped) try body. That extra condition is load-bearing:
 *     without it this shape buries `lib/mediaAccess.ts`, whose branch-3a-to-3f
 *     comment-only catches each sit under a read that binds its error and hands
 *     it to `noteLookupFailure`. Those catches are honest; flagging them would
 *     teach people the guard is wrong. Branch 3g is the one that does NOT bind
 *     its error, and the guard reports it — a real finding, baselined here
 *     rather than fixed, because this PR is the guard and nothing else.
 *
 * S3  DANGLING `.then`. A read chain whose `.then` FULFILMENT callback consumes
 *     `data` — `({ data }) => …`, `(r) => r.data` — and never looks at `error`.
 *     A `.catch(…)` tail does NOT exempt it and neither does a second `.then`
 *     argument: both are rejection handlers, and a PostgREST failure does not
 *     reject. It resolves, carrying the `error` this callback just dropped.
 *     That is the whole point of the defect class, and the one place a
 *     "there's a catch, it's handled" reading is most tempting and most wrong.
 *     The shape was added for the client tree, which has essentially no
 *     try/catch for S2 to hang on; every site it finds today happens to be on
 *     the server side, where the same idiom also appears.
 *
 * S4  CONSEQUENCE-GATED COALESCE. `data ?? []` / `?? 0` / `?? false` on a read
 *     that binds no error AND whose table is on the CONSEQUENTIAL_TABLES list
 *     below. This shape is deliberately TABLE-GATED. Ungated it matches many
 *     hundreds of sites tree-wide, most of them genuinely fail-soft display
 *     code, and a report that size is one people learn to scroll past. A guard
 *     nobody reads is worse than no guard: it launders the defect class as
 *     "known".
 *
 * ── WHAT IT DOES NOT DEMAND ─────────────────────────────────────────────────
 * Not that the read be fatal. Not that failure propagate to the caller. Only
 * that the failure be OBSERVABLE — bound, and then logged, branched on, or
 * turned into a distinct sentinel. Fail-soft is a legitimate design; fail-soft
 * that cannot tell you it happened is not.
 *
 * For a genuinely intentional silence, say so:
 *
 *      // resolves-not-throws-ok: <why silence is the intended behavior>
 *
 * The token is IDENTICAL to the write guard's, so one grep finds every waiver
 * of this defect class across both. Unlike the write guard, a reason after the
 * colon is REQUIRED here — a bare token is a waiver nobody can review, and this
 * guard reports it as such rather than honouring it.
 *
 * ── LIMITS, STATED RATHER THAN IMPLIED ──────────────────────────────────────
 *   * Text-level, not type-level, and not data-flow. It keys on `.select(`,
 *     `.single(`, `.maybeSingle(` and `.rpc(` in source text. A read reached
 *     through a helper is invisible here (the helper's own body is scanned
 *     instead), and so is a chain built across several statements.
 *   * "Bound an error" is not "handled the error". S1 proves only that the
 *     identifier is mentioned again somewhere in its block; S2 and S4 treat any
 *     error binding in scope as compliance. `if (error) {}` satisfies all
 *     three. This guard measures whether the EVIDENCE was kept, not whether the
 *     conclusion drawn from it was right. That judgement is a code review's.
 *   * S1's "never referenced again" is scoped by brace matching to the
 *     innermost enclosing block, and a reference means a USE — `logger.error`
 *     and `{ error: "db_error" }` do not count, or the shape could never fire
 *     in a codebase where that word appears on every third line. The
 *     `({ data, error } = await …)` REASSIGNMENT idiom (the profiles
 *     fallback-select in routes/profile.ts and routes/passport.ts) writes to an
 *     outer `let` whose check lives outside the block, so S1 declines to judge
 *     it rather than reporting it wrongly.
 *   * S1's baseline is EMPTY, and that is a real measurement, not a stub: on
 *     this tree there is currently no orphaned error binding on a read. The
 *     shape ships anyway, because its job is to stop the first one.
 *   * S4's table list is a NAMED SET, with exactly the blind spot that implies:
 *     a consequential read of a table nobody added here is invisible. Its seed
 *     is the seven gate tables from `src/test/silentSchemaErrorCatches.test.ts`;
 *     the rest were added from the six shipped incidents above. S4 also needs a
 *     DESTRUCTURED `data` binding to follow — `(await sc.from(…).select()).data
 *     ?? []`, with no destructure at all, is not seen.
 *   * An awaited call inside a NESTED try with its own catch does not implicate
 *     the outer catch (inherited from the write guard).
 *   * It cannot see whether an empty result fails OPEN or fails CLOSED. Failing
 *     closed on an unreadable gate is correct and this guard would still flag a
 *     site that does it silently — because "correct today, and nobody will know
 *     when it stops being correct" is the state this exists to end.
 *
 * ── DELIBERATELY NOT DUPLICATED ─────────────────────────────────────────────
 * `src/test/silentSchemaErrorCatches.test.ts` already guards a NARROWER read
 * case: a gate-table read that is BOTH inside a comment-only catch AND discards
 * its error, with per-site written justifications. That file is not modified
 * and not replaced. Its seven-table set is folded in here as S4's seed, and the
 * two overlap only where a gate-table read is both catch-swallowed and
 * coalesced. Where they overlap, they agree.
 *
 * Static, so it needs no database and runs on every push.
 * Run: node --import tsx/esm src/scripts/checkSilentSupabaseReads.ts
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { resolve, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  sanitize,
  matchBrace,
  matchParen,
  stripNestedTry,
  lineOf,
  compareToBaseline,
} from "./lib/supabaseCallScan.js";

const __dir = dirname(fileURLToPath(import.meta.url));
/** <repo>/artifacts/api-server/src/scripts → <repo> */
const REPO_ROOT = resolve(__dir, "../../../..");

/**
 * Trees scanned, repo-root-relative. The server is the bulk of it; the client
 * trees are here because S3 exists for them — the same defect, in a tree with
 * no try/catch to hang S2 on.
 */
export const SCAN_ROOTS = ["artifacts/api-server/src", "app", "src", "lib"];

/** Test trees and generated types are exempt (fakes legitimately swallow). */
const SKIP_DIRS = new Set(["test", "__tests__", "node_modules", "dist", "build"]);
const SKIP_FILES = new Set([
  "database.types.ts",
  // Self-reference: these three carry the pattern literals this guard scans for.
  "checkSilentSupabaseReads.ts",
  "checkSilentSupabaseWrites.ts",
  "supabaseCallScan.ts",
]);

export const ESCAPE_HATCH = "resolves-not-throws-ok";
/** A waiver must carry a reason. A bare token is a waiver nobody can review. */
const HATCH_WITH_REASON = new RegExp(`${ESCAPE_HATCH}\\s*:\\s*\\S`);
const HATCH_ANY = new RegExp(ESCAPE_HATCH);

/**
 * Tables where an unreadable result is not a missing label but a changed
 * outcome. Seeded verbatim from GATE_TABLES in
 * `src/test/silentSchemaErrorCatches.test.ts` — reads that decide who may see
 * what. Adding a table here tightens S4; nothing else changes.
 */
export const CONSEQUENTIAL_TABLES = new Set([
  // ── Seed: GATE_TABLES from src/test/silentSchemaErrorCatches.test.ts.
  // Reads that decide who may see what. An empty result does not lose a label;
  // it opens or closes a gate.
  "blocks",
  "user_mutes",
  "post_hides",
  "close_friends",
  "profile_privacy_settings",
  "user_account_states",
  "message_thread_members",
  // ── Added here: the tables behind the six shipped incidents in the header.
  // Each is a table where `?? []` / `?? 0` / `?? false` states a fact about the
  // user rather than omitting a decoration.
  "user_privacy_settings", // privacy settings reset to public — and persisted
  "trust_profiles", // the fabricated 50.00 "measured" trust score
  "trust_events",
  "trust_restrictions",
  "trust_caps",
  "user_follows", // "you're all caught up" on an unreadable follow graph
  "user_friendships",
  "friend_requests",
  "rent_buddy_safety_checkins", // a suppressed safety hazard
  "rent_buddy_safety_events",
  "airport_profiles", // curated airport buffers overwritten by an empty read
]);

/** The read half of the resolves-not-throws surface. */
const SUPA_READ = /\.(select|single|maybeSingle|rpc)\s*\(/;
// `[^;]*?` (not `[\s\S]*?`) so the await and the read must be the SAME
// statement — a supabase chain spans many lines but never a semicolon.
// Unbounded, an `await` at the top of a long try body pairs with any `.select(`
// below it, including one that is not supabase at all.
const AWAIT_SUPA_READ = /\bawait\b[^;]*?\.(select|single|maybeSingle|rpc)\s*\(/;

export type Shape = "S1" | "S2" | "S3" | "S4";

export interface SilentRead {
  file: string;
  /** 1-indexed line of the offending site. */
  line: number;
  shape: Shape;
  /** Short excerpt of the site, for the report. */
  detail: string;
}

// ── Small text helpers ───────────────────────────────────────────────────────

/**
 * An `error` binding anywhere in `text`: `{ error }`, `{ data, error }`,
 * `{ error: assetErr }`, or a declaration whose name reads as an error
 * (`const pmErr = …`). Case-sensitive on the bare word so `new Error(…)` — a
 * throw, not an observation of a resolved `{ error }` — does not count.
 */
export function bindsError(text: string): boolean {
  // A DESTRUCTURING pattern that binds error, shorthand or aliased, plain or
  // inside an array pattern: `{ data, error } =`, `{ data: a, error: e } =`,
  // `[{ data, error }] =`. The trailing `=` is what separates a BINDING from an
  // object LITERAL — `res.json({ error: "db_error" })` mentions the word and
  // observes nothing, and treating it as compliance would exempt the very
  // handlers this guard exists for.
  if (/\{[^{}]*\berror\b[^{}]*\}[\]\s]*=(?!=)/.test(text)) return true;
  if (/\b(?:const|let|var)\s+[A-Za-z_$][\w$]*[eE]rr[\w$]*\b/.test(text)) return true;
  // `.error` READ off a result object (`const res = await …; if (res.error)`).
  // The negative lookahead keeps `logger.error(…)` / `console.error(…)` out:
  // a method named error is a log call, not an observation of a resolved one.
  if (/\.\s*error\b(?!\s*\()/.test(text)) return true;
  return false;
}

/** Names bound to the resolved `error` field by a destructuring pattern. */
export function errorBindingNames(lhs: string): string[] {
  const names: string[] = [];
  const alias = /\berror\s*:\s*([A-Za-z_$][\w$]*)/g;
  let m: RegExpExecArray | null;
  while ((m = alias.exec(lhs)) !== null) names.push(m[1]);
  // Shorthand `{ …, error, … }` — but not the alias form already captured.
  const shorthand = /[{,]\s*error\s*(?=[,}])/g;
  while ((m = shorthand.exec(lhs)) !== null) names.push("error");
  return [...new Set(names)];
}

/**
 * Is `name` USED as a variable in `text` — as opposed to appearing as a
 * property (`req.log.error(…)`, `console.error(…)`) or as an object KEY
 * (`res.json({ error: "db_error" })`)?
 *
 * This distinction is the whole of S1. `error` is one of the most common words
 * in this codebase, and a plain word-boundary search finds `logger.error` two
 * lines below every orphaned binding — which silently turns S1 into a shape
 * that can never fire. Reading a property off it (`error.message`) and passing
 * it by shorthand (`{ error }`) both still count as uses.
 */
export function referencesIdentifier(text: string, name: string): boolean {
  return new RegExp(`(?<![.\\w$])${name}\\b(?!\\s*:)`).test(text);
}

/** Names bound to the resolved `data` field by a destructuring pattern. */
export function dataBindingNames(lhs: string): string[] {
  const names: string[] = [];
  const alias = /\bdata\s*:\s*([A-Za-z_$][\w$]*)/g;
  let m: RegExpExecArray | null;
  while ((m = alias.exec(lhs)) !== null) names.push(m[1]);
  const shorthand = /[{,]\s*data\s*(?=[,}])/g;
  while ((m = shorthand.exec(lhs)) !== null) names.push("data");
  return [...new Set(names)];
}

/** End of the statement containing `from`: the next `;` at bracket depth 0. */
function statementEnd(code: string, from: number): number {
  let d = 0;
  for (let i = from; i < code.length; i++) {
    const c = code[i];
    if (c === "(" || c === "[" || c === "{") d++;
    else if (c === ")" || c === "]" || c === "}") {
      if (d === 0) return i; // ran out of statement (e.g. an arrow body)
      d--;
    } else if (c === ";" && d === 0) return i;
  }
  return code.length;
}

/**
 * Start of the statement containing `at`: just past the previous `;`, the `{`
 * that opened the block, or the `}` that CLOSED the previous block. That last
 * case matters — without it the scan walks back over a whole `if (…) { … }` and
 * reports its condition as part of the next statement.
 */
function statementStart(code: string, at: number): number {
  let d = 0;
  for (let i = at; i >= 0; i--) {
    const c = code[i];
    if (d === 0 && (c === ";" || c === "}")) return i + 1;
    if (c === ")" || c === "]" || c === "}") d++;
    else if (c === "(" || c === "[" || c === "{") {
      if (d === 0) return i + 1;
      d--;
    }
  }
  return 0;
}

/** Index of the matching open bracket for the close bracket at `close`. -1 if none. */
function matchOpenBackwards(code: string, close: number): number {
  const pairs: Record<string, string> = { "}": "{", "]": "[", ")": "(" };
  const open = pairs[code[close]];
  if (!open) return -1;
  let d = 0;
  for (let i = close; i >= 0; i--) {
    if (code[i] === code[close]) d++;
    else if (code[i] === open) {
      d--;
      if (d === 0) return i;
    }
  }
  return -1;
}

/**
 * The destructuring pattern immediately left of `= await` at `awaitAt`, and
 * whether it DECLARES (const/let/var) or reassigns an outer binding.
 *
 * Derived by walking left from the `await` rather than by slicing the statement,
 * because a loose slice picks up unrelated `error:` keys from a preceding object
 * literal and invents bindings that are not there.
 */
export function destructurePattern(
  code: string,
  awaitAt: number,
): { pattern: string; declares: boolean } | null {
  let i = awaitAt - 1;
  while (i >= 0 && /\s/.test(code[i])) i--;
  if (code[i] !== "=" || code[i - 1] === "=" || code[i - 1] === "!" || code[i - 1] === "<" || code[i - 1] === ">") {
    return null;
  }
  i--;
  while (i >= 0 && /\s/.test(code[i])) i--;
  if (code[i] !== "}" && code[i] !== "]") return null; // plain identifier: no binding to orphan
  const open = matchOpenBackwards(code, i);
  if (open === -1) return null;
  const pattern = code.slice(open, i + 1);
  const before = code.slice(Math.max(0, open - 20), open);
  return { pattern, declares: /\b(?:const|let|var)\s*$/.test(before) };
}

/** Close brace of the innermost block enclosing `at`; end-of-file if top level. */
export function enclosingBlockEnd(code: string, at: number): number {
  let d = 0;
  for (let i = at; i >= 0; i--) {
    const c = code[i];
    if (c === "}") d++;
    else if (c === "{") {
      if (d === 0) {
        const close = matchBrace(code, i);
        return close === -1 ? code.length : close;
      }
      d--;
    }
  }
  return code.length;
}

/**
 * A reviewable waiver on `line` or the line above it, read from the ORIGINAL
 * source (sanitize blanks comments). Returns "ok" (silence declared, with a
 * reason), "bare" (token present, no reason — NOT honoured), or "none".
 */
export function hatchAt(src: string, index: number): "ok" | "bare" | "none" {
  const lines = src.split("\n");
  const ln = lineOf(src, index) - 1; // 0-indexed
  const window = [lines[ln - 1] ?? "", lines[ln] ?? "", lines[ln + 1] ?? ""].join("\n");
  if (HATCH_WITH_REASON.test(window)) return "ok";
  if (HATCH_ANY.test(window)) return "bare";
  return "none";
}

// ── Statement model ──────────────────────────────────────────────────────────

interface ReadStatement {
  /** Index of the `await` keyword in sanitized code. */
  awaitAt: number;
  start: number;
  end: number;
  /** Sanitized statement text. */
  text: string;
  /** The destructuring pattern left of `= await`, or "" if there is none. */
  lhs: string;
  /** false for `({ data, error } = await …)` — a reassignment of an outer let. */
  declares: boolean;
}

/** Every awaited statement in a file that contains a supabase READ. */
export function readStatements(code: string): ReadStatement[] {
  const out: ReadStatement[] = [];
  const awaitRe = /\bawait\b/g;
  let m: RegExpExecArray | null;
  while ((m = awaitRe.exec(code)) !== null) {
    const start = statementStart(code, m.index - 1);
    const end = statementEnd(code, m.index);
    const text = code.slice(start, end);
    if (!SUPA_READ.test(text)) continue;
    const pat = destructurePattern(code, m.index);
    out.push({
      awaitAt: m.index,
      start,
      end,
      text,
      lhs: pat?.pattern ?? "",
      declares: pat?.declares ?? false,
    });
  }
  return out;
}

// ── The four shapes ──────────────────────────────────────────────────────────

/** S1 — an `error` binding that is never referenced again in its block. */
function findS1(src: string, code: string, file: string): SilentRead[] {
  const found: SilentRead[] = [];
  for (const st of readStatements(code)) {
    // A reassignment (`({ data, error } = await …)`) writes to an outer `let`
    // whose check lives outside this block — the profiles fallback-select idiom
    // in routes/profile.ts and routes/passport.ts. Block-scope reasoning does
    // not apply to it, so this shape declines to judge it.
    if (!st.declares) continue;
    const names = errorBindingNames(st.lhs);
    if (names.length === 0) continue;
    const blockEnd = enclosingBlockEnd(code, st.start);
    const rest = code.slice(st.end, Math.max(st.end, blockEnd));
    for (const name of names) {
      if (referencesIdentifier(rest, name)) continue;
      const h = hatchAt(src, st.start);
      if (h === "ok") continue;
      found.push({
        file,
        line: lineOf(src, st.start),
        shape: "S1",
        detail:
          `\`${name}\` bound and never read` +
          (h === "bare" ? " [waiver present but carries no reason — not honoured]" : "") +
          ` — ${st.text.replace(/\s+/g, " ").trim().slice(0, 90)}`,
      });
    }
  }
  return found;
}

/** S2 — a dead catch around a consequential read that binds no error at all. */
function findS2(src: string, code: string, file: string): SilentRead[] {
  const found: SilentRead[] = [];
  const tryRe = /\btry\s*\{/g;
  let tm: RegExpExecArray | null;
  while ((tm = tryRe.exec(code)) !== null) {
    const tryOpen = tm.index + tm[0].length - 1;
    const tryClose = matchBrace(code, tryOpen);
    if (tryClose === -1) continue;
    const afterTry = code.slice(tryClose + 1);
    const cm = /^\s*catch\s*(\([^)]*\))?\s*\{/.exec(afterTry);
    if (!cm) continue;
    const catchOpen = tryClose + 1 + cm[0].length - 1;
    const catchClose = matchBrace(code, catchOpen);
    if (catchClose === -1) continue;

    // A catch with any statement in it is real handling — comments are not.
    if (code.slice(catchOpen + 1, catchClose).trim() !== "") continue;

    const tryBody = stripNestedTry(code.slice(tryOpen + 1, tryClose));
    if (!AWAIT_SUPA_READ.test(tryBody)) continue;

    // THE load-bearing condition: if the try body binds an error anywhere, the
    // author kept the evidence and this catch is not the silence. Both forms
    // count — a `const { data, error } = await …` declaration and a callback
    // parameter pattern such as `.then(({ data, error }) => …)`.
    if (bindsError(tryBody) || errorBindingNames(tryBody).length > 0) continue;

    const catchBodyOriginal = src.slice(catchOpen + 1, catchClose);
    if (HATCH_WITH_REASON.test(catchBodyOriginal)) continue;
    const bare = HATCH_ANY.test(catchBodyOriginal);

    const am = AWAIT_SUPA_READ.exec(tryBody);
    found.push({
      file,
      line: lineOf(src, catchOpen),
      shape: "S2",
      detail:
        (bare ? "[waiver present but carries no reason — not honoured] " : "") +
        (am ? am[0].replace(/\s+/g, " ").slice(-90) : "awaited read"),
    });
  }
  return found;
}

/** The first argument of a call's argument list: everything up to the first top-level comma. */
export function firstArgument(args: string): string {
  let d = 0;
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if (c === "(" || c === "[" || c === "{") d++;
    else if (c === ")" || c === "]" || c === "}") d--;
    else if (c === "," && d === 0) return args.slice(0, i);
  }
  return args;
}

/** S3 — a read whose `.then` consumes `data` and never looks at `error`. */
function findS3(src: string, code: string, file: string): SilentRead[] {
  const found: SilentRead[] = [];
  const thenRe = /\.\s*then\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = thenRe.exec(code)) !== null) {
    const open = m.index + m[0].length - 1;
    const close = matchParen(code, open);
    if (close === -1) continue;
    const chain = code.slice(statementStart(code, m.index), m.index);
    if (!SUPA_READ.test(chain)) continue;

    // ONLY the first argument — the fulfilment callback. The second argument is
    // a rejection handler, and reading it here would mistake its own
    // `({ data: null })` fallback for a consumption of the resolved value
    // (lib/mediaAccess.ts's `.then(undefined, () => ({ data: null }))`).
    const args = firstArgument(code.slice(open + 1, close));
    // Only a callback that CONSUMES the resolved value is making a claim about
    // it. `undefined` as the fulfilment handler consumes nothing.
    if (!/[{,]\s*data\s*[,}:]/.test(args) && !/\.\s*data\b/.test(args)) continue;
    // A callback PARAMETER pattern (`({ data, error }) => …`) has no trailing
    // `=` for bindsError to key on, so the pattern is also asked directly.
    if (bindsError(args) || errorBindingNames(args).length > 0) continue;

    // NOTE, deliberately: a `.catch(…)` tail and a second `.then` argument are
    // both REJECTION handlers, and a PostgREST failure does not reject — it
    // resolves with `{ error }`, which this callback has already dropped. So
    // neither rescues this site, and neither exempts it. (routes/trust-admin.ts
    // is exactly this: `.then(({ data: profiles }) => …).catch(() => {})`, where
    // an unreadable profile list silently becomes "no profiles to recalculate".)

    const h = hatchAt(src, m.index);
    if (h === "ok") continue;
    found.push({
      file,
      line: lineOf(src, m.index),
      shape: "S3",
      detail:
        (h === "bare" ? "[waiver present but carries no reason — not honoured] " : "") +
        chain.replace(/\s+/g, " ").trim().slice(-90),
    });
  }
  return found;
}

/** S4 — `?? []` / `?? 0` / `?? false` on an error-less read of a gate table. */
function findS4(src: string, code: string, file: string): SilentRead[] {
  const found: SilentRead[] = [];
  for (const st of readStatements(code)) {
    // The binding pattern is NOT part of st.text (the statement scan stops at
    // the pattern's closing brace), and on its own it carries no trailing `=`
    // for bindsError to key on — so the pattern is asked directly, and the rest
    // of the statement is asked the general question.
    if (errorBindingNames(st.lhs).length > 0 || bindsError(st.text)) continue;
    // Table names come from the ORIGINAL text: sanitize blanks string bodies,
    // so `.from("blocks")` reads as `.from(" ")` in the sanitized copy. Offsets
    // are identical by construction, which is what makes this slice valid.
    const raw = src.slice(st.start, st.end);
    const tables = [...raw.matchAll(/\.from\(\s*["'`]([A-Za-z_][\w.]*)/g)].map((t) => t[1]);
    const gate = tables.find((t) => CONSEQUENTIAL_TABLES.has(t));
    if (!gate) continue;

    // Only a DESTRUCTURED `data` binding is followed. A statement with no
    // pattern of its own — `await Promise.all([...])` wrapping several reads —
    // would otherwise claim every coalesce in the block, reporting each inner
    // read's site twice. The cost is that `(await sc.from(…).select()).data ??
    // []` (no destructure at all) is not seen; no such site exists today.
    const names = dataBindingNames(st.lhs);
    if (names.length === 0) continue;

    const blockEnd = enclosingBlockEnd(code, st.start);
    const scope = code.slice(st.start, Math.max(st.start, blockEnd));
    for (const name of names) {
      // `\b` after `]` never matches (both sides non-word), so the empty-array
      // arm carries no trailing boundary — only the numeric/boolean arms do.
      const re = new RegExp(
        `\\b${name}\\b\\s*(?:as\\s+[\\w$\\[\\]<>. ]+)?\\)?\\s*\\?\\?\\s*(\\[\\s*\\]|\\b(?:0|false)\\b)`,
      );
      const hit = re.exec(scope);
      if (!hit) continue;
      const at = st.start + hit.index;
      const h = hatchAt(src, at);
      if (h === "ok") continue;
      found.push({
        file,
        line: lineOf(src, at),
        shape: "S4",
        detail:
          (h === "bare" ? "[waiver present but carries no reason — not honoured] " : "") +
          `${gate}: ${hit[0].replace(/\s+/g, " ")} with no error binding`,
      });
      break; // one finding per read, not one per coalesce site
    }
  }
  return found;
}

/** Scan one file's source for all four read shapes. */
export function findSilentSupabaseReads(src: string, file: string): SilentRead[] {
  const code = sanitize(src);
  return [
    ...findS1(src, code, file),
    ...findS2(src, code, file),
    ...findS3(src, code, file),
    ...findS4(src, code, file),
  ];
}

// ── Tree walk + CLI ─────────────────────────────────────────────────────────

export function scanTree(
  roots: string[] = SCAN_ROOTS,
  repoRoot: string = REPO_ROOT,
): { violations: SilentRead[]; filesScanned: number } {
  const all: SilentRead[] = [];
  let filesScanned = 0;
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        walk(p);
      } else if (
        (name.endsWith(".ts") || name.endsWith(".tsx")) &&
        !name.endsWith(".test.ts") &&
        !name.endsWith(".test.tsx") &&
        !name.endsWith(".d.ts") &&
        !SKIP_FILES.has(name)
      ) {
        filesScanned++;
        const rel = relative(repoRoot, p);
        all.push(...findSilentSupabaseReads(readFileSync(p, "utf8"), rel));
      }
    }
  };
  for (const r of roots) {
    const abs = resolve(repoRoot, r);
    if (existsSync(abs)) walk(abs);
  }
  return { violations: all, filesScanned };
}

// ── Baseline ratchet ────────────────────────────────────────────────────────
// Pre-existing sites are recorded per `<relpath>::<shape>` so that fixing an S2
// cannot be paid for with a new S1 in the same file. Two-sided and shrink-only,
// exactly like SILENT_SUPABASE_WRITES_BASELINE.json: `found > allowed` is a NEW
// violation, `found < allowed` is a STALE entry and also fails, which is what
// forces the count down as sites are fixed.
//
// `__total_files_scanned` is a FLOOR, not a count of sites. A static guard whose
// subject disappears — a moved directory, a renamed root, a walk that silently
// stops recursing — passes green while checking nothing. This is the assertion
// that a green result actually means something.
export const BASELINE_PATH = resolve(__dir, "../../scripts/SILENT_SUPABASE_READS_BASELINE.json");
export const TOTAL_KEY = "__total_files_scanned";

export function baselineKey(v: SilentRead): string {
  return `${v.file}::${v.shape}`;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  let baseline: Record<string, number> = {};
  try {
    baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  } catch {
    // No baseline file — every violation is new.
  }
  const { violations, filesScanned } = scanTree();
  const { newViolations, staleEntries } = compareToBaseline(violations, baseline, baselineKey);
  const floor = baseline[TOTAL_KEY] ?? 0;
  const floorBroken = filesScanned < floor;

  if (newViolations.length === 0 && staleEntries.length === 0 && !floorBroken) {
    console.log(
      `✅ check-silent-supabase-reads: no NEW silently-discarded supabase read ` +
        `(${violations.length} pre-existing site(s) baselined for burn-down across ${filesScanned} files).`,
    );
    process.exit(0);
  }
  if (newViolations.length > 0) {
    console.error(
      `\n✘ check-silent-supabase-reads: ${newViolations.length} NEW silently-discarded supabase read(s).\n\n` +
        "supabase-js RESOLVES (does not throw) on a DB error, so a try/catch around\n" +
        "a read never runs for the failure it appears to handle, and `data ?? []`\n" +
        "turns that failure into a confident empty answer.\n" +
        "Fix: bind { error } and log or branch on it, return a DISTINCT sentinel for\n" +
        `"could not read", or declare the silence with a "// ${ESCAPE_HATCH}: <reason>"\n` +
        "comment (the reason is required).\n",
    );
    for (const v of newViolations) {
      console.error(`  ${v.file}:${v.line}  [${v.shape}]  ${v.detail}`);
    }
  }
  if (staleEntries.length > 0) {
    console.error(
      `\n✘ stale baseline entries (site was fixed — lower the count in ${relative(process.cwd(), BASELINE_PATH)} so it cannot regress):`,
    );
    for (const s of staleEntries) {
      console.error(`  ${s.file}: baselined ${s.baselined}, found ${s.found}`);
    }
  }
  if (floorBroken) {
    console.error(
      `\n✘ scanned only ${filesScanned} files, below the floor of ${floor}.\n` +
        "  A guard whose subject vanished passes green while checking nothing.\n" +
        `  Either a scan root moved (see SCAN_ROOTS) or the tree really shrank —\n` +
        `  if the latter, lower ${TOTAL_KEY} deliberately.`,
    );
  }
  process.exit(1);
}
