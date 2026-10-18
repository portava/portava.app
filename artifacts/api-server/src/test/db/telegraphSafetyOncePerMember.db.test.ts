/**
 * telegraphSafetyOncePerMember — census-telegraph T254: migration 3901 on the replayed chain, executed against real
 * PostgreSQL (CI's postgis/postgis:16-3.4 service, scripts/local-db/up.sh). The code half and the PGlite execution are
 * src/test/telegraphSafetyOncePerMember.test.ts; this suite proves the index on the real public.notifications, with
 * its real foreign keys, indexes and policies, after the whole chain.
 *
 * Run: LOCAL_DB_URL=postgresql://… node --import tsx/esm --test src/test/db/telegraphSafetyOncePerMember.db.test.ts
 *      (or pnpm run test:db-local). Skips without a database, like every src/test/db suite;
 *      scripts/local-db/run-tests.sh refuses a skipped run.
 *
 * PROPERTIES
 *   S1  3901 is in force: the partial unique index exists, is valid, and is the one the file states.
 *   S2  a second safety notification for one (member, help request) is refused with 23505 naming the index; the
 *       first row is untouched.
 *   S3  nothing else is refused: another member, another help request, another producer, no causal id.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { HAVE_DB, exec, psql, scalar, seedUser, deleteUser } from "./localDb.js";

const INDEX = "notifications_safety_once_per_member_uniq";
let A = "";
let B = "";
const MSG = randomUUID();

const ins = (user: string, source: string | null, causal: string | null) =>
  `INSERT INTO public.notifications (user_id, category, event_type, title, body, source_type, metadata)
   VALUES ('${user}', 'safety', 'telegraph.sos', 'Safety alert', 'asked for help', ${source === null ? "NULL" : `'${source}'`},
           ${causal === null ? "'{}'::jsonb" : `jsonb_build_object('cause', 'SAFETY', 'causal_event_id', '${causal}')`});`;
const mine = () => `SELECT count(*) FROM public.notifications WHERE user_id IN ('${A}', '${B}');`;

describe("census-telegraph T254 — 3901: one safety notification per member per help request", { skip: !HAVE_DB }, () => {
  before(() => {
    A = seedUser("s1a");
    B = seedUser("s1b");
  });

  after(() => {
    if (!A) return;
    exec(`DELETE FROM public.notifications WHERE user_id IN ('${A}', '${B}');`);
    for (const u of [A, B]) if (u) deleteUser(u);
  });

  it("S1 — 3901 is in force: a valid partial unique index over the safety producer's rows", () => {
    const def = scalar(`SELECT pg_get_indexdef('public.${INDEX}'::regclass);`);
    assert.equal(def, `CREATE UNIQUE INDEX ${INDEX} ON public.notifications USING btree (user_id, ((metadata ->> 'causal_event_id'::text))) WHERE ((source_type = 'thread_safety_alert'::text) AND ((metadata ->> 'causal_event_id'::text) IS NOT NULL))`);
    assert.equal(scalar(`SELECT (indisvalid AND indisready)::text FROM pg_index WHERE indexrelid = 'public.${INDEX}'::regclass;`), "true");
  });

  it("S2 — the second row for one (member, help request) is refused with 23505, naming the index; the first stays", () => {
    const r = psql(`BEGIN;\n${ins(A, "thread_safety_alert", `MESSAGE:${MSG}`)}\n${ins(A, "thread_safety_alert", `MESSAGE:${MSG}`)}\nCOMMIT;`);
    assert.notEqual(r.status, 0, "the second insert must fail");
    assert.match(r.stderr, new RegExp(`duplicate key value violates unique constraint "${INDEX}"`));
    assert.equal(scalar(mine()), "0", "the failed transaction wrote nothing");
    exec(ins(A, "thread_safety_alert", `MESSAGE:${MSG}`));
    const again = psql(ins(A, "thread_safety_alert", `MESSAGE:${MSG}`));
    assert.notEqual(again.status, 0);
    assert.match(again.stderr, /23505|duplicate key value/);
    assert.equal(scalar(mine()), "1", "the first row is untouched");
  });

  it("S3 — refuses nothing else: another member, another help request, another producer, no causal id", () => {
    exec([
      ins(B, "thread_safety_alert", `MESSAGE:${MSG}`),
      ins(A, "thread_safety_alert", `MESSAGE:${randomUUID()}`),
      ins(A, "thread_message", `MESSAGE:${MSG}`),
      ins(A, "thread_message", `MESSAGE:${MSG}`),
      ins(A, null, `MESSAGE:${MSG}`),
      ins(A, "thread_safety_alert", null),
      ins(A, "thread_safety_alert", null),
    ].join("\n"), { single: true });
    assert.equal(scalar(mine()), "8");
  });
});
