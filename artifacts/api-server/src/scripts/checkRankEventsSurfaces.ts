/**
 * rank_events surface/outcome reachability check — READ-ONLY diagnostic
 *
 * THE QUESTION THIS ANSWERS
 * -------------------------
 * Are we silently dropping ranking signal?
 *
 * `rank_events` constrains both `surface` and `outcome`. Migration 0153
 * declares:
 *
 *   surface text NOT NULL CHECK (surface IN ('pulse','discovery','events'))
 *   outcome      CHECK (outcome IN ('impression','tap','save','join','rsvp','attended'))
 *
 * (0197 later widened `outcome` to add the server-side 'analytics' sentinel.)
 *
 * But the server writes surface values that are NOT in that declared list:
 *
 *   routes/rankEvents.ts   surface: "living_page"
 *   (elsewhere)            surface: "compass"
 *
 * and the Living Page insert is deliberately fire-and-forget:
 *
 *   // Fire-and-forget: failures are non-fatal — a missed signal is better
 *   // than a broken Living Page load.
 *   if (error) { req.log.warn(...) }
 *
 * So if the LIVE constraint matches the migration, every Living Page and
 * Compass impression is rejected by Postgres, the error is logged at warn
 * and swallowed, and the rows never land. Nothing fails, nothing alerts,
 * and the ranking corpus is missing two entire surfaces.
 *
 * The alternative is that the live constraint has been widened out-of-band —
 * which is plausible: the schema reconciliation found live CHECK constraints
 * WIDER than the migration files in more than one place. Either way it is a
 * fact about production that cannot be established by reading the repo, which
 * is exactly why this script exists.
 *
 * WHAT IT DOES
 * ------------
 *   1. Reads the live CHECK constraint definitions for rank_events.
 *   2. Extracts the permitted surface and outcome values from them.
 *   3. Compares against every value the codebase actually writes.
 *   4. Reports observed row counts per surface, so a permitted-but-unused
 *      value is distinguishable from a permitted-and-working one.
 *
 * READ-ONLY. Runs SELECTs against pg_constraint and one aggregate over
 * rank_events. It writes nothing, and it will not alter a constraint — if a
 * value is rejected, that is a decision for a human, not this script.
 *
 * Usage (from artifacts/api-server, with .env loaded):
 *   node --env-file-if-exists=.env --import tsx/esm src/scripts/checkRankEventsSurfaces.ts
 *
 * Exit 0  every value the code writes is permitted live
 * Exit 1  at least one written value is rejected live — signal is being dropped
 * Exit 2  environment not configured (no token / URL)
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const ACCESS_TOKEN =
  process.env.SUPABASE_PROJECT_TOKEN || process.env.SUPABASE_ACCESS_TOKEN;

if (!SUPABASE_URL || !ACCESS_TOKEN) {
  console.error(
    "ERROR: SUPABASE_URL and a Supabase token must be set.\n" +
      "       Set SUPABASE_PROJECT_TOKEN (project-scoped, preferred for CI)\n" +
      "       or SUPABASE_ACCESS_TOKEN (personal access token).\n" +
      "       Run from artifacts/api-server with .env loaded.",
  );
  process.exit(2);
}

const projectRef = new URL(SUPABASE_URL).hostname.split(".")[0];

async function liveQuery<T = Record<string, unknown>>(query: string): Promise<T[]> {
  const res = await fetch(
    `https://api.supabase.com/v1/projects/${projectRef}/database/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
    },
  );
  if (!res.ok) {
    throw new Error(`Management API ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T[];
}

/**
 * Values the codebase writes. Kept explicit rather than grepped: a grep would
 * quietly stop finding a value the moment someone reformats the call, and this
 * check exists precisely because silent omission is the failure mode.
 *
 * Sources:
 *   pulse / discovery / events  — SURFACE_VALUES in routes/rankEvents.ts (the
 *                                 client-facing zod enum) and the client's
 *                                 Surface type in hooks/useRankOutcome.ts
 *   living_page                 — routes/rankEvents.ts, direct service-client
 *                                 insert on the Living Page path
 *   compass                     — server-side insert on the Compass path
 */
const WRITTEN_SURFACES = [
  "pulse",
  "discovery",
  "events",
  "living_page",
  "compass",
] as const;

/** Outcome values the codebase writes. 'analytics' was added by 0197. */
const WRITTEN_OUTCOMES = [
  "impression",
  "tap",
  "save",
  "join",
  "rsvp",
  "attended",
  "analytics",
] as const;

/** Pull the quoted literals out of a CHECK definition. */
function permittedValues(checkDef: string): Set<string> {
  return new Set([...checkDef.matchAll(/'([^']+)'/g)].map((m) => m[1]!));
}

async function main(): Promise<void> {
  const constraints = await liveQuery<{ conname: string; def: string }>(`
    select conname, pg_get_constraintdef(oid) as def
    from pg_constraint
    where conrelid = 'public.rank_events'::regclass
      and contype = 'c'
    order by conname
  `);

  if (constraints.length === 0) {
    console.error("No CHECK constraints found on public.rank_events — unexpected.");
    process.exit(1);
  }

  console.log("── live CHECK constraints on rank_events ──");
  for (const c of constraints) console.log(`  ${c.conname}: ${c.def}`);
  console.log();

  const surfaceDef = constraints.find((c) => /\bsurface\b/.test(c.def));
  const outcomeDef = constraints.find((c) => /\boutcome\b/.test(c.def));

  let failed = false;

  const report = (
    label: string,
    def: { def: string } | undefined,
    written: readonly string[],
  ) => {
    if (!def) {
      console.log(`── ${label} ── no CHECK constraint found live; any value is accepted.`);
      console.log();
      return;
    }
    const allowed = permittedValues(def.def);
    console.log(`── ${label} ──`);
    for (const v of written) {
      const ok = allowed.has(v);
      if (!ok) failed = true;
      console.log(`  ${ok ? "OK      " : "REJECTED"}  ${v}`);
    }
    const unused = [...allowed].filter((a) => !written.includes(a));
    if (unused.length) console.log(`  (permitted but never written: ${unused.join(", ")})`);
    console.log();
  };

  report("surface", surfaceDef, WRITTEN_SURFACES);
  report("outcome", outcomeDef, WRITTEN_OUTCOMES);

  // Observed rows. A value can be permitted and still never arrive — that is a
  // different problem from being rejected, and the two are easy to confuse.
  const rows = await liveQuery<{ surface: string; n: string }>(`
    select surface, count(*)::text as n
    from public.rank_events
    group by surface
    order by count(*) desc
  `);
  console.log("── observed rows by surface ──");
  if (rows.length === 0) {
    console.log("  (no rows at all)");
  } else {
    for (const r of rows) console.log(`  ${String(r.n).padStart(10)}  ${r.surface}`);
  }
  const seen = new Set(rows.map((r) => r.surface));
  const never = WRITTEN_SURFACES.filter((s) => !seen.has(s));
  if (never.length) {
    console.log(`\n  Written by the code but ZERO rows present: ${never.join(", ")}`);
    console.log("  If those surfaces are permitted, the insert is failing for another");
    console.log("  reason, or that code path never runs. Either way the signal is absent.");
  }

  console.log();
  if (failed) {
    console.error(
      "FAIL — the code writes at least one value the live constraint rejects.\n" +
        "       Those inserts fail in production. The Living Page path swallows the\n" +
        "       error by design (fire-and-forget), so this does not surface anywhere\n" +
        "       except a warn-level log.\n" +
        "       Widening a CHECK constraint is a production schema change: decide it\n" +
        "       deliberately, do not let this script imply it.",
    );
    process.exit(1);
  }
  console.log("PASS — every value the code writes is permitted by the live constraints.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
