/**
 * search_path hazard probe for SECURITY DEFINER functions that WRITE.
 *
 * Companion to verify-search-path-hazard.mjs, which covers the read-side
 * authorization predicates. This one covers the writers, because the claim being
 * made about them is strictly worse: a shadowed READ misinforms a decision, a
 * shadowed WRITE puts the row somewhere the attacker controls — or deletes from
 * a table that is not the one the author meant.
 *
 * Same method, and for the same reason: asserting pg_proc.proconfig contains a
 * setting only proves ALTER FUNCTION ran. So this reads no catalog. It builds
 * the attack and checks that it fails:
 *
 *   1. create a schema the caller controls        (sp_write_probe)
 *   2. put a SHADOWING table in it, same name as the public table the function
 *      writes to
 *   3. set search_path so the shadow is found FIRST
 *   4. invoke the function — for the trigger, by doing the INSERT that fires it
 *   5. look in the SHADOW and see whether the write landed there
 *
 * UNPINNED -> the row appears in the attacker's table -> HAZARD OPEN
 * PINNED   -> the shadow stays empty, the write went to public -> HAZARD CLOSED
 *
 * Every probe runs inside a statement that ALWAYS raises, so the schema, the
 * shadow tables, the search_path change AND any write the function performed
 * against the real tables are rolled back together, on both the success and the
 * failure path. verifyClean() re-checks the schema is gone afterwards.
 *
 * NOTE ON THE DESTRUCTIVE ONE: when purge_old_ranking_debug_samples is PINNED it
 * correctly resolves to public and really does DELETE production rows older than
 * seven days. That is why the unconditional abort is not a nicety here. The
 * probe additionally records public.ranking_debug_samples' row count before and
 * after and refuses to pass if it moved.
 *
 * COVERAGE — STATED PER FUNCTION, NOT IMPLIED UNIFORMLY
 * ----------------------------------------------------
 * Probed here (real red/green differential on a write):
 *   add_owner_as_member              trigger; fires on INSERT INTO public.trips
 *   increment_hashtag_usage_count    direct call
 *   upsert_hashtag_usage_and_increment direct call
 *   increment_distribution_stats     direct call
 *   purge_old_ranking_debug_samples  direct call (DELETE path)
 *
 * NOT probed:
 *   handle_new_user — it is a trigger function, and firing it means INSERTing
 *     into auth.users. It is currently bound to NO trigger at all (auth.users
 *     has zero non-internal triggers), so there is no live write path to
 *     demonstrate, and manufacturing one against the auth schema is not worth
 *     the blast radius. It is pinned on the strength of the mechanism the other
 *     five demonstrate. Do not read a green run as proof for handle_new_user.
 *
 * Exit codes:
 *   0  every probed writer resolved against public
 *   2  cannot run (no credentials / unparsable SUPABASE_URL) — never a silent pass
 *   3  a write landed in the attacker's schema, a probe could not be evaluated,
 *      probe residue survived, or a real table's row count moved
 */

const EXIT_OK = 0;
const EXIT_CANNOT_RUN = 2;
const EXIT_HAZARD = 3;

const S = "sp_write_probe";
const SENTINEL = "__SP_WRITE_PROBE__";

const PID = "cafe0000-0000-4000-8000-00000000beef"; // synthetic, asserted absent
const PTEXT = "sp-write-probe-item";

/**
 * Each probe seeds a shadow of the table the function writes to, invokes the
 * function, and counts rows in the SHADOW that only exist if the write was
 * misdirected there.
 */
const PROBES = [
  {
    fn: "increment_hashtag_usage_count",
    writes: "public.hashtags",
    absent: `SELECT count(*)::int AS n FROM public.hashtags WHERE id = '${PID}'`,
    body: `
      CREATE TABLE ${S}.hashtags (
        id uuid PRIMARY KEY, usage_count int4 NOT NULL DEFAULT 0,
        updated_at timestamptz NOT NULL DEFAULT now());
      INSERT INTO ${S}.hashtags (id, usage_count) VALUES ('${PID}', 0);
      PERFORM set_config('search_path', '${S}, public', true);

      PERFORM public.increment_hashtag_usage_count('${PID}'::uuid);

      SELECT count(*)::int INTO v_hit
        FROM ${S}.hashtags WHERE id = '${PID}' AND usage_count = 1;`,
  },
  {
    fn: "upsert_hashtag_usage_and_increment",
    writes: "public.hashtag_usage + public.hashtags",
    absent: `SELECT count(*)::int AS n FROM public.hashtag_usage WHERE hashtag_id = '${PID}'`,
    guardTable: "public.hashtag_usage",
    body: `
      -- The REAL public.hashtag_usage carries an FK to public.hashtags. The
      -- shadow has no such FK, so before pinning the probe landed in the shadow
      -- and evaluated fine — but once pinned the write correctly resolves to
      -- public and the FK rejects a synthetic hashtag_id, which reported as
      -- UNEVALUATED rather than CLOSED. Seeding the real row (inside the same
      -- always-aborted transaction) makes the probe evaluable in BOTH states,
      -- so red and green are produced by identical probe code.
      INSERT INTO public.hashtags (id, name, slug)
      VALUES ('${PID}', 'sp-write-probe', 'sp-write-probe')
      ON CONFLICT (id) DO NOTHING;

      CREATE TABLE ${S}.hashtag_usage (
        hashtag_id uuid NOT NULL, source_type text NOT NULL, source_id text NOT NULL,
        author_id uuid NOT NULL, city text, country text,
        UNIQUE (hashtag_id, source_type, source_id));
      CREATE TABLE ${S}.hashtags (
        id uuid PRIMARY KEY, usage_count int4 NOT NULL DEFAULT 0,
        updated_at timestamptz NOT NULL DEFAULT now());
      INSERT INTO ${S}.hashtags (id, usage_count) VALUES ('${PID}', 0);
      PERFORM set_config('search_path', '${S}, public', true);

      -- author_id has its own FK to public.profiles, so it must be a real user
      -- for the pinned (public-resolving) path to be reachable at all.
      SELECT id INTO v_author FROM public.profiles ORDER BY created_at LIMIT 1;

      PERFORM public.upsert_hashtag_usage_and_increment(
        '${PID}'::uuid, 'sp_probe', '${PID}'::uuid, v_author, NULL, NULL);

      SELECT count(*)::int INTO v_hit
        FROM ${S}.hashtag_usage WHERE hashtag_id = '${PID}';`,
  },
  {
    fn: "increment_distribution_stats",
    writes: "public.content_distribution_stats",
    absent: `SELECT count(*)::int AS n FROM public.content_distribution_stats WHERE item_id = '${PTEXT}'`,
    body: `
      CREATE TABLE ${S}.content_distribution_stats (
        item_id text UNIQUE,
        eligible_impressions int8 NOT NULL,
        negative_signal_count int4 NOT NULL,
        underexposure_status public.underexposure_status_enum NOT NULL,
        first_evaluated_at timestamptz,
        last_updated_at timestamptz NOT NULL);
      PERFORM set_config('search_path', '${S}, public', true);

      PERFORM public.increment_distribution_stats('${PTEXT}', 'sp-probe-viewer', false);

      SELECT count(*)::int INTO v_hit
        FROM ${S}.content_distribution_stats WHERE item_id = '${PTEXT}';`,
  },
  {
    fn: "purge_old_ranking_debug_samples",
    writes: "public.ranking_debug_samples (DELETE)",
    absent: null, // nothing seeded in public; guarded by the row-count check instead
    guardTable: "public.ranking_debug_samples",
    body: `
      CREATE TABLE ${S}.ranking_debug_samples (
        id bigint GENERATED ALWAYS AS IDENTITY, sampled_at timestamptz NOT NULL);
      INSERT INTO ${S}.ranking_debug_samples (sampled_at) VALUES (now() - interval '30 days');
      PERFORM set_config('search_path', '${S}, public', true);

      PERFORM public.purge_old_ranking_debug_samples();

      -- the shadow row is gone only if the DELETE was misdirected into it
      SELECT (1 - count(*))::int INTO v_hit FROM ${S}.ranking_debug_samples;`,
  },
  {
    fn: "add_owner_as_member",
    writes: "public.trip_members (via AFTER INSERT trigger on public.trips)",
    absent: null,
    guardTable: "public.trip_members",
    body: `
      CREATE TABLE ${S}.trip_members (
        trip_id uuid NOT NULL, user_id uuid NOT NULL, role public.member_role NOT NULL,
        UNIQUE (trip_id, user_id));
      PERFORM set_config('search_path', '${S}, public', true);

      -- firing the trigger for real: a genuine INSERT into public.trips
      INSERT INTO public.trips (owner_id, title, destination_city)
      VALUES ((SELECT id FROM public.profiles ORDER BY created_at LIMIT 1),
              'sp-write-probe', 'sp-write-probe')
      RETURNING id INTO v_trip;

      SELECT count(*)::int INTO v_hit
        FROM ${S}.trip_members WHERE trip_id = v_trip;`,
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
 * Signatures used only by --prove-red, to un-pin a function for the duration of
 * an always-aborted transaction. Kept beside the probes so the two cannot drift.
 */
const SIGNATURES = {
  increment_hashtag_usage_count: "p_hashtag_id uuid",
  upsert_hashtag_usage_and_increment:
    "p_hashtag_id uuid, p_source_type text, p_source_id uuid, p_author_id uuid, p_city text, p_country text",
  increment_distribution_stats:
    "p_item_id text, p_viewer_id text, p_negative_signal boolean, p_threshold integer, p_suppression_rate double precision",
  purge_old_ranking_debug_samples: "",
  add_owner_as_member: "",
};

/**
 * --prove-red: demonstrate that THIS probe code still detects the hazard, by
 * RESETting the function's search_path inside the probe's own transaction. DDL
 * is transactional in PostgreSQL, so the unconditional RAISE rolls the un-pin
 * back with everything else — production is never left unpinned, not even
 * briefly, and no separate window exists for a concurrent caller to hit.
 *
 * This exists so red and green are produced by IDENTICAL probe code. Without
 * it, the only red evidence is a historical run of an earlier version of this
 * file, which is weaker.
 */
const PROVE_RED = process.argv.includes("--prove-red");

async function runProbe(p) {
  const unpin = PROVE_RED
    ? `  ALTER FUNCTION public.${p.fn}(${SIGNATURES[p.fn] ?? ""}) RESET search_path;\n`
    : "";
  const sql = `
DO $probe$
DECLARE
  v_hit int := -1;
  v_trip uuid;
  v_author uuid;
BEGIN
  CREATE SCHEMA ${S};
${unpin}  ${p.body}

  -- UNCONDITIONAL ABORT. Reached on every path, so neither the shadow schema nor
  -- any write this function performed against the real tables can persist.
  RAISE EXCEPTION '${SENTINEL}|%|', v_hit;
END
$probe$;`;
  const r = await raw(sql, false);
  const m = new RegExp(`${SENTINEL}\\|(-?\\d+)\\|`).exec(r.text);
  if (!m) {
    return { verdict: "UNEVALUATED", detail: `no sentinel (HTTP ${r.status}): ${r.text.slice(0, 300)}` };
  }
  const hit = Number(m[1]);
  if (hit > 0) return { verdict: "HAZARD_OPEN", detail: `${hit} row(s) written into ${S}` };
  if (hit === 0) return { verdict: "CLOSED", detail: "shadow untouched; write resolved to public" };
  return { verdict: "UNEVALUATED", detail: `probe returned ${hit}` };
}

async function verifyClean() {
  const rows = await readQuery(`SELECT count(*)::int AS n FROM pg_namespace WHERE nspname='${S}'`);
  return (rows[0]?.n ?? -1) === 0;
}

async function main() {
  console.log("── SECURITY DEFINER write-path hazard probe (shadow-table differential) ──");
  console.log(`   probe schema: ${S} (always rolled back)`);
  if (PROVE_RED) {
    console.log("   MODE: --prove-red — each function is RESET to unpinned INSIDE the");
    console.log("         aborted transaction. Every probe SHOULD report HAZARD OPEN.");
    console.log("         A green run here means the probe is broken, not that you are safe.");
  }
  console.log();

  let open = 0, unevaluated = 0, moved = 0;

  for (const p of PROBES) {
    // Probe ids must not collide with real rows, or the differential is meaningless.
    if (p.absent) {
      const n = (await readQuery(p.absent))[0]?.n ?? -1;
      if (n !== 0) {
        die(EXIT_HAZARD, `${p.fn}: probe id collides with ${n} real row(s) — change the synthetic id`);
      }
    }
    // Row-count guard for probes that can touch a real table.
    let before = null;
    if (p.guardTable) {
      before = (await readQuery(`SELECT count(*)::int AS n FROM ${p.guardTable}`))[0]?.n;
    }

    const { verdict, detail } = await runProbe(p);

    if (p.guardTable) {
      const after = (await readQuery(`SELECT count(*)::int AS n FROM ${p.guardTable}`))[0]?.n;
      if (before !== after) {
        console.error(`  ✘  ${p.fn}: ${p.guardTable} row count moved ${before} -> ${after} — the abort did not hold`);
        moved++;
      }
    }

    if (verdict === "CLOSED") {
      console.log(`  ✔  ${p.fn}: HAZARD CLOSED — ${detail}`);
      console.log(`        (writes ${p.writes})`);
    } else if (verdict === "HAZARD_OPEN") {
      console.error(`  ✘  ${p.fn}: HAZARD OPEN — ${detail}`);
      console.error(`        (writes ${p.writes})`);
      open++;
    } else {
      console.error(`  ✘  ${p.fn}: UNEVALUATED — ${detail}`);
      unevaluated++;
    }
  }

  const clean = await verifyClean();
  console.log(`\n  probe residue check: schema ${S} ${clean ? "absent (expected)" : "STILL PRESENT"}`);
  if (!clean) die(EXIT_HAZARD, "probe schema survived — drop it manually before trusting anything");

  console.log("  NOT probed: handle_new_user (bound to no trigger; firing it means writing auth.users)");

  if (open || unevaluated || moved) {
    console.error(`\nFAIL — ${open} misdirected write(s), ${unevaluated} unevaluated, ${moved} row-count movement(s).`);
    process.exit(EXIT_HAZARD);
  }
  console.log(`\nPASS — all ${PROBES.length} probed writers wrote to public despite a shadowing`);
  console.log("       schema earlier in search_path, and nothing persisted.");
  process.exit(EXIT_OK);
}

main().catch((e) => {
  console.error(`  ✘  unexpected failure: ${e instanceof Error ? e.stack : String(e)}`);
  process.exit(EXIT_HAZARD);
});
