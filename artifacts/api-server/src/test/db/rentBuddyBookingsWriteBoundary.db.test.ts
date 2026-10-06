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
 *        raise; untouched, it passes. Its policy claim is about what a client
 *        role can DO — an effective privilege AND a policy that admits it — and
 *        the catalog verdict is checked against the write itself.
 *   W7b  re-applying 3820 repairs every re-opened door it owns, reports a
 *        client-write policy no privilege reaches, and refuses a view it does
 *        not own the decision for.
 *   W8   3820 is idempotent, and a second apply does not overwrite the record
 *        of the state before the first.
 *   W9   apply, apply again, rollback: the prior state is restored exactly,
 *        from the baseline's grants, from 2490's and from the hosted
 *        databases' as read on 2026-10-04; without the record the rollback
 *        refuses.
 *   W10  3820's preconditions refuse a state they cannot leave correct, naming
 *        a view outside the nine that reaches either table as its owner.
 *   W11  3820's in-transaction assertion is not decorative: a body that also
 *        took the read, the party policy or the service role's write aborts.
 *   W12  policies as a Supabase advisor rewrites them — `(select auth.role())`,
 *        `(select auth.uid())`, `TO authenticated` — neither stop the apply nor
 *        trip its postcondition, and the rollback recreates the dropped policy
 *        as it was FOUND.
 *   W13  the rollback's record survives a comment that has been added to; a
 *        comment that was REPLACED makes the postcondition raise and the
 *        rollback refuse, loudly, in both of its blocks.
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

    // ── The policy claim: what a client role can DO ───────────────────────────
    // A privilege that arrives through ROLE MEMBERSHIP is in no ACL entry of
    // anon, authenticated or PUBLIC, so claims 1 and 2 cannot see it; claim 3
    // asks has_table_privilege, which can. Each case is then tried for real as
    // the role, so the catalog verdict is held against the write itself.
    const VIA = (grant: string) => `CREATE ROLE zz_3820_w NOLOGIN; ${grant} TO zz_3820_w; GRANT zz_3820_w TO authenticated;\n`;
    const TRY_INSERT = `${as("authenticated", T)}${CLIENT_INSERT(T, "rent_buddy_bookings").replace(/;\s*$/, " RETURNING 'WROTE=' || total_usd;")}`;
    const TRY_UPDATE = `${as("authenticated", T)}UPDATE public.rent_buddy_bookings SET total_usd = 0.01 WHERE id = '${BK}' RETURNING 'WROTE=' || total_usd;`;
    const canWrite: Array<[what: string, breakIt: string, expected: RegExp, attempt: string, wrote: RegExp]> = [
      ["an inherited INSERT privilege meets a policy that admits the traveller",
        `${VIA("GRANT INSERT ON public.rent_buddy_bookings")}CREATE POLICY zz_3820_ins ON public.rent_buddy_bookings FOR INSERT WITH CHECK ((auth.uid() = traveler_id));`,
        /a client role can still write: .*rent_buddy_bookings:authenticated:INSERT admitted by policy zz_3820_ins/, TRY_INSERT, /WROTE=0\.01/],
      ["the admitting policy is the advisor's rewrite, TO authenticated",
        `${VIA("GRANT INSERT ON public.rent_buddy_bookings")}CREATE POLICY zz_3820_ins ON public.rent_buddy_bookings FOR INSERT TO authenticated WITH CHECK (((SELECT auth.uid()) = traveler_id));`,
        /rent_buddy_bookings:authenticated:INSERT admitted by policy zz_3820_ins/, TRY_INSERT, /WROTE=0\.01/],
      ["an inherited UPDATE privilege meets a FOR ALL policy",
        `${VIA("GRANT UPDATE ON public.rent_buddy_bookings")}CREATE POLICY zz_3820_all ON public.rent_buddy_bookings USING ((auth.uid() = traveler_id));`,
        /rent_buddy_bookings:authenticated:UPDATE admitted by policy zz_3820_all/, TRY_UPDATE, /WROTE=0\.01/],
      ["an inherited COLUMN privilege meets an UPDATE policy",
        `${VIA("GRANT UPDATE (total_usd) ON public.rent_buddy_bookings")}CREATE POLICY zz_3820_upd ON public.rent_buddy_bookings FOR UPDATE USING ((auth.uid() = traveler_id));`,
        /rent_buddy_bookings:authenticated:UPDATE admitted by policy zz_3820_upd/, TRY_UPDATE, /WROTE=0\.01/],
      // DELETE has no column form, so this is the one case that rests on has_table_privilege alone.
      ["an inherited DELETE privilege meets a DELETE policy",
        `${VIA("GRANT DELETE ON public.rent_buddy_bookings")}CREATE POLICY zz_3820_del ON public.rent_buddy_bookings FOR DELETE USING ((auth.uid() = traveler_id));`,
        /rent_buddy_bookings:authenticated:DELETE admitted by policy zz_3820_del/,
        `${as("authenticated", T)}DELETE FROM public.rent_buddy_bookings WHERE id = '${BK}' RETURNING 'WROTE=gone';`, /WROTE=gone/],
      ["a predicate that only LOOKS like the service one",
        `${VIA("GRANT UPDATE ON public.rent_buddy_bookings")}CREATE POLICY zz_3820_fake ON public.rent_buddy_bookings FOR UPDATE USING ((auth.role() = 'authenticated'));`,
        /rent_buddy_bookings:authenticated:UPDATE admitted by policy zz_3820_fake/, TRY_UPDATE, /WROTE=0\.01/],
      ["row level security is switched off under an inherited privilege",
        `${VIA("GRANT UPDATE ON public.rent_buddy_bookings")}ALTER TABLE public.rent_buddy_bookings DISABLE ROW LEVEL SECURITY;`,
        /rent_buddy_bookings:authenticated:UPDATE with row level security off/, TRY_UPDATE, /WROTE=0\.01/],
      ["rent_buddy_offers: an inherited UPDATE privilege meets rb_offers_buddy",
        VIA("GRANT UPDATE ON public.rent_buddy_offers"),
        /rent_buddy_offers:authenticated:UPDATE admitted by policy rb_offers_buddy/,
        `${as("authenticated", B)}UPDATE public.rent_buddy_offers SET proposed_price_usd = 4000 WHERE id = '${OF}' RETURNING 'WROTE=' || proposed_price_usd;`, /WROTE=4000/],
    ];
    for (const [what, breakIt, expected, attempt, wrote] of canWrite) {
      const out = inRolledBackTx(`${breakIt}\n${postcondition()}`);
      assert.notEqual(out.status, 0, `the postcondition passed although ${what}`);
      assert.match(out.stderr, expected, `${what}: ${out.stderr}`);
      const real = inRolledBackTx(`${FIXTURES}${API_ROWS}${breakIt}\n${attempt}`);
      assert.equal(real.status, 0, `${what}: the postcondition says the role can write, and the write was refused: ${real.stderr}`);
      assert.match(real.stdout, wrote, `${what}: the write did not land: ${real.stdout}`);
    }

    // The other half: a privilege with no policy that admits it, or a policy
    // with no privilege, is not a client write — and the write really is refused.
    const cannotWrite: Array<[what: string, state: string, attempt: string, refusal: RegExp, notice: RegExp | null]> = [
      ["an inherited INSERT privilege meets only the service policy",
        VIA("GRANT INSERT ON public.rent_buddy_bookings"), TRY_INSERT, /violates row-level security policy/, null],
      ["…and the service policy is the advisor's rewrite",
        `${VIA("GRANT INSERT ON public.rent_buddy_bookings")}ALTER POLICY rb_booking_svc ON public.rent_buddy_bookings USING (((SELECT auth.role()) = 'service_role'));`,
        TRY_INSERT, /violates row-level security policy/, null],
      ["…or is written the other way round, with a WITH CHECK",
        `${VIA("GRANT INSERT ON public.rent_buddy_bookings")}ALTER POLICY rb_booking_svc ON public.rent_buddy_bookings USING (('service_role' = (SELECT auth.role()))) WITH CHECK ((auth.role() = 'service_role'));`,
        TRY_INSERT, /violates row-level security policy/, null],
      ["an inherited privilege meets a policy for service_role only",
        `${VIA("GRANT INSERT ON public.rent_buddy_bookings")}CREATE POLICY zz_3820_svc ON public.rent_buddy_bookings FOR ALL TO service_role USING (true) WITH CHECK (true);`,
        TRY_INSERT, /violates row-level security policy/, null],
      ["the traveller INSERT policy returns with no privilege behind it",
        "CREATE POLICY rb_booking_traveler_ins ON public.rent_buddy_bookings FOR INSERT WITH CHECK ((auth.uid() = traveler_id));",
        TRY_INSERT, /permission denied for table rent_buddy_bookings/, /no privilege reaches: .*rent_buddy_bookings\.rb_booking_traveler_ins/],
      ["a client UPDATE policy is added with no privilege behind it",
        "CREATE POLICY zz_3820_upd ON public.rent_buddy_bookings FOR UPDATE TO authenticated USING (((SELECT auth.uid()) = traveler_id));",
        TRY_UPDATE, /permission denied for table rent_buddy_bookings/, /no privilege reaches: .*rent_buddy_bookings\.zz_3820_upd/],
    ];
    for (const [what, state, attempt, refusal, notice] of cannotWrite) {
      const out = inRolledBackTx(`${state}\n${postcondition()}`);
      assert.equal(out.status, 0, `the postcondition raised although ${what} — no client role can write: ${out.stderr}`);
      if (notice) assert.match(out.stderr, notice, `${what}: the closing NOTICE does not name the policy: ${out.stderr}`);
      const real = inRolledBackTx(`${FIXTURES}${API_ROWS}${state}\n${attempt}`);
      assert.notEqual(real.status, 0, `${what}: the postcondition says no client role can write, and the write was PERMITTED\n${real.stdout}`);
      assert.match(real.stderr, refusal, `${what}: refused for another reason: ${real.stderr}`);
    }
  });

  it("W7b: re-applying 3820 repairs every re-opened door it owns, reports an unreachable client-write policy, and refuses a view that is not its to alter", () => {
    const repaired = inRolledBackTx(`
GRANT ALL ON public.rent_buddy_bookings, public.rent_buddy_offers, public.buddy_bookings, public.buddy_booking_requests TO anon, authenticated;
CREATE POLICY rb_booking_traveler_ins ON public.rent_buddy_bookings FOR INSERT TO authenticated WITH CHECK (((SELECT auth.uid()) = traveler_id));
ALTER VIEW public.buddy_profiles RESET (security_invoker);
${apply()}
SELECT 'POLICIES=' || string_agg(polname, ',' ORDER BY polname) FROM pg_policy WHERE polrelid = 'public.rent_buddy_bookings'::regclass;
SELECT 'PROFILE_VIEW=' || reloptions::text FROM pg_class WHERE oid = 'public.buddy_profiles'::regclass;`);
    assert.equal(repaired.status, 0, `a second apply did not converge: ${repaired.stderr}`);
    assert.match(repaired.stdout, /POLICIES=rb_booking_parties,rb_booking_svc$/m, "the re-created traveller INSERT policy was not dropped again");
    assert.match(repaired.stdout, /PROFILE_VIEW=\{security_invoker=true\}/, "the compatibility view was not switched back");

    // A client write policy 3820 does not name is somebody's decision. With no
    // client privilege behind it, it admits nothing: 3820 applies, and says so.
    const unknown = inRolledBackTx(`CREATE POLICY zz_3820_upd ON public.rent_buddy_bookings FOR UPDATE USING ((auth.uid() = traveler_id));\n${apply()}`);
    assert.equal(unknown.status, 0, `an unreachable client-write policy stopped the apply: ${unknown.stderr}`);
    assert.match(unknown.stderr, /no privilege reaches: .*rent_buddy_bookings\.zz_3820_upd/);

    // A view outside the nine is not 3820's to alter: it is named and refused,
    // and it is still an owner-rights view afterwards (the apply never ran).
    const foreign = inRolledBackTx(`CREATE VIEW public.zz_3820_door AS SELECT id, total_usd FROM public.rent_buddy_bookings;\n${apply()}`);
    assert.notEqual(foreign.status, 0, "3820 applied over a view it does not own the decision for");
    assert.match(foreign.stderr, /PRECONDITION FAILED \(3820\): view\(s\) public\.zz_3820_door reach/);
    // …and once that view runs with the caller's rights, 3820 applies and leaves it alone.
    const settled = inRolledBackTx(`CREATE VIEW public.zz_3820_door WITH (security_invoker = true) AS SELECT id, total_usd FROM public.rent_buddy_bookings;\n${apply()}`);
    assert.equal(settled.status, 0, settled.stderr);
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

  it("W9: apply, apply again, rollback — the prior state is restored exactly, from the baseline's grants, from 2490's and from the hosted state; without the record the rollback refuses", () => {
    const views = NINE_VIEWS.map((v) => `public.${v}`).join(", ");
    // 2490 cannot replay on PostgreSQL 16 (MAINTAIN), so its effect on these
    // relations is reproduced.
    const AFTER_2490 = `REVOKE TRUNCATE, REFERENCES, TRIGGER ON public.rent_buddy_bookings, public.rent_buddy_offers, ${views} FROM anon, authenticated;\n`;
    // The hosted databases, as read on 2026-10-04: 2490's grants, and the nine
    // views already security_invoker, granted to authenticated and not to anon.
    const HOSTED = `${AFTER_2490}REVOKE ALL ON ${views} FROM anon;\n${NINE_VIEWS.map((v) => `ALTER VIEW public.${v} SET (security_invoker = true);`).join("\n")}\n`;
    const RECORD = `SELECT 'INVOKER=' || (substring(obj_description('public.rent_buddy_bookings'::regclass, 'pg_class') FROM '<<3820-prior-state (\\{[^\\n]*\\}) 3820-prior-state>>')::jsonb -> 'invoker')::text;`;

    // What the applier writes after a successful apply; the rollback deletes it so that 3820 is applied again later.
    const LEDGER_ROW = `INSERT INTO public.schema_migration_ledger (filename, checksum, applied_by, notes) VALUES ('3820_rent_buddy_bookings_write_boundary.sql', 'w9', 'manual', 'W9') ON CONFLICT (filename) DO NOTHING;\n`;
    const LEDGER = `SELECT 'LEDGER=' || count(*) FROM public.schema_migration_ledger WHERE filename = '3820_rent_buddy_bookings_write_boundary.sql';`;

    for (const [posture, prepare, switched] of [
      ["the baseline's grants (full default set)", "", 9],
      ["2490's grants (TRUNCATE, REFERENCES, TRIGGER already gone)", AFTER_2490, 9],
      ["the hosted state (nine views already security_invoker, no anon grant on them)", HOSTED, 0],
      // Nothing for the rollback to hand back on the table: its closing block must still know that it RAN,
      // and not mistake an honest "there was no client INSERT before 3820 either" for a rollback that refused.
      ["a database whose client roles held no write on rent_buddy_bookings to begin with",
        "REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.rent_buddy_bookings FROM anon, authenticated;\n", 9],
    ] as const) {
      // The marker of the FIRST rollback (the one that re-opens the baseline for this property) is cleared,
      // as the rollback file itself clears it before its transaction: each run answers for itself.
      const out = inRolledBackTx(`${reopen()}SELECT set_config('pay_3820.rolled_back', 'no', false);\n${prepare}${SNAPSHOT}${apply()}${LEDGER_ROW}${SNAPSHOT}${RECORD}${apply()}${SNAPSHOT}${reopen()}${SNAPSHOT}${LEDGER}`);
      assert.equal(out.status, 0, `${posture}: ${out.stderr}`);
      const [before, applied, reapplied, restored] = [0, 1, 2, 3].map((n) => snapOf(out.stdout, n));
      assert.ok(before && applied && reapplied && restored, `${posture}: four snapshots expected, got ${out.stdout}`);
      assert.notEqual(applied, before, `${posture}: the snapshot does not see what 3820 changes, so equality below would prove nothing`);
      assert.equal(reapplied, applied, `${posture}: a second apply changed something`);
      assert.equal(restored, before, `${posture}: the rollback did not restore the state before 3820`);
      const invoker = JSON.parse(/^INVOKER=(.*)$/m.exec(out.stdout)?.[1] ?? "null") as unknown[];
      assert.equal(invoker.length, switched, `${posture}: 3820 recorded ${invoker.length} view(s) as switched, expected ${switched}`);
      assert.match(out.stdout, /^LEDGER=0$/m, `${posture}: the rollback left 3820's ledger row, so the applier would never apply it again`);
    }

    const twice = inRolledBackTx(`${reopen()}${reopen()}`);
    assert.notEqual(twice.status, 0, "a rollback with no 3820 record to restore from must refuse");
    assert.match(twice.stderr, /ROLLBACK REFUSED \(3820\): the comment on rent_buddy_bookings carries no 3820 record/);
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
      ["a view outside the nine reaches bookings with its owner's rights",
        "CREATE VIEW public.zz_3820_door AS SELECT id, total_usd FROM public.rent_buddy_bookings;", /PRECONDITION FAILED \(3820\): view\(s\) public\.zz_3820_door reach rent_buddy_bookings or rent_buddy_offers with their owner's rights/],
      ["such a view is stacked on one of the nine",
        "CREATE VIEW public.zz_3820_door2 AS SELECT * FROM public.buddy_bookings;", /PRECONDITION FAILED \(3820\): view\(s\) public\.zz_3820_door2 reach/],
      ["such a view lives in another schema and reaches offers",
        "CREATE SCHEMA zz_3820; CREATE VIEW zz_3820.door AS SELECT id, proposed_price_usd FROM public.rent_buddy_offers;", /PRECONDITION FAILED \(3820\): view\(s\) zz_3820\.door reach/],
      ["the applying role does not own a compatibility view it would have to switch",
        "ALTER VIEW public.buddy_profiles RESET (security_invoker); CREATE ROLE zz_3820_applier NOLOGIN; GRANT USAGE ON SCHEMA public TO zz_3820_applier; SET LOCAL ROLE zz_3820_applier;",
        /PRECONDITION FAILED \(3820\): zz_3820_applier cannot switch compatibility view\(s\) buddy_profiles/],
    ];
    for (const [what, prepare, expected] of cases) {
      const out = inRolledBackTx(`${prepare}\n${apply()}`);
      assert.notEqual(out.status, 0, `3820 applied although ${what}`);
      assert.match(out.stderr, expected, `${what}: ${out.stderr}`);
    }
  });

  it("W12: advisor-rewritten policies neither stop the apply nor trip its postcondition, and the rollback recreates the dropped policy as it was found", () => {
    // What a Supabase performance advisor makes of the baseline's three
    // policies: auth.*() wrapped in a scalar subquery, and a role list.
    const REWRITTEN = `
DROP POLICY rb_booking_traveler_ins ON public.rent_buddy_bookings;
CREATE POLICY rb_booking_traveler_ins ON public.rent_buddy_bookings FOR INSERT TO authenticated WITH CHECK (((SELECT auth.uid()) = traveler_id));
ALTER POLICY rb_booking_svc ON public.rent_buddy_bookings USING (((SELECT auth.role()) = 'service_role'));
`;
    const POLICY = `SELECT 'INS=' || COALESCE((SELECT polroles::regrole[]::text || ' ' || pg_get_expr(polwithcheck, polrelid) FROM pg_policy WHERE polrelid = 'public.rent_buddy_bookings'::regclass AND polname = 'rb_booking_traveler_ins'), '(none)');`;
    const out = inRolledBackTx(`${reopen()}${REWRITTEN}${SNAPSHOT}${POLICY}${apply()}${SNAPSHOT}${POLICY}${apply()}${SNAPSHOT}${reopen()}${SNAPSHOT}${POLICY}`);
    assert.equal(out.status, 0, `3820 does not apply and roll back over advisor-rewritten policies: ${out.stderr}`);
    const [before, applied, reapplied, restored] = [0, 1, 2, 3].map((n) => snapOf(out.stdout, n));
    assert.notEqual(applied, before);
    assert.equal(reapplied, applied, "a second apply changed something");
    assert.equal(restored, before, "the rollback did not restore the rewritten policy exactly: it must recreate what it FOUND, not the baseline's text");
    const ins = [...out.stdout.matchAll(/^INS=(.*)$/gm)].map((m) => m[1]);
    assert.equal(ins.length, 3);
    assert.match(ins[0]!, /^\{authenticated\} .*SELECT auth\.uid\(\)/, `the fixture is not the rewritten policy: ${ins[0]}`);
    assert.equal(ins[1], "(none)", "3820 did not drop the rewritten policy");
    assert.equal(ins[2], ins[0], "the rollback recreated a different policy from the one 3820 dropped");

    // And the boundary holds over that state: the traveller's insert is refused.
    assertRefused(inRolledBackTx(`${FIXTURES}${reopen()}${REWRITTEN}${apply()}${as("authenticated", T)}${CLIENT_INSERT(T, "rent_buddy_bookings")}`),
      "rent_buddy_bookings", "authenticated INSERT after 3820 over rewritten policies");

    // A database with NO traveller INSERT policy: recorded as none, and none is invented on the way back.
    const none = inRolledBackTx(`${reopen()}DROP POLICY rb_booking_traveler_ins ON public.rent_buddy_bookings;\n${SNAPSHOT}${apply()}${reopen()}${SNAPSHOT}${POLICY}`);
    assert.equal(none.status, 0, none.stderr);
    assert.equal(snapOf(none.stdout, 1), snapOf(none.stdout, 0));
    assert.match(none.stdout, /^INS=\(none\)$/m);
  });

  it("W13: the rollback's record survives a comment that was added to; a REPLACED comment makes the postcondition raise and the rollback refuse in both its blocks", () => {
    const COMMENT = `SELECT 'COMMENT=' || replace(COALESCE(obj_description('public.rent_buddy_bookings'::regclass, 'pg_class'), '(null)'), E'\\n', '|');`;
    const edit = (expr: string) => `DO $edit$ BEGIN EXECUTE format('COMMENT ON TABLE public.rent_buddy_bookings IS %L', ${expr}); END $edit$;\n`;
    const CURRENT = `obj_description('public.rent_buddy_bookings'::regclass, 'pg_class')`;

    for (const [what, change, left] of [
      ["text appended after the record", edit(`${CURRENT} || E'\\n\\nAdded later by another migration.'`), "Added later by another migration."],
      ["text put before 3820's lines", edit(`'An older note.' || E'\\n\\n' || ${CURRENT}`), "An older note."],
      ["text on both sides", edit(`'An older note.' || E'\\n\\n' || ${CURRENT} || E'\\n\\nAdded later.'`), "An older note.||Added later."],
      ["text appended to the record's own line", edit(`${CURRENT} || ' trailing words'`), " trailing words"],
    ] as const) {
      const post = inRolledBackTx(`${change}${postcondition()}`);
      assert.equal(post.status, 0, `${what}: 3820's postcondition no longer finds the record: ${post.stderr}`);
      // A re-apply finds the record too, and does not write a second one over the state AFTER 3820.
      const again = inRolledBackTx(`${change}${COMMENT}${apply()}${COMMENT}`);
      assert.equal(again.status, 0, `${what}: ${again.stderr}`);
      const seen = [...again.stdout.matchAll(/^COMMENT=(.*)$/gm)].map((m) => m[1]);
      assert.equal(seen[1], seen[0], `${what}: a re-apply rewrote the comment`);
      // The rollback restores from it, and takes out its own two lines only.
      const back = inRolledBackTx(`${change}${reopen()}${COMMENT}
SELECT 'INSERT_BACK=' || has_table_privilege('authenticated', 'public.rent_buddy_bookings', 'INSERT');`);
      assert.equal(back.status, 0, `${what}: the rollback could not read its record: ${back.stderr}`);
      assert.match(back.stdout, /INSERT_BACK=true/, `${what}: the rollback ran and restored nothing`);
      assert.equal(/^COMMENT=(.*)$/m.exec(back.stdout)?.[1], left, `${what}: the rollback did not leave exactly the text that was not 3820's`);
    }

    const NO_RECORD = /ROLLBACK REFUSED \(3820\): the comment on rent_buddy_bookings carries no 3820 record/;
    for (const [what, change, refusal] of [
      ["the comment was replaced", "COMMENT ON TABLE public.rent_buddy_bookings IS 'Bookings.';\n", NO_RECORD],
      ["the comment was removed", "COMMENT ON TABLE public.rent_buddy_bookings IS NULL;\n", NO_RECORD],
      ["3820's sentence is there and the record line is not", edit(`split_part(${CURRENT}, E'\\n<<3820-prior-state', 1)`), NO_RECORD],
      ["the record is no longer JSON", edit(`replace(${CURRENT}, '{"policy"', '{policy')`), /invalid input syntax for type json/],
      ["the record is JSON that is not 3820's", edit(`regexp_replace(${CURRENT}, '<<3820-prior-state [^\\n]* 3820-prior-state>>', '<<3820-prior-state {"policy": null} 3820-prior-state>>')`), NO_RECORD],
    ] as const) {
      const post = inRolledBackTx(`${change}${postcondition()}`);
      assert.notEqual(post.status, 0, `${what}: 3820's postcondition still passes with nothing to roll back from`);
      const refused = inRolledBackTx(`${change}${reopen()}`);
      assert.notEqual(refused.status, 0, `${what}: the rollback did not refuse`);
      assert.match(refused.stderr, refusal, `${what}: ${refused.stderr}`);
      // Run without ON_ERROR_STOP the refusal scrolls past and the file carries
      // on to its last block — which must fail too, not report success.
      const tail = inRolledBackTx(`${change}SET LOCAL pay_3820.rolled_back TO 'no';\n${parts(ROLLBACK).tail}`);
      assert.notEqual(tail.status, 0, `${what}: the rollback's closing block passed although the rollback never happened`);
      assert.match(tail.stderr, /ROLLBACK DID NOT HAPPEN \(3820\)/, `${what}: ${tail.stderr}`);
    }
  });
});
