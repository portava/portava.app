/**
 * rentBuddyBookingsWriteBoundary — migration 3820, executed against real
 * PostgreSQL (PAY-002: only the API, as service_role, writes a booking).
 *
 * Run: LOCAL_DB_URL=postgresql://… node --import tsx/esm --test src/test/db/rentBuddyBookingsWriteBoundary.db.test.ts
 *      (or pnpm run test:db-local). Skips without a database, like every
 *      src/test/db suite; scripts/local-db/run-tests.sh refuses a skipped run.
 *
 * THE DEFECT. The 2026-08-19 baseline grants anon and authenticated ALL on
 * rent_buddy_bookings and keeps `rb_booking_traveler_ins FOR INSERT WITH CHECK
 * (auth.uid() = traveler_id)`, so a signed-in user could INSERT a booking with
 * a price and a status of their choosing, past every gate the route applies.
 * And the nine buddy_* compatibility views ran with their OWNER's rights and
 * were granted ALL to both client roles, so a caller holding only the public
 * anon key could read every booking, write and delete bookings, and set
 * `verified` on a buddy profile — past the table's grants and its policies.
 *
 * HOW THESE PROPERTIES BITE. up.sh replays 3820 with the chain, so the database
 * under test already carries it. Each "before" property therefore RE-OPENS the
 * pre-3820 state inside a transaction with 3820's own rollback, proves the hole
 * is open there, applies 3820's body and proves it closed; the transaction
 * always rolls back. Every fixture row is created inside the same transaction,
 * so the suite leaves nothing behind and needs no cleanup.
 *
 * PROPERTIES
 *   W0   3820 is in force on the replayed chain.
 *   W1   PAY-002: before, an authenticated traveller INSERTs a booking at a
 *        price of their choosing; after, INSERT, UPDATE and DELETE are refused
 *        and no row is written.
 *   W2   the view door: before, anon reads every booking and INSERTs, UPDATEs
 *        and DELETEs through buddy_bookings / buddy_booking_requests; after,
 *        every write is refused and anon reads nothing.
 *   W3   the API path still works: service_role inserts, updates and deletes a
 *        booking and an offer, and reads through the view.
 *   W4   the party read is unchanged: traveller and buddy see their booking by
 *        table and by view; a stranger and anon see none.
 *   W5   rent_buddy_offers: before, the buddy rewrites an offer's price and
 *        status directly; after, refused — and the buddy and the traveller
 *        still read it.
 *   W6   buddy_profiles: before, anon sets `verified` through the view, walking
 *        round 2145; after, refused — and the buddy still edits a field 2145
 *        lets a buddy edit.
 *   W7   3820's postcondition is not decorative: each claim, broken, makes it
 *        raise; untouched, it passes.
 *   W8   3820 is idempotent, and a second apply does not overwrite the record
 *        of the state before the first.
 *   W9   the rollback restores the prior state exactly, from the baseline's
 *        grants and from 2490's; without the record it refuses.
 *   W10  3820's preconditions refuse a state they cannot leave correct.
 *   W11  3820's in-transaction assertion is not decorative: a body that also
 *        took the read, the party policy or the service role's write aborts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HAVE_DB, psql, rows, type PsqlResult } from "./localDb.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const MIGRATION = resolve(__dir, "../../migrations/3820_rent_buddy_bookings_write_boundary.sql");
const ROLLBACK = resolve(__dir, "../../../../../db/rollback/2026-10-04-3820-rent-buddy-bookings-write-boundary-rollback.sql");

/** A file's statements without its own BEGIN … COMMIT, split into the in-transaction body and the tail after the COMMIT. */
function parts(file: string): { body: string; tail: string } {
  const sql = readFileSync(file, "utf8");
  const begin = sql.search(/^BEGIN;\s*$/m);
  const commit = sql.lastIndexOf("\nCOMMIT;");
  assert.ok(begin >= 0 && commit > begin, `${file}: no BEGIN … COMMIT wrapper`);
  return { body: sql.slice(sql.indexOf("\n", begin) + 1, commit) + "\n", tail: sql.slice(commit + "\nCOMMIT;".length) + "\n" };
}

/** 3820 as it runs: body, then its postcondition block. */
const apply = () => { const p = parts(MIGRATION); return p.body + p.tail; };
/** 3820's postcondition block alone. */
const postcondition = () => parts(MIGRATION).tail;
/** 3820's rollback: re-opens the pre-3820 state from the record 3820 wrote. */
const reopen = () => { const p = parts(ROLLBACK); return p.body + p.tail; };

/** Run a script in one transaction that always rolls back. */
function inRolledBackTx(script: string): PsqlResult {
  return psql(`BEGIN;\n${script}\nROLLBACK;\n`);
}

// One traveller, one buddy, one stranger — created inside each transaction.
const T  = "3820aaaa-0000-4000-8000-000000000001";
const B  = "3820aaaa-0000-4000-8000-000000000002";
const S  = "3820aaaa-0000-4000-8000-000000000003";
const BP = "3820bbbb-0000-4000-8000-000000000001"; // the buddy's rent_buddy_profiles row
const BK = "3820cccc-0000-4000-8000-000000000001"; // a booking the API made
const RQ = "3820dddd-0000-4000-8000-000000000001"; // the traveller's request
const OF = "3820eeee-0000-4000-8000-000000000001"; // the buddy's offer on it

const FIXTURES = `
INSERT INTO auth.users (id, email) VALUES ('${T}', 'pay3820_t@local.test'), ('${B}', 'pay3820_b@local.test'), ('${S}', 'pay3820_s@local.test');
INSERT INTO public.profiles (id, handle, name) VALUES ('${T}', 'pay3820_t', 'traveller'), ('${B}', 'pay3820_b', 'buddy'), ('${S}', 'pay3820_s', 'stranger');
INSERT INTO public.rent_buddy_profiles (id, user_id, city) VALUES ('${BP}', '${B}', 'Lisbon');
`;

/** What the API does through the service client: one booking, one request, one offer. */
const API_ROWS = `
SET LOCAL ROLE service_role;
INSERT INTO public.rent_buddy_bookings (id, buddy_id, traveler_id, booking_date, duration_h, group_size, city, category, payment_mode, total_usd, deposit_usd, cash_balance_usd, status)
  VALUES ('${BK}', '${BP}', '${T}', current_date, 2, 1, 'Lisbon', 'local_guide', 'full_in_app', 50, 0, 0, 'pending');
INSERT INTO public.rent_buddy_requests (id, traveler_id, city, category) VALUES ('${RQ}', '${T}', 'Lisbon', 'local_guide');
INSERT INTO public.rent_buddy_offers (id, request_id, buddy_profile_id, buddy_user_id, proposed_price_usd) VALUES ('${OF}', '${RQ}', '${BP}', '${B}', 40);
RESET ROLE;
`;

/** Become a PostgREST caller: the role, and the JWT GUCs auth.uid() / auth.role() read. */
function as(role: "anon" | "authenticated", userId = ""): string {
  return [
    "RESET ROLE;",
    `SELECT set_config('request.jwt.claim.sub', '${userId}', true);`,
    `SELECT set_config('request.jwt.claim.role', '${role}', true);`,
    `SET LOCAL ROLE ${role};`,
  ].join("\n") + "\n";
}

const CLIENT_INSERT = (traveler: string, relation: string) => `
INSERT INTO public.${relation} (buddy_id, traveler_id, booking_date, duration_h, city, category, total_usd, status)
  VALUES ('${BP}', '${traveler}', current_date, 2, 'Lisbon', 'local_guide', 0.01, 'confirmed');`;

const NINE_VIEWS = [
  "buddy_availability", "buddy_booking_checkins", "buddy_booking_requests", "buddy_bookings",
  "buddy_change_requests", "buddy_disputes", "buddy_favorites", "buddy_profiles", "buddy_reviews",
];
const BOUNDED = ["rent_buddy_bookings", "rent_buddy_offers", "buddy_bookings", "buddy_booking_requests"];
const inList = (xs: string[]) => xs.map((x) => `'${x}'`).join(", ");

/** One line of catalog state per privilege, policy, view option, RLS flag and the comment: what 3820 may touch. */
const SNAPSHOT = `
SELECT 'SNAP=' || md5(string_agg(line, E'\\n' ORDER BY line)) FROM (
  SELECT 'ACL ' || c.relname || ' ' || x.grantor::text || ' ' || x.grantee::text || ' ' || x.privilege_type || ' ' || x.is_grantable::text AS line
    FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) x
   WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN (${inList([...BOUNDED, ...NINE_VIEWS])})
  UNION ALL
  SELECT 'OPT ' || c.relname || ' ' || COALESCE(c.reloptions::text, '-')
    FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'v' AND c.relname IN (${inList(NINE_VIEWS)})
  UNION ALL
  SELECT 'POL ' || c.relname || ' ' || p.polname || ' ' || p.polcmd::text || ' ' || p.polpermissive::text || ' ' || p.polroles::text
         || ' ' || COALESCE(pg_get_expr(p.polqual, p.polrelid), '-') || ' ' || COALESCE(pg_get_expr(p.polwithcheck, p.polrelid), '-')
    FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
   WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('rent_buddy_bookings', 'rent_buddy_offers')
  UNION ALL
  SELECT 'RLS ' || c.relname || ' ' || c.relrowsecurity::text FROM pg_class c
   WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('rent_buddy_bookings', 'rent_buddy_offers')
  UNION ALL
  SELECT 'COMMENT ' || COALESCE(obj_description('public.rent_buddy_bookings'::regclass, 'pg_class'), '-')
) s;`;

const snapOf = (out: string, n: number) => [...out.matchAll(/^SNAP=([0-9a-f]{32})$/gm)].map((m) => m[1])[n];

/** Assert a script ended on a privilege refusal for `relation`, and nothing else. */
function assertRefused(r: PsqlResult, relation: string, what: string): void {
  assert.notEqual(r.status, 0, `${what}: the statement was PERMITTED\n${r.stdout}`);
  assert.match(r.stderr, new RegExp(`permission denied for (table|view) ${relation}`), `${what}: refused for another reason: ${r.stderr}`);
}

describe("3820: only service_role writes a Rent-a-Buddy booking or offer (PAY-002)", { skip: !HAVE_DB && "no LOCAL_DB_URL" }, () => {
  it("W0: 3820 is in force on the replayed chain", () => {
    const present = rows<{ relname: string; relkind: string }>(
      `SELECT c.relname, c.relkind::text AS relkind FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN (${inList(BOUNDED)}) ORDER BY 1`);
    assert.deepEqual(present.map((p) => `${p.relname}:${p.relkind}`),
      ["buddy_booking_requests:v", "buddy_bookings:v", "rent_buddy_bookings:r", "rent_buddy_offers:r"],
      "the four relations 3820 bounds are not all here: the harness did not replay the baseline");

    const writes = rows(`
      SELECT c.relname, CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END AS grantee, x.privilege_type
        FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) x
       WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN (${inList(BOUNDED)})
         AND (x.grantee = 0 OR pg_get_userbyid(x.grantee) IN ('anon', 'authenticated')) AND x.privilege_type <> 'SELECT'`);
    assert.deepEqual(writes, [], "a client role still holds a write privilege");

    // The read was not taken with the writes.
    const reads = rows<{ n: number }>(`
      SELECT count(*)::int AS n FROM unnest(ARRAY[${inList(BOUNDED)}]) t, unnest(ARRAY['anon', 'authenticated']) r
       WHERE has_table_privilege(r, ('public.' || t)::regclass, 'SELECT')`)[0]!.n;
    assert.equal(reads, 8, "3820 must leave client SELECT exactly as it found it");

    const policies = rows<{ polname: string; polcmd: string }>(
      `SELECT p.polname, p.polcmd::text AS polcmd FROM pg_policy p WHERE p.polrelid = 'public.rent_buddy_bookings'::regclass ORDER BY 1`);
    assert.deepEqual(policies, [{ polname: "rb_booking_parties", polcmd: "r" }, { polname: "rb_booking_svc", polcmd: "*" }],
      "rent_buddy_bookings must carry the party SELECT policy and the service policy, and no other");

    const owners = rows<{ relname: string }>(`
      SELECT c.relname FROM pg_class c
       WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'v' AND c.relname IN (${inList(NINE_VIEWS)})
         AND NOT COALESCE((SELECT lower(o.option_value) = 'true' FROM pg_options_to_table(c.reloptions) o WHERE o.option_name = 'security_invoker'), false)`);
    assert.deepEqual(owners, [], "a compatibility view still runs with its owner's rights");
    const views = rows<{ n: number }>(`SELECT count(*)::int AS n FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'v' AND c.relname IN (${inList(NINE_VIEWS)})`)[0]!.n;
    assert.equal(views, 9, `expected the baseline's nine compatibility views, found ${views}: a sweep over none proves nothing`);
  });

  it("W1: PAY-002 — before 3820 a traveller INSERTs a booking at their own price; after it INSERT, UPDATE and DELETE are refused", () => {
    // The hole, open: 3820's rollback restores the baseline's grants and policy.
    const open = inRolledBackTx(`${FIXTURES}${reopen()}${as("authenticated", T)}${CLIENT_INSERT(T, "rent_buddy_bookings")}
RESET ROLE;
SELECT 'ROWS=' || count(*) || ' PRICE=' || min(total_usd) || ' STATUS=' || min(status::text) FROM public.rent_buddy_bookings WHERE traveler_id = '${T}';`);
    assert.equal(open.status, 0, `before 3820 the insert must succeed, or this property proves nothing: ${open.stderr}`);
    assert.match(open.stdout, /ROWS=1 PRICE=0\.01 STATUS=confirmed/, "the client did not write the price and status it chose");

    // The hole, closed: the same state, then 3820, then the same statement.
    const shut = inRolledBackTx(`${FIXTURES}${reopen()}${apply()}${as("authenticated", T)}${CLIENT_INSERT(T, "rent_buddy_bookings")}`);
    assertRefused(shut, "rent_buddy_bookings", "authenticated INSERT after 3820");

    // UPDATE and DELETE of a booking the API made, by its own traveller.
    for (const [verb, stmt] of [
      ["UPDATE", `UPDATE public.rent_buddy_bookings SET total_usd = 0.01, status = 'completed' WHERE id = '${BK}';`],
      ["DELETE", `DELETE FROM public.rent_buddy_bookings WHERE id = '${BK}';`],
    ] as const) {
      const before = inRolledBackTx(`${FIXTURES}${API_ROWS}${reopen()}${as("authenticated", T)}${stmt}`);
      // Before 3820 these hold the grant and no policy admits them: 0 rows, no error. The grant is what 3820 removes.
      assert.equal(before.status, 0, `${verb} before 3820: ${before.stderr}`);
      const after = inRolledBackTx(`${FIXTURES}${API_ROWS}${as("authenticated", T)}${stmt}`);
      assertRefused(after, "rent_buddy_bookings", `authenticated ${verb} after 3820`);
    }

    // Stored state: after a refused client INSERT the API's row is the only one and is untouched.
    const state = inRolledBackTx(`${FIXTURES}${API_ROWS}
SAVEPOINT attempt;
${as("authenticated", T)}
DO $$ BEGIN
  INSERT INTO public.rent_buddy_bookings (buddy_id, traveler_id, booking_date, duration_h, city, category, total_usd, status)
    VALUES ('${BP}', '${T}', current_date, 2, 'Lisbon', 'local_guide', 0.01, 'confirmed');
  RAISE EXCEPTION 'the client insert was permitted';
EXCEPTION WHEN insufficient_privilege THEN NULL;
END $$;
RESET ROLE;
SELECT 'ROWS=' || count(*) || ' PRICE=' || min(total_usd) || ' STATUS=' || min(status::text) FROM public.rent_buddy_bookings WHERE traveler_id = '${T}';`);
    assert.equal(state.status, 0, state.stderr);
    assert.match(state.stdout, /ROWS=1 PRICE=50\.00 STATUS=pending/, `the stored bookings are not exactly the API's one: ${state.stdout}`);
  });

  it("W2: the view door — before 3820 anon reads every booking and writes through the views; after it anon reads nothing and every write is refused", () => {
    const open = inRolledBackTx(`${FIXTURES}${API_ROWS}${reopen()}${as("anon")}
SELECT 'VIEW_ROWS=' || count(*) FROM public.buddy_bookings;
SELECT 'TABLE_ROWS=' || count(*) FROM public.rent_buddy_bookings;
${CLIENT_INSERT(S, "buddy_bookings")}
UPDATE public.buddy_booking_requests SET total_usd = 9999 WHERE id = '${BK}';
RESET ROLE;
SELECT 'AFTER_ROWS=' || count(*) || ' API_PRICE=' || (SELECT total_usd FROM public.rent_buddy_bookings WHERE id = '${BK}') FROM public.rent_buddy_bookings;
${as("anon")}
DELETE FROM public.buddy_bookings;
RESET ROLE;
SELECT 'LEFT=' || count(*) FROM public.rent_buddy_bookings;`);
    assert.equal(open.status, 0, `before 3820 anon must be able to do all of this, or the property proves nothing: ${open.stderr}`);
    assert.match(open.stdout, /VIEW_ROWS=1/, "anon did not read the booking through the view");
    assert.match(open.stdout, /TABLE_ROWS=0/, "the table's own RLS should have hidden it from anon — the view is what leaked");
    assert.match(open.stdout, /AFTER_ROWS=2 API_PRICE=9999\.00/, "anon did not insert a booking for another user and rewrite the API's price");
    assert.match(open.stdout, /LEFT=0/, "anon did not delete the bookings");

    const read = inRolledBackTx(`${FIXTURES}${API_ROWS}${as("anon")}
SELECT 'VIEW_ROWS=' || count(*) FROM public.buddy_bookings;
SELECT 'VIEW2_ROWS=' || count(*) FROM public.buddy_booking_requests;`);
    assert.equal(read.status, 0, read.stderr);
    assert.match(read.stdout, /VIEW_ROWS=0/);
    assert.match(read.stdout, /VIEW2_ROWS=0/);

    for (const role of ["anon", "authenticated"] as const) {
      const who = role === "anon" ? as("anon") : as("authenticated", T);
      const cases: Array<[string, string, string]> = [
        ["INSERT buddy_bookings", CLIENT_INSERT(role === "anon" ? S : T, "buddy_bookings"), "buddy_bookings"],
        ["INSERT buddy_booking_requests", CLIENT_INSERT(role === "anon" ? S : T, "buddy_booking_requests"), "buddy_booking_requests"],
        ["UPDATE buddy_booking_requests", `UPDATE public.buddy_booking_requests SET total_usd = 9999 WHERE id = '${BK}';`, "buddy_booking_requests"],
        ["UPDATE buddy_bookings", `UPDATE public.buddy_bookings SET status = 'completed' WHERE id = '${BK}';`, "buddy_bookings"],
        ["DELETE buddy_bookings", `DELETE FROM public.buddy_bookings WHERE id = '${BK}';`, "buddy_bookings"],
      ];
      for (const [what, stmt, relation] of cases) {
        assertRefused(inRolledBackTx(`${FIXTURES}${API_ROWS}${who}${stmt}`), relation, `${role} ${what} after 3820`);
      }
    }
  });

  it("W3: the API path still works — service_role inserts, updates and deletes a booking and an offer, and reads through the view", () => {
    const r = inRolledBackTx(`${FIXTURES}${API_ROWS}
SET LOCAL ROLE service_role;
UPDATE public.rent_buddy_bookings SET status = 'confirmed', confirmed_at = now() WHERE id = '${BK}';
UPDATE public.rent_buddy_offers SET status = 'accepted', accepted_booking_id = '${BK}' WHERE id = '${OF}';
SELECT 'BOOKING=' || status || '/' || total_usd FROM public.rent_buddy_bookings WHERE id = '${BK}';
SELECT 'OFFER=' || status || '/' || proposed_price_usd FROM public.rent_buddy_offers WHERE id = '${OF}';
SELECT 'VIEW=' || count(*) FROM public.buddy_bookings WHERE id = '${BK}';
SELECT 'PROFILE_VIEW=' || count(*) FROM public.buddy_profiles WHERE id = '${BP}';
DELETE FROM public.rent_buddy_offers WHERE id = '${OF}';
DELETE FROM public.rent_buddy_bookings WHERE id = '${BK}';
SELECT 'LEFT=' || (SELECT count(*) FROM public.rent_buddy_bookings WHERE id = '${BK}') || '/' || (SELECT count(*) FROM public.rent_buddy_offers WHERE id = '${OF}');`);
    assert.equal(r.status, 0, `the service path is broken: ${r.stderr}`);
    assert.match(r.stdout, /BOOKING=confirmed\/50\.00/);
    assert.match(r.stdout, /OFFER=accepted\/40\.00/);
    assert.match(r.stdout, /^VIEW=1$/m, "pulse.ts reads buddy_bookings on the service client; it must still see the row");
    assert.match(r.stdout, /PROFILE_VIEW=1/, "CompassFrontLoadEngine reads buddy_profiles on the service client; it must still see the row");
    assert.match(r.stdout, /LEFT=0\/0/);
  });

  it("W4: the party read is unchanged — traveller and buddy see their booking, by table and by view; a stranger and anon see none", () => {
    const count = (who: string) => {
      const r = inRolledBackTx(`${FIXTURES}${API_ROWS}${who}
SELECT 'TABLE=' || count(*) FROM public.rent_buddy_bookings;
SELECT 'VIEW=' || count(*) FROM public.buddy_bookings;
SELECT 'VIEW2=' || count(*) FROM public.buddy_booking_requests;`);
      assert.equal(r.status, 0, r.stderr);
      return ["TABLE", "VIEW", "VIEW2"].map((k) => Number(new RegExp(`^${k}=(\\d+)$`, "m").exec(r.stdout)?.[1] ?? NaN));
    };
    assert.deepEqual(count(as("authenticated", T)), [1, 1, 1], "the traveller lost the read of their own booking");
    assert.deepEqual(count(as("authenticated", B)), [1, 1, 1], "the buddy lost the read of a booking made with them");
    assert.deepEqual(count(as("authenticated", S)), [0, 0, 0], "a stranger reads somebody else's booking");
    assert.deepEqual(count(as("anon")), [0, 0, 0], "anon reads a booking");
  });

  it("W5: rent_buddy_offers — before 3820 the buddy rewrites an offer's price and status directly; after it refused, and both parties still read it", () => {
    const rewrite = `UPDATE public.rent_buddy_offers SET proposed_price_usd = 4000, status = 'accepted' WHERE id = '${OF}';`;
    const open = inRolledBackTx(`${FIXTURES}${API_ROWS}${reopen()}${as("authenticated", B)}${rewrite}
RESET ROLE;
SELECT 'OFFER=' || status || '/' || proposed_price_usd FROM public.rent_buddy_offers WHERE id = '${OF}';`);
    assert.equal(open.status, 0, open.stderr);
    assert.match(open.stdout, /OFFER=accepted\/4000\.00/, "before 3820 the buddy must be able to rewrite the offer, or the property proves nothing");

    assertRefused(inRolledBackTx(`${FIXTURES}${API_ROWS}${as("authenticated", B)}${rewrite}`), "rent_buddy_offers", "buddy UPDATE offer after 3820");
    assertRefused(inRolledBackTx(`${FIXTURES}${API_ROWS}${as("authenticated", B)}
INSERT INTO public.rent_buddy_offers (request_id, buddy_profile_id, buddy_user_id, proposed_price_usd) VALUES ('${RQ}', '${BP}', '${B}', 1);`),
      "rent_buddy_offers", "buddy INSERT offer after 3820");
    assertRefused(inRolledBackTx(`${FIXTURES}${API_ROWS}${as("authenticated", B)}DELETE FROM public.rent_buddy_offers WHERE id = '${OF}';`),
      "rent_buddy_offers", "buddy DELETE offer after 3820");

    for (const [who, label] of [[B, "the buddy"], [T, "the traveller"]] as const) {
      const r = inRolledBackTx(`${FIXTURES}${API_ROWS}${as("authenticated", who)}SELECT 'OFFERS=' || count(*) FROM public.rent_buddy_offers;`);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /OFFERS=1/, `${label} lost the read of the offer`);
    }
    const stranger = inRolledBackTx(`${FIXTURES}${API_ROWS}${as("authenticated", S)}SELECT 'OFFERS=' || count(*) FROM public.rent_buddy_offers;`);
    assert.match(stranger.stdout, /OFFERS=0/);
  });

  it("W6: buddy_profiles — before 3820 anon sets `verified` through the view; after it refused, and the buddy still edits what 2145 lets a buddy edit", () => {
    const forge = `UPDATE public.buddy_profiles SET verified = true, buddy_level = 'elite' WHERE id = '${BP}';`;
    const open = inRolledBackTx(`${FIXTURES}${reopen()}${as("anon")}${forge}
RESET ROLE;
SELECT 'PROFILE=' || verified || '/' || buddy_level FROM public.rent_buddy_profiles WHERE id = '${BP}';`);
    assert.equal(open.status, 0, open.stderr);
    assert.match(open.stdout, /PROFILE=true\/elite/, "before 3820 anon must be able to self-verify through the view, or the property proves nothing");

    assertRefused(inRolledBackTx(`${FIXTURES}${as("anon")}${forge}`), "rent_buddy_profiles", "anon self-verification after 3820");
    assertRefused(inRolledBackTx(`${FIXTURES}${as("authenticated", B)}UPDATE public.buddy_profiles SET verified = true WHERE id = '${BP}';`),
      "rent_buddy_profiles", "the buddy's own self-verification after 3820");

    // The healthy twin: the view is now exactly as writable as the table, so
    // 2145's column grant still lets the buddy edit their own tagline — and
    // RLS still stops a stranger editing it.
    const own = inRolledBackTx(`${FIXTURES}${as("authenticated", B)}UPDATE public.buddy_profiles SET tagline = 'hello' WHERE id = '${BP}';
RESET ROLE;
SELECT 'TAGLINE=' || tagline FROM public.rent_buddy_profiles WHERE id = '${BP}';`);
    assert.equal(own.status, 0, own.stderr);
    assert.match(own.stdout, /TAGLINE=hello/, "the buddy can no longer edit a field 2145 grants");
    const other = inRolledBackTx(`${FIXTURES}${as("authenticated", S)}UPDATE public.buddy_profiles SET tagline = 'defaced' WHERE id = '${BP}';
RESET ROLE;
SELECT 'TAGLINE=' || COALESCE(tagline, '(none)') FROM public.rent_buddy_profiles WHERE id = '${BP}';`);
    assert.equal(other.status, 0, other.stderr);
    assert.match(other.stdout, /TAGLINE=\(none\)/, "a stranger edited another buddy's profile through the view");
  });

  it("W7: 3820's postcondition raises over each broken claim, and passes untouched", () => {
    const healthy = inRolledBackTx(postcondition());
    assert.equal(healthy.status, 0, `the postcondition fails on the state 3820 itself left: ${healthy.stderr}`);

    const cases: Array<[what: string, breakIt: string, expected: RegExp]> = [
      ["authenticated regains INSERT on the table", "GRANT INSERT ON public.rent_buddy_bookings TO authenticated;", /still holds a write privilege: .*rent_buddy_bookings:authenticated:INSERT/],
      ["anon regains UPDATE on a view over bookings", "GRANT UPDATE ON public.buddy_bookings TO anon;", /still holds a write privilege: .*buddy_bookings:anon:UPDATE/],
      ["PUBLIC is granted DELETE on offers", "GRANT DELETE ON public.rent_buddy_offers TO PUBLIC;", /still holds a write privilege: .*rent_buddy_offers:PUBLIC:DELETE/],
      ["a client role is granted TRUNCATE", "GRANT TRUNCATE ON public.rent_buddy_bookings TO anon;", /still holds a write privilege: .*rent_buddy_bookings:anon:TRUNCATE/],
      ["a column-level write grant appears", "GRANT UPDATE (total_usd) ON public.rent_buddy_bookings TO authenticated;", /column-level write privilege: .*rent_buddy_bookings\.total_usd:UPDATE/],
      ["the traveller INSERT policy returns", "CREATE POLICY rb_booking_traveler_ins ON public.rent_buddy_bookings FOR INSERT WITH CHECK ((auth.uid() = traveler_id));", /still carries a client write policy: rb_booking_traveler_ins/],
      ["a new client UPDATE policy is added", "CREATE POLICY zz_3820_upd ON public.rent_buddy_bookings FOR UPDATE USING ((auth.uid() = traveler_id));", /still carries a client write policy: zz_3820_upd/],
      ["a FOR ALL policy for the buddy is added", "CREATE POLICY zz_3820_all ON public.rent_buddy_bookings USING ((auth.uid() = traveler_id));", /still carries a client write policy: zz_3820_all/],
      ["a new owner-rights view reaches bookings", "CREATE VIEW public.zz_3820_door AS SELECT id, total_usd FROM public.rent_buddy_bookings;", /owner's rights.*public\.zz_3820_door/],
      ["an owner-rights view is stacked on an invoker view", "CREATE VIEW public.zz_3820_door2 AS SELECT * FROM public.buddy_bookings;", /owner's rights.*public\.zz_3820_door2/],
      ["a new owner-rights view reaches offers", "CREATE VIEW public.zz_3820_door3 AS SELECT id, proposed_price_usd FROM public.rent_buddy_offers;", /owner's rights.*public\.zz_3820_door3/],
      ["a compatibility view goes back to owner's rights", "ALTER VIEW public.buddy_profiles RESET (security_invoker);", /owner's rights.*public\.buddy_profiles/],
      ["service_role loses INSERT", "REVOKE INSERT ON public.rent_buddy_bookings FROM service_role;", /service_role lost rent_buddy_bookings:INSERT/],
      ["the rollback's record is removed", "COMMENT ON TABLE public.rent_buddy_bookings IS NULL;", /record the rollback restores from is missing/],
    ];
    for (const [what, breakIt, expected] of cases) {
      const out = inRolledBackTx(`${breakIt}\n${postcondition()}`);
      assert.notEqual(out.status, 0, `the postcondition passed although ${what}`);
      assert.match(out.stderr, expected, `${what}: ${out.stderr}`);
    }

    // A policy that only the service role can use is not a client write policy.
    const svc = inRolledBackTx(`CREATE POLICY zz_3820_svc ON public.rent_buddy_bookings FOR ALL TO service_role USING (true) WITH CHECK (true);\n${postcondition()}`);
    assert.equal(svc.status, 0, `a service_role-only policy tripped the postcondition: ${svc.stderr}`);
  });

  it("W7b: re-applying 3820 repairs every re-opened door it owns, and refuses the one it will not guess at", () => {
    const repaired = inRolledBackTx(`
GRANT ALL ON public.rent_buddy_bookings, public.rent_buddy_offers, public.buddy_bookings, public.buddy_booking_requests TO anon, authenticated;
CREATE POLICY rb_booking_traveler_ins ON public.rent_buddy_bookings FOR INSERT WITH CHECK ((auth.uid() = traveler_id));
CREATE VIEW public.zz_3820_door AS SELECT id, total_usd FROM public.rent_buddy_bookings;
ALTER VIEW public.buddy_profiles RESET (security_invoker);
${apply()}`);
    assert.equal(repaired.status, 0, `a second apply did not converge: ${repaired.stderr}`);

    // An unknown client write policy is somebody's decision: 3820 does not drop
    // what it cannot name, and says so by failing.
    const unknown = inRolledBackTx(`CREATE POLICY zz_3820_upd ON public.rent_buddy_bookings FOR UPDATE USING ((auth.uid() = traveler_id));\n${apply()}`);
    assert.notEqual(unknown.status, 0);
    assert.match(unknown.stderr, /still carries a client write policy: zz_3820_upd/);
  });

  it("W8: 3820 is idempotent, and a second apply keeps the record of the state before the first", () => {
    const comment = `SELECT 'RECORD=' || md5(obj_description('public.rent_buddy_bookings'::regclass, 'pg_class')) || ' HELD_INSERT=' || (obj_description('public.rent_buddy_bookings'::regclass, 'pg_class') LIKE '%"held": [%"INSERT"%')::text;`;
    const out = inRolledBackTx(`${reopen()}${apply()}${comment}${SNAPSHOT}${apply()}${comment}${SNAPSHOT}`);
    assert.equal(out.status, 0, out.stderr);
    const records = [...out.stdout.matchAll(/^RECORD=([0-9a-f]{32}) HELD_INSERT=(true|false)$/gm)];
    assert.equal(records.length, 2);
    assert.equal(records[0]![2], "true", "the record does not hold the client INSERT 3820 removed");
    assert.equal(records[1]![1], records[0]![1], "a second apply rewrote the record with the state AFTER the first: the rollback would restore nothing");
    assert.equal(snapOf(out.stdout, 1), snapOf(out.stdout, 0), "a second apply changed something");
  });

  it("W9: the rollback restores the prior state exactly, from the baseline's grants and from 2490's; without the record it refuses", () => {
    for (const [posture, prepare] of [
      ["the baseline's grants (full default set)", ""],
      // 2490 cannot replay on PostgreSQL 16 (MAINTAIN), so its effect on these
      // relations is reproduced: the hosted databases' starting point.
      ["2490's grants (TRUNCATE, REFERENCES, TRIGGER already gone)",
        `REVOKE TRUNCATE, REFERENCES, TRIGGER ON public.rent_buddy_bookings, public.rent_buddy_offers, public.buddy_bookings, public.buddy_booking_requests FROM anon, authenticated;`],
    ] as const) {
      const out = inRolledBackTx(`${reopen()}${prepare}${SNAPSHOT}${apply()}${SNAPSHOT}${reopen()}${SNAPSHOT}`);
      assert.equal(out.status, 0, `${posture}: ${out.stderr}`);
      const [before, applied, restored] = [0, 1, 2].map((n) => snapOf(out.stdout, n));
      assert.ok(before && applied && restored, `${posture}: three snapshots expected, got ${out.stdout}`);
      assert.notEqual(applied, before, `${posture}: the snapshot does not see what 3820 changes, so equality below would prove nothing`);
      assert.equal(restored, before, `${posture}: the rollback did not restore the state before 3820`);
    }

    const twice = inRolledBackTx(`${reopen()}${reopen()}`);
    assert.notEqual(twice.status, 0, "a rollback with no 3820 record to restore from must refuse");
    assert.match(twice.stderr, /ROLLBACK REFUSED \(3820\)/);
  });

  it("W11: 3820's in-transaction assertion aborts a body that changes anything but the client writes and the one policy", () => {
    // The assertion compares what must NOT move, before and after the body's
    // own statements. It cannot be reached while the body is correct, so the
    // body is run with one extra statement slipped in just before the block
    // that carries the assertion — the mistake a later edit of 3820 could make.
    const marker = "DO $narrow$";
    const body = apply();
    assert.equal(body.split(marker).length, 2, "3820 no longer has exactly one $narrow$ block; re-anchor this property");
    const cases: Array<[what: string, extra: string]> = [
      ["the client read is taken with the writes", "REVOKE SELECT ON public.rent_buddy_bookings FROM authenticated;"],
      ["the party SELECT policy is dropped", "DROP POLICY rb_booking_parties ON public.rent_buddy_bookings;"],
      ["the party SELECT policy is rewritten", "ALTER POLICY rb_booking_parties ON public.rent_buddy_bookings USING (true);"],
      ["the service role loses a write", "REVOKE UPDATE ON public.rent_buddy_offers FROM service_role;"],
      ["the buddy's offer policy is dropped", "DROP POLICY rb_offers_buddy ON public.rent_buddy_offers;"],
      ["row level security is switched off", "ALTER TABLE public.rent_buddy_offers DISABLE ROW LEVEL SECURITY;"],
    ];
    for (const [what, extra] of cases) {
      const out = inRolledBackTx(`${reopen()}${body.replace(marker, () => `${extra}\n${marker}`)}`);
      assert.notEqual(out.status, 0, `3820 completed although ${what}`);
      assert.match(out.stderr, /ASSERTION FAILED \(3820\): something other than the client write privileges and rb_booking_traveler_ins changed/, `${what}: ${out.stderr}`);
    }
    // The twin: the unmodified body, from the same starting state, completes.
    const clean = inRolledBackTx(`${reopen()}${body}`);
    assert.equal(clean.status, 0, clean.stderr);
  });

  it("W10: 3820's preconditions refuse a state they cannot leave correct", () => {
    const cases: Array<[what: string, prepare: string, expected: RegExp]> = [
      ["RLS is off on a table whose client SELECT 3820 keeps",
        "ALTER TABLE public.rent_buddy_bookings DISABLE ROW LEVEL SECURITY;", /PRECONDITION FAILED \(3820\): row level security is not enabled on rent_buddy_bookings/],
      ["service_role cannot write",
        "REVOKE INSERT ON public.rent_buddy_offers FROM service_role;", /PRECONDITION FAILED \(3820\): service_role lacks rent_buddy_offers:INSERT/],
      ["a column-level client write grant exists",
        "GRANT UPDATE (notes) ON public.rent_buddy_bookings TO authenticated;", /PRECONDITION FAILED \(3820\): column-level client write privileges exist \(rent_buddy_bookings\.notes:UPDATE\)/],
      ["the INSERT policy is not the baseline's",
        "CREATE POLICY rb_booking_traveler_ins ON public.rent_buddy_bookings FOR INSERT WITH CHECK (true);", /PRECONDITION FAILED \(3820\): policy rb_booking_traveler_ins on rent_buddy_bookings is not the baseline's/],
    ];
    for (const [what, prepare, expected] of cases) {
      const out = inRolledBackTx(`${prepare}\n${apply()}`);
      assert.notEqual(out.status, 0, `3820 applied although ${what}`);
      assert.match(out.stderr, expected, `${what}: ${out.stderr}`);
    }
  });
});
