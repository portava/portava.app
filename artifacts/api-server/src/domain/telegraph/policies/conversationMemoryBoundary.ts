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
 * 0, one level of call into the same file or an imported module, string-level
 * table names, comments stripped. A path built from a computed table name, or
 * reached through two levels of indirection, is not seen. It never claimed to
 * be a proof; it is the tripwire §29 asked for where there was none.
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
