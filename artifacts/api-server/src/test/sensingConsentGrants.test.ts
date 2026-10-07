/**
 * OD-MAP-6 — three SEPARATE, revocable passive-sensing consents (migration
 * 3703; lib/sensingConsentGrants.ts; routes/sensingConsent.ts).
 *
 * "Separate consent for on-device capture, contribution upload, and each
 * secondary use. Make it revocable; don't bundle it with general app consent."
 *
 * What is pinned, as STATE (the rows the fake keeps), not return values:
 *   1. Each consent is OFF until granted; a withdrawal keeps the record and
 *      stamps withdrawn_at; a grant under older wording does not count.
 *   2. They are ordered in EFFECT (upload needs capture, surface needs upload)
 *      while each stays its own record — touching one never writes another.
 *   3. A grant records the version IN FORCE and is refused unless the client
 *      displayed exactly that version; the client never chooses what is stored.
 *   4. Granting needs the flag ON; WITHDRAWING never does. An unreadable flag
 *      or grants table is "try again", never a default.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *   node --import tsx/esm --test src/test/sensingConsentGrants.test.ts
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";

import sensingConsentRouter from "../routes/sensingConsent.js";
import { _setTestClient, _clearTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import {
  SENSING_CONSENT_DISCLOSURE_VERSIONS as V,
  effectiveSensingConsent,
  grantsFromRows,
  readSensingConsent,
  sessionScopesForGrants,
  setSensingConsent,
} from "../lib/sensingConsentGrants.js";
import { SENSING_ANON_POLICY_V1, type IntelligenceContributionPolicy } from "../lib/sensingContributionPolicy.js";

const USER = "6e6e6e6e-1111-4111-8111-111111111111";
const OTHER = "7f7f7f7f-2222-4222-8222-222222222222";
const TOKEN = "account-token";
const NOW = new Date("2026-10-06T12:00:00.000Z");

type Row = { user_id: string; scope: string; disclosure_version: string; granted_at: string; withdrawn_at: string | null; updated_at?: string };

/** A grants table that persists writes; `fail` makes one operation answer an error. */
function store(initial: Row[] = [], opts: { fail?: "select" | "upsert" | "update"; flag?: boolean | null | "error" } = {}) {
  const rows: Row[] = initial.map((r) => ({ ...r }));
  const writes: string[] = [];
  const flag = opts.flag === undefined ? true : opts.flag;
  const client: any = {
    rows,
    writes,
    auth: {
      getUser: async (t: string) => (t === TOKEN ? { data: { user: { id: USER } }, error: null } : { data: { user: null }, error: { message: "Invalid" } }),
    },
    from(table: string) {
      if (table === "profiles") {
        const q: any = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: { account_status: "active" }, error: null }) };
        return q;
      }
      if (table === "feature_flags") {
        const q: any = {
          select: () => q, eq: () => q,
          maybeSingle: async () => flag === "error"
            ? { data: null, error: { message: "unreadable", code: "XX000" } }
            : { data: flag === null ? null : { enabled: flag }, error: null },
        };
        return q;
      }
      assert.equal(table, "sensing_consent_grants", `unexpected table ${table}`);
      const filters: Array<(r: Row) => boolean> = [];
      let op: "select" | "update" = "select";
      let patch: Partial<Row> = {};
      const q: any = {
        select: () => q,
        eq: (c: keyof Row, v: unknown) => { filters.push((r) => r[c] === v); return q; },
        is: (c: keyof Row, v: unknown) => { filters.push((r) => (r[c] ?? null) === v); return q; },
        update: (p: Partial<Row>) => { op = "update"; patch = p; return q; },
        upsert: async (row: Row) => {
          if (opts.fail === "upsert") return { data: null, error: { message: "denied", code: "42501" } };
          writes.push(`upsert:${row.scope}`);
          const i = rows.findIndex((r) => r.user_id === row.user_id && r.scope === row.scope);
          if (i >= 0) rows[i] = { ...rows[i], ...row }; else rows.push({ ...row });
          return { data: null, error: null };
        },
        then(ok: any, bad: any) {
          return Promise.resolve().then(() => {
            if (op === "update") {
              if (opts.fail === "update") return { data: null, error: { message: "denied", code: "42501" } };
              for (const r of rows) if (filters.every((f) => f(r))) { Object.assign(r, patch); writes.push(`update:${r.scope}`); }
              return { data: null, error: null };
            }
            if (opts.fail === "select") return { data: null, error: { message: "unreadable", code: "XX000" } };
            return { data: rows.filter((r) => filters.every((f) => f(r))), error: null };
          }).then(ok, bad);
        },
      };
      return q;
    },
  };
  return client;
}

const G = (scope: string, over: Partial<Row> = {}): Row => ({
  user_id: USER, scope, disclosure_version: (V as Record<string, string>)[scope]!, granted_at: "2026-10-05T00:00:00.000Z", withdrawn_at: null, ...over,
});

// ── 1-2. The grants and what they permit ─────────────────────────────────────

describe("OD-MAP-6 — three separate consents, each off until granted", () => {
  it("no rows: all three OFF; a withdrawn grant is off but keeps its record; older wording does not count", () => {
    const none = grantsFromRows([]);
    for (const s of ["capture", "upload", "surface"] as const) assert.equal(none[s].granted, false);
    const g = grantsFromRows([
      G("capture"),
      G("upload", { withdrawn_at: "2026-10-05T01:00:00.000Z" }),
      G("surface", { disclosure_version: "sensing_surface_v0" }),
    ]);
    assert.equal(g.capture.granted && g.capture.current, true);
    assert.equal(g.upload.granted, false);
    assert.equal(g.upload.grantedAt, "2026-10-05T00:00:00.000Z", "a withdrawal keeps what was agreed");
    assert.equal(g.surface.granted, true);
    assert.equal(g.surface.current, false, "a grant under older words is not a grant of the current ones");
  });

  it("ordered in EFFECT: upload counts only with capture; surface only with upload", () => {
    assert.deepEqual(effectiveSensingConsent(grantsFromRows([G("upload"), G("surface")])), { capture: false, upload: false, surface: false });
    assert.deepEqual(effectiveSensingConsent(grantsFromRows([G("capture"), G("surface")])), { capture: true, upload: false, surface: false });
    assert.deepEqual(effectiveSensingConsent(grantsFromRows([G("capture"), G("upload"), G("surface")])), { capture: true, upload: true, surface: true });
  });

  it("session scopes: capture+upload give collect/retain/aggregate; surface only with its grant AND a policy that grants it", () => {
    const granting: IntelligenceContributionPolicy = { ...SENSING_ANON_POLICY_V1, purposeScopes: ["collect", "retain", "aggregate", "surface"] };
    const all = grantsFromRows([G("capture"), G("upload"), G("surface")]);
    assert.deepEqual(sessionScopesForGrants(all, SENSING_ANON_POLICY_V1), { covered: true, scopes: ["collect", "retain", "aggregate"] });
    assert.deepEqual(sessionScopesForGrants(all, granting), { covered: true, scopes: ["collect", "retain", "aggregate", "surface"] });
    assert.deepEqual(sessionScopesForGrants(grantsFromRows([G("capture"), G("upload")]), granting), { covered: true, scopes: ["collect", "retain", "aggregate"] });
    assert.deepEqual(sessionScopesForGrants(grantsFromRows([G("capture")]), granting), { covered: false, reason: "upload_not_granted" });
    assert.deepEqual(sessionScopesForGrants(grantsFromRows([]), granting), { covered: false, reason: "capture_not_granted" });
  });

  it("an unreadable grants table is a failure, never 'everything off'", async () => {
    assert.deepEqual(await readSensingConsent(store([], { fail: "select" }), USER), { ok: false, reason: "db_error" });
    assert.deepEqual(await readSensingConsent(null, USER), { ok: false, reason: "no_client" });
  });
});

// ── 3. Setting one consent ───────────────────────────────────────────────────

describe("OD-MAP-6 — granting and withdrawing one consent touches that one only", () => {
  it("a grant stores the version IN FORCE, and only when the client displayed exactly it", async () => {
    const s = store();
    assert.deepEqual(await setSensingConsent(s, USER, "upload", true, "sensing_upload_v0", NOW), { ok: false, reason: "disclosure_version_mismatch" });
    assert.deepEqual(await setSensingConsent(s, USER, "upload", true, undefined, NOW), { ok: false, reason: "disclosure_version_mismatch" });
    assert.deepEqual(s.writes, [], "a refused grant writes nothing");
    const r = await setSensingConsent(s, USER, "upload", true, V.upload, NOW);
    assert.equal(r.ok, true);
    assert.deepEqual(s.rows, [{ user_id: USER, scope: "upload", disclosure_version: V.upload, granted_at: NOW.toISOString(), withdrawn_at: null, updated_at: NOW.toISOString() }]);
  });

  it("a withdrawal stamps withdrawn_at on THAT consent, keeps its record, and never touches the other two or another person", async () => {
    const s = store([G("capture"), G("upload"), G("surface"), { ...G("upload"), user_id: OTHER }]);
    const r = await setSensingConsent(s, USER, "upload", false, undefined, NOW);
    assert.equal(r.ok, true);
    const mine = (scope: string) => s.rows.find((x: Row) => x.user_id === USER && x.scope === scope);
    assert.equal(mine("upload").withdrawn_at, NOW.toISOString());
    assert.equal(mine("upload").disclosure_version, V.upload, "the record of what was agreed stays");
    assert.equal(mine("capture").withdrawn_at, null);
    assert.equal(mine("surface").withdrawn_at, null);
    assert.equal(s.rows.find((x: Row) => x.user_id === OTHER).withdrawn_at, null);
    assert.deepEqual(s.writes, ["update:upload"]);
    // Withdrawn: upload no longer counts, so neither does surface — while surface's own record is untouched.
    assert.ok(r.ok && r.grants);
    if (r.ok && r.grants) assert.deepEqual(effectiveSensingConsent(r.grants), { capture: true, upload: false, surface: false });
  });

  it("a failed write is db_error; a failed READ-BACK after a landed write is ok without a state, never a default", async () => {
    assert.deepEqual(await setSensingConsent(store([], { fail: "upsert" }), USER, "capture", true, V.capture, NOW), { ok: false, reason: "db_error" });
    assert.deepEqual(await setSensingConsent(store([G("capture")], { fail: "update" }), USER, "capture", false, undefined, NOW), { ok: false, reason: "db_error" });
    const s = store([], { fail: "select" });
    assert.deepEqual(await setSensingConsent(s, USER, "capture", true, V.capture, NOW), { ok: true });
    assert.equal(s.rows.length, 1, "the grant itself landed");
  });
});

// ── 4. The routes ────────────────────────────────────────────────────────────

/** The route's own body shape (routes/sensingConsent.ts sensingConsentBody). */
interface ConsentBody {
  available: boolean;
  consents: Array<{ scope: string; granted: boolean; current: boolean; effective: boolean; disclosureVersion: string | null; currentVersion: string }>;
}

async function call(client: any, method: "GET" | "PUT", path: string, body?: unknown, token: string | null = TOKEN): Promise<{ status: number; body: ConsentBody }> {
  _setTestClient(client, true);
  _setTestServiceClient(client);
  const a = express();
  a.use(express.json());
  a.use("/api", sensingConsentRouter);
  const server = createServer(a);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port as number;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api${path}`, {
      method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as ConsentBody };
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

afterEach(() => { _clearTestClient(); _setTestServiceClient(null); });

describe("GET/PUT /v1/sensing/consent — the person's own three switches", () => {
  it("GET: each consent with its state, effect and the version in force; `available` follows the flag", async () => {
    const on = await call(store([G("capture")]), "GET", "/v1/sensing/consent");
    assert.equal(on.status, 200);
    assert.equal(on.body.available, true);
    assert.deepEqual(on.body.consents.map((c) => [c.scope, c.granted, c.effective, c.currentVersion]), [
      ["capture", true, true, V.capture], ["upload", false, false, V.upload], ["surface", false, false, V.surface],
    ]);
    const off = await call(store([], { flag: false }), "GET", "/v1/sensing/consent");
    assert.equal(off.body.available, false);
  });

  it("GET: an unreadable flag or grants table is 503 'try again' — never a page of switches all off", async () => {
    assert.equal((await call(store([], { flag: "error" }), "GET", "/v1/sensing/consent")).status, 503);
    assert.equal((await call(store([], { fail: "select" }), "GET", "/v1/sensing/consent")).status, 503);
    assert.equal((await call(store(), "GET", "/v1/sensing/consent", undefined, null)).status, 401);
  });

  it("PUT grant needs the flag ON — off or absent refuses with no write; unreadable is 503", async () => {
    for (const flag of [false, null] as const) {
      const s = store([], { flag });
      const r = await call(s, "PUT", "/v1/sensing/consent/capture", { granted: true, displayedVersion: V.capture });
      assert.equal(r.status, 404, `flag=${flag}`);
      assert.deepEqual(s.writes, []);
    }
    const s = store([], { flag: "error" });
    assert.equal((await call(s, "PUT", "/v1/sensing/consent/capture", { granted: true, displayedVersion: V.capture })).status, 503);
    assert.deepEqual(s.writes, []);
  });

  it("PUT WITHDRAW is always accepted — flag off, absent or unreadable — and lands", async () => {
    for (const flag of [false, null, "error"] as const) {
      const s = store([G("upload")], { flag });
      const r = await call(s, "PUT", "/v1/sensing/consent/upload", { granted: false });
      assert.equal(r.status, 200, `flag=${flag}`);
      assert.notEqual(s.rows[0].withdrawn_at, null, `flag=${flag}: revocable means revocable`);
    }
  });

  it("PUT grant with the flag on stores the version in force; a stale displayed version is 409; an unknown consent is 400", async () => {
    const s = store();
    const ok = await call(s, "PUT", "/v1/sensing/consent/surface", { granted: true, displayedVersion: V.surface });
    assert.equal(ok.status, 200);
    assert.equal(s.rows[0].disclosure_version, V.surface);
    assert.equal(ok.body.consents.find((c) => c.scope === "surface")?.granted, true);
    assert.equal(ok.body.consents.find((c) => c.scope === "surface")?.effective, false, "surface has no effect without capture and upload");
    const stale = await call(store(), "PUT", "/v1/sensing/consent/capture", { granted: true, displayedVersion: "sensing_capture_v0" });
    assert.equal(stale.status, 409);
    assert.equal((await call(store(), "PUT", "/v1/sensing/consent/everything", { granted: true })).status, 400);
    assert.equal((await call(store(), "PUT", "/v1/sensing/consent/capture", { granted: "yes" })).status, 400);
  });
});
