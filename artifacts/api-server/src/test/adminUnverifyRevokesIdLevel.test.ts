/**
 * REVOKING A VERIFICATION MUST REVOKE THE SIGNAL THE GATES READ.
 *
 * ── THE OBLIGATION ──────────────────────────────────────────────────────────
 * verified-foundation-plan.md V-4: "`verification_revoked` action clears
 * `profiles.verification_level`." Trust architecture upgrade v2 TRV2-10 states
 * the consequence side: "Verification revocation reaches displays/eligibility."
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 * `POST /admin/users/:userId/unverify` is the platform's revoke action. It
 * cleared `verified`, `verification_status` and `verified_at` — the exact
 * inverse of what `/verify` sets — and left `verification_level` untouched.
 *
 * That column is not decorative and it is not a duplicate of the other three.
 * It has exactly ONE writer in the whole server, `routes/verification.ts:71`
 * (`applyVerifiedProfile`, the provider ID-check success path), and
 * `lib/travelerVerification.ts:85-88` reads `verification_level !== 'none'` as
 * a SUFFICIENT id-verified signal, ORed with the other two rather than ANDed:
 *
 *     const idVerified =
 *       (typeof row["verification_level"] === "string" && row["verification_level"] !== "none")
 *       || row["verification_status"] === "verified"
 *       || Boolean(row["id_verified_at"]);
 *
 * So clearing two of the three disjuncts revokes nothing. An admin who
 * unverified a user — the action an operator takes after a fraudulent or
 * disputed ID — still left them passing every gate that calls
 * `loadTravelerIdentity`, including `routes/rentABuddyRollout.ts`'s MVP-mode
 * booking gate. Rent-a-Buddy pairs strangers in person.
 *
 * Nothing else in the server can clear it: a grep for writes of
 * `profiles.verification_level` returns exactly one site, and it only ever sets
 * a verified level. Before this fix there was no code path in the product that
 * could take an ID-verified standing away.
 *
 * ── WHAT THIS FILE DOES NOT CLAIM ───────────────────────────────────────────
 * It does not add a new `verification_revoked` action type; `unverify` already
 * IS the revoke action and already writes its `moderation_actions` audit row
 * (asserted below, because a revocation that is not audited is its own defect).
 * Whether revocation should also reverse derived trust effects is the open
 * reversal/retention policy, recorded as CANNOT-VERIFY in
 * docs/architecture/census-trust.md §12.7 — not decided here.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/adminUnverifyRevokesIdLevel.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import adminRouter from "../routes/admin.js";
import { travelerIdentityFromProfile } from "../lib/travelerVerification.js";

const TARGET = "aaaaaaaa-0000-4000-a000-000000000901";
const ADMIN = "bbbbbbbb-0000-4000-a000-000000000902";

let server: http.Server;
let base: string;

/** Patches sent to `profiles.update(...)`, in order. */
let profilePatches: Record<string, unknown>[] = [];
/** Rows inserted into `moderation_actions`. */
let auditInserts: Record<string, unknown>[] = [];

function makeClient() {
  function builder(table: string, rows: any[]) {
    let _rows = [...rows];
    const eq: Record<string, unknown> = {};
    const b: any = {
      select: () => b,
      insert: (data: any) => {
        if (table === "moderation_actions") auditInserts.push(data);
        _rows = Array.isArray(data) ? data : [data];
        return b;
      },
      update: (data: any) => {
        if (table === "profiles") profilePatches.push(data);
        _rows = _rows.map((r: any) => ({ ...r, ...data }));
        return b;
      },
      upsert: (data: any) => { _rows = Array.isArray(data) ? data : [data]; return b; },
      delete: () => { _rows = []; return b; },
      eq: (c: string, v: unknown) => { eq[c] = v; return b; },
      neq: () => b, is: () => b, not: () => b, in: () => b, or: () => b,
      gt: () => b, ilike: () => b, order: () => b, limit: () => b, range: () => b,
      then: (resolve: any) => {
        let out = [..._rows];
        for (const [c, v] of Object.entries(eq)) out = out.filter((r: any) => r[c] === v);
        return Promise.resolve({ data: out, error: null, count: out.length }).then(resolve);
      },
      maybeSingle: () => Promise.resolve({ data: _rows[0] ?? null, error: null }),
      single: () => Promise.resolve({ data: { ..._rows[0], id: "audit-1" }, error: null }),
    };
    return b;
  }

  return {
    from: (table: string) => {
      if (table === "profiles") {
        return builder(table, [
          { id: ADMIN, role: "admin" },
          {
            id: TARGET,
            role: "user",
            verified: true,
            verification_status: "verified",
            verified_at: "2026-09-01T00:00:00.000Z",
            // What routes/verification.ts writes on a successful provider check.
            verification_level: "id_selfie_verified",
          },
        ]);
      }
      return builder(table, []);
    },
    auth: { getUser: () => Promise.resolve({ data: { user: { id: ADMIN } }, error: null }) },
  } as any;
}

function post(path: string, body: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = JSON.stringify(body);
    const r = http.request(
      {
        hostname: url.hostname, port: Number(url.port), path: url.pathname, method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer fake.jwt.token" },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let parsed: any;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    r.on("error", reject);
    r.write(payload);
    r.end();
  });
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((r: any, _res: any, next: any) => {
    r.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    next();
  });
  app.use(adminRouter);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});

after(() => server.close());

describe("admin unverify revokes the ID-verified signal the gates read", () => {
  it("PROOF OF PREMISE: verification_level alone is sufficient for idVerified", () => {
    // If this ever stops being true, the assertions below stop meaning what they say.
    const onlyLevel = travelerIdentityFromProfile({
      verification_level: "id_selfie_verified",
      verification_status: "unverified",
      verified: false,
      id_verified_at: null,
    });
    assert.equal(
      onlyLevel.idVerified,
      true,
      "travelerVerification ORs the three signals; a stale verification_level alone passes the gate",
    );
  });

  it("unverify clears verification_level, not just the other three columns", async () => {
    profilePatches = [];
    auditInserts = [];
    const c = makeClient();
    _setTestClient(c, true);
    _setTestServiceClient(c);

    const res = await post(`/admin/users/${TARGET}/unverify`, { reason: "disputed document" });
    assert.equal(res.status, 200, `unverify should succeed; got ${res.status} ${JSON.stringify(res.body)}`);

    const patch = profilePatches.at(-1);
    assert.ok(patch, "unverify must write a profiles patch");
    assert.equal(
      patch["verification_level"],
      "none",
      "an admin revoking a verification must clear the one column routes/verification.ts sets — " +
        "otherwise the Rent-a-Buddy booking gate still reads the user as ID-verified",
    );
  });

  it("the revoked profile no longer passes the traveler ID gate", async () => {
    profilePatches = [];
    const c = makeClient();
    _setTestClient(c, true);
    _setTestServiceClient(c);

    await post(`/admin/users/${TARGET}/unverify`, { reason: "disputed document" });

    // Apply the patch the route actually sent to the row it actually had, and
    // ask the real gate. This is the OUTCOME, not the column list.
    const after = {
      verification_level: "id_selfie_verified",
      verification_status: "verified",
      verified: true,
      id_verified_at: null,
      ...profilePatches.at(-1),
    };
    assert.equal(
      travelerIdentityFromProfile(after).idVerified,
      false,
      "after revocation lib/travelerVerification must answer 'not ID verified'",
    );
  });

  it("the revocation is still audited — a revoke with no moderation_actions row is its own defect", async () => {
    profilePatches = [];
    auditInserts = [];
    const c = makeClient();
    _setTestClient(c, true);
    _setTestServiceClient(c);

    await post(`/admin/users/${TARGET}/unverify`, { reason: "disputed document" });

    assert.equal(auditInserts.length, 1, "exactly one moderation_actions row");
    assert.equal(auditInserts[0]!["action_type"], "unverify");
    assert.equal(auditInserts[0]!["target_user_id"], TARGET);
    assert.equal(auditInserts[0]!["performed_by"], ADMIN);
    assert.equal(auditInserts[0]!["reason"], "disputed document");
  });

  it("CONTROL: the three columns unverify already cleared are still cleared", async () => {
    profilePatches = [];
    const c = makeClient();
    _setTestClient(c, true);
    _setTestServiceClient(c);

    await post(`/admin/users/${TARGET}/unverify`, { reason: "disputed document" });

    const patch = profilePatches.at(-1)!;
    assert.equal(patch["verified"], false);
    assert.equal(patch["verification_status"], "unverified");
    assert.equal(patch["verified_at"], null);
  });
});
