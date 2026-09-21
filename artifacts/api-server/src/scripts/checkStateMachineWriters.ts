/**
 * Every modelled state must have a reachable writer — `check:state-machine-writers`.
 *
 * ── THE DEFECT ───────────────────────────────────────────────────────────────
 * A STATE NOTHING CAN WRITE. `events.state` has a `started` member; the enum
 * declares it, an RLS policy names it, two Passport services list it as live,
 * and three routes REQUIRE it — `POST /events/:id/complete` refuses anything
 * else. Nothing has ever written it. Production, measured 2026-09-07: 97 open
 * events, 96 of them already past `starts_at`, **0 started**, and **0 rows in
 * `event_activity_log`**, so no event on production has ever passed through a
 * transitioning route at all. `POST /complete` cannot succeed, and has not.
 *
 * The parts are individually correct: the enum label is valid, the routes are
 * wired, the types check, the tests pass. A state can exist across the schema
 * and the API, be consumed by real logic, and have no reachable writer — and
 * nothing fails.
 *
 * This is the third member of a family. `checkWriterlessReads.ts` asks whether
 * a TABLE can ever hold a row; `checkProjectionConsumers.ts` asks whether a
 * table that fills is ever read. This one asks the question one level down:
 * inside a table that does fill, can every STATE the code branches on actually
 * occur?
 *
 * ── WHY A REGISTRY, NOT AN ENUM SCANNER ──────────────────────────────────────
 * A blind scan over every enum reports hundreds of states, is wrong about most
 * of them, and is switched off within a week. It also cannot distinguish the
 * four cases that decide what anyone should DO — a state blocked on a person's
 * decision, one only an operator causes, one deliberately switched off, and one
 * that is vocabulary and nothing more. So `lib/stateMachines/registry.ts`
 * states the classification WITH ITS EVIDENCE and this script verifies every
 * claim against the tree.
 *
 * ── WHAT FAILS ───────────────────────────────────────────────────────────────
 * Only MISSING_WRITER, and invalid registration:
 *   1.  a declared state that is not in the CHECK constraint / enum;
 *   2.  a state in the schema that the registry does not mention (so a new enum
 *       label cannot be added without being classified);
 *   3.  a TS mirror constant that has drifted from the SQL vocabulary;
 *   4.  a declared writer file that does not exist, or that no longer contains
 *       the write it is cited for;
 *   5.  a declared consumer that does not exist or never mentions the state;
 *   6.  a non-REACHABLE classification with no substantive reason;
 *   7.  OWNER_BLOCKED with no owner decision recorded in a doc that exists;
 *   8.  HOLD whose flag is not actually seeded FALSE by the migration cited;
 *   9.  a state classified more reachable than its own best writer;
 *   10. a scheduler-driven transition whose scheduler is never started;
 *   11. the PIN below;
 *   12. vacuity;
 *   13. a writer, consumer or hold-flag reader whose only mention of the thing
 *       it is cited for is inside a COMMENT;
 *   14. an RPC writer whose sqlFile merely NAMES the function instead of
 *       defining it;
 *   15. a column-DEFAULT writer whose evidence does not quote the one insert it
 *       is a claim about, or whose CREATE TABLE does not give that column that
 *       default;
 *   16. a derived lifecycle whose declared accessor no writer of the machine
 *       defines.
 *
 * ── EVERY QUESTION HERE IS A QUESTION ABOUT CODE ─────────────────────────────
 * Rules 4, 5 and 8 used to be `rawFileText.includes(…)`, which is the same
 * mistake `callsFunction` was extracted to fix in rule 10 and which six guards
 * in this tree have now shipped: a commented-out write, a state named only in
 * prose and a flag mentioned in a docblock all counted. They are read through
 * `codeOnly` now. Rules 14 and 16 go one step further and mask string CONTENTS
 * as well, because "is this DEFINED here?" must not be answered by a name that
 * appears inside a log message, a GRANT or another function's quoted body.
 *
 * ── THE PIN ──────────────────────────────────────────────────────────────────
 * `events.state = 'started'` must be classified OWNER_BLOCKED, naming
 * EVENT_START_TRANSITION. Not MISSING_WRITER: engineering does not owe a
 * writer, and reporting it as a bug would put it on the wrong queue. Not
 * REACHABLE: it is not, and calling it so would erase the finding.
 *
 * And — this is the point of a pin rather than a rule — the classification is
 * NOT satisfiable by implementing the writer. `lib/eventLifecycle.ts` already
 * implements it, is started from `index.ts`, and writes nothing, because
 * migration 2600 seeds `event_start_transition_enabled` FALSE. Flipping that
 * flag does not close this; flipping it TAKES the decision (option (a),
 * derived) on the owner's behalf, and its first pass on production would move
 * 96 events belonging to 3 hosts. The pin lifts when the decision is recorded
 * as taken, by a person, in the ledger — not when somebody makes the check
 * green.
 *
 * Run: node --import tsx/esm src/scripts/checkStateMachineWriters.ts
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { callsFunction } from "./lib/callsFunction.js";
import {
  STATE_MACHINES as REAL_MACHINES,
  CLASSIFICATION_RANK,
  summarize,
  type StateClassification,
  type StateMachineEntry,
} from "../lib/stateMachines/registry.js";

/**
 * The registry can be swapped for a crafted one — the same seam
 * PROJECTION_REGISTRY gives checkProjectionConsumers.ts. It exists so the tests
 * can PROVE each rule fires: while the real registry is correct every failure
 * path here is unreachable, and a guard nobody has watched fail is not a guard.
 */
const MACHINES: readonly StateMachineEntry[] = process.env.STATE_MACHINE_REGISTRY
  ? (JSON.parse(readFileSync(resolve(process.env.STATE_MACHINE_REGISTRY), "utf8")) as StateMachineEntry[])
  : REAL_MACHINES;

const HERE = dirname(fileURLToPath(import.meta.url));
export const API_ROOT = process.env.STATE_MACHINE_API_ROOT
  ? resolve(process.env.STATE_MACHINE_API_ROOT)
  : resolve(HERE, "..", "..");
export const REPO_ROOT = process.env.STATE_MACHINE_REPO_ROOT
  ? resolve(process.env.STATE_MACHINE_REPO_ROOT)
  : resolve(API_ROOT, "..", "..");
const SRC = process.env.STATE_MACHINE_SRC ? resolve(process.env.STATE_MACHINE_SRC) : join(API_ROOT, "src");

/** Non-vacuity floors. A check that examines nothing must not report success. */
const MIN_FILES_SCANNED = 100;
const MIN_MACHINES = 6;
const MIN_STATES = 40;
const MIN_TRANSITIONS = 40;
/** A reason that does not say anything is not a reason. */
const MIN_REASON = 40;

/**
 * States whose classification is fixed by a decision a PERSON owes, and which
 * therefore cannot be satisfied by writing code. Changing one of these means
 * the decision was taken — record that in the ledger and edit this list in the
 * same commit, deliberately.
 */
const OWNER_DECISION_PINS: readonly { machine: string; state: string; decision: string }[] = [
  { machine: "EVENTS_STATE", state: "started", decision: "EVENT_START_TRANSITION" },
];

// ── file helpers ─────────────────────────────────────────────────────────────

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      if (e !== "node_modules") walk(p, out);
    } else if (p.endsWith(".ts") || p.endsWith(".sql")) {
      out.push(p);
    }
  }
  return out;
}

const cache = new Map<string, string | null>();
function read(abs: string): string | null {
  if (cache.has(abs)) return cache.get(abs)!;
  const v = existsSync(abs) && statSync(abs).isFile() ? readFileSync(abs, "utf8") : null;
  cache.set(abs, v);
  return v;
}

// ── vocabulary extraction ────────────────────────────────────────────────────

/** Quoted SQL literals inside `text`. */
function literals(text: string): string[] {
  return [...text.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
}

/**
 * `CREATE TYPE <symbol> AS ENUM ('a','b',…)`.
 * Returns null when the type is not declared in the file at all.
 */
export function enumStates(sql: string, symbol: string): string[] | null {
  const re = new RegExp(`CREATE TYPE\\s+${symbol.replace(/[.$]/g, "\\$&")}\\s+AS ENUM\\s*\\(([^)]*)\\)`);
  const m = re.exec(sql);
  return m ? literals(m[1]!) : null;
}

/**
 * The first `IN ( … )` list after `anchor`.
 *
 * The anchor must occur EXACTLY ONCE — an anchor that matches twice would
 * silently read whichever list came first, which is how a check ends up
 * validating the wrong constraint and passing. `occurrences` is reported so
 * that case fails loudly instead.
 */
export function checkStates(sql: string, anchor: string): { states: string[] | null; occurrences: number } {
  let occurrences = 0;
  for (let i = sql.indexOf(anchor); i !== -1; i = sql.indexOf(anchor, i + 1)) occurrences += 1;
  if (occurrences !== 1) return { states: null, occurrences };
  const from = sql.indexOf(anchor);
  const inAt = sql.indexOf("IN (", from);
  if (inAt === -1) return { states: null, occurrences };
  const close = sql.indexOf(")", inAt);
  if (close === -1) return { states: null, occurrences };
  return { states: literals(sql.slice(inAt + 4, close)), occurrences };
}

/** `export const SYMBOL = [ "a", "b", … ] as const` in TypeScript. */
export function mirrorStates(ts: string, symbol: string): string[] | null {
  const re = new RegExp(`\\b${symbol}\\s*(?::[^=]+)?=\\s*\\[([^\\]]*)\\]`);
  const m = re.exec(ts);
  if (!m) return null;
  return [...m[1]!.matchAll(/["'`]([^"'`]+)["'`]/g)].map((x) => x[1]!);
}

/**
 * Does `text` actually CALL `name`, outside comments?
 *
 * A plain `new RegExp(name + "\\s*\\(")` over the raw file says yes for
 * `// startTrustMaintenanceScheduler();`. That was measured, not imagined:
 * commenting the call out in index.ts left this check GREEN while the state it
 * guards became unreachable — the exact regression the rule exists to catch,
 * passing. Line comments and block comments are stripped first.
 *
 * It errs toward NOT finding the call (a `//` inside a string literal truncates
 * the rest of that line), which fails loudly rather than passing quietly.
 */
/**
 * Lifted to src/scripts/lib/callsFunction.ts once checkProjectionConsumers.ts
 * was found to carry the identical bug. Re-exported here because the mutation
 * fixtures in src/test/stateMachineWriters.test.ts import it from this module,
 * and the proof that a commented-out call is not a call belongs with them.
 */
export { callsFunction };

// ── code-aware reading ───────────────────────────────────────────────────────

/**
 * WHY THIS FILE HAS ITS OWN SCANNER AS WELL AS `stripComments`.
 *
 * Every question this guard asks about a file is a question about CODE, and the
 * family bug it was born from is answering one of those by matching RAW TEXT.
 * `callsFunction` (built on `src/scripts/lib/stripComments.ts`) fixed that for
 * "is this scheduler started?". Rules 4, 5 and 8 still used `text.includes(…)`
 * on the raw file, so a writer that had been commented out, a consumer that
 * only NAMES the state in prose, and a hold flag mentioned in a docblock all
 * still counted. Those are the same defect wearing different hats.
 *
 * `stripComments` alone cannot be used for them, and this was measured rather
 * than assumed: it looks for `/*` BEFORE `//` on each line, so the perfectly
 * ordinary line
 *
 *     // client's /api/buddy-bookings(star) URLs reach them through …
 *
 * in `routes/rentABuddySpec.ts:852` opens a block comment that never closes on
 * that line, and everything down to the next `(star)/` — 1400 lines, including the
 * dispute-resolution writer this registry cites — vanishes. Its own header
 * calls that direction deliberate and safe, and for "is this called?" it is: a
 * false NO fails loudly. For "does this writer still exist?" a false NO is a
 * guard that goes red on correct code, which gets it deleted.
 *
 * So this scanner walks the file once, in order, and decides at each position
 * whether it is inside a line comment, a block comment or a string — which is
 * the only way `//` inside a string and `/*` inside a `//` both come out right.
 * It replaces removed text with spaces rather than deleting it, so offsets and
 * line numbers survive.
 *
 * `maskStrings` is the DEFINITION/OCCURRENCE distinction:
 *
 *   false  strings are kept. "Does this file contain this write?" — the write
 *          IS a string (`.update({ status: "expired" … })`), so masking it
 *          would delete the very evidence being looked for.
 *   true   string CONTENTS are blanked. "Does this file DEFINE this function?"
 *          — a name inside a log message, an error string or a SQL body quoted
 *          into another statement is a mention, not a definition, and the whole
 *          point of the question is to tell those apart.
 */
type Lang = "ts" | "sql";

export function codeOnly(text: string, lang: Lang, maskStrings: boolean): string {
  const out = text.split("");
  const n = text.length;
  const blank = (a: number, b: number): void => {
    for (let k = Math.max(a, 0); k < Math.min(b, n); k++) if (out[k] !== "\n") out[k] = " ";
  };
  let i = 0;
  while (i < n) {
    const c = text[i]!;
    const d = text[i + 1];
    // line comment: `//` in TS, `--` in SQL
    if ((lang === "ts" && c === "/" && d === "/") || (lang === "sql" && c === "-" && d === "-")) {
      let j = text.indexOf("\n", i);
      if (j === -1) j = n;
      blank(i, j);
      i = j;
      continue;
    }
    // block comment (both languages)
    if (c === "/" && d === "*") {
      const end = text.indexOf("*/", i + 2);
      const j = end === -1 ? n : end + 2;
      blank(i, j);
      i = j;
      continue;
    }
    // dollar-quoted SQL body: $$ … $$ or $tag$ … $tag$
    if (lang === "sql" && c === "$") {
      const m = /^\$(?:[A-Za-z_]\w*)?\$/.exec(text.slice(i, i + 64));
      if (m) {
        const tag = m[0];
        const end = text.indexOf(tag, i + tag.length);
        const bodyEnd = end === -1 ? n : end;
        if (maskStrings) blank(i + tag.length, bodyEnd);
        i = end === -1 ? n : end + tag.length;
        continue;
      }
    }
    if (c === "'" || c === '"' || (lang === "ts" && c === "`")) {
      let j = i + 1;
      while (j < n) {
        const q = text[j]!;
        if (lang === "ts" && q === "\\") { j += 2; continue; }
        // SQL escapes a quote by doubling it
        if (lang === "sql" && q === c && text[j + 1] === c) { j += 2; continue; }
        if (q === c) { j += 1; break; }
        // an unterminated single/double-quoted literal must not swallow the file
        if (q === "\n" && c !== "`") { break; }
        j += 1;
      }
      if (maskStrings) blank(i + 1, j - 1);
      i = j;
      continue;
    }
    i += 1;
  }
  return out.join("");
}

/** Comments gone, strings kept — for "does this file contain this write?". */
export function codeText(text: string, lang: Lang = "ts"): string {
  return codeOnly(text, lang, false);
}

/**
 * Is `name` DEFINED as a function in this TypeScript — not merely called,
 * imported or mentioned?
 *
 * A DEFINITION question, so string CONTENTS are masked as well as comments:
 * `"export async function getRestrictionState("` appears inside this guard's
 * own test fixtures as a string, and a rule that accepted that would let a
 * registry point its accessor at any file that happens to quote the signature.
 */
export function definesTsFunction(ts: string, name: string): boolean {
  const body = codeOnly(ts, "ts", true);
  const n = name.replace(/[.$*+?()[\]{}|^\\]/g, "\\$&");
  return new RegExp(
    `(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s*\\*?\\s*${n}\\s*[(<]` +
      `|(?:const|let|var)\\s+${n}\\s*(?::[^=;]+)?=\\s*(?:async\\s*)?(?:function|\\()`,
  ).test(body);
}

/**
 * Is `name` DEFINED as a SQL function here — not merely named?
 *
 * `sql.includes(name)` was the old rule, and an RPC name appears in a comment
 * above the function, in a GRANT, in a RAISE NOTICE and inside any other
 * function's quoted body. None of those is a definition; a registry entry whose
 * `via` was renamed would still have passed on the leftover GRANT line. Comments
 * are dropped and string / dollar-quoted BODIES are blanked before the match, so
 * only a real `CREATE [OR REPLACE] FUNCTION <name>(` counts.
 */
export function definesSqlFunction(sql: string, name: string): boolean {
  const bare = name.replace(/^public\./, "");
  const re = new RegExp(
    `CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+(?:[A-Za-z_]\\w*\\s*\\.\\s*)?${bare.replace(/[.$*+?()[\]{}|^\\]/g, "\\$&")}\\s*\\(`,
    "i",
  );
  return re.test(codeOnly(sql, "sql", true));
}

/**
 * The `CREATE TABLE <table> ( … )` block, or null.
 *
 * Used so a column DEFAULT is read from the RIGHT table: `DEFAULT 'active'` on a
 * `status` column occurs twice in 0167 (sessions and live shares) and matching
 * the file as a whole would let either entry vouch for the other.
 */
export function createTableBlock(sql: string, table: string): string | null {
  const re = new RegExp(`CREATE TABLE\\s+(?:IF NOT EXISTS\\s+)?(?:public\\s*\\.\\s*)?${table}\\b`, "i");
  const m = re.exec(sql);
  if (!m) return null;
  const from = m.index;
  const end = sql.indexOf("\n);", from);
  return sql.slice(from, end === -1 ? sql.length : end + 3);
}

/** Does the CREATE TABLE block give `column` a DDL DEFAULT of `state`? */
export function columnDefaultsTo(block: string, column: string, state: string): boolean {
  const body = codeOnly(block, "sql", false);
  const re = new RegExp(`\\b${column}\\b[^,\\n]*DEFAULT\\s+'${state}'`, "i");
  for (const line of body.split("\n")) if (re.test(line)) return true;
  // pg_dump writes `status text DEFAULT 'pending'::text NOT NULL,` on one line;
  // a hand-written migration may wrap. Fall back to the whole block, still
  // scoped to this table.
  return new RegExp(`\\b${column}\\b[\\s\\S]{0,120}?DEFAULT\\s+'${state}'`, "i").test(body);
}

// ── the check ────────────────────────────────────────────────────────────────

function main(): void {
  const problems: string[] = [];
  const filesRead = new Set<string>();
  const tree = walk(SRC);

  const note = (abs: string): string | null => {
    filesRead.add(abs);
    return read(abs);
  };

  let totalStates = 0;
  let totalTransitions = 0;
  const reports: string[] = [];

  for (const m of MACHINES) {
    const declared = m.states.map((s) => s.name);
    const byName = new Map(m.states.map((s) => [s.name, s]));
    totalStates += m.states.length;
    totalTransitions += m.transitions.length;

    if (declared.length !== new Set(declared).size) {
      problems.push(`${m.key}: duplicate state names in the registry.`);
    }

    // ── 1/2. vocabulary parity, in BOTH directions ──────────────────────────
    const vocabAbs = join(API_ROOT, m.vocabulary.file);
    const vocabText = note(vocabAbs);
    let schemaStates: string[] | null = null;

    if (vocabText === null) {
      problems.push(`${m.key}: vocabulary source ${m.vocabulary.file} does not exist.`);
    } else if (m.vocabulary.kind === "pgEnum") {
      schemaStates = enumStates(vocabText, m.vocabulary.symbol);
      if (schemaStates === null) {
        problems.push(`${m.key}: ${m.vocabulary.file} declares no enum ${m.vocabulary.symbol}.`);
      }
    } else if (m.vocabulary.kind === "sqlCheck") {
      const r = checkStates(vocabText, m.vocabulary.anchor);
      schemaStates = r.states;
      if (schemaStates === null) {
        problems.push(
          `${m.key}: anchor ${JSON.stringify(m.vocabulary.anchor)} occurs ${r.occurrences} time(s) in ` +
            `${m.vocabulary.file} with a readable IN (…) list after it; it must occur exactly once. ` +
            `An anchor that matches twice reads whichever constraint came first and passes on the wrong one.`,
        );
      }
    } else {
      // derived: there is no vocabulary list, so the columns the derivation
      // reads must at least exist where the entry says they do.
      for (const col of m.vocabulary.columns) {
        if (!vocabText.includes(col)) {
          problems.push(
            `${m.key}: derived lifecycle names column ${col}, which does not appear in ${m.vocabulary.file}.`,
          );
        }
      }
      if (m.vocabulary.derivation.trim().length <= MIN_REASON) {
        problems.push(`${m.key}: a derived lifecycle must state HOW the state is computed; the derivation is too thin.`);
      }
      if (m.vocabulary.columns.length === 0) {
        problems.push(`${m.key}: derived lifecycle declares no columns, so nothing about it is checkable.`);
      }
      // An accessor is only a stand-in for the missing state name if it really
      // exists — and it must be defined by this machine's OWN writers, so the
      // registry cannot borrow an unrelated function's name to excuse a consumer.
      for (const acc of m.vocabulary.accessors ?? []) {
        const homes = [...new Set(m.transitions.map((t) => t.writer.file))];
        const defined = homes.some((f) => {
          const text = note(join(SRC, f));
          return text !== null && definesTsFunction(text, acc);
        });
        if (!defined) {
          problems.push(
            `${m.key}: derived accessor ${acc} is not DEFINED in any of this machine's writer files ` +
              `(${homes.join(", ")}). An accessor that does not exist cannot stand in for a state name ` +
              `that does not exist either.`,
          );
        }
      }
    }

    if (schemaStates) {
      if (schemaStates.length === 0) {
        problems.push(`${m.key}: parsed an EMPTY state vocabulary from ${m.vocabulary.file} — the parse is wrong or the schema is.`);
      }
      for (const s of declared) {
        if (!schemaStates.includes(s)) {
          problems.push(
            `${m.key}: registered state "${s}" is NOT in ${m.storage}.${m.field}'s vocabulary ` +
              `(${m.vocabulary.file}: ${schemaStates.join(", ")}). A state the schema cannot hold is a branch ` +
              `that can never run — CompassNotificationEngine branched on public_level 'suspended' for exactly this reason.`,
          );
        }
      }
      for (const s of schemaStates) {
        if (!declared.includes(s)) {
          problems.push(
            `${m.key}: ${m.storage}.${m.field} admits "${s}" and the registry does not mention it. ` +
              `Classify it (REACHABLE / OWNER_BLOCKED / OPS_DRIVEN / HOLD / DECLARED_UNUSED) — the registry ` +
              `cannot be used to hide a state, which is how events.state='started' stayed invisible.`,
          );
        }
      }
    }

    // ── 3. TS mirror of the SQL vocabulary ──────────────────────────────────
    if (m.mirror) {
      const abs = join(SRC, m.mirror.file);
      const text = note(abs);
      if (text === null) {
        problems.push(`${m.key}: mirror file ${m.mirror.file} does not exist.`);
      } else {
        const mir = mirrorStates(text, m.mirror.symbol);
        if (mir === null) {
          problems.push(`${m.key}: ${m.mirror.file} declares no ${m.mirror.symbol} array.`);
        } else if (schemaStates) {
          const missing = schemaStates.filter((s) => !mir.includes(s));
          const extra = mir.filter((s) => !schemaStates!.includes(s));
          if (missing.length || extra.length) {
            problems.push(
              `${m.key}: ${m.mirror.symbol} has drifted from ${m.vocabulary.file}` +
                (missing.length ? ` — missing ${missing.join(", ")}` : "") +
                (extra.length ? ` — has ${extra.join(", ")} the schema does not` : "") + ".",
            );
          }
        }
      }
    }

    // ── 4. transitions: the writer exists and still writes it ───────────────
    const incoming = new Map<string, StateClassification[]>();
    const outgoing = new Set<string>();

    for (const t of m.transitions) {
      const label = `${m.key}: ${t.from.length ? t.from.join("|") : "(create)"} -> ${t.to}`;

      if (!byName.has(t.to)) {
        problems.push(`${label}: target state "${t.to}" is not a declared state of this machine.`);
      }
      for (const f of t.from) {
        if (!byName.has(f)) problems.push(`${label}: source state "${f}" is not a declared state of this machine.`);
        outgoing.add(f);
      }
      if (!incoming.has(t.to)) incoming.set(t.to, []);
      incoming.get(t.to)!.push(t.classification);

      if (t.classification === "DECLARED_UNUSED") {
        problems.push(`${label}: a transition cannot be DECLARED_UNUSED — it has a writer, so the state is used.`);
      }
      if (t.classification !== "REACHABLE" && (t.reason ?? "").trim().length <= MIN_REASON) {
        problems.push(
          `${label}: classification ${t.classification} requires a substantive reason. ` +
            `"nothing writes it" is the defect, not an exemption.`,
        );
      }

      const wAbs = join(SRC, t.writer.file);
      const wRaw = note(wAbs);
      // Rule 4 asks whether the WRITE is still there. A commented-out write is
      // not a write — that is the whole family bug — so the question is put to
      // the code, with string literals kept, because the write IS a literal.
      const wText = wRaw === null ? null : codeText(wRaw, wAbs.endsWith(".sql") ? "sql" : "ts");
      if (wText === null || wRaw === null) {
        problems.push(`${label}: declared writer ${t.writer.file} does not exist.`);
      } else {
        for (const ev of t.writer.evidence) {
          if (!wText.includes(ev)) {
            problems.push(
              wRaw.includes(ev)
                ? `${label}: ${t.writer.file} contains ${JSON.stringify(ev)} only inside a COMMENT. ` +
                    `A commented-out write is not a writer, and "${t.to}" is unreachable through it.`
                : `${label}: ${t.writer.file} no longer contains ${JSON.stringify(ev)}. ` +
                    `Either the writer moved and the registry is stale, or the transition was removed and ` +
                    `"${t.to}" just became unreachable without anything else noticing.`,
            );
          }
        }
        if (t.writer.evidence.length === 0) {
          problems.push(`${label}: a writer with no evidence proves nothing.`);
        }
        if (t.writer.via) {
          // The TS caller contains the RPC name; the state literal lives in SQL.
          if (!t.writer.evidence.some((e) => e.includes(t.writer.via!))) {
            problems.push(`${label}: evidence must cite the producer function ${t.writer.via}.`);
          }
          if (!t.writer.sqlFile) {
            problems.push(`${label}: writer declares via=${t.writer.via} but no sqlFile defining it.`);
          } else {
            const sAbs = join(API_ROOT, t.writer.sqlFile);
            const sText = note(sAbs);
            if (sText === null) {
              problems.push(`${label}: ${t.writer.sqlFile} (which should define ${t.writer.via}) does not exist.`);
            } else {
              // A DEFINITION question: the name must be CREATEd here, not merely
              // named in a comment, a GRANT or another function's quoted body.
              if (!definesSqlFunction(sText, t.writer.via)) {
                problems.push(
                  `${label}: ${t.writer.sqlFile} does not DEFINE ${t.writer.via} ` +
                    `(no CREATE [OR REPLACE] FUNCTION for it outside comments and string bodies). ` +
                    `${sText.includes(t.writer.via) ? "The name does appear there — as a mention, which is not a writer." : ""}`,
                );
              }
              // A derived lifecycle has no state literal to find in SQL.
              if (m.vocabulary.kind !== "derived" && !sText.includes(`'${t.to}'`)) {
                problems.push(
                  `${label}: ${t.writer.sqlFile} defines ${t.writer.via} but never writes '${t.to}'. ` +
                    `An RPC named in the registry that does not produce the state is not a writer.`,
                );
              }
            }
          }
        } else if (t.writer.columnDefault) {
          // ── the row is created in this state BY THE SCHEMA ──────────────────
          //
          // `SafeReturnService.createSession` inserts a `safe_return_sessions`
          // row and never mentions `status`; the row is `pending` because the
          // COLUMN says so. The ordinary rule ("evidence must name the state")
          // cannot be satisfied honestly here, and the only text in that file
          // naming `pending` is a docblock — so the rule as written invites
          // exactly the citation this guard exists to refuse: a comment used as
          // proof of a write. The honest answer is to check the two halves that
          // are actually true — the writer inserts into the table, and the DDL
          // gives the column that default — and to check the default INSIDE the
          // right CREATE TABLE, because `DEFAULT 'active'` on a `status` column
          // appears twice in 0167 and either table would otherwise vouch for the
          // other.
          const cd = t.writer.columnDefault;
          // ONE evidence entry must contain BOTH the table and the insert,
          // contiguously. Two separate tokens are not enough and this was
          // measured: with `.from("safe_return_live_shares")` and `.insert({`
          // listed as separate evidence, repointing startShare's insert at
          // another table left the guard GREEN, because both tokens still
          // occurred elsewhere in a file that reads that table four times. A
          // column DEFAULT is a claim about ONE statement, so the evidence has
          // to quote that one statement.
          if (
            !t.writer.evidence.some((e) => e.includes(`.from("${m.storage}")`) && e.includes(".insert("))
          ) {
            problems.push(
              `${label}: a column-DEFAULT writer's claim is about ONE statement — that THIS insert goes ` +
                `into ${m.storage} — so a single evidence entry must quote both ` +
                `.from("${m.storage}") and .insert( together. Listing them separately passes on any file ` +
                `that happens to contain each somewhere, which is how a writer repointed at another table ` +
                `stays green. (A column DEFAULT also applies only on INSERT: an UPDATE that omits the ` +
                `column leaves the row in whatever state it already had.)`,
            );
          }
          const ddl = note(join(API_ROOT, cd.file));
          if (ddl === null) {
            problems.push(`${label}: column-DEFAULT source ${cd.file} does not exist.`);
          } else {
            const block = createTableBlock(ddl, m.storage);
            if (block === null) {
              problems.push(`${label}: ${cd.file} has no CREATE TABLE ${m.storage}, so its DEFAULT proves nothing here.`);
            } else if (!columnDefaultsTo(block, cd.column, t.to)) {
              problems.push(
                `${label}: ${cd.file}'s CREATE TABLE ${m.storage} does not give ${cd.column} a DEFAULT of ` +
                  `'${t.to}'. The writer never sets the column, so if the schema default is not "${t.to}" ` +
                  `then nothing writes "${t.to}" at all and this transition is a fiction.`,
              );
            }
          }
        } else if (m.vocabulary.kind === "derived") {
          // A derived lifecycle's state NAMES are registry labels — "active",
          // "lifted", "expired" appear nowhere in the code, because the state IS
          // the timestamps. Requiring the label here would be a guaranteed false
          // failure on correct code, so the evidence must instead cite one of the
          // columns the declared derivation actually reads.
          const cols: readonly string[] = m.vocabulary.columns;
          if (!t.writer.evidence.some((e) => cols.some((c) => e.includes(c)))) {
            problems.push(
              `${label}: this machine has no state column, so evidence must cite one of the columns the ` +
                `derivation reads (${cols.join(", ")}). Evidence that touches none of them ` +
                `does not show the lifecycle moving.`,
            );
          }
        } else if (!t.writer.evidence.some((e) => e.includes(t.to))) {
          problems.push(
            `${label}: no evidence line mentions "${t.to}". Evidence that does not name the state cannot ` +
              `show the state is written — point at the write, not at the file.`,
          );
        }
      }

      // ── 10. a time-driven transition whose scheduler nobody starts ────────
      if (t.scheduler) {
        const eAbs = join(SRC, t.scheduler.from);
        const eText = note(eAbs);
        if (eText === null) {
          problems.push(`${label}: scheduler entry point ${t.scheduler.from} does not exist.`);
        } else if (!callsFunction(eText, t.scheduler.starts)) {
          problems.push(
            `${label}: ${t.scheduler.starts} is never CALLED from ${t.scheduler.from}. ` +
              `An unstarted scheduler is a writer that never runs, and "${t.to}" is then unreachable ` +
              `however complete the pass looks — TrustRestrictionService.expireOldRestrictions sat like ` +
              `that, commented "call from cleanup job", with no caller.`,
          );
        }
      }
    }

    // ── 5-9. per state ──────────────────────────────────────────────────────
    for (const s of m.states) {
      const inc = incoming.get(s.name) ?? [];

      if (s.classification === "MISSING_WRITER") {
        problems.push(
          `${m.key}.${s.name}: MISSING_WRITER — ${m.storage}.${m.field} can hold "${s.name}", code branches ` +
            `on it, and nothing anywhere writes it. ${s.reason ?? "(no reason recorded)"}`,
        );
      }

      if (s.classification !== "REACHABLE" && (s.reason ?? "").trim().length <= MIN_REASON) {
        problems.push(
          `${m.key}.${s.name}: classification ${s.classification} requires a substantive reason ` +
            `(what blocks it, who owns it, what was measured).`,
        );
      }

      if (s.terminal && outgoing.has(s.name)) {
        problems.push(`${m.key}.${s.name}: declared terminal but a transition leaves it.`);
      }

      // OWNER_BLOCKED must name a decision recorded in a doc that exists.
      if (s.classification === "OWNER_BLOCKED") {
        const d = s.ownerDecision;
        if (!d) {
          problems.push(
            `${m.key}.${s.name}: OWNER_BLOCKED with no ownerDecision. The classification only means ` +
              `anything if it names the decision and the person it is waiting on.`,
          );
        } else {
          if (!/^[A-Z][A-Z0-9_]+$/.test(d.id)) {
            problems.push(`${m.key}.${s.name}: owner decision id ${JSON.stringify(d.id)} is not a decision identifier.`);
          }
          if ((d.question ?? "").trim().length <= MIN_REASON) {
            problems.push(`${m.key}.${s.name}: owner decision ${d.id} does not state what is actually being decided.`);
          }
          if (d.docs.length === 0) {
            problems.push(`${m.key}.${s.name}: owner decision ${d.id} is recorded nowhere.`);
          }
          for (const doc of d.docs) {
            const abs = join(REPO_ROOT, doc);
            const text = note(abs);
            if (text === null) {
              problems.push(`${m.key}.${s.name}: owner decision doc ${doc} does not exist.`);
            } else if (!text.includes(d.id)) {
              problems.push(
                `${m.key}.${s.name}: ${doc} never names ${d.id}. A decision nobody can find is not recorded.`,
              );
            }
          }
        }
      } else if (s.ownerDecision) {
        problems.push(`${m.key}.${s.name}: names an owner decision but is classified ${s.classification}.`);
      }

      // HOLD must be a switch that is really off.
      if (s.classification === "HOLD") {
        const h = s.hold;
        if (!h) {
          problems.push(
            `${m.key}.${s.name}: HOLD with no gate. A hold is a flag someone can flip; without the flag ` +
              `this is just an unwritten state wearing a nicer word.`,
          );
        } else {
          const mig = note(join(API_ROOT, h.seededFalseIn));
          if (mig === null) {
            problems.push(`${m.key}.${s.name}: ${h.seededFalseIn} (cited as seeding ${h.flag} FALSE) does not exist.`);
          } else if (!new RegExp(`'${h.flag}'\\s*,\\s*false\\b`, "i").test(mig)) {
            problems.push(
              `${m.key}.${s.name}: ${h.seededFalseIn} does not seed ${h.flag} FALSE. Either the flag was ` +
                `turned on — in which case this state is no longer on hold — or the citation is wrong.`,
            );
          }
          const reader = note(join(SRC, h.readBy));
          if (reader === null) {
            problems.push(`${m.key}.${s.name}: hold reader ${h.readBy} does not exist.`);
          } else if (!codeText(reader).includes(h.flag)) {
            problems.push(
              reader.includes(h.flag)
                ? `${m.key}.${s.name}: ${h.readBy} names ${h.flag} only in a COMMENT. A flag a file talks ` +
                    `about is not a flag a file reads, and a HOLD claimed on an unread flag is a state ` +
                    `nothing gates — which is the opposite of a hold.`
                : `${m.key}.${s.name}: ${h.readBy} never reads ${h.flag}, so the writer is not actually gated ` +
                    `by the flag this entry claims holds it.`,
            );
          }
        }
      } else if (s.hold) {
        problems.push(`${m.key}.${s.name}: declares a hold gate but is classified ${s.classification}.`);
      }

      // Consumers are how a non-reachable state proves what it costs.
      const needsConsumers =
        s.classification === "OWNER_BLOCKED" ||
        s.classification === "DECLARED_UNUSED" ||
        s.classification === "MISSING_WRITER";
      if (needsConsumers && (s.consumers ?? []).length === 0) {
        problems.push(
          `${m.key}.${s.name}: ${s.classification} must list the files that CONSUME the state. That list is ` +
            `the difference between a gate nobody can open and a label nobody uses.`,
        );
      }
      // A derived lifecycle's state names appear nowhere in the code, so a
      // consumer proves itself by reading one of the derivation columns or by
      // calling one of the declared accessors instead. Requiring the label there
      // would fail correct code — which is how a guard gets switched off.
      const derived = m.vocabulary.kind === "derived" ? m.vocabulary : null;
      const consumerTokens = derived
        ? [s.name, ...derived.columns, ...(derived.accessors ?? [])]
        : [s.name];
      for (const c of s.consumers ?? []) {
        const abs = join(SRC, c);
        const text = note(abs);
        const code = text === null ? "" : codeText(text, abs.endsWith(".sql") ? "sql" : "ts");
        if (text === null) {
          problems.push(`${m.key}.${s.name}: declared consumer ${c} does not exist.`);
        } else if (!consumerTokens.some((tok) => code.includes(tok))) {
          problems.push(
            consumerTokens.some((tok) => text.includes(tok))
              ? `${m.key}.${s.name}: declared consumer ${c} names ${consumerTokens.map((t2) => `"${t2}"`).join(" / ")} ` +
                  `only in a COMMENT. Prose about a state is not a consumer of it, and a consumer list ` +
                  `built from prose cannot show what the missing state COSTS — which is the only thing ` +
                  `the list is for.`
              : `${m.key}.${s.name}: declared consumer ${c} never mentions ` +
                  `${consumerTokens.map((t2) => `"${t2}"`).join(" / ")} — it stopped consuming, or it never did.`,
          );
        }
      }

      // ── 9. a state is only as reachable as its best writer ────────────────
      if (inc.length === 0) {
        if (s.classification !== "DECLARED_UNUSED" && s.classification !== "MISSING_WRITER") {
          problems.push(
            `${m.key}.${s.name}: classified ${s.classification} with NO transition into it. Either a ` +
              `writer exists and is unregistered, or the state is unwritten and the honest ` +
              `classification is DECLARED_UNUSED (nothing is starved) or MISSING_WRITER (something is).`,
          );
        }
      } else {
        if (s.classification === "DECLARED_UNUSED") {
          problems.push(`${m.key}.${s.name}: DECLARED_UNUSED but ${inc.length} transition(s) write it.`);
        } else {
          const best = inc.reduce((a, b) => (CLASSIFICATION_RANK[b] < CLASSIFICATION_RANK[a] ? b : a));
          if (best !== s.classification) {
            problems.push(
              `${m.key}.${s.name}: classified ${s.classification}, but its most reachable writer is ` +
                `${best}. A state is exactly as reachable as the easiest way into it.`,
            );
          }
        }
      }
    }

    // ── 11. pins ────────────────────────────────────────────────────────────
    for (const pin of OWNER_DECISION_PINS) {
      if (pin.machine !== m.key) continue;
      const s = byName.get(pin.state);
      if (!s) {
        problems.push(
          `${m.key}: PINNED state "${pin.state}" is no longer registered. It is pinned because a person ` +
            `owes the ${pin.decision} decision; deleting the entry does not take the decision.`,
        );
        continue;
      }
      if (s.classification !== "OWNER_BLOCKED" || s.ownerDecision?.id !== pin.decision) {
        problems.push(
          `${m.key}.${pin.state}: PIN VIOLATED — must be OWNER_BLOCKED on ${pin.decision}, found ` +
            `${s.classification}${s.ownerDecision ? ` on ${s.ownerDecision.id}` : ""}. This pin is NOT ` +
            `satisfiable by implementing the writer: lib/eventLifecycle.ts already implements it and is ` +
            `started from index.ts, and it writes nothing because 2600 seeds ` +
            `event_start_transition_enabled FALSE. Flipping that flag does not close this — it TAKES the ` +
            `owner's decision (derived vs host-initiated) and moves 96 production events on its first ` +
            `pass. Lift the pin only when the decision is recorded as taken, in the same commit.`,
        );
      }
    }

    const sum = summarize(m);
    reports.push(
      `  ${m.key.padEnd(30)} ${`${m.storage}.${m.field}`.padEnd(46)} ` +
        `${m.states.length} state(s), ${m.transitions.length} transition(s)` +
        `${sum.terminal.length ? `; terminal: ${sum.terminal.join(",")}` : ""}` +
        `${sum.manual.length ? `; ops: ${sum.manual.join(",")}` : ""}` +
        `${sum.hold.length ? `; HOLD: ${sum.hold.join(",")}` : ""}` +
        `${sum.ownerBlocked.length ? `; OWNER_BLOCKED: ${sum.ownerBlocked.join(",")}` : ""}`,
    );
  }

  console.log(
    `check:state-machine-writers — ${MACHINES.length} machine(s), ${totalStates} state(s), ` +
      `${totalTransitions} transition(s); ${filesRead.size} declared file(s) opened, ${tree.length} file(s) in the tree`,
  );

  // ── 12. non-vacuity ───────────────────────────────────────────────────────
  if (
    MACHINES.length < MIN_MACHINES ||
    totalStates < MIN_STATES ||
    totalTransitions < MIN_TRANSITIONS ||
    tree.length < MIN_FILES_SCANNED ||
    filesRead.size === 0
  ) {
    console.error(
      `\nFAIL — VACUOUS: ${MACHINES.length} machine(s) (min ${MIN_MACHINES}), ${totalStates} state(s) ` +
        `(min ${MIN_STATES}), ${totalTransitions} transition(s) (min ${MIN_TRANSITIONS}), ` +
        `${tree.length} file(s) in the tree (min ${MIN_FILES_SCANNED}), ${filesRead.size} file(s) opened. ` +
        `A check that examines nothing must not report success.`,
    );
    process.exit(1);
  }

  if (problems.length) {
    console.error(`\nFAIL — ${problems.length} problem(s):`);
    for (const p of problems) console.error(`  • ${p}`);
    console.error("");
    process.exit(1);
  }

  for (const r of reports) console.log(r);
  const owner = MACHINES.flatMap((m) => m.states.filter((s) => s.classification === "OWNER_BLOCKED"));
  const hold = MACHINES.flatMap((m) => m.states.filter((s) => s.classification === "HOLD"));
  const unused = MACHINES.flatMap((m) => m.states.filter((s) => s.classification === "DECLARED_UNUSED"));
  console.log(
    `\n✅ every registered state has a writer that can reach it, or a recorded reason it cannot be reached: ` +
      `${owner.length} OWNER_BLOCKED, ${hold.length} HOLD, ${unused.length} DECLARED_UNUSED, 0 MISSING_WRITER.`,
  );
}

const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  main();
}

export { main as runStateMachineWriterCheck };
