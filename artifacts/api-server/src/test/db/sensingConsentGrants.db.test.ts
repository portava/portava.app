/**
 * sensingConsentGrants — migration 3703 against real PostgreSQL (OD-MAP-6).
 *
 * Run: LOCAL_DB_URL=postgresql://… node --import tsx/esm --test src/test/db/sensingConsentGrants.db.test.ts
 *      Skips without a database, like every src/test/db suite.
 *
 *   SC-1  a signed-in person cannot read or write ANY grant row with their client
 *         key — not even their own: the API stamps the version as service_role.
 *   SC-2  service_role writes one row per (person, scope); an unknown scope and a
 *         withdrawal before the grant are refused by the table itself.
 *   SC-3  deleting the person's auth.users row removes their grants (cascade).
 *   SC-4  the flag is seeded FALSE; the rollback REFUSES while it is TRUE, drops
 *         the table when it is not, and 3703 re-applies.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HAVE_DB, exec, psql, scalar, seedUser, deleteUser } from "./localDb.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const MIGRATION = resolve(__dir, "../../migrations/3703_sensing_consent_grants.sql");
const ROLLBACK = resolve(__dir, "../../../../../db/rollback/2026-10-06-3703-sensing-consent-grants-rollback.sql");

let PERSON = "";
let GONE = "";
const asPerson = (uid: string, sql: string) => psql(
  `DO $p$ BEGIN PERFORM set_config('request.jwt.claim.sub', '${uid}', true); PERFORM set_config('request.jwt.claim.role', 'authenticated', true); END $p$;\nSET LOCAL ROLE authenticated;\n${sql}`,
  { single: true },
);
const asService = (sql: string) => psql(`SET LOCAL ROLE service_role;\n${sql}`, { single: true });

describe("3703: OD-MAP-6's three sensing consents are service-role records", { skip: !HAVE_DB && "no LOCAL_DB_URL" }, () => {
  before(() => { PERSON = seedUser("sc3703"); GONE = seedUser("sc3703gone"); });
  after(() => {
    if (!PERSON) return;
    exec(`DELETE FROM public.sensing_consent_grants WHERE user_id IN ('${PERSON}', '${GONE}');`);
    deleteUser(PERSON);
  });

  it("SC-1 — a signed-in person cannot read or write any grant row with their client key, even their own", () => {
    const w = asService(`INSERT INTO public.sensing_consent_grants (user_id, scope, disclosure_version, granted_at) VALUES ('${PERSON}', 'capture', 'sensing_capture_v1', now());`);
    assert.equal(w.status, 0, w.stderr);
    const read = asPerson(PERSON, `SELECT scope FROM public.sensing_consent_grants WHERE user_id = '${PERSON}';`);
    assert.notEqual(read.status, 0, "a client read its own grant row directly");
    assert.match(read.stderr, /permission denied/);
    const write = asPerson(PERSON, `INSERT INTO public.sensing_consent_grants (user_id, scope, disclosure_version, granted_at) VALUES ('${PERSON}', 'upload', 'anything', now());`);
    assert.notEqual(write.status, 0, "a client wrote a grant with a version of its choosing");
  });

  it("SC-2 — one row per (person, scope); an unknown scope and a withdrawal before the grant are refused by the table", () => {
    const dup = asService(`INSERT INTO public.sensing_consent_grants (user_id, scope, disclosure_version, granted_at) VALUES ('${PERSON}', 'capture', 'sensing_capture_v1', now());`);
    assert.notEqual(dup.status, 0, "a second capture row for the same person");
    const unknown = asService(`INSERT INTO public.sensing_consent_grants (user_id, scope, disclosure_version, granted_at) VALUES ('${PERSON}', 'everything', 'v1', now());`);
    assert.notEqual(unknown.status, 0);
    assert.match(unknown.stderr, /sensing_consent_grants_scope_check/);
    const early = asService(`INSERT INTO public.sensing_consent_grants (user_id, scope, disclosure_version, granted_at, withdrawn_at) VALUES ('${PERSON}', 'surface', 'sensing_surface_v1', now(), now() - interval '1 day');`);
    assert.notEqual(early.status, 0);
    assert.match(early.stderr, /sensing_consent_grants_withdrawn_after_granted/);
  });

  it("SC-3 — deleting the person's auth.users row removes their grants", () => {
    assert.equal(asService(`INSERT INTO public.sensing_consent_grants (user_id, scope, disclosure_version, granted_at) VALUES ('${GONE}', 'capture', 'sensing_capture_v1', now());`).status, 0);
    deleteUser(GONE);
    assert.equal(scalar(`SELECT count(*) FROM public.sensing_consent_grants WHERE user_id = '${GONE}'`), "0");
  });

  it("SC-4 — the flag is seeded FALSE; the rollback refuses while it is TRUE, drops when it is not, and 3703 re-applies", () => {
    assert.equal(scalar(`SELECT enabled::text FROM public.feature_flags WHERE flag = 'sensing_consent_split_enabled'`), "false");
    exec(`UPDATE public.feature_flags SET enabled = true WHERE flag = 'sensing_consent_split_enabled';`);
    try {
      const refused = psql(readFileSync(ROLLBACK, "utf8"));
      assert.notEqual(refused.status, 0);
      assert.match(refused.stderr, /ROLLBACK REFUSED \(3703\)/);
    } finally {
      exec(`UPDATE public.feature_flags SET enabled = false WHERE flag = 'sensing_consent_split_enabled';`);
    }
    exec(`DELETE FROM public.sensing_consent_grants WHERE user_id = '${PERSON}';`);
    const rb = psql(readFileSync(ROLLBACK, "utf8"));
    assert.equal(rb.status, 0, rb.stderr);
    assert.equal(scalar(`SELECT (to_regclass('public.sensing_consent_grants') IS NULL)::text`), "true");
    const re = psql(readFileSync(MIGRATION, "utf8"));
    assert.equal(re.status, 0, re.stderr);
    assert.equal(scalar(`SELECT (to_regclass('public.sensing_consent_grants') IS NULL)::text`), "false");
  });
});
