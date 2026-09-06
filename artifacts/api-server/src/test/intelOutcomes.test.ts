/**
 * I4a — outcome events on the canonical spine (spec §14 / Appendix A).
 *
 * Proves, offline against a fake client:
 *   * the Appendix-A enum is exact and every outcome maps onto an EXISTING
 *     'outcome'-family verb (the 2130 ruling: no intel_outcomes table, no new
 *     verb for outcomes);
 *   * payload.intel is EXACTLY the shape shared with I4b, siblings stay outside;
 *   * served-ness is derived from the snapshot record (privacy-eligible, and
 *     served_at inside [observed_at, expires_at] and not in the future);
 *   * the claim must be one of the snapshot's inputs;
 *   * one outcome per (actor, snapshot): a replay returns the original id, and a
 *     lost insert race (23505) is answered as a replay, never a 500;
 *   * the route authenticates, rate-limits, requires the idempotency header,
 *     validates, gates on the projection stage flag, and never trusts the body
 *     for the actor;
 *   * migration 2277's text carries the verb widening, the unique index, the
 *     'domain' family and an OFF flag with an on_count postcondition.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import { VERB_FAMILY } from "../lib/eventFamilies.js";
import { INTEL_DOMAIN_EVENT_VERBS } from "../lib/canonicalEvents.js";
import {
  INTEL_OUTCOMES, OUTCOME_VERB, OUTCOME_VERBS, ATTRIBUTION_TOUCHES, TRAVELER_MODES,
  isIntelOutcomePayload, checkServed, buildOutcomeEvent, recordIntelOutcome,
  type ServedSnapshot,
} from "../lib/intelOutcomes.js";
import intelOutcomesRouter, { INTEL_OUTCOME_RATE_LIMIT, INTEL_OUTCOME_GATE_FLAG } from "../routes/intelOutcomes.js";

const ACTOR = "11111111-1111-4111-8111-111111111111";
const OTHER = "11111111-1111-4111-8111-111111111112";
const SUBJECT = "22222222-2222-4222-8222-222222222222";
const SNAP = "33333333-3333-4333-8333-333333333333";
const CLAIM = "44444444-4444-4444-8444-444444444444";
const CLAIM_OTHER = "44444444-4444-4444-8444-444444444445";
const TOK = "tok-actor";

// Relative to the REAL clock: the route uses `new Date()`, so fixed dates would
// read as "served in the future" or "expired" depending on when the suite runs.
const NOW = new Date();
const at = (minutesFromNow: number) => new Date(NOW.getTime() + minutesFromNow * 60_000).toISOString();
const OBSERVED = at(-30);
const SERVED = at(-15);
const EXPIRES = at(+15);

const snapshot = (over: Partial<ServedSnapshot> = {}): ServedSnapshot => ({
  id: SNAP, subject_id: SUBJECT, zone_id: null, claim_type: "crowd.level",
  confidence: 0.8, source_count: 4, privacy_eligible: true,
  observed_at: OBSERVED, expires_at: EXPIRES, ...over,
});

// ── Fake supabase client ──────────────────────────────────────────────────────
// Rows in tables; filters applied generically, including PostgREST JSON paths
// (`payload->intel->>snapshot_id`) so the dedup read is exercised for real. The
// 2277 partial unique index is emulated on canonical_events.
function cell(row: any, col: string): unknown {
  if (!col.includes("->")) return row[col];
  const parts = col.split(/->>?/);
  let v: any = row;
  for (const p of parts) v = v == null ? undefined : v[p];
  return v;
}

interface Seed {
  flags?: Record<string, boolean>;
  snapshots?: any[];
  claims?: any[];
  events?: any[];
  /** Inject a 23505 on the FIRST canonical_events insert even without a stored dup. */
  raceOnce?: boolean;
  errorTable?: string;
}

function makeDb(seed: Seed = {}) {
  const tables: Record<string, any[]> = {
    feature_flags: Object.entries(seed.flags ?? {}).map(([flag, enabled]) => ({ flag, enabled })),
    profiles: [{ id: ACTOR, account_status: "active" }, { id: OTHER, account_status: "active" }],
    intel_state_snapshots: [...(seed.snapshots ?? [])],
    intel_claims: [...(seed.claims ?? [])],
    canonical_events: [...(seed.events ?? [])],
  };
  let seq = 0;
  let race = seed.raceOnce === true;
  const writes: any[] = [];

  function from(table: string) {
    let op: "select" | "insert" | "insert_select" = "select";
    let payload: any = null;
    let lim = Infinity;
    const filters: Array<{ col: string; val: any; kind: string }> = [];
    const match = (row: any) => filters.every((f) => {
      const c = cell(row, f.col);
      return f.kind === "in" ? (f.val as any[]).includes(c) : c === f.val;
    });
    function run(): { data: any; error: any } {
      if (seed.errorTable === table) return { data: null, error: { message: "boom" } };
      const store = tables[table] ?? (tables[table] = []);
      if (op === "insert" || op === "insert_select") {
        const row = { id: `ev-${++seq}`, created_at: NOW.toISOString(), ...payload };
        if (table === "canonical_events") {
          const sid = cell(row, "payload->intel->>snapshot_id");
          const dup = sid != null && (OUTCOME_VERBS as readonly string[]).includes(row.verb)
            && store.some((r) => r.actor_id === row.actor_id && cell(r, "payload->intel->>snapshot_id") === sid
              && (OUTCOME_VERBS as readonly string[]).includes(r.verb));
          if (dup || race) {
            if (race) {
              race = false;
              // The racing winner exists from now on.
              store.push({ ...row, id: "ev-winner" });
            }
            return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
          }
        }
        store.push(row);
        writes.push({ table, row });
        return { data: op === "insert_select" ? row : null, error: null };
      }
      return { data: store.filter(match).slice(0, lim), error: null };
    }
    const b: any = {
      select() { if (op === "insert") op = "insert_select"; return b; },
      insert(row: any) { op = "insert"; payload = row; return b; },
      eq(c: string, v: any) { filters.push({ col: c, val: v, kind: "eq" }); return b; },
      in(c: string, v: any[]) { filters.push({ col: c, val: v, kind: "in" }); return b; },
      limit(n: number) { lim = n; return b; },
      maybeSingle() { const r = run(); return Promise.resolve({ data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error }); },
      single() { const r = run(); return Promise.resolve({ data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error }); },
      then(resolve: (r: any) => any) { return Promise.resolve(run()).then(resolve); },
    };
    return b;
  }
  return {
    from,
    auth: { getUser: async (token: string) => token === TOK
      ? { data: { user: { id: ACTOR } }, error: null }
      : { data: { user: null }, error: { message: "bad token" } } },
    _tables: tables,
    _writes: writes,
  };
}

const servedWorld = (over: Seed = {}): Seed => ({
  flags: { [INTEL_OUTCOME_GATE_FLAG]: true },
  snapshots: [snapshot()],
  claims: [
    { id: CLAIM, subject_id: SUBJECT, zone_id: null, claim_type: "crowd.level" },
    { id: CLAIM_OTHER, subject_id: SUBJECT, zone_id: null, claim_type: "queue.wait" },
  ],
  ...over,
});

const input = (over: Record<string, unknown> = {}) => ({
  snapshotId: SNAP, claimId: CLAIM, outcome: "same" as const, servedAt: SERVED, touch: "go_tap" as const, ...over,
});

// ═══════════════════════════════════════════════════════════════════════════
describe("I4a outcomes — the enum and its verbs honour the 2130 ruling", () => {
  it("Appendix A outcome enum is exact", () => {
    assert.deepEqual([...INTEL_OUTCOMES], ["better", "slightly_better", "same", "worse", "did_not_go", "could_not_enter"]);
  });
  it("every outcome maps onto an EXISTING 'outcome'-family verb — no verb added for outcomes", () => {
    for (const o of INTEL_OUTCOMES) {
      const verb = OUTCOME_VERB[o];
      assert.equal(VERB_FAMILY[verb], "outcome", `${o} → ${verb} must be in the outcome family`);
      assert.ok(!(INTEL_DOMAIN_EVENT_VERBS as readonly string[]).includes(verb), "an outcome never rides a domain verb");
    }
    assert.equal(OUTCOME_VERB.did_not_go, "rejection");
    assert.equal(OUTCOME_VERB.could_not_enter, "arrival");
    assert.deepEqual(new Set(Object.values(OUTCOME_VERB)), new Set(OUTCOME_VERBS));
  });
  it("Table-22 touches and traveler modes are the documented sets", () => {
    assert.deepEqual([...ATTRIBUTION_TOUCHES], ["direct_paid_answer", "go_tap", "compass_explanation", "impression", "pre_committed"]);
    assert.deepEqual([...TRAVELER_MODES], ["solo", "couple", "group", "family", "unknown"]);
  });

  /**
   * Every reader that selects outcome events off the spine must filter on the
   * VERB, not on the payload envelope alone.
   *
   * payload.intel is not an outcome marker: lib/intelDomainEvents gives
   * intel.observation.recorded, intel.claim.promoted and intel.state.changed the
   * same envelope. A reader matching only `payload->intel is not null` therefore
   * tallies system transitions as traveler-reported outcomes — which read as
   * successful arrivals in the §24 decision section and as finalized outcome
   * evidence in the density gate. Three separate readers had that shape (the
   * observability route, the calibration scheduler and its on-demand CLI twin),
   * so this is a source-level ratchet rather than three per-reader tests: a new
   * reader written the old way fails here even if nobody writes a test for it.
   */
  it("no reader matches intel outcome events on payload.intel without a verb filter", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name === "test" || e.name === "node_modules" || e.name === "migrations") continue;
          walk(p);
        } else if (e.name.endsWith(".ts")) files.push(p);
      }
    };
    walk(root);
    assert.ok(files.length > 100, `expected to scan the server source, found ${files.length} files`);

    const NEEDLE = '.not("payload->intel", "is", null)';
    const offenders: string[] = [];
    let matched = 0;
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      for (let i = src.indexOf(NEEDLE); i !== -1; i = src.indexOf(NEEDLE, i + 1)) {
        matched += 1;
        // The query text from its own .from("canonical_events") up to the predicate.
        const start = src.lastIndexOf('from("canonical_events")', i);
        const query = start === -1 ? "" : src.slice(start, i);
        if (!query.includes('.in("verb", OUTCOME_VERBS')) {
          offenders.push(`${f.slice(root.length + 1)}:${src.slice(0, i).split("\n").length}`);
        }
      }
    }
    // The needle must still exist, or this ratchet would pass by matching nothing.
    assert.ok(matched >= 3, `expected the intel-payload predicate in the known readers, found ${matched}`);
    assert.deepEqual(offenders, [], `these readers count intel domain events as outcomes: ${offenders.join(", ")}`);
  });
});

describe("I4a outcomes — the shared payload contract is exact", () => {
  it("buildOutcomeEvent writes payload.intel with exactly the contract keys", () => {
    const ev = buildOutcomeEvent(ACTOR, snapshot(), input({ experienceRating: 4, counterfactualSameChoice: false, travelerMode: "solo" }), NOW);
    const intel = (ev.payload as any).intel;
    assert.deepEqual(Object.keys(intel).sort(), ["claim_id", "experience_rating", "outcome", "served_at", "snapshot_id", "subject_id"]);
    assert.deepEqual(intel, { snapshot_id: SNAP, claim_id: CLAIM, subject_id: SUBJECT, outcome: "same", experience_rating: 4, served_at: SERVED });
    // siblings stay OUTSIDE intel
    assert.equal((ev.payload as any).touch, "go_tap");
    assert.equal((ev.payload as any).counterfactual_same_choice, false);
    assert.equal((ev.payload as any).traveler_mode, "solo");
    assert.ok(isIntelOutcomePayload(intel));
  });
  it("omits experience_rating when absent (optional in the contract)", () => {
    const ev = buildOutcomeEvent(ACTOR, snapshot(), input(), NOW);
    assert.ok(!("experience_rating" in (ev.payload as any).intel));
  });
  it("fills the five-column envelope from the served snapshot", () => {
    const ev = buildOutcomeEvent(ACTOR, snapshot(), input(), NOW);
    assert.equal(ev.verb, "completion");
    assert.equal(ev.actorId, ACTOR);
    assert.equal(ev.subjectId, SUBJECT);
    assert.equal(ev.confidence, 0.8, "expected_accuracy source for the attribution job");
    assert.equal(ev.sourceCount, 4);
    assert.equal(ev.privacyEligible, true);
    assert.equal(ev.expiresAt, EXPIRES);
    assert.equal(ev.freshnessSeconds, 15 * 60, "served − observed");
    assert.equal(ev.occurredAt, NOW.toISOString());
  });
  it("isIntelOutcomePayload fails closed on drift", () => {
    const good = { snapshot_id: SNAP, claim_id: CLAIM, subject_id: SUBJECT, outcome: "worse", served_at: SERVED };
    assert.ok(isIntelOutcomePayload(good));
    assert.ok(!isIntelOutcomePayload({ ...good, outcome: "meh" }));
    assert.ok(!isIntelOutcomePayload({ ...good, served_at: "yesterday" }));
    assert.ok(!isIntelOutcomePayload({ ...good, experience_rating: 6 }));
    assert.ok(!isIntelOutcomePayload({ ...good, experience_rating: 2.5 }));
    const { claim_id: _c, ...noClaim } = good;
    assert.ok(!isIntelOutcomePayload(noClaim));
    assert.ok(!isIntelOutcomePayload(null));
  });
});

describe("I4a outcomes — served-ness is derived from the snapshot record", () => {
  it("ok inside [observed_at, expires_at], privacy-eligible, not in the future", () => {
    assert.deepEqual(checkServed(snapshot(), SERVED, NOW), { ok: true });
  });
  it("refuses a snapshot that was never servable (privacy_eligible=false)", () => {
    assert.deepEqual(checkServed(snapshot({ privacy_eligible: false }), SERVED, NOW), { ok: false, reason: "snapshot_not_served" });
  });
  it("refuses served_at before the state was observed", () => {
    assert.deepEqual(checkServed(snapshot(), at(-45), NOW), { ok: false, reason: "served_before_observed" });
  });
  it("refuses served_at after expiry", () => {
    assert.deepEqual(checkServed(snapshot({ expires_at: at(-20) }), SERVED, NOW), { ok: false, reason: "served_after_expiry" });
  });
  it("refuses a future served_at beyond skew, and garbage", () => {
    assert.deepEqual(checkServed(snapshot({ expires_at: "2999-01-01T00:00:00Z" }), at(+5), NOW), { ok: false, reason: "served_in_future" });
    assert.deepEqual(checkServed(snapshot(), "nope", NOW), { ok: false, reason: "invalid_served_at" });
  });
});

describe("I4a outcomes — recordIntelOutcome verifies, dedups, writes", () => {
  it("writes ONE spine row with the contract payload; a replay returns the same id", async () => {
    const db = makeDb(servedWorld());
    const first = await recordIntelOutcome(db, ACTOR, input({ experienceRating: 5 }), NOW);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(first.deduped, false);
    assert.equal(db._tables.canonical_events.length, 1);
    const row = db._tables.canonical_events[0];
    assert.equal(row.verb, "completion");
    assert.equal(row.actor_id, ACTOR);
    assert.deepEqual(row.payload.intel, { snapshot_id: SNAP, claim_id: CLAIM, subject_id: SUBJECT, outcome: "same", experience_rating: 5, served_at: SERVED });
    assert.equal(row.confidence, 0.8);

    const second = await recordIntelOutcome(db, ACTOR, input({ outcome: "worse" }), NOW);
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.equal(second.deduped, true);
    assert.equal(second.eventId, first.eventId);
    assert.equal(db._tables.canonical_events.length, 1, "no second row for the same (actor, snapshot)");
  });
  it("a different actor may report the same snapshot", async () => {
    const db = makeDb(servedWorld());
    await recordIntelOutcome(db, ACTOR, input(), NOW);
    const r = await recordIntelOutcome(db, OTHER, input(), NOW);
    assert.equal(r.ok && !r.deduped, true);
    assert.equal(db._tables.canonical_events.length, 2);
  });
  it("a lost insert race (23505) is answered as a replay of the winner, never an error", async () => {
    const db = makeDb(servedWorld({ raceOnce: true }));
    const r = await recordIntelOutcome(db, ACTOR, input(), NOW);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.deduped, true);
    assert.equal(r.eventId, "ev-winner");
  });
  it("refuses an unknown snapshot, an unknown claim, and a claim that is not the snapshot's input", async () => {
    const db = makeDb(servedWorld());
    assert.deepEqual(await recordIntelOutcome(db, ACTOR, input({ snapshotId: "33333333-3333-4333-8333-333333333334" }), NOW), { ok: false, reason: "snapshot_not_found" });
    assert.deepEqual(await recordIntelOutcome(db, ACTOR, input({ claimId: "44444444-4444-4444-8444-444444444499" }), NOW), { ok: false, reason: "claim_not_found" });
    assert.deepEqual(await recordIntelOutcome(db, ACTOR, input({ claimId: CLAIM_OTHER }), NOW), { ok: false, reason: "claim_mismatch" });
    assert.equal(db._tables.canonical_events.length, 0, "nothing written on refusal");
  });
  it("refuses a snapshot that was never served, and a db error is a db_error not a silent success", async () => {
    const db = makeDb(servedWorld({ snapshots: [snapshot({ privacy_eligible: false })] }));
    assert.deepEqual(await recordIntelOutcome(db, ACTOR, input(), NOW), { ok: false, reason: "snapshot_not_served" });
    const bad = makeDb(servedWorld({ errorTable: "intel_claims" }));
    const r = await recordIntelOutcome(bad, ACTOR, input(), NOW);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "db_error");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Route
// ═══════════════════════════════════════════════════════════════════════════
let base: string;
let server: ReturnType<typeof createServer>;
let db: ReturnType<typeof makeDb>;

/** The §19 response envelope POST /v1/intel/outcomes emits (routes/intelOutcomes.ts). */
interface OutcomeResponse {
  outcome: {
    eventId: string; snapshotId: string; claimId: string; subjectId: string; outcome: string;
    experienceRating: number | null; servedAt: string; occurredAt: string; touch: string;
  };
  deduped: boolean;
  schemaVersion: number;
  sourceLabel: string;
  generatedAt: string;
}
interface ErrorResponse { error: string; message?: string }
const asOutcome = async (r: Response): Promise<OutcomeResponse> => (await r.json()) as OutcomeResponse;
const asError = async (r: Response): Promise<ErrorResponse> => (await r.json()) as ErrorResponse;

function setup(seed: Seed) {
  db = makeDb(seed);
  _setTestClient(db, true);
  _setTestServiceClient(db as any);
  _resetRateLimit();
  return db;
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = { info() {}, warn() {}, error() {}, debug() {} }; next(); });
  app.use(intelOutcomesRouter);
  server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(() => server.close());
beforeEach(() => setup(servedWorld()));

function post(body: any, opts: { tok?: string | null; key?: string | null } = {}) {
  const { tok = TOK, key = "outcome-key-1" } = opts;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (tok) headers.Authorization = `Bearer ${tok}`;
  if (key) headers["Idempotency-Key"] = key;
  return fetch(`${base}/v1/intel/outcomes`, { method: "POST", headers, body: JSON.stringify(body) });
}

describe("POST /v1/intel/outcomes", () => {
  it("401 without a bearer token; nothing written", async () => {
    const r = await post(input(), { tok: null });
    assert.equal(r.status, 401);
    assert.equal(db._tables.canonical_events.length, 0);
  });
  it("400 without an Idempotency-Key header (§19: every intel write)", async () => {
    const r = await post(input(), { key: null });
    assert.equal(r.status, 400);
    assert.equal(db._tables.canonical_events.length, 0);
  });
  it("400 on an invalid outcome / rating / touch", async () => {
    for (const bad of [input({ outcome: "amazing" }), input({ experienceRating: 9 }), input({ touch: "billboard" }), input({ servedAt: "yesterday" })]) {
      const r = await post(bad);
      assert.equal(r.status, 400, JSON.stringify(bad));
    }
    assert.equal(db._tables.canonical_events.length, 0);
  });
  it("feature_disabled when the projection stage flag is off — fail-closed, nothing written", async () => {
    setup(servedWorld({ flags: { [INTEL_OUTCOME_GATE_FLAG]: false } }));
    const r = await post(input());
    assert.equal(r.status, 404);
    assert.equal((await asError(r)).error, "feature_disabled");
    assert.equal(db._tables.canonical_events.length, 0);
  });
  it("201 writes the outcome for the SESSION user (a body actor is ignored) with the §19 envelope; replay is 200 deduped", async () => {
    const r = await post({ ...input({ experienceRating: 3, travelerMode: "group" }), actorId: OTHER, actor_id: OTHER });
    assert.equal(r.status, 201);
    const body = await asOutcome(r);
    assert.equal(body.deduped, false);
    assert.equal(body.schemaVersion, 1);
    assert.equal(body.sourceLabel, "traveler_outcome");
    assert.ok(body.generatedAt);
    assert.equal(body.outcome.snapshotId, SNAP);
    assert.equal(body.outcome.claimId, CLAIM);
    assert.equal(body.outcome.subjectId, SUBJECT);
    assert.equal(body.outcome.outcome, "same");
    assert.equal(body.outcome.experienceRating, 3);
    assert.equal(body.outcome.touch, "go_tap");
    assert.equal(db._tables.canonical_events.length, 1);
    assert.equal(db._tables.canonical_events[0].actor_id, ACTOR, "actor is the session user, never the body");
    assert.equal(db._tables.canonical_events[0].payload.traveler_mode, "group");

    const again = await post(input({ outcome: "better" }), { key: "outcome-key-2" });
    assert.equal(again.status, 200);
    const b2 = await asOutcome(again);
    assert.equal(b2.deduped, true);
    assert.equal(b2.outcome.eventId, body.outcome.eventId);
    assert.equal(db._tables.canonical_events.length, 1);
  });
  it("403 when the snapshot was never served; 404 unknown snapshot; 400 claim mismatch", async () => {
    setup(servedWorld({ snapshots: [snapshot({ privacy_eligible: false })] }));
    assert.equal((await post(input())).status, 403);
    setup(servedWorld());
    assert.equal((await post(input({ snapshotId: "33333333-3333-4333-8333-333333333334" }))).status, 404);
    assert.equal((await post(input({ claimId: CLAIM_OTHER }))).status, 400);
    assert.equal(db._tables.canonical_events.length, 0);
  });
  it("429 after the per-user budget, with Retry-After", async () => {
    for (let i = 0; i < INTEL_OUTCOME_RATE_LIMIT.limit; i++) {
      const r = await post(input(), { key: `k-${i}` });
      assert.ok(r.status === 201 || r.status === 200, `request ${i} → ${r.status}`);
    }
    const r = await post(input(), { key: "k-over" });
    assert.equal(r.status, 429);
    assert.ok(r.headers.get("retry-after"));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Migration 2277 — text pins
// ═══════════════════════════════════════════════════════════════════════════
const MIG = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../migrations/2277_intel_outcomes_attribution.sql"), "utf8");

describe("migration 2277 — what it declares", () => {
  it("widens the verb CHECK with exactly the three domain verbs and keeps the nine", () => {
    for (const v of INTEL_DOMAIN_EVENT_VERBS) assert.ok(MIG.includes(`'${v}'`), `${v} missing from the CHECK`);
    for (const v of ["impression", "open", "save", "join", "direction", "arrival", "completion", "rejection", "satisfaction"]) {
      assert.ok(MIG.includes(`'${v}'`), `${v} missing`);
    }
    assert.ok(!/'(better|slightly_better|did_not_go|could_not_enter)'\s*,?\s*'?(impression|open)/.test(MIG), "outcomes are not verbs");
  });
  it("files the domain verbs under 'domain' in the 2123 view, mirroring VERB_FAMILY", () => {
    for (const v of INTEL_DOMAIN_EVENT_VERBS) {
      assert.match(MIG, new RegExp(`WHEN '${v.replace(/\./g, "\\.")}'\\s+THEN 'domain'`));
      assert.equal(VERB_FAMILY[v], "domain");
    }
    assert.ok(MIG.includes("security_invoker = true"), "the view must keep evaluating RLS as the caller");
  });
  it("makes (actor, snapshot) outcomes unique on the spine", () => {
    assert.ok(MIG.includes("canonical_events_intel_outcome_once"));
    assert.match(MIG, /payload->'intel'->>'snapshot_id'/);
  });
  it("creates intel_attributions append-only, deny-default, REVOKE-first, service_role INSERT+SELECT only", () => {
    assert.ok(MIG.includes("CREATE TABLE IF NOT EXISTS public.intel_attributions"));
    assert.ok(MIG.includes("ALTER TABLE public.intel_attributions ENABLE ROW LEVEL SECURITY"));
    for (const role of ["PUBLIC", "anon", "authenticated", "service_role"]) {
      assert.ok(MIG.includes(`REVOKE ALL ON public.intel_attributions FROM ${role}`), `REVOKE from ${role}`);
    }
    assert.ok(MIG.includes("GRANT INSERT, SELECT ON public.intel_attributions TO service_role"));
    assert.ok(!/GRANT[^;]*intel_attributions[^;]*TO (anon|authenticated)/.test(MIG), "no client grant");
    assert.ok(MIG.includes("EXECUTE FUNCTION public.intel_append_only()"), "reuses the 2130 erasure-aware append-only trigger");
  });
  it("seeds the attribution flag OFF with an on_count = 0 postcondition", () => {
    assert.match(MIG, /'intel_outcome_attribution_enabled',\s*false/);
    assert.match(MIG, /flag = 'intel_outcome_attribution_enabled' AND enabled = TRUE/);
    assert.match(MIG, /IF on_count <> 0 THEN/);
  });
});
