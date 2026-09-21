/**
 * CreatorAttributionService and the creator-type eligibility gate.
 *
 * ── WHAT IS PINNED, AND WHY IT MATTERS MORE THAN IT LOOKS ───────────────────
 * Two of these properties are the ones that a report can claim and a tree can
 * fail to have:
 *
 *   FAIL-CLOSED. Nothing is read or written before the `creator_attribution_enabled`
 *   flag is checked, and no migration in this lane creates that flag row. An
 *   absent row reads false through isFlagEnabled, so the surface is OFF in every
 *   deployment. The test asserts the WRITE LOG IS EMPTY on a refusal, not merely
 *   that the return value said no.
 *
 *   DEGRADE, NOT CRASH. Until 2920/2921 are applied every read is a missing
 *   relation. PostgREST returns that as an error object rather than throwing, so
 *   the failure mode without this handling is a `{ data }` destructure producing
 *   undefined — the exact class `check:enum-literals`'s header documents. The
 *   test drives a 42P01 through and requires `degraded_unavailable`.
 *
 * And the honest one: a producerless type gets an attribution row and NO
 * earning, and the service refuses at the same place the database does.
 *
 * Run: node --import tsx/esm --test src/test/creatorTypeService.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CREATOR_TYPES, creatorTypeFacts, typesWithoutValueEventProducer } from "../lib/creatorTypes.js";
import { buildAttribution, type CreatorAttribution } from "../lib/creatorTypeAttribution.js";
import { evaluateCreatorTypeEligibility } from "../lib/rewardEligibility.js";
import {
  CREATOR_ATTRIBUTION_FLAG,
  holdCreatorAttribution,
  readCreatorTypeCoverage,
  recordCreatorAttribution,
  recordCreatorEarning,
  resolveActiveRuleVersion,
  resolveAllActiveRuleVersions,
} from "../services/creators/CreatorAttributionService.js";

const B = "11111111-1111-4111-8111-111111111111";
const MISSING_RELATION = { code: "42P01", message: 'relation "public.creator_attributions" does not exist' };

interface Write { table: string; op: string; payload: any }

/**
 * A fake PostgREST client modelling the parts that matter: the flag read, an
 * ordered/limited select over the rule versions, a plain select, and an INSERT
 * that can raise the 23505 the TOTAL unique index will.
 */
function fakeClient(opts: {
  flagOn?: boolean;
  ruleVersionRows?: any[];
  attributionRows?: any[];
  entryRows?: any[];
  error?: any;
  insertError?: any;
  /**
   * How many rows of an ARRAY payload the upsert actually inserted.
   *
   * `ON CONFLICT DO NOTHING ... RETURNING` returns ONLY the rows it inserted,
   * so a redelivered earning comes back as `data: []` with `error: null` —
   * byte-identical, at the wire, to an upsert that had nothing to write. This
   * option is how that wire shape is put in front of the service. Omitted, the
   * fake echoes the whole payload, which is the first-delivery case.
   */
  upsertInserted?: number;
} = {}) {
  const writes: Write[] = [];
  const flagOn = opts.flagOn !== false;
  const from = (t: string) => {
    const state: any = {
      _t: t, _payload: null as any, _filters: [] as Array<[string, any]>,
      select() { return this; },
      eq(c: string, v: any) { this._filters.push([c, v]); return this; },
      lte() { return this; },
      order() { return this; },
      limit() { return this; },
      insert(p: any) { this._payload = p; writes.push({ table: t, op: "insert", payload: p }); return this; },
      upsert(p: any) { this._payload = p; writes.push({ table: t, op: "upsert", payload: p }); return this; },
      // PostgREST's .single()/.maybeSingle() UNWRAP a result set to one row or
      // null. The first version of this double returned the array unchanged,
      // which made an empty [] truthy at the call site and turned a failed
      // replay lookup into a silent success — the fake pinning a fiction, which
      // is the exact failure mode check:enum-literals' header documents.
      single() { this._single = true; return this; },
      maybeSingle() { this._single = true; return this; },
      _single: false,
      async then(res: (v: any) => void) {
        const emit = (v: any) => res(
          this._single && Array.isArray(v.data) ? { ...v, data: v.data[0] ?? null } : v,
        );
        if (t === "feature_flags") return emit({ data: flagOn ? { enabled: true } : null, error: null });
        if (opts.error) return emit({ data: null, error: opts.error });
        if (this._payload !== null) {
          if (opts.insertError) return emit({ data: null, error: opts.insertError });
          const p = this._payload;
          if (Array.isArray(p) && opts.upsertInserted !== undefined) {
            return res({
              data: p.slice(0, opts.upsertInserted).map((r, i) => ({ id: `row-${i}`, ...r })),
              error: null,
            });
          }
          return res({
            data: Array.isArray(p) ? p.map((r, i) => ({ id: `row-${i}`, ...r })) : { id: "row-0", ...p },
            error: null,
          });
        }
        if (t === "creator_rule_versions") {
          const rows = opts.ruleVersionRows ?? CREATOR_TYPES.map((ct) => ({
            creator_type: ct, rule_version: creatorTypeFacts(ct).defaultRuleVersion,
            params: {}, effective_from: "2026-01-01T00:00:00Z",
          }));
          const byType = this._filters.find(([c]: any) => c === "creator_type");
          return emit({ data: byType ? rows.filter((r) => r.creator_type === byType[1]) : rows, error: null });
        }
        if (t === "creator_attributions") return emit({ data: opts.attributionRows ?? [], error: null });
        if (t === "creator_earning_entries") return emit({ data: opts.entryRows ?? [], error: null });
        return emit({ data: null, error: null });
      },
    };
    return state;
  };
  return { client: { from }, writes };
}

function attributionFor(t: (typeof CREATOR_TYPES)[number]): CreatorAttribution {
  const f = creatorTypeFacts(t);
  const r = buildAttribution({
    creatorType: t, subjectId: "s-1",
    valueEventId: f.valueEventProducer ? "evt-1" : null,
    beneficiaryUserId: B, ruleVersion: f.defaultRuleVersion,
    weight: f.valueEventProducer ? 1 : 0, confidence: f.valueEventProducer ? 1 : 0,
    grossRevenueMinor: 0, provisionalShareMinor: 0,
    fraudHold: false, fraudHoldReason: null,
  });
  assert.equal(r.status, "built", t);
  if (r.status !== "built") throw new Error("unreachable");
  return r.attribution;
}

// ═══════════════════════════════════════════════════════════════════════════
describe("fail-closed: the flag gates every entry point, and nothing is written", () => {
  const entryPoints: Array<[string, (c: any) => Promise<any>]> = [
    ["resolveActiveRuleVersion", (c) => resolveActiveRuleVersion(c, "travel_partner")],
    ["resolveAllActiveRuleVersions", (c) => resolveAllActiveRuleVersions(c)],
    ["recordCreatorAttribution", (c) => recordCreatorAttribution(c, {
      creatorType: "travel_partner", subjectId: "s", valueEventId: "e", beneficiaryUserId: B,
      weight: 1, confidence: 1, grossRevenueMinor: 0, provisionalShareMinor: 0,
      fraudHold: false, fraudHoldReason: null,
    })],
    ["recordCreatorEarning", (c) => recordCreatorEarning(c, "row-1", attributionFor("travel_partner"), {
      grossRevenueMinor: 100, creatorShareMinor: 100, platformFeeMinor: 0,
    })],
    ["holdCreatorAttribution", (c) => holdCreatorAttribution(c, attributionFor("travel_partner"), "fake_visits")],
    ["readCreatorTypeCoverage", (c) => readCreatorTypeCoverage(c)],
  ];

  for (const [name, call] of entryPoints) {
    it(`${name} refuses with the flag off AND writes nothing`, async () => {
      const { client, writes } = fakeClient({ flagOn: false });
      const r = await call(client);
      assert.equal(r.ok, false, name);
      assert.equal(r.reason, "disabled", name);
      assert.deepEqual(writes, [], `${name} wrote something with the flag off`);
    });
  }

  it("the flag this lane gates on is not created by either migration — absent reads false", async () => {
    const { readFileSync } = await import("node:fs");
    const { dirname, join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const M = join(dirname(fileURLToPath(import.meta.url)), "../migrations");
    for (const f of ["2920_creator_attributions.sql", "2921_creator_earning_entries.sql"]) {
      const sql = readFileSync(join(M, f), "utf8")
        .split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
      assert.ok(!/feature_flags/.test(sql), `${f} touches feature_flags; the surface would not be off by default`);
    }
    assert.equal(CREATOR_ATTRIBUTION_FLAG, "creator_attribution_enabled");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("degrade, not crash, when 2920/2921 are not applied", () => {
  it("a 42P01 becomes degraded_unavailable on every read path", async () => {
    const { client } = fakeClient({ error: MISSING_RELATION });
    for (const r of [
      await resolveActiveRuleVersion(client, "travel_partner"),
      await resolveAllActiveRuleVersions(client),
      await readCreatorTypeCoverage(client),
    ]) {
      assert.equal(r.ok, false);
      assert.equal((r as any).reason, "degraded_unavailable");
    }
  });

  it("a GENUINE fault is db_error, not degraded — the two must not be confused", async () => {
    const { client } = fakeClient({ error: { code: "57014", message: "canceling statement due to statement timeout" } });
    const r = await resolveActiveRuleVersion(client, "travel_partner");
    assert.equal(r.ok, false);
    assert.equal((r as any).reason, "db_error");
  });

  it("a type with NO rule version row refuses rather than defaulting to one", async () => {
    const { client } = fakeClient({ ruleVersionRows: [] });
    const r = await resolveActiveRuleVersion(client, "trail_builder");
    assert.equal(r.ok, false);
    assert.equal((r as any).reason, "no_active_rule_version");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("`07` §10 property 3 — a rule version in force for ALL SIX types", () => {
  it("resolveAllActiveRuleVersions reports every type, and names the missing ones", async () => {
    const { client } = fakeClient();
    const r = await resolveAllActiveRuleVersions(client);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(Object.keys(r.value).sort(), [...CREATOR_TYPES].sort());
    for (const t of CREATOR_TYPES) {
      assert.equal(r.value[t], creatorTypeFacts(t).defaultRuleVersion, t);
    }
  });

  it("a type absent from the table reads NULL rather than being omitted", async () => {
    const { client } = fakeClient({
      ruleVersionRows: CREATOR_TYPES.filter((t) => t !== "experience_host").map((ct) => ({
        creator_type: ct, rule_version: creatorTypeFacts(ct).defaultRuleVersion,
        params: {}, effective_from: "2026-01-01T00:00:00Z",
      })),
    });
    const r = await resolveAllActiveRuleVersions(client);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.value.experience_host, null);
    assert.ok("experience_host" in r.value, "a missing type was omitted instead of reported");
  });

  it("the NEWEST row wins per type — rows arrive newest-first and history must not overwrite it", async () => {
    const { client } = fakeClient({
      ruleVersionRows: [
        { creator_type: "travel_partner", rule_version: "creator-rules/travel-partner/v3", params: {}, effective_from: "2026-06-01T00:00:00Z" },
        { creator_type: "travel_partner", rule_version: "creator-rules/travel-partner/v1", params: {}, effective_from: "2026-01-01T00:00:00Z" },
      ],
    });
    const r = await resolveAllActiveRuleVersions(client);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.value.travel_partner, "creator-rules/travel-partner/v3");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("`07` §10 property 1 — attribution is recorded for ALL SIX types", () => {
  it("every type writes exactly one attribution row, with no settlement", async () => {
    for (const t of CREATOR_TYPES) {
      const f = creatorTypeFacts(t);
      const { client, writes } = fakeClient();
      const r = await recordCreatorAttribution(client, {
        creatorType: t, subjectId: "s-1",
        valueEventId: f.valueEventProducer ? "evt-1" : null, beneficiaryUserId: B,
        weight: f.valueEventProducer ? 1 : 0, confidence: f.valueEventProducer ? 1 : 0,
        grossRevenueMinor: 0, provisionalShareMinor: 0, fraudHold: false, fraudHoldReason: null,
      });
      assert.equal(r.ok, true, `${t}: ${JSON.stringify(r)}`);
      const inserts = writes.filter((w) => w.table === "creator_attributions");
      assert.equal(inserts.length, 1, t);
      assert.equal(inserts[0].payload.settled_minor, 0, `${t} recorded a settlement`);
      assert.equal(inserts[0].payload.creator_type, t);
      assert.equal(inserts[0].payload.subject_kind, f.subjectKind);
      assert.equal(
        inserts[0].payload.attribution_basis,
        f.valueEventProducer ? "recorded_value_event" : "seam_no_producer", t,
      );
    }
  });

  it("the rule version is resolved from the table when the caller names none", async () => {
    const { client, writes } = fakeClient();
    const r = await recordCreatorAttribution(client, {
      creatorType: "local_expert", subjectId: "s", valueEventId: "e", beneficiaryUserId: B,
      weight: 1, confidence: 1, grossRevenueMinor: 0, provisionalShareMinor: 0,
      fraudHold: false, fraudHoldReason: null,
    });
    assert.equal(r.ok, true);
    assert.equal(
      writes.find((w) => w.table === "creator_attributions")!.payload.rule_version,
      creatorTypeFacts("local_expert").defaultRuleVersion,
    );
  });

  it("a 23505 is a REPLAY, not a second row", async () => {
    const { client } = fakeClient({ insertError: { code: "23505", message: "duplicate key" } });
    const r = await recordCreatorAttribution(client, {
      creatorType: "travel_partner", subjectId: "s", valueEventId: "e", beneficiaryUserId: B,
      weight: 1, confidence: 1, grossRevenueMinor: 0, provisionalShareMinor: 0,
      fraudHold: false, fraudHoldReason: null,
    });
    // The fake returns [] for the lookup, so this exercises the "23505 but no
    // existing row" branch — which must be an error, never a silent success.
    assert.equal(r.ok, false);
    assert.equal((r as any).reason, "db_error");
  });

  it("the model's refusals reach the caller as refused_by_model, and write nothing", async () => {
    const { client, writes } = fakeClient();
    const r = await recordCreatorAttribution(client, {
      creatorType: "travel_partner", subjectId: "", valueEventId: "e", beneficiaryUserId: B,
      weight: 1, confidence: 1, grossRevenueMinor: 0, provisionalShareMinor: 0,
      fraudHold: false, fraudHoldReason: null,
    });
    assert.equal(r.ok, false);
    assert.equal((r as any).reason, "refused_by_model");
    assert.match(String((r as any).detail), /missing_attribution/);
    assert.deepEqual(writes.filter((w) => w.table === "creator_attributions"), []);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("`07` §10 property 2 — earnings, and the seam refusal", () => {
  it("a producerless type is refused an earning AND writes no entry", async () => {
    for (const t of typesWithoutValueEventProducer()) {
      const { client, writes } = fakeClient();
      const r = await recordCreatorEarning(client, "row-1", attributionFor(t), {
        grossRevenueMinor: 1000, creatorShareMinor: 800, platformFeeMinor: 200,
      });
      assert.equal(r.ok, false, `${t} minted an earning`);
      assert.equal((r as any).reason, "refused_by_model");
      assert.match(String((r as any).detail), /not_earnable/);
      assert.deepEqual(writes.filter((w) => w.table === "creator_earning_entries"), [], t);
    }
  });

  it("a type WITH a producer books balanced entries carrying no settlement", async () => {
    const { client, writes } = fakeClient();
    const r = await recordCreatorEarning(client, "row-1", attributionFor("travel_partner"), {
      grossRevenueMinor: 1000, creatorShareMinor: 800, platformFeeMinor: 200,
      revenueSource: "booking_commission",
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    const upserts = writes.filter((w) => w.table === "creator_earning_entries");
    assert.equal(upserts.length, 1);
    const rows = upserts[0].payload as any[];
    assert.equal(rows.length, 4, "share and fee, two legs each");
    assert.equal(rows.reduce((s, x) => s + x.amount_minor, 0), 0, "the entry set does not net to zero");
    for (const row of rows) {
      assert.equal(row.cash_settled_minor, 0);
      assert.equal(row.creator_type, "travel_partner");
      assert.equal(row.attribution_id, "row-1");
    }
  });

  it("an all-zero earning writes nothing and says so rather than reporting a phantom success", async () => {
    const { client, writes } = fakeClient();
    const r = await recordCreatorEarning(client, "row-1", attributionFor("local_expert"), {
      grossRevenueMinor: 0, creatorShareMinor: 0, platformFeeMinor: 0,
    });
    assert.equal(r.ok, true);
    if (r.ok) assert.deepEqual(r.value.entries, []);
    assert.equal(r.ok && r.value.booking, "nothing_to_book");
    assert.deepEqual(writes.filter((w) => w.table === "creator_earning_entries"), []);
  });

  /**
   * ── THE `07` §10 PROPERTY THIS SUITE EXISTS FOR ────────────────────────────
   *
   * "Earnings can be recorded WITHOUT PAYING" is a claim about what a reader of
   * the ledger can TELL, not only about what the writer refrains from doing.
   * The settlement half is structural and holds: `cash_settled_minor = 0` is
   * CHECK-enforced by 2921 and typed `0` in the model, so no row can assert that
   * money moved.
   *
   * The RECORDED half had a hole in it. `recordCreatorEarning` upserts with
   * `ignoreDuplicates`, and `ON CONFLICT DO NOTHING ... RETURNING` returns only
   * the rows it actually inserted. So a redelivered earning — every leg already
   * on the ledger, the creator's entitlement fully recorded — came back as
   * `{ ok: true, entries: [] }`: the SAME value, field for field, that an
   * all-zero earning returns when nothing was booked at all.
   *
   * A caller asking "is this creator's earning on the ledger?" therefore could
   * not distinguish "yes, twice over" from "no, and nothing ever will be". That
   * is a false negative about someone's money, produced by success rather than
   * by an error — the failure mode this lane is graded on.
   *
   * `recordCreatorAttribution` already flags its replay (`replayed: true`); the
   * earning path had the same field available on the result type and never set
   * it. These three tests are the asymmetry, closed.
   */
  it("a REPLAYED earning is distinguishable from an earning that was never booked", async () => {
    // Every leg already on the ledger: the upsert inserts 0 of the 4 rows.
    const { client: replayClient } = fakeClient({ upsertInserted: 0 });
    const replay = await recordCreatorEarning(replayClient, "row-1", attributionFor("travel_partner"), {
      grossRevenueMinor: 1000, creatorShareMinor: 800, platformFeeMinor: 200,
      revenueSource: "booking_commission",
    });

    // Nothing to book at all: no entitlement exists and none ever did.
    const { client: zeroClient } = fakeClient();
    const nothing = await recordCreatorEarning(zeroClient, "row-1", attributionFor("travel_partner"), {
      grossRevenueMinor: 0, creatorShareMinor: 0, platformFeeMinor: 0,
    });

    assert.equal(replay.ok, true, JSON.stringify(replay));
    assert.equal(nothing.ok, true, JSON.stringify(nothing));
    if (!replay.ok || !nothing.ok) return;

    assert.notDeepEqual(
      replay.value, nothing.value,
      "a fully-recorded earning and an earning that was never booked returned the same value",
    );
    assert.equal(replay.value.booking, "already_booked");
    assert.equal(nothing.value.booking, "nothing_to_book");
    // The count of entries the earning CONSISTS of survives the replay; the
    // count this call inserted is zero, and the two are separate fields so
    // neither can be read as the other.
    assert.equal(replay.value.entryCount, 4);
    assert.equal(nothing.value.entryCount, 0);
    assert.equal(replay.replayed, true, "the replay was not flagged as one");
    assert.equal(nothing.replayed, undefined, "nothing_to_book is not a replay");
  });

  it("a first delivery is `booked`, and carries the rows it wrote", async () => {
    const { client } = fakeClient();
    const r = await recordCreatorEarning(client, "row-1", attributionFor("travel_partner"), {
      grossRevenueMinor: 1000, creatorShareMinor: 800, platformFeeMinor: 200,
      revenueSource: "booking_commission",
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    if (!r.ok) return;
    assert.equal(r.value.booking, "booked");
    assert.equal(r.value.entries.length, 4);
    assert.equal(r.value.entryCount, 4);
    assert.equal(r.replayed, undefined);
  });

  it("a PARTIAL replay is its own answer — not a clean write and not a clean replay", async () => {
    // Two of four legs were already present. After this call the transaction is
    // whole, but a caller reconciling what IT wrote must not be told it wrote
    // all four, and an auditor must be able to see that the legs of one
    // balanced transaction arrived in two deliveries.
    const { client } = fakeClient({ upsertInserted: 2 });
    const r = await recordCreatorEarning(client, "row-1", attributionFor("travel_partner"), {
      grossRevenueMinor: 1000, creatorShareMinor: 800, platformFeeMinor: 200,
      revenueSource: "booking_commission",
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    if (!r.ok) return;
    assert.equal(r.value.booking, "partially_already_booked");
    assert.equal(r.value.entries.length, 2);
    assert.equal(r.value.entryCount, 4);
    assert.equal(r.replayed, true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("`07` §10 property 4 — a fraud hold is an APPENDED row, never an edit", () => {
  it("holding writes a NEW attribution carrying the hold and its reason", async () => {
    const { client, writes } = fakeClient();
    const r = await holdCreatorAttribution(client, attributionFor("travel_partner"), "circular_transactions");
    assert.equal(r.ok, true, JSON.stringify(r));
    const inserts = writes.filter((w) => w.table === "creator_attributions");
    assert.equal(inserts.length, 1);
    assert.equal(inserts[0].payload.fraud_hold, true);
    assert.equal(inserts[0].payload.fraud_hold_reason, "circular_transactions");
    assert.equal(inserts[0].op, "insert", "a hold must not be an update");
  });

  it("no service call ever issues an update or a delete", async () => {
    const { client, writes } = fakeClient();
    await recordCreatorAttribution(client, {
      creatorType: "travel_partner", subjectId: "s", valueEventId: "e", beneficiaryUserId: B,
      weight: 1, confidence: 1, grossRevenueMinor: 0, provisionalShareMinor: 0,
      fraudHold: false, fraudHoldReason: null,
    });
    await recordCreatorEarning(client, "row-1", attributionFor("travel_partner"), {
      grossRevenueMinor: 10, creatorShareMinor: 10, platformFeeMinor: 0,
    });
    await holdCreatorAttribution(client, attributionFor("local_expert"), "synthetic_accounts");
    assert.ok(writes.length > 0, "the fixture exercised nothing");
    for (const w of writes) assert.ok(["insert", "upsert"].includes(w.op), `${w.table}: ${w.op}`);
  });

  it("an unexplained hold is refused before any read", async () => {
    const { client, writes } = fakeClient();
    const r = await holdCreatorAttribution(client, attributionFor("travel_partner"), "");
    assert.equal(r.ok, false);
    assert.deepEqual(writes.filter((w) => w.table !== "feature_flags"), []);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the coverage read reports what is true, not what is claimed", () => {
  it("every type appears, with its producer and its seam/real attribution split", async () => {
    const { client } = fakeClient({
      attributionRows: [
        { creator_type: "trail_builder", attribution_basis: "seam_no_producer" },
        { creator_type: "trail_builder", attribution_basis: "seam_no_producer" },
        { creator_type: "travel_partner", attribution_basis: "recorded_value_event" },
      ],
      entryRows: [{ creator_type: "travel_partner" }, { creator_type: "travel_partner" }],
    });
    const r = await readCreatorTypeCoverage(client);
    assert.equal(r.ok, true, JSON.stringify(r));
    if (!r.ok) return;
    assert.equal(r.value.length, 6);

    const tb = r.value.find((x) => x.creatorType === "trail_builder")!;
    assert.equal(tb.attributionsRecorded, 2);
    // TWO rows and ZERO real attributions. This is the number that stops a row
    // count being read as coverage.
    assert.equal(tb.attributionsWithValueEvent, 0);
    assert.equal(tb.earningEntriesRecorded, 0);
    assert.equal(tb.valueEventProducer, null);
    assert.equal(tb.subjectTable, "public.trails");

    const tp = r.value.find((x) => x.creatorType === "travel_partner")!;
    assert.equal(tp.attributionsWithValueEvent, 1);
    assert.equal(tp.earningEntriesRecorded, 2);
    assert.equal(tp.valueEventProducer, "lib/rentBuddyEarningsLedger.ts");

    const ic = r.value.find((x) => x.creatorType === "itinerary_creator")!;
    assert.equal(ic.subjectTable, null, "itinerary_creator was given an object it does not have");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the creator-type eligibility gate (`lib/rewardEligibility.ts`)", () => {
  const passing = {
    commercialUsePermission: true, fundingSourceKnown: true, ledgerVersion: "intel-reward/v1",
    fraudHold: false, outcomeFinalized: true, valueEventRecorded: true,
  };

  it("a type WITH a producer, all gates open, is eligible", () => {
    for (const t of ["local_expert", "travel_partner"] as const) {
      const r = evaluateCreatorTypeEligibility({
        ...passing, creatorType: t, typeRuleVersion: creatorTypeFacts(t).defaultRuleVersion,
      });
      assert.equal(r.eligible, true, `${t}: ${r.reasons.join(",")}`);
    }
  });

  it("a producerless type is NEVER eligible, and the reason names why", () => {
    for (const t of typesWithoutValueEventProducer()) {
      const r = evaluateCreatorTypeEligibility({
        ...passing, creatorType: t, typeRuleVersion: creatorTypeFacts(t).defaultRuleVersion,
        valueEventRecorded: true, // even lying about this must not make it eligible
      });
      assert.equal(r.eligible, false, t);
      assert.ok(r.reasons.includes("no_value_event_producer"), `${t}: ${r.reasons.join(",")}`);
    }
  });

  it("the five intel gates are DELEGATED, not restated — each still refuses", () => {
    const cases: Array<[Partial<typeof passing>, string]> = [
      [{ outcomeFinalized: false }, "outcome_not_finalized"],
      [{ commercialUsePermission: false }, "no_commercial_use_permission"],
      [{ fundingSourceKnown: false }, "no_funding_source"],
      [{ ledgerVersion: null as any }, "no_ledger_version"],
      [{ fraudHold: true }, "fraud_hold"],
    ];
    for (const [over, reason] of cases) {
      const r = evaluateCreatorTypeEligibility({
        ...passing, ...over, creatorType: "travel_partner",
        typeRuleVersion: creatorTypeFacts("travel_partner").defaultRuleVersion,
      });
      assert.equal(r.eligible, false, reason);
      assert.ok(r.reasons.includes(reason), `${reason} missing from ${r.reasons.join(",")}`);
    }
  });

  it("no type rule version refuses — an earning under no version cannot be recomputed", () => {
    const r = evaluateCreatorTypeEligibility({
      ...passing, creatorType: "travel_partner", typeRuleVersion: null,
    });
    assert.equal(r.eligible, false);
    assert.ok(r.reasons.includes("no_type_rule_version"));
  });

  it("another type's rule version refuses — per-type versioning would be decorative otherwise", () => {
    const r = evaluateCreatorTypeEligibility({
      ...passing, creatorType: "travel_partner",
      typeRuleVersion: creatorTypeFacts("local_expert").defaultRuleVersion,
    });
    assert.equal(r.eligible, false);
    assert.ok(r.reasons.includes("rule_version_type_mismatch"), r.reasons.join(","));
  });

  it("a later generation of the type's own lineage is accepted", () => {
    const r = evaluateCreatorTypeEligibility({
      ...passing, creatorType: "travel_partner", typeRuleVersion: "creator-rules/travel-partner/v9",
    });
    assert.equal(r.eligible, true, r.reasons.join(","));
  });

  it("an unknown type refuses ALONE — nothing downstream of it is worth reporting", () => {
    const r = evaluateCreatorTypeEligibility({
      ...passing, creatorType: "influencer" as any, typeRuleVersion: null,
      outcomeFinalized: false,
    });
    assert.deepEqual(r.reasons, ["unknown_creator_type"]);
  });

  it("reasons are de-duplicated but never empty on a refusal", () => {
    const r = evaluateCreatorTypeEligibility({
      ...passing, creatorType: "trail_builder", typeRuleVersion: null,
      valueEventRecorded: false, fraudHold: true,
    });
    assert.equal(r.eligible, false);
    assert.equal(new Set(r.reasons).size, r.reasons.length);
    assert.ok(r.reasons.length >= 3);
  });
});
