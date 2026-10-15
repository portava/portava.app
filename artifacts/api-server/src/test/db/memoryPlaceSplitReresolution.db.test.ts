/**
 * memoryPlaceSplitReresolution.db.test.ts — the EXECUTING witness for 3812 (the
 * admin place split and the Memory re-resolution proposals) on the full chain
 * scripts/local-db/up.sh replays (production's 2026-08-19 baseline structure plus
 * every migration). Census-highlights-memories H72; B58 cluster MEM-PLACE-SPLIT.
 *
 * The route suite (src/test/memoryPlaceSplitReresolution.test.ts) ports
 * place_split, the guard and the CHECKs to TypeScript to drive the API; this file
 * proves the SQL itself does what the port assumes, as the API's service role
 * calls it, with every other memories trigger the chain installs in place.
 *
 * EVERY CASE RUNS IN ONE TRANSACTION THAT IS ROLLED BACK: the flags it turns on,
 * the rows it seeds and the rollback it rehearses never outlive the case, so no
 * other suite on the shared harness database can see them.
 *
 *   D1  flags off ⇒ place_split answers disabled and writes nothing; on ⇒ it keeps
 *       P, creates P2, moves exactly the named reference and logs 'split'
 *   D2  a proposal is born pending for the owner's live Memory at the split place;
 *       the guard refuses another owner, a deleted Memory, another place; the
 *       CHECKs refuse a stored coordinate and a suggestion the rule did not make;
 *       a re-run (ON CONFLICT DO NOTHING) writes nothing
 *   D3  accepted only once the Memory stores the place (the owner's PATCH); final
 *   D4  the soft delete purges, as the service role that holds no DELETE; archive does not
 *   D5  RLS on, no client privilege, no client EXECUTE; the flag is seeded FALSE
 *   D6  the account's erasure leaves no proposal
 *   D7  the rollback refuses (flag ON; proposals), then restores (merge, unmerge)
 *       with no split row; 3812 re-applies and its postcondition holds
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HAVE_DB, psql, scalar } from "./localDb.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const MIGRATION = resolve(__dir, "../../migrations/3812_place_split_memory_reresolution.sql");
const ROLLBACK = resolve(__dir, "../../../../../db/rollback/2026-10-14-3812-place-split-memory-reresolution-rollback.sql");

/** The file between its BEGIN and COMMIT, plus what follows COMMIT (its $post$), so it can run inside a case's transaction. */
function unwrapped(path: string): string {
  const sql = readFileSync(path, "utf8");
  const begin = sql.search(/^BEGIN;\s*$/m);
  const commit = sql.lastIndexOf("\nCOMMIT;");
  assert.ok(begin >= 0 && commit > begin, `${path}: no BEGIN … COMMIT wrapper`);
  return sql.slice(sql.indexOf("\n", begin) + 1, commit) + "\n" + sql.slice(commit + "\nCOMMIT;".length);
}

/** One case: BEGIN, seed, body, ROLLBACK. Returns psql's result; the body raises to fail. */
function inRolledBackCase(body: string) {
  const T = randomUUID().slice(0, 8);
  const ids = {
    A: randomUUID(), B: randomUUID(), ADMIN: randomUUID(), P: randomUUID(), ELSE: randomUUID(), REF_A: randomUUID(), REF_B: randomUUID(),
    M1: randomUUID(), M2: randomUUID(), MDEL: randomUUID(), MB: randomUUID(), MELSE: randomUUID(),
  };
  const users = [ids.A, ids.B, ids.ADMIN].map((u, i) => `INSERT INTO auth.users (id, email) VALUES ('${u}', 'h72${i}${T}@local.test'); INSERT INTO public.profiles (id, handle, name) VALUES ('${u}', 'h72${i}_${T}', 'h72 ${i}');`).join("\n");
  const mem = (id: string, owner: string, place: string, state: string, lng: number) =>
    `INSERT INTO public.memories (id, owner_id, title, visibility, state, place_id, location_lat, location_lng) VALUES ('${id}', '${owner}', 'h72 ${T}', 'only_me', '${state}', '${place}', 10, ${lng});`;
  const seed = `
${users}
INSERT INTO public.places (id, name, normalized_name, primary_category, latitude, longitude, address, city, country_code) VALUES
  ('${ids.P}', 'Cafe A ${T}', 'cafe a ${T}', 'cafe', 10, 106, '1 Street', 'Da Nang', 'VN'),
  ('${ids.ELSE}', 'Elsewhere ${T}', 'elsewhere ${T}', 'cafe', 10.05, 106, NULL, 'Da Nang', 'VN');
INSERT INTO public.external_place_references (id, place_id, provider, provider_place_id) VALUES
  ('${ids.REF_A}', '${ids.P}', 'h72test', 'a-${T}'), ('${ids.REF_B}', '${ids.P}', 'h72test', 'b-${T}');
SET LOCAL ROLE service_role;
${mem(ids.M1, ids.A, ids.P, "published", 106)}
${mem(ids.M2, ids.A, ids.P, "published", 106.000912)}
${mem(ids.MDEL, ids.A, ids.P, "deleted", 106)}
${mem(ids.MB, ids.B, ids.P, "published", 106)}
${mem(ids.MELSE, ids.A, ids.ELSE, "published", 106)}
RESET ROLE;
CREATE TEMP TABLE h72 (k text PRIMARY KEY, v text) ON COMMIT DROP;
GRANT SELECT, INSERT ON h72 TO service_role;
INSERT INTO h72 VALUES ${Object.entries(ids).map(([k, v]) => `('${k}', '${v}')`).join(", ")};
CREATE FUNCTION pg_temp.id(k text) RETURNS uuid LANGUAGE sql AS $f$ SELECT v::uuid FROM h72 WHERE h72.k = $1 $f$;
CREATE FUNCTION pg_temp.ev(reason text, a uuid, b uuid) RETURNS jsonb LANGUAGE sql AS $f$
  SELECT jsonb_build_object('rule', 'h72-v1', 'bound_m', 75, 'reason', reason, 'candidates',
    jsonb_build_array(jsonb_build_object('place_id', a, 'within_bound', true, 'name_match', true),
                      jsonb_build_object('place_id', b, 'within_bound', false, 'name_match', false)))
$f$;
CREATE FUNCTION pg_temp.refused(label text, sql text, pattern text) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  BEGIN EXECUTE sql; EXCEPTION WHEN OTHERS THEN
    IF SQLERRM !~ pattern THEN RAISE EXCEPTION '% FAILED: refused for the wrong reason: %', label, SQLERRM; END IF;
    RETURN;
  END;
  RAISE EXCEPTION '% FAILED: was not refused', label;
END $f$;
`;
  const flagsOn = `UPDATE public.feature_flags SET enabled = true WHERE flag IN ('memory_place_split_reresolution_enabled', 'external_places_enabled');
INSERT INTO public.feature_flags (flag, enabled) VALUES ('external_places_enabled', true) ON CONFLICT (flag) DO UPDATE SET enabled = true;`;
  const split = `SET LOCAL ROLE service_role;
INSERT INTO h72 SELECT 'split', public.place_split(pg_temp.id('P'), '{"name":"Bar B","normalized_name":"bar b","latitude":10,"longitude":106.000912}', ARRAY[pg_temp.id('REF_B')], pg_temp.id('ADMIN'))::text;
RESET ROLE;
INSERT INTO h72 SELECT 'P2', (v::jsonb)->>'new_place_id' FROM h72 WHERE k = 'split';
INSERT INTO h72 SELECT 'SPLIT', (v::jsonb)->>'split_id' FROM h72 WHERE k = 'split';`;
  const script = `BEGIN;\n${seed}\n${body.replaceAll("{{FLAGS_ON}}", flagsOn).replaceAll("{{SPLIT}}", split)}\nSELECT 'CASE-OK';\nROLLBACK;\n`;
  return psql(script);
}

function ok(r: { status: number; stdout: string; stderr: string }, label: string): void {
  assert.equal(r.status, 0, `${label}: psql exited ${r.status}\n${r.stderr}`);
  assert.match(r.stdout, /CASE-OK/, `${label}: the case did not reach its end`);
}

const MERGE_ID = randomUUID();
const proposal = (memoryKey: string, ownerKey: string, suggested: string, reason: string) => `
INSERT INTO public.memory_place_reresolution_proposals (memory_id, owner_id, split_id, split_from_place_id, candidate_place_ids, suggested_place_id, evidence)
VALUES (pg_temp.id('${memoryKey}'), pg_temp.id('${ownerKey}'), pg_temp.id('SPLIT'), pg_temp.id('P'), ARRAY[pg_temp.id('P'), pg_temp.id('P2')], ${suggested},
        pg_temp.ev('${reason}', pg_temp.id('P'), pg_temp.id('P2')))`;

describe("3812 on the full chain: the place split and the re-resolution proposals", { skip: !HAVE_DB }, () => {
  test("D1 flags off ⇒ disabled, nothing written; on ⇒ P kept, P2 created, exactly the named reference moved, split logged", () => {
    ok(inRolledBackCase(`
UPDATE public.feature_flags SET enabled = false WHERE flag IN ('memory_place_split_reresolution_enabled', 'external_places_enabled');
SET LOCAL ROLE service_role;
DO $d$ BEGIN
  IF public.place_split(pg_temp.id('P'), '{"name":"Bar B","latitude":10,"longitude":106}', '{}', NULL)->>'outcome' <> 'disabled' THEN RAISE EXCEPTION 'D1 FAILED: split ran with the flags off'; END IF;
END $d$;
RESET ROLE;
DO $d$ BEGIN
  IF EXISTS (SELECT 1 FROM public.place_merge_log WHERE survivor_place_id = pg_temp.id('P')) THEN RAISE EXCEPTION 'D1 FAILED: a refused split logged'; END IF;
END $d$;
{{FLAGS_ON}}
{{SPLIT}}
DO $d$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.places WHERE id = pg_temp.id('P2') AND name = 'Bar B' AND longitude = 106.000912 AND city = 'Da Nang' AND status = 'active') THEN RAISE EXCEPTION 'D1 FAILED: P2'; END IF;
  IF (SELECT place_id FROM public.external_place_references WHERE id = pg_temp.id('REF_B')) <> pg_temp.id('P2')
     OR (SELECT place_id FROM public.external_place_references WHERE id = pg_temp.id('REF_A')) <> pg_temp.id('P') THEN RAISE EXCEPTION 'D1 FAILED: references'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.place_merge_log WHERE id = pg_temp.id('SPLIT') AND action = 'split' AND survivor_place_id = pg_temp.id('P')
                   AND affected_place_id = pg_temp.id('P2') AND admin_id = pg_temp.id('ADMIN') AND ref_count = 1) THEN RAISE EXCEPTION 'D1 FAILED: log'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.places WHERE id = pg_temp.id('P') AND longitude = 106 AND merged_into_place_id IS NULL) THEN RAISE EXCEPTION 'D1 FAILED: P changed'; END IF;
END $d$;`), "D1");
  });

  test("D2 born pending for the owner's live Memory at the split place; the guard and the CHECKs refuse the rest; a re-run writes nothing", () => {
    ok(inRolledBackCase(`
{{FLAGS_ON}}
{{SPLIT}}
SET LOCAL ROLE service_role;
${proposal("M1", "A", "pg_temp.id('P')", "unique_within_bound_name_match")};
${proposal("M1", "A", "NULL", "several_within_bound")} ON CONFLICT (memory_id, split_id) DO NOTHING;
RESET ROLE;
DO $d$
DECLARE ins text := 'INSERT INTO public.memory_place_reresolution_proposals (memory_id, owner_id, split_id, split_from_place_id, candidate_place_ids, suggested_place_id, evidence) VALUES (%L, %L, %L, %L, ARRAY[%L, %L]::uuid[], %L, %L::jsonb)';
  P uuid := pg_temp.id('P'); P2 uuid := pg_temp.id('P2'); S uuid := pg_temp.id('SPLIT'); good jsonb := pg_temp.ev('several_within_bound', pg_temp.id('P'), pg_temp.id('P2'));
BEGIN
  IF (SELECT count(*) FROM public.memory_place_reresolution_proposals WHERE memory_id = pg_temp.id('M1')) <> 1
     OR (SELECT state FROM public.memory_place_reresolution_proposals WHERE memory_id = pg_temp.id('M1')) <> 'pending' THEN RAISE EXCEPTION 'D2 FAILED: one pending proposal'; END IF;
  PERFORM pg_temp.refused('D2 owner', format(ins, pg_temp.id('MB'), pg_temp.id('A'), S, P, P, P2, NULL, good), 'not the Memory''s owner');
  PERFORM pg_temp.refused('D2 deleted', format(ins, pg_temp.id('MDEL'), pg_temp.id('A'), S, P, P, P2, NULL, good), 'the Memory is deleted');
  PERFORM pg_temp.refused('D2 elsewhere', format(ins, pg_temp.id('MELSE'), pg_temp.id('A'), S, P, P, P2, NULL, good), 'no longer stores the split place');
  INSERT INTO public.place_merge_log (id, action, survivor_place_id, affected_place_id) VALUES ('${MERGE_ID}', 'merge', P, P2);
  PERFORM pg_temp.refused('D2 a merge of the same places', format(ins, pg_temp.id('M2'), pg_temp.id('A'), '${MERGE_ID}', P, P, P2, NULL, good), 'is not a split');
  PERFORM pg_temp.refused('D2 coordinate', format(ins, pg_temp.id('M2'), pg_temp.id('A'), S, P, P, P2, NULL, good || '{"lat":10}'), 'evidence_shape');
  PERFORM pg_temp.refused('D2 distance', format(ins, pg_temp.id('M2'), pg_temp.id('A'), S, P, P, P2, NULL, jsonb_set(good, '{candidates,0,within_bound}', '31.4')), 'evidence_shape');
  PERFORM pg_temp.refused('D2 unbacked suggestion', format(ins, pg_temp.id('M2'), pg_temp.id('A'), S, P, P, P2, P2, good), 'suggested_iff_resolved');
END $d$;`), "D2");
  });

  test("D3 accepted only once the Memory stores the chosen place; a decision is final", () => {
    ok(inRolledBackCase(`
{{FLAGS_ON}}
{{SPLIT}}
SET LOCAL ROLE service_role;
${proposal("M2", "A", "NULL", "several_within_bound")};
DO $d$ DECLARE pid uuid := (SELECT id FROM public.memory_place_reresolution_proposals WHERE memory_id = pg_temp.id('M2'));
BEGIN
  PERFORM pg_temp.refused('D3 unchanged', format('UPDATE public.memory_place_reresolution_proposals SET state = ''accepted'', accepted_place_id = %L, decided_at = now() WHERE id = %L', pg_temp.id('P2'), pid), 'does not store the accepted place');
  UPDATE public.memories SET place_id = pg_temp.id('P2')::text WHERE id = pg_temp.id('M2'); -- the owner's PATCH, by its committed effect
  UPDATE public.memory_place_reresolution_proposals SET state = 'accepted', accepted_place_id = pg_temp.id('P2'), decided_at = now() WHERE id = pid;
  PERFORM pg_temp.refused('D3 final', format('UPDATE public.memory_place_reresolution_proposals SET state = ''dismissed'', accepted_place_id = NULL WHERE id = %L', pid), 'decided proposal is final');
END $d$;
RESET ROLE;`), "D3");
  });

  test("D4 the soft delete purges, as the service role that holds no DELETE on the table; archiving does not", () => {
    ok(inRolledBackCase(`
{{FLAGS_ON}}
{{SPLIT}}
SET LOCAL ROLE service_role;
${proposal("M1", "A", "NULL", "several_within_bound")};
${proposal("MB", "B", "NULL", "several_within_bound")};
DO $d$ BEGIN
  PERFORM pg_temp.refused('D4 direct delete', 'DELETE FROM public.memory_place_reresolution_proposals', 'permission denied');
  UPDATE public.memories SET state = 'archived' WHERE id = pg_temp.id('M1');
  IF NOT EXISTS (SELECT 1 FROM public.memory_place_reresolution_proposals WHERE memory_id = pg_temp.id('M1')) THEN RAISE EXCEPTION 'D4 FAILED: archiving purged'; END IF;
  UPDATE public.memories SET state = 'deleted' WHERE id = pg_temp.id('M1');
  IF EXISTS (SELECT 1 FROM public.memory_place_reresolution_proposals WHERE memory_id = pg_temp.id('M1')) THEN RAISE EXCEPTION 'D4 FAILED: the soft delete left the proposal'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.memory_place_reresolution_proposals WHERE memory_id = pg_temp.id('MB')) THEN RAISE EXCEPTION 'D4 FAILED: another Memory''s proposal went'; END IF;
END $d$;
RESET ROLE;`), "D4");
  });

  test("D5 RLS on, no policy, no client privilege or EXECUTE; the flag is seeded FALSE", () => {
    assert.equal(scalar("SELECT relrowsecurity FROM pg_class WHERE oid = 'public.memory_place_reresolution_proposals'::regclass"), "t");
    assert.equal(scalar("SELECT count(*) FROM pg_policy WHERE polrelid = 'public.memory_place_reresolution_proposals'::regclass"), "0");
    for (const role of ["anon", "authenticated"]) {
      for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        assert.equal(scalar(`SELECT has_table_privilege('${role}', 'public.memory_place_reresolution_proposals', '${priv}')`), "f", `${role} ${priv}`);
      }
      assert.equal(scalar(`SELECT has_function_privilege('${role}', 'public.place_split(uuid,jsonb,uuid[],uuid)', 'EXECUTE')`), "f", `${role} EXECUTE`);
    }
    assert.equal(scalar("SELECT has_table_privilege('service_role', 'public.memory_place_reresolution_proposals', 'DELETE')"), "f");
    assert.equal(scalar("SELECT enabled::text FROM public.feature_flags WHERE flag = 'memory_place_split_reresolution_enabled'"), "false");
  });

  test("D6 the account's erasure leaves no proposal", () => {
    ok(inRolledBackCase(`
{{FLAGS_ON}}
{{SPLIT}}
SET LOCAL ROLE service_role;
${proposal("MB", "B", "NULL", "several_within_bound")};
DELETE FROM public.profiles WHERE id = pg_temp.id('B');
RESET ROLE;
DELETE FROM auth.users WHERE id = pg_temp.id('B');
DO $d$ BEGIN
  IF EXISTS (SELECT 1 FROM public.memory_place_reresolution_proposals WHERE owner_id = pg_temp.id('B')) THEN RAISE EXCEPTION 'D6 FAILED: the account''s proposal survived'; END IF;
END $d$;`), "D6");
  });

  test("D7 the rollback refuses while the flag is ON and while proposals exist; restores (merge, unmerge) with no split row; 3812 re-applies", () => {
    const rb = unwrapped(ROLLBACK);
    const refusedOn = inRolledBackCase(`UPDATE public.feature_flags SET enabled = true WHERE flag = 'memory_place_split_reresolution_enabled';\n${rb}`);
    assert.notEqual(refusedOn.status, 0);
    assert.match(refusedOn.stderr, /ROLLBACK REFUSED \(3812\): memory_place_split_reresolution_enabled is ON/);
    const refusedRows = inRolledBackCase(`{{FLAGS_ON}}\n{{SPLIT}}\nSET LOCAL ROLE service_role;\n${proposal("M1", "A", "NULL", "several_within_bound")};\nRESET ROLE;\nUPDATE public.feature_flags SET enabled = false WHERE flag = 'memory_place_split_reresolution_enabled';\n${rb}`);
    assert.notEqual(refusedRows.status, 0);
    assert.match(refusedRows.stderr, /ROLLBACK REFUSED \(3812\): memory_place_reresolution_proposals holds rows/);
    ok(inRolledBackCase(`
UPDATE public.feature_flags SET enabled = false WHERE flag = 'memory_place_split_reresolution_enabled';
DELETE FROM public.memory_place_reresolution_proposals;
DELETE FROM public.place_merge_log WHERE action = 'split';
${rb}
DO $d$ BEGIN
  IF to_regclass('public.memory_place_reresolution_proposals') IS NOT NULL OR to_regprocedure('public.place_split(uuid,jsonb,uuid[],uuid)') IS NOT NULL THEN RAISE EXCEPTION 'D7 FAILED: objects left'; END IF;
  BEGIN
    INSERT INTO public.place_merge_log (action, survivor_place_id, affected_place_id) VALUES ('split', gen_random_uuid(), gen_random_uuid());
    RAISE EXCEPTION 'D7 FAILED: split still admitted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $d$;
${unwrapped(MIGRATION)}`), "D7");
  });
});
