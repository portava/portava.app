/**
 * POST /me/requests/circle_invite/:id/accept — an unreadable age limit is not
 * "no age limit".
 *
 * This is the WRITE side of the read fixed in routes/circleAgeSettings.ts
 * (commit 04dcbde5), and it carried the same defect in a worse place: rather
 * than reporting a permissive answer, it ACTED on one — joining someone to
 * another user's trusted circle.
 *
 *   `if (serviceClient)` with no else  the whole age gate was skipped when the
 *                                      client was absent, and the invite was
 *                                      accepted. Silently.
 *   unbound `.error`                   supabase-js RESOLVES on a database
 *                                      error, so an unreadable
 *                                      `circle_age_settings` bound data:null,
 *                                      fell through `?.age_limit_enabled` and
 *                                      accepted the invite the same way.
 *
 * WHAT MAKES THESE ASSERTIONS MEAN SOMETHING
 * ------------------------------------------
 *   - The status code is asserted EXACTLY (503 + `degraded_unavailable`), never
 *     `!== 200`. A route that crashes returns 500, and "not 200" would accept
 *     that as fail-closed.
 *   - `req.log` IS shimmed. Without it the new guards throw on `req.log.error`
 *     and the 500-from-crash impersonates a refusal.
 *   - Every outage case is paired with the readable case it must be
 *     distinguishable from: the absent row that genuinely means "no limit", and
 *     a present row that genuinely blocks. The outage and the absent row used
 *     to produce the identical 200.
 *
 * NOT TESTED, and deliberately not implied: the `!serviceClient` branch.
 * `getServiceClient()` answers from the environment, so `_setTestServiceClient(null)`
 * does not yield a null client — the route would get a real client pointed at an
 * unreachable host and pass off the read-error branch instead, which is a
 * false green. That branch is verified by inspection only. Same finding as
 * commit 04dcbde5.
 *
 * Runtime: node:test. The verdict is the exit code.
 * Run: node --import tsx/esm --test src/test/circleInviteAgeOutage.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";

const INVITE_ID = "00000000-0000-0000-0000-0000000000a9";
const OWNER_ID = "circle-owner-id";
const INVITEE = "invitee-user";

/** A real PostgREST-shaped failure, resolved (never thrown) as supabase-js does. */
const DB_ERROR = { code: "XX000", message: "internal error: relation unavailable" };

type Row = Record<string, unknown>;

function makeFakeClient(o: {
  invite?: Row | null;
  circleAgeSettings?: Row | null;
  profile?: Row | null;
  /**
   * Reads that resolve with an error instead of data. A key is either a table
   * name, or `table:column` to fail ONLY the read whose projection names that
   * column.
   *
   * The projection form is not decoration. `requireUser` reads
   * `profiles.account_status` on EVERY authenticated request and refuses with
   * the same 503 `degraded_unavailable` when it fails (lib/http.ts), so failing
   * the whole `profiles` table means the request never reaches this route at
   * all — and a test asserting 503 passes without the guard under test existing.
   * That is exactly what happened to the first draft of this file, and the
   * hand-revert is what exposed it. Keying on `date_of_birth` fails only the
   * route's own read.
   */
  errors?: Record<string, { code: string; message: string }>;
}) {
  const errors = o.errors ?? {};

  const builder = (table: string, data: Row | null): any => {
    let projection = "";
    const errFor = (): { code: string; message: string } | null =>
      errors[`${table}:${projection.replace(/\s/g, "")}`] ??
      Object.entries(errors).find(([k]) => {
        const [t, col] = k.split(":");
        return t === table && (col === undefined || projection.includes(col));
      })?.[1] ??
      null;
    const b: any = {
      select: (cols?: string) => { projection = cols ?? ""; return b; },
      insert: () => b, update: () => b, upsert: () => b,
      eq: () => b, in: () => b, or: () => b, order: () => b, limit: () => b,
      maybeSingle: () => { const e = errFor(); return Promise.resolve(e ? { data: null, error: e } : { data, error: null }); },
      single: () => { const e = errFor(); return Promise.resolve(e ? { data: null, error: e } : { data, error: null }); },
      then: (resolve: (v: any) => any) => {
        const e = errFor();
        return Promise.resolve(e ? { data: null, error: e } : { data: data ? [data] : [], error: null }).then(resolve);
      },
    };
    return b;
  };

  const forTable: Record<string, Row | null> = {
    circle_invites: o.invite ?? null,
    circle_age_settings: o.circleAgeSettings ?? null,
    profiles: o.profile ?? null,
    age_limit_audit_log: null,
    circle_memberships: { id: "cm-1" },
  };

  return {
    auth: {
      getUser: async () => ({ data: { user: { id: INVITEE } }, error: null }),
    },
    from: (table: string) => builder(table, forTable[table] ?? null),
  };
}

let server: http.Server;
let baseUrl: string;

before(async () => {
  const app = express();
  app.use(express.json());
  // REQUIRED. The guards under test log before refusing; without this shim they
  // throw and a 500-from-crash would masquerade as a fail-closed 503.
  app.use((req: any, _res, next) => {
    req.log = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };
    next();
  });
  const { default: requestsRouter } = await import("../routes/requests.js");
  app.use(requestsRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", () => resolve()); });
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => { server.close(); });

function acceptInvite(): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = "{}";
    const req = http.request(
      `${baseUrl}/me/requests/circle_invite/${INVITE_ID}/accept`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload).toString(),
          authorization: "Bearer test-token",
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => { raw += c; });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw || "{}") }));
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

const pendingInvite: Row = {
  id: INVITE_ID, owner_id: OWNER_ID, recipient_id: INVITEE, status: "pending",
};
const enabledAgeSettings: Row = {
  owner_id: OWNER_ID, age_limit_enabled: true, min_age: 21, max_age: null,
};

/** A DOB comfortably over the 21 limit above. */
const eligibleDob = (() => {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 30);
  return d.toISOString().slice(0, 10);
})();

let cases = 0;
async function run(o: Parameters<typeof makeFakeClient>[0]) {
  _setTestClient(makeFakeClient(o), true);
  cases++;
  return acceptInvite();
}

describe("circle_age_settings unreadable", () => {
  it("refuses with 503 degraded_unavailable — does NOT accept the invite", async () => {
    const r = await run({
      invite: pendingInvite,
      profile: { id: INVITEE, date_of_birth: null },
      errors: { circle_age_settings: DB_ERROR },
    });
    assert.equal(r.status, 503, `expected 503, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, "degraded_unavailable", JSON.stringify(r.body));
  });

  it("PAIR — readable and ABSENT → the owner set no limit, invite is ACCEPTED (200)", async () => {
    // This is the case the outage above used to be indistinguishable from.
    const r = await run({
      invite: pendingInvite,
      circleAgeSettings: null,
      profile: { id: INVITEE, date_of_birth: null },
    });
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.status, "accepted");
  });

  it("PAIR — readable, limit ENABLED, invitee eligible → ACCEPTED (200)", async () => {
    const r = await run({
      invite: pendingInvite,
      circleAgeSettings: enabledAgeSettings,
      profile: { id: INVITEE, date_of_birth: eligibleDob },
    });
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.status, "accepted");
  });

  it("PAIR — readable, limit ENABLED, invitee ineligible → 403 age_not_eligible", async () => {
    // Proves the 503 above is not simply "this route refuses everything".
    const r = await run({
      invite: pendingInvite,
      circleAgeSettings: enabledAgeSettings,
      profile: { id: INVITEE, date_of_birth: null },
    });
    assert.equal(r.status, 403, `expected 403, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, "age_not_eligible");
  });
});

describe("profiles unreadable while an age limit is in force", () => {
  it("refuses with 503 — not a 403 claiming the invitee has no date of birth", async () => {
    // The direction was already fail-closed (a null DOB is ineligible), but the
    // 403 asserted a FACT about the acceptor's profile from a read of it that
    // failed. The refusal is now honest and retryable.
    const r = await run({
      invite: pendingInvite,
      circleAgeSettings: enabledAgeSettings,
      // Only the route's own read of the acceptor's DOB fails. `requireUser`'s
      // `profiles.account_status` read still succeeds, so the request reaches
      // the guard under test instead of being refused upstream.
      errors: { "profiles:date_of_birth": DB_ERROR },
    });
    assert.equal(r.status, 503, `expected 503, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, "degraded_unavailable", JSON.stringify(r.body));
  });
});

describe("vacuity", () => {
  it("every case above actually issued a request", () => {
    assert.ok(cases >= 5, `expected >= 5 accept attempts, got ${cases}`);
  });
});
