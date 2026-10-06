/**
 * accountStateGateBridges — the account-state gate's ONE read, through each of
 * this directory's three database bridges, against real PostgreSQL.
 *
 * Run: LOCAL_DB_URL=postgresql://… node --import tsx/esm --test src/test/db/accountStateGateBridges.db.test.ts
 *      (or pnpm run test:db-local). Skips without a database, like every
 *      src/test/db suite; scripts/local-db/run-tests.sh refuses a skipped run.
 *
 * WHY THIS SUITE EXISTS
 * ---------------------
 * lib/accountStateGate.ts reads, on every authenticated request,
 *
 *   profiles?select=account_status,user_account_states!user_account_states_user_id_fkey(state,expires_at)
 *
 * and every database suite that drives a real route through `requireUser` issues
 * that select through one of three doubles: trailPostgrestBridge (the Trails and
 * trust suites), discoveryVerifyBridge (the Discovery verify chain) and
 * creatorLedgerPsqlClient (the creator-ledger routes). All three were written
 * for plain column lists and THREW on an embed. The gate read the throw as an
 * account state it could not read and answered 503 — correct for the gate — and
 * `api-server · kernel SQL executed on a throwaway database` went red on head
 * 9dd3aafc2 (trailsService.db.test.ts H1, H2, H4, H5: 503 where 200 / 404 was
 * expected). Nothing in this directory exercised the gate's read itself, so the
 * gap surfaced only as other suites' failures.
 *
 * The bridges now translate that embed against the REAL foreign key
 * (./postgrestEmbed.ts). This suite pins, per bridge, what the gate relies on:
 *
 *   B1  the row PostgREST would answer: the embed is an ARRAY of exactly the
 *       named columns, `[]` when the user has no rows, and no row at all is null.
 *   B2  resolveAccountRestriction over the bridge: no restriction; a ban (which
 *       outranks a suspension beside it); a suspension with its end; and a
 *       revoked ban / ended suspension that restrict nothing.
 *   B3  requireUser over the bridge: served, 403 `account_banned`, 403
 *       `account_suspended` — the token is the user id, as the bridges' auth
 *       shims have it.
 *   B4  a hint that names no foreign key between the two tables is PGRST200
 *       (HTTP 400), as PostgREST answers — so a renamed or dropped
 *       `user_account_states_user_id_fkey` FAILS the gate here (state
 *       unavailable) instead of being papered over by a double that guesses.
 *   B5  the hint is honoured, not ignored: the table's OTHER foreign key to
 *       profiles (`set_by`) embeds the rows a user SET, not the rows about them.
 *   B6  a plain select is answered exactly as before.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { HAVE_DB, exec, seedUser, deleteUser } from "./localDb.js";
import { makeTrailBridge } from "./trailPostgrestBridge.js";
import { bridge as discoveryVerifyBridge } from "./discoveryVerifyBridge.js";
import { creatorPsqlClient } from "./creatorLedgerPsqlClient.js";
import { resolveAccountRestriction, ACCOUNT_STATE_GATE_SELECT } from "../../lib/accountStateGate.js";
import { requireUser, _setTestClient, _clearTestClient } from "../../lib/http.js";

const skip = !HAVE_DB ? "LOCAL_DB_URL not set" : false;

/** As service_role (BYPASSRLS — the API's client), in one transaction. */
function svc(script: string): string[] {
  return exec(`SET LOCAL ROLE service_role;\n${script}`, { single: true });
}

function sink() {
  const out: { status: number | null; body: any } = { status: null, body: null };
  const res: any = { status(c: number) { out.status = c; return res; }, json(b: any) { out.body = b; return res; } };
  return { res, out };
}
const bearer = (token: string): any => ({ headers: { authorization: `Bearer ${token}` }, log: { error() {}, warn() {}, info() {} } });

describe("the account-state gate's read, through each database bridge", { skip }, () => {
  let clear = "";
  let banned = "";
  let suspended = "";
  let ended = "";
  let admin = "";
  const users = (): string[] => [clear, banned, suspended, ended, admin].filter(Boolean);

  before(() => {
    clear = seedUser("gate_clear");
    banned = seedUser("gate_banned");
    suspended = seedUser("gate_susp");
    ended = seedUser("gate_ended");
    admin = seedUser("gate_admin");
    svc(
      `INSERT INTO public.user_account_states (user_id, state, expires_at, set_by) VALUES
         ('${banned}', 'banned', NULL, '${admin}'),
         ('${banned}', 'suspended', now() + interval '1 hour', '${admin}'),
         ('${suspended}', 'suspended', now() + interval '2 hours', '${admin}'),
         ('${ended}', 'suspended', now() - interval '1 hour', '${admin}'),
         ('${ended}', 'banned', now() - interval '1 minute', '${admin}');`,
    );
  });
  after(() => {
    _clearTestClient();
    // The moderation rows first: set_by references the admin's profile with no cascade.
    const ids = users().map((id) => `'${id}'`).join(", ");
    if (ids) svc(`DELETE FROM public.user_account_states WHERE user_id IN (${ids}) OR set_by IN (${ids});`);
    for (const id of users()) { try { deleteUser(id); } catch { /* already gone */ } }
  });

  const tokens = (): Record<string, string> => Object.fromEntries(users().map((id) => [id, id]));
  const BRIDGES: Array<[string, () => any]> = [
    ["trailPostgrestBridge", () => makeTrailBridge().client],
    ["discoveryVerifyBridge", () => discoveryVerifyBridge({ flags: {}, tokens: tokens() }).client],
    ["creatorLedgerPsqlClient", () => creatorPsqlClient({ tokens: tokens() })],
  ];

  for (const [name, make] of BRIDGES) {
    describe(name, () => {
      it("B1 — the embed is an array of the named columns, [] for a user with no rows; no profile row is null", async () => {
        const c = make();
        const none = await c.from("profiles").select(ACCOUNT_STATE_GATE_SELECT).eq("id", clear).maybeSingle();
        assert.equal(none.error, null, JSON.stringify(none.error));
        assert.deepEqual(none.data, { account_status: "active", user_account_states: [] });

        const two = await c.from("profiles").select(ACCOUNT_STATE_GATE_SELECT).eq("id", banned).maybeSingle();
        assert.equal(two.error, null, JSON.stringify(two.error));
        assert.equal(two.data.account_status, "active", "a banned user's account_status is still 'active': its CHECK cannot hold 'banned'");
        assert.deepEqual(two.data.user_account_states.map((r: any) => r.state).sort(), ["banned", "suspended"]);
        for (const r of two.data.user_account_states) assert.deepEqual(Object.keys(r).sort(), ["expires_at", "state"]);

        const absent = await c.from("profiles").select(ACCOUNT_STATE_GATE_SELECT).eq("id", "00000000-0000-4000-8000-000000000000").maybeSingle();
        assert.equal(absent.error, null, JSON.stringify(absent.error));
        assert.equal(absent.data, null);
      });

      it("B2 — resolveAccountRestriction: none; banned over a suspension; suspended with its end; ended and revoked rows restrict nothing", async () => {
        const c = make();
        assert.deepEqual(await resolveAccountRestriction(c, clear), { state: "ok", accountStatus: "active", restriction: { kind: "none" } });
        assert.deepEqual(await resolveAccountRestriction(c, banned), { state: "ok", accountStatus: "active", restriction: { kind: "banned", until: null } });
        const s = await resolveAccountRestriction(c, suspended);
        assert.ok(s.state === "ok" && s.restriction.kind === "suspended", JSON.stringify(s));
        assert.ok(s.state === "ok" && s.restriction.kind === "suspended" && s.restriction.until !== null && Date.parse(s.restriction.until) > Date.now(), JSON.stringify(s));
        assert.deepEqual(await resolveAccountRestriction(c, ended), { state: "ok", accountStatus: "active", restriction: { kind: "none" } });
      });

      it("B3 — requireUser: an unrestricted and a formerly-restricted user are served; a ban and a suspension are 403 with their reason", async () => {
        _setTestClient(make(), true);
        try {
          for (const id of [clear, ended]) {
            const s = sink();
            const auth = await requireUser(bearer(id), s.res);
            assert.equal(auth?.user.id, id, `served: ${JSON.stringify(s.out)}`);
            assert.equal(s.out.status, null);
          }
          const b = sink();
          assert.equal(await requireUser(bearer(banned), b.res), null);
          assert.equal(b.out.status, 403);
          assert.equal(b.out.body.reason, "account_banned");
          const u = sink();
          assert.equal(await requireUser(bearer(suspended), u.res), null);
          assert.equal(u.out.status, 403);
          assert.equal(u.out.body.reason, "account_suspended");
          assert.equal(u.out.body.restriction.kind, "suspended");
        } finally {
          _clearTestClient();
        }
      });

      it("B4 — a hint that names no foreign key between the tables is PGRST200, and the gate reports it as an unreadable state", async () => {
        const c = make();
        const r = await c.from("profiles").select("account_status, user_account_states!user_account_states_no_such_fkey(state, expires_at)").eq("id", banned).maybeSingle();
        assert.equal(r.data, null);
        assert.equal(r.error?.code, "PGRST200", JSON.stringify(r.error));
        assert.match(String(r.error?.message), /Could not find a relationship between 'profiles' and 'user_account_states'/);
      });

      it("B5 — the hint is honoured: the set_by foreign key embeds the rows a user SET", async () => {
        const c = make();
        const set = await c.from("profiles").select("account_status, user_account_states!user_account_states_set_by_fkey(state)").eq("id", admin).maybeSingle();
        assert.equal(set.error, null, JSON.stringify(set.error));
        assert.equal(set.data.user_account_states.length, 5, "the admin set five rows and has none of their own");
        const own = await c.from("profiles").select(ACCOUNT_STATE_GATE_SELECT).eq("id", admin).maybeSingle();
        assert.deepEqual(own.data.user_account_states, []);
      });

      it("B6 — a plain select is answered as before", async () => {
        const c = make();
        const r = await c.from("profiles").select("id, account_status").eq("id", clear).maybeSingle();
        assert.equal(r.error, null, JSON.stringify(r.error));
        assert.deepEqual(r.data, { id: clear, account_status: "active" });
      });
    });
  }
});
