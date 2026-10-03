/**
 * "The table is absent" must mean THE TABLE IS ABSENT — not a missing column,
 * a missing function, a type drift, a permission denial or a transport fault.
 *
 * THE DEFECT CLASS
 * ----------------
 * Several reads keep a deliberate, correct fail-open for a table that may not
 * be migrated yet: if the table is absent, no row in it can exist, so "no
 * mute", "no recurrence", "nothing to purge" is a TRUE statement. That
 * reasoning holds for an absent TABLE and for nothing else. The classifiers
 * that decided "absent" answered a much wider question — PGRST204 / 42703
 * (missing COLUMN), any message containing "does not exist" (42703, 42883
 * `operator/function … does not exist`), PGRST200 (missing RELATIONSHIP), or a
 * code-bearing error whose MESSAGE happened to contain "relation … does not
 * exist" (Postgres words a DML column error `column "c" of relation "t" does
 * not exist`). Each of those is a table that EXISTS and could not be read or
 * written, and each was answered as "never migrated".
 *
 * THE RULE (lib/tableAbsence.ts — the same rule PR #574's
 * lib/absentTableError.ts states; see that file for why they are two files):
 *   42P01 / PGRST205                  → absent
 *   any OTHER code                    → NOT absent
 *   no code                           → absent only for the exact wordings
 *                                       `relation "x" does not exist` /
 *                                       `Could not find the table 'x' in the schema cache`
 *
 * WHAT A MISCLASSIFICATION DID, PER SITE (each pinned below, with a control
 * that a genuinely absent table still degrades exactly as before):
 *   routes/interactionContext.ts        an unread mute/restriction → iMuted/iRestricted FALSE
 *   lib/canonicalLocations.ts           a column-drifted read → [] (a failure as "no match")
 *   lib/capability/schemaCapability.ts  42703 "of relation" → table missing →
 *                                       discoverySearchCanonical served [] as "stored"
 *   services/ledger/CanonicalShareReader.ts  an unreadable creator ledger → its
 *                                       rows silently dropped from the per-ledger
 *                                       side of a MONEY reconciliation
 *   services/memory/memoryDeletionLifecycle.ts  an evidence purge that FAILED →
 *                                       `not_applicable` in an erasure report
 *   services/memoryProjections/derivativeRegistry.ts  a revocation that FAILED →
 *                                       retryable:false → the deletion lifecycle
 *                                       reports DERIVATIVES_PURGED `not_applicable`
 *   lib/profileVisibility.ts            a code-bearing error with a "relation"
 *                                       message → the ban/suspension state of
 *                                       user_account_states skipped → profile shown
 *   domain/trips/services/TripRoutineContext.ts  PGRST200 / DML-worded 42703 →
 *                                       "no recurrence source" instead of "unread"
 *   services/telegraph/messageEdits.ts  42703 / PGRST204 → "2811 unapplied" →
 *                                       the edit goes through and the previous body
 *                                       is overwritten UNRECORDED
 *   lib/liveReferenceMessages.ts, lib/wallMomentRead.ts,
 *   services/memoryProjections/derivativeRegistryRead.ts
 *                                       refusal LABEL only (versions_unavailable /
 *                                       retryable:false): no fail-open, but the
 *                                       label told an operator "apply the
 *                                       migration" for a drift or an outage.
 *
 * Synthetic: every error object below is hand-built in the shape Postgres /
 * PostgREST emit; none was captured from a hosted database.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isMissingTableError } from "../lib/capability/schemaCapability.js";
import { readLatestVersions } from "../lib/liveReferenceMessages.js";
import { readPreviousReadings } from "../lib/wallMomentRead.js";
import { suggestCanonicalLocations } from "../lib/canonicalLocations.js";
import { readCanonicalCitySuggestions } from "../lib/discoverySearchCanonical.js";
import { readPerLedgerShareRows } from "../services/ledger/CanonicalShareReader.js";
import { isStoreAbsent } from "../services/memory/memoryDeletionLifecycle.js";
import { revokeDerivativesForMemory } from "../services/memoryProjections/derivativeRegistry.js";
import { readRegisteredPayload } from "../services/memoryProjections/derivativeRegistryRead.js";
import { resolveProfileVisibility } from "../lib/profileVisibility.js";
import { readTripRecurrences } from "../domain/trips/services/TripRoutineContext.js";
import { isEditHistorySchemaAbsent } from "../services/telegraph/messageEdits.js";

// ── Error shapes ─────────────────────────────────────────────────────────────
const ABSENT_42P01 = { code: "42P01", message: 'relation "x" does not exist' };
const ABSENT_PGRST205 = { code: "PGRST205", message: "Could not find the table 'public.x' in the schema cache" };
const ABSENT_CODELESS = { message: 'relation "public.x" does not exist' };
const COL_READ = (t: string, c: string) => ({ code: "42703", message: `column ${t}.${c} does not exist` });
const COL_DML = (t: string, c: string) => ({ code: "42703", message: `column "${c}" of relation "${t}" does not exist` });
const COL_CACHE = (t: string, c: string) => ({ code: "PGRST204", message: `Could not find the '${c}' column of '${t}' in the schema cache` });
const FN_MISSING = { code: "42883", message: "function public.trg_fn() does not exist" };
const OP_MISSING = { code: "42883", message: "operator does not exist: text = uuid" };
const RELATIONSHIP = { code: "PGRST200", message: "Could not find a relationship between 'a' and 'b' in the schema cache" };
const PERM = { code: "42501", message: "permission denied for table x" };
const TRANSPORT = { code: "", message: "TypeError: fetch failed" };
const NOT_ABSENT_SHAPES = [COL_READ("t", "c"), COL_DML("t", "c"), COL_CACHE("t", "c"), FN_MISSING, OP_MISSING, RELATIONSHIP, PERM, TRANSPORT];

/** A supabase-js shaped fake: per-table error or rows; every builder method chains; RESOLVES on error. */
function fake(spec: Record<string, { error?: any; rows?: any[] }>): any {
  return {
    from(table: string) {
      const s = spec[table] ?? { rows: [] };
      const result = () => (s.error ? { data: null, error: s.error, count: null } : { data: s.rows ?? [], error: null, count: (s.rows ?? []).length });
      const b: any = {};
      for (const m of ["select", "eq", "neq", "in", "is", "or", "order", "limit", "range", "ilike", "contains", "gt", "gte", "lt", "lte", "not", "delete", "update", "insert", "upsert"]) {
        b[m] = () => b;
      }
      b.maybeSingle = async () => { const r = result(); return r.error ? r : { data: (r.data as any[])[0] ?? null, error: null }; };
      b.single = b.maybeSingle;
      b.then = (f: any, r: any) => Promise.resolve(result()).then(f, r);
      return b;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────

describe("lib/tableAbsence — the narrow rule itself", () => {
  const load = async () => (await import("../lib/tableAbsence.js").catch(() => ({}))) as any;

  it("absent: 42P01, PGRST205, and the two exact code-less wordings", async () => {
    const { isTableAbsentError } = await load();
    assert.equal(typeof isTableAbsentError, "function", "lib/tableAbsence.ts must export isTableAbsentError");
    for (const e of [ABSENT_42P01, ABSENT_PGRST205, ABSENT_CODELESS, { message: "Could not find the table 'public.x' in the schema cache" }]) {
      assert.equal(isTableAbsentError(e), true, JSON.stringify(e));
    }
  });

  it("a code, when present, DECIDES — even over a message worded exactly like an absent table", async () => {
    const { isTableAbsentError } = await load();
    assert.equal(isTableAbsentError({ code: "57014", message: 'relation "x" does not exist' }), false);
    assert.equal(isTableAbsentError({ code: "PGRST204", message: "Could not find the table 'public.x' in the schema cache" }), false);
  });

  it("NOT absent: column, function, operator, relationship, permission, transport — and garbage", async () => {
    const { isTableAbsentError } = await load();
    for (const e of NOT_ABSENT_SHAPES) assert.equal(isTableAbsentError(e), false, JSON.stringify(e));
    for (const e of [null, undefined, "42P01", 42, {}, { message: 'error: relation "x" does not exist; retry' },
      { message: "Could not find the table 'public.x' in the schema cache, and then the socket closed" }]) {
      assert.equal(isTableAbsentError(e), false, String(e));
    }
  });
});

describe("schemaCapability.isMissingTableError — a code-bearing column error is not a missing table", () => {
  it("42703 worded `column \"c\" of relation \"t\" does not exist` is NOT a missing table", () => {
    assert.equal(isMissingTableError(COL_DML("t", "c")), false);
  });
  it("no other non-table shape is a missing table either", () => {
    for (const e of NOT_ABSENT_SHAPES) assert.equal(isMissingTableError(e), false, JSON.stringify(e));
  });
  it("CONTROL — 42P01 / PGRST205 / the exact code-less wording still are", () => {
    for (const e of [ABSENT_42P01, ABSENT_PGRST205, ABSENT_CODELESS]) assert.equal(isMissingTableError(e), true);
  });
});

describe("discoverySearchCanonical — a column-drifted canonical_locations is not 'no cities'", () => {
  it("42703 (DML wording) on every read REFUSES instead of answering [] as stored", async () => {
    const sc = fake({ canonical_locations: { error: COL_DML("canonical_locations", "search_key") } });
    await assert.rejects(() => readCanonicalCitySuggestions(sc, "kyoto"),
      "a column error must reach the column/legacy path or refuse — never an empty 'stored' answer");
  });
  it("CONTROL — an absent table is still [] (the honest empty)", async () => {
    const out = await readCanonicalCitySuggestions(fake({ canonical_locations: { error: ABSENT_42P01 } }), "kyoto");
    assert.deepEqual([...out], []);
  });
});

describe("canonicalLocations.suggestCanonicalLocations — column drift is a refusal, not no-match", () => {
  for (const e of [COL_READ("canonical_locations", "normalized_name"), COL_DML("canonical_locations", "normalized_name")]) {
    it(`${e.message} → throws`, async () => {
      await assert.rejects(() => suggestCanonicalLocations(fake({ canonical_locations: { error: e } }) as any, "kyoto"));
    });
  }
  it("CONTROL — an absent table is still []", async () => {
    assert.deepEqual(await suggestCanonicalLocations(fake({ canonical_locations: { error: ABSENT_PGRST205 } }) as any, "kyoto"), []);
  });
});

describe("CanonicalShareReader.readPerLedgerShareRows — the creator ledger in a money reconciliation", () => {
  const healthy = { intel_reward_ledger: { rows: [] }, rent_buddy_earnings_entries: { rows: [] } };
  for (const e of [COL_READ("creator_earning_entries", "cash_settled_minor"), FN_MISSING, OP_MISSING]) {
    it(`${e.code} "${e.message}" on creator_earning_entries REFUSES — its rows are not dropped`, async () => {
      const r = await readPerLedgerShareRows(fake({ ...healthy, creator_earning_entries: { error: e } }));
      assert.equal(r.ok, false, "an unreadable ledger must refuse the whole read, not read as an empty ledger");
    });
  }
  it("CONTROL — an absent creator ledger (2921 unapplied) still reads as empty", async () => {
    const r = await readPerLedgerShareRows(fake({ ...healthy, creator_earning_entries: { error: ABSENT_42P01 } }));
    assert.equal(r.ok, true);
  });
});

describe("memoryDeletionLifecycle.isStoreAbsent — an erasure step may be `not_applicable` only for an absent table", () => {
  for (const e of [COL_READ("memory_evidence", "memory_id"), COL_DML("memory_evidence", "memory_id"), COL_CACHE("memory_evidence", "memory_id"), FN_MISSING]) {
    it(`${e.code} is NOT absent — the purge FAILED`, () => assert.equal(isStoreAbsent(e), false));
  }
  it("CONTROL — 42P01 / PGRST205 still are", () => {
    assert.equal(isStoreAbsent(ABSENT_42P01), true);
    assert.equal(isStoreAbsent(ABSENT_PGRST205), true);
  });
});

describe("derivativeRegistry.revokeDerivativesForMemory — a failed revocation stays retryable", () => {
  for (const e of [COL_READ("memory_derivative_registry", "revocation_state"), COL_CACHE("memory_derivative_registry", "revoked_at"), FN_MISSING]) {
    it(`${e.code} on the registry read → retryable:true (so the lifecycle reports FAILED, not not_applicable)`, async () => {
      const r = await revokeDerivativesForMemory(fake({ memory_derivative_registry: { error: e } }), "m1", "memory_deleted", new Date());
      assert.equal(r.ok, false);
      assert.equal((r as any).retryable, true);
    });
  }
  it("CONTROL — an absent registry is still retryable:false", async () => {
    const r = await revokeDerivativesForMemory(fake({ memory_derivative_registry: { error: ABSENT_42P01 } }), "m1", "memory_deleted", new Date());
    assert.equal((r as any).retryable, false);
  });
});

describe("derivativeRegistryRead.readRegisteredPayload — label only", () => {
  it("42703 on the registry → retryable:true", async () => {
    const r = await readRegisteredPayload(fake({ memory_derivative_registry: { error: COL_READ("memory_derivative_registry", "payload_json") } }), "PublicMemoryProjection" as any, { ownerId: "o" } as any);
    assert.equal(r.ok, false);
    assert.equal((r as any).retryable, true);
  });
  it("CONTROL — an absent registry → retryable:false", async () => {
    const r = await readRegisteredPayload(fake({ memory_derivative_registry: { error: ABSENT_PGRST205 } }), "PublicMemoryProjection" as any, { ownerId: "o" } as any);
    assert.equal((r as any).retryable, false);
  });
});

describe("liveReferenceMessages / wallMomentRead — the refusal label", () => {
  for (const e of [COL_READ("intel_state_snapshot_versions", "privacy_eligible"), OP_MISSING]) {
    it(`readLatestVersions: ${e.code} is 'error', not 'versions_unavailable'`, async () => {
      const r = await readLatestVersions(fake({ intel_state_snapshot_versions: { error: e } }), "s1", ["crowd.level"]);
      assert.deepEqual(r, { ok: false, reason: "error" });
    });
    it(`readPreviousReadings: ${e.code} is 'error', not 'versions_unavailable'`, async () => {
      const r = await readPreviousReadings(fake({ intel_state_snapshot_versions: { error: e } }), "s1", ["crowd.level"]);
      assert.deepEqual(r, { ok: false, reason: "error" });
    });
  }
  it("CONTROL — an absent table is still versions_unavailable on both", async () => {
    const sc = fake({ intel_state_snapshot_versions: { error: ABSENT_42P01 } });
    assert.deepEqual(await readLatestVersions(sc, "s1", ["crowd.level"]), { ok: false, reason: "versions_unavailable" });
    assert.deepEqual(await readPreviousReadings(sc, "s1", ["crowd.level"]), { ok: false, reason: "versions_unavailable" });
  });
});

describe("profileVisibility — the ban/suspension state of user_account_states", () => {
  const row = { id: "t", is_private: false, account_status: "active", passport_visibility: "public" };
  it("a code-bearing column error worded `of relation … does not exist` hides the profile (state unread)", async () => {
    const sc = fake({
      user_account_states: { error: COL_DML("user_account_states", "state") },
      blocks: { rows: [] },
      profile_privacy_settings: { rows: [] },
    });
    const r = await resolveProfileVisibility(sc, "viewer", "t", row as any);
    assert.equal(r.visibility, "unavailable", "an unread ban state must not read as 'no ban'");
  });
  it("CONTROL — a genuinely absent user_account_states carries no restriction", async () => {
    const sc = fake({ user_account_states: { error: ABSENT_42P01 }, blocks: { rows: [] }, profile_privacy_settings: { rows: [] } });
    const r = await resolveProfileVisibility(sc, "viewer", "t", row as any);
    assert.notEqual(r.visibility, "unavailable");
  });
});

describe("TripRoutineContext.readTripRecurrences — unread is not 'no source'", () => {
  for (const e of [RELATIONSHIP, COL_DML("trip_commitment_recurrences", "skip_dates")]) {
    it(`${e.code} → unread`, async () => {
      const layer: any = await readTripRecurrences(fake({ trip_commitment_recurrences: { error: e } }), "trip-1");
      assert.equal(layer.status, "unread", JSON.stringify(layer));
    });
  }
  it("CONTROL — an absent table is still no_source", async () => {
    const layer: any = await readTripRecurrences(fake({ trip_commitment_recurrences: { error: ABSENT_PGRST205 } }), "trip-1");
    assert.equal(layer.status, "no_source", JSON.stringify(layer));
  });
});

describe("messageEdits.isEditHistorySchemaAbsent — only an absent message_edits lets an edit through unrecorded", () => {
  it("42703 / PGRST204 are NOT the 2811 gap — the edit must be refused, not recorded nowhere", () => {
    assert.equal(isEditHistorySchemaAbsent(COL_DML("message_edits", "previous_body")), false);
    assert.equal(isEditHistorySchemaAbsent(COL_CACHE("message_edits", "previous_body")), false);
  });
  it("CONTROL — 42P01 / PGRST205 still are", () => {
    assert.equal(isEditHistorySchemaAbsent(ABSENT_42P01), true);
    assert.equal(isEditHistorySchemaAbsent(ABSENT_PGRST205), true);
  });
});

describe("GET /users/:id/interaction-context — an unread mute/restriction is not 'not muted'", () => {
  const VIEWER = "11111111-1111-4111-8111-111111111111";
  const TARGET = "22222222-2222-4222-8222-222222222222";
  async function hit(spec: Record<string, { error?: any; rows?: any[] }>) {
    const { default: express } = await import("express");
    const http = await import("node:http");
    const { _setTestClient, _clearTestClient } = await import("../lib/http.js");
    const { default: router } = await import("../routes/interactionContext.js");
    const sc = fake(spec);
    sc.auth = { getUser: async () => ({ data: { user: { id: VIEWER } }, error: null }) };
    _setTestClient(sc, true);
    const app = express();
    const logged: any[] = [];
    app.use((req: any, _res: any, next: any) => { req.log = { error: (o: any) => logged.push(o), warn() {}, info() {} }; next(); });
    app.use("/api", router);
    const server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const port = (server.address() as any).port;
      const r = await fetch(`http://127.0.0.1:${port}/api/users/${TARGET}/interaction-context`, { headers: { authorization: "Bearer t" } });
      const text = await r.text();
      let body: any = text;
      try { body = JSON.parse(text); } catch { /* not JSON */ }
      return { status: r.status, body, logged };
    } finally {
      server.close();
      _clearTestClient();
    }
  }
  for (const [label, e] of [["42703", COL_READ("user_mutes", "muted_id")], ["PGRST204", COL_CACHE("user_mutes", "muted_id")], ["42883", OP_MISSING]] as const) {
    it(`${label} on user_mutes is a refusal, not iMuted:false`, async () => {
      const r = await hit({ user_mutes: { error: e } });
      assert.notEqual(r.body.iMuted, false, `an unread mute was reported as 'not muted': ${JSON.stringify(r.body).slice(0, 200)}`);
      assert.ok(r.status >= 500, `expected a refusal, got ${r.status}`);
    });
  }
  it("42703 on user_restrictions is a refusal, not iRestricted:false", async () => {
    const r = await hit({ user_restrictions: { error: COL_READ("user_restrictions", "restricted_id") } });
    assert.ok(r.status >= 500, `expected a refusal, got ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
  });
  it("CONTROL — absent Phase 2 tables still degrade to iMuted/iRestricted false with a 200", async () => {
    const r = await hit({ user_mutes: { error: ABSENT_42P01 }, user_restrictions: { error: ABSENT_PGRST205 } });
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300) + String(r.logged.map((l: any) => l?.err?.stack ?? l?.err).join("\n")).slice(0, 600));
    assert.equal(r.body.iMuted, false);
    assert.equal(r.body.iRestricted, false);
  });
});
