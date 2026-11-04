/**
 * Migration 3985 — client EXECUTE withdrawn from the SECURITY DEFINER functions no client needs, and
 * search_path pinned on ten functions (portava-ci advisor, 2026-11-04). And the offline ratchet that
 * keeps a later migration from undoing it (src/scripts/lib/definerClientExecuteWithdrawn.ts, run by
 * check:security-definer-oracles).
 *
 * WHAT WOULD TURN THIS RED
 *   - the file revoking from, or granting to, any role other than the ones pinned below, touching a
 *     function the decision table keeps, pinning a different set, or changing default privileges;
 *   - a revoke that forgets PUBLIC, or an anon-only revoke that loses authenticated or service_role;
 *   - the ratchet's lists drifting from the file, or the ratchet missing any of its red shapes or
 *     flagging its green ones, or the real corpus failing it;
 *   - on PostgreSQL: the apply not producing exactly the pinned privileges and settings; a policy TO
 *     authenticated that calls an anon-only function failing for authenticated, or anon's read turning
 *     into a function-permission error; a trigger no longer firing; a pinned body not resolving; the
 *     precondition not refusing each unsafe starting state (or refusing a safe one); the postcondition
 *     not standing alone or not being load-bearing; the rollback not restoring the pre-state.
 *
 * EXECUTED on PGlite (PostgreSQL in-process; the repo's convention). The fixture stubs the nine
 * SECURITY DEFINER functions with their real signatures, and installs the ten pinned functions from
 * the migrations that define them (2120, 2773 transformed by 2787 and 2799, 2776, 2784, 2998, 3440).
 *
 * No function is named by a bare string literal in this file: checkSecurityDefinerOracles counts one as
 * a reference, and event_is_in_state is ledgered there as referenced by nothing.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *        node --import tsx/esm --test src/test/definerClientExecuteWithdrawn3985.test.ts
 */
import { describe, it, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";

import { maskForKeywordScan, postconditionBlocks, topLevelStatements } from "../scripts/lib/migrationSqlBlocks.js";
import {
  DEFINER_EXECUTE_CLOSED_BY,
  PINNED_SEARCH_PATH,
  WITHDRAWN_CLIENT_EXECUTE,
  expectedClosingStatements,
  findDefinerExecuteRegressions,
  fnName,
  type CorpusFile,
} from "../scripts/lib/definerClientExecuteWithdrawn.js";

const FILE = "3985_definer_client_execute_and_search_path_pins.sql";
const ROLLBACK = "2026-11-04-3985-definer-client-execute-and-search-path-pins-rollback.sql";
const migration = (f: string) => readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8");
const sql = migration(FILE);
const rollbackUrl = new URL(`../../../../db/rollback/${ROLLBACK}`, import.meta.url);

// ── the decision, pinned independently of the ratchet's own lists ──────────────────────────────────
const REVOKED_FROM_ALL_CLIENTS = [
  "public.add_owner_as_member()",
  "public.enforce_is_official_privileged()",
  "public.enforce_profile_role_privileged()",
  "public.enforce_trip_max_members()",
  "public.handle_new_user()",
  "public.event_is_in_state(uuid, public.event_state[])",
];
const REVOKED_FROM_ANON_ONLY = [
  "public.can_post_to_trip(uuid)",
  "public.user_is_event_participant(uuid)",
  "public.is_accepted_trip_member(uuid)",
];
const PINNED = [
  "public.canonical_events_append_only()",
  "public.input_normalize_city_key(text)",
  "public.stories_freeze_deleted_at()",
  "public.trip_presence_freshness(timestamptz, timestamptz, timestamptz)",
  "public.trip_reservation_events_append_only()",
  "public.trip_reservation_events_no_direct_delete()",
  "public.trip_snapshot_fold(jsonb, jsonb)",
  "public.trip_snapshot_fold_all(jsonb, jsonb[])",
  "public.trip_snapshot_replay(uuid, jsonb, bigint, bigint)",
  "public.trip_snapshot_seed(uuid)",
];
/** Every SECURITY DEFINER function the advisor flagged, with what 3985 does about it. */
const ADVISOR_DEFINER_FINDINGS: Record<string, "revoked from anon and authenticated" | "revoked from anon" | "kept: policy-referenced" | "kept: extension member"> = {
  "public.add_owner_as_member()": "revoked from anon and authenticated",
  "public.enforce_is_official_privileged()": "revoked from anon and authenticated",
  "public.enforce_profile_role_privileged()": "revoked from anon and authenticated",
  "public.enforce_trip_max_members()": "revoked from anon and authenticated",
  "public.handle_new_user()": "revoked from anon and authenticated",
  "public.event_is_in_state(uuid, public.event_state[])": "revoked from anon and authenticated",
  "public.can_post_to_trip(uuid)": "revoked from anon",
  "public.user_is_event_participant(uuid)": "revoked from anon",
  "public.is_accepted_trip_member(uuid)": "revoked from anon",
  "public.auth_uid_has_event_role(uuid, public.event_role_type[])": "kept: policy-referenced",
  "public.auth_uid_has_event_rsvp(uuid, public.event_rsvp_status[])": "kept: policy-referenced",
  "public.auth_uid_is_event_cohost(uuid)": "kept: policy-referenced",
  "public.auth_uid_is_event_host(uuid)": "kept: policy-referenced",
  "public.can_see_post(uuid)": "kept: policy-referenced",
  "public.can_see_postcard(uuid)": "kept: policy-referenced",
  "public.can_see_trip(uuid)": "kept: policy-referenced",
  "public.viewer_is_blocked(uuid)": "kept: policy-referenced",
  "public.intel_self_contributor_tokens()": "kept: policy-referenced",
  "public.post_media_path_is_moderated(text, uuid)": "kept: policy-referenced",
  "public.st_estimatedextent(text, text)": "kept: extension member",
  "public.st_estimatedextent(text, text, text)": "kept: extension member",
  "public.st_estimatedextent(text, text, text, boolean)": "kept: extension member",
};

/** Top-level statements, leading comment lines dropped, whitespace collapsed. */
const flat = (text: string): string[] => topLevelStatements(text).map((s) => s.replace(/^(\s*--[^\n]*\n)+/, "").replace(/\s+/g, " ").trim()).filter(Boolean);
const statements = flat(sql);
const privilegeStatements = statements.filter((s) => /^(GRANT|REVOKE)\b/i.test(s));
const alterStatements = statements.filter((s) => /^ALTER\s+FUNCTION\b/i.test(s));
/** The signatures a DO block's text[] constant names, in order. */
const arrayConstant = (block: string, name: string): string[] => {
  const m = new RegExp(`${name}\\s+constant\\s+text\\[\\]\\s*:=\\s*ARRAY\\[([\\s\\S]*?)\\];`).exec(block);
  assert.ok(m, `${name} is declared`);
  return [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
};

describe("3985 — static shape", () => {
  it("is one transaction: $pre$ first, the statements, ONE assertion-only $post$ before the COMMIT; nothing but privileges and settings change", () => {
    assert.equal((sql.match(/^BEGIN;$/gm) ?? []).length, 1);
    assert.equal((sql.match(/^COMMIT;$/gm) ?? []).length, 1);
    assert.ok(sql.trimEnd().endsWith("COMMIT;"), "nothing after the COMMIT");
    assert.ok(sql.indexOf("DO $pre$") < sql.indexOf("\nREVOKE "));
    const post = postconditionBlocks(sql);
    assert.equal(post.length, 1);
    assert.ok(post[0]!.text.includes("DO $post$"));
    assert.ok(sql.indexOf(post[0]!.text) > sql.lastIndexOf("\nALTER FUNCTION ") && sql.indexOf(post[0]!.text) < sql.lastIndexOf("\nCOMMIT;"));
    const masked = maskForKeywordScan(sql);
    assert.doesNotMatch(masked, /\b(CREATE|DROP|TRUNCATE|INSERT|UPDATE|DELETE|COMMENT)\b/i);
    assert.doesNotMatch(masked, /\bALTER\s+(TABLE|POLICY|VIEW|SCHEMA|ROLE|DEFAULT\s+PRIVILEGES)\b/i);
    assert.doesNotMatch(masked, /SECURITY\s+(DEFINER|INVOKER)/i, "no function's security mode changes");
    const allowed = /^(BEGIN;|COMMIT;|SET LOCAL lock_timeout = '5s';|DO \$(pre|post)\$ |GRANT EXECUTE ON FUNCTION |REVOKE ALL ON FUNCTION |ALTER FUNCTION |NOTIFY pgrst, 'reload schema';)/;
    assert.deepEqual(statements.filter((s) => !allowed.test(s)), []);
  });

  it("pins the revoke list: each withdrawn function is revoked from PUBLIC and exactly its roles, and granted to exactly the roles that keep it", () => {
    const expected: string[] = [];
    for (const sig of REVOKED_FROM_ALL_CLIENTS) expected.push(`REVOKE ALL ON FUNCTION ${sig} FROM PUBLIC, anon, authenticated;`, `GRANT EXECUTE ON FUNCTION ${sig} TO service_role;`);
    for (const sig of REVOKED_FROM_ANON_ONLY) expected.push(`REVOKE ALL ON FUNCTION ${sig} FROM PUBLIC, anon;`, `GRANT EXECUTE ON FUNCTION ${sig} TO authenticated, service_role;`);
    assert.deepEqual(privilegeStatements, expected);
  });

  it("pins the search_path list: ten ALTER FUNCTION ... SET search_path = '' and nothing else", () => {
    assert.deepEqual(alterStatements, PINNED.map((sig) => `ALTER FUNCTION ${sig} SET search_path = '';`));
  });

  it("covers every SECURITY DEFINER function the advisor flagged, and touches none it keeps", () => {
    const touched = new Set([...privilegeStatements, ...alterStatements].map((s) => /FUNCTION (public\.[a-z_]+\([^)]*\))/.exec(s)![1]!));
    for (const [sig, fate] of Object.entries(ADVISOR_DEFINER_FINDINGS)) {
      if (fate.startsWith("revoked")) assert.ok(touched.has(sig), `${sig} is revoked`);
      else assert.ok(![...touched].some((t) => fnName(t) === fnName(sig)), `${sig} is ${fate} and must not be touched`);
    }
    assert.deepEqual(
      Object.entries(ADVISOR_DEFINER_FINDINGS).filter(([, f]) => f.startsWith("revoked")).map(([s]) => s).sort(),
      [...REVOKED_FROM_ALL_CLIENTS, ...REVOKED_FROM_ANON_ONLY].sort(),
    );
  });

  it("the precondition and postcondition name exactly the same three lists", () => {
    const pre = topLevelStatements(sql).find((s) => s.includes("DO $pre$"))!;
    const post = postconditionBlocks(sql)[0]!.text;
    for (const block of [pre, post]) {
      assert.deepEqual(arrayConstant(block, "v_all"), REVOKED_FROM_ALL_CLIENTS);
      assert.deepEqual(arrayConstant(block, "v_anon"), REVOKED_FROM_ANON_ONLY);
      assert.deepEqual(arrayConstant(block, "v_pin"), PINNED);
    }
  });

  it("the ratchet's lists are this file's lists, and its expected statements are the file's statements", () => {
    assert.equal(DEFINER_EXECUTE_CLOSED_BY, FILE);
    assert.deepEqual(WITHDRAWN_CLIENT_EXECUTE.filter((w) => w.withdrawnFrom.length === 2).map((w) => w.signature), REVOKED_FROM_ALL_CLIENTS);
    assert.deepEqual(WITHDRAWN_CLIENT_EXECUTE.filter((w) => w.withdrawnFrom.length === 1).map((w) => w.signature), REVOKED_FROM_ANON_ONLY);
    assert.ok(WITHDRAWN_CLIENT_EXECUTE.filter((w) => w.withdrawnFrom.length === 1).every((w) => w.withdrawnFrom[0] === "anon"));
    assert.deepEqual(WITHDRAWN_CLIENT_EXECUTE.filter((w) => w.triggerFn).map((w) => w.signature), REVOKED_FROM_ALL_CLIENTS.slice(0, 5));
    assert.deepEqual(PINNED_SEARCH_PATH, PINNED);
    assert.deepEqual(expectedClosingStatements().map((s) => `${s};`), [...privilegeStatements, ...alterStatements]);
  });

  it("the rollback exists, undoes exactly this file, and deletes exactly this file's ledger row", () => {
    assert.ok(sql.includes(`db/rollback/${ROLLBACK}`), "the header names the rollback");
    assert.ok(existsSync(rollbackUrl));
    const rb = readFileSync(rollbackUrl, "utf8");
    const rbStatements = flat(rb);
    assert.deepEqual(rbStatements.filter((s) => /^GRANT\b/.test(s)), [
      ...REVOKED_FROM_ALL_CLIENTS.map((sig) => `GRANT EXECUTE ON FUNCTION ${sig} TO PUBLIC, anon, authenticated;`),
      ...REVOKED_FROM_ANON_ONLY.map((sig) => `GRANT EXECUTE ON FUNCTION ${sig} TO PUBLIC, anon;`),
    ]);
    assert.deepEqual(rbStatements.filter((s) => /^ALTER\b/.test(s)), PINNED.map((sig) => `ALTER FUNCTION ${sig} RESET search_path;`));
    assert.deepEqual(rbStatements.filter((s) => /^DELETE\b/.test(s)), [`DELETE FROM public.schema_migration_ledger WHERE filename = '${FILE}';`]);
    assert.doesNotMatch(maskForKeywordScan(rb), /\bREVOKE\b|\bservice_role\b/, "the rollback never touches service_role");
  });

  it("the number is a free gap: no other file uses 3985, and none of 3986-3999 (which production applies BEFORE this gap file) names any of the nineteen", () => {
    const names = readdirSync(new URL("../migrations/", import.meta.url)).filter((n) => n.endsWith(".sql"));
    assert.deepEqual(names.filter((n) => n.startsWith("3985_")), [FILE]);
    const fns = [...REVOKED_FROM_ALL_CLIENTS, ...REVOKED_FROM_ANON_ONLY, ...PINNED].map(fnName);
    const above = names.filter((x) => x > FILE && x < "4000");
    assert.ok(above.length > 0, "the band above 3985 is populated on main; this proves the scan looked");
    for (const n of above) {
      const text = maskForKeywordScan(migration(n));
      for (const f of fns) assert.doesNotMatch(text, new RegExp(`\\b${f}\\b`), `${n} names ${f}: re-check that 3985 is order-independent of it`);
    }
  });
});

describe("the ratchet (definerClientExecuteWithdrawn.ts)", () => {
  const anonOnly = REVOKED_FROM_ANON_ONLY[0]!; // can_post_to_trip
  const oracle = REVOKED_FROM_ALL_CLIENTS[5]!; // event_is_in_state
  const trigger = REVOKED_FROM_ALL_CLIENTS[0]!; // add_owner_as_member
  const pin = PINNED[9]!; // trip_snapshot_seed
  const corpusWith = (later: string, before = ""): CorpusFile[] => [
    { file: "src/migrations/3000_before.sql", sql: before },
    { file: `src/migrations/${FILE}`, sql },
    { file: "src/migrations/3999_later.sql", sql: later },
  ];
  const problems = (later: string, before = "") => findDefinerExecuteRegressions(corpusWith(later, before)).problems;

  const red: Array<[string, string, RegExp]> = [
    ["a GRANT back to anon", `GRANT EXECUTE ON FUNCTION ${anonOnly} TO anon;`, /grants EXECUTE on public\.can_post_to_trip\(uuid\) to anon/],
    ["a GRANT ALL back to PUBLIC", `GRANT ALL ON FUNCTION ${trigger} TO PUBLIC;`, /grants EXECUTE on public\.add_owner_as_member\(\) to public/],
    ["a GRANT back to authenticated on a fully withdrawn function", `GRANT EXECUTE ON FUNCTION public.${fnName(oracle)}(uuid, public.event_state[]) TO service_role, authenticated;`, /to authenticated/],
    ["a GRANT that names the function without its argument list, second in a list", `GRANT EXECUTE ON FUNCTION public.trip_snapshot_seed(uuid), public.${fnName(anonOnly)} TO anon;`, /grants EXECUTE on public\.can_post_to_trip\(uuid\) to anon/],
    ["a GRANT inside a DO block",`DO $$ BEGIN GRANT EXECUTE ON FUNCTION ${oracle} TO anon; END $$;`, /grants EXECUTE on public\.event_is_in_state/],
    ["a GRANT on ALL FUNCTIONS IN SCHEMA public", "GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO anon, authenticated;", /ALL FUNCTIONS IN SCHEMA public to anon, authenticated/],
    ["a DROP with no revoke", `DROP FUNCTION IF EXISTS ${anonOnly};`, /drops public\.can_post_to_trip\(uuid\) and does not revoke EXECUTE from public, anon/],
    ["a plain CREATE with no revoke", `CREATE FUNCTION public.${fnName(oracle)}(eid uuid, states public.event_state[]) RETURNS boolean LANGUAGE sql SECURITY DEFINER AS $$ SELECT true $$;`, /creates public\.event_is_in_state.* without OR REPLACE/],
    ["a rename", `ALTER FUNCTION ${anonOnly} RENAME TO may_post;`, /renames, moves or re-owns public\.can_post_to_trip/],
    ["a re-definition that drops the pin", `CREATE OR REPLACE FUNCTION ${pin.replace("(uuid)", "(p_trip_id uuid)")} RETURNS jsonb LANGUAGE sql IMMUTABLE AS $fn$ SELECT '{}'::jsonb $fn$;`, /re-defines public\.trip_snapshot_seed without SET search_path/],
    ["a RESET search_path", `ALTER FUNCTION ${pin} RESET search_path;`, /resets, renames or moves public\.trip_snapshot_seed/],
    ["a SET search_path TO DEFAULT", `ALTER FUNCTION ${pin} SET search_path TO DEFAULT;`, /resets, renames or moves public\.trip_snapshot_seed/],
    ["a DROP of a pinned function with no pinned re-create", `DROP FUNCTION ${pin};`, /drops public\.trip_snapshot_seed and does not re-create it with SET search_path/],
    ["a policy TO public calling an anon-only function", `CREATE POLICY p_any ON public.posts FOR INSERT WITH CHECK (public.${fnName(anonOnly)}(trip_id));`, /policy public\.posts::p_any .* applies to public/],
    ["a policy TO anon calling an anon-only function", `CREATE POLICY p_anon ON public.posts FOR INSERT TO anon WITH CHECK (${fnName(anonOnly)}(trip_id));`, /applies to anon/],
    ["a policy TO authenticated calling a fully withdrawn function", `CREATE POLICY e_state ON public.events FOR SELECT TO authenticated USING (public.${fnName(oracle)}(id, ARRAY['live']::public.event_state[]));`, /applies to authenticated/],
    ["an ALTER POLICY that widens to PUBLIC", `ALTER POLICY posts_insert ON public.posts TO public;`, /policy public\.posts::posts_insert .* applies to public/],
    ["a view calling a withdrawn function", `CREATE VIEW public.v AS SELECT ${fnName(anonOnly)}(t.id) FROM public.trips t;`, /has a view that calls public\.can_post_to_trip/],
    ["a SECURITY INVOKER function calling a withdrawn function", `CREATE FUNCTION public.wrap(t uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT public.${fnName(anonOnly)}(t) $$;`, /has a SECURITY INVOKER function that calls public\.can_post_to_trip/],
  ];
  for (const [label, later, msg] of red) {
    it(`fails on ${label}`, () => {
      const before = label.startsWith("an ALTER POLICY") ? `CREATE POLICY posts_insert ON public.posts FOR INSERT TO authenticated WITH CHECK (public.${fnName(anonOnly)}(trip_id));` : "";
      const p = problems(later, before);
      assert.ok(p.some((x) => msg.test(x)), `${label}: ${p.join("\n") || "(no problem reported)"}`);
    });
  }

  const green: Array<[string, string]> = [
    ["a GRANT to authenticated on an anon-only function", `GRANT EXECUTE ON FUNCTION ${anonOnly} TO authenticated;`],
    ["a GRANT to service_role", `GRANT EXECUTE ON FUNCTION ${oracle} TO service_role;`],
    ["a GRANT on another schema's function of the same name", "GRANT EXECUTE ON FUNCTION authz.is_accepted_trip_member(uuid, uuid) TO anon, authenticated;"],
    ["a DROP and re-create that revokes in the same file", `DROP FUNCTION ${anonOnly}; CREATE FUNCTION public.${fnName(anonOnly)}(t_id uuid) RETURNS boolean LANGUAGE sql SECURITY DEFINER AS $$ SELECT true $$; REVOKE ALL ON FUNCTION ${anonOnly} FROM PUBLIC, anon;`],
    ["a CREATE OR REPLACE that keeps the grants", `CREATE OR REPLACE FUNCTION public.${fnName(anonOnly)}(t_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog AS $$ SELECT true $$;`],
    ["a re-definition that keeps a pin (before the body)", `CREATE OR REPLACE FUNCTION public.${fnName(pin)}(p_trip_id uuid) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path = '' AS $fn$ SELECT '{}'::jsonb $fn$;`],
    ["a re-definition that keeps a pin (after the body)", `CREATE OR REPLACE FUNCTION public.${fnName(pin)}(p_trip_id uuid) RETURNS jsonb AS $fn$ SELECT '{}'::jsonb $fn$ LANGUAGE sql IMMUTABLE SET search_path = '';`],
    ["a pg_get_functiondef transform of a pinned function", `DO $tx$ DECLARE d text; BEGIN SELECT pg_get_functiondef(p.oid) INTO d FROM pg_proc p WHERE p.proname = 'trip_snapshot_fold'; d := replace(d, 'a', 'b'); EXECUTE d; END $tx$;`],
    ["a policy TO authenticated calling an anon-only function", `CREATE POLICY p_auth ON public.posts FOR INSERT TO authenticated WITH CHECK (public.${fnName(anonOnly)}(trip_id));`],
    ["a policy calling another schema's function of the same name", "CREATE POLICY p_crew ON public.trip_availability FOR SELECT USING (authz.is_accepted_trip_member(trip_id, auth.uid()));"],
    ["a SECURITY DEFINER function calling a withdrawn function", `CREATE FUNCTION public.wrap(t uuid) RETURNS boolean LANGUAGE sql SECURITY DEFINER AS $$ SELECT public.${fnName(anonOnly)}(t) $$;`],
    ["a trigger bound to a withdrawn trigger function", `CREATE TRIGGER t AFTER INSERT ON public.trips FOR EACH ROW EXECUTE FUNCTION ${trigger};`],
    ["a dropped policy that used to be wrong", `CREATE POLICY p_any ON public.posts FOR INSERT WITH CHECK (public.${fnName(anonOnly)}(trip_id)); DROP POLICY p_any ON public.posts;`],
  ];
  for (const [label, later] of green) {
    it(`passes ${label}`, () => assert.deepEqual(problems(later), []));
  }

  it("fails when the closing file is missing or drifts from the lists", () => {
    assert.match(findDefinerExecuteRegressions([{ file: "src/migrations/3999_x.sql", sql: "" }]).problems.join("\n"), /3985_definer_client_execute_and_search_path_pins\.sql is missing/);
    const drifted = sql.replace(`REVOKE ALL ON FUNCTION ${anonOnly} FROM PUBLIC, anon;`, `REVOKE ALL ON FUNCTION ${anonOnly} FROM anon;`);
    const p = findDefinerExecuteRegressions([{ file: `src/migrations/${FILE}`, sql: drifted }]).problems.join("\n");
    assert.match(p, /no longer makes `REVOKE ALL ON FUNCTION public\.can_post_to_trip\(uuid\) FROM PUBLIC, anon;`/);
    assert.match(p, /makes `REVOKE ALL ON FUNCTION public\.can_post_to_trip\(uuid\) FROM anon;`, which definerClientExecuteWithdrawn\.ts does not list/);
  });

  it("the real corpus passes, and the scan saw it", () => {
    const corpus: CorpusFile[] = [{ file: "baseline/20260819_baseline_structure.sql", sql: readFileSync(new URL("../../baseline/20260819_baseline_structure.sql", import.meta.url), "utf8") }];
    for (const n of readdirSync(new URL("../migrations/", import.meta.url)).filter((x) => x.endsWith(".sql")).sort()) corpus.push({ file: `src/migrations/${n}`, sql: migration(n) });
    const r = findDefinerExecuteRegressions(corpus);
    assert.deepEqual(r.problems, []);
    assert.ok(r.stats.closingIndex > 0);
    assert.ok(r.stats.policiesSurviving >= 100, `${r.stats.policiesSurviving} policies parsed`);
    assert.ok(r.stats.guardedPolicyEdges >= 2, "posts_insert and events_participant_read call anon-only functions TO authenticated, and the scan sees both");
  });
});

// ── PostgreSQL ─────────────────────────────────────────────────────────────────────────────────────
/** The CREATE statement that starts with `head` in a migration file, through its body's closing tag. */
function createStatement(file: string, head: string): string {
  const text = migration(file);
  const at = text.indexOf(head);
  assert.ok(at >= 0, `${file} carries ${head}`);
  const as = /\bAS\s+(\$[A-Za-z0-9_]*\$)/.exec(text.slice(at))!;
  const bodyStart = at + as.index + as[0].length;
  const bodyEnd = text.indexOf(as[1]!, bodyStart);
  return text.slice(at, text.indexOf(";", bodyEnd + as[1]!.length) + 1);
}

const TRIP = "a5555555-5555-4555-8555-555555555501";
const OWNER = "a5555555-5555-4555-8555-555555555502";
const EV_LIVE = "a6666666-6666-4666-8666-666666666601";
const EV_DRAFT = "a6666666-6666-4666-8666-666666666602";
const RES = "a7777777-7777-4777-8777-777777777701";
const IS_IN_STATE = REVOKED_FROM_ALL_CLIENTS[5]!;
const CAN_POST = REVOKED_FROM_ANON_ONLY[0]!;
const ACCEPTED = REVOKED_FROM_ANON_ONLY[2]!;

const FIXTURE = [
  "DO $r$ BEGIN CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $r$;",
  "CREATE TYPE public.event_state AS ENUM ('draft', 'live', 'ended');",
  "CREATE TABLE public.trips (id uuid PRIMARY KEY, owner_id uuid);",
  "CREATE TABLE public.trip_members (trip_id uuid, user_id uuid);",
  "CREATE TABLE public.posts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), trip_id uuid, body text);",
  "CREATE TABLE public.events (id uuid PRIMARY KEY, state public.event_state NOT NULL);",
  "CREATE TABLE public.trip_events (trip_id uuid, aggregate_version bigint, sequence bigint, type text, payload_json jsonb);",
  "CREATE TABLE public.trip_reservations (id uuid PRIMARY KEY);",
  "CREATE TABLE public.trip_reservation_events (reservation_id uuid, note text);",
  "CREATE TABLE public.canonical_events (id int, note text);",
  "CREATE TABLE public.stories (id int, state text, deleted_at timestamptz);",
  "CREATE TABLE public.schema_migration_ledger (filename text PRIMARY KEY);",
  // the nine SECURITY DEFINER functions, stubbed with their real signatures and the 0201/0204 pin
  "CREATE FUNCTION public.is_accepted_trip_member(t_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog AS $$ SELECT EXISTS (SELECT 1 FROM public.trips t WHERE t.id = t_id) $$;",
  // unqualified, as 0200 wrote it: the definer caller resolves and checks EXECUTE as its owner
  "CREATE FUNCTION public.can_post_to_trip(t_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog AS $$ SELECT t_id IS NULL OR is_accepted_trip_member(t_id) $$;",
  "CREATE FUNCTION public.user_is_event_participant(eid uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog AS $$ SELECT eid IS NOT NULL $$;",
  "CREATE FUNCTION public.event_is_in_state(eid uuid, states public.event_state[]) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog AS $$ SELECT EXISTS (SELECT 1 FROM public.events e WHERE e.id = eid AND e.state = ANY (states)) $$;",
  "CREATE FUNCTION public.add_owner_as_member() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$ BEGIN INSERT INTO public.trip_members (trip_id, user_id) VALUES (NEW.id, NEW.owner_id); RETURN NEW; END $$;",
  "CREATE FUNCTION public.enforce_trip_max_members() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$ BEGIN IF NEW.user_id IS NULL THEN RAISE EXCEPTION 'max members guard ran'; END IF; RETURN NEW; END $$;",
  "CREATE FUNCTION public.enforce_is_official_privileged() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$ BEGIN RETURN NEW; END $$;",
  "CREATE FUNCTION public.enforce_profile_role_privileged() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$ BEGIN RETURN NEW; END $$;",
  "CREATE FUNCTION public.handle_new_user() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$ BEGIN RETURN NEW; END $$;",
  "CREATE TRIGGER trips_add_owner AFTER INSERT ON public.trips FOR EACH ROW EXECUTE FUNCTION public.add_owner_as_member();",
  "CREATE TRIGGER trip_members_max BEFORE INSERT ON public.trip_members FOR EACH ROW EXECUTE FUNCTION public.enforce_trip_max_members();",
  // the ten pinned functions, from the migrations that define them, unpinned as the advisor found them
  createStatement("2120_canonical_events.sql", "CREATE OR REPLACE FUNCTION canonical_events_append_only()"),
  createStatement("3440_canonical_search_key_letter_fold.sql", "CREATE OR REPLACE FUNCTION public.input_normalize_city_key(p_name text)"),
  createStatement("2998_story_retention.sql", "CREATE OR REPLACE FUNCTION public.stories_freeze_deleted_at()"),
  createStatement("2776_trip_presence_freshness_and_ordering.sql", "CREATE OR REPLACE FUNCTION public.trip_presence_freshness("),
  createStatement("2784_trip_reservation_history.sql", "CREATE OR REPLACE FUNCTION public.trip_reservation_events_append_only()"),
  createStatement("2784_trip_reservation_history.sql", "CREATE OR REPLACE FUNCTION public.trip_reservation_events_no_direct_delete()"),
  createStatement("2773_trip_snapshot_fold_and_replay.sql", "CREATE OR REPLACE FUNCTION public.trip_snapshot_seed("),
  createStatement("2773_trip_snapshot_fold_and_replay.sql", "CREATE OR REPLACE FUNCTION public.trip_snapshot_fold("),
  createStatement("2773_trip_snapshot_fold_and_replay.sql", "CREATE OR REPLACE FUNCTION public.trip_snapshot_fold_all("),
  createStatement("2773_trip_snapshot_fold_and_replay.sql", "CREATE OR REPLACE FUNCTION public.trip_snapshot_replay("),
  migration("2787_trip_snapshot_fold_vocabulary.sql"),
  migration("2799_trip_snapshot_fold_recurrence_vocabulary.sql"),
  "CREATE TRIGGER canonical_events_append_only BEFORE UPDATE OR DELETE ON public.canonical_events FOR EACH ROW EXECUTE FUNCTION public.canonical_events_append_only();",
  "CREATE TRIGGER stories_freeze_deleted_at_trg BEFORE INSERT OR UPDATE ON public.stories FOR EACH ROW EXECUTE FUNCTION public.stories_freeze_deleted_at();",
  "CREATE TRIGGER trip_reservation_events_no_update BEFORE UPDATE ON public.trip_reservation_events FOR EACH ROW EXECUTE FUNCTION public.trip_reservation_events_append_only();",
  "CREATE TRIGGER trip_reservation_events_no_delete BEFORE DELETE ON public.trip_reservation_events FOR EACH ROW EXECUTE FUNCTION public.trip_reservation_events_no_direct_delete();",
  // RLS as production has it for the two anon-only functions' tables
  "ALTER TABLE public.posts ENABLE ROW LEVEL SECURITY;",
  "CREATE POLICY posts_read ON public.posts FOR SELECT USING (true);",
  `CREATE POLICY posts_insert ON public.posts FOR INSERT TO authenticated WITH CHECK (public.${fnName(CAN_POST)}(trip_id));`,
  "ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;",
  "CREATE POLICY events_public_read ON public.events FOR SELECT USING (state = 'live');",
  "CREATE POLICY events_participant_read ON public.events FOR SELECT TO authenticated USING (public.user_is_event_participant(id));",
  // Supabase's default grants (the baseline's GRANT ALL ... TO anon, authenticated, service_role)
  "GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;",
  "GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;",
  "GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO anon, authenticated, service_role;",
  `INSERT INTO public.trips (id, owner_id) VALUES ('${TRIP}', '${OWNER}');`,
  `INSERT INTO public.events (id, state) VALUES ('${EV_LIVE}', 'live'), ('${EV_DRAFT}', 'draft');`,
  `INSERT INTO public.trip_reservations (id) VALUES ('${RES}');`,
  `INSERT INTO public.trip_reservation_events (reservation_id, note) VALUES ('${RES}', 'booked');`,
  "INSERT INTO public.canonical_events (id, note) VALUES (1, 'seen');",
].join("\n");

const ALL_NINE = [...REVOKED_FROM_ALL_CLIENTS, ...REVOKED_FROM_ANON_ONLY];

test("3985 executes on PostgreSQL (PGlite)", async (t) => { // PGlite is a devDependency: this always executes (never a counted skip)
  const { PGlite } = await import(process.env.DISCOVERY_PGLITE_MODULE ?? "@electric-sql/pglite");
  const fresh = async (opts: { apply?: boolean } = {}) => {
    const db = new PGlite();
    await db.exec(FIXTURE);
    if (opts.apply !== false) await db.exec(sql);
    return db;
  };
  const val = async (db: any, q: string) => Object.values((await db.query(q)).rows[0] ?? {})[0];
  const can = async (db: any, role: string, sig: string) => (await val(db, `SELECT has_function_privilege('${role}', '${sig}', 'EXECUTE')`)) as boolean;
  const matrix = async (db: any) => {
    const out: Record<string, string> = {};
    for (const sig of ALL_NINE) {
      const roles: string[] = [];
      for (const r of ["anon", "authenticated", "service_role"]) if (await can(db, r, sig)) roles.push(r);
      const pub = await val(db, `SELECT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE p.oid = '${sig}'::regprocedure AND a.grantee = 0)`);
      out[sig] = [pub ? "PUBLIC" : null, ...roles].filter(Boolean).join(" ");
    }
    return out;
  };
  const settings = async (db: any) => {
    const out: Record<string, string | null> = {};
    for (const sig of PINNED) out[sig] = (await val(db, `SELECT array_to_string(proconfig, ',') FROM pg_proc WHERE oid = '${sig}'::regprocedure`)) as string | null;
    return out;
  };
  const asRole = async <T>(db: any, role: string, fn: () => Promise<T>): Promise<T> => {
    await db.exec(`SET ROLE ${role}`);
    try { return await fn(); } finally { await db.exec("RESET ROLE"); }
  };
  const BEFORE_MATRIX = Object.fromEntries(ALL_NINE.map((s) => [s, "PUBLIC anon authenticated service_role"]));
  const AFTER_MATRIX = Object.fromEntries([
    ...REVOKED_FROM_ALL_CLIENTS.map((s) => [s, "service_role"]),
    ...REVOKED_FROM_ANON_ONLY.map((s) => [s, "authenticated service_role"]),
  ]);

  await t.test("before 3985 the findings are real: anon can ask the oracle, and a caller's search_path redirects an unpinned body", async () => {
    const db = await fresh({ apply: false });
    assert.deepEqual(await matrix(db), BEFORE_MATRIX);
    assert.equal(await asRole(db, "anon", () => val(db, `SELECT public.${fnName(IS_IN_STATE)}('${EV_DRAFT}', ARRAY['draft']::public.event_state[])`)), true, "anon learns that a draft event exists");
    await db.exec("CREATE SCHEMA evil; CREATE FUNCTION evil.btrim(text) RETURNS text LANGUAGE sql AS $$ SELECT 'redirected' $$; GRANT USAGE ON SCHEMA evil TO PUBLIC;");
    await db.exec("SET search_path = evil, pg_catalog, public");
    assert.equal(await val(db, "SELECT public.input_normalize_city_key('Cebu City')"), "redirected");
    await db.exec("RESET search_path");
    await db.close();
  });

  const db = await fresh();

  await t.test("the apply leaves exactly the pinned privileges and settings", async () => {
    assert.deepEqual(await matrix(db), AFTER_MATRIX);
    assert.deepEqual(await settings(db), Object.fromEntries(PINNED.map((s) => [s, 'search_path=""'])));
  });

  await t.test("anon: its reads still work, its policy-less insert is refused by RLS (not by a function permission), and the RPCs are gone", async () => {
    await asRole(db, "anon", async () => {
      assert.equal(await val(db, "SELECT count(*)::int FROM public.events"), 1, "events_public_read still answers anon");
      assert.equal(await val(db, "SELECT count(*)::int FROM public.posts"), 0);
      await assert.rejects(db.query(`INSERT INTO public.posts (trip_id, body) VALUES ('${TRIP}', 'x')`), /new row violates row-level security policy/);
      for (const call of [`public.${fnName(CAN_POST)}('${TRIP}')`, `public.${fnName(ACCEPTED)}('${TRIP}')`, `public.user_is_event_participant('${EV_LIVE}')`, `public.${fnName(IS_IN_STATE)}('${EV_DRAFT}', ARRAY['draft']::public.event_state[])`]) {
        await assert.rejects(db.query(`SELECT ${call}`), /permission denied for function/, call);
      }
    });
  });

  await t.test("authenticated: the policies that call the anon-only functions still pass, through a SECURITY DEFINER chain; the oracle is gone", async () => {
    await asRole(db, "authenticated", async () => {
      await db.query(`INSERT INTO public.posts (trip_id, body) VALUES ('${TRIP}', 'hello')`);
      assert.equal(await val(db, "SELECT count(*)::int FROM public.events"), 2, "events_participant_read evaluates user_is_event_participant for authenticated");
      assert.equal(await val(db, `SELECT public.${fnName(CAN_POST)}('${TRIP}')`), true, "can_post_to_trip calls is_accepted_trip_member as its owner");
      await assert.rejects(db.query(`SELECT public.${fnName(IS_IN_STATE)}('${EV_LIVE}', ARRAY['live']::public.event_state[])`), /permission denied for function/);
    });
  });

  await t.test("the withdrawn trigger functions still fire for a client role (EXECUTE is checked at CREATE TRIGGER, not at firing)", async () => {
    const trip2 = "a5555555-5555-4555-8555-555555555509";
    await asRole(db, "authenticated", () => db.query(`INSERT INTO public.trips (id, owner_id) VALUES ('${trip2}', '${OWNER}')`));
    assert.equal(await val(db, `SELECT count(*)::int FROM public.trip_members WHERE trip_id = '${trip2}'`), 1, "add_owner_as_member and enforce_trip_max_members ran");
  });

  await t.test("the pinned trigger functions resolve and behave under the pin", async () => {
    await assert.rejects(db.query("UPDATE public.canonical_events SET note = 'changed'"), /canonical_events is an append-only ingestion spine: UPDATE is not permitted/);
    await db.query("INSERT INTO public.stories (id, state) VALUES (1, 'deleted'), (2, 'live')");
    assert.equal(await val(db, "SELECT count(*)::int FROM public.stories WHERE (id = 1 AND deleted_at IS NOT NULL) OR (id = 2 AND deleted_at IS NULL)"), 2);
    await assert.rejects(db.query("UPDATE public.trip_reservation_events SET note = 'x'"), /trip_reservation_events is append-only/);
    await assert.rejects(db.query(`DELETE FROM public.trip_reservation_events WHERE reservation_id = '${RES}'`), /DELETE refused while the reservation exists/);
  });

  await t.test("a pinned body ignores the caller's search_path", async () => {
    await db.exec("CREATE SCHEMA evil; CREATE FUNCTION evil.btrim(text) RETURNS text LANGUAGE sql AS $$ SELECT 'redirected' $$; GRANT USAGE ON SCHEMA evil TO PUBLIC;");
    await db.exec("SET search_path = evil, pg_catalog, public");
    assert.equal(await val(db, "SELECT public.input_normalize_city_key('Cebu City')"), "cebu");
    await db.exec("RESET search_path; DROP SCHEMA evil CASCADE;");
  });

  await t.test("re-applying is a no-op", async () => {
    const before = JSON.stringify([await matrix(db), await settings(db)]);
    await db.exec(sql);
    assert.equal(JSON.stringify([await matrix(db), await settings(db)]), before);
  });

  await t.test("the postcondition re-runs alone in a new session, and is load-bearing", async () => {
    const post = postconditionBlocks(sql)[0]!.text;
    await db.exec("DISCARD ALL");
    await db.exec(post);
    const breaks: Array<[string, string, RegExp]> = [
      [`GRANT EXECUTE ON FUNCTION ${IS_IN_STATE} TO anon`, `REVOKE ALL ON FUNCTION ${IS_IN_STATE} FROM anon`, /anon can execute public\.event_is_in_state/],
      [`GRANT EXECUTE ON FUNCTION ${REVOKED_FROM_ALL_CLIENTS[4]} TO PUBLIC`, `REVOKE ALL ON FUNCTION ${REVOKED_FROM_ALL_CLIENTS[4]} FROM PUBLIC`, /PUBLIC holds EXECUTE on public\.handle_new_user/],
      [`GRANT EXECUTE ON FUNCTION ${REVOKED_FROM_ALL_CLIENTS[0]} TO authenticated`, `REVOKE ALL ON FUNCTION ${REVOKED_FROM_ALL_CLIENTS[0]} FROM authenticated`, /authenticated can execute public\.add_owner_as_member/],
      [`REVOKE ALL ON FUNCTION ${CAN_POST} FROM authenticated`, `GRANT EXECUTE ON FUNCTION ${CAN_POST} TO authenticated`, /authenticated cannot execute public\.can_post_to_trip/],
      [`REVOKE ALL ON FUNCTION ${ACCEPTED} FROM service_role`, `GRANT EXECUTE ON FUNCTION ${ACCEPTED} TO service_role`, /service_role cannot execute public\.is_accepted_trip_member/],
      [`ALTER FUNCTION ${PINNED[9]} RESET search_path`, `ALTER FUNCTION ${PINNED[9]} SET search_path = ''`, /public\.trip_snapshot_seed\(uuid\) does not pin search_path/],
      [`ALTER FUNCTION ${PINNED[1]} SET search_path = public`, `ALTER FUNCTION ${PINNED[1]} SET search_path = ''`, /public\.input_normalize_city_key\(text\) does not pin search_path/],
    ];
    for (const [breakIt, restore, msg] of breaks) {
      await db.exec(breakIt);
      await assert.rejects(db.exec(post), msg, breakIt);
      await db.exec(restore);
      await db.exec(post);
    }
    const body = String(await val(db, `SELECT pg_get_functiondef('${PINNED[3]}'::regprocedure)`));
    await db.exec(body.replace("THEN 'recent'", "THEN 'fresh'"));
    await assert.rejects(db.exec(post), /trip_presence_freshness no longer grades as 2776 defined/);
    await db.exec(body);
    await db.exec(post);
  });
  await db.close();

  await t.test("the precondition refuses each unsafe starting state, changes nothing, and does not refuse a same-named function in another schema", async () => {
    const refusals: Array<[string, string, RegExp]> = [
      ["a policy TO public calls an anon-only function", `CREATE POLICY posts_insert_any ON public.posts FOR INSERT WITH CHECK (public.${fnName(CAN_POST)}(trip_id));`, /can_post_to_trip\(uuid\) is reached by a role this file withdraws it from: policy posts_insert_any on table posts/],
      ["a policy TO anon calls an anon-only function", "CREATE POLICY events_anon ON public.events FOR SELECT TO anon USING (public.user_is_event_participant(id));", /user_is_event_participant\(uuid\) is reached .*policy events_anon on table events/],
      ["a policy TO authenticated calls the fully withdrawn oracle", `CREATE POLICY events_state ON public.events FOR SELECT TO authenticated USING (public.${fnName(IS_IN_STATE)}(id, ARRAY['live']::public.event_state[]));`, /event_is_in_state\(uuid, public\.event_state\[\]\) is reached .*policy events_state on table events/],
      ["a view calls an anon-only function", "CREATE VIEW public.participation AS SELECT e.id, public.user_is_event_participant(e.id) AS p FROM public.events e;", /user_is_event_participant\(uuid\) is reached .*view participation/],
      ["an anon-executable INVOKER function calls one unqualified", `CREATE FUNCTION public.member_of(t uuid) RETURNS boolean LANGUAGE plpgsql AS $$ BEGIN RETURN ${fnName(ACCEPTED)}(t); END $$;`, /is_accepted_trip_member\(uuid\) is called by SECURITY INVOKER function\(s\) a losing role can run: member_of\(uuid\)/],
      ["an INVOKER trigger function calls one", `CREATE FUNCTION public.guard_posts() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NOT public.${fnName(CAN_POST)}(NEW.trip_id) THEN RAISE EXCEPTION 'no'; END IF; RETURN NEW; END $$; REVOKE ALL ON FUNCTION public.guard_posts() FROM PUBLIC, anon, authenticated;`, /can_post_to_trip\(uuid\) is called by SECURITY INVOKER function\(s\) a losing role can run: guard_posts\(\)/],
      ["a withdrawn function is not SECURITY DEFINER", `ALTER FUNCTION ${CAN_POST} SECURITY INVOKER;`, /can_post_to_trip\(uuid\) is not SECURITY DEFINER/],
      ["a pinned function already pins another search_path", `ALTER FUNCTION ${PINNED[6]} SET search_path = public;`, /trip_snapshot_fold\(jsonb, jsonb\) already pins a different search_path/],
      ["a function is missing", `DROP FUNCTION ${REVOKED_FROM_ALL_CLIENTS[4]};`, /public\.handle_new_user\(\) does not exist/],
    ];
    for (const [label, setup, msg] of refusals) {
      const d = await fresh({ apply: false });
      await d.exec(setup);
      const before = JSON.stringify([await matrix(d).catch(() => null), await settings(d)]);
      await assert.rejects(d.exec(sql), msg, label);
      await d.exec("ROLLBACK").catch(() => undefined); // the file's BEGIN is left open on this single session; psql would discard it at exit
      assert.equal(JSON.stringify([await matrix(d).catch(() => null), await settings(d)]), before, `${label}: nothing changed`);
      await d.close();
    }
    const other = await fresh({ apply: false });
    await other.exec([
      "CREATE SCHEMA authz;",
      "CREATE FUNCTION authz.is_accepted_trip_member(t uuid, u uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT true $$;",
      "CREATE FUNCTION public.crew_check(t uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT authz.is_accepted_trip_member(t, t) $$;",
      "CREATE POLICY posts_crew ON public.posts FOR SELECT USING (authz.is_accepted_trip_member(trip_id, trip_id));",
    ].join("\n"));
    await other.exec(sql);
    assert.deepEqual(await matrix(other), AFTER_MATRIX);
    await other.close();
  });

  await t.test("the rollback restores the pre-state and deletes the ledger row, and the file re-applies after it", async () => {
    const d = await fresh();
    await d.exec(`INSERT INTO public.schema_migration_ledger (filename) VALUES ('${FILE}');`);
    await d.exec(readFileSync(rollbackUrl, "utf8"));
    assert.deepEqual(await matrix(d), BEFORE_MATRIX);
    assert.deepEqual(await settings(d), Object.fromEntries(PINNED.map((s) => [s, null])));
    assert.equal(await val(d, "SELECT count(*)::int FROM public.schema_migration_ledger"), 0);
    await d.exec(sql);
    assert.deepEqual(await matrix(d), AFTER_MATRIX);
    await d.close();
  });
});
