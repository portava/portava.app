/**
 * A `void` supabase write that nothing continues is NEVER SENT.
 * `check:unissued-supabase-writes`.
 *
 * ── THE DEFECT ───────────────────────────────────────────────────────────────
 * PostgrestBuilder is a THENABLE, not a promise. It builds its headers and calls
 * `_fetch` inside `then()` — verified in the installed
 * @supabase/postgrest-js@2.108.2, `PostgrestBuilder.ts:267-311`. So
 *
 *     void sc.from("buddy_booking_events").insert({ ... });
 *
 * constructs a request object and throws it away. No HTTP call is made. Not a
 * lost error, not an unawaited race — the write does not happen at all.
 *
 * Measured, not reasoned: with a counting fetch installed on a real client,
 *
 *     void ….insert({...})                     -> fetch called 0 times
 *     void ….insert({...}).then(undefined, …)  -> fetch called 1 time
 *     await ….insert({...})                    -> fetch called 1 time
 *
 * ── WHY IT SURVIVED ──────────────────────────────────────────────────────────
 * It looks exactly like the fire-and-forget idiom used correctly elsewhere in
 * this tree — `routes/reports.ts` and `routes/compass.ts` write
 * `void ….insert(…).then(undefined, () => {})`, which DOES send. The difference
 * is one chained call, and nothing about the shorter form reads as broken.
 *
 * And no test caught it because a test fake cannot: `src/test/rentABuddy.test.ts`
 * captures inserted rows EAGERLY inside `.insert()`, with a comment recording
 * that "the production code issues `void serviceClient.from(table).insert(...)` —
 * `_resolve()` is never reached". The fake was written around the defect, so the
 * suite proved the row was constructed and never that it was sent.
 *
 * That is why this guard is static rather than a test: the only witness that can
 * tell the two apart is the real client, and the real client is exactly what the
 * suites replace.
 *
 * ── WHAT IS ENFORCED ─────────────────────────────────────────────────────────
 *   A `void` expression statement whose expression is a supabase mutation chain
 *   (.from(…) or .rpc(…) with .insert/.update/.upsert/.delete) must continue it —
 *   `.then(…)`, `.catch(…)` or an `await` inside. Anything else is a write that
 *   is never issued.
 *
 * AST, not text: the unit is the `void` expression node, so a comment or a string
 * containing "then" cannot satisfy the rule, and a chain spanning twenty lines is
 * judged whole. Six guards in this tree shipped a bug from matching raw text.
 *
 * Scope: src/**, excluding src/test/** — a fake in a test may legitimately never
 * be sent, because there is nothing to send it to.
 *
 * ── VACUITY ──────────────────────────────────────────────────────────────────
 * Zero files scanned, or zero `void` statements of ANY kind found, exits non-zero:
 * a guard that examined nothing must not report success.
 *
 * Run: node --import tsx/esm src/scripts/checkUnissuedSupabaseWrites.ts
 * Exit 0 when every void supabase write is continued. Exit 1 otherwise.
 */
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import ts from "typescript";
import { listSourceFiles } from "./lib/tableAccessExtract.js";

const SRC = process.env.UNISSUED_WRITES_SRC ? resolve(process.env.UNISSUED_WRITES_SRC) : "src";
const MIN_FILES = Number(process.env.UNISSUED_WRITES_MIN_FILES ?? 100);
const MIN_VOIDS = Number(process.env.UNISSUED_WRITES_MIN_VOIDS ?? 1);

const MUTATION = /\.(insert|update|upsert|delete)\s*\(/;
const REACHES_DB = /\.(from|rpc)\s*\(/;
/** A continuation that actually invokes `then` and therefore sends the request. */
const CONTINUED = /\.then\s*\(|\.catch\s*\(|\bawait\b/;

export interface Unissued {
  file: string;
  line: number;
  table: string;
  verb: string;
  excerpt: string;
}

export function scanFile(src: string, file: string): { hits: Unissued[]; voidsSeen: number } {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const hits: Unissued[] = [];
  let voidsSeen = 0;
  const visit = (n: ts.Node): void => {
    if (ts.isVoidExpression(n)) {
      voidsSeen += 1;
      const t = n.expression.getText(sf);
      if (REACHES_DB.test(t) && MUTATION.test(t) && !CONTINUED.test(t)) {
        hits.push({
          file,
          line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
          table: (t.match(/\.from\(\s*["'`]([a-z0-9_]+)["'`]/) ?? [])[1] ?? "(dynamic)",
          verb: (t.match(MUTATION) ?? [])[1] ?? "?",
          excerpt: t.replace(/\s+/g, " ").slice(0, 110),
        });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { hits, voidsSeen };
}

function main(): void {
  const files = listSourceFiles(SRC).filter((f) => !f.includes("/test/"));
  const all: Unissued[] = [];
  let voidsSeen = 0;
  for (const f of files) {
    const r = scanFile(readFileSync(f, "utf8"), relative(process.cwd(), f));
    all.push(...r.hits);
    voidsSeen += r.voidsSeen;
  }

  console.log(
    `check:unissued-supabase-writes — ${files.length} file(s), ${voidsSeen} void statement(s) examined, ` +
      `${all.length} write(s) never issued`,
  );

  if (files.length < MIN_FILES || voidsSeen < MIN_VOIDS) {
    console.error(
      `\nFAIL — VACUOUS: scanned ${files.length} file(s) (min ${MIN_FILES}) and found ${voidsSeen} void ` +
        `statement(s) (min ${MIN_VOIDS}). A check that examined nothing must not report success.`,
    );
    process.exit(1);
  }

  if (all.length > 0) {
    console.error(`\nFAIL — ${all.length} supabase write(s) are constructed and NEVER SENT:`);
    for (const h of all) {
      console.error(`  ${h.file}:${h.line}  ${h.verb} ${h.table}`);
      console.error(`      ${h.excerpt}`);
    }
    console.error(
      "\nPostgrestBuilder issues its request inside then(). A `void` chain with no .then/.catch/await " +
        "constructs the request and discards it — the row is never written. Chain `.then(undefined, () => {})` " +
        "to keep it fire-and-forget, or await it and handle the error.\n",
    );
    process.exit(1);
  }
  console.log("\n✅ every void supabase write is continued, so every one is actually sent.");
}

if (process.argv[1] && resolve(process.argv[1]).endsWith("checkUnissuedSupabaseWrites.ts")) main();
