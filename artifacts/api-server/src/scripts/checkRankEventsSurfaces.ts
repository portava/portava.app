/**
 * rank_events surface deploy gate — BEHAVIOURAL PROBE (+ read-only reporting)
 *
 * THE QUESTION THIS ANSWERS
 * -------------------------
 * Will an insert with `surface='live_pulse'` actually be accepted by the LIVE
 * database? And, separately, are we silently dropping ranking signal on the
 * surfaces the code already writes?
 *
 * WHY THIS IS NO LONGER A TEXT PARSE
 * ----------------------------------
 * The previous version answered the gate question by running
 * `pg_get_constraintdef()` and regex-harvesting every single-quoted literal out
 * of the definition. Three rounds of review found that irreducibly fragile:
 *
 *   - it harvested literals from ANY clause, so a definition that mentions
 *     'live_pulse' in a NEGATIVE clause (`surface <> 'live_pulse'`,
 *     `NOT (surface = ANY (ARRAY['live_pulse']))`, a CASE arm, a comment-ish
 *     string) read as PERMITTED;
 *   - it never verified the definition was a positive allow-list ON `surface`
 *     at all;
 *   - with more than one CHECK touching `surface` the effective vocabulary is
 *     the INTERSECTION, which no single definition string can express.
 *
 * Every one of those is a way for the gate to print PERMITTED about a database
 * that would reject the row. So the gate no longer reads SQL text. It asks the
 * database, by attempting the write.
 *
 * THE PROBE
 * ---------
 * One statement. It attempts a real INSERT into `public.rank_events` with
 * `surface='live_pulse'` and then ALWAYS aborts, so the row can never persist.
 *
 *   accepted                       -> GATE PASSES  (exit 0)
 *   rejected by the SURFACE check  -> GATE FAILS   (exit 3)
 *   anything else                  -> FATAL, fail closed (exit 3)
 *
 * REACHING THE SURFACE CONSTRAINT
 * -------------------------------
 * A probe that dies on a NOT NULL, an FK, or a different CHECK proves NOTHING
 * about `surface` and must never be reported as "rejected". `rank_events` has:
 *
 *   user_id   uuid NOT NULL REFERENCES auth.users(id)   <- the hard one
 *   item_id   text NOT NULL                             (no FK, free text)
 *   item_kind text CHECK (item_kind IN ('post','event','plan','buddy','place','gem'))
 *   position  smallint     outcome text CHECK (...)     features jsonb NOT NULL
 *
 * So the probe:
 *   - sources `user_id` by `SELECT id FROM auth.users LIMIT 1` INSIDE the same
 *     statement, so the value is guaranteed to satisfy the FK at insert time.
 *     If `auth.users` is empty the probe cannot be built -> FATAL, never
 *     "rejected";
 *   - supplies an explicit, known-good value for EVERY other constrained column
 *     ('place', 0, '{}'::jsonb, 'impression', now()), values that are legal
 *     under 0153, 0154, 0197 and 0199 alike. `surface` is therefore the only
 *     column that can plausibly trip a CHECK — and the probe still refuses to
 *     assume that; see ATTRIBUTION below.
 *
 * WHY NOTHING CAN PERSIST
 * -----------------------
 * The probe is ONE statement — a `DO` block — and its final act is an
 * unconditional `RAISE EXCEPTION`. It raises on the success path too, carrying
 * the verdict in the exception message. So:
 *
 *   - there is no ROLLBACK statement that could be skipped, because rollback is
 *     not a statement here: it is the consequence of the only statement failing;
 *   - there is no path where "BEGIN succeeded and ROLLBACK did not run", because
 *     the probe never issues BEGIN;
 *   - the successful-INSERT path is undone twice over: the inner
 *     BEGIN/EXCEPTION block is a subtransaction, and the outer RAISE aborts the
 *     whole statement;
 *   - even a transport that wrapped the body in an explicit transaction and then
 *     issued COMMIT cannot persist the row: Postgres executes COMMIT in an
 *     aborted transaction block as ROLLBACK.
 *
 * After the probe, `provePristine()` counts rows matching the probe's sentinel
 * `item_id` prefix and requires ZERO — and it matches the prefix, not this run's
 * id, so it also catches a leak from any PREVIOUS run. A non-zero count, or an
 * inability to run that count, is FATAL.
 *
 * TRANSPORT — AND THE UNCERTAINTY, STATED OUT LOUD
 * ------------------------------------------------
 * This runs through the Supabase Management API,
 * `POST /v1/projects/{ref}/database/query` (see docs/migrations.md).
 *
 * I could NOT establish from this repo whether that endpoint executes a
 * multi-statement script or one statement per call. The evidence is indirect
 * and points at multi-statement — docs/migrations.md says the live database is
 * migrated through this exact endpoint, and the migration files it lists
 * (including 0199, which uses BEGIN/COMMIT) contain many statements — but NO
 * code in this repo has ever sent a multi-statement body to it. Every existing
 * caller sends a single SELECT. That is not proof.
 *
 * So the probe does not depend on the answer: it is a SINGLE statement, valid
 * under either transport. `BEGIN; INSERT; ROLLBACK;` was rejected precisely
 * because it is only safe under one of the two, and because under the simple
 * query protocol an erroring INSERT aborts the rest of the batch — the ROLLBACK
 * would be skipped as a statement, which is the exact hazard we must not have.
 *
 * The one transport property the probe DOES depend on: that the response body
 * contains the Postgres error message text. Every error path here is carried in
 * that message. If the sentinel is not found in the response, the probe reports
 * FATAL ("could not determine the result") rather than guessing — see
 * `classifyProbe()`. It never infers a verdict from HTTP status alone.
 *
 * ERROR CLASSES ARE READ FROM SQLSTATE, NEVER FROM MESSAGE PROSE
 * --------------------------------------------------------------
 *   23514 check_violation       -> the value was rejected. GATE FAILS — but only
 *                                  once attributed; see below.
 *   23503 foreign_key_violation -> the PROBE is wrong (bad user_id). FATAL.
 *   23502 not_null_violation    -> the PROBE is wrong (missing column). FATAL.
 *   25006 read_only_sql_transaction -> the endpoint ran us read-only. FATAL.
 *   42501 insufficient_privilege    -> token cannot write. FATAL.
 *   anything else / unknown     -> FATAL.
 *
 * The SQLSTATE is captured inside the database by `GET STACKED DIAGNOSTICS`,
 * not scraped from an HTTP error string.
 *
 * ATTRIBUTION — "was it the SURFACE check?"
 * -----------------------------------------
 * A check_violation could come from a DIFFERENT CHECK on the same row. Treating
 * any 23514 as "surface rejected" would be the same class of bug as the regex.
 * So the probe also captures `CONSTRAINT_NAME` via `GET STACKED DIAGNOSTICS`
 * (this is how the constraint name is exposed — from the database, so it does
 * not depend on the HTTP transport surfacing structured error fields), and the
 * violated name is then cross-checked against the live `pg_constraint` listing:
 *
 *   attributed to surface  <=>  the named constraint exists live
 *                               AND its definition references `surface`
 *                               AND it references NO other rank_events column
 *
 * Only that is reported as NOT PERMITTED. An empty constraint name, a name that
 * is not in the live listing, or a definition that also touches another column
 * is an UNATTRIBUTABLE check_violation and is FATAL — not a clean "rejected".
 *
 * WHAT IS STILL TEXT PARSING — AND IS EXPLICITLY NOT THE GATE
 * -----------------------------------------------------------
 * `pg_get_constraintdef()` output is still printed, and the old
 * literal-harvesting comparison of WRITTEN_SURFACES / WRITTEN_OUTCOMES against
 * it is still run. It is INFORMATIONAL ONLY. It is labelled as such in the
 * output, it carries the same fragility caveat, and it does NOT get an exit
 * code of its own: the standing living_page/compass finding is printed
 * prominently and the script still exits 0. It can never set or override the
 * GATE verdict. The gate verdict comes from the probe alone.
 *
 * Usage (from artifacts/api-server, with .env loaded):
 *   node --env-file-if-exists=.env --import tsx/esm src/scripts/checkRankEventsSurfaces.ts
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * EXIT CODE CONTRACT — docs/migrations.md, docs/algorithm/rank-events-signal-gaps.md
 * and scripts/run-all-checks.sh all state this same table. Change one, change all.
 * ══════════════════════════════════════════════════════════════════════════════
 * PROCEED on exit 0 AND ONLY when the line `GATE live_pulse: PERMITTED` is
 * PRESENT in the output. BLOCK on ANY other code, including codes this script
 * does not currently produce — an unrecognised code is an unknown state, and an
 * unknown state is not a pass. Exit 0 with no GATE line is also a BLOCK: it
 * means the process ended before printing a verdict.
 *
 * WHY EXIT 1 IS RESERVED AND NEVER CHOSEN
 * ---------------------------------------
 * 1 is Node's DEFAULT exit code for every involuntary death: an uncaught
 * exception, an unhandled rejection, a module-resolution failure, a tsx /
 * TypeScript load failure. If this script also CHOSE 1 for a finding it calls
 * "proceed", then a crash — a run that proved nothing at all — would be
 * indistinguishable from a pass, and callers told to ignore 1 would ignore it.
 * So nothing in this script chooses 1. It means, and only means, "the process
 * died involuntarily", and it is a BLOCK.
 *
 *   0  PROCEED    The probe INSERT with surface='live_pulse' was ACCEPTED by the
 *                 live database and rolled back, and no probe row persisted.
 *                 The INFORMATIONAL literal-harvest report may or may not have
 *                 found something (the standing 'living_page' / 'compass'
 *                 finding is expected on every run); either way it is printed
 *                 prominently and the code stays 0, because it is information
 *                 for a human and not a deploy verdict. PROCEED — after
 *                 confirming the `GATE live_pulse: PERMITTED` line is present.
 *
 *   1  CRASHED    NEVER chosen by this script. Node's default code for an
 *                 uncaught exception / unhandled rejection / module-load
 *                 failure. The run died before reaching a verdict, so nothing
 *                 was proven. BLOCK.
 *
 *   2  CANNOT-RUN No SUPABASE_URL / token, or a SUPABASE_URL that does not parse
 *                 into a project ref, so the probe never ran and proved nothing.
 *                 BLOCK. A gate that silently no-ops without credentials is not
 *                 a gate. (Distinct from 3 only because the remedy is
 *                 "configure the environment", not "fix the schema".)
 *
 *   3  BLOCKED    Fail-closed. Every fatal condition this script CHOOSES exits
 *                 3, including a throw that escapes main(): main().catch()
 *                 converts it to 3 rather than letting Node default it to 1.
 *                 Either the probe was REJECTED, or its result could not be
 *                 established:
 *                   - the surface CHECK rejected 'live_pulse'      (definitive)
 *                   - check_violation that could NOT be attributed to the
 *                     surface constraint
 *                   - foreign_key_violation / not_null_violation — the probe
 *                     itself is wrong and proves nothing about surface
 *                   - read-only transaction / insufficient privilege
 *                   - any other SQLSTATE
 *                   - the response contained no probe sentinel: result unknown
 *                   - `auth.users` is empty, so no FK-valid user_id existed
 *                   - a probe row PERSISTED, or the pristine check could not run
 *                   - rank_events has CHECK constraints but none on `surface`
 *                     (the half-applied-0199 state: the DROP committed and the
 *                     revalidating ADD did not) — an accepted insert there proves
 *                     only that nothing is enforced
 *                   - no CHECK constrains `outcome` (carried over unchanged)
 *                   - the live pg_constraint read threw (network/token/permission)
 *                   - anything thrown out of main() — see NOTHING THAT CAN
 *                     THROW RUNS AT MODULE SCOPE below
 *                 NOT fatal any more: "more than one CHECK mentions `surface`".
 *                 The probe measures their INTERSECTION directly, which is the
 *                 whole reason the old text parse could not. It is now reported.
 *                 BLOCK.
 *
 * NOTHING THAT CAN THROW RUNS AT MODULE SCOPE
 * -------------------------------------------
 * A throw at module scope is outside main()'s catch, so Node would exit with
 * its default code — 1 — and the contract above would have to call that a
 * pass. Therefore every statement that can throw (environment validation, the
 * `new URL(SUPABASE_URL)` parse that derives the project ref, any file read)
 * runs INSIDE main(), where main().catch() maps it to 3. Module scope holds
 * only literals, `process.env` property reads, and declarations. Keep it that
 * way: adding a throwing module-scope statement silently re-introduces the
 * crash-looks-like-a-pass defect.
 *
 * Exactly ONE `GATE <surface>:` line is printed per REQUIRED_SURFACES entry, on
 * every exit path this script controls, before exiting. `grep '^GATE '` yields
 * a verdict:
 *
 *   GATE <s>: PERMITTED           the live DB ACCEPTED an insert of <s>
 *                                 (and rolled it back)                   (exit 0)
 *   GATE <s>: NOT PERMITTED       the live surface CHECK rejected <s>     (exit 3)
 *   GATE <s>: BLOCKED (<reason>)  the result could not be established     (exit 2/3)
 *
 * An absent GATE line means the check never ran, or died before reaching a
 * verdict. That is itself a block, WHATEVER the exit code — including 0. Never
 * read "no output" as a pass. `run_gate` in scripts/run-all-checks.sh enforces
 * exactly this: exit 0 AND the `GATE live_pulse: PERMITTED` line present.
 */

// ── THE ALLOWLIST ASSERTION, IN THE EXECUTION PATH ───────────────────────────
//
// FIRST import, deliberately: ES modules evaluate their imports in source
// order, before the importing module's own body, so this runs before anything
// else in this file — and this file attempts a REAL INSERT into
// public.rank_events. It asserts that the project ref resolved from
// SUPABASE_URL is the one sanctioned CI project and exits 2 if it cannot
// establish that.
//
// 2 is deliberate and matches the EXIT CODE CONTRACT above: a refusal is
// CANNOT-RUN, not the involuntary death that 1 denotes. run_gate() in
// scripts/run-all-checks.sh therefore reports it as deploy-blocking rather
// than as a crash.
//
// THIS DOES NOT VIOLATE "NOTHING THAT CAN THROW RUNS AT MODULE SCOPE" above.
// The guard never throws: every failure path inside it — missing policy
// script, unspawnable bash, killed child, non-zero status — ends in an
// explicit process.exit(2). It therefore cannot reach Node's default exit 1,
// which is the specific outcome that invariant exists to prevent. It prints no
// `GATE live_pulse:` line either, which is correct and already covered: an
// absent GATE line is a block whatever the exit code, and run_gate() fails on
// both counts.
//
// It is not a workflow step, so no YAML edit can skip it. Deleting the
// `Preflight — Supabase target must be the sanctioned CI project` step from
// .github/workflows/live-db.yml, disabling it with `if:`, moving it after the
// install step, or adding a brand-new job in a brand-new workflow file all
// still land here, because this process cannot start without it.
//
// See src/lib/ciSupabaseGuard.mjs and docs/ci/README.md.
import "../lib/ciSupabaseGuard.mjs";

import { randomUUID } from "node:crypto";

/**
 * Surfaces a PENDING deploy depends on, checked independently of the
 * informational report below.
 *
 * Why separate: the informational report is permanently red ('living_page' is
 * rejected live), so a deploy step gated on it is gated on a check that can
 * never go green and will inevitably get `|| true`'d. That is why the
 * informational finding no longer moves the exit code at all — it prints and
 * the script still exits 0 — while these drive exit 3. See the EXIT CODE
 * CONTRACT above.
 *
 * Remove an entry once its migration is applied AND the code that writes it has
 * shipped and been confirmed landing rows.
 *
 * Declared FIRST, above even the environment check, so that every exit path in
 * this file — including "no credentials" — can emit its GATE verdict.
 */
const REQUIRED_SURFACES = ["live_pulse", "living_page", "watch_feed"] as const;

/** Fail-closed exit code. See the EXIT CODE CONTRACT in the header. */
const EXIT_BLOCKED = 3;
/** Environment not configured — the check did not run. Also a BLOCK. */
const EXIT_CANNOT_RUN = 2;
/**
 * Exit 1 is DELIBERATELY not a constant here, because nothing in this script
 * may choose it. 1 is Node's default code for an involuntary death (uncaught
 * exception, unhandled rejection, module-resolution or tsx load failure). If a
 * "proceed" state shared that code, a crash would read as a pass to every
 * caller told to ignore it. The informational living_page/compass finding used
 * to live here; it now prints prominently and exits 0.
 */

/** The one machine-greppable line per required surface. Never skipped. */
function printGateVerdicts(verdict: string): void {
  console.log();
  for (const s of REQUIRED_SURFACES) console.log(`GATE ${s}: ${verdict}`);
  console.log();
}

/**
 * Refuse the deploy, loudly, on any state this script cannot prove safe.
 *
 * Prints a `GATE <surface>: BLOCKED (<reason>)` line for EVERY required surface
 * before exiting, so the one output an operator (or `grep '^GATE '`) is told to
 * look for is never missing. A verdict-shaped hole reads exactly like a check
 * that never ran.
 */
function blockGate(reason: string, detail: string, code = EXIT_BLOCKED): never {
  printGateVerdicts(`BLOCKED (${reason})`);
  console.error(`BLOCKED — ${detail}`);
  process.exit(code);
}

/**
 * Raw environment reads. These are plain `process.env` property accesses: they
 * cannot throw, so they are safe at module scope. VALIDATING them, and PARSING
 * SUPABASE_URL into a project ref, both can fail — so both happen inside
 * `requireTransport()`, which main() calls as its first act. See NOTHING THAT
 * CAN THROW RUNS AT MODULE SCOPE in the header.
 */
const SUPABASE_URL = process.env.SUPABASE_URL;
const ACCESS_TOKEN =
  process.env.SUPABASE_PROJECT_TOKEN || process.env.SUPABASE_ACCESS_TOKEN;

/** Everything needed to talk to the Management API, once validated. */
interface Transport {
  mgmtUrl: string;
  accessToken: string;
}

/**
 * Memoised result of `requireTransport()`. DECLARED at module scope, never
 * COMPUTED there — the computation is the part that can fail.
 */
let transport: Transport | undefined;

/**
 * Validate the environment and derive the Management API endpoint.
 *
 * This used to be module-scope code:
 *
 *     const projectRef = new URL(SUPABASE_URL).hostname.split(".")[0];
 *
 * `new URL()` throws on a malformed value. At module scope that throw is
 * outside main()'s catch, so Node would terminate the process with its default
 * code — 1 — which is precisely the code no caller may treat as a result. Here
 * the same failure is a deliberate, verdict-printing exit instead.
 *
 * Idempotent and memoised, so `rawQuery()` can call it without re-validating.
 */
function requireTransport(): Transport {
  if (transport) return transport;

  const url = SUPABASE_URL;
  const token = ACCESS_TOKEN;
  if (!url || !token) {
    // Exit 2, not 3, because the remedy is different (configure the environment
    // rather than fix the schema) — but it is still a BLOCKED verdict, and it
    // still prints one. A missing-credentials run proves nothing, and a caller
    // that only tests for exit 3 would otherwise read "the gate did not run" as
    // "the gate passed".
    return blockGate(
      "environment not configured — the probe did not run",
      "SUPABASE_URL and a Supabase token must be set.\n" +
        "       Set SUPABASE_PROJECT_TOKEN (project-scoped, preferred for CI)\n" +
        "       or SUPABASE_ACCESS_TOKEN (personal access token).\n" +
        "       Run from artifacts/api-server with .env loaded.\n" +
        "       This gate needs LIVE credentials by construction: it proves a fact\n" +
        "       about the production database that cannot be read off the repo. In\n" +
        "       an environment without them it must FAIL, not skip — which is why\n" +
        "       this is exit 2 and why run-all-checks.sh scores exit 2 as a failure.",
      EXIT_CANNOT_RUN,
    );
  }

  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch (e) {
    return blockGate(
      "SUPABASE_URL is not a parsable URL — the probe did not run",
      `SUPABASE_URL could not be parsed: ${e instanceof Error ? e.message : String(e)}\n` +
        "       The Management API endpoint is derived from its hostname, so the probe\n" +
        "       has nowhere to go and nothing was proven. Set SUPABASE_URL to the full\n" +
        "       project URL, e.g. https://<project-ref>.supabase.co\n" +
        "       (This is exit 2 — 'the gate could not run' — deliberately NOT the\n" +
        "       uncaught-throw exit 1 this parse used to produce at module scope.)",
      EXIT_CANNOT_RUN,
    );
  }

  const projectRef = hostname.split(".")[0] ?? "";
  if (!projectRef) {
    return blockGate(
      "no project ref could be derived from SUPABASE_URL",
      `SUPABASE_URL parsed, but its hostname ('${hostname}') yielded no leading\n` +
        "       label to use as the Supabase project ref. Expected\n" +
        "       https://<project-ref>.supabase.co — nothing was proven.",
      EXIT_CANNOT_RUN,
    );
  }

  transport = {
    mgmtUrl: `https://api.supabase.com/v1/projects/${projectRef}/database/query`,
    accessToken: token,
  };
  return transport;
}

interface RawResponse {
  ok: boolean;
  status: number;
  text: string;
}

/** Send one SQL body to the Management API and return the raw response. */
async function rawQuery(query: string): Promise<RawResponse> {
  const { mgmtUrl, accessToken } = requireTransport();
  const res = await fetch(mgmtUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  });
  return { ok: res.ok, status: res.status, text: await res.text() };
}

/** Read-only helper for the reporting queries. Throws on any non-2xx. */
async function liveQuery<T = Record<string, unknown>>(query: string): Promise<T[]> {
  const res = await rawQuery(query);
  if (!res.ok) {
    throw new Error(`Management API ${res.status}: ${res.text}`);
  }
  return JSON.parse(res.text) as T[];
}

// ── The probe ────────────────────────────────────────────────────────────────

/**
 * Sentinel prefix for the probe's `item_id`.
 *
 * A FIXED prefix (not this run's id) is what `provePristine()` matches on, so
 * the pristine check catches a leaked row from ANY run, ever — not just this
 * one. `item_id` is plain `text` with no CHECK and no FK, so any value is legal
 * and this cannot itself be the thing that gets rejected.
 */
const PROBE_ITEM_PREFIX = "rank-events-surface-probe:";

/** Sentinel framing the verdict inside the RAISE message. */
const SENTINEL = "__RE_SURFACE_PROBE__";
/**
 * The one other module-scope constructor call in this file, kept here after the
 * throw-capable-module-scope audit because it provably cannot throw: SENTINEL
 * is regex-escaped before interpolation, so the pattern is valid whatever
 * SENTINEL is later changed to. Without that escape, editing SENTINEL to
 * contain a metacharacter would throw at module scope — outside main()'s catch,
 * exiting 1, the code the contract forbids as a result.
 */
const SENTINEL_RE = new RegExp(
  `${SENTINEL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}` +
    `\\|([A-Z_]+)\\|([0-9A-Za-z]*)\\|([A-Za-z0-9_]*)\\|__END__`,
);

/**
 * Build the probe statement.
 *
 * Everything the verdict depends on is computed and classified INSIDE the
 * database and shipped out in the exception message, framed by SENTINEL and
 * hard-sanitised to `[A-Za-z0-9_]` so JSON escaping in the transport cannot
 * corrupt the parse. The free-text diagnostic is appended AFTER the closing
 * `__END__` marker where it cannot affect parsing.
 *
 * `runId` is a `randomUUID()`, so it is hex+dashes only — nothing here is
 * user-controlled and no value is interpolated into a position where it could
 * change the statement's shape.
 */
function buildProbeSql(surface: string, runId: string): string {
  return `
DO $probe$
DECLARE
  v_user       uuid;
  v_verdict    text := 'NO_RESULT';
  v_sqlstate   text := '';
  v_constraint text := '';
  v_detail     text := '';
BEGIN
  -- Outer guard: anything that fails while BUILDING the probe (reading
  -- auth.users, permissions on it) must still come back as a sentinel verdict,
  -- never as a bare Postgres error we would have to parse prose out of.
  BEGIN
    SELECT id INTO v_user FROM auth.users LIMIT 1;

    IF v_user IS NULL THEN
      -- No FK-valid user exists. The probe cannot be built, so it proves
      -- nothing about the surface constraint. FATAL, never 'rejected'.
      v_verdict := 'NO_USER';
    ELSE
      BEGIN
        -- Every constrained column gets an explicitly known-good value, legal
        -- under 0153/0154/0197/0199, so 'surface' is the only column that
        -- should be able to trip a CHECK. Attribution below still verifies it.
        INSERT INTO public.rank_events
          (user_id, item_id, item_kind, "position", features, outcome, served_at, surface)
        VALUES
          (v_user,
           '${PROBE_ITEM_PREFIX}${runId}',
           'place',
           0,
           '{}'::jsonb,
           'impression',
           now(),
           '${surface}');
        v_verdict := 'ACCEPTED';
      EXCEPTION
        WHEN check_violation THEN
          v_verdict := 'CHECK_VIOLATION';
          GET STACKED DIAGNOSTICS v_sqlstate   = RETURNED_SQLSTATE,
                                  v_constraint = CONSTRAINT_NAME,
                                  v_detail     = MESSAGE_TEXT;
        WHEN foreign_key_violation THEN
          v_verdict := 'FK_VIOLATION';
          GET STACKED DIAGNOSTICS v_sqlstate   = RETURNED_SQLSTATE,
                                  v_constraint = CONSTRAINT_NAME,
                                  v_detail     = MESSAGE_TEXT;
        WHEN not_null_violation THEN
          v_verdict := 'NOT_NULL_VIOLATION';
          GET STACKED DIAGNOSTICS v_sqlstate   = RETURNED_SQLSTATE,
                                  v_constraint = COLUMN_NAME,
                                  v_detail     = MESSAGE_TEXT;
        WHEN OTHERS THEN
          v_verdict := 'INSERT_ERROR';
          GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE,
                                  v_detail   = MESSAGE_TEXT;
      END;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_verdict := 'SETUP_ERROR';
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE,
                            v_detail   = MESSAGE_TEXT;
  END;

  -- UNCONDITIONAL ABORT — success path included.
  --
  -- This is the rollback. It is not a separate statement that could be skipped:
  -- it is the only statement failing. On the ACCEPTED path it undoes the INSERT
  -- (the inner block is already a subtransaction; this aborts the statement on
  -- top of that). On every failure path there is nothing to undo. There is no
  -- ordering, no branch and no transport behaviour under which the probe row
  -- can survive.
  RAISE EXCEPTION USING
    ERRCODE = 'P0001',
    MESSAGE = '${SENTINEL}|' || v_verdict || '|'
              || regexp_replace(coalesce(v_sqlstate, ''),   '[^A-Za-z0-9]', '', 'g') || '|'
              || regexp_replace(coalesce(v_constraint, ''), '[^A-Za-z0-9_]', '', 'g') || '|'
              || '__END__ '
              || left(regexp_replace(coalesce(v_detail, ''), '[^A-Za-z0-9 _.:=()-]', '?', 'g'), 240);
END
$probe$;
`.trim();
}

type ProbeOutcome =
  | { kind: "accepted" }
  | { kind: "rejected"; constraint: string; sqlstate: string; detail: string }
  | { kind: "fatal"; reason: string; detail: string };

interface LiveConstraint {
  conname: string;
  def: string;
}

/**
 * Columns of rank_events other than `surface`. Used for attribution: if the
 * violated constraint's definition mentions any of these, it is not purely a
 * surface constraint and the violation cannot be cleanly attributed.
 */
const OTHER_RANK_EVENT_COLUMNS = [
  "user_id",
  "item_id",
  "item_kind",
  "position",
  "features",
  "outcome",
  "served_at",
  "outcome_at",
  "session_id",
  "event_type",
  "content_type",
];

/** Does this constraint definition constrain `surface` and nothing else? */
function isPureSurfaceConstraint(def: string): boolean {
  if (!/\bsurface\b/.test(def)) return false;
  return !OTHER_RANK_EVENT_COLUMNS.some((c) => new RegExp(`\\b${c}\\b`).test(def));
}

/**
 * Turn the raw transport response into a verdict.
 *
 * NOTE the deliberate absence of any HTTP-status-based inference. A 2xx does not
 * mean accepted and a 4xx does not mean rejected: the probe ALWAYS raises, so a
 * 2xx would actually be the surprising case. The only thing trusted is the
 * sentinel the database itself produced. No sentinel -> no verdict -> FATAL.
 */
function classifyProbe(res: RawResponse, constraints: LiveConstraint[]): ProbeOutcome {
  const m = SENTINEL_RE.exec(res.text);
  if (!m) {
    return {
      kind: "fatal",
      reason: "no probe sentinel in the response — result unknown",
      detail:
        `The probe always raises an exception carrying '${SENTINEL}', and the\n` +
        `       Management API response (HTTP ${res.status}) did not contain it.\n` +
        "       Either the endpoint did not execute the statement, or it does not\n" +
        "       return Postgres error message text — the one transport property this\n" +
        "       probe depends on (see TRANSPORT in the header). Either way the result\n" +
        "       could not be established, and unestablished is not permitted.\n" +
        `       Raw response: ${res.text.slice(0, 600)}`,
    };
  }

  const [, verdict, sqlstate, constraintName] = m;
  const detail = res.text.slice(m.index + m[0].length, m.index + m[0].length + 260).trim();

  switch (verdict) {
    case "ACCEPTED":
      return { kind: "accepted" };

    case "CHECK_VIOLATION": {
      // 23514. Definitive ONLY once attributed to the surface constraint —
      // otherwise it is some other CHECK on the same row and says nothing.
      const named = constraints.find((c) => c.conname === constraintName);
      if (!constraintName) {
        return {
          kind: "fatal",
          reason: "unattributable check_violation (no constraint name)",
          detail:
            "The insert was rejected with SQLSTATE 23514 (check_violation), but the\n" +
            "       error carried NO constraint name, so it cannot be shown to be the\n" +
            "       SURFACE check rather than some other CHECK on the same row.\n" +
            "       An unattributable check_violation is FATAL, not a clean 'rejected'.\n" +
            `       Message: ${detail}`,
        };
      }
      if (!named) {
        return {
          kind: "fatal",
          reason: `check_violation on unknown constraint '${constraintName}'`,
          detail:
            `SQLSTATE 23514 named constraint '${constraintName}', which is not in the\n` +
            "       live CHECK listing for public.rank_events read moments earlier.\n" +
            "       It may belong to another relation, a domain, or a trigger-invoked\n" +
            "       statement. Not attributable to `surface` -> FATAL.\n" +
            `       Message: ${detail}`,
        };
      }
      if (!isPureSurfaceConstraint(named.def)) {
        return {
          kind: "fatal",
          reason: `check_violation on non-surface constraint '${constraintName}'`,
          detail:
            `SQLSTATE 23514 named '${constraintName}', whose live definition is:\n` +
            `         ${named.def}\n` +
            "       That definition does not constrain `surface` alone, so the rejection\n" +
            "       cannot be attributed to the surface value. Either the probe row shape\n" +
            "       is wrong for another column, or the surface rule has been folded into\n" +
            "       a composite CHECK. Fix the probe (or split the constraint) — do NOT\n" +
            "       read this as 'live_pulse is rejected'.\n" +
            `       Message: ${detail}`,
        };
      }
      return { kind: "rejected", constraint: constraintName, sqlstate, detail };
    }

    case "FK_VIOLATION":
      return {
        kind: "fatal",
        reason: "foreign_key_violation — the probe is wrong, not the surface",
        detail:
          `SQLSTATE ${sqlstate || "23503"} on constraint '${constraintName}'. The probe row\n` +
          "       never reached the surface CHECK, so it proves NOTHING about\n" +
          "       'live_pulse'. rank_events.user_id references auth.users(id); the probe\n" +
          "       sources it with SELECT id FROM auth.users LIMIT 1 in the same\n" +
          "       statement, so an FK failure here means the schema moved. Fix the probe.\n" +
          `       Message: ${detail}`,
      };

    case "NOT_NULL_VIOLATION":
      return {
        kind: "fatal",
        reason: "not_null_violation — the probe is wrong, not the surface",
        detail:
          `SQLSTATE ${sqlstate || "23502"} on column '${constraintName}'. rank_events has\n` +
          "       gained a NOT NULL column the probe does not supply, so the row never\n" +
          "       reached the surface CHECK and proves NOTHING. Add the column to the\n" +
          "       probe INSERT with a known-good value and re-run.\n" +
          `       Message: ${detail}`,
      };

    case "NO_USER":
      return {
        kind: "fatal",
        reason: "auth.users is empty — no FK-valid user_id to probe with",
        detail:
          "rank_events.user_id is `uuid NOT NULL REFERENCES auth.users(id)` and\n" +
          "       auth.users returned no rows, so no probe row can be built that would\n" +
          "       survive the FK long enough to reach the surface CHECK. This is NOT\n" +
          "       'live_pulse is rejected' — it is 'the gate could not be run'.",
      };

    case "INSERT_ERROR": {
      const known: Record<string, string> = {
        "25006":
          "read_only_sql_transaction — the Management API executed this statement\n" +
          "       in a read-only transaction, so no INSERT can be attempted at all and\n" +
          "       the behavioural gate cannot run through this transport.",
        "42501":
          "insufficient_privilege — the configured token's role cannot INSERT into\n" +
          "       public.rank_events, so the probe measures permissions, not the CHECK.",
        "42P01": "undefined_table — public.rank_events does not exist live.",
        "42703": "undefined_column — the probe's column list no longer matches the table.",
      };
      return {
        kind: "fatal",
        reason: `unexpected SQLSTATE ${sqlstate || "unknown"} on the probe INSERT`,
        detail:
          (known[sqlstate] ??
            `SQLSTATE ${sqlstate || "unknown"} is not a class this gate can interpret.`) +
          "\n       The insert did not reach a verdict about `surface`, so nothing was\n" +
          "       proven. Fail closed.\n" +
          `       Message: ${detail}`,
      };
    }

    case "SETUP_ERROR":
      return {
        kind: "fatal",
        reason: `probe setup failed (SQLSTATE ${sqlstate || "unknown"})`,
        detail:
          "The probe failed before it could attempt the INSERT — most likely reading\n" +
          "       auth.users (permission, or the relation moved). Nothing about\n" +
          "       `surface` was tested.\n" +
          `       Message: ${detail}`,
      };

    default:
      return {
        kind: "fatal",
        reason: `unrecognised probe verdict '${verdict}'`,
        detail:
          "The sentinel parsed but carried a verdict this script does not know how\n" +
          "       to interpret. Treating an uninterpretable result as a pass is exactly\n" +
          "       the failure this rewrite exists to remove.\n" +
          `       Message: ${detail}`,
      };
  }
}

/**
 * Prove no probe row survived. Matches the FIXED sentinel prefix, so it also
 * catches leakage from any earlier run. Zero is the only acceptable answer;
 * "I could not check" is not.
 */
async function provePristine(): Promise<{ ok: true; count: number } | { ok: false; err: string }> {
  try {
    const rows = await liveQuery<{ n: string }>(`
      select count(*)::text as n
      from public.rank_events
      where item_id like '${PROBE_ITEM_PREFIX}%'
    `);
    const n = Number(rows[0]?.n ?? "NaN");
    if (!Number.isFinite(n)) {
      return { ok: false, err: "the pristine count returned no usable value" };
    }
    return { ok: true, count: n };
  } catch (e) {
    return { ok: false, err: e instanceof Error ? e.message : String(e) };
  }
}

// ── Informational reporting (NOT the gate) ───────────────────────────────────

/**
 * Values the codebase writes. Kept explicit rather than grepped: a grep would
 * quietly stop finding a value the moment someone reformats the call.
 *
 * Sources:
 *   pulse / discovery / events  — SURFACE_VALUES in routes/rankEvents.ts
 *   living_page                 — routes/rankEvents.ts, Living Page path
 *   compass                     — server-side insert on the Compass path
 *   live_pulse                  — logLivePulseServe in lib/rankLog.ts
 */
const WRITTEN_SURFACES = [
  "pulse",
  "discovery",
  "events",
  "living_page",
  "compass",
  "live_pulse",
  "watch_feed",
] as const;

/**
 * Outcome values the codebase writes. 'analytics' was added by 0197.
 *
 * 'dismiss' is added by 2294_rank_events_dismiss_outcome.sql and is written by
 * POST /api/rank-events/outcome. Until that migration is applied live it will
 * print ABSENT here — correctly: the code writes it and the live CHECK does not
 * yet permit it. This comparison is INFORMATIONAL ONLY (see the header) and
 * carries no exit code, so naming it here reports the pending state rather than
 * blocking on it.
 */
const WRITTEN_OUTCOMES = [
  "impression",
  "tap",
  "save",
  "join",
  "rsvp",
  "attended",
  "analytics",
  "dismiss",
] as const;

/**
 * Pull the quoted literals out of a CHECK definition.
 *
 * INFORMATIONAL ONLY — this is the fragile harvest that used to decide the
 * gate. It takes EVERY single-quoted literal anywhere in the definition and
 * does not verify the definition is a positive allow-list on the column, so a
 * value named in a negative clause reads as permitted. That is precisely why it
 * no longer answers the deploy question. Its output is a hint for a human
 * reading the definitions printed above it, nothing more.
 */
function harvestQuotedLiterals(checkDef: string): Set<string> {
  return new Set([...checkDef.matchAll(/'([^']+)'/g)].map((m) => m[1]!));
}

async function main(): Promise<void> {
  // ── 0. Environment ────────────────────────────────────────────────────────
  // Validated and parsed HERE, not at module scope, so that a malformed
  // SUPABASE_URL is a printed BLOCKED verdict with exit 2 rather than an
  // uncaught throw that Node would exit 1 on. Called explicitly (rather than
  // left to the first rawQuery) so the failure lands before any other work.
  requireTransport();

  // ── 1. Live constraint listing ────────────────────────────────────────────
  // Needed for two things: printing (informational) and ATTRIBUTING a
  // check_violation to a constraint name (load-bearing). If it cannot be read,
  // a 23514 could not be attributed, so the gate could not reach a verdict.
  const constraints: LiveConstraint[] = await liveQuery<LiveConstraint>(`
    select conname, pg_get_constraintdef(oid) as def
    from pg_constraint
    where conrelid = 'public.rank_events'::regclass
      and contype = 'c'
    order by conname
  `).catch((e: unknown) =>
    // Expression-bodied so the callback's inferred return type is `never`,
    // which keeps `constraints` typed LiveConstraint[] without relying on
    // definite-assignment analysis across a try/catch.
    blockGate(
      "the live constraint listing could not be read",
      "could not read public.rank_events CHECK constraints from pg_constraint:\n" +
        `       ${e instanceof Error ? e.message : String(e)}\n` +
        "       Without that listing a check_violation could not be attributed to the\n" +
        "       surface constraint, so the probe could not reach a trustworthy verdict.\n" +
        "       The check proved nothing, and 'unproven' is not 'safe'.",
    ),
  );

  console.log("── live CHECK constraints on rank_events (INFORMATIONAL) ──");
  if (constraints.length === 0) {
    console.log("  (none)");
  } else {
    for (const c of constraints) console.log(`  ${c.conname}: ${c.def}`);
  }
  console.log(
    "  NOTE: printed for a human. The deploy verdict below comes from a\n" +
      "        behavioural probe, NOT from parsing these strings.",
  );
  console.log();

  const surfaceConstraints = constraints.filter((c) => /\bsurface\b/.test(c.def));

  // ── 2. The probe ──────────────────────────────────────────────────────────
  // One required surface today. Looping keeps the contract honest if a second
  // is ever added: each gets its own probe and its own GATE line.
  const runId = randomUUID();
  const outcomes = new Map<string, ProbeOutcome>();

  console.log("── behavioural probe ──");
  console.log(`  run id: ${runId}`);
  for (const surface of REQUIRED_SURFACES) {
    console.log(`  probing INSERT ... surface='${surface}' (always rolled back)`);
    let res: RawResponse;
    try {
      res = await rawQuery(buildProbeSql(surface, runId));
    } catch (e) {
      outcomes.set(surface, {
        kind: "fatal",
        reason: "the probe request itself failed",
        detail:
          "the Management API call did not complete (network / DNS / TLS / timeout):\n" +
          `       ${e instanceof Error ? e.message : String(e)}\n` +
          "       No verdict was reached. Note the probe cannot have written anything:\n" +
          "       it is one self-aborting statement, so a request that never completed\n" +
          "       leaves nothing behind. The pristine check below confirms it.",
      });
      continue;
    }
    console.log(`  transport: HTTP ${res.status}`);
    outcomes.set(surface, classifyProbe(res, constraints));
  }
  console.log();

  // ── 3. Persistence proof — runs unconditionally, including after a fatal ──
  const pristine = await provePristine();
  console.log("── probe row persistence proof ──");
  if (!pristine.ok) {
    console.log(`  COULD NOT VERIFY: ${pristine.err}`);
  } else {
    console.log(
      `  rows matching item_id LIKE '${PROBE_ITEM_PREFIX}%' : ${pristine.count}` +
        (pristine.count === 0 ? "  (expected 0 — nothing persisted)" : "  ← EXPECTED 0"),
    );
  }
  console.log();

  if (!pristine.ok) {
    blockGate(
      "could not prove the probe row did not persist",
      `the post-probe pristine count failed: ${pristine.err}\n` +
        "       The probe cannot commit by construction (one statement, unconditional\n" +
        "       RAISE), but this gate does not ship on 'by construction' alone. Until\n" +
        "       the count is confirmed zero, treat the run as unverified.",
    );
  }
  if (pristine.count !== 0) {
    blockGate(
      `${pristine.count} probe row(s) PERSISTED`,
      `${pristine.count} row(s) with item_id LIKE '${PROBE_ITEM_PREFIX}%' exist live.\n` +
        "       The probe is designed so this is impossible: one statement whose final\n" +
        "       act is an unconditional RAISE. A non-zero count means either the\n" +
        "       transport committed something it should not have, or a previous run of\n" +
        "       an older probe leaked. Delete them —\n" +
        `         DELETE FROM public.rank_events WHERE item_id LIKE '${PROBE_ITEM_PREFIX}%';\n` +
        "       — and do not ship until the count is zero, because those rows are\n" +
        "       synthetic and would pollute the ranking corpus.",
    );
  }

  // ── 4. Structural guard: no CHECK on `surface` at all ─────────────────────
  // Deliberately AFTER the probe: an accepted insert into a table with no
  // surface constraint proves only that nothing is ENFORCED, which is not the
  // same fact as 'live_pulse is permitted'. This is the half-applied-0199 state
  // (the DROP committed, the revalidating ADD did not).
  //
  // Note what is NOT here any more: the old "more than one CHECK mentions
  // surface" fatal. The probe is immune to that — the effective vocabulary is
  // the intersection of all of them, and the probe measures the intersection
  // directly by attempting the write. It is now reported and nothing more.
  if (constraints.length > 0 && surfaceConstraints.length === 0) {
    blockGate(
      "no CHECK constraint on `surface` live",
      "rank_events has CHECK constraints, but NONE of them constrains `surface`.\n" +
        "       This is the half-applied 0199 state: the DROP committed and the\n" +
        "       revalidating ADD did not. Any surface string is accepted right now, so\n" +
        "       an accepted probe means 'unenforced', not 'verified'. Re-apply\n" +
        "       src/migrations/0199_rank_events_live_pulse_surface.sql (idempotent:\n" +
        "       DROP ... IF EXISTS then ADD) and re-run. Read the 'observed rows by\n" +
        "       surface' output of a previous run first — a row written while the\n" +
        "       constraint was absent will make the revalidating ADD fail.",
    );
  }
  if (constraints.length === 0) {
    blockGate(
      "rank_events has no CHECK constraints live",
      "public.rank_events has NO CHECK constraints at all. The probe can only\n" +
        "       observe that nothing is enforced, never that a value is permitted.\n" +
        "       That is not a green light; it is a schema that has lost its\n" +
        "       guarantees. Restore 0153/0154/0197/0199 before shipping.",
    );
  }
  // Same rule applied to `outcome`, carried over unchanged from the previous
  // version of this check. Nothing about the behavioural probe makes it safe to
  // relax an existing fail-closed condition, so it stays: 0197 owns this
  // constraint, and without it the 'analytics' sentinel the ranking pipeline
  // depends on is unverifiable rather than permitted.
  if (!constraints.some((c) => /\boutcome\b/.test(c.def))) {
    blockGate(
      "no CHECK constraint on `outcome` live",
      "rank_events has no CHECK constraint on `outcome`. 0197 owns it, and\n" +
        "       without it the 'analytics' sentinel this code depends on is\n" +
        "       unverifiable rather than permitted. Restore it before shipping.",
    );
  }
  if (surfaceConstraints.length > 1) {
    console.log(
      `  NOTE: ${surfaceConstraints.length} CHECK constraints mention 'surface'. The effective\n` +
        "        vocabulary is their INTERSECTION. This used to be fatal because no\n" +
        "        single definition string could be read as the answer; the probe\n" +
        "        measures the intersection directly, so it is now only worth a human's\n" +
        "        attention — most likely a DROP CONSTRAINT IF EXISTS that matched no\n" +
        "        name and left an older narrow CHECK in place alongside the new one.\n",
    );
  }

  // ── 5. Any remaining fatal, then the single GATE verdict ──────────────────
  const firstFatal = [...outcomes.entries()].find(([, o]) => o.kind === "fatal");
  if (firstFatal) {
    const o = firstFatal[1] as Extract<ProbeOutcome, { kind: "fatal" }>;
    blockGate(o.reason, o.detail);
  }

  let gateFailed = false;
  for (const s of REQUIRED_SURFACES) {
    const o = outcomes.get(s)!;
    if (o.kind === "accepted") {
      console.log(`GATE ${s}: PERMITTED`);
    } else {
      // Only an ATTRIBUTED surface check_violation reaches here.
      console.log(`GATE ${s}: NOT PERMITTED`);
      gateFailed = true;
    }
  }
  console.log();

  for (const s of REQUIRED_SURFACES) {
    const o = outcomes.get(s)!;
    if (o.kind === "rejected") {
      console.log(
        `  '${s}' was rejected by constraint '${o.constraint}' (SQLSTATE ${o.sqlstate}).\n` +
          `  Message: ${o.detail}`,
      );
    }
  }

  // ── 6. Informational value report (fragile by construction, never the gate) ─
  let informationalFailed = false;
  const report = (label: string, def: LiveConstraint | undefined, written: readonly string[]) => {
    console.log(`── ${label} — INFORMATIONAL, literal harvest, NOT the gate ──`);
    if (!def) {
      console.log(`  (no live CHECK constrains \`${label}\` — nothing to compare against)`);
      console.log();
      return;
    }
    const allowed = harvestQuotedLiterals(def.def);
    for (const v of written) {
      const listed = allowed.has(v);
      if (!listed) informationalFailed = true;
      console.log(`  ${listed ? "listed  " : "ABSENT  "}  ${v}`);
    }
    const unused = [...allowed].filter((a) => !written.includes(a));
    if (unused.length) console.log(`  (listed but never written: ${unused.join(", ")})`);
    console.log(
      "  Caveat: 'listed' means the literal appears SOMEWHERE in the definition\n" +
        "  above — including in a negative clause. It is a reading aid, not a verdict.",
    );
    console.log();
  };

  report("surface", surfaceConstraints[0], WRITTEN_SURFACES);
  report(
    "outcome",
    constraints.find((c) => /\boutcome\b/.test(c.def)),
    WRITTEN_OUTCOMES,
  );

  // ── 7. Observed rows. Permitted-and-unused is a different bug from rejected ─
  try {
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
  } catch (e) {
    // Informational only — it must not mask, upgrade, or downgrade the verdict.
    console.log("── observed rows by surface ──");
    console.log(
      `  (unavailable: ${e instanceof Error ? e.message : String(e)})\n` +
        "  This is reporting, not the gate. The verdict above already stands on the\n" +
        "  probe and its pristine proof, both of which completed.",
    );
  }

  console.log();
  if (gateFailed) {
    console.error(
      "BLOCKED — the live surface CHECK rejected a surface the pending deploy writes.\n" +
        "       This is a behavioural fact: the database was asked and it said no.\n" +
        "       Apply src/migrations/0199_rank_events_live_pulse_surface.sql via the\n" +
        "       Management API BEFORE shipping the code that writes it.\n" +
        "       logLivePulseServe() is fire-and-forget and only calls onError, so\n" +
        "       shipping first loses 100% of the signal with no alert — the exact\n" +
        "       failure 'living_page' is in today.",
    );
    process.exit(EXIT_BLOCKED);
  }
  if (informationalFailed) {
    // Printed prominently, and NOT given an exit code of its own.
    //
    // This used to exit 1. Exit 1 is also Node's default for a crash, so a run
    // that died on an uncaught throw was indistinguishable from this — and
    // callers were told to treat 1 as "proceed". A finding that is genuinely
    // informational must not consume a distinct code; it must be loud instead.
    console.error(
      "════════════════════════════════════════════════════════════════════════\n" +
        "FINDING (informational — NOT a blocker, exit code stays 0)\n" +
        "════════════════════════════════════════════════════════════════════════\n" +
        "       The informational harvest above did not find every written value in\n" +
        "       the live definitions. Those inserts are likely failing in production;\n" +
        "       the Living Page path swallows the error by design (fire-and-forget),\n" +
        "       so it surfaces nowhere but a warn log.\n" +
        "       This is the standing 'living_page' / 'compass' loss and it is\n" +
        "       reported on EVERY run. It is NOT the gate: every GATE line above says\n" +
        "       PERMITTED, proven by an accepted-and-rolled-back insert.\n" +
        "       Widening a CHECK is a production schema change: decide it deliberately.\n" +
        "════════════════════════════════════════════════════════════════════════",
    );
  }
  console.log(
    "PASS — the live database accepted an insert for every required surface\n" +
      "       (and rolled every one of them back)." +
      (informationalFailed
        ? "\n       See the informational FINDING above; it does not block the deploy."
        : ""),
  );
}

// A throw escaping main() means the run did not complete. Node would exit 1 for
// it by default, and 1 is exactly the code that must never carry a verdict — so
// this catch converts it to a printed BLOCKED verdict and exit 3.
//
// This catch only covers what main() awaits. That is why NOTHING that can throw
// runs at module scope: a module-scope throw happens before this handler is
// even installed, and Node's default 1 would be the whole story. See
// requireTransport() and the header.
main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  blockGate(
    "the gate threw before reaching a verdict",
    "the run did not complete (see the error above). Nothing was proven, and\n" +
      "       'unproven' is not 'safe'. The probe cannot have left a row behind — it\n" +
      "       is a single self-aborting statement — but if you want certainty, run:\n" +
      `         SELECT count(*) FROM public.rank_events WHERE item_id LIKE '${PROBE_ITEM_PREFIX}%';`,
  );
});
