/**
 * §21 Intelligence-Gathering DOMAIN events (spec Table 29) — the emitters that
 * ride the promotion and projection passes and file pipeline transitions onto
 * the canonical spine. Proves: the three verbs are built with actor_id null
 * (service-only, never a "read own" leak) and the exact `intel` envelope the
 * 2278 dedup indexes key on; the promotion emitter is a catch-up (dedups against
 * what already exists, matches the anchor observation by the copied observed_at,
 * tolerates 23505); the state-changed emitter fires ONLY on a real semantic diff
 * (spec §11) and dedups a group-subject orphan against its "went dark" row; and
 * every emitter is fail-closed — a read error emits nothing rather than duping.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildObservationRecordedEvent,
  buildClaimPromotedEvent,
  buildStateChangedEvent,
  snapshotTransition,
  snapshotKey,
  emitPromotionDomainEvents,
  emitStateChangedEvents,
  captureSnapshotStates,
  type SnapshotRow,
  type AnchorObservationRow,
  type PromotedClaimRow,
} from "../lib/intelDomainEvents.js";
import { runIntelPromotionPass } from "../lib/intelPromotionScheduler.js";
import { VERB_FAMILY } from "../lib/eventFamilies.js";

const NOW = new Date("2026-09-04T12:00:00.000Z");

// ── A store-backed mock: every chain method returns a thenable builder; the
// terminal await runs the query. Supports canonical_events insert + json-path
// filters (payload->intel->>X), and reads of the intel_* tables. ────────────
function makeDb(cfg: {
  claims?: any[];
  observations?: any[];
  snapshots?: any[];
  events?: any[];              // pre-existing canonical_events rows
  errorTable?: string;         // reads of this table return an error
}) {
  const events: any[] = [...(cfg.events ?? [])];
  const resolve = (row: any, col: string): any => {
    const m = /^payload->intel->>(.+)$/.exec(col);
    if (m) return row?.payload?.intel?.[m[1]];
    return row?.[col];
  };
  function from(table: string) {
    let op: "select" | "insert" = "select";
    let insertRow: any = null;
    const eqs: [string, any][] = [];
    const ins: [string, any[]][] = [];
    let lim = Infinity;
    const src = (): any[] =>
      (({ intel_claims: cfg.claims, intel_observations: cfg.observations, intel_state_snapshots: cfg.snapshots, canonical_events: events } as any)[table] ?? []);
    const match = (r: any) =>
      eqs.every(([c, v]) => resolve(r, c) === v) && ins.every(([c, vs]) => vs.includes(resolve(r, c)));
    const run = () => {
      if (cfg.errorTable === table && op === "select") return { data: null, error: { message: "boom", code: "XXBOOM" } };
      if (op === "insert") {
        // enforce the two 2278 partial-unique constraints in-memory
        const verb = insertRow.verb;
        const key = verb === "intel.observation.recorded" ? insertRow.payload?.intel?.observation_id
          : verb === "intel.claim.promoted" ? insertRow.payload?.intel?.claim_id : null;
        if (key != null && events.some((e) => e.verb === verb && (e.payload?.intel?.observation_id === key || e.payload?.intel?.claim_id === key))) {
          return { data: null, error: { code: "23505", message: "duplicate" } };
        }
        events.push(insertRow);
        return { data: null, error: null };
      }
      let rows = src().filter(match);
      if (lim !== Infinity) rows = rows.slice(0, lim);
      return { data: rows, error: null };
    };
    const b: any = {
      select() { return b; },
      insert(row: any) { op = "insert"; insertRow = row; return b; },
      eq(c: string, v: any) { eqs.push([c, v]); return b; },
      in(c: string, v: any[]) { ins.push([c, v]); return b; },
      order() { return b; },
      limit(n: number) { lim = n; return b; },
      maybeSingle() { return Promise.resolve(run()); },
      then(res: (r: any) => any) { return Promise.resolve(run()).then(res); },
    };
    return b;
  }
  return { from, _events: events };
}

describe("intelDomainEvents — pure builders (spec Table 29 / 2278 envelope)", () => {
  it("observation.recorded: domain family, actor null, intel.observation_id present", () => {
    const obs: AnchorObservationRow = {
      id: "obs1", subject_id: "place1", zone_id: "z1", claim_type: "crowd.level",
      observed_at: NOW.toISOString(), source_class: "firsthand_unverified", presence_level: "P1", actor_id: "u1",
    };
    const e = buildObservationRecordedEvent(obs, NOW);
    assert.equal(e.verb, "intel.observation.recorded");
    assert.equal(VERB_FAMILY[e.verb], "domain");
    assert.equal(e.actorId, null, "system transition — never a 'read own' leak");
    assert.equal((e.payload as any).intel.observation_id, "obs1");
    assert.equal((e.payload as any).intel.actor_id, "u1");
    assert.equal((e.payload as any).intel.claim_type, "crowd.level");
  });

  it("claim.promoted: actor null, intel.claim_id present, promotion_source system", () => {
    const claim: PromotedClaimRow = {
      id: "c1", subject_id: "place1", zone_id: null, claim_type: "queue.wait",
      confidence: 0.7, confidence_band: "likely_current", observed_at: NOW.toISOString(),
    };
    const e = buildClaimPromotedEvent(claim, NOW);
    assert.equal(e.verb, "intel.claim.promoted");
    assert.equal(e.actorId, null);
    assert.equal(e.confidence, 0.7);
    assert.equal((e.payload as any).intel.claim_id, "c1");
    assert.equal((e.payload as any).intel.promotion_source, "system");
  });

  it("state.changed: actor null, carries snapshot_id + transition + privacy flag", () => {
    const snap = { id: "s1", subject_id: "place1", zone_id: "z1", claim_type: "crowd.level", value: { level: "busy" }, confidence: 0.6, confidence_band: "live", privacy_eligible: true };
    const e = buildStateChangedEvent(snap, "changed", NOW);
    assert.equal(e.verb, "intel.state.changed");
    assert.equal(e.actorId, null);
    assert.equal(e.privacyEligible, true);
    assert.equal((e.payload as any).intel.snapshot_id, "s1");
    assert.equal((e.payload as any).intel.transition, "changed");
    assert.deepEqual((e.payload as any).intel.value, { level: "busy" });
  });

  it("state.changed 'expired' omits the value (the state is going dark)", () => {
    const e = buildStateChangedEvent({ id: "s1", subject_id: "p1", zone_id: null, claim_type: "crowd.level", value: { level: "busy" }, confidence: null, confidence_band: null, privacy_eligible: false }, "expired", NOW);
    assert.equal((e.payload as any).intel.transition, "expired");
    assert.equal("value" in (e.payload as any).intel, false);
  });
});

describe("intelDomainEvents — snapshotTransition (spec §11 trigger)", () => {
  const st = (v: unknown, band: string | null, elig: boolean) => ({ value: v, confidence_band: band, privacy_eligible: elig });
  it("no prior ⇒ appeared", () => {
    assert.equal(snapshotTransition(undefined, st({ level: "quiet" }, "live", true)), "appeared");
  });
  it("identical ⇒ null (no event)", () => {
    assert.equal(snapshotTransition(st({ level: "quiet" }, "live", true), st({ level: "quiet" }, "live", true)), null);
  });
  it("semantic value change ⇒ changed", () => {
    assert.equal(snapshotTransition(st({ level: "quiet" }, "live", true), st({ level: "busy" }, "live", true)), "changed");
  });
  it("confidence-band change ⇒ changed", () => {
    assert.equal(snapshotTransition(st({ level: "quiet" }, "provisional", true), st({ level: "quiet" }, "live", true)), "changed");
  });
  it("eligibility flip (went dark) ⇒ changed", () => {
    assert.equal(snapshotTransition(st({ level: "quiet" }, "live", true), st({ level: "quiet" }, "live", false)), "changed");
  });
});

describe("emitPromotionDomainEvents — catch-up, deduped, anchor-matched", () => {
  const claim: any = { id: "c1", subject_id: "place1", zone_id: "z1", claim_type: "crowd.level", status: "active", promotion_source: "system", confidence: 0.6, confidence_band: "live", observed_at: NOW.toISOString(), created_at: NOW.toISOString() };
  const anchor: any = { id: "obs1", subject_id: "place1", zone_id: "z1", claim_type: "crowd.level", observed_at: NOW.toISOString(), source_class: "firsthand_unverified", presence_level: "P1", actor_id: "u1" };

  it("emits claim.promoted + observation.recorded for a new system claim", async () => {
    const db = makeDb({ claims: [claim], observations: [anchor], events: [] });
    const r = await emitPromotionDomainEvents(db as any, { now: NOW });
    assert.deepEqual(r, { claimsPromoted: 1, observationsRecorded: 1 });
    const verbs = db._events.map((e) => e.verb).sort();
    assert.deepEqual(verbs, ["intel.claim.promoted", "intel.observation.recorded"]);
    const promoted = db._events.find((e) => e.verb === "intel.claim.promoted");
    assert.equal(promoted.payload.intel.claim_id, "c1");
    const rec = db._events.find((e) => e.verb === "intel.observation.recorded");
    assert.equal(rec.payload.intel.observation_id, "obs1");
  });

  it("is a no-op when the claim.promoted event already exists (steady state)", async () => {
    const existing = { verb: "intel.claim.promoted", payload: { intel: { claim_id: "c1" } } };
    const recorded = { verb: "intel.observation.recorded", payload: { intel: { observation_id: "obs1" } } };
    const db = makeDb({ claims: [claim], observations: [anchor], events: [existing, recorded] });
    const r = await emitPromotionDomainEvents(db as any, { now: NOW });
    assert.deepEqual(r, { claimsPromoted: 0, observationsRecorded: 0 });
    assert.equal(db._events.length, 2, "nothing new inserted");
  });

  it("only the anchor whose observed_at matches the claim is recorded", async () => {
    const stale = { ...anchor, id: "obsOLD", observed_at: new Date(NOW.getTime() - 3600_000).toISOString() };
    const db = makeDb({ claims: [claim], observations: [stale, anchor], events: [] });
    await emitPromotionDomainEvents(db as any, { now: NOW });
    const recs = db._events.filter((e) => e.verb === "intel.observation.recorded");
    assert.equal(recs.length, 1);
    assert.equal(recs[0].payload.intel.observation_id, "obs1", "the observed_at-matching anchor, not the stale one");
  });

  it("emits claim.promoted even when no anchor observation is found", async () => {
    const db = makeDb({ claims: [claim], observations: [], events: [] });
    const r = await emitPromotionDomainEvents(db as any, { now: NOW });
    assert.equal(r.claimsPromoted, 1);
    assert.equal(r.observationsRecorded, 0);
  });

  it("fail-closed: a claim read error emits nothing", async () => {
    const db = makeDb({ claims: [claim], observations: [anchor], events: [], errorTable: "intel_claims" });
    const r = await emitPromotionDomainEvents(db as any, { now: NOW });
    assert.deepEqual(r, { claimsPromoted: 0, observationsRecorded: 0 });
    assert.equal(db._events.length, 0);
  });

  it("fail-closed: a dedup read error skips emit (never risks a duplicate)", async () => {
    const db = makeDb({ claims: [claim], observations: [anchor], events: [], errorTable: "canonical_events" });
    const r = await emitPromotionDomainEvents(db as any, { now: NOW });
    assert.deepEqual(r, { claimsPromoted: 0, observationsRecorded: 0 });
  });
});

describe("emitStateChangedEvents — only on a real diff, dedup by snapshot id", () => {
  const snap = (over: Partial<SnapshotRow>): SnapshotRow => ({
    id: "s1", subject_id: "place1", zone_id: "z1", claim_type: "crowd.level",
    value: { level: "busy" }, confidence: 0.6, confidence_band: "live", privacy_eligible: true,
    observed_at: NOW.toISOString(), expires_at: new Date(NOW.getTime() + 3600_000).toISOString(), ...over,
  });

  it("emits 'appeared' for a snapshot with no prior", async () => {
    const post = new Map([[snapshotKey(snap({})), snap({})]]);
    const db = makeDb({ events: [] });
    const r = await emitStateChangedEvents(db as any, new Map(), post, [], { now: NOW });
    assert.equal(r.stateChanged, 1);
    assert.equal(db._events[0].payload.intel.transition, "appeared");
  });

  it("emits nothing when value and band are unchanged", async () => {
    const prior = new Map([[snapshotKey(snap({})), snap({})]]);
    const post = new Map([[snapshotKey(snap({})), snap({ id: "s1b" })]]); // same key, same sem state
    const db = makeDb({ events: [] });
    const r = await emitStateChangedEvents(db as any, prior, post, [], { now: NOW });
    assert.equal(r.stateChanged, 0);
    assert.equal(db._events.length, 0);
  });

  it("emits 'changed' on a value diff", async () => {
    const prior = new Map([[snapshotKey(snap({})), snap({ value: { level: "quiet" } })]]);
    const post = new Map([[snapshotKey(snap({})), snap({ value: { level: "busy" } })]]);
    const db = makeDb({ events: [] });
    const r = await emitStateChangedEvents(db as any, prior, post, [], { now: NOW });
    assert.equal(r.stateChanged, 1);
    assert.equal(db._events[0].payload.intel.transition, "changed");
  });

  it("a wentDark orphan already covered by the prior/post diff is not double-counted", async () => {
    // Same snapshot appears both as an eligibility flip in post AND in wentDark.
    const prior = new Map([[snapshotKey(snap({})), snap({ privacy_eligible: true })]]);
    const post = new Map([[snapshotKey(snap({})), snap({ privacy_eligible: false })]]);
    const db = makeDb({ events: [] });
    const r = await emitStateChangedEvents(db as any, prior, post, [{ id: "s1", subject_id: "place1", zone_id: "z1", claim_type: "crowd.level" }], { now: NOW });
    assert.equal(r.stateChanged, 1, "one snapshot id ⇒ one event");
  });

  it("a wentDark orphan of an unprojected subject emits 'expired'", async () => {
    const db = makeDb({ events: [] });
    const r = await emitStateChangedEvents(db as any, new Map(), new Map(), [{ id: "s9", subject_id: "placeX", zone_id: null, claim_type: "queue.wait" }], { now: NOW });
    assert.equal(r.stateChanged, 1);
    assert.equal(db._events[0].payload.intel.transition, "expired");
    assert.equal(db._events[0].payload.intel.snapshot_id, "s9");
  });
});

describe("captureSnapshotStates", () => {
  it("keys snapshots by (subject, zone, claim_type)", async () => {
    const s: any = { id: "s1", subject_id: "p1", zone_id: "z1", claim_type: "crowd.level", value: { level: "busy" }, confidence: 0.5, confidence_band: "live", privacy_eligible: true, observed_at: NOW.toISOString(), expires_at: NOW.toISOString() };
    const db = makeDb({ snapshots: [s] });
    const m = await captureSnapshotStates(db as any, ["p1"]);
    assert.equal(m.size, 1);
    assert.ok(m.has(snapshotKey(s)));
  });
  it("empty subject list reads nothing", async () => {
    const db = makeDb({ snapshots: [{ id: "s1", subject_id: "p1", claim_type: "x" }] });
    const m = await captureSnapshotStates(db as any, []);
    assert.equal(m.size, 0);
  });
});

describe("runIntelPromotionPass — wires the §21 emitters after promotion", () => {
  // A mock that answers the flag, the RPC, and the emitter's reads.
  function passDb(flag: boolean, claim: any, anchor: any) {
    const inner = makeDb({ claims: claim ? [claim] : [], observations: anchor ? [anchor] : [], events: [] });
    return {
      _events: inner._events,
      from(table: string) {
        if (table === "feature_flags") {
          return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { enabled: flag }, error: null }) }) }) };
        }
        return inner.from(table);
      },
      rpc: async () => ({ data: 1, error: null }),
    };
  }
  const claim: any = { id: "c1", subject_id: "place1", zone_id: "z1", claim_type: "crowd.level", status: "active", promotion_source: "system", confidence: 0.6, confidence_band: "live", observed_at: NOW.toISOString(), created_at: NOW.toISOString() };
  const anchor: any = { id: "obs1", subject_id: "place1", zone_id: "z1", claim_type: "crowd.level", observed_at: NOW.toISOString(), source_class: "firsthand_unverified", presence_level: "P1", actor_id: "u1" };

  it("emits domain events on a promoting pass and reports the counts", async () => {
    const db = passDb(true, claim, anchor);
    const r = await runIntelPromotionPass({ client: db as any, now: NOW });
    assert.equal(r.promoted, 1);
    assert.equal(r.claimsPromoted, 1);
    assert.equal(r.observationsRecorded, 1);
    assert.equal(db._events.length, 2);
  });

  it("does not emit when the flag is off", async () => {
    const db = passDb(false, claim, anchor);
    const r = await runIntelPromotionPass({ client: db as any, now: NOW });
    assert.equal(r.reason, "disabled");
    assert.equal(db._events.length, 0);
  });
});
