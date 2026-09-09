/**
 * intel_live_promoted_scopes — the writer-less reader gets its ONE writer (2430).
 *
 * THE PROPERTY UNDER TEST: the full chain
 *   snapshot exists → nothing serves (allowlist empty)
 *   → promoteLiveScope writes a row (provenance, horizon)
 *   → readLiveClaims serves the claim
 *   → withdrawal / expiry REMOVES it from the served set (and the row says why)
 * and, separately, that with the flag OFF the writer performs NO write and the
 * reader's answer is byte-identical to before 2430 existed.
 *
 * The fake client applies the 2430 SQL functions' documented state machine in
 * memory (promoted / repromoted / renewed / already_active; withdrawn /
 * already_withdrawn / not_found; expire ⇒ withdrawn('expired')) so the TS chain
 * is exercised end to end. The SQL bodies themselves are pinned by the text
 * contracts at the bottom (same technique as intelSqlFunctionContracts.test.ts);
 * they were additionally rehearsed on portava-ci inside a rolled-back
 * transaction on 2026-09-07 — see the migration header.
 *
 * Run: node --import tsx/esm --test src/test/intelLiveScopePromotion.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  promoteLiveScope,
  withdrawLiveScope,
  runLiveScopeExpiryPass,
  liveScopeKey,
  LIVE_SCOPE_PROMOTION_FLAG,
} from "../lib/intelLiveScopePromotion.js";
import { runIntelPromotionTick } from "../lib/intelPromotionScheduler.js";
import {
  readLiveClaims,
  isPromotedScopeActive,
  PROMOTED_SCOPE_COLUMNS,
  _clearPromotedScopeCache,
} from "../lib/liveClaimRead.js";

const NOW = new Date("2026-09-07T12:00:00.000Z");
const iso = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
const HOUR = 60 * 60 * 1000;
const SUBJECT = "11111111-1111-4111-8111-111111111111";

interface ScopeRow {
  scope_key: string; zone_id: string | null; claim_type: string; promoted_at: string; promoted_by: string | null;
  note: string | null; expires_at: string | null; withdrawn_at: string | null; withdrawn_by: string | null;
  withdrawn_reason: string | null; promoted_via: "manual" | "service"; evidence: unknown; updated_at: string;
}

/**
 * In-memory Supabase fake. `flags` drives feature_flags (absent key ⇒ no row).
 * `scopes` is the intel_live_promoted_scopes table. `rpc` applies the 2430
 * contract. Every write to the scope table that does NOT go through rpc throws
 * — the reader must never self-populate.
 */
function fakeDb(opts: {
  flags: Record<string, boolean>;
  snapshots?: any[];
  pre2430?: boolean;           // selecting the 2430 columns fails with 42703
  rpcError?: boolean;          // every rpc resolves with an error
  rpcReceipt?: unknown;        // override the rpc receipt (unknown-receipt case)
}) {
  _clearPromotedScopeCache();
  const scopes = new Map<string, ScopeRow>();
  const rpcCalls: { fn: string; args: any }[] = [];
  const selects: string[] = [];
  const api: any = {
    scopes, rpcCalls, selects,
    from(table: string) {
      if (table === "feature_flags") {
        let flagName = "";
        const fq: any = {
          select: () => fq,
          eq: (k: string, v: unknown) => { if (k === "flag") flagName = String(v); return fq; },
          maybeSingle: async () =>
            flagName in opts.flags ? { data: { enabled: opts.flags[flagName] }, error: null } : { data: null, error: null },
        };
        return fq;
      }
      if (table === "intel_live_promoted_scopes") {
        let cols = "";
        const forbid = () => { throw new Error("reader must never write intel_live_promoted_scopes"); };
        const pq: any = {
          select: (c: string) => { cols = c; selects.push(c); return pq; },
          insert: forbid, upsert: forbid, update: forbid, delete: forbid,
          then: (res: any) => {
            if (opts.pre2430 && /expires_at|withdrawn_at/.test(cols)) {
              return res({ data: null, error: { code: "42703", message: 'column "expires_at" does not exist' } });
            }
            const wanted = cols.split(",").map((s) => s.trim());
            const data = [...scopes.values()].map((r) => Object.fromEntries(wanted.map((k) => [k, (r as any)[k]])));
            return res({ data, error: null });
          },
        };
        return pq;
      }
      if (table === "intel_state_snapshots") {
        const q: any = { select: () => q, eq: () => q, gt: () => q, in: () => q };
        return Object.assign(q, { then: (res: any) => res({ data: opts.snapshots ?? [], error: null }) });
      }
      throw new Error(`unexpected table ${table}`);
    },
    async rpc(fn: string, args: any) {
      rpcCalls.push({ fn, args });
      if (opts.rpcError) return { data: null, error: { message: "boom" } };
      if (opts.rpcReceipt !== undefined) return { data: opts.rpcReceipt, error: null };
      const now: string = args.p_now;
      if (fn === "system_promote_intel_live_scope") {
        const key = `${args.p_zone_id ?? ""}|${args.p_claim_type}`;
        const row = scopes.get(key);
        let action: string;
        if (!row) {
          scopes.set(key, {
            scope_key: key, zone_id: args.p_zone_id ?? null, claim_type: args.p_claim_type, promoted_at: now,
            promoted_by: args.p_promoted_by ?? null, note: args.p_note ?? null, expires_at: args.p_expires_at,
            withdrawn_at: null, withdrawn_by: null, withdrawn_reason: null, promoted_via: "service",
            evidence: args.p_evidence ?? null, updated_at: now,
          });
          action = "promoted";
        } else if (row.withdrawn_at != null || (row.expires_at != null && row.expires_at <= now)) {
          Object.assign(row, {
            promoted_at: now, promoted_by: args.p_promoted_by ?? null, note: args.p_note ?? null,
            expires_at: args.p_expires_at, promoted_via: "service", evidence: args.p_evidence ?? null,
            withdrawn_at: null, withdrawn_by: null, withdrawn_reason: null, updated_at: now,
          });
          action = "repromoted";
        } else if (row.expires_at == null || args.p_expires_at > row.expires_at) {
          Object.assign(row, { expires_at: args.p_expires_at, promoted_via: "service", updated_at: now,
            evidence: args.p_evidence ?? row.evidence, note: args.p_note ?? row.note });
          action = "renewed";
        } else {
          action = "already_active";
        }
        const r = scopes.get(key)!;
        return { data: { scope_key: key, action, promoted_at: r.promoted_at, expires_at: r.expires_at }, error: null };
      }
      if (fn === "system_withdraw_intel_live_scope") {
        const key = `${args.p_zone_id ?? ""}|${args.p_claim_type}`;
        const row = scopes.get(key);
        if (!row) return { data: { scope_key: key, action: "not_found" }, error: null };
        if (row.withdrawn_at != null) return { data: { scope_key: key, action: "already_withdrawn" }, error: null };
        Object.assign(row, { withdrawn_at: now, withdrawn_by: args.p_withdrawn_by ?? null, withdrawn_reason: args.p_reason, updated_at: now });
        return { data: { scope_key: key, action: "withdrawn", withdrawn_at: now }, error: null };
      }
      if (fn === "system_expire_intel_live_scopes") {
        let n = 0;
        for (const row of scopes.values()) {
          if (row.withdrawn_at == null && row.expires_at != null && row.expires_at <= now) {
            Object.assign(row, { withdrawn_at: now, withdrawn_reason: "expired", updated_at: now });
            n += 1;
          }
        }
        return { data: String(n), error: null }; // bigint-as-string over PostgREST
      }
      if (fn === "system_promote_admissible_intel_claims") return { data: "0", error: null };
      throw new Error(`unexpected rpc ${fn}`);
    },
  };
  return api;
}

/** The whole live chain ON (as production is), plus the writer flag as given. */
function liveFlags(writer: boolean | "absent"): Record<string, boolean> {
  const f: Record<string, boolean> = {
    intel_live_label_crowd: true, intel_claim_projection_crowd: true, intel_capture_quick_signal: true,
    disable_intel_live_labels: false, intel_limited_live: true,
  };
  if (writer !== "absent") f[LIVE_SCOPE_PROMOTION_FLAG] = writer;
  return f;
}

const snapshot = (over: Record<string, unknown> = {}) => ({
  id: "snap-1", subject_id: SUBJECT, zone_id: "z1", claim_type: "crowd.level", value: { level: "busy" },
  confidence: 0.8, source_count: 20, observed_at: iso(-30 * 60_000), expires_at: iso(HOUR),
  privacy_eligible: true, conflict_state: "none", source_class: "firsthand_unverified", computed_at: iso(-60_000),
  ...over,
});

// ── The flag OFF: no write, byte-identical read ───────────────────────────────

describe("2430 writer — gated OFF is byte-identical to today", () => {
  for (const state of ["absent", false] as const) {
    it(`flag ${state}: promote/withdraw/expiry perform ZERO writes and the reader still answers []`, async () => {
      const db = fakeDb({ flags: liveFlags(state), snapshots: [snapshot()] });
      const before = await readLiveClaims(db, SUBJECT, { now: NOW });
      assert.deepEqual(before, [], "today's answer with an empty allowlist");

      const p = await promoteLiveScope({ zoneId: "z1", claimType: "crowd.level", expiresAt: iso(HOUR), now: NOW }, { client: db });
      const w = await withdrawLiveScope({ zoneId: "z1", claimType: "crowd.level", reason: "x", now: NOW }, { client: db });
      const e = await runLiveScopeExpiryPass({ client: db, now: NOW });
      assert.deepEqual(p, { skipped: true, reason: "disabled", scopeKey: "z1|crowd.level", action: null, expiresAt: null });
      assert.deepEqual(w, { skipped: true, reason: "disabled", scopeKey: "z1|crowd.level", action: null });
      assert.deepEqual(e, { skipped: true, reason: "disabled", expired: 0 });
      assert.equal(db.rpcCalls.length, 0, "no RPC may be issued while the flag is off");
      assert.equal(db.scopes.size, 0, "the allowlist is untouched");

      _clearPromotedScopeCache();
      const after = await readLiveClaims(db, SUBJECT, { now: NOW });
      assert.deepEqual(after, before, "byte-identical: the gated-off writer changes nothing the reader sees");
    });
  }

  it("no client ⇒ no_client, nothing else", async () => {
    assert.equal((await promoteLiveScope({ zoneId: null, claimType: "crowd.level", expiresAt: iso(HOUR) }, { client: null })).reason, "no_client");
    assert.equal((await withdrawLiveScope({ zoneId: null, claimType: "crowd.level", reason: "x" }, { client: null })).reason, "no_client");
    assert.equal((await runLiveScopeExpiryPass({ client: null })).reason, "no_client");
  });
});

// ── Input validation happens BEFORE any RPC ───────────────────────────────────

describe("2430 writer — refuses bad input before touching the database", () => {
  it("a horizon in the past, or unparseable, is invalid_input with no RPC", async () => {
    const db = fakeDb({ flags: liveFlags(true) });
    const past = await promoteLiveScope({ zoneId: "z1", claimType: "crowd.level", expiresAt: iso(-1), now: NOW }, { client: db });
    const junk = await promoteLiveScope({ zoneId: "z1", claimType: "crowd.level", expiresAt: "not a date", now: NOW }, { client: db });
    assert.equal(past.reason, "invalid_input");
    assert.equal(junk.reason, "invalid_input");
    assert.equal(db.rpcCalls.length, 0);
  });
  it("an empty claim type, or a withdrawal without a reason, is invalid_input with no RPC", async () => {
    const db = fakeDb({ flags: liveFlags(true) });
    assert.equal((await promoteLiveScope({ zoneId: "z1", claimType: "", expiresAt: iso(HOUR), now: NOW }, { client: db })).reason, "invalid_input");
    assert.equal((await withdrawLiveScope({ zoneId: "z1", claimType: "crowd.level", reason: "", now: NOW }, { client: db })).reason, "invalid_input");
    assert.equal(db.rpcCalls.length, 0);
  });
  it("an RPC that RESOLVES with an error is reported as error, never as success", async () => {
    const db = fakeDb({ flags: liveFlags(true), rpcError: true });
    const p = await promoteLiveScope({ zoneId: "z1", claimType: "crowd.level", expiresAt: iso(HOUR), now: NOW }, { client: db });
    const w = await withdrawLiveScope({ zoneId: "z1", claimType: "crowd.level", reason: "x", now: NOW }, { client: db });
    const e = await runLiveScopeExpiryPass({ client: db, now: NOW });
    assert.deepEqual([p.skipped, p.reason, p.action], [true, "error", null]);
    assert.deepEqual([w.skipped, w.reason, w.action], [true, "error", null]);
    assert.deepEqual(e, { skipped: true, reason: "error", expired: 0 });
  });
  it("a receipt this build does not recognise is an error, not a success", async () => {
    const db = fakeDb({ flags: liveFlags(true), rpcReceipt: { action: "something_new" } });
    const p = await promoteLiveScope({ zoneId: "z1", claimType: "crowd.level", expiresAt: iso(HOUR), now: NOW }, { client: db });
    assert.deepEqual([p.skipped, p.reason, p.action], [true, "error", null]);
  });
});

// ── The full chain ────────────────────────────────────────────────────────────

describe("2430 chain — snapshot → promotion → row → reader → withdrawal/expiry removes it", () => {
  it("promotion makes the claim servable; the row carries provenance, evidence and a horizon", async () => {
    const db = fakeDb({ flags: liveFlags(true), snapshots: [snapshot()] });
    assert.deepEqual(await readLiveClaims(db, SUBJECT, { now: NOW }), [], "before promotion: the snapshot exists but nothing serves");

    const evidence = { gate: { met: false, failures: ["weekly_observations"] }, certifiable: false };
    const p = await promoteLiveScope(
      { zoneId: "z1", claimType: "crowd.level", expiresAt: iso(HOUR), promotedBy: SUBJECT, note: "owner review 2026-09-07", evidence, now: NOW },
      { client: db },
    );
    assert.equal(p.skipped, false);
    assert.equal(p.action, "promoted");
    assert.equal(p.scopeKey, "z1|crowd.level");
    assert.equal(db.rpcCalls[0]!.fn, "system_promote_intel_live_scope");
    assert.deepEqual(db.rpcCalls[0]!.args, {
      p_zone_id: "z1", p_claim_type: "crowd.level", p_expires_at: iso(HOUR), p_promoted_by: SUBJECT,
      p_note: "owner review 2026-09-07", p_evidence: evidence, p_now: NOW.toISOString(),
    });
    const row = db.scopes.get("z1|crowd.level")!;
    assert.equal(row.promoted_via, "service", "provenance");
    assert.deepEqual(row.evidence, evidence, "evidence recorded verbatim");
    assert.equal(row.expires_at, iso(HOUR), "explicit horizon");
    assert.equal(row.withdrawn_at, null);

    _clearPromotedScopeCache();
    const served = await readLiveClaims(db, SUBJECT, { now: NOW });
    assert.equal(served.length, 1, "after promotion: the reader sees the claim");
    assert.equal(served[0]!.claimType, "crowd.level");
    assert.ok(db.selects.includes(PROMOTED_SCOPE_COLUMNS), "the reader projects the 2430 columns");
  });

  it("re-promoting an active scope is idempotent (already_active, row unchanged)", async () => {
    const db = fakeDb({ flags: liveFlags(true) });
    await promoteLiveScope({ zoneId: "z1", claimType: "crowd.level", expiresAt: iso(HOUR), now: NOW }, { client: db });
    const snapshotBefore = JSON.stringify(db.scopes.get("z1|crowd.level"));
    const again = await promoteLiveScope({ zoneId: "z1", claimType: "crowd.level", expiresAt: iso(HOUR), now: new Date(NOW.getTime() + 60_000) }, { client: db });
    assert.equal(again.action, "already_active");
    assert.equal(JSON.stringify(db.scopes.get("z1|crowd.level")), snapshotBefore, "no write on an idempotent repeat");
    const renewed = await promoteLiveScope({ zoneId: "z1", claimType: "crowd.level", expiresAt: iso(2 * HOUR), now: NOW }, { client: db });
    assert.equal(renewed.action, "renewed");
    assert.equal(db.scopes.get("z1|crowd.level")!.expires_at, iso(2 * HOUR));
  });

  it("withdrawal removes the claim from the served set and keeps the row with its reason", async () => {
    const db = fakeDb({ flags: liveFlags(true), snapshots: [snapshot()] });
    await promoteLiveScope({ zoneId: "z1", claimType: "crowd.level", expiresAt: iso(HOUR), now: NOW }, { client: db });
    _clearPromotedScopeCache();
    assert.equal((await readLiveClaims(db, SUBJECT, { now: NOW })).length, 1);

    const w = await withdrawLiveScope({ zoneId: "z1", claimType: "crowd.level", reason: "privacy incident", withdrawnBy: SUBJECT, now: NOW }, { client: db });
    assert.equal(w.action, "withdrawn");
    const row = db.scopes.get("z1|crowd.level")!;
    assert.equal(row.withdrawn_reason, "privacy incident");
    assert.equal(row.withdrawn_at, NOW.toISOString());

    _clearPromotedScopeCache();
    assert.deepEqual(await readLiveClaims(db, SUBJECT, { now: NOW }), [], "withdrawn ⇒ not served");

    assert.equal((await withdrawLiveScope({ zoneId: "z1", claimType: "crowd.level", reason: "again", now: NOW }, { client: db })).action, "already_withdrawn");
    assert.equal(row.withdrawn_reason, "privacy incident", "a second withdrawal does not overwrite the first reason");
    assert.equal((await withdrawLiveScope({ zoneId: "zz", claimType: "crowd.level", reason: "x", now: NOW }, { client: db })).action, "not_found");

    const re = await promoteLiveScope({ zoneId: "z1", claimType: "crowd.level", expiresAt: iso(HOUR), now: NOW }, { client: db });
    assert.equal(re.action, "repromoted");
    assert.equal(row.withdrawn_at, null, "re-promotion clears the withdrawal");
    _clearPromotedScopeCache();
    assert.equal((await readLiveClaims(db, SUBJECT, { now: NOW })).length, 1, "re-promoted ⇒ served again");
  });

  it("a stale promotion is invalidated by the reader at its horizon, WITHOUT waiting for the sweep", async () => {
    const db = fakeDb({ flags: liveFlags(true), snapshots: [snapshot({ expires_at: iso(3 * HOUR) })] });
    await promoteLiveScope({ zoneId: "z1", claimType: "crowd.level", expiresAt: iso(HOUR), now: NOW }, { client: db });
    _clearPromotedScopeCache();
    assert.equal((await readLiveClaims(db, SUBJECT, { now: NOW })).length, 1, "inside the horizon: served");
    // Same cached rows, later clock: the horizon is evaluated per call.
    assert.deepEqual(await readLiveClaims(db, SUBJECT, { now: new Date(NOW.getTime() + HOUR) }), [], "AT the horizon: not served");
    assert.deepEqual(await readLiveClaims(db, SUBJECT, { now: new Date(NOW.getTime() + 2 * HOUR) }), [], "past the horizon: not served");
    assert.equal(db.scopes.get("z1|crowd.level")!.withdrawn_at, null, "…and no sweep has run yet");
  });

  it("the expiry sweep turns a lapsed promotion into withdrawn('expired'), idempotently", async () => {
    const db = fakeDb({ flags: liveFlags(true) });
    await promoteLiveScope({ zoneId: "z1", claimType: "crowd.level", expiresAt: iso(HOUR), now: NOW }, { client: db });
    await promoteLiveScope({ zoneId: "z2", claimType: "crowd.level", expiresAt: iso(5 * HOUR), now: NOW }, { client: db });
    assert.deepEqual(await runLiveScopeExpiryPass({ client: db, now: NOW }), { skipped: false, reason: null, expired: 0 }, "nothing lapsed yet");
    const later = new Date(NOW.getTime() + 2 * HOUR);
    assert.deepEqual(await runLiveScopeExpiryPass({ client: db, now: later }), { skipped: false, reason: null, expired: 1 });
    assert.equal(db.scopes.get("z1|crowd.level")!.withdrawn_reason, "expired");
    assert.equal(db.scopes.get("z2|crowd.level")!.withdrawn_at, null, "the unexpired scope is untouched");
    assert.deepEqual(await runLiveScopeExpiryPass({ client: db, now: later }), { skipped: false, reason: null, expired: 0 }, "idempotent");
  });

  it("the promotion scheduler tick runs the sweep under its OWN flag, independent of the claim-promotion flag", async () => {
    const db = fakeDb({ flags: { ...liveFlags(true), intel_claim_projection_crowd: false } });
    await promoteLiveScope({ zoneId: "z1", claimType: "crowd.level", expiresAt: iso(HOUR), now: NOW }, { client: db });
    const tick = await runIntelPromotionTick({ client: db, now: new Date(NOW.getTime() + 2 * HOUR) });
    assert.equal(tick.promotion.reason, "disabled", "claim promotion: its flag is off");
    assert.deepEqual(tick.scopeExpiry, { skipped: false, reason: null, expired: 1 }, "scope expiry: its flag is on, it ran");
    assert.equal(db.scopes.get("z1|crowd.level")!.withdrawn_reason, "expired");
  });
});

// ── Reader semantics in isolation ─────────────────────────────────────────────

describe("liveClaimRead — promoted-scope activity rule", () => {
  const t = NOW.getTime();
  it("active: no withdrawal and no/future horizon", () => {
    assert.equal(isPromotedScopeActive({ scope_key: "k" }, t), true, "2179-shaped row (no columns) is unconditionally promoted");
    assert.equal(isPromotedScopeActive({ scope_key: "k", expires_at: null, withdrawn_at: null }, t), true);
    assert.equal(isPromotedScopeActive({ scope_key: "k", expires_at: iso(1), withdrawn_at: null }, t), true);
  });
  it("inactive: withdrawn, at/after the horizon, or an unparseable horizon", () => {
    assert.equal(isPromotedScopeActive({ scope_key: "k", withdrawn_at: iso(-1) }, t), false);
    assert.equal(isPromotedScopeActive({ scope_key: "k", expires_at: iso(0) }, t), false);
    assert.equal(isPromotedScopeActive({ scope_key: "k", expires_at: iso(-1) }, t), false);
    assert.equal(isPromotedScopeActive({ scope_key: "k", expires_at: "garbage" }, t), false);
    assert.equal(isPromotedScopeActive({ scope_key: "k", expires_at: iso(HOUR), withdrawn_at: iso(-1) }, t), false, "withdrawal wins over a future horizon");
  });
  it("a schema predating 2430 (42703 on the new columns) falls back to scope_key and serves as 2179 did", async () => {
    const db = fakeDb({ flags: liveFlags(true), snapshots: [snapshot()], pre2430: true });
    // A hand-inserted 2179 row: scope_key only.
    db.scopes.set("z1|crowd.level", { scope_key: "z1|crowd.level" } as any);
    const served = await readLiveClaims(db, SUBJECT, { now: NOW });
    assert.equal(served.length, 1);
    assert.deepEqual(db.selects, [PROMOTED_SCOPE_COLUMNS, "scope_key"], "tried the 2430 projection first, then the pre-2430 one");
  });
  it("liveScopeKey is the canonical composition (2179 CHECK) for zoneless and zoned scopes", () => {
    assert.equal(liveScopeKey(null, "crowd.level"), "|crowd.level");
    assert.equal(liveScopeKey(undefined, "crowd.level"), "|crowd.level");
    assert.equal(liveScopeKey("z1", "crowd.level"), "z1|crowd.level");
  });
});

// ── SQL contracts for the 2430 functions (text-pinned) ────────────────────────

const MIGRATION = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations/2430_intel_live_scope_promotion_writer.sql");
const sql = () => fs.readFileSync(MIGRATION, "utf8");
/** Strip `--` line comments (a comment between IF … THEN and RAISE must not defeat a substring pin), then collapse whitespace. */
const flat = (s: string) => s.replace(/--[^\n]*/g, "").replace(/\s+/g, " ");
function fnBody(name: string): string {
  const s = sql();
  const start = s.search(new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+public\\.${name}\\b`));
  assert.ok(start >= 0, `2430 must define public.${name}`);
  const end = s.indexOf("\n$$;", start);
  assert.ok(end > start, `could not find the end of ${name}`);
  return flat(s.slice(start, end + 4));
}
function grantLines(name: string): string[] {
  return sql().split("\n").filter((l) => /^\s*(REVOKE|GRANT)\b/.test(l) && l.includes(`FUNCTION public.${name}(`)).map((l) => l.trim());
}

describe("2430 SQL — posture and contracts", () => {
  for (const name of ["system_promote_intel_live_scope", "system_withdraw_intel_live_scope", "system_expire_intel_live_scopes"]) {
    it(`${name}: SECURITY DEFINER, pinned search_path, service_role only`, () => {
      const f = fnBody(name);
      assert.ok(f.includes("SECURITY DEFINER"));
      assert.ok(/SET search_path = ''/.test(f));
      const g = grantLines(name);
      assert.ok(g.some((l) => l.startsWith("REVOKE ALL") && l.endsWith("FROM PUBLIC;")), `${name}: revoke PUBLIC`);
      assert.ok(g.some((l) => l.startsWith("REVOKE ALL") && l.endsWith("FROM anon;")), `${name}: revoke anon`);
      assert.ok(g.some((l) => l.startsWith("REVOKE ALL") && l.endsWith("FROM authenticated;")), `${name}: revoke authenticated`);
      assert.ok(g.some((l) => l.startsWith("GRANT EXECUTE") && l.endsWith("TO service_role;")), `${name}: grant service_role`);
      assert.ok(!g.some((l) => l.startsWith("GRANT") && !l.endsWith("TO service_role;")), `${name}: no grant to anyone else`);
    });
  }
  it("promote: writes the table (the reader's writer exists), records 'service' provenance, requires a horizon, serialises on the row", () => {
    const f = fnBody("system_promote_intel_live_scope");
    assert.ok(f.includes("INSERT INTO public.intel_live_promoted_scopes"));
    assert.ok(f.includes("'service'"), "provenance");
    assert.ok(!f.includes("'manual'"), "the service path may never claim the hand-insert provenance");
    assert.ok(f.includes("IF p_expires_at IS NULL THEN RAISE EXCEPTION"), "a service promotion without a horizon is refused");
    assert.ok(f.includes("FOR UPDATE"), "concurrent promotions of one scope serialise");
    assert.ok(f.includes("coalesce(p_zone_id, '') || '|' || p_claim_type"), "the canonical scope_key composition (2179 CHECK)");
    for (const action of ["'promoted'", "'repromoted'", "'renewed'", "'already_active'"]) assert.ok(f.includes(action), `action ${action}`);
  });
  it("promote/withdraw/expire never touch the serving decision (snapshots, privacy_eligible, bands)", () => {
    for (const name of ["system_promote_intel_live_scope", "system_withdraw_intel_live_scope", "system_expire_intel_live_scopes"]) {
      const f = fnBody(name);
      for (const forbidden of ["intel_state_snapshots", "privacy_eligible", "confidence_band", "intel_claims", "intel_observations"]) {
        assert.ok(!f.includes(forbidden), `${name} must not read/write ${forbidden}`);
      }
    }
  });
  it("withdraw keeps the row and requires a reason; expire marks 'expired' only on lapsed, un-withdrawn rows", () => {
    const w = fnBody("system_withdraw_intel_live_scope");
    assert.ok(!w.includes("DELETE"), "withdrawal is an UPDATE — the row is the audit trail");
    assert.ok(w.includes("IF p_reason IS NULL OR length(p_reason) = 0 THEN RAISE EXCEPTION"));
    const e = fnBody("system_expire_intel_live_scopes");
    assert.ok(e.includes("withdrawn_reason = 'expired'"));
    assert.ok(e.includes("WHERE withdrawn_at IS NULL AND expires_at IS NOT NULL AND expires_at <= p_now"));
  });
  it("seeds intel_live_scope_promotion_enabled FALSE with a postcondition refusing ON, and promotes nothing", () => {
    const s = flat(sql());
    assert.ok(s.includes("'intel_live_scope_promotion_enabled', false,"), "seeded false");
    assert.ok(s.includes("ON CONFLICT (flag) DO NOTHING"), "idempotent seed");
    assert.ok(s.includes("seeded ON — must ship OFF"), "postcondition refuses ON");
    assert.ok(s.includes("2430 must not promote any scope"), "postcondition: no service rows created by the migration");
    // The only INSERT INTO the allowlist is inside the promote function.
    const inserts = sql().match(/INSERT INTO public\.intel_live_promoted_scopes/g) ?? [];
    assert.equal(inserts.length, 1);
  });
  it("the read path's CHECK-mirroring composition matches the SQL one for a zoneless scope", () => {
    // coalesce(NULL,'') || '|' || 'crowd.level' = '|crowd.level'
    assert.equal(liveScopeKey(null, "crowd.level"), "|crowd.level");
  });
});
