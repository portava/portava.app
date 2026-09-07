/**
 * featuredCounterAtomicity.test.ts
 *
 * C1 (docs/architecture/12 §3.3; 07 §3 D6): `profiles.featured_count` was
 * maintained by a read-modify-write increment — select the current value, then
 * `update({ featured_count: current + 1 })` — at four sites in
 * routes/adminFeatured.ts. `.agents/memory/counter-update-atomicity.md` records
 * that pattern as REJECTED in completion review and names the required form:
 * a SECURITY DEFINER RPC with a column allowlist and `GREATEST(0, col + delta)`,
 * plus a concurrency test proving parallel calls land exactly N.
 *
 * WHAT MAKES THE CONCURRENCY TEST HERE FALSIFIABLE
 * -----------------------------------------------
 * A concurrency test whose fake store applies every write atomically proves
 * nothing: the OLD code would pass it too, because the race lives in the gap
 * between the read and the write, and a store with no gap has no race. So the
 * store below is deliberately RACY — `select` and `update` each yield to the
 * event loop, exactly as two round trips to PostgREST do — and the suite runs
 * the SAME 25 parallel adjustments twice:
 *
 *   - through the RPC path (the fix)        -> must land exactly +25
 *   - through the read-modify-write fallback -> must LOSE increments
 *
 * The second is a negative control, not a bug being enshrined: it is the proof
 * that this harness can actually see the defect. If the fallback ever stops
 * losing increments under this store, the store has gone atomic and the first
 * assertion has quietly become vacuous — so that case fails loudly too.
 *
 * Runtime: node:test + node:assert (NOT vitest).
 * Run: pnpm --filter @workspace/api-server test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  adjustProfileCounter,
  PROFILE_COUNTER_RPC,
} from "../routes/adminFeatured.js";

const HERE      = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT  = resolve(HERE, "..");
const MIGRATION = resolve(SRC_ROOT, "migrations/2331_creator_counter_atomicity.sql");
const ROUTE     = resolve(SRC_ROOT, "routes/adminFeatured.ts");

const USER = "aaaaaaaa-0000-4000-8000-00000000f001";

/** Yield to the event loop, so an interleaving is actually possible. */
const tick = () => new Promise((r) => setTimeout(r, 0));

// ─── A deliberately racy fake profiles table ─────────────────────────────────

interface RacyClient {
  client: any;
  state: { featured_count: number | null };
  rpcCalls: Array<Record<string, unknown>>;
  updates: Array<Record<string, unknown>>;
}

/**
 * A fake Supabase client over ONE profiles row.
 *
 * `select` and `update` both await a tick before touching the store, so two
 * concurrent read-modify-write sequences interleave the way two PostgREST round
 * trips do. `rpc`, when present, mutates in a single synchronous step after its
 * own tick — which is what a single `UPDATE … SET c = GREATEST(0, c + $1)`
 * statement is: the read and the write cannot be separated by another writer.
 */
function makeRacyClient(opts: {
  withRpc: boolean;
  start?: number | null;
  rpcError?: { message: string } | null;
  readError?: { message: string } | null;
  /** When true the RPC reports success but reports NO row matched. */
  rpcNoRow?: boolean;
}): RacyClient {
  const state: { featured_count: number | null } = {
    featured_count: opts.start === undefined ? 0 : opts.start,
  };
  const rpcCalls: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];

  const client: any = {
    from(table: string) {
      assert.equal(table, "profiles", "the counter writer must only touch profiles");
      let patch: Record<string, unknown> | null = null;
      const chain: any = {
        select: () => chain,
        update: (p: Record<string, unknown>) => { patch = p; return chain; },
        eq: () => (patch === null ? chain : applyUpdate()),
        maybeSingle: async () => {
          await tick();
          if (opts.readError) return { data: null, error: opts.readError };
          return { data: { featured_count: state.featured_count }, error: null };
        },
      };
      async function applyUpdate() {
        await tick();
        updates.push(patch as Record<string, unknown>);
        state.featured_count = Number((patch as any).featured_count);
        return { error: null };
      }
      return chain;
    },
  };

  if (opts.withRpc) {
    client.rpc = async (fn: string, args: Record<string, unknown>) => {
      await tick();
      rpcCalls.push({ fn, ...args });
      if (opts.rpcError) return { data: null, error: opts.rpcError };
      if (opts.rpcNoRow) return { data: null, error: null };
      // The single-statement semantics of GREATEST(0, COALESCE(col,0) + delta):
      // read and write are one indivisible step, with no await between them.
      const next = Math.max(0, Number(state.featured_count ?? 0) + Number(args.p_delta));
      state.featured_count = next;
      return { data: next, error: null };
    };
  }

  return { client, state, rpcCalls, updates };
}

// ─── THE CONCURRENCY TEST ────────────────────────────────────────────────────

const N = 25;

describe("featured_count under concurrency", () => {
  it(`lands exactly +${N} for ${N} parallel increments through the atomic RPC`, async () => {
    const h = makeRacyClient({ withRpc: true, start: 0 });

    await Promise.all(
      Array.from({ length: N }, () => adjustProfileCounter(h.client, USER, "featured_count", +1)),
    );

    assert.equal(
      h.state.featured_count, N,
      `${N} concurrent features produced featured_count=${h.state.featured_count}. ` +
        "The adjustment is no longer a single atomic statement.",
    );
    assert.equal(h.rpcCalls.length, N, "every adjustment must go through the RPC");
    assert.equal(h.updates.length, 0, "the RPC path must never fall back to read-modify-write");
  });

  it(`NEGATIVE CONTROL: the read-modify-write fallback LOSES increments on the same store`, async () => {
    // No `rpc` on the client at all — the pre-2331 code path, and the one a
    // partial test double or an unapplied migration still takes.
    const h = makeRacyClient({ withRpc: false, start: 0 });

    await Promise.all(
      Array.from({ length: N }, () => adjustProfileCounter(h.client, USER, "featured_count", +1)),
    );

    assert.ok(
      (h.state.featured_count ?? 0) < N,
      `the read-modify-write fallback landed all ${N} increments (${h.state.featured_count}). ` +
        "That means this fake store applies writes atomically, so the RPC test above " +
        "proves nothing — fix the store, do not relax this assertion.",
    );
  });

  it(`decrements are clamped at zero and land exactly, not approximately`, async () => {
    const h = makeRacyClient({ withRpc: true, start: 10 });

    await Promise.all([
      ...Array.from({ length: 10 }, () => adjustProfileCounter(h.client, USER, "featured_count", -1)),
      ...Array.from({ length: 4 },  () => adjustProfileCounter(h.client, USER, "featured_count", +1)),
    ]);

    assert.equal(h.state.featured_count, 4, "10 - 10 + 4 must be 4 regardless of interleaving");
  });

  it("a decrement below zero clamps rather than going negative", async () => {
    const h = makeRacyClient({ withRpc: true, start: 1 });
    await Promise.all(
      Array.from({ length: 5 }, () => adjustProfileCounter(h.client, USER, "featured_count", -1)),
    );
    assert.equal(h.state.featured_count, 0, "GREATEST(0, …) must floor the counter at zero");
  });
});

// ─── The RPC contract ────────────────────────────────────────────────────────

describe("adjustProfileCounter — the call contract", () => {
  it("calls the 2331 function by name with the three contracted arguments", async () => {
    const h = makeRacyClient({ withRpc: true, start: 3 });
    await adjustProfileCounter(h.client, USER, "featured_count", +1);
    assert.deepEqual(h.rpcCalls, [{
      fn: PROFILE_COUNTER_RPC,
      p_user_id: USER,
      p_column:  "featured_count",
      p_delta:   1,
    }]);
    assert.equal(PROFILE_COUNTER_RPC, "portava_adjust_profile_counter");
  });

  it("falls back to read-modify-write when the RPC reports an error (migration not yet applied)", async () => {
    const h = makeRacyClient({
      withRpc: true, start: 7,
      rpcError: { message: "function public.portava_adjust_profile_counter does not exist" },
    });
    await adjustProfileCounter(h.client, USER, "featured_count", +1);
    assert.equal(h.updates.length, 1, "an errored RPC must not silently drop the adjustment");
    assert.equal(h.state.featured_count, 8);
  });

  it("does not fall back when the RPC succeeds but matched no profile row", async () => {
    // A NULL return is 'nothing to count', not 'the write failed'. Falling back
    // would re-run a read-modify-write that also matches nothing, and on a fake
    // or lagging replica could resurrect a row-shaped write.
    const h = makeRacyClient({ withRpc: true, start: 0, rpcNoRow: true });
    await adjustProfileCounter(h.client, USER, "featured_count", +1);
    assert.equal(h.updates.length, 0, "a null RPC result must not trigger the fallback write");
  });

  it("a FAILED profile read never writes a counter (a failed read is not a zero)", async () => {
    const h = makeRacyClient({
      withRpc: false, start: 9,
      readError: { message: "could not connect" },
    });
    await adjustProfileCounter(h.client, USER, "featured_count", +1);
    assert.deepEqual(h.updates, [], "the old `?? 0` would have written 1 over a real count of 9");
    assert.equal(h.state.featured_count, 9, "the stored counter must be left exactly as it was");
  });

  it("a zero delta and a missing user are no-ops, not writes of the current value", async () => {
    const h = makeRacyClient({ withRpc: true, start: 5 });
    await adjustProfileCounter(h.client, USER, "featured_count", 0);
    await adjustProfileCounter(h.client, "", "featured_count", 1);
    await adjustProfileCounter(null, USER, "featured_count", 1);
    assert.deepEqual(h.rpcCalls, []);
    assert.deepEqual(h.updates, []);
    assert.equal(h.state.featured_count, 5);
  });

  it("never throws, whatever the client does — a counter must not fail an admin action", async () => {
    const throwingRpc: any = {
      rpc: () => { throw new Error("boom"); },
      from: () => { throw new Error("boom"); },
    };
    await assert.doesNotReject(() => adjustProfileCounter(throwingRpc, USER, "featured_count", 1));
  });
});

// ─── The route no longer contains the rejected pattern ───────────────────────

/** Drop block and line comments so prose describing the old shape is not read as it. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("routes/adminFeatured.ts — no read-modify-write counters remain", () => {
  const src = stripComments(readFileSync(ROUTE, "utf8"));

  it("has no `update({ featured_count: … })` anywhere", () => {
    // The rejected shape, in any spacing. A source-level pin because a
    // reintroduced site would pass every behavioural test in this file — the
    // helper would simply not be the thing being called.
    const rejected = /update\(\s*\{[^}]*featured_count\s*:/m;
    assert.equal(
      rejected.test(src), false,
      "a read-modify-write featured_count update is back in adminFeatured.ts",
    );
  });

  it("routes every adjustment through the one helper, at all FOUR sites", () => {
    // approve, accept-permission, revoke, and DELETE /:id. The fourth was not
    // named in the defect register (12 §3.3 cites :333-342, :444-449, :561-565)
    // and carries the same defect.
    const calls = [...src.matchAll(/adjustProfileCounter\(/g)].length;
    assert.equal(
      calls, 5,
      "expected 4 call sites plus the definition; the register names only three sites, " +
        "but DELETE /admin/featured/:id decrements too",
    );
    assert.equal([...src.matchAll(/adjustProfileCounter\(sc,/g)].length, 4);
  });
});

// ─── The migration ───────────────────────────────────────────────────────────

describe("2331_creator_counter_atomicity.sql", () => {
  const sql = readFileSync(MIGRATION, "utf8");
  /** The executable half: everything up to the final line-start COMMIT. */
  const body = sql.slice(0, sql.search(/^COMMIT;$/m));
  /** The commented-out reversal that follows it. */
  const tail = sql.slice(sql.search(/^COMMIT;$/m));

  it("creates the function the route calls, by that exact name", () => {
    assert.match(
      sql,
      new RegExp(`CREATE OR REPLACE FUNCTION public\\.${PROFILE_COUNTER_RPC}\\(`),
      "the migration and the caller must agree on the function name",
    );
  });

  it("is SECURITY DEFINER with a pinned search_path", () => {
    assert.match(sql, /SECURITY DEFINER/);
    assert.match(sql, /SET search_path TO 'public'/);
  });

  it("clamps with GREATEST(0, …) rather than trusting the caller", () => {
    assert.match(sql, /GREATEST\(0, COALESCE\(%I, 0\) \+ \$1\)/);
  });

  it("carries a column allowlist checked BEFORE anything is formatted", () => {
    assert.match(sql, /IF p_column NOT IN \('featured_count'\) THEN/);
    const allowlistAt = sql.indexOf("p_column NOT IN");
    const formatAt    = sql.indexOf("EXECUTE format(");
    assert.ok(allowlistAt > -1 && formatAt > -1);
    assert.ok(
      allowlistAt < formatAt,
      "the allowlist must reject before a statement is constructed — otherwise a " +
        "SECURITY DEFINER function on the identity table takes an arbitrary column name",
    );
  });

  it("revokes from PUBLIC, anon, authenticated AND service_role before granting", () => {
    for (const role of ["PUBLIC", "anon", "authenticated", "service_role"]) {
      assert.match(
        sql, new RegExp(`REVOKE ALL ON FUNCTION public\\.${PROFILE_COUNTER_RPC}\\([^)]*\\) FROM ${role};`),
        `missing REVOKE from ${role} — Supabase's public-schema ALTER DEFAULT PRIVILEGES ` +
          "can grant ALL at CREATE time (the 2092 -> 2093 failure)",
      );
    }
    // Measured over the executable half only: the commented-out reversal at the
    // bottom of the file also revokes, and it is not a statement.
    const lastRevoke = body.lastIndexOf("REVOKE ALL ON FUNCTION");
    const grant      = body.indexOf("GRANT EXECUTE ON FUNCTION");
    assert.ok(grant > lastRevoke, "the GRANT must come after every REVOKE, or it is undone");
  });

  it("grants EXECUTE to service_role and to nobody else", () => {
    const grants = [...sql.matchAll(/^GRANT EXECUTE ON FUNCTION[^;]*TO ([a-z_]+);/gm)].map((m) => m[1]);
    assert.deepEqual(grants, ["service_role"]);
  });

  it("asserts its claims in a postcondition block that RAISEs", () => {
    for (const claim of [
      "must be SECURITY DEFINER",
      "must pin search_path",
      "lost its GREATEST",
      "must not hold EXECUTE",
      "the column allowlist admitted",
    ]) {
      assert.ok(sql.includes(claim), `postcondition missing: ${claim}`);
    }
  });

  it("every aborting RAISE sits inside an IF or an exception handler (the 2195 rollback trap)", () => {
    // Same rule migrationDeployability.test.ts enforces across the whole
    // corpus, asserted here too so this file's own shape is pinned at the point
    // it is written rather than only in aggregate.
    const lines = sql.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!/^\s*RAISE\s+EXCEPTION\b/.test(lines[i])) continue;
      const before = lines.slice(Math.max(0, i - 8), i).join("\n");
      assert.match(
        before, /\bTHEN\b|\bEXCEPTION\s+WHEN\b/,
        `unconditional RAISE at line ${i + 1}: ${lines[i].trim()}`,
      );
    }
  });

  it("ends with a commented-out reversal, as 2325 does", () => {
    assert.match(tail, /ROLLBACK \(manual/);
    assert.match(tail, /--\s+DROP FUNCTION IF EXISTS public\.portava_adjust_profile_counter/);
    // Commented out, not executable: nothing after COMMIT may be a live statement.
    for (const line of tail.split("\n").slice(1)) {
      if (line.trim() === "") continue;
      assert.match(line, /^\s*--/, `the reversal section must stay commented: ${line}`);
    }
  });

  it("writes no data — additive only", () => {
    assert.equal(/^\s*(INSERT|UPDATE|DELETE|TRUNCATE)\s/im.test(sql), false,
      "2331 must not backfill or recount; a data change belongs in its own file");
  });
});
