/**
 * Migration 3802 — memory_narrative_ai_consent and memory_narrative_ai_enabled,
 * on the replayed chain (census-highlights-memories H172; B58 MEM-NARR-1).
 *
 * WHAT IS PROVED HERE, on the real chain rather than as text:
 *   · the flag exists and is OFF;
 *   · no client role can read or write the table (rule 4), through RLS or around it;
 *   · service_role can record a grant, and a grant that is not stamped is refused;
 *   · deleting the account erases the person's consent row (the cascade the
 *     deletion disposition ERASED_BY_CASCADE relies on);
 *   · the migration re-applies as a no-op, and its postconditions hold when run alone.
 *
 * Run: LOCAL_DB_URL=... node --import tsx/esm --test src/test/db/memoryNarrativeAiConsent.db.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { HAVE_DB, deleteUser, exec, psql, scalar, seedUser } from "./localDb.ts";

const SKIP = HAVE_DB ? false : "LOCAL_DB_URL not set — scripts/local-db/up.sh provides one";
const MIGRATION = new URL("../../migrations/3802_memory_narrative_ai_consent.sql", import.meta.url);

/** Run a statement as a role; return psql's exit status and stderr. */
function as(role: "anon" | "authenticated" | "service_role", script: string, sub?: string): { status: number; err: string } {
  const who = sub
    ? `SELECT set_config('request.jwt.claim.sub', '${sub}', true);\nSELECT set_config('request.jwt.claim.role', '${role}', true);\n`
    : "";
  const r = psql(`${who}SET LOCAL ROLE ${role};\n${script}`, { single: true });
  return { status: r.status, err: r.stderr };
}

describe("3802 memory_narrative_ai_consent — on the replayed chain", { skip: SKIP }, () => {
  let owner = "";
  let other = "";

  before(() => {
    owner = seedUser("narr_owner");
    other = seedUser("narr_other");
  });
  after(() => {
    for (const id of [owner, other]) if (id) { try { deleteUser(id); } catch { /* already gone */ } }
  });

  it("the flag is seeded OFF", () => {
    assert.equal(scalar(`SELECT enabled::text FROM public.feature_flags WHERE flag = 'memory_narrative_ai_enabled';`), "false");
  });

  it("no client role holds any privilege on the table, and RLS is on", () => {
    for (const role of ["anon", "authenticated"]) {
      for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        assert.equal(scalar(`SELECT has_table_privilege('${role}', 'public.memory_narrative_ai_consent', '${priv}')::text;`), "false", `${role} ${priv}`);
      }
    }
    assert.equal(scalar(`SELECT relrowsecurity::text FROM pg_class WHERE oid = 'public.memory_narrative_ai_consent'::regclass;`), "true");
  });

  it("a signed-in person cannot grant or read their own consent through PostgREST — only the server stamps it", () => {
    const write = as("authenticated", `INSERT INTO public.memory_narrative_ai_consent (user_id, enabled, consent_version, consented_at) VALUES ('${owner}', true, 'memory_narrative_ai_v1', now());`, owner);
    assert.notEqual(write.status, 0);
    assert.match(write.err, /permission denied/);
    const read = as("authenticated", `SELECT count(*) FROM public.memory_narrative_ai_consent;`, owner);
    assert.notEqual(read.status, 0);
    assert.match(read.err, /permission denied/);
  });

  it("service_role records a stamped grant; an unstamped grant is refused", () => {
    const bad = as("service_role", `INSERT INTO public.memory_narrative_ai_consent (user_id, enabled) VALUES ('${other}', true);`);
    assert.notEqual(bad.status, 0);
    assert.match(bad.err, /memory_narrative_ai_consent_grant_is_stamped/);
    const ok = as("service_role", `INSERT INTO public.memory_narrative_ai_consent (user_id, enabled, consent_version, consented_at) VALUES ('${owner}', true, 'memory_narrative_ai_v1', now());`);
    assert.equal(ok.status, 0, ok.err);
    assert.equal(scalar(`SELECT count(*)::text FROM public.memory_narrative_ai_consent WHERE user_id = '${owner}' AND enabled;`), "1");
  });

  it("deleting the account erases the person's consent row", () => {
    const id = seedUser("narr_gone");
    exec(`SET LOCAL ROLE service_role;\nINSERT INTO public.memory_narrative_ai_consent (user_id, enabled, consent_version, consented_at) VALUES ('${id}', true, 'memory_narrative_ai_v1', now());`, { single: true });
    deleteUser(id);
    assert.equal(scalar(`SELECT count(*)::text FROM public.memory_narrative_ai_consent WHERE user_id = '${id}';`), "0");
  });

  it("re-applies as a no-op, the flag still OFF, and its postconditions hold run alone", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    const again = psql(sql);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(scalar(`SELECT enabled::text FROM public.feature_flags WHERE flag = 'memory_narrative_ai_enabled';`), "false");
    const post = sql.slice(sql.indexOf("DO $post$"));
    const alone = psql(post);
    assert.equal(alone.status, 0, alone.stderr);
  });
});
