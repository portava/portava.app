/**
 * Table access extraction — the AST half of `check:writerless-reads`.
 *
 * THE DEFECT THIS EXISTS FOR
 * --------------------------
 * Code that reads a table NOTHING ever writes. Every read returns zero rows, in
 * every environment, permanently — and because a query against an empty table
 * is indistinguishable from a query against an empty fixture, no test can see
 * it. Two confirmed instances, both of which survived years of review:
 *
 *   `activity_events` — read by four of the five CreatorActivityScore
 *   components plus both penalties. Its only writer was an internal-secret-
 *   gated route that nothing called, so 0.70 of the score's weight was
 *   structurally zero. The scheduler that fed it had the same shape twice over:
 *   its candidate pool was (rows written only by itself) UNION (activity_events
 *   actors), so no creator was ever scored a first time. Fixed 2026-09-06.
 *
 *   `public.circles` — seven readers, no writer anywhere: not server TS, not
 *   client TS, not SQL, and no circle-creation UI. One of those readers is an
 *   AUTHORIZATION predicate (routes/locateFriends.ts), so it denies every user,
 *   permanently and silently. Fail-closed, so nothing leaks — but the guarded
 *   resource is unreachable.
 *
 * Neither is visible to any existing guard. `check:enum-literals` judges filter
 * VALUES, `check:schema-references` judges that columns EXIST, and
 * `check:write-path-columns` judges columns against the live schema. All three
 * pass happily on a query that is perfectly well-formed and matches nothing.
 *
 * WHY AN AST AND NOT A REGEX
 * --------------------------
 * This check was first prototyped with a regex and it was WRONG in a way worth
 * recording, because the failure is silent and the output looks plausible:
 *
 *     /\.from\(["'](\w+)["']\)[\s\S]{0,400}?\.(insert|upsert)\(/
 *
 * Regex matches do not overlap. An earlier `.from("circle_invites")` consumed
 * the text through a LATER `.upsert(`, so the `from("circle_memberships")`
 * sitting between them never got to start its own match and the table was
 * reported as having no writer. That single bug turned 377 real writers into
 * 350 and produced 41 false dead tables instead of 16 — a 60% false-positive
 * rate on a check meant to gate CI.
 *
 * A zero-width lookahead fixes the regex, and a parser removes the class. The
 * parser also does what no regex can: it ignores comments (a text scan reports
 * commented-out code and prose describing an already-fixed defect), and it
 * follows chains that span statements.
 *
 * CHAINS THAT SPAN STATEMENTS
 * ---------------------------
 * The write is very often not in the same expression as the `.from()`:
 *
 *     const q = sc.from("posts");
 *     …
 *     const { error } = await q.insert(row);
 *
 * so identifiers are bound to their table first, exactly as filterLiteralExtract
 * does, and an identifier bound to two tables in one file is DROPPED rather than
 * guessed at. A wrong binding here would report a real writer as missing, which
 * is the one outcome this check must never have.
 *
 * FAILURE POSTURE: over-permissive by construction
 * ------------------------------------------------
 * Anything ambiguous counts as a WRITE, never as a read-only. A dynamic
 * `.from(expr)` marks every table unjudgeable. The cost of a miss is one more
 * dead lane surviving; the cost of a false positive is blocking unrelated work
 * on a table that is written somewhere this cannot see.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

/** Chain methods that mutate. `.delete()` counts: it proves rows can exist. */
const WRITE_METHODS = new Set(["insert", "upsert", "update", "delete"]);

export interface TableAccess {
  table: string;
  file: string;
  line: number;
  kind: "read" | "write";
  /**
   * For a write: the `router.<verb>("<path>")` handler enclosing it, when the
   * write happens inside one, plus whether that handler is gated on the
   * internal-service secret. This is what separates a table that genuinely has
   * a producer from one whose only producer is unreachable — the exact shape of
   * `activity_events`, whose sole writer sat behind
   * POST /internal/activity-events with no caller anywhere.
   */
  routePath?: string;
  internalGated?: boolean;
}

export interface AccessResult {
  reads: Map<string, TableAccess[]>;
  writes: Map<string, TableAccess[]>;
  filesScanned: number;
  /** True when any `.from(<non-literal>)` was seen — the result is then partial. */
  sawDynamicFrom: boolean;
}

export function listSourceFiles(dir: string, exts = [".ts", ".tsx"]): string[] {
  const out: string[] = [];
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const entry of entries.sort()) {
    if (entry === "node_modules" || entry === "dist" || entry === "__tests__") continue;
    const full = join(dir, entry);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) { out.push(...listSourceFiles(full, exts)); continue; }
    if (!exts.some((e) => entry.endsWith(e))) continue;
    if (entry.endsWith(".d.ts") || entry.endsWith(".test.ts") || entry.endsWith(".test.tsx")) continue;
    if (entry === "database.types.ts") continue; // generated, and it OVER-reports
    out.push(full);
  }
  return out;
}

/**
 * True when a `.from()` call is `supabase.storage.from("bucket")` rather than a
 * table read. Storage buckets are NOT tables: `.storage.from("stamp-artwork")`
 * and `.from("post-media")` would otherwise be reported as writerless tables,
 * which is exactly what the first run of this check did. The receiver is walked
 * rather than the name matched, because the chain is often
 * `getServiceClient().storage.from(...)` or `sc.storage.from(...)`.
 */
function isStorageFrom(call: ts.CallExpression): boolean {
  const callee = unwrap(call.expression);
  if (!ts.isPropertyAccessExpression(callee)) return false;
  let recv = unwrap(callee.expression);
  // `x.storage.from(...)` -> receiver of `.from` is `x.storage`
  if (ts.isPropertyAccessExpression(recv) && recv.name.text === "storage") return true;
  if (ts.isCallExpression(recv)) {
    const inner = unwrap(recv.expression);
    if (ts.isPropertyAccessExpression(inner) && inner.name.text === "storage") return true;
  }
  if (ts.isIdentifier(recv) && /storage/i.test(recv.text)) return true;
  return false;
}

const HTTP_VERBS = new Set(["get", "post", "put", "patch", "delete", "all", "use"]);

/**
 * The `router.<verb>("<path>", …)` call enclosing `node`, if any, together with
 * whether that handler body calls `requireInternalSecret`.
 *
 * Walking up from the write is what makes this precise: a file can hold twenty
 * routes, only one of which is internal-gated, so a file-level grep for
 * `requireInternalSecret` would mark every write in the file as gated.
 */
function enclosingRoute(node: ts.Node): { path: string; internal: boolean } | null {
  let cur: ts.Node | undefined = node;
  while (cur) {
    if (ts.isCallExpression(cur)) {
      const callee = unwrap(cur.expression);
      if (ts.isPropertyAccessExpression(callee) && HTTP_VERBS.has(callee.name.text)) {
        const arg = cur.arguments[0];
        if (arg && ts.isStringLiteralLike(arg)) {
          const body = cur.getText();
          return { path: arg.text, internal: /requireInternalSecret\s*\(/.test(body) };
        }
      }
    }
    cur = cur.parent;
  }
  return null;
}

/**
 * True when this `.from()` is the head of a chain that ends in a write.
 *
 * Without this, `sc.from("t").insert(row)` records BOTH a write and a read of
 * `t`, so a write-only table looks like it has a reader and the reader counts
 * everywhere are inflated by one per write site. The read half of this check is
 * about code that CONSUMES rows; the `.from()` that opens an insert consumes
 * nothing.
 */
function isWriteChain(fromCall: ts.CallExpression): boolean {
  let cur: ts.Node | undefined = fromCall.parent;
  while (cur) {
    if (ts.isPropertyAccessExpression(cur)) { cur = cur.parent; continue; }
    if (ts.isCallExpression(cur)) {
      const callee = unwrap(cur.expression);
      if (ts.isPropertyAccessExpression(callee) && WRITE_METHODS.has(callee.name.text)) return true;
      cur = cur.parent;
      continue;
    }
    if (
      ts.isAwaitExpression(cur) || ts.isParenthesizedExpression(cur) ||
      ts.isAsExpression(cur) || ts.isNonNullExpression(cur)
    ) { cur = cur.parent; continue; }
    return false;
  }
  return false;
}

function unwrap(expr: ts.Expression): ts.Expression {
  let cur = expr;
  while (
    ts.isParenthesizedExpression(cur) ||
    ts.isAsExpression(cur) ||
    ts.isNonNullExpression(cur) ||
    ts.isAwaitExpression(cur)
  ) {
    cur = cur.expression;
  }
  return cur;
}

/**
 * Walk DOWN a chain looking for `.from("<literal>")`. Returns the table name,
 * "<dynamic>" for a non-literal `.from()`, `id:<name>` when the chain bottoms
 * out on a bare identifier, or null.
 */
function chainRoot(expr: ts.Expression): string | null {
  let cur = unwrap(expr);
  for (;;) {
    if (ts.isCallExpression(cur)) {
      const callee = unwrap(cur.expression);
      if (ts.isPropertyAccessExpression(callee)) {
        if (callee.name.text === "from") {
          if (isStorageFrom(cur)) return null; // storage bucket, not a table
          const arg = cur.arguments[0];
          if (arg && ts.isStringLiteralLike(arg)) return arg.text;
          return "<dynamic>";
        }
        cur = unwrap(callee.expression);
        continue;
      }
      return null;
    }
    if (ts.isPropertyAccessExpression(cur)) { cur = unwrap(cur.expression); continue; }
    if (ts.isIdentifier(cur)) return `id:${cur.text}`;
    return null;
  }
}

/** identifier -> table, or null where the binding is ambiguous. */
function bindIdentifiers(sf: ts.SourceFile): Map<string, string | null> {
  const bound = new Map<string, string | null>();
  const note = (name: string, table: string): void => {
    if (!bound.has(name)) { bound.set(name, table); return; }
    if (bound.get(name) !== table) bound.set(name, null); // refuse to guess
  };
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name)) {
      const r = chainRoot(node.initializer);
      if (r && !r.startsWith("id:") && r !== "<dynamic>") note(node.name.text, r);
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      const r = chainRoot(node.right);
      if (r && !r.startsWith("id:") && r !== "<dynamic>") note(node.left.text, r);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return bound;
}

/**
 * Collect every table access under `dirs`.
 *
 * A table is recorded as WRITTEN when any `.insert/.upsert/.update/.delete`
 * resolves back to it, and as READ for every other `.from()`. Both are recorded
 * — a table can be, and usually is, both.
 */
export function extractTableAccess(dirs: string[], repoRoot: string): AccessResult {
  const reads = new Map<string, TableAccess[]>();
  const writes = new Map<string, TableAccess[]>();
  let filesScanned = 0;
  let sawDynamicFrom = false;

  const push = (m: Map<string, TableAccess[]>, a: TableAccess): void => {
    if (!m.has(a.table)) m.set(a.table, []);
    m.get(a.table)!.push(a);
  };

  for (const dir of dirs) {
    for (const file of listSourceFiles(dir)) {
      let text: string;
      try { text = readFileSync(file, "utf8"); } catch { continue; }
      filesScanned++;
      const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
      const bound = bindIdentifiers(sf);
      const rel = relative(repoRoot, file);

      const resolve = (expr: ts.Expression): string | null => {
        const r = chainRoot(expr);
        if (r === null) return null;
        if (r === "<dynamic>") { sawDynamicFrom = true; return null; }
        if (r.startsWith("id:")) return bound.get(r.slice(3)) ?? null;
        return r;
      };

      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          const callee = unwrap(node.expression);
          if (ts.isPropertyAccessExpression(callee)) {
            const method = callee.name.text;
            // `.from("t")` itself — the read record.
            if (method === "from" && !isStorageFrom(node) && !isWriteChain(node)) {
              const arg = node.arguments[0];
              if (arg && ts.isStringLiteralLike(arg)) {
                push(reads, {
                  table: arg.text,
                  file: rel,
                  line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
                  kind: "read",
                });
              } else {
                sawDynamicFrom = true;
              }
            } else if (WRITE_METHODS.has(method)) {
              const table = resolve(callee.expression);
              if (table) {
                const route = enclosingRoute(node);
                push(writes, {
                  table,
                  file: rel,
                  line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
                  kind: "write",
                  routePath: route?.path,
                  internalGated: route?.internal ?? false,
                });
              }
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
  }

  return { reads, writes, filesScanned, sawDynamicFrom };
}

/**
 * Tables written by SQL — migrations, the baseline, triggers and functions.
 *
 * Deliberately generous: any `INSERT INTO t`, `UPDATE t`, or a `COPY t FROM`
 * counts, wherever it appears, including inside a function body. A table seeded
 * or maintained by SQL is not a dead lane, and this check would rather miss a
 * dead table than block work on a live one.
 */
export function extractSqlWrittenTables(sqlFiles: string[]): Set<string> {
  const written = new Set<string>();
  const pats = [
    /INSERT\s+INTO\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi,
    /UPDATE\s+(?:ONLY\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s+SET/gi,
    /COPY\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s/gi,
  ];
  for (const f of sqlFiles) {
    let sql: string;
    try { sql = readFileSync(f, "utf8"); } catch { continue; }
    for (const p of pats) {
      p.lastIndex = 0;
      for (const m of sql.matchAll(p)) written.add(m[1]!.toLowerCase());
    }
  }
  return written;
}

/**
 * Names declared as VIEWS (including materialized views) anywhere in the schema.
 *
 * A view is never written directly — you write its underlying table — so a view
 * read with no writer is not a dead lane and must not be reported. `buddy_bookings`
 * and `buddy_profiles` are exactly this: they LOOK like abandoned pre-rename
 * tables sitting beside `rent_buddy_*`, and the first run of this check reported
 * both. They are views over the rent_buddy tables. Excluding views structurally
 * is right; ratcheting them would have recorded a non-defect as debt.
 */
export function extractViewNames(sqlFiles: string[]): Set<string> {
  const views = new Set<string>();
  const pat =
    /CREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi;
  for (const f of sqlFiles) {
    let sql: string;
    try { sql = readFileSync(f, "utf8"); } catch { continue; }
    pat.lastIndex = 0;
    for (const m of sql.matchAll(pat)) views.add(m[1]!.toLowerCase());
  }
  return views;
}

/**
 * Every STRING LITERAL value in a file, as a single searchable blob.
 *
 * Used to answer "does anything actually call this route?" — and it must be
 * literals, not raw text. The first version of that check searched file text
 * and was defeated immediately by PROSE: the doc comment above the route, and
 * the comments in this very file documenting the defect, all contain
 * "/internal/activity-events", so the route looked well-referenced and the
 * check stayed silent. A text scan cannot tell a caller from a description of a
 * caller; the parser can.
 */
export function collectStringLiterals(file: string): string {
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch { return ""; }
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const parts: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node)) parts.push(node.text);
    else if (ts.isTemplateExpression(node)) {
      parts.push(node.head.text);
      for (const span of node.templateSpans) parts.push(span.literal.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return parts.join("\u0000");
}

export function listSqlFiles(dirs: string[]): string[] {
  const out: string[] = [];
  for (const dir of dirs) {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const e of entries.sort()) {
      const full = join(dir, e);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) out.push(...listSqlFiles([full]));
      else if (e.endsWith(".sql")) out.push(full);
    }
  }
  return out;
}
