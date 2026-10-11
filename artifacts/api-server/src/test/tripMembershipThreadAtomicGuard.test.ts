/**
 * census-telegraph T319 / migration 3763 — the static half of "every trip-
 * membership writer ends the thread membership in the same transaction".
 *
 * 3763 routes EVERY writer by construction: an AFTER ROW trigger on
 * `trip_members` itself, so the flag-off route statements, `trip_kernel_execute`,
 * the `profiles` cascades and any future rpc all fire it. What can still break
 * that is TEXT — and this file pins it, without a database:
 *
 *   1. the trigger covers every verb that can end a membership: DELETE, and an
 *      UPDATE of role / status / user_id / trip_id (an INSERT cannot end one);
 *      it is AFTER (it sees the committed shape of the write) and FOR EACH ROW;
 *   2. its function is SECURITY DEFINER with a pinned search_path, and EXECUTE is
 *      revoked from PUBLIC, anon and authenticated;
 *   3. no LATER migration drops or disables it (a migration that wants to must
 *      edit this test, which is the conversation that should happen);
 *   4. the set it treats as crew CONTAINS the set both sync helpers reconcile the
 *      thread to — so the trigger can never end a thread row the sync would
 *      keep; and it equals 3972's accepted-crew rule, the one requireTripMember
 *      applies;
 *   5. the rollback drops exactly the trigger and the function.
 *
 * Executed proof is src/test/db/tripMembershipThreadAtomic.db.test.ts (real
 * kernel, CI local-db job) and the PGlite rehearsal named in docs/migrations.md.
 *
 * Run: node --import tsx/esm --test src/test/tripMembershipThreadAtomicGuard.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API = path.resolve(HERE, "../..");
const MIGRATIONS = path.join(API, "src/migrations");
const FILE = "3763_trip_membership_thread_atomic.sql";
const ROLLBACK = path.resolve(API, "../../db/rollback/2026-10-11-3763-trip-membership-thread-atomic-rollback.sql");

/** SQL with `--` comments removed, so prose about a statement is never the statement. */
const code = (sql: string): string => sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
const read = (p: string): string => readFileSync(p, "utf8");
const mig = code(read(path.join(MIGRATIONS, FILE)));

/** The quoted roles inside the first `IN (...)` after `anchor`. */
function roleSet(text: string, anchor: RegExp): string[] {
  const at = text.search(anchor);
  assert.ok(at >= 0, `anchor ${anchor} not found`);
  const m = /IN\s*\(([^)]*)\)/.exec(text.slice(at));
  assert.ok(m, `no IN (...) after ${anchor}`);
  return [...m![1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]!).sort();
}

describe("3763: the trigger every trip-membership writer fires", () => {
  it("covers DELETE and UPDATE OF role, status, user_id, trip_id — AFTER, FOR EACH ROW, on trip_members", () => {
    assert.match(
      mig,
      /CREATE TRIGGER trip_members_end_thread_membership\s+AFTER DELETE OR UPDATE OF role, status, user_id, trip_id ON public\.trip_members\s+FOR EACH ROW EXECUTE FUNCTION public\.trip_members_end_thread_membership\(\);/,
    );
  });

  it("its function is SECURITY DEFINER with a pinned search_path, and no client role may execute it", () => {
    const fn = /CREATE OR REPLACE FUNCTION public\.trip_members_end_thread_membership\(\)[\s\S]*?\$fn\$;/.exec(mig)?.[0] ?? "";
    assert.ok(fn, "function body not found");
    assert.match(fn, /RETURNS trigger/);
    assert.match(fn, /SECURITY DEFINER/);
    assert.match(fn, /SET search_path TO 'public', 'pg_catalog'/);
    assert.match(mig, /REVOKE ALL ON FUNCTION public\.trip_members_end_thread_membership\(\) FROM PUBLIC, anon, authenticated;/);
    assert.doesNotMatch(mig, /GRANT [^;]*ON FUNCTION public\.trip_members_end_thread_membership\(\) TO [^;]*(anon|authenticated)/);
  });

  it("ends only the person's row on that trip's thread, only while active, and never adds anyone", () => {
    const upd = /UPDATE public\.message_thread_members tm[\s\S]*?;/.exec(mig)?.[0] ?? "";
    for (const clause of [/SET left_at = now\(\)/, /th\.thread_type = 'trip'/, /th\.trip_id = OLD\.trip_id/, /tm\.user_id = OLD\.user_id/, /tm\.left_at IS NULL/]) {
      assert.match(upd, clause);
    }
    assert.doesNotMatch(mig, /INSERT INTO public\.message_thread_members/);
    assert.doesNotMatch(mig, /left_at\s*=\s*NULL/i);
  });

  it("no later migration drops or disables it", () => {
    const later = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql") && f > FILE);
    const offenders = later.filter((f) => {
      const t = code(read(path.join(MIGRATIONS, f)));
      return /DROP TRIGGER[^;]*trip_members_end_thread_membership/i.test(t)
        || /DROP FUNCTION[^;]*trip_members_end_thread_membership/i.test(t)
        || /ALTER TABLE[^;]*trip_members[^;]*DISABLE TRIGGER/i.test(t);
    });
    assert.deepEqual(offenders, [], "a later migration removes or disables 3763's trigger — edit this guard only with the T319 argument in hand");
  });

  it("its crew set contains the set both sync helpers reconcile the thread to, and equals 3972's accepted-crew rule", () => {
    const trigger = roleSet(mig, /is_crew := coalesce\(NEW\.role::text, ''\)/);
    for (const rel of ["src/lib/chatSync.ts", "src/services/groupChatSync.ts"]) {
      const m = /\.from\('trip_members'\)[\s\S]*?\.in\('role', \[([^\]]*)\]\)/.exec(read(path.join(API, rel)));
      assert.ok(m, `${rel}: the accepted-member read was not found`);
      const sync = [...m![1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]!);
      for (const r of sync) assert.ok(trigger.includes(r), `${rel} keeps role '${r}' on the thread; the trigger would end it`);
    }
    const anchors = code(read(path.join(MIGRATIONS, "3972_trip_private_anchor_rls_and_grant_lifecycle.sql")));
    assert.deepEqual(trigger, roleSet(anchors, /is_accepted\s*:=/), "3763's crew rule drifted from 3972's");
    assert.match(mig, /coalesce\(NEW\.status, 'accepted'\) = 'accepted'/, "a non-accepted status must count as not crew");
  });

  it("the rollback drops exactly the trigger and the function", () => {
    const rb = code(read(ROLLBACK));
    assert.match(rb, /DROP TRIGGER IF EXISTS trip_members_end_thread_membership ON public\.trip_members;/);
    assert.match(rb, /DROP FUNCTION IF EXISTS public\.trip_members_end_thread_membership\(\);/);
    assert.equal((rb.match(/\bDROP\b/g) ?? []).length, 2, "the rollback drops something else too");
  });
});
