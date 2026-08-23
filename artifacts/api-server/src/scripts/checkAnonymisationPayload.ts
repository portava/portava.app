/**
 * check-anonymisation-payload — an account-deletion step may not null a NOT NULL column.
 *
 * ── THE DEFECT THIS CLOSES ──────────────────────────────────────────────────
 * executeAccountDeletion's `anonymise_profile` step wrote `handle: null`.
 * public.profiles.handle is `text NOT NULL UNIQUE`, so the UPDATE raised 23502
 * on every invocation. That step is FATAL — the function returns before step 5
 * removes the auth user — while steps 1-3 (storage objects, posts, messages,
 * media, reactions, follows, devices, notifications, search history) have
 * already succeeded and are irreversible.
 *
 * The result was the exact inverse of a deletion: content destroyed, email
 * retained, and `user_deletion_requests` never marked completed, so the worker
 * re-selected the row forever and failed identically each time.
 *
 * It survived review because nothing exercised it: the worker flag
 * (account_deletion_worker_enabled) is false in production, the requests table
 * is empty, and no profile has ever been anonymised. The unit tests mock the
 * Supabase client, so a mocked .update() accepts a payload the real column
 * constraint rejects. A test suite cannot catch a schema violation it never
 * sends to a schema.
 *
 * ── WHAT THIS CHECKS ────────────────────────────────────────────────────────
 * Cross-references the literal payload in the source against the committed
 * baseline's NOT NULL columns. It is a static check on purpose: it needs no
 * database, so it runs in CI on every push, which is exactly where the original
 * defect would have been caught.
 *
 * Run: node --import tsx/esm src/scripts/checkAnonymisationPayload.ts
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BASELINE_PATH, notNullColumns } from "./parseBaselineSchema.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const SERVICE_PATH = resolve(__dir, "../services/accountDeletion/AccountDeletionService.ts");

/** One `.from("<table>").update({...})` payload found in the service source. */
interface Payload {
  table: string;
  /** Keys explicitly assigned the literal `null`. */
  nulled: string[];
}

/**
 * Extract every `.from("x")....update({ ... })` payload. Brace-counting rather
 * than a regex, because the payload spans lines and contains nested braces.
 */
export function extractUpdatePayloads(src: string): Payload[] {
  const out: Payload[] = [];
  const re = /\.from\(\s*["'`]([A-Za-z0-9_]+)["'`]\s*\)\s*(?:\r?\n\s*)?\.update\(\s*\{/g;

  for (let m = re.exec(src); m !== null; m = re.exec(src)) {
    const table = m[1];
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") depth--;
    }
    const body = src.slice(m.index + m[0].length, i - 1);

    const nulled: string[] = [];
    for (const line of body.split("\n")) {
      const stripped = line.replace(/\/\/.*$/, "").trim();
      const kv = /^([A-Za-z0-9_]+)\s*:\s*null\s*,?$/.exec(stripped);
      if (kv) nulled.push(kv[1]);
    }
    out.push({ table, nulled });
  }
  return out;
}

function main(): void {
  const src = readFileSync(SERVICE_PATH, "utf8");
  const baselineSql = readFileSync(BASELINE_PATH, "utf8");
  const payloads = extractUpdatePayloads(src);

  // A check that silently finds nothing is worse than no check — it reports
  // success forever after a refactor renames the call it was watching.
  if (payloads.length === 0) {
    console.error(
      "check-anonymisation-payload: FOUND NO .update() PAYLOAD in AccountDeletionService.\n" +
      "  The extractor is stale — refusing to report success on an unexamined file.",
    );
    process.exit(1);
  }

  const problems: string[] = [];
  let inspected = 0;

  for (const p of payloads) {
    const notNull = notNullColumns(baselineSql, p.table);
    if (notNull.size === 0) {
      problems.push(
        `${p.table}: not present in the baseline (or has no NOT NULL columns). ` +
        `Stale table name, or the baseline needs recapturing.`,
      );
      continue;
    }
    inspected++;
    for (const col of p.nulled) {
      if (notNull.has(col)) {
        problems.push(
          `${p.table}.${col} is NOT NULL in the baseline, but the deletion payload sets it to null. ` +
          `This UPDATE raises 23502 at runtime; if its step is fatal, deletion aborts after ` +
          `content has already been irreversibly removed.`,
        );
      }
    }
  }

  console.log(
    `\ncheck-anonymisation-payload: ${payloads.length} update payload(s), ${inspected} checked against the baseline`,
  );

  if (problems.length > 0) {
    console.error("\n✗ account-deletion UPDATE payload violates a NOT NULL column:\n");
    for (const p of problems) console.error(`   - ${p}`);
    console.error(
      "\n  Write a non-null placeholder instead. It must satisfy every constraint on the\n" +
      "  column (profiles.handle is also UNIQUE) and should be derived from the user id so\n" +
      "  the step stays idempotent across the worker's retries.\n",
    );
    process.exit(1);
  }

  console.log("✓ no deletion payload nulls a NOT NULL column.\n");
}

// Run only when executed directly. The test suite imports extractUpdatePayloads
// from this module, and a main() that fired on import would process.exit(1) the
// whole test run the moment the gate had something to report.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
