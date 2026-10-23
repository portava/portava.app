/**
 * reviewsCompassMemories3910 — migration 3910 (production's 2096 and 2099, codified), executed against real
 * PostgreSQL (CI's postgis/postgis:16-3.4 service, scripts/local-db/up.sh).
 *
 * Run: LOCAL_DB_URL=postgresql://… node --import tsx/esm --test src/test/db/reviewsCompassMemories3910.db.test.ts
 *      (or pnpm run test:db-local). Skips without a database, like every src/test/db suite;
 *      scripts/local-db/run-tests.sh refuses a skipped run.
 *
 * THE STARTING SHAPES
 *   production / this harness   the baseline already carries 2096 (RLS on compass_memories) and 2099 (the
 *                               visibility-scoped public review read), so 3910 must change nothing.
 *   portava-ci                  the chain from 0001: compass_memories with RLS off and 0067's unscoped
 *                               "Public read published reviews". Rebuilt here inside a rolled-back transaction.
 *
 * PROPERTIES
 *   R0  on the replayed chain, 3910's own postconditions hold.
 *   R1  re-running 3910's body on that shape is a strict no-op: no catalog row it could touch is rewritten.
 *   R2  on portava-ci's shape the body enables RLS on compass_memories, creates the scoped read and drops
 *       0067's, and the same postconditions then hold.
 *   R3  the scoped read works: anon reads a published public review and not a published anonymous one; the
 *       author still reads their own anonymous review. Under 0067's policy anon read both (red before).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HAVE_DB, exec, seedUser, deleteUser } from "./localDb.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = resolve(__dir, "../../migrations");
const FILE = readFileSync(resolve(MIGRATIONS, "3910_reviews_and_compass_memories_2096_2099_codified.sql"), "utf8");
const BODY = (() => {
  const b = FILE.indexOf("\nBEGIN;\n");
  const c = FILE.indexOf("\nCOMMIT;\n");
  assert.ok(b >= 0 && c > b, "3910 is BEGIN … COMMIT with a postcondition tail");
  return FILE.slice(b + "\nBEGIN;\n".length, c);
})();
const POSTCONDITIONS = FILE.slice(FILE.indexOf("\nCOMMIT;\n") + "\nCOMMIT;\n".length);
/** 0067's unscoped public read, verbatim, schema-qualified the way portava-ci resolved it. */
const POLICY_0067 = (() => {
  const s = readFileSync(resolve(MIGRATIONS, "0067_reviews.sql"), "utf8");
  const start = s.indexOf('CREATE POLICY "Public read published reviews"');
  const end = s.indexOf(";", start);
  assert.ok(start >= 0 && end > start, "0067 still creates the unscoped public read");
  return s.slice(start, end + 1).replace(" ON reviews", " ON public.reviews");
})();
const PORTAVA_CI_SHAPE = `
  DROP POLICY "Public reads published public reviews" ON public.reviews;
  ${POLICY_0067}
  ALTER TABLE public.compass_memories DISABLE ROW LEVEL SECURITY;`;

const CATALOG = `
  SELECT 'policy:' || polname || '@' || oid || '/' || xmin FROM pg_policy
   WHERE polrelid IN ('public.reviews'::regclass, 'public.compass_memories'::regclass)
  UNION ALL SELECT 'class:' || relname || '@' || oid || '/' || xmin FROM pg_class
   WHERE oid IN ('public.reviews'::regclass, 'public.compass_memories'::regclass)
  ORDER BY 1`;

const as = (uid: string | null) =>
  uid === null
    ? `DO $p$ BEGIN PERFORM set_config('request.jwt.claim.role', 'anon', true); END $p$;\nSET LOCAL ROLE anon;\n`
    : `DO $p$ BEGIN PERFORM set_config('request.jwt.claim.sub', '${uid}', true); PERFORM set_config('request.jwt.claim.role', 'authenticated', true); END $p$;\nSET LOCAL ROLE authenticated;\n`;

let AUTHOR = "";
const PUBLIC_REVIEW = "00000000-0000-4000-a000-0000000391a1";
const ANON_REVIEW = "00000000-0000-4000-a000-0000000391a2";

/** Which of the two fixture reviews `who` reads; `prelude` runs first in the same rolled-back transaction. */
function reads(who: string | null, prelude = ""): string[] {
  const out = exec(`BEGIN;\n${prelude}\n${as(who)}SELECT 'id=' || id FROM public.reviews WHERE id IN ('${PUBLIC_REVIEW}', '${ANON_REVIEW}') ORDER BY id;\nROLLBACK;`);
  return out.filter((l) => l.startsWith("id=")).map((l) => l.slice(3));
}

describe("3910 — production's 2096 and 2099 (compass_memories RLS, visibility-scoped review reads), codified", { skip: !HAVE_DB }, () => {
  before(() => {
    AUTHOR = seedUser("r3910author");
    exec(`INSERT INTO public.reviews (id, reviewer_id, entity_type, entity_id, rating, body, visibility, state) VALUES
      ('${PUBLIC_REVIEW}', '${AUTHOR}', 'place', gen_random_uuid(), 5, 'r3910 public', 'public', 'published'),
      ('${ANON_REVIEW}', '${AUTHOR}', 'place', gen_random_uuid(), 2, 'r3910 anonymous', 'anonymous', 'published');`);
  });

  after(() => {
    if (!AUTHOR) return;
    exec(`DELETE FROM public.reviews WHERE id IN ('${PUBLIC_REVIEW}', '${ANON_REVIEW}');`);
    deleteUser(AUTHOR);
  });

  it("R0 — on the replayed chain 3910's postconditions hold", () => {
    exec(POSTCONDITIONS);
  });

  it("R1 — on that shape, 3910's body rewrites no catalog row (a strict no-op, as on production)", () => {
    const out = exec(`BEGIN;\n${CATALOG};\nSELECT '---';\n${BODY}\n${CATALOG};\nROLLBACK;`);
    const sep = out.indexOf("---");
    assert.ok(sep > 0, out.join("\n"));
    assert.ok(sep >= 7, `anti-vacuity: the snapshot read the objects (${sep} rows)`);
    assert.deepEqual(out.slice(sep + 1), out.slice(0, sep), "no oid or xmin changed");
  });

  it("R2 — on portava-ci's shape the body converges to production's, and the postconditions then hold", () => {
    const state = `SELECT 'state=' || (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.compass_memories'::regclass)
      || ' ' || (SELECT string_agg(polname, ',' ORDER BY polname) FROM pg_policy WHERE polrelid = 'public.reviews'::regclass AND polname LIKE 'Public %');`;
    const out = exec(`BEGIN;\n${PORTAVA_CI_SHAPE}\n${state}\n${BODY}\n${POSTCONDITIONS}\n${state}\nROLLBACK;`);
    assert.deepEqual(out.filter((l) => l.startsWith("state=")), [
      "state=false Public read published reviews",
      "state=true Public reads published public reviews",
    ]);
  });

  it("R3 — anon reads the published public review and not the anonymous one; the author reads both", () => {
    assert.deepEqual(reads(null, PORTAVA_CI_SHAPE), [PUBLIC_REVIEW, ANON_REVIEW], "RED BEFORE: under 0067 anon reads the anonymous review");
    assert.deepEqual(reads(null), [PUBLIC_REVIEW], "after 3910 anon reads only the public one");
    assert.deepEqual(reads(AUTHOR), [PUBLIC_REVIEW, ANON_REVIEW], "the author still reads their own anonymous review");
  });
});
