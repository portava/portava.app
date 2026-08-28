/**
 * search_path hazard probe for SECURITY DEFINER authorization functions.
 *
 * WHAT THIS PROVES, AND WHY A CATALOG READ WOULD NOT
 * --------------------------------------------------
 * Asserting that pg_proc.proconfig contains 'search_path=...' proves only that
 * somebody ran ALTER FUNCTION. It reads the same catalog the migration wrote and
 * cannot distinguish a pin that works from a pin that does not. So this script
 * does not read proconfig at all. It builds the actual attack and checks that it
 * fails:
 *
 *   1. create a schema the caller controls          (sp_hazard_probe)
 *   2. put a SHADOWING table in it — same name as the public table the
 *      function reads, holding a row that would flip the function's answer
 *   3. set search_path so the shadow is found FIRST
 *   4. call the SECURITY DEFINER function
 *   5. assert it still resolved against public
 *
 * UNPINNED  -> the function reads the attacker's table   -> returns true  -> HAZARD OPEN
 * PINNED    -> the function reads public.*               -> returns false -> HAZARD CLOSED
 *
 * Every probe runs inside a statement that ALWAYS raises, so the schema, the
 * shadow tables and the search_path change are rolled back on both the success
 * and the failure path. Nothing is left behind; verifyClean() re-checks that the
 * probe schema does not exist afterwards.
 *
 * COVERAGE — STATED HONESTLY
 * --------------------------
 * Only functions with a branch reachable WITHOUT auth.uid() can be probed this
 * way. The Management API has no JWT, so auth.uid() is NULL, and any predicate
 * of the form `user_id = auth.uid()` is unsatisfiable no matter which table the
 * name resolves to — the shadow cannot flip the answer, so such a probe would
 * be green for the wrong reason and prove nothing.
 *
 * Probed here (real red/green differential):
 *   is_blocked, in_accepted_circle, can_see_post, can_see_trip
 *
 * SCHEMA RESOLUTION (2182). Migration 2182 moved is_blocked, in_accepted_circle
 * and can_see_location out of `public` into `authz` to close the anonymous
 * PostgREST RPC oracle. The Management API connects as postgres, so this probe
 * can still call them there — but a hard-coded `public.` prefix would ERROR on
 * a migrated database and a hard-coded `authz.` prefix would ERROR on one not
 * yet migrated. The probe therefore resolves each function's schema from
 * pg_proc at runtime (public or authz only) and fails loudly if a function is
 * found in neither or in both. Do not hard-code the prefix back.
 *
 * NOT probed (auth.uid()-gated, no reachable public branch):
 *   is_accepted_trip_member, can_post_to_trip, shares_trip_with,
 *   viewer_is_blocked, can_see_postcard, can_see_location,
 *   auth_uid_is_event_host, auth_uid_has_event_role, auth_uid_has_event_rsvp,
 *   auth_uid_is_event_cohost, user_is_event_participant, event_is_in_state
 * These share the identical mechanism (an unqualified table reference resolved
 * through the caller's search_path); they are pinned on the strength of the
 * mechanism demonstrated here, not on a per-function red/green. Do not read a
 * green run as per-function proof for that second list.
 *
 * Exit codes:
 *   0  every probed function resolved against public (hazard closed)
 *   2  cannot run (no credentials / unparsable SUPABASE_URL) — never a silent pass
 *   3  at least one probe resolved against the shadow (HAZARD OPEN), or a probe
 *      could not be evaluated, or probe residue was left behind
 */

const EXIT_OK = 0;
const EXIT_CANNOT_RUN = 2;
const EXIT_HAZARD = 3;

const PROBE_SCHEMA = "sp_hazard_probe";
const SENTINEL = "__SP_HAZARD_PROBE__";

// Fixed synthetic ids. They must not exist in the real tables; assertAbsent()
// below verifies that rather than assuming it.
const ID_A = "aaaaaaaa-0000-4000-8000-00000000aaaa";
const ID_B = "bbbbbbbb-0000-4000-8000-00000000bbbb";

/**
 * Each probe shadows the table its function reads and seeds a row that makes
 * the function return TRUE *if and only if* the shadow is what got resolved.
 */
const PROBES = [
  {
    fn: "is_blocked",
    reads: "public.blocks",
    absent: { table: "blocks", where: `blocker_id = '${ID_A}' OR blocked_id = '${ID_A}'` },
    shadow: `
      CREATE TABLE ${PROBE_SCHEMA}.blocks (blocker_id uuid, blocked_id uuid);
      INSERT INTO ${PROBE_SCHEMA}.blocks VALUES ('${ID_A}', '${ID_B}');`,
    call: `__FN_SCHEMA__.is_blocked('${ID_A}'::uuid, '${ID_B}'::uuid)`,
  },
  {
    fn: "in_accepted_circle",
    reads: "public.circle_memberships",
    absent: { table: "circle_memberships", where: `user_id = '${ID_A}' OR other_id = '${ID_A}'` },
    // The body self-joins the table, so both directions must be present for the
    // shadow to satisfy it.
    shadow: `
      CREATE TABLE ${PROBE_SCHEMA}.circle_memberships (user_id uuid, other_id uuid, status text);
      INSERT INTO ${PROBE_SCHEMA}.circle_memberships VALUES
        ('${ID_A}', '${ID_B}', 'accepted'),
        ('${ID_B}', '${ID_A}', 'accepted');`,
    call: `__FN_SCHEMA__.in_accepted_circle('${ID_A}'::uuid, '${ID_B}'::uuid)`,
  },
  {
    fn: "can_see_post",
    reads: "public.posts",
    absent: { table: "posts", where: `id = '${ID_A}'` },
    // visibility='public' is reachable without auth.uid().
    shadow: `
      CREATE TABLE ${PROBE_SCHEMA}.posts (
        id uuid, author_id uuid, status public.post_status,
        deleted_at timestamptz, visibility public.post_visibility, trip_id uuid);
      INSERT INTO ${PROBE_SCHEMA}.posts VALUES
        ('${ID_A}', '${ID_B}', 'active'::public.post_status,
         NULL, 'public'::public.post_visibility, NULL);`,
    call: `__FN_SCHEMA__.can_see_post('${ID_A}'::uuid)`,
  },
  {
    fn: "can_see_trip",
    reads: "public.trips",
    absent: { table: "trips", where: `id = '${ID_A}'` },
    // visibility='public' AND NOT viewer_is_blocked(owner): with auth.uid() NULL
    // viewer_is_blocked is false, so NOT false = true and the branch is reachable.
    shadow: `
      CREATE TABLE ${PROBE_SCHEMA}.trips (
        id uuid, owner_id uuid, visibility public.trip_visibility);
      INSERT INTO ${PROBE_SCHEMA}.trips VALUES
        ('${ID_A}', '${ID_B}', 'public'::public.trip_visibility);`,
    call: `__FN_SCHEMA__.can_see_trip('${ID_A}'::uuid)`,
  },
];

function die(code, msg) {
  console.error(`  ✘  ${msg}`);
  process.exit(code);
}

const supabaseUrl = process.env.SUPABASE_URL;
const token = process.env.SUPABASE_PROJECT_TOKEN || process.env.SUPABASE_ACCESS_TOKEN;
if (!supabaseUrl || !token) {
  die(EXIT_CANNOT_RUN, "SUPABASE_URL and a Supabase token are required — nothing was probed.");
}
let projectRef;
try {
  projectRef = new URL(supabaseUrl).hostname.split(".")[0];
} catch (e) {
  die(EXIT_CANNOT_RUN, `SUPABASE_URL is not parsable: ${String(e)}`);
}
const ENDPOINT = `https://api.supabase.com/v1/projects/${projectRef}/database/query`;

async function raw(query, readOnly) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(readOnly ? { query, read_only: true } : { query }),
  });
  return { ok: res.ok, status: res.status, text: await res.text() };
}

async function readQuery(q) {
  const r = await raw(q, true);
  if (!r.ok) die(EXIT_CANNOT_RUN, `Management API HTTP ${r.status}: ${r.text}`);
  return JSON.parse(r.text);
}

/**
 * Resolve which schema (public or authz) a probed function lives in. 2182 moved
 * is_blocked / in_accepted_circle to authz; can_see_post / can_see_trip stay in
 * public. Resolving live keeps this probe correct on both sides of that
 * migration — and refuses to guess if the function is missing or duplicated.
 */
async function resolveFnSchema(fn) {
  const rows = await readQuery(
    `SELECT n.nspname AS s FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE p.proname = '${fn}' AND n.nspname IN ('public','authz')`,
  );
  if (rows.length !== 1) {
    die(
      EXIT_HAZARD,
      `${fn}: found in ${rows.length} of (public, authz) — expected exactly one. ` +
        "Refusing to guess which copy is the live RLS predicate.",
    );
  }
  return rows[0].s;
}

/** The probe ids must not collide with real data, or the differential is meaningless. */
async function assertAbsent(p) {
  const rows = await readQuery(
    `SELECT count(*)::int AS n FROM public.${p.absent.table} WHERE ${p.absent.where}`,
  );
  const n = rows[0]?.n ?? -1;
  if (n !== 0) {
    die(
      EXIT_HAZARD,
      `${p.fn}: probe ids collide with real rows in public.${p.absent.table} (${n}) — ` +
        "the differential would be meaningless. Change the synthetic ids.",
    );
  }
}

async function runProbe(p, fnSchema) {
  const call = p.call.replace("__FN_SCHEMA__", fnSchema);
  const sql = `
DO $probe$
DECLARE
  v_res boolean;
BEGIN
  CREATE SCHEMA ${PROBE_SCHEMA};
  ${p.shadow}
  -- prefer the attacker-controlled schema
  PERFORM set_config('search_path', '${PROBE_SCHEMA}, public', true);

  SELECT ${call} INTO v_res;

  -- UNCONDITIONAL ABORT. Reached on every path, so the schema, the shadow
  -- tables and the search_path change can never persist.
  RAISE EXCEPTION '${SENTINEL}|%|', COALESCE(v_res::text, 'null');
END
$probe$;`;

  const r = await raw(sql, false);
  const m = new RegExp(`${SENTINEL}\\|([a-z]+)\\|`).exec(r.text);
  if (!m) {
    return {
      verdict: "UNEVALUATED",
      detail: `no probe sentinel in the response (HTTP ${r.status}): ${r.text.slice(0, 400)}`,
    };
  }
  const value = m[1];
  if (value === "true") return { verdict: "HAZARD_OPEN", detail: "function resolved to the SHADOW table" };
  if (value === "false") return { verdict: "CLOSED", detail: "function resolved to public" };
  return { verdict: "UNEVALUATED", detail: `probe returned ${value}` };
}

async function verifyClean() {
  const rows = await readQuery(
    `SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = '${PROBE_SCHEMA}'`,
  );
  return (rows[0]?.n ?? -1) === 0;
}

async function main() {
  console.log("── search_path hazard probe (shadow-table differential) ──");
  console.log(`   probe schema: ${PROBE_SCHEMA} (always rolled back)\n`);

  let open = 0;
  let unevaluated = 0;

  for (const p of PROBES) {
    await assertAbsent(p);
    const fnSchema = await resolveFnSchema(p.fn);
    const { verdict, detail } = await runProbe(p, fnSchema);
    if (verdict === "CLOSED") {
      console.log(`  ✔  ${fnSchema}.${p.fn}: HAZARD CLOSED — ${detail} (shadowed ${p.reads})`);
    } else if (verdict === "HAZARD_OPEN") {
      console.error(`  ✘  ${fnSchema}.${p.fn}: HAZARD OPEN — ${detail} (shadowed ${p.reads})`);
      open++;
    } else {
      console.error(`  ✘  ${p.fn}: UNEVALUATED — ${detail}`);
      unevaluated++;
    }
  }

  const clean = await verifyClean();
  console.log(
    `\n  probe residue check: schema ${PROBE_SCHEMA} ${clean ? "absent (expected)" : "STILL PRESENT"}`,
  );
  if (!clean) {
    die(EXIT_HAZARD, "probe schema survived — it must be dropped manually before trusting anything");
  }

  if (open > 0 || unevaluated > 0) {
    console.error(
      `\nFAIL — ${open} function(s) resolved against an attacker-controlled schema, ` +
        `${unevaluated} could not be evaluated.`,
    );
    process.exit(EXIT_HAZARD);
  }

  console.log(`\nPASS — all ${PROBES.length} probed functions resolved against public despite a`);
  console.log("       shadowing schema earlier in search_path.");
  process.exit(EXIT_OK);
}

main().catch((e) => {
  console.error(`  ✘  unexpected failure: ${e instanceof Error ? e.stack : String(e)}`);
  process.exit(EXIT_HAZARD);
});
