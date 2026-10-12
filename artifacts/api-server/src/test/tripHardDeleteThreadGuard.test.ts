/**
 * OD-1012-DEL-1 / migration 3770 — the static half of "a trip that still has its
 * conversation is refused a hard delete, typed, before anything cascades; the
 * conversation's fate stays an open owner decision".
 *
 * Executed proof is src/test/db/tripHardDeleteThreadGuard.db.test.ts (CI local-
 * db job, real chain) and the PGlite rehearsal named in docs/migrations.md. What
 * can still break the rule is TEXT, and this file pins it without a database:
 *
 *   1. the trigger is BEFORE DELETE FOR EACH ROW on trips (an AFTER trigger
 *      fires behind the foreign key's own action, which raises the raw 23514
 *      first), its function is SECURITY DEFINER with a pinned search_path (an
 *      owner hidden from the thread by RLS must still be refused by name), and no
 *      client role may execute it;
 *   2. the refusal is SQLSTATE PT409 and keys on ANY thread carrying the trip's
 *      id; it RETURNs OLD, so a trip with no thread deletes as before;
 *   3. 3770 decides nothing: it writes no thread, no message, no constraint and
 *      no foreign key;
 *   4. no later migration drops or disables the trigger, and none turns
 *      message_threads_trip_id_fkey into an ON DELETE CASCADE (the owner ruled
 *      out cascade-deleting chat history);
 *   5. no server code hard-deletes a trip (the product's "delete" archives); a
 *      path that wants to must arrive with the conversation's fate decided;
 *   6. the rollback drops exactly the trigger and the function.
 *
 * Run: node --import tsx/esm --test src/test/tripHardDeleteThreadGuard.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API = path.resolve(HERE, "../..");
const MIGRATIONS = path.join(API, "src/migrations");
const FILE = "3770_trip_hard_delete_thread_guard.sql";
const ROLLBACK = path.resolve(API, "../../db/rollback/2026-10-12-3770-trip-hard-delete-thread-guard-rollback.sql");

/** SQL with `--` comments removed, so prose about a statement is never the statement. */
const code = (sql: string): string => sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
const read = (p: string): string => readFileSync(p, "utf8");
const mig = code(read(path.join(MIGRATIONS, FILE)));
const fnBody = /CREATE OR REPLACE FUNCTION public\.trips_refuse_delete_with_thread\(\)[\s\S]*?\$fn\$;/.exec(mig)?.[0] ?? "";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== "test" && name !== "migrations") walk(p, out); }
    else if (/\.(ts|mts)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(p);
  }
  return out;
}

describe("3770: a trip with its conversation is refused a hard delete, typed, before anything moves", () => {
  it("BEFORE DELETE FOR EACH ROW on trips; SECURITY DEFINER, pinned search_path, no client EXECUTE", () => {
    assert.match(
      mig,
      /CREATE TRIGGER trips_refuse_delete_with_thread\s+BEFORE DELETE ON public\.trips\s+FOR EACH ROW EXECUTE FUNCTION public\.trips_refuse_delete_with_thread\(\);/,
    );
    assert.ok(fnBody, "function body not found");
    assert.match(fnBody, /RETURNS trigger/);
    assert.match(fnBody, /SECURITY DEFINER/);
    assert.match(fnBody, /SET search_path TO 'public', 'pg_catalog'/);
    assert.match(mig, /REVOKE ALL ON FUNCTION public\.trips_refuse_delete_with_thread\(\) FROM PUBLIC, anon, authenticated;/);
    assert.doesNotMatch(mig, /GRANT [^;]*ON FUNCTION public\.trips_refuse_delete_with_thread\(\) TO [^;]*(anon|authenticated)/);
  });

  it("refuses PT409 on any thread carrying the trip's id, and lets a thread-less trip through", () => {
    assert.match(fnBody, /IF EXISTS \(SELECT 1 FROM public\.message_threads th WHERE th\.trip_id = OLD\.id\) THEN/);
    assert.match(fnBody, /RAISE EXCEPTION 'trip_delete_refused: [^']*'/);
    assert.match(fnBody, /ERRCODE = 'PT409'/);
    assert.match(fnBody, /OD-1012-DEL-1/);
    assert.match(fnBody, /RETURN OLD;/);
    assert.doesNotMatch(fnBody, /RETURN NULL/);
  });

  it("decides nothing: no thread, message, constraint or foreign key is written", () => {
    for (const forbidden of [
      /\b(INSERT INTO|UPDATE|DELETE FROM)\s+public\.(message_threads|messages|message_thread_members)\b/i,
      /ALTER TABLE[^;]*\bmessage_threads\b/i,
      /\bDROP CONSTRAINT\b/i,
      /\bADD CONSTRAINT\b/i,
      /\bON DELETE CASCADE\b/i,
    ]) assert.doesNotMatch(mig, forbidden);
  });

  it("no later migration drops or disables the trigger, or cascades the trip FK into chat history", () => {
    const later = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql") && f > FILE);
    const offenders = later.filter((f) => {
      const t = code(read(path.join(MIGRATIONS, f)));
      return /DROP TRIGGER[^;]*trips_refuse_delete_with_thread/i.test(t)
        || /DROP FUNCTION[^;]*trips_refuse_delete_with_thread/i.test(t)
        || /ALTER TABLE[^;]*\btrips\b[^;]*DISABLE TRIGGER/i.test(t)
        || /message_threads_trip_id_fkey[^;]*ON DELETE CASCADE/i.test(t);
    });
    assert.deepEqual(offenders, [], "a later migration removes 3770's refusal or cascades trip deletion into chat history — that is OD-1012-DEL-1's decision, not a migration's");
  });

  it("no server code hard-deletes a trip (the product's delete archives)", () => {
    const src = path.join(API, "src");
    const offenders = walk(src).filter((p) => /\.from\(\s*["'`]trips["'`]\s*\)\s*\.delete\(/.test(read(p)))
      .map((p) => path.relative(API, p));
    assert.deepEqual(offenders, [], "a server path hard-deletes trips: decide the conversation's fate (OD-1012-DEL-1) first");
  });

  it("the rollback drops exactly the trigger and the function", () => {
    const rb = code(read(ROLLBACK));
    assert.match(rb, /DROP TRIGGER IF EXISTS trips_refuse_delete_with_thread ON public\.trips;/);
    assert.match(rb, /DROP FUNCTION IF EXISTS public\.trips_refuse_delete_with_thread\(\);/);
    assert.equal((rb.match(/\bDROP\b/g) ?? []).length, 2, "the rollback drops something else too");
  });
});
