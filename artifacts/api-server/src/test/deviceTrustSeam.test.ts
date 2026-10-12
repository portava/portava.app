/**
 * OD-1012-DEV-1 (census-telegraph T399): "Devices default to unverified. Only
 * server-validated evidence may promote `trust_state`; never accept a client's
 * self-declaration as proof."
 *
 * SCAFFOLDING ONLY. Which evidence / provider promotes a device is an OPEN owner
 * decision; no verifier is registered in this tree, so no device can become
 * verified. These tests pin:
 *
 *   1. the seam (lib/deviceTrust.ts promoteDeviceTrust) refuses without a
 *      registered verifier, refuses evidence it did not mint (a client-shaped
 *      object), refuses without an audit record, and writes only the constant;
 *   2. revocation that keeps the registry row for a retry demotes it;
 *   3. STATIC: no other file writes trust_state (TS/JS/SQL), every `devices`
 *      write is a literal-keyed object with no spread and no request value, and
 *      nothing outside tests registers a verifier or an audit sink.
 *
 * Run: node --import tsx/esm --test src/test/deviceTrustSeam.test.ts
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEVICE_EVIDENCE_MAX_AGE_MS,
  _resetDeviceTrustRegistry,
  collectDeviceEvidence,
  demoteDeviceTrust,
  promoteDeviceTrust,
  registerDeviceEvidenceVerifier,
  registerDeviceTrustAuditSink,
  registeredDeviceVerifierIds,
  type DeviceEvidenceVerifier,
  type ServerValidatedDeviceEvidence,
} from "../lib/deviceTrust.js";
import { revokeDevice } from "../lib/deviceRevocation.js";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "99999999-9999-4999-8999-999999999999";
const DEV = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const DEV2 = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const NOW = 1_800_000_000_000;

// ── a recording PostgREST double ──────────────────────────────────────────────

type Row = Record<string, any>;
interface Write { table: string; op: string; patch: Row | null; filters: Array<[string, unknown]> }

function makeDb(rows: Row[], opts: { failUpdate?: { message: string; code?: string } | null; failAdmin?: boolean } = {}) {
  const writes: Write[] = [];
  const tables: Record<string, Row[]> = { devices: rows, notification_devices: [], push_retry_queue: [] };
  const sc: any = {
    auth: {
      admin: {
        getUserById: async (id: string) => ({ data: { user: { id, app_metadata: {} } }, error: null }),
        updateUserById: async () => (opts.failAdmin ? { data: null, error: { message: "down" } } : { data: {}, error: null }),
        signOut: async () => ({ data: null, error: { message: "down" } }),
      },
    },
    from(table: string) {
      let op = "select";
      let patch: Row | null = null;
      let returning = false;
      const filters: Array<[string, unknown]> = [];
      const run = () => {
        const t = (tables[table] ??= []);
        const hit = t.filter((r) => filters.every(([c, v]) => r[c] === v));
        if (op === "select") return { data: hit.map((r) => ({ ...r })), error: null };
        writes.push({ table, op, patch, filters: [...filters] });
        if (op === "update") {
          if (table === "devices" && opts.failUpdate) return { data: null, error: opts.failUpdate };
          for (const r of hit) Object.assign(r, patch);
          return { data: returning ? hit.map((r) => ({ ...r })) : null, error: null };
        }
        if (op === "delete") {
          tables[table] = t.filter((r) => !hit.includes(r));
          return { data: returning ? hit.map((r) => ({ ...r })) : [], error: null };
        }
        return { data: null, error: null };
      };
      const chain: any = {
        select: () => { if (op !== "select") returning = true; return chain; },
        eq: (c: string, v: unknown) => { filters.push([c, v]); return chain; },
        update: (p: Row) => { op = "update"; patch = p; return chain; },
        delete: () => { op = "delete"; return chain; },
        maybeSingle: async () => { const r = run(); return r.error ? r : { data: (r.data as Row[])[0] ?? null, error: null }; },
        then: (f: any, rej: any) => Promise.resolve(run()).then(f, rej),
      };
      return chain;
    },
  };
  return { sc, writes, tables };
}

const okVerifier = (id = "test-attest", kind = "test_attestation"): DeviceEvidenceVerifier & { calls: number } => {
  const v = { id, kind, calls: 0, async verify() { v.calls++; return { ok: true as const }; } };
  return v;
};
const okAudit = () => {
  const entries: Row[] = [];
  return { entries, sink: { async record(e: Row) { entries.push(e); return true; } } };
};
const trustWrites = (w: Write[]) => w.filter((x) => x.table === "devices" && x.patch && "trust_state" in x.patch);

beforeEach(() => _resetDeviceTrustRegistry());

// ── 1. the seam ───────────────────────────────────────────────────────────────

describe("promoteDeviceTrust — fail closed until the owner names an evidence source", () => {
  it("NOTHING is registered in this tree: promotion of any device is refused and nothing is written", async () => {
    assert.deepEqual(registeredDeviceVerifierIds(), []);
    const { sc, writes, tables } = makeDb([{ id: DEV, user_id: USER, trust_state: "unverified" }]);
    const forged = { verifierId: "x", kind: "x", userId: USER, deviceId: DEV, verifiedAtMs: NOW } as ServerValidatedDeviceEvidence;
    const r = await promoteDeviceTrust(sc, DEV, forged, NOW);
    assert.deepEqual(r, { ok: false, refusal: "no_verifier_registered" });
    const c = await collectDeviceEvidence(sc, "x", { userId: USER, deviceId: DEV }, NOW);
    assert.deepEqual(c, { ok: false, refusal: "no_verifier_registered" });
    assert.equal(writes.length, 0);
    assert.equal(tables.devices![0]!.trust_state, "unverified");
  });

  it("a client's self-declaration (a plain object of the right shape) is refused even with a verifier registered", async () => {
    const v = okVerifier();
    registerDeviceEvidenceVerifier(v);
    registerDeviceTrustAuditSink(okAudit().sink);
    const { sc, writes } = makeDb([{ id: DEV, user_id: USER, trust_state: "unverified" }]);
    const fromRequestBody = JSON.parse(JSON.stringify({ verifierId: v.id, kind: v.kind, userId: USER, deviceId: DEV, verifiedAtMs: NOW }));
    const r = await promoteDeviceTrust(sc, DEV, fromRequestBody, NOW);
    assert.deepEqual(r, { ok: false, refusal: "evidence_not_server_validated" });
    // a structural copy of REAL evidence is refused too: identity, not shape
    const real = await collectDeviceEvidence(sc, v.id, { userId: USER, deviceId: DEV }, NOW);
    assert.ok(real.ok);
    const copy = { ...(real as any).evidence };
    assert.deepEqual(await promoteDeviceTrust(sc, DEV, copy, NOW), { ok: false, refusal: "evidence_not_server_validated" });
    assert.equal(trustWrites(writes).length, 0);
  });

  it("evidence minted by a registered verifier + an audit record → the row (and only that user's row) becomes 'verified'", async () => {
    const v = okVerifier();
    registerDeviceEvidenceVerifier(v);
    const audit = okAudit();
    registerDeviceTrustAuditSink(audit.sink);
    const { sc, writes, tables } = makeDb([{ id: DEV, user_id: USER, trust_state: "unverified" }]);
    const c = await collectDeviceEvidence(sc, v.id, { userId: USER, deviceId: DEV }, NOW);
    assert.ok(c.ok);
    const r = await promoteDeviceTrust(sc, DEV, (c as any).evidence, NOW + 1000);
    assert.deepEqual(r, { ok: true, trustState: "verified", kind: "test_attestation" });
    assert.equal(tables.devices![0]!.trust_state, "verified");
    const tw = trustWrites(writes);
    assert.equal(tw.length, 1);
    assert.deepEqual(tw[0]!.patch, { trust_state: "verified" }, "the seam writes the constant and nothing else");
    assert.deepEqual(tw[0]!.filters, [["id", DEV], ["user_id", USER]]);
    assert.deepEqual(audit.entries, [{ userId: USER, deviceId: DEV, verifierId: v.id, kind: "test_attestation", verifiedAtMs: NOW }]);
  });

  it("a verifier that rejects or throws mints no evidence", async () => {
    registerDeviceEvidenceVerifier({ id: "no", kind: "k", verify: async () => ({ ok: false, reason: "integrity_failed" }) });
    registerDeviceEvidenceVerifier({ id: "boom", kind: "k", verify: async () => { throw new Error("provider down"); } });
    const { sc } = makeDb([]);
    assert.deepEqual(await collectDeviceEvidence(sc, "no", { userId: USER, deviceId: DEV }, NOW), { ok: false, refusal: "verifier_rejected", detail: "integrity_failed" });
    const b = await collectDeviceEvidence(sc, "boom", { userId: USER, deviceId: DEV }, NOW);
    assert.equal(b.ok, false);
    assert.equal((b as any).refusal, "verifier_error");
    assert.deepEqual(await collectDeviceEvidence(sc, "unknown", { userId: USER, deviceId: DEV }, NOW), { ok: false, refusal: "verifier_not_registered" });
  });

  it("evidence for another device, stale evidence, or evidence from a verifier since removed is refused", async () => {
    const v = okVerifier();
    registerDeviceEvidenceVerifier(v);
    registerDeviceTrustAuditSink(okAudit().sink);
    const { sc, writes } = makeDb([{ id: DEV, user_id: USER }, { id: DEV2, user_id: USER }]);
    const ev = ((await collectDeviceEvidence(sc, v.id, { userId: USER, deviceId: DEV }, NOW)) as any).evidence;
    assert.deepEqual(await promoteDeviceTrust(sc, DEV2, ev, NOW), { ok: false, refusal: "evidence_device_mismatch" });
    assert.deepEqual(await promoteDeviceTrust(sc, DEV, ev, NOW + DEVICE_EVIDENCE_MAX_AGE_MS + 1), { ok: false, refusal: "evidence_stale" });
    assert.deepEqual(await promoteDeviceTrust(sc, DEV, ev, NOW - 1), { ok: false, refusal: "evidence_stale" });
    _resetDeviceTrustRegistry();
    registerDeviceEvidenceVerifier(okVerifier("other"));
    registerDeviceTrustAuditSink(okAudit().sink);
    assert.deepEqual(await promoteDeviceTrust(sc, DEV, ev, NOW), { ok: false, refusal: "verifier_not_registered" });
    assert.equal(trustWrites(writes).length, 0);
  });

  it("no audit sink, or an audit write that fails, refuses BEFORE any state change", async () => {
    const v = okVerifier();
    registerDeviceEvidenceVerifier(v);
    const { sc, writes } = makeDb([{ id: DEV, user_id: USER, trust_state: "unverified" }]);
    const ev = ((await collectDeviceEvidence(sc, v.id, { userId: USER, deviceId: DEV }, NOW)) as any).evidence;
    assert.deepEqual(await promoteDeviceTrust(sc, DEV, ev, NOW), { ok: false, refusal: "audit_unavailable" });
    registerDeviceTrustAuditSink({ record: async () => false });
    assert.deepEqual(await promoteDeviceTrust(sc, DEV, ev, NOW), { ok: false, refusal: "audit_unavailable" });
    registerDeviceTrustAuditSink({ record: async () => { throw new Error("down"); } });
    assert.deepEqual(await promoteDeviceTrust(sc, DEV, ev, NOW), { ok: false, refusal: "audit_unavailable" });
    assert.equal(trustWrites(writes).length, 0);
  });

  it("a row that is not the evidence user's is not promoted (device_not_found); a database without 3743 says so", async () => {
    const v = okVerifier();
    registerDeviceEvidenceVerifier(v);
    registerDeviceTrustAuditSink(okAudit().sink);
    const db1 = makeDb([{ id: DEV, user_id: OTHER, trust_state: "unverified" }]);
    const ev = ((await collectDeviceEvidence(db1.sc, v.id, { userId: USER, deviceId: DEV }, NOW)) as any).evidence;
    assert.deepEqual(await promoteDeviceTrust(db1.sc, DEV, ev, NOW), { ok: false, refusal: "device_not_found" });
    assert.equal(db1.tables.devices![0]!.trust_state, "unverified");
    const db2 = makeDb([{ id: DEV, user_id: USER }], { failUpdate: { message: 'column "trust_state" does not exist', code: "42703" } });
    assert.deepEqual(await promoteDeviceTrust(db2.sc, DEV, ev, NOW), { ok: false, refusal: "trust_column_absent" });
    const db3 = makeDb([{ id: DEV, user_id: USER }], { failUpdate: { message: "down", code: "57P01" } });
    assert.deepEqual(await promoteDeviceTrust(db3.sc, DEV, ev, NOW), { ok: false, refusal: "write_failed" });
  });

  it("demotion writes the constant 'unverified', scoped to the user", async () => {
    const { sc, writes, tables } = makeDb([{ id: DEV, user_id: USER, trust_state: "verified" }, { id: DEV2, user_id: USER, trust_state: "verified" }]);
    assert.equal(await demoteDeviceTrust(sc, USER, DEV), "done");
    assert.equal(tables.devices![0]!.trust_state, "unverified");
    assert.equal(tables.devices![1]!.trust_state, "verified");
    assert.deepEqual(trustWrites(writes)[0]!.patch, { trust_state: "unverified" });
    const absent = makeDb([], { failUpdate: { message: 'column "trust_state" does not exist', code: "42703" } });
    assert.equal(await demoteDeviceTrust(absent.sc, USER, DEV), "column_absent");
  });
});

// ── 2. revocation demotes a kept row ──────────────────────────────────────────

describe("revocation never leaves a half-revoked device trusted", () => {
  it("auth step fails → the row is kept for a retry AND demoted to unverified", async () => {
    const { sc, tables } = makeDb([{ id: DEV, user_id: USER, auth_session_id: "5a5a5a5a-0000-4000-8000-00000000000a", trust_state: "verified" }], { failAdmin: true });
    const r = await revokeDevice(sc, { userId: USER, deviceId: DEV, callerToken: null, callerDeviceId: null, nowMs: NOW });
    assert.equal(r.steps.registry_row, "kept_for_retry");
    assert.equal(tables.devices!.length, 1);
    assert.equal(tables.devices![0]!.trust_state, "unverified", "a kept row must not keep 'verified'");
    assert.equal(r.trustDemotion, "done");
  });

  it("a completed revocation deletes the row (nothing left to demote)", async () => {
    const { sc, tables } = makeDb([{ id: DEV, user_id: USER, auth_session_id: "5a5a5a5a-0000-4000-8000-00000000000a", trust_state: "verified" }]);
    const r = await revokeDevice(sc, { userId: USER, deviceId: DEV, callerToken: null, callerDeviceId: null, nowMs: NOW });
    assert.equal(r.steps.registry_row, "done");
    assert.equal(tables.devices!.length, 0);
    assert.equal(r.trustDemotion, "not_applicable");
  });
});

// ── 3. static guards ──────────────────────────────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url));
const API_SRC = resolve(HERE, "..");
const REPO = resolve(API_SRC, "../../..");
const SEAM = "artifacts/api-server/src/lib/deviceTrust.ts";
/** The migration that ADDED the column (and its rollback) — the only SQL allowed to name it. */
const SQL_ALLOWED = new Set([
  "artifacts/api-server/src/migrations/3743_telegraph_device_registry_revocation_links.sql",
  "db/rollback/2026-10-11-3743-telegraph-device-registry-revocation-links-rollback.sql",
]);
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".expo", "docs", "coverage", ".turbo"]);
const EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|sql)$/;

function isTestFile(rel: string): boolean {
  return /(^|\/)(test|tests|__tests__)\//.test(rel) || /\.(test|spec)\.[a-z]+$/.test(rel);
}

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name)) continue;
      const p = join(dir, name);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p);
      else if (EXT.test(name) && st.size < 4_000_000) out.push(relative(REPO, p).split("\\").join("/"));
    }
  };
  walk(REPO);
  return out;
}

const FILES = sourceFiles();

/** `trust_state` as its own identifier (not `user_trust_state`). */
const TRUST_TOKEN = /(?<![A-Za-z0-9_])trust_state(?![A-Za-z0-9_])/;

/** Every `.from("devices")…insert|update|upsert(ARG)` in a source text: the ARG text. */
export function devicesWriteArgs(src: string): string[] {
  const args: string[] = [];
  const re = /\.from\(\s*["'`]devices["'`]\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const end = src.indexOf(";", m.index);
    const stmt = src.slice(m.index, end === -1 ? undefined : end);
    const w = /\.(insert|update|upsert)\(/.exec(stmt);
    if (!w) continue;
    let i = w.index + w[0].length;
    let depth = 1;
    const start = i;
    for (; i < stmt.length && depth > 0; i++) {
      if (stmt[i] === "(") depth++;
      else if (stmt[i] === ")") depth--;
    }
    args.push(stmt.slice(start, i - 1).trim());
  }
  return args;
}

/** Why a devices write argument is unsafe, or null. */
export function unsafeDevicesWrite(arg: string): string | null {
  if (!arg.startsWith("{")) return "not an object literal (a variable can carry any column)";
  if (/\.\.\./.test(arg)) return "spreads an object into the row";
  if (/\breq\b|\brequest\b|\bbody\b|\bparams\b|\bquery\b/.test(arg)) return "takes a value from the request";
  if (/\[[^\]]+\]\s*:/.test(arg)) return "computed key";
  return null;
}

describe("STATIC: trust_state has exactly one writer, and no request reaches a devices write", () => {
  it("the walk found the tree (sanity)", () => {
    assert.ok(FILES.includes(SEAM), "the seam file was not found — the walk is broken");
    assert.ok(FILES.includes("artifacts/api-server/src/routes/devices.ts"));
    assert.ok(FILES.length > 500, `only ${FILES.length} files walked`);
  });

  it("no TS/JS source other than lib/deviceTrust.ts names trust_state", () => {
    const offenders = FILES.filter((f) => !f.endsWith(".sql") && f !== SEAM && !isTestFile(f) && TRUST_TOKEN.test(readFileSync(join(REPO, f), "utf8")));
    assert.deepEqual(offenders, [], `only ${SEAM} may write devices.trust_state (OD-1012-DEV-1)`);
  });

  it("no SQL (RPC, trigger, migration, script) other than 3743 + its rollback names trust_state", () => {
    const offenders = FILES.filter((f) => f.endsWith(".sql") && !SQL_ALLOWED.has(f) && TRUST_TOKEN.test(readFileSync(join(REPO, f), "utf8")));
    assert.deepEqual(offenders, [], "a SQL writer of trust_state bypasses the server seam — route it through lib/deviceTrust.ts");
  });

  it("every devices insert/update/upsert is a literal-keyed object with no spread and no request value", () => {
    const bad: string[] = [];
    let seen = 0;
    for (const f of FILES) {
      if (f.endsWith(".sql") || isTestFile(f)) continue;
      const src = readFileSync(join(REPO, f), "utf8");
      if (!src.includes("devices")) continue;
      for (const arg of devicesWriteArgs(src)) {
        seen++;
        const why = unsafeDevicesWrite(arg);
        if (why) bad.push(`${f}: ${why}: ${arg.slice(0, 120)}`);
        if (f !== SEAM && TRUST_TOKEN.test(arg)) bad.push(`${f}: writes trust_state outside the seam`);
      }
    }
    assert.ok(seen >= 6, `expected the known devices writes (register, heartbeat, public key, capabilities, session link, key-package counter, seam); saw ${seen}`);
    assert.deepEqual(bad, []);
  });

  it("nothing outside tests registers a verifier or an audit sink (which evidence promotes is an OPEN owner decision)", () => {
    const offenders = FILES.filter((f) => f !== SEAM && !isTestFile(f) && /registerDevice(EvidenceVerifier|TrustAuditSink)\s*\(/.test(readFileSync(join(REPO, f), "utf8")));
    assert.deepEqual(offenders, []);
  });

  it("the guard's detectors catch what they claim to (self-test)", () => {
    const sample = `
      await sc.from("devices").update({ ...req.body }).eq("id", id);
      await sc.from("devices").insert(payload);
      await sc.from("devices").update({ public_key: req.body.publicKey });
      await sc.from("devices").upsert({ [col]: true });
      await sc.from("devices").update({ last_seen_at: new Date().toISOString() }).eq("id", id);
    `;
    const reasons = devicesWriteArgs(sample).map(unsafeDevicesWrite);
    assert.deepEqual(reasons, [
      "spreads an object into the row",
      "not an object literal (a variable can carry any column)",
      "takes a value from the request",
      "computed key",
      null,
    ]);
    assert.equal(TRUST_TOKEN.test("user_trust_state"), false);
    assert.equal(TRUST_TOKEN.test("update({ trust_state: x })"), true);
  });
});
