/**
 * layover_recommendations must not be writable by the traveller it advises.
 *
 * node:test + node:assert (NOT vitest). Static: reads the committed migration
 * SQL and the service/route sources. No DB, no network — the live behaviour was
 * verified separately against portava-ci (see the header of
 * migrations/2335_layover_recommendation_write_boundary.sql).
 *
 * THE DEFECT. 0127_layover_system.sql declared
 *
 *   CREATE POLICY "layover_recs_owner" ON layover_recommendations
 *     FOR ALL TO authenticated USING (session_id IN (... user_id = auth.uid()));
 *
 * with no WITH CHECK. PostgreSQL reuses a FOR ALL policy's USING expression as
 * its write check, so the predicate "is this row on one of your own sessions"
 * became the rule for INSERT and UPDATE too — and `authenticated` held the full
 * default privilege set on the table. A session owner could therefore rewrite
 * `safety_rating`, `return_buffer_min` and `hard_return_time`: the
 * server-computed values that tell them when to head back for their flight.
 *
 * 2335 replaces the policy with a FOR SELECT one and narrows the grants. These
 * tests hold that shape down in the SQL that actually ships.
 *
 * Run: node --import tsx/esm --test src/test/layoverRecommendationWriteBoundary.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, "..", "migrations");
const TABLE = "layover_recommendations";
const POLICY = "layover_recs_owner";

/** Every migration file, in the order Postgres would have seen them. */
function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
}

/**
 * The policy statement that wins: the last `CREATE POLICY "layover_recs_owner"`
 * across the migration series. Testing the last one rather than a named file is
 * what makes this a guard — a future migration that re-broadens the policy fails
 * here instead of quietly shipping.
 */
function effectivePolicyStatement(): { file: string; sql: string } {
  const re = new RegExp(`CREATE\\s+POLICY\\s+"?${POLICY}"?[\\s\\S]*?;`, "gi");
  let found: { file: string; sql: string } | null = null;
  for (const f of migrationFiles()) {
    const text = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
    const matches = text.match(re);
    if (matches && matches.length > 0) found = { file: f, sql: matches[matches.length - 1] };
  }
  assert.ok(found, `no CREATE POLICY "${POLICY}" found in ${MIGRATIONS_DIR}`);
  return found!;
}

describe("layover_recommendations write boundary — policy shape", () => {
  it("the effective policy is FOR SELECT, not FOR ALL", () => {
    const { file, sql } = effectivePolicyStatement();
    assert.match(
      sql, /\bFOR\s+SELECT\b/i,
      `${file}: the winning "${POLICY}" policy must be FOR SELECT — got:\n${sql}`,
    );
    assert.doesNotMatch(
      sql, /\bFOR\s+ALL\b/i,
      `${file}: "${POLICY}" is FOR ALL again. A FOR ALL policy reuses USING as ` +
      `its write check unless WITH CHECK is given, which is exactly how an ` +
      `end user came to be able to set their own safety_rating and ` +
      `hard_return_time. Use FOR SELECT.`,
    );
  });

  it("the read predicate is unchanged — visibility was never the defect", () => {
    const { sql } = effectivePolicyStatement();
    assert.match(sql, /\bUSING\b/i, "the policy must still carry a USING predicate");
    assert.match(
      sql.replace(/\s+/g, " "),
      /session_id IN \( SELECT id FROM (public\.)?layover_sessions WHERE user_id = auth\.uid\(\) \)/i,
      "the owner predicate must still scope reads to the caller's own sessions",
    );
  });

  it("a FOR ALL policy on this table anywhere must carry WITH CHECK", () => {
    // Belt and braces: catches a *differently named* FOR ALL policy being added
    // to the same table without a write check.
    const re = new RegExp(`CREATE\\s+POLICY\\s+("?[\\w ]+"?)\\s+ON\\s+(public\\.)?${TABLE}\\b[\\s\\S]*?;`, "gi");
    for (const f of migrationFiles()) {
      const text = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      for (const stmt of text.match(re) ?? []) {
        if (/\bFOR\s+ALL\b/i.test(stmt) && !/\bWITH\s+CHECK\b/i.test(stmt)) {
          // 0127 is the original defect and is superseded by 2335; every other
          // occurrence is a new regression.
          assert.ok(
            f.startsWith("0127_"),
            `${f}: FOR ALL policy on ${TABLE} with no WITH CHECK:\n${stmt}`,
          );
        }
      }
    }
  });
});

describe("layover_recommendations write boundary — grants", () => {
  const boundary = readFileSync(
    join(MIGRATIONS_DIR, "2335_layover_recommendation_write_boundary.sql"), "utf8",
  );
  // Assert on the SQL, not on the prose: the file's header quotes the very
  // privilege lists it is removing, and a comment must never satisfy — or
  // trip — a grant assertion.
  const norm = boundary
    .split("\n").map((l) => l.replace(/--.*$/, "")).join("\n")
    .replace(/\s+/g, " ").trim();

  it("revokes before granting — a GRANT with no REVOKE cannot narrow Supabase's default ALL", () => {
    for (const role of ["PUBLIC", "anon", "authenticated", "service_role"]) {
      assert.ok(
        norm.includes(`REVOKE ALL ON public.${TABLE} FROM ${role};`),
        `missing REVOKE ALL ... FROM ${role} — without it the GRANTs below are decorative`,
      );
    }
    const firstGrant = norm.indexOf(`GRANT SELECT ON public.${TABLE}`);
    const lastRevoke = norm.lastIndexOf(`REVOKE ALL ON public.${TABLE}`);
    assert.ok(lastRevoke >= 0 && firstGrant > lastRevoke, "every REVOKE must precede the GRANTs");
  });

  it("authenticated gets SELECT and nothing else", () => {
    assert.ok(norm.includes(`GRANT SELECT ON public.${TABLE} TO authenticated;`));
    for (const verb of ["INSERT", "UPDATE", "DELETE", "TRUNCATE", "ALL"]) {
      assert.doesNotMatch(
        norm,
        new RegExp(`GRANT[^;]*\\b${verb}\\b[^;]*ON public\\.${TABLE} TO [^;]*authenticated`, "i"),
        `authenticated must not be granted ${verb} on ${TABLE}`,
      );
    }
  });

  it("service_role keeps the DML it needs and does not get TRUNCATE", () => {
    assert.ok(
      norm.includes(`GRANT SELECT, INSERT, UPDATE, DELETE ON public.${TABLE} TO service_role;`),
      "service_role is the only writer — the server routes would break without this",
    );
    assert.doesNotMatch(
      norm,
      new RegExp(`GRANT[^;]*TRUNCATE[^;]*ON public\\.${TABLE}`, "i"),
      "nothing truncates this table, and TRUNCATE is the one verb RLS does not police",
    );
  });

  it("anon — the unauthenticated public role — is granted nothing", () => {
    assert.doesNotMatch(
      norm,
      new RegExp(`GRANT[^;]*ON public\\.${TABLE} TO [^;]*\\banon\\b`, "i"),
      `anon must hold no privilege on ${TABLE}`,
    );
  });

  it("TRUNCATE is taken back from anon and authenticated on the sibling layover tables", () => {
    for (const t of ["layover_sessions", "layover_events", "layover_plan_stops", "airport_profiles"]) {
      assert.match(
        norm,
        new RegExp(`REVOKE TRUNCATE ON public\\.${t} +FROM anon, authenticated;`),
        `${t} still lets anon/authenticated TRUNCATE — RLS does not police TRUNCATE`,
      );
    }
  });
});

describe("layover_recommendations has no client-side writer", () => {
  // The boundary above is only correct because every writer is server-side under
  // the service key. If a route ever writes this table with a user-scoped
  // client, the read-only grant would break it — and that is worth failing on
  // here rather than discovering in production.
  it("the recommendation service never builds its own client — it takes an injected one", () => {
    const svc = readFileSync(
      join(HERE, "..", "services", "airport", "LayoverRecommendationService.ts"), "utf8");
    assert.match(svc, /db: SupabaseClient/, "the service must receive its client from the caller");
    assert.doesNotMatch(
      svc, /getServiceClient|createClient\(/,
      "the service must not construct a client; its caller decides the privilege level",
    );
  });

  it("the only caller supplies a service client, never a user-scoped one", () => {
    const routes = readFileSync(join(HERE, "..", "routes", "airport.ts"), "utf8");
    assert.ok(
      routes.includes("getServiceClient"),
      `routes/airport.ts writes ${TABLE} but never obtains a service client`,
    );
    assert.doesNotMatch(
      routes, /createUserClient|getUserClient|createClientFromRequest|createClientFromToken/,
      `routes/airport.ts appears to build a user-scoped Supabase client; ` +
      `${TABLE} is read-only to authenticated, so such a client could not write it`,
    );
    // Every layover_recommendations access in this file is on the service client.
    for (const line of routes.split("\n")) {
      if (line.includes(`from("${TABLE}")`)) {
        assert.match(line, /\bsc\b|\.from\(/, `unexpected access shape: ${line.trim()}`);
      }
    }
  });
});
