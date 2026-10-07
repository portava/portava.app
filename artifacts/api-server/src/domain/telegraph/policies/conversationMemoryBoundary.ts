/**
 * Telegraph §29 / §10.2 — no automatic Memory creation from private conversation history.
 *
 * Spec §29 (Non-Negotiable Developer Invariants) and §10.2, verbatim:
 *   "No automatic Memory creation from private conversation history."
 *   "Telegraph never automatically converts whole conversations into Memories."
 *
 * ── THE DEFECT THIS CLOSES ──────────────────────────────────────────────────
 * census-telegraph T366: "Unguarded absence: no conversation→Memory path exists,
 * and nothing would refuse one." The first half stopped being true when §10.2's
 * explicit Save-to-Memory landed (`routes/telegraphMemory.ts`, one message per
 * call, a private draft) — that is a conversation→Memory path, deliberately, and
 * it is the ONLY one. The second half was still true: nothing in the tree would
 * notice a second path being added, so the invariant held by coincidence.
 *
 * ── WHAT IS GUARDED, AS DATA ────────────────────────────────────────────────
 * Three closed lists, enforced by `src/test/telegraphConversationMemoryBoundary.test.ts`
 * over the whole server tree and every SQL migration:
 *
 *   CONVERSATION_HISTORY_TABLES — the tables that hold what people said to one
 *     another. Thread METADATA (`message_threads`, `message_thread_members`) is
 *     deliberately not on it: knowing that a thread exists is not history.
 *   MEMORY_CREATION_TABLES — every table whose rows ARE a Memory, its evidence,
 *     its projection or its outbox. Compass's own memory is on it too: an
 *     assistant that quietly "remembered" a private conversation would be the
 *     same violation reached by a different door.
 *   EXPLICIT_CONVERSATION_MEMORY_PATHS — the modules allowed to do both, each
 *     with the rule that makes it explicit rather than automatic. It has one
 *     entry, and a second entry is a reviewed product decision, not a refactor.
 *
 * A top-level unit (a route handler, a function, a const) that READS
 * conversation history and CREATES a memory row — by an insert, an upsert or a
 * memory-creating RPC, itself or through a same-file function or an imported
 * symbol it calls — and whose file is not on the third list is the violation.
 * The unit, not the file, is what is judged: `routes/events.ts` reads `messages`
 * in its chat handler and writes `passport_memories` in its convert-to-memory
 * handler, from the EVENT row; those are two units that never meet, and a
 * file-level rule would have called that a conversation→Memory path. So is a
 * SQL migration that does both in one file a violation.
 *
 * ── WHAT THIS DOES NOT CLAIM ────────────────────────────────────────────────
 * It is a STATIC guard over the shipped tree: top-level units split at column
 * 0, comments stripped. Since 2026-10-07 (foot of file) calls are followed to a
 * FIXPOINT across files, table and RPC names through the file's constants, an
 * unresolvable RPC fails closed, and the mobile tree is scanned. Still not seen:
 * a table name passed as an ARGUMENT, a call made only through JSX or a value.
 */

/** What people said to one another. Reading any of these is reading history. */
export const CONVERSATION_HISTORY_TABLES = [
  "messages",
  "message_translations",
  "message_edits",
  "message_attachments",
  "message_reactions",
  "saved_messages",
] as const;

/** Every table whose rows are a Memory, its evidence, its projection or its outbox. */
export const MEMORY_CREATION_TABLES = [
  "memories",
  "memory_items",
  "memory_episodes",
  "memory_evidence",
  "memory_events",
  "memory_domain_events",
  "memory_event_outbox",
  "memory_projections",
  "memory_relations",
  "passport_memories",
  "compass_memories",
] as const;

/**
 * Memory RPCs that CREATE or PROJECT memory rows. Erasure, retrieval, export,
 * reset and expiry sweeps destroy or read and are not creation.
 */
export const MEMORY_CREATION_RPCS = [
  "memory_kernel_execute",
  "project_user_memory",
  "project_user_memory_with_retraction",
  "project_inferred_preferences",
] as const;

export interface ExplicitConversationMemoryPath {
  /** Repo-relative module (from artifacts/api-server). */
  readonly file: string;
  /** Why this path is explicit rather than automatic. Checked by its own suite. */
  readonly rule: string;
  /** The suite that proves the rule. */
  readonly provedBy: string;
}

/**
 * The closed list. One entry: §10.2's Save-to-Memory, which promotes ONE message
 * the caller chose into a PRIVATE DRAFT, and refuses a thread, a list or "all"
 * by name.
 */
export const EXPLICIT_CONVERSATION_MEMORY_PATHS: readonly ExplicitConversationMemoryPath[] = [
  {
    file: "src/routes/telegraphMemory.ts",
    rule:
      "POST /me/memory-drafts takes a SINGULAR messageId the caller chose, writes exactly one row " +
      "with state='draft' and visibility='only_me' as literals, re-authorizes membership and the " +
      "§14.3 window at promotion, and refuses threadId / messageIds / conversationId / all by name.",
    provedBy: "src/test/telegraphMemory.test.ts",
  },
];

/** Strip block and line comments so an EXPLANATION is never counted as an offence. */
export function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

const FROM_RE = /\.from\(\s*["'`]([a-z_]+)["'`]\s*\)/g;
const RPC_RE = /\.rpc\(\s*["'`]([a-z_]+)["'`]/g;

/** Tables a source file reads or writes through `.from("…")`. */
export function tablesTouched(code: string): Set<string> {
  const out = new Set<string>();
  for (const m of code.matchAll(FROM_RE)) out.add(m[1]!);
  return out;
}

/**
 * Memory tables this source file CREATES rows in: a `.from("<memory table>")`
 * whose own chained statement — up to the next `;` or the next `.from(` —
 * calls `.insert(` or `.upsert(`, plus any memory-creating RPC.
 */
export function memoryCreationsIn(code: string): string[] {
  const memory = new Set<string>(MEMORY_CREATION_TABLES);
  const found: string[] = [];
  for (const m of code.matchAll(FROM_RE)) {
    const table = m[1]!;
    if (!memory.has(table)) continue;
    const start = (m.index ?? 0) + m[0].length;
    const rest = code.slice(start);
    const stops = [rest.indexOf(";"), rest.search(/\.from\(/)].filter((i) => i >= 0);
    const stmt = stops.length > 0 ? rest.slice(0, Math.min(...stops)) : rest;
    if (/\.(insert|upsert)\(/.test(stmt)) found.push(table);
  }
  const rpcs = new Set<string>(MEMORY_CREATION_RPCS);
  for (const m of code.matchAll(RPC_RE)) {
    if (rpcs.has(m[1]!)) found.push(`rpc:${m[1]}`);
  }
  return found;
}

/** Conversation-history tables this source file reads. */
export function conversationReadsIn(code: string): string[] {
  const history = new Set<string>(CONVERSATION_HISTORY_TABLES);
  return [...tablesTouched(code)].filter((t) => history.has(t));
}

/** A SQL file that both inserts into a memory table and selects from a history table. */
export function sqlCrossesBoundary(sql: string): boolean {
  const code = sql.replace(/--.*$/gm, "");
  const mem = MEMORY_CREATION_TABLES.join("|");
  const hist = CONVERSATION_HISTORY_TABLES.join("|");
  const inserts = new RegExp(`INSERT\\s+INTO\\s+(public\\.)?"?(${mem})"?\\b`, "i").test(code);
  const reads = new RegExp(`(FROM|JOIN)\\s+(public\\.)?"?(${hist})"?\\b`, "i").test(code);
  return inserts && reads;
}

// ── unit-level analysis ──────────────────────────────────────────────────────

export interface CodeUnit {
  /** Names this unit declares at top level (function / const / let). */
  readonly declares: readonly string[];
  readonly code: string;
}

/**
 * Split comment-stripped source into top-level units at column-0 starts of a
 * declaration or a router registration. A unit runs to the next such start.
 */
export function codeUnits(code: string): CodeUnit[] {
  const START = /^(?:export\s+default\s|export\s+(?:async\s+)?function\s|(?:async\s+)?function\s|export\s+(?:const|let)\s|(?:const|let)\s|router\.)/;
  const lines = code.split("\n");
  const units: CodeUnit[] = [];
  let buf: string[] = [];
  const flush = () => {
    if (buf.length === 0) return;
    const text = buf.join("\n");
    const declares: string[] = [];
    const m = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)|^(?:export\s+)?(?:const|let)\s+([A-Za-z0-9_$]+)/.exec(text);
    if (m) declares.push((m[1] ?? m[2])!);
    units.push({ declares, code: text });
    buf = [];
  };
  for (const line of lines) {
    if (START.test(line)) flush();
    buf.push(line);
  }
  flush();
  return units;
}

/** Local names bound by `import { a, b as c } from "<spec>"` / `import d from "<spec>"`. */
export function importedNames(code: string): Array<{ spec: string; names: string[] }> {
  const out: Array<{ spec: string; names: string[] }> = [];
  const re = /import\s+(?:type\s+)?([^;]*?)\s+from\s+["']([^"']+)["']/g;
  for (const m of code.matchAll(re)) {
    const clause = m[1]!;
    const names: string[] = [];
    const braces = /\{([^}]*)\}/.exec(clause);
    if (braces) {
      for (const part of braces[1]!.split(",")) {
        const t = part.trim().replace(/^type\s+/, "");
        if (!t) continue;
        const as = /\bas\s+([A-Za-z0-9_$]+)$/.exec(t);
        names.push(as ? as[1]! : t);
      }
    }
    const def = /^([A-Za-z0-9_$]+)/.exec(clause.trim());
    if (def && !clause.trim().startsWith("{")) names.push(def[1]!);
    const ns = /\*\s+as\s+([A-Za-z0-9_$]+)/.exec(clause);
    if (ns) names.push(ns[1]!);
    out.push({ spec: m[2]!, names });
  }
  return out;
}

function mentions(code: string, name: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9_$.])${name.replace(/\$/g, "\\$")}\\s*[(.]`).test(code);
}

export interface BoundaryCrossing {
  readonly unit: string;
  readonly reads: readonly string[];
  /** The memory creation reached: a table, an `rpc:` name, or `call:<name>`. */
  readonly creates: readonly string[];
}

/**
 * Units of ONE comment-stripped file that read conversation history and reach a
 * memory creation. `importedCreatorNames` are local names this file imported
 * from a module that creates memory rows.
 */
export function crossingsInFile(code: string, importedCreatorNames: ReadonlySet<string>): BoundaryCrossing[] {
  const units = codeUnits(code);
  const sameFileCreators = new Set<string>();
  for (const u of units) {
    if (memoryCreationsIn(u.code).length > 0) for (const d of u.declares) sameFileCreators.add(d);
  }
  const out: BoundaryCrossing[] = [];
  for (const u of units) {
    const reads = conversationReadsIn(u.code);
    if (reads.length === 0) continue;
    const creates = [...memoryCreationsIn(u.code)];
    for (const n of sameFileCreators) if (!u.declares.includes(n) && mentions(u.code, n)) creates.push(`call:${n}`);
    for (const n of importedCreatorNames) if (mentions(u.code, n)) creates.push(`call:${n}`);
    if (creates.length > 0) {
      const head = u.code.split("\n")[0]!.slice(0, 120);
      out.push({ unit: head, reads, creates });
    }
  }
  return out;
}

// ── Hardening (lane T, mission 4, 2026-10-07): the three holes §45c named ───
//
// census-telegraph §45c moved T366 back to W as "a tripwire with stated holes":
//   1. only a LITERAL `.rpc("…")` was recognised, and the memory kernel is
//      called as `sc.rpc(fn, …)` (lib/memoryCommandBus.ts), so a handler that
//      read `messages` and called `executeMemoryCommand(…CREATE_MEMORY…)` stayed
//      green;
//   2. `const HISTORY = "messages"; sc.from(HISTORY)` stayed green;
//   3. the mobile app was not scanned at all.
// And the header above stated a fourth: two levels of indirection were not
// seen. What follows closes all four:
//   1. an `.rpc(` whose name is not a literal is resolved through the file's
//      string constants, and an unresolved one COUNTS as a creation (fail
//      closed): the scan cannot prove it is not the memory kernel;
//   2. `.from(NAME)` is resolved through the file's string constants, and an
//      unresolved database `.from(expr)` counts as a possible history read AND,
//      chained to an insert or upsert, a possible memory creation;
//   3. the mobile tree is scanned (clientMemoryBoundary below and its suite);
//   4. reads and creations are carried through calls to a FIXPOINT across
//      files (`reachingNames`), not one level.

/** `const NAME = "literal"` declarations in one comment-stripped file (string literals of identifier characters only). */
export function stringConstsIn(code: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /(?:^|[\s;{])(?:export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=\n]+)?=\s*(["'`])([A-Za-z0-9_]+)\2/g;
  for (const m of code.matchAll(re)) out.set(m[1]!, m[3]!);
  return out;
}

/**
 * `const NAME = <expression>` whose expression names string constants or
 * literals — `const fn = highlight ? HIGHLIGHT_KERNEL_FN : MEMORY_KERNEL_FN` —
 * mapped to every value it can take. Plain-literal constants are included.
 */
export function constCandidatesIn(code: string, consts: ReadonlyMap<string, string> = stringConstsIn(code)): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [k, v] of consts) out.set(k, new Set([v]));
  for (const m of code.matchAll(/(?:^|[\s;{(])(?:export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=\n]+)?=\s*([^;\n]+)/g)) {
    if (out.has(m[1]!)) continue;
    const vals = new Set<string>();
    for (const lit of m[2]!.matchAll(/(["'`])([A-Za-z0-9_]+)\1/g)) vals.add(lit[2]!);
    for (const id of m[2]!.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) { const v = consts.get(id[0]); if (v) vals.add(v); }
    if (vals.size > 0) out.set(m[1]!, vals);
  }
  return out;
}

/** `.from(` receivers that are not a database client. */
const NON_DB_FROM_RECEIVER = /^(Array|Buffer|Object|Set|Map|String|Iterator|[A-Z][A-Za-z0-9]*Array)$/;

/** One `.from(...)` call: the table when it is known, or the unresolved expression. */
export interface FromSite {
  readonly table: string | null;
  readonly expr: string | null;
  /** Offset just past the call's opening argument, for statement scanning. */
  readonly end: number;
}

/** Every database `.from(` in a file, literal or not, with the table resolved where the file says what it is. */
export function fromSites(code: string, consts: ReadonlyMap<string, string> = stringConstsIn(code)): FromSite[] {
  const out: FromSite[] = [];
  const re = /([A-Za-z0-9_$\])!]*)\.from\(\s*(?:(["'`])([A-Za-z0-9_]+)\2|([A-Za-z_$][A-Za-z0-9_$.]*))/g;
  for (const m of code.matchAll(re)) {
    const receiver = (m[1] ?? "").replace(/.*\./, "");
    if (NON_DB_FROM_RECEIVER.test(receiver)) continue;
    const end = (m.index ?? 0) + m[0].length;
    if (m[3]) { out.push({ table: m[3], expr: null, end }); continue; }
    const ident = m[4]!;
    const resolved = consts.get(ident) ?? null;
    out.push({ table: resolved, expr: resolved ? null : ident, end });
  }
  return out;
}

/** The chained statement after a call: up to the next `;` or the next `.from(`. */
function statementAfter(code: string, end: number): string {
  const rest = code.slice(end);
  const stops = [rest.indexOf(";"), rest.search(/\.from\(/)].filter((i) => i >= 0);
  return stops.length > 0 ? rest.slice(0, Math.min(...stops)) : rest;
}

/**
 * Conversation-history READS in one unit, the table named by a literal or a
 * constant. A statement that inserts, upserts, updates or deletes is a write,
 * not a read of what people said (posting a booking card INTO a thread reads
 * nothing). An unresolved `.from(expr)` is reported as `?expr`; the suite
 * decides what to do with it.
 */
export function conversationReadsResolved(code: string, consts: ReadonlyMap<string, string>): string[] {
  const history = new Set<string>(CONVERSATION_HISTORY_TABLES);
  const out = new Set<string>();
  for (const s of fromSites(code, consts)) {
    if (s.table === null) { out.add(`?${s.expr}`); continue; }
    if (!history.has(s.table)) continue;
    if (/\.(insert|upsert|update|delete)\(/.test(statementAfter(code, s.end))) continue;
    out.add(s.table);
  }
  return [...out];
}

/**
 * The names an `.rpc(<expr>)` can call, from what the FILE says: a constant or
 * a constant expression; `obj.prop` → every `prop: "literal"` in the file (the
 * probe-table shape); a parameter of a NON-exported function → the argument
 * every same-file call passes in that position. `null` = cannot be resolved.
 */
export function rpcNameCandidates(expr: string, unitCode: string, fileCode: string, consts: ReadonlyMap<string, string>): Set<string> | null {
  const direct = constCandidatesIn(unitCode, consts).get(expr) ?? constCandidatesIn(fileCode, consts).get(expr);
  if (direct) return direct;
  const member = /^[A-Za-z_$][A-Za-z0-9_$]*\.([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(expr);
  if (member) {
    const vals = new Set<string>();
    for (const m of fileCode.matchAll(new RegExp(`\\b${member[1]}\\s*:\\s*(["'\`])([A-Za-z0-9_]+)\\1`, "g"))) vals.add(m[2]!);
    return vals.size > 0 ? vals : null;
  }
  const fn = /^(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(([^)]*)\)/.exec(unitCode.trim());
  if (!fn) return null;
  const params = fn[2]!.split(",").map((p) => p.trim().replace(/[:=?].*$/, "").trim());
  const idx = params.indexOf(expr);
  if (idx < 0) return null;
  const vals = new Set<string>();
  let calls = 0;
  for (const call of fileCode.matchAll(new RegExp(`(?<![A-Za-z0-9_$.])${fn[1]}\\s*\\(`, "g"))) {
    const start = (call.index ?? 0) + call[0].length;
    if (/\bfunction\s*$/.test(fileCode.slice(Math.max(0, (call.index ?? 0) - 24), call.index))) continue; // the declaration itself
    const arg = splitTopLevelArgs(fileCode, start)[idx];
    if (arg === undefined) return null;
    const lit = /^(["'`])([A-Za-z0-9_]+)\1$/.exec(arg.trim());
    const resolved = lit ? new Set([lit[2]!]) : (constCandidatesIn(fileCode, consts).get(arg.trim()) ?? null);
    if (resolved === null) return null;
    for (const v of resolved) vals.add(v);
    calls += 1;
  }
  return calls > 0 ? vals : null;
}

/** The top-level comma-separated arguments of a call whose `(` ends at `start`. */
function splitTopLevelArgs(code: string, start: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let cur = "";
  let quote: string | null = null;
  for (let i = start; i < code.length; i++) {
    const ch = code[i]!;
    if (quote) { cur += ch; if (ch === quote && code[i - 1] !== "\\") quote = null; continue; }
    if (ch === "'" || ch === '"' || ch === "`") { quote = ch; cur += ch; continue; }
    if (ch === "(" || ch === "{" || ch === "[") depth += 1;
    if (ch === ")" || ch === "}" || ch === "]") {
      if (depth === 0) { args.push(cur); return args; }
      depth -= 1;
    }
    if (ch === "," && depth === 0) { args.push(cur); cur = ""; continue; }
    cur += ch;
  }
  return args;
}

/** Memory creations in one unit: literal and constant tables, RPC names as far as the file resolves them, and — fail closed — the unresolved. */
export function memoryCreationsResolved(code: string, consts: ReadonlyMap<string, string>, fileCode: string = code): string[] {
  const memory = new Set<string>(MEMORY_CREATION_TABLES);
  const found: string[] = [];
  for (const s of fromSites(code, consts)) {
    if (s.table !== null && !memory.has(s.table)) continue;
    const rest = code.slice(s.end);
    const stops = [rest.indexOf(";"), rest.search(/\.from\(/)].filter((i) => i >= 0);
    const stmt = stops.length > 0 ? rest.slice(0, Math.min(...stops)) : rest;
    if (/\.(insert|upsert)\(/.test(stmt)) found.push(s.table ?? `?${s.expr}`);
  }
  const rpcs = new Set<string>(MEMORY_CREATION_RPCS);
  for (const m of code.matchAll(/\.rpc\(\s*(?:(["'`])([A-Za-z0-9_]+)\1|([A-Za-z_$][A-Za-z0-9_$.]*))/g)) {
    const names = m[2] ? new Set([m[2]]) : rpcNameCandidates(m[3]!, code, fileCode, consts);
    if (names === null) found.push(`rpc:?${m[3]}`);
    else for (const n of names) if (rpcs.has(n)) found.push(`rpc:${n}`);
  }
  return found;
}

/**
 * The FIXPOINT. For every file, the top-level names whose unit reaches `seed` —
 * itself, through a same-file name, or through a name imported from a file
 * whose same-named export reaches it — iterated until nothing changes, so any
 * depth of indirection is followed. `importsOf(file)` gives each import's
 * resolved target file (or null for a package) and the local names it binds.
 */
export function reachingNames(
  units: ReadonlyMap<string, readonly CodeUnit[]>,
  importsOf: (file: string) => ReadonlyArray<{ target: string | null; names: readonly string[]; defaultName?: string | null; namespace?: string | null }>,
  seed: (file: string, unitCode: string) => boolean,
): Map<string, Set<string>> {
  const reach = new Map<string, Set<string>>();
  for (const f of units.keys()) reach.set(f, new Set());
  let changed = true;
  while (changed) {
    changed = false;
    for (const [f, us] of units) {
      const mine = reach.get(f)!;
      const imported = new Set<string>();
      for (const imp of importsOf(f)) {
        if (!imp.target) continue;
        const theirs = reach.get(imp.target);
        if (!theirs) continue;
        for (const n of imp.names) if (theirs.has(n)) imported.add(n);
        if (imp.defaultName && theirs.has("default")) imported.add(imp.defaultName);
        if (imp.namespace && theirs.size > 0) imported.add(imp.namespace);
      }
      for (const u of us) {
        if (u.declares.every((d) => mine.has(d)) && u.declares.length > 0) continue;
        const hit = seed(f, u.code) ||
          [...mine].some((n) => !u.declares.includes(n) && mentions(u.code, n)) ||
          [...imported].some((n) => mentions(u.code, n));
        if (!hit) continue;
        for (const d of u.declares) if (!mine.has(d)) { mine.add(d); changed = true; }
        if (u.declares.length === 0 && /^export\s+default\s/.test(u.code) && !mine.has("default")) { mine.add("default"); changed = true; }
      }
    }
  }
  return reach;
}

/**
 * Units of one file that READ conversation history and CREATE a memory, each
 * possibly at any depth: `readers` / `creators` are the fixpoint's names for
 * this file and its imports. A unit names what it reached.
 */
export function crossingsTransitive(
  units: readonly CodeUnit[],
  reads: (unitCode: string) => readonly string[],
  creates: (unitCode: string) => readonly string[],
  readerNames: ReadonlySet<string>,
  creatorNames: ReadonlySet<string>,
): BoundaryCrossing[] {
  const out: BoundaryCrossing[] = [];
  for (const u of units) {
    const r = [...reads(u.code)];
    for (const n of readerNames) if (!u.declares.includes(n) && mentions(u.code, n)) r.push(`call:${n}`);
    if (r.length === 0) continue;
    const c = [...creates(u.code)];
    for (const n of creatorNames) if (!u.declares.includes(n) && mentions(u.code, n)) c.push(`call:${n}`);
    if (c.length > 0) out.push({ unit: u.code.split("\n")[0]!.slice(0, 120), reads: r, creates: c });
  }
  return out;
}

/**
 * Call trees that reach a conversation read AND a memory creation in DIFFERENT
 * branches, reviewed and found to carry no conversation content into the
 * memory. The fixpoint cannot tell "reaches both" from "flows one into the
 * other" — that is the price of following calls to any depth — so each entry
 * names the unit, the argument, and the pin that keeps the argument true. A
 * listed unit that stops crossing must be removed (the suite says so).
 */
export interface ReviewedNonFlow {
  readonly file: string;
  /** The unit's first line starts with this. */
  readonly unit: string;
  readonly why: string;
  /** The suite whose assertion keeps `why` true. */
  readonly pinnedBy: string;
}

export const REVIEWED_CALL_TREE_NON_FLOWS: readonly ReviewedNonFlow[] = [
  {
    file: "src/routes/compass.ts",
    unit: 'router.post("/compass/ask"',
    why:
      "The tool loop can read a Telegraph conversation (telegraph_search_conversation and friends) and hands " +
      "the result to the model; compressConversationIfDue later extracts preferences from the COMPASS " +
      "conversation's USER turns only (compass_conversation_messages, role = 'user'), never from tool results " +
      "or assistant turns, so nothing a Telegraph read returned reaches compass_memories.",
    pinnedBy: "src/test/telegraphConversationMemoryBoundary.test.ts",
  },
];
