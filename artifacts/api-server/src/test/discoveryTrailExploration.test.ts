/**
 * census-discovery §86 (lane W10-T) — the Trail machinery behind
 * `discovery_trail_exploration_enabled` and `discovery_trail_health_order_enabled`
 * (3485, both seeded FALSE): §7's content lifecycle (DC-04), §8's horizon and a
 * module for every rotating state (DV-21), §9's rotation, the Trail's own serve
 * count and steps 3–5 driving what is served (DV-22), and §11's health order
 * (DC-05).
 *
 *   G0  flags OFF: absent and FALSE rows serve the same bytes, and nothing is read or written
 *   L1  every §7 move the machinery can make is in 3381's relation, and the table of when
 *   L2  rotation: successive pages walk the backlog, least-exposed first
 *   L3  the horizon is applied and NO member is left in no module
 *   L4  steps 3–5 drive what is served (taper out, expand up, retest back)
 *   L5  the Trail's own serves are counted, once per member per page
 *   L6  health orders the modules; OFF, it does not
 *   L7  an unread denominator reserves nothing (`null`, never `[]`)
 *
 * Controlled data only. Nothing here measures real-world effectiveness.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getTrailModules, settleTrailModulesServe } from "../services/trails/TrailService.js";
import {
  decideContentTransition, rotateExplorationSlots, exposureVerdict, JUST_ARRIVED_HORIZON_MS, TRAIL_SUSTAIN_MS,
  TRAIL_EVERGREEN_MIN_AGE_MS, TRAIL_RETEST_INTERVAL_MS, TRAIL_EXPLORATION_FLAG, TRAIL_HEALTH_ORDER_FLAG,
} from "../services/trails/trailExploration.js";
import {
  TRAIL_CONTENT_STATES, isTrailContentTransitionAllowed, type TrailContentState,
} from "../lib/discoveryTrailObject.js";
import { TRAIL_EXPLORATION_IMPRESSION_CEILING, TRAIL_EXPOSURE_MIN_EVIDENCE } from "../lib/discoveryTrailHealth.js";
import { makeRulesDb, type Row } from "./helpers/fakeTrailRulesDb.js";

const H = 3_600_000, D = 24 * H;
const rel = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const U = (n: number) => `11111111-1111-4111-8111-1111111111${String(n).padStart(2, "0")}`;
const T = "22222222-2222-4222-8222-222222222201";
const PL = (n: number) => `33333333-3333-4333-8333-3333333333${String(n).padStart(2, "0")}`;
const M = (n: number) => `66666666-6666-4666-8666-6666666666${String(n).padStart(2, "0")}`;

const trailRow: Row = {
  id: T, slug: "bangkok-after-dark", title: "Bangkok After Dark", description: null, destination: "bangkok", place_scope: null,
  parent_trail_id: null, lifecycle_status: "active", created_by: U(1), created_at: rel(90 * D), updated_at: rel(90 * D),
};
/** A place member submitted by its own person, so no creator or place cap interferes with what is being measured. */
const place = (n: number, over: Row = {}): Row => ({
  id: M(n), trail_id: T, source_type: "place", source_id: PL(n), relationship: "supporting", signal: null, source: "user",
  confidence: 0.8, contributor_id: U(n), content_state: "just_arrived", created_at: rel(n * H), ...over,
});
const community = (ns: number[]) => ns.map((n) => ({ id: PL(n), submitted_by: U(n), name: `P${n}`, lat: null, lng: null }));
const profiles = (n: number) => Array.from({ length: n }, (_, i) => ({ id: U(i + 1), account_status: "active", role: "user" }));
const flagsOn = (...flags: string[]) => flags.map((flag) => ({ flag, enabled: true }));
const served = (n: number, count: number, outcome = "impression"): Row[] => Array.from({ length: count }, (_, i) => ({
  id: `re-${n}-${outcome}-${i}`, surface: "discovery", item_id: `db/${PL(n)}`, outcome, served_at: rel(2 * H + i), outcome_at: outcome === "impression" ? null : rel(H),
}));
const rpc = {
  trail_record_member_exposures: (args: Row, tables: Record<string, Row[]>) => {
    const day = String(args.p_at).slice(0, 10);
    const list = (tables.trail_member_exposures ??= []);
    for (const it of args.p_items as Row[]) {
      const hit = list.find((r) => r.trail_id === args.p_trail_id && r.source_type === it.source_type && r.source_id === it.source_id && r.served_on === day);
      if (hit) hit.impressions += 1; else list.push({ trail_id: args.p_trail_id, source_type: it.source_type, source_id: it.source_id, served_on: day, impressions: 1 });
    }
    return { data: (args.p_items as Row[]).length, error: null };
  },
};

describe("G0 — flags OFF: absent and FALSE serve the same bytes, nothing written (NOT a claim of pre-§86 bytes: the unflagged §10 rules apply)", () => {
  const seed = (flags: Row[]) => makeRulesDb({
    profiles: profiles(9), trails: [{ ...trailRow }], feature_flags: flags,
    content_trails: [place(1), place(2, { created_at: rel(10 * D) }), place(3, { content_state: "evergreen" }), place(4, { content_state: "archived_from_active_rotation", created_at: rel(40 * D) })],
    discovery_places: community([1, 2, 3, 4]),
    rank_events: [...served(1, 30), ...served(2, 40), ...served(2, 5, "save")],
    trail_member_exposures: [], content_trails_stamp: [],
  }, { rpc });
  it("absent flags and FALSE flags serve the same bytes; the flag-on machinery never runs", async () => {
    const absent = seed([]);
    const off = seed([{ flag: TRAIL_EXPLORATION_FLAG, enabled: false }, { flag: TRAIL_HEALTH_ORDER_FLAG, enabled: false }]);
    const a = await getTrailModules(absent, T, { viewerId: U(9), pageSize: 8 });
    const b = await getTrailModules(off, T, { viewerId: U(9), pageSize: 8 });
    assert.equal(JSON.stringify(a.modules), JSON.stringify(b.modules));
    assert.deepEqual(a.modules.map((m) => m.key), ["just_arrived", "trending_now", "evergreen", "local_picks"], "the four modules, as before");
    assert.equal(a.serveEffects, undefined);
    await settleTrailModulesServe(absent, T, a);
    await settleTrailModulesServe(off, T, b);
    for (const db of [absent, off]) {
      assert.deepEqual(db.writes.filter((w) => w.op !== "insert" || w.table !== "trail_health_snapshots"), [], "no state move, no serve count, no rpc");
      assert.ok(!db.reads.includes("trail_member_exposures"), "the Trail's own serve count is not even read");
    }
    const ja = a.modules[0]!;
    assert.ok(ja.items.some((i) => i.id === M(2)), "OFF: a 10-day-old just_arrived member stays in just_arrived, as before");
  });
});

describe("L1 — §7: when each move is made, and every move is in 3381's relation", () => {
  const NOW = Date.parse("2026-09-28T12:00:00Z");
  const expand = { impressions: TRAIL_EXPOSURE_MIN_EVIDENCE, positives: TRAIL_EXPOSURE_MIN_EVIDENCE };
  const expandAtCeiling = { impressions: TRAIL_EXPLORATION_IMPRESSION_CEILING, positives: TRAIL_EXPLORATION_IMPRESSION_CEILING };
  const taper = { impressions: TRAIL_EXPOSURE_MIN_EVIDENCE, positives: 0 };
  const thin = { impressions: 1, positives: 1 };
  const move = (state: string, measured: any, createdAgo: number, stateAgo: number | null | undefined) =>
    decideContentTransition({ state, createdAtMs: NOW - createdAgo, stateChangedAtMs: stateAgo === null || stateAgo === undefined ? stateAgo : NOW - stateAgo, measured, nowMs: NOW });
  it("the table", () => {
    assert.equal(exposureVerdict(thin), "evaluating");
    assert.equal(exposureVerdict(null), "unmeasured");
    assert.equal(move("just_arrived", taper, H, null), "archived_from_active_rotation");
    assert.equal(move("just_arrived", expandAtCeiling, H, null), "growing");
    assert.equal(move("just_arrived", expand, H, null), null, "expand below the ceiling: still arriving");
    assert.equal(move("just_arrived", thin, JUST_ARRIVED_HORIZON_MS, null), "growing", "the horizon");
    assert.equal(move("just_arrived", null, JUST_ARRIVED_HORIZON_MS, undefined), "growing", "arrival time is created_at even with no stamp");
    assert.equal(move("growing", taper, 20 * D, 2 * D), "archived_from_active_rotation");
    assert.equal(move("growing", expand, 20 * D, TRAIL_SUSTAIN_MS), "featured");
    assert.equal(move("growing", expand, 20 * D, TRAIL_SUSTAIN_MS - 1), null);
    assert.equal(move("growing", expand, 20 * D, undefined), null, "no stamp: a duration cannot be guessed");
    assert.equal(move("featured", taper, 20 * D, D), "growing");
    assert.equal(move("featured", expand, TRAIL_EVERGREEN_MIN_AGE_MS, TRAIL_SUSTAIN_MS), "evergreen");
    assert.equal(move("featured", expand, TRAIL_EVERGREEN_MIN_AGE_MS - 1, TRAIL_SUSTAIN_MS), null);
    assert.equal(move("evergreen", taper, 400 * D, 100 * D), "archived_from_active_rotation");
    assert.equal(move("evergreen", expand, 400 * D, 100 * D), null);
    assert.equal(move("archived_from_active_rotation", expand, 60 * D, TRAIL_RETEST_INTERVAL_MS), "rediscovered");
    assert.equal(move("archived_from_active_rotation", expand, 60 * D, TRAIL_RETEST_INTERVAL_MS - 1), null);
    assert.equal(move("rediscovered", thin, 60 * D, JUST_ARRIVED_HORIZON_MS), "growing");
    assert.equal(move("rediscovered", thin, 60 * D, undefined), null);
  });
  it("exhaustively: no state × verdict × duration yields a move outside CONTENT_TRANSITIONS", () => {
    const measures = [null, thin, expand, expandAtCeiling, taper];
    const spans = [0, H, TRAIL_SUSTAIN_MS, TRAIL_EVERGREEN_MIN_AGE_MS, 400 * D];
    for (const s of TRAIL_CONTENT_STATES) for (const m of measures) for (const c of spans) for (const st of [...spans, null, undefined]) {
      const to = move(s, m, c, st as any);
      if (to !== null) assert.ok(isTrailContentTransitionAllowed(s, to as TrailContentState), `${s} → ${to}`);
    }
  });
});

describe("L2 — §9: rotation walks the backlog, least-exposed first", () => {
  it("pure: the least-exposed, then oldest, qualified item takes the slot; tapered and at-ceiling items never; a retest only when nothing new waits", () => {
    const c = (id: string, over: any = {}) => ({ id, state: "just_arrived", queuedAtMs: 0, trailImpressions: 0, measured: { impressions: 0, positives: 0 }, retestDue: false, ...over });
    assert.deepEqual(rotateExplorationSlots([c("a", { trailImpressions: 3 }), c("b", { trailImpressions: 1 }), c("c", { trailImpressions: 1, queuedAtMs: -1 })], 8), ["c"]);
    assert.deepEqual(rotateExplorationSlots([c("t", { measured: { impressions: TRAIL_EXPOSURE_MIN_EVIDENCE, positives: 0 } }), c("x", { trailImpressions: TRAIL_EXPLORATION_IMPRESSION_CEILING })], 8), []);
    assert.deepEqual(rotateExplorationSlots([c("r", { state: "archived_from_active_rotation", retestDue: true }), c("n", { trailImpressions: 100 })], 8), ["n"]);
    assert.deepEqual(rotateExplorationSlots([c("r", { state: "archived_from_active_rotation", retestDue: true })], 8), ["r"]);
    assert.deepEqual(rotateExplorationSlots([c("a"), c("b")], 10), ["a", "b"], "the budget is 20 % of the page");
  });
  it("through the service: each served page is counted, so successive pages reach different new items", async () => {
    const db = makeRulesDb({
      profiles: profiles(9), trails: [{ ...trailRow }], feature_flags: flagsOn(TRAIL_EXPLORATION_FLAG),
      // Twelve new members and a page of eight: four are beyond the page — the backlog §9 must still reach.
      content_trails: Array.from({ length: 12 }, (_, i) => place(i + 1)), discovery_places: community(Array.from({ length: 12 }, (_, i) => i + 1)),
      rank_events: [], trail_member_exposures: [],
    }, { rpc });
    const slots: string[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await getTrailModules(db, T, { viewerId: U(9), pageSize: 8 });
      slots.push(...(r.modules[0]!.explorationSlots ?? []));
      await settleTrailModulesServe(db, T, r);
    }
    assert.deepEqual(slots, [M(12), M(11), M(10), M(9)], "each page's reserved slot goes to the least-exposed, oldest member of the backlog beyond the page");
  });
});

describe("L3 — DV-21: the horizon is applied and no member is left in no module", () => {
  it("a just_arrived member past 7 days leaves just_arrived for hidden_gems (growing); every non-archived member is in some module", async () => {
    const members = [
      place(1), place(2, { created_at: rel(10 * D) }), place(3, { content_state: "evergreen", created_at: rel(60 * D) }),
      place(4, { content_state: "growing", created_at: rel(20 * D) }), place(5, { content_state: "featured", created_at: rel(20 * D) }),
      place(6, { content_state: "rediscovered", created_at: rel(90 * D), content_state_changed_at: rel(2 * D) }), place(7, { source: "curated", created_at: rel(30 * D), content_state: "growing" }),
      place(8, { content_state: "archived_from_active_rotation", created_at: rel(90 * D) }),
    ];
    const db = makeRulesDb({
      profiles: profiles(9), trails: [{ ...trailRow }], feature_flags: flagsOn(TRAIL_EXPLORATION_FLAG),
      content_trails: members, discovery_places: community([1, 2, 3, 4, 5, 6, 7, 8]), rank_events: [], trail_member_exposures: [],
    }, { rpc });
    const r = await getTrailModules(db, T, { viewerId: U(9), pageSize: 20 });
    const keys = r.modules.map((m) => m.key);
    assert.deepEqual(keys, ["just_arrived", "trending_now", "hidden_gems", "evergreen", "local_picks"]);
    const where = (id: string) => r.modules.filter((m) => m.items.some((i) => i.id === id)).map((m) => m.key);
    assert.deepEqual(where(M(1)), ["just_arrived"]);
    assert.deepEqual(where(M(2)), ["hidden_gems"], "past the horizon: graduated, and served where growing members are");
    assert.equal(r.modules[2]!.items.find((i) => i.id === M(2))!.contentState, "growing");
    for (const m of members) {
      if (m.content_state === "archived_from_active_rotation") continue;
      assert.ok(where(String(m.id)).length > 0, `${m.id} (${m.content_state}) is in no module`);
    }
    assert.ok(where(M(6)).includes("just_arrived"), "rediscovered two days ago: its horizon runs from the rediscovery (3486's stamp), not from arrival");
  });
});

describe("L4 — §9 steps 3–5 drive what is served", () => {
  it("taper leaves rotation; expand at the ceiling graduates; a rested cooled member that responds is rediscovered; the moves are persisted by compare-and-set", async () => {
    const members = [
      place(1), place(2), place(3, { content_state: "archived_from_active_rotation", created_at: rel(60 * D) }),
    ];
    const db = makeRulesDb({
      profiles: profiles(9), trails: [{ ...trailRow }], feature_flags: flagsOn(TRAIL_EXPLORATION_FLAG),
      content_trails: members.map((m) => ({ ...m, content_state_changed_at: m.id === M(3) ? rel(TRAIL_RETEST_INTERVAL_MS + H) : null })),
      discovery_places: community([1, 2, 3]),
      rank_events: [
        ...served(1, TRAIL_EXPOSURE_MIN_EVIDENCE),
        ...served(2, TRAIL_EXPLORATION_IMPRESSION_CEILING - 50), ...served(2, 50, "save"),
        ...served(3, 10), ...served(3, 20, "save"),
      ],
      trail_member_exposures: [],
    }, { rpc });
    const r = await getTrailModules(db, T, { viewerId: U(9), pageSize: 8 });
    const where = (id: string) => r.modules.filter((m) => m.items.some((i) => i.id === id)).map((m) => m.key);
    assert.deepEqual(where(M(1)), [], "tapered: out of active rotation");
    assert.ok(where(M(2)).includes("hidden_gems"));
    assert.ok(where(M(3)).includes("just_arrived"), "rediscovered");
    assert.deepEqual(r.serveEffects!.transitions.map((t) => [t.rowId, t.from, t.to]).sort(), [
      [M(1), "just_arrived", "archived_from_active_rotation"], [M(2), "just_arrived", "growing"], [M(3), "archived_from_active_rotation", "rediscovered"],
    ].sort());
    await settleTrailModulesServe(db, T, r);
    assert.deepEqual(db.tables.content_trails.map((m) => m.content_state), ["archived_from_active_rotation", "growing", "rediscovered"]);
    const cas = db.writes.filter((w) => w.table === "content_trails" && w.op === "update");
    assert.equal(cas.length, 3);
    // A lost race: the row moved under us. The compare-and-set matches nothing and nothing is overwritten.
    db.tables.content_trails[0]!.content_state = "growing";
    await settleTrailModulesServe(db, T, { ...r, serveEffects: { ...r.serveEffects!, transitions: [r.serveEffects!.transitions.find((t) => t.rowId === M(1))!], served: [] } });
    assert.equal(db.tables.content_trails[0]!.content_state, "growing");
  });
});

describe("L5 — the Trail's own serves are counted once per member per page", () => {
  it("the rpc carries each served member once, with no viewer id", async () => {
    const db = makeRulesDb({
      profiles: profiles(9), trails: [{ ...trailRow }], feature_flags: flagsOn(TRAIL_EXPLORATION_FLAG),
      content_trails: [place(1), place(2, { content_state: "evergreen" })], discovery_places: community([1, 2]),
      rank_events: served(2, 3, "save"), trail_member_exposures: [],
    }, { rpc });
    const r = await getTrailModules(db, T, { viewerId: U(9), pageSize: 8 });
    await settleTrailModulesServe(db, T, r);
    const call = db.writes.find((w) => w.table === "trail_record_member_exposures")!;
    assert.deepEqual((call.rows.p_items as Row[]).map((i) => i.source_id).sort(), [PL(1), PL(2)].sort());
    assert.ok(!JSON.stringify(call.rows).includes(U(9)), "no viewer id");
  });
});

describe("L6 — DC-05: health orders the Trail's own modules (flag), and does not when OFF", () => {
  const seed = (flags: Row[]) => makeRulesDb({
    profiles: profiles(9), trails: [{ ...trailRow }], feature_flags: flags,
    content_trails: [
      place(1, { content_state: "evergreen", confidence: 0.95, created_at: rel(10 * D) }),
      place(2, { content_state: "featured", confidence: 0.9, created_at: rel(10 * D) }),
      place(3, { content_state: "evergreen", confidence: 0.99, contributor_id: U(5), created_at: rel(10 * D) }),
      place(4, { content_state: "evergreen", confidence: 0.98, contributor_id: U(5), created_at: rel(10 * D) }),
      place(5, { content_state: "evergreen", confidence: 0.97, contributor_id: U(5), created_at: rel(10 * D) }),
    ],
    discovery_places: [1, 2, 3, 4, 5].map((n) => ({ id: PL(n), submitted_by: null, name: `P${n}`, lat: null, lng: null })),
    rank_events: [],
  }, { rpc });
  it("contributor_concentration 3/5 > 1/3: the dominant contributor's members are served after the others, nothing removed", async () => {
    const off = await getTrailModules(seed([]), T, { viewerId: U(9), pageSize: 8 });
    const on = await getTrailModules(seed(flagsOn(TRAIL_HEALTH_ORDER_FLAG)), T, { viewerId: U(9), pageSize: 8 });
    const ev = (r: any) => r.modules.find((m: any) => m.key === "evergreen").items.map((i: any) => i.id);
    assert.deepEqual(ev(off), [M(3), M(4), M(1), M(2)], "OFF: the objective's own order (confidence), capped by §10 as before");
    assert.deepEqual(ev(on).slice(0, 2), [M(1), M(2)], "ON: the members §11 counts against the Trail come last");
    assert.deepEqual([...ev(on)].sort(), [...ev(off)].sort(), "the same members: health orders, it never erases");
  });
});

describe("L7 — an unread denominator reserves nothing", () => {
  it("the Trail's own count unreadable ⇒ explorationSlots null, not []", async () => {
    const db = makeRulesDb({
      profiles: profiles(9), trails: [{ ...trailRow }], feature_flags: flagsOn(TRAIL_EXPLORATION_FLAG),
      content_trails: [place(1)], discovery_places: community([1]), rank_events: [],
    }, { rpc, erroring: ["trail_member_exposures"] });
    const r = await getTrailModules(db, T, { viewerId: U(9), pageSize: 8 });
    assert.equal(r.modules[0]!.explorationSlots, null);
    assert.ok(r.modules[0]!.items.some((i) => i.id === M(1)), "the member is still served; only the reservation is withheld");
  });
});
