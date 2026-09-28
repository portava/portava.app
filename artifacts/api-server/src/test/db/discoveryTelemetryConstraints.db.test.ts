/**
 * discoveryTelemetryConstraints.db.test.ts — census-discovery DV-45 (`04` §10.5
 * "test all CHECK/enum constraints"), against a REAL PostgreSQL.
 *
 * WHY THIS IS NOT A UNIT TEST. DV-45's standing finding was that every existing
 * vocabulary test ran against `SUPABASE_URL=127.0.0.1:9` — an unreachable
 * database — so no test had ever watched a CHECK REFUSE a row: a green run did
 * not prove a constraint. Here every CHECK on the two Discovery telemetry
 * tables (`rank_events`, and 3376's `recommendations`) is exercised both ways
 * on the harness's replayed chain — one row it must ADMIT and one it must
 * REFUSE — and the refusal must name the constraint expected, so a row refused
 * by the wrong rule cannot pass for the right one.
 *
 * COMPLETENESS IS ASSERTED, NOT HOPED. The first case reads every CHECK on both
 * tables out of pg_constraint and requires this file to exercise each by name.
 * A CHECK added later with no case here turns this suite red.
 *
 * THE SURFACE CHECK DIFFERS BY DATABASE, and the suite says so rather than
 * pinning one shape. The harness replays 2893, so its vocabulary is the eight
 * writer-backed surfaces; production has NOT applied 2893 (owner-deferred) and
 * admits fifteen. What must hold on both is asserted: every surface a writer in
 * this tree persists is admitted, an invented one is refused.
 */
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { HAVE_DB, psql, exec, rows, scalar, seedUser, deleteUser } from "./localDb.js";
import { PERSISTED_RANK_SURFACES } from "../../services/ranking/DiscoveryRankingService.js";
import { RANK_ITEM_KINDS } from "../../lib/discoveryServeLog.js";

const RID = "AAAAAAAAAAAAAAAAAAAA0";   // 21 chars + one per case → 22
let user = "";

/** Run one INSERT in a transaction that is always rolled back. */
function attempt(sql: string): { ok: boolean; constraint: string | null; sqlstate: string; stderr: string } {
  const r = psql(`\\set VERBOSITY verbose\nBEGIN;\n${sql};\nROLLBACK;\n`);
  if (r.status === 0) return { ok: true, constraint: null, sqlstate: "", stderr: "" };
  const constraint = /constraint "([^"]+)"/.exec(r.stderr)?.[1] ?? null;
  const sqlstate = /ERROR:\s+([0-9A-Z]{5}):/.exec(r.stderr)?.[1] ?? "";
  return { ok: false, constraint, sqlstate, stderr: r.stderr };
}

const covered = new Set<string>();
function admits(sql: string, why: string) {
  const r = attempt(sql);
  assert.equal(r.ok, true, `${why}\n${r.stderr}`);
}
function refuses(sql: string, constraint: string, sqlstate: string, why: string) {
  const r = attempt(sql);
  assert.equal(r.ok, false, `${why}: the row was ADMITTED`);
  assert.equal(r.sqlstate, sqlstate, `${why}: refused with ${r.sqlstate}, expected ${sqlstate}\n${r.stderr}`);
  if (constraint) {
    assert.equal(r.constraint, constraint, `${why}: refused by ${r.constraint}, not by ${constraint}`);
    covered.add(constraint);
  }
}

/** A rank_events row with every constrained column set to a known-good value, then overridden. */
function re(over: Record<string, string> = {}): string {
  const cols: Record<string, string> = {
    user_id: `'${user}'`, item_id: `'dv45-item'`, item_kind: `'place'`, position: `0`, features: `'{}'::jsonb`,
    outcome: `'impression'`, served_at: `now()`, surface: `'discovery'`, session_id: `gen_random_uuid()`,
    schema_version: `1`, privacy_class: `'raw_behavioral_event'`, retention_tier: `'raw_recent'`, ...over,
  };
  return `INSERT INTO public.rank_events (${Object.keys(cols).join(", ")}) VALUES (${Object.values(cols).join(", ")})`;
}

/** A recommendations row, known-good, then overridden. */
function rq(over: Record<string, string> = {}): string {
  const cols: Record<string, string> = {
    id: `'${RID}q'`, user_id: `NULL`, viewer_class: `'anonymous'`, session_id: `gen_random_uuid()`, surface: `'discovery'`,
    serve_point: `1`, route: `'GET /discovery'`, model_version: `'m'`, context_hash: `NULL`, served_count: `1`,
    item_ids: `ARRAY['node/1']`, item_kinds: `ARRAY['place']`, served_at: `now()`, schema_version: `1`,
    privacy_class: `'raw_behavioral_event'`, retention_tier: `'raw_recent'`, ...over,
  };
  return `INSERT INTO public.recommendations (${Object.keys(cols).join(", ")}) VALUES (${Object.values(cols).join(", ")})`;
}

describe("DV-45 — every CHECK on the Discovery telemetry tables, admitted AND refused, on a real database", { skip: !HAVE_DB }, () => {
  before(() => { user = seedUser("dv45"); });
  after(() => {
    exec(`DELETE FROM public.rank_events WHERE user_id = '${user}';`);
    deleteUser(user);
  });

  test("precondition: 2890, 2891, 3375 and 3376 are applied here", () => {
    assert.equal(scalar(`SELECT count(*) FROM pg_constraint WHERE conname = 'rank_events_schema_version_check'`), "1");
    assert.equal(scalar(`SELECT to_regclass('public.recommendations') IS NOT NULL`), "t");
    assert.equal(scalar(`SELECT count(*) FROM pg_indexes WHERE indexname = 'rank_events_recommendation_idempotency_idx'`), "1");
  });

  test("rank_events: the good row is admitted (the baseline every refusal below departs from by ONE column)", () => {
    admits(re(), "a fully valid Discovery exposure row");
  });

  test("rank_events_item_kind_check — the six kinds and NULL; nothing else", () => {
    for (const k of RANK_ITEM_KINDS) admits(re({ item_kind: `'${k}'` }), `item_kind ${k}`);
    admits(re({ item_kind: "NULL" }), "NULL: served, kind not applicable (0197)");
    refuses(re({ item_kind: `'trail'` }), "rank_events_item_kind_check", "23514", "an unmapped kind");
  });

  test("rank_events_outcome_check — the nine outcomes 0153+0197+2297+2894 admit; nothing else", () => {
    for (const o of ["impression", "tap", "save", "join", "rsvp", "attended", "analytics", "dismiss", "trip_add"]) {
      admits(re({ outcome: `'${o}'` }), `outcome ${o}`);
    }
    refuses(re({ outcome: `'not_interested'` }), "rank_events_outcome_check", "23514", "an outcome no migration admits");
  });

  test("rank_events_surface_check — every surface a writer persists is admitted; an invented one is refused", () => {
    const def = scalar(`SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'rank_events_surface_check'`)!;
    for (const s of PERSISTED_RANK_SURFACES) admits(re({ surface: `'${s}'` }), `surface ${s} has a writer and must be admitted`);
    refuses(re({ surface: `'not_a_surface'` }), "rank_events_surface_check", "23514", "an invented surface");
    // The seven 2893 retires: refused where 2893 is applied (this harness),
    // admitted where it is not (production). Whichever this is, it is stated.
    const retired = ["search", "nearby", "story", "event", "trip", "profile", "explore"];
    const applied = !def.includes("'explore'");
    for (const s of retired) {
      if (applied) refuses(re({ surface: `'${s}'` }), "rank_events_surface_check", "23514", `${s} is retired by 2893 here`);
      else admits(re({ surface: `'${s}'` }), `${s} is still admitted where 2893 is not applied`);
    }
  });

  test("rank_events_privacy_class_check and rank_events_retention_tier_check (2890)", () => {
    for (const c of ["raw_behavioral_event", "derived_behavioral_feature", "audit_security_event"]) admits(re({ privacy_class: `'${c}'` }), c);
    refuses(re({ privacy_class: `'public'` }), "rank_events_privacy_class_check", "23514", "an unclassified privacy class");
    for (const t of ["raw_recent", "durable_aggregate", "audit_security", "anonymized_longterm"]) admits(re({ retention_tier: `'${t}'` }), t);
    refuses(re({ retention_tier: `'forever'` }), "rank_events_retention_tier_check", "23514", "an invented retention tier");
    refuses(re({ privacy_class: "NULL" }), null as any, "23502", "privacy_class is NOT NULL");
  });

  test("rank_events_dwell_ms_check, _dwell_kind_check, _dwell_pairing_check (2890, `04` §7)", () => {
    admits(re({ dwell_ms: "0" }), "a measured zero is a measurement");
    admits(re({ dwell_ms: "1500", dwell_kind: `'active'` }), "active dwell");
    admits(re({ dwell_ms: "1500" }), "timed but not classified is permitted");
    refuses(re({ dwell_ms: "-1" }), "rank_events_dwell_ms_check", "23514", "negative dwell");
    refuses(re({ dwell_ms: "10", dwell_kind: `'bored'` }), "rank_events_dwell_kind_check", "23514", "an invented dwell kind");
    refuses(re({ dwell_kind: `'idle'` }), "rank_events_dwell_pairing_check", "23514", "a kind with no duration is a label over nothing");
  });

  test("rank_events_recommendation_id_shape_check (2891) and the (recommendation_id, outcome) arbiter", () => {
    admits(re({ recommendation_id: `'${RID}a'` }), "a 22-char base64url token");
    admits(re({ recommendation_id: "NULL" }), "NULL: the historical state");
    refuses(re({ recommendation_id: `'short'` }), "rank_events_recommendation_id_shape_check", "23514", "a malformed token");
    refuses(re({ recommendation_id: `'${RID}+'` }), "rank_events_recommendation_id_shape_check", "23514", "a non-base64url character");
    const twice = `${re({ recommendation_id: `'${RID}b'` })};\n${re({ recommendation_id: `'${RID}b'` })}`;
    refuses(twice, "rank_events_recommendation_idempotency_idx", "23505", "one exposure, one outcome, one row");
    admits(`${re({ recommendation_id: `'${RID}c'` })};\n${re({ recommendation_id: `'${RID}c'`, outcome: `'analytics'` })}`,
      "an exposure and its analytics row share a token without colliding (the index is keyed on the outcome too)");
    admits(`${re({ recommendation_id: "NULL" })};\n${re({ recommendation_id: "NULL" })}`, "NULLs are distinct: history never collides");
  });

  test("rank_events_schema_version_check (3375) — an unknown record version is refused at the door", () => {
    admits(re({ schema_version: "1" }), "version 1");
    refuses(re({ schema_version: "2" }), "rank_events_schema_version_check", "23514", "a version no reader exists for");
    refuses(re({ schema_version: "0" }), "rank_events_schema_version_check", "23514", "version 0");
  });

  test("rank_events NOT NULL and the user FK: an exposure is always somebody's", () => {
    refuses(re({ user_id: "NULL" }), null as any, "23502", "user_id is NOT NULL — why an anonymous serve writes no rank_events row");
    refuses(re({ user_id: "gen_random_uuid()" }), "rank_events_user_id_fkey", "23503", "an exposure for a user that does not exist");
    refuses(re({ surface: "NULL" }), null as any, "23502", "surface is NOT NULL");
  });

  test("recommendations: the good anonymous row, and a good signed-in row, are admitted", () => {
    admits(rq(), "an anonymous request");
    admits(rq({ user_id: `'${user}'`, viewer_class: `'signed_in'`, id: `'${RID}r'` }), "a signed-in request");
    admits(rq({ served_count: "0", item_ids: "'{}'", item_kinds: "'{}'", id: `'${RID}s'` }), "an EMPTY serve is a real request, served_count 0");
  });

  test("recommendations: every one of its fourteen CHECKs refuses the row it exists to refuse", () => {
    refuses(rq({ id: `'short'` }), "recommendations_id_shape_check", "23514", "a malformed request id");
    refuses(rq({ viewer_class: `'robot'` }), "recommendations_viewer_class_check", "23514", "an invented viewer class");
    refuses(rq({ user_id: `'${user}'` }), "recommendations_viewer_matches_user_check", "23514", "an ANONYMOUS row carrying a user");
    refuses(rq({ viewer_class: `'signed_in'` }), "recommendations_viewer_matches_user_check", "23514", "a signed-in row with no user");
    refuses(rq({ surface: `'pulse'` }), "recommendations_surface_check", "23514", "not a Discovery serve");
    refuses(rq({ serve_point: "14" }), "recommendations_serve_point_check", "23514", "no such serve point"); admits(rq({ serve_point: "13", id: `'${RID}t'` }), "serve point 13, the output kinds (3491, census-discovery §94)");
    refuses(rq({ route: `''` }), "recommendations_route_check", "23514", "an empty route");
    refuses(rq({ model_version: `''` }), "recommendations_model_version_check", "23514", "an empty model version");
    refuses(rq({ context_hash: `'x'` }), "recommendations_context_hash_check", "23514", "a malformed context hash");
    // A negative count can never be refused by served_count_check ALONE: no
    // array has cardinality -1, so items_match fails with it (found by running
    // this case, not by reading the DDL). The bound is isolated at the top end.
    refuses(rq({ served_count: "-1" }), null as any, "23514", "a negative denominator");
    refuses(rq({ served_count: "1001", item_ids: "array_fill('node/1'::text, ARRAY[1001])", item_kinds: "array_fill('place'::text, ARRAY[1001])" }),
      "recommendations_served_count_check", "23514", "an unbounded page");
    refuses(rq({ served_count: "2" }), "recommendations_items_match_count_check", "23514", "a denominator that disagrees with its items");
    refuses(rq({ item_kinds: `ARRAY['trail']` }), "recommendations_item_kinds_check", "23514", "an item kind rank_events would refuse");
    refuses(rq({ item_kinds: `ARRAY[NULL::text]` }), "recommendations_item_kinds_check", "23514", "a NULL kind element (<@ never matches NULL)");
    refuses(rq({ schema_version: "2" }), "recommendations_schema_version_check", "23514", "an unknown version");
    refuses(rq({ privacy_class: `'audit_security_event'` }), "recommendations_privacy_class_check", "23514", "a class this table does not hold");
    refuses(rq({ retention_tier: `'forever'` }), "recommendations_retention_tier_check", "23514", "an invented retention tier");
    refuses(rq({ user_id: "gen_random_uuid()", viewer_class: `'signed_in'` }), "recommendations_user_id_fkey", "23503", "a request for a user that does not exist");
    refuses(`${rq()};\n${rq()}`, "recommendations_pkey", "23505", "one request, one row");
  });

  test("recommendations: no client role can read or write it, and the door is service_role's alone", () => {
    for (const role of ["anon", "authenticated"]) {
      for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        assert.equal(scalar(`SELECT has_table_privilege('${role}', 'public.recommendations', '${p}')`), "f", `${role} ${p}`);
      }
      assert.equal(scalar(`SELECT has_function_privilege('${role}', 'public.record_discovery_serve_request(jsonb)', 'EXECUTE')`), "f");
    }
    assert.equal(scalar(`SELECT has_table_privilege('service_role', 'public.recommendations', 'UPDATE')`), "f", "append-only");
  });

  test("COMPLETENESS — every CHECK on both tables was exercised by name above", () => {
    const all = rows<{ conname: string }>(`
      SELECT c.conname FROM pg_constraint c
       WHERE c.conrelid IN ('public.rank_events'::regclass, 'public.recommendations'::regclass)
         AND c.contype = 'c' ORDER BY 1`).map((r) => r.conname);
    const missing = all.filter((c) => !covered.has(c));
    assert.deepEqual(missing, [], "a CHECK with no refusal case here is a constraint nobody has watched refuse anything");
    assert.ok(all.length >= 24, `precondition: 10 on rank_events + 14 on recommendations, found ${all.length}`);
  });
});
