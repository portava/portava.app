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
import { getTrail, getTrailModules, loadViewerTrailModifier, relatedTrails, settleTrailModulesServe } from "../services/trails/TrailService.js";
import {
  decideContentTransition, rotateExplorationSlots, exposureVerdict, JUST_ARRIVED_HORIZON_MS, TRAIL_SUSTAIN_MS,
  TRAIL_EVERGREEN_MIN_AGE_MS, TRAIL_RETEST_INTERVAL_MS, TRAIL_EXPLORATION_FLAG, TRAIL_HEALTH_ORDER_FLAG,
  readStateChangedAt, readTrailOwnExposures,
} from "../services/trails/trailExploration.js";
import {
  TRAIL_CONTENT_STATES, isTrailContentTransitionAllowed, type TrailContentState,
} from "../lib/discoveryTrailObject.js";
import { TRAIL_EXPLORATION_IMPRESSION_CEILING, TRAIL_EXPOSURE_MIN_EVIDENCE } from "../lib/discoveryTrailHealth.js";
import { makeRulesDb, type FakeRulesDb, type Row } from "./helpers/fakeTrailRulesDb.js";
import { readBoundedTrailRows, MAX_TRAIL_READ_PAGES, MAX_TRAIL_READ_ROWS, TRAIL_READ_PAGE_SIZE } from "../services/trails/trailRead.js";

const H = 3_600_000, D = 24 * H;
const rel = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const U = (n: number) => `11111111-1111-4111-8111-1111111111${String(n).padStart(2, "0")}`;
const T = "22222222-2222-4222-8222-222222222201";
const PL = (n: number) => `33333333-3333-4333-8333-3333333333${String(n).padStart(2, "0")}`;
const M = (n: number) => `66666666-6666-4666-8666-6666666666${String(n).padStart(2, "0")}`;

const trailRow: Row = {
  id: T, slug: "bangkok-after-dark", title: "Bangkok After Dark", description: null, destination: "bangkok", place_scope: null,
  parent_trail_id: null, review_state: "approved", lifecycle_status: "active", created_by: U(1), created_at: rel(90 * D), updated_at: rel(90 * D),
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
  for (const stamp of ["absent", "malformed", "missing_row", "unreadable", "legacy_null", "recent", "expired"] as const) {
    it(`DC-04/DV-21: rediscovered horizon preserves ${stamp} state-stamp semantics`, async () => {
      const nowMs = Date.now();
      const stateStamp = stamp === "legacy_null" ? null
        : stamp === "malformed" ? "invalid"
        : stamp === "recent" ? new Date(nowMs - D).toISOString()
        : stamp === "expired" ? new Date(nowMs - 8 * D).toISOString()
        : undefined;
      const db = makeRulesDb({
        profiles: profiles(9), trails: [{ ...trailRow }], feature_flags: flagsOn(TRAIL_EXPLORATION_FLAG),
        content_trails: [place(1, {
          content_state: "rediscovered", created_at: new Date(nowMs - 60 * D).toISOString(),
          content_state_changed_at: stateStamp,
        })],
        discovery_places: community([1]), rank_events: [], trail_member_exposures: [],
      });
      if (stamp === "missing_row" || stamp === "unreadable") {
        const originalFrom = db.from.bind(db);
        db.from = (table: string) => {
          const builder = originalFrom(table);
          const originalSelect = builder.select.bind(builder);
          builder.select = (columns: string, options?: unknown) => table === "content_trails" && columns === "id, content_state_changed_at"
            ? { in: () => Promise.resolve(stamp === "missing_row"
              ? { data: [], error: null }
              : { data: null, error: { code: "57014", message: "timeout" } }) }
            : originalSelect(columns, options);
          return builder;
        };
      }
      const result = await getTrailModules(db, T, { viewerId: U(9), nowMs });
      const graduated = stamp === "legacy_null" || stamp === "expired";
      assert.deepEqual(result.serveEffects!.transitions, graduated
        ? [{ rowId: M(1), from: "rediscovered", to: "growing" }] : []);
      assert.deepEqual(result.modules.filter((module) => module.items.some((item) => item.id === M(1))).map((module) => module.key),
        [graduated ? "hidden_gems" : "just_arrived"]);
      assert.equal(result.modules.flatMap((module) => module.items)[0]!.contentState, graduated ? "growing" : "rediscovered");
      assert.deepEqual(db.writes, []);
    });
  }

  it("DC-04: a missing state-stamp row cannot promote a growing member using its creation date", async () => {
    const db = makeRulesDb({
      profiles: profiles(9), trails: [{ ...trailRow }], feature_flags: flagsOn(TRAIL_EXPLORATION_FLAG),
      content_trails: [place(1, { content_state: "growing", created_at: rel(60 * D) })],
      discovery_places: community([1]), rank_events: served(1, 30, "save"), trail_member_exposures: [],
    });
    const originalFrom = db.from.bind(db);
    db.from = (table: string) => {
      const builder = originalFrom(table);
      const originalSelect = builder.select.bind(builder);
      builder.select = (columns: string, options?: unknown) => table === "content_trails" && columns === "id, content_state_changed_at"
        ? { in: () => Promise.resolve({ data: [], error: null }) }
        : originalSelect(columns, options);
      return builder;
    };
    const result = await getTrailModules(db, T, { viewerId: U(9) });
    assert.deepEqual(result.serveEffects!.transitions, []);
    assert.ok(result.modules.find((module) => module.key === "hidden_gems")!.items.some((item) => item.id === M(1)));
  });

  it("DC-04: absent or malformed stamps stay unknown; explicit null still means inserted in that state", async () => {
    const validStamp = rel(D);
    const db = makeRulesDb({ content_trails: [
      { id: M(1) }, { id: M(2), content_state_changed_at: "invalid" },
      { id: M(3), content_state_changed_at: null }, { id: M(4), content_state_changed_at: validStamp },
    ] });
    const stamps = await readStateChangedAt(db, [M(1), M(2), M(3), M(4)]);
    assert.equal(stamps!.get(M(1)), undefined);
    assert.equal(stamps!.get(M(2)), undefined);
    assert.equal(stamps!.get(M(3)), null);
    assert.equal(stamps!.get(M(4)), Date.parse(validStamp));
  });

  it("DC-04/DV-21: curation cannot keep a tapered member in Local Picks or count another serve", async () => {
    const db = makeRulesDb({
      profiles: profiles(9), trails: [{ ...trailRow }], feature_flags: flagsOn(TRAIL_EXPLORATION_FLAG),
      content_trails: [place(1, { source: "curated", content_state: "growing", content_state_changed_at: rel(D) })],
      discovery_places: community([1]), rank_events: served(1, TRAIL_EXPOSURE_MIN_EVIDENCE), trail_member_exposures: [],
    }, { rpc });
    const result = await getTrailModules(db, T, { viewerId: U(9) });
    assert.deepEqual(result.serveEffects!.transitions, [{ rowId: M(1), from: "growing", to: "archived_from_active_rotation" }]);
    assert.deepEqual(result.modules.flatMap((module) => module.items), []);
    await settleTrailModulesServe(db, T, result);
    assert.equal(db.tables.content_trails[0]!.content_state, "archived_from_active_rotation");
    assert.ok(!db.writes.some((write) => write.table === "trail_record_member_exposures"));
  });

  it("DC-04/DV-21: a rested curated member returns only in its bounded retest slot", async () => {
    const db = makeRulesDb({
      profiles: profiles(9), trails: [{ ...trailRow }], feature_flags: flagsOn(TRAIL_EXPLORATION_FLAG),
      content_trails: [place(1, { source: "curated", content_state: "archived_from_active_rotation", content_state_changed_at: rel(8 * D) })],
      discovery_places: community([1]), rank_events: [], trail_member_exposures: [],
    }, { rpc });
    const result = await getTrailModules(db, T, { viewerId: U(9) });
    assert.deepEqual(result.modules.filter((module) => module.items.some((item) => item.id === M(1))).map((module) => module.key), ["just_arrived"]);
    assert.deepEqual(result.modules[0]!.explorationSlots, [M(1)]);
  });

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

describe("bounded remaining Trail lifecycle, authorization and health reads", () => {
  const NOW = Date.parse("2026-10-16T12:00:00Z");
  const DAY = 86_400_000;
  const TRAIL = "22222222-2222-4222-8222-222222222201";
  const VIEWER = "11111111-1111-4111-8111-111111111101";
  const at = (days: number) => new Date(NOW - days * DAY).toISOString();
  const trail = (id = TRAIL, overrides: Row = {}): Row => ({
    id, slug: id, title: id, lifecycle_status: "active", review_state: "approved", created_by: VIEWER,
    parent_trail_id: null, created_at: at(90), updated_at: at(1), ...overrides,
  });
  const member = (id: string, overrides: Row = {}): Row => ({
    id, trail_id: TRAIL, source_type: "place", source_id: id, relationship: "supporting", signal: null,
    source: "user", confidence: 0.8, contributor_id: null, content_state: "just_arrived", created_at: at(1), ...overrides,
  });
  const exposure = (id: string, impressions = 1, days = 0): Row => ({
    trail_id: TRAIL, source_type: "place", source_id: id, served_on: at(days).slice(0, 10), impressions,
  });

  interface QueryRead { table: string; columns: string; offset: number; ordered: boolean; reviewFiltered: boolean; countRequested: boolean; limit: number | null }

  function cappedReads(db: FakeRulesDb, options: {
    cap?: number;
    omitCount?: boolean;
    reverseUnorderedReviews?: boolean;
    result?: (query: QueryRead) => { data: any; error: any; count?: number | null } | undefined;
  } = {}): QueryRead[] {
    const reads: QueryRead[] = [];
    const originalFrom = db.from.bind(db);
    db.from = (table: string) => {
      const builder = originalFrom(table);
      const query: QueryRead = { table, columns: "", offset: 0, ordered: false, reviewFiltered: false, countRequested: false, limit: null };
      const select = builder.select.bind(builder);
      const range = builder.range.bind(builder);
      const order = builder.order.bind(builder);
      const limit = builder.limit.bind(builder);
      const inFilter = builder.in.bind(builder);
      const then = builder.then.bind(builder);
      builder.select = (columns: string, settings?: { count?: string }) => {
        query.columns = columns; query.countRequested = settings?.count === "exact"; return select(columns, settings);
      };
      builder.range = (start: number, end: number) => { query.offset = start; return range(start, end); };
      builder.order = (column: string, settings?: unknown) => { query.ordered = true; return order(column, settings); };
      builder.limit = (size: number) => { query.limit = size; return limit(size); };
      builder.in = (column: string, values: unknown[]) => { if (column === "review_state") query.reviewFiltered = true; return inFilter(column, values); };
      builder.then = (resolve: any, reject: any) => then((response: any) => {
        reads.push({ ...query });
        const replacement = options.result?.(query);
        if (replacement) return replacement;
        if (!Array.isArray(response.data)) return response;
        let data = response.data;
        if (options.reverseUnorderedReviews && table === "trail_edges" && query.columns.includes("review_state") && !query.ordered) data = [...data].reverse();
        return { ...response, data: data.slice(0, options.cap ?? 1000), ...(options.omitCount ? { count: undefined } : {}) };
      }).then(resolve, reject);
      return builder;
    };
    return reads;
  }

  describe("DV-21/DV-22 — complete bounded Trail exposure denominators", () => {
    it("counts daily rows beyond PostgREST's first 1,000 results", async () => {
      const db = makeRulesDb({ trail_member_exposures: [
        ...Array.from({ length: 1000 }, (_, index) => exposure(`a-${index}`)), exposure("z-ceiling", 500),
      ] });
      cappedReads(db);
      const counts = await readTrailOwnExposures(db, TRAIL, NOW);
      assert.equal(counts?.["place:z-ceiling"], 500);
    });

    it("never grants an at-ceiling member a new reservation after a truncated read", async () => {
      const db = makeRulesDb({
        trails: [trail()], feature_flags: [{ flag: TRAIL_EXPLORATION_FLAG, enabled: true }],
        content_trails: [member("z-ceiling", { created_at: at(2) }), member("fresh")],
        trail_member_exposures: [...Array.from({ length: 1000 }, (_, index) => exposure(`a-${index}`)), exposure("z-ceiling", 500)],
      });
      cappedReads(db);
      const result = await getTrailModules(db, TRAIL, { nowMs: NOW });
      assert.equal(result.refusal, null);
      assert.deepEqual(result.modules.find((module) => module.key === "just_arrived")?.explorationSlots, ["fresh"]);
      assert.deepEqual(db.writes, []);
    });

    for (const omitCount of [false, true]) {
      it(`continues short server-capped pages without skipping daily rows (count omitted: ${omitCount})`, async () => {
        const db = makeRulesDb({ trail_member_exposures: Array.from({ length: 7 }, (_, index) => exposure("same", 2, index)) });
        const reads = cappedReads(db, { cap: 2, omitCount });
        assert.deepEqual(await readTrailOwnExposures(db, TRAIL, NOW), { "place:same": 14 });
        assert.deepEqual(reads.slice(0, 4).map((query) => query.offset), [0, 2, 4, 6]);
      });
    }

    for (const failure of ["error", "malformed", "throw"] as const) {
      it(`discards accumulated counts when a later page is ${failure}`, async () => {
        const db = makeRulesDb({ trail_member_exposures: Array.from({ length: 7 }, (_, index) => exposure("same", 2, index)) });
        cappedReads(db, { cap: 2, result: (query) => {
          if (query.offset < 2) return undefined;
          if (failure === "throw") throw new Error("transport failed");
          return { data: null, error: failure === "error" ? { code: "57014" } : null };
        } });
        assert.equal(await readTrailOwnExposures(db, TRAIL, NOW), null);
      });
    }
  });

  describe("DC-05 — report health never mistakes a partial read for a complete numerator", () => {
    const seed = () => ({
      trails: [trail()], content_trails: [member("a"), member("b"), member("c"), member("d")],
      trail_follows: [{ trail_id: TRAIL, user_id: VIEWER }],
      trail_reports: [
        ...Array.from({ length: 1000 }, (_, index) => ({ id: `a-${index}`, trail_id: TRAIL, reported_by: "reporter", content_trail_id: "a", resolution: null })),
        { id: "z-distinct", trail_id: TRAIL, reported_by: "another", content_trail_id: "b", resolution: null },
      ],
    });

    for (const read of [getTrail, getTrailModules]) {
      it(`${read.name}: deduplicates reports across all pages before computing health`, async () => {
        const db = makeRulesDb(seed());
        cappedReads(db);
        const result = read === getTrail ? await getTrail(db, TRAIL, NOW) : await getTrailModules(db, TRAIL, { nowMs: NOW });
        assert.equal(result.health?.metrics.report_rate, 0.5);
        assert.deepEqual(db.writes, []);
      });
    }

    it("the followed-Trail multiplier uses the same complete report counts as the page", async () => {
      const complete = await loadViewerTrailModifier(makeRulesDb(seed()), VIEWER, ["a"], { nowMs: NOW });
      const db = makeRulesDb(seed());
      cappedReads(db);
      assert.deepEqual(await loadViewerTrailModifier(db, VIEWER, ["a"], { nowMs: NOW }), complete);
    });

    for (const failure of ["error", "malformed", "throw"] as const) {
      it(`a ${failure} after the first report page leaves report_rate unmeasured`, async () => {
        const db = makeRulesDb(seed());
        cappedReads(db, { result: (query) => {
          if (query.table !== "trail_reports" || query.offset === 0) return undefined;
          if (failure === "throw") throw new Error("transport failed");
          return { data: null, error: failure === "error" ? { code: "57014" } : null };
        } });
        const result = await getTrail(db, TRAIL, NOW);
        assert.equal(result.refusal, null);
        assert.equal(result.health?.metrics.report_rate, null);
        assert.ok(result.health?.unmeasured.includes("report_rate"));
      });
    }
  });

  describe("DV-24/DC-20 — an incomplete review read cannot authorize navigation", () => {
    it("same-count review churn cannot authorize a skipped pending candidate", async () => {
      const targetId = (number: number) => `11111111-1111-4111-8111-${String(number).padStart(12, "0")}`;
      const targets = Array.from({ length: TRAIL_READ_PAGE_SIZE + 1 }, (_, index) => targetId(index + 1));
      const edge = (id: string) => ({
        from_trail_id: TRAIL, to_trail_id: id, edge_type: "related", strength: 0.5, review_state: "pending",
      });
      const db = makeRulesDb({
        trails: [trail(), ...targets.map((id) => trail(id)), trail(targetId(TRAIL_READ_PAGE_SIZE + 2))],
        trail_edges: targets.map(edge),
      });
      const originalFrom = db.from.bind(db);
      const reviewPages: Array<{ count: number; rows: number }> = [];
      db.from = (table: string) => {
        const builder = originalFrom(table);
        const select = builder.select.bind(builder);
        const then = builder.then.bind(builder);
        let columns = "";
        builder.select = (value: string, options?: unknown) => { columns = value; return select(value, options); };
        builder.then = (resolve: any, reject: any) => then((response: any) => {
          if (table === "trail_edges" && columns.includes("review_state")) {
            reviewPages.push({ count: response.count, rows: response.data.length });
            if (reviewPages.length === 1) {
              response = structuredClone(response);
              db.tables.trail_edges![0]!.review_state = "accepted";
              db.tables.trail_edges!.push(edge(targetId(TRAIL_READ_PAGE_SIZE + 2)));
            }
          }
          return response;
        }).then(resolve, reject);
        return builder;
      };
      const result = await relatedTrails(db, TRAIL);
      assert.equal(db.tables.trail_edges!.find((row) => row.to_trail_id === targets.at(-1))!.review_state, "pending");
      assert.ok(!result.edges.some((row) => row.trail.id === targets.at(-1)), "unchanged totals do not prove candidate authorization");
      assert.equal(result.refusal, "db_error", "an over-budget single-response snapshot must refuse");
      assert.deepEqual(reviewPages, [{ count: TRAIL_READ_PAGE_SIZE + 1, rows: TRAIL_READ_PAGE_SIZE }]);
      assert.deepEqual(db.writes, []);
    });

    const seed = () => ({
      trails: [trail(), trail("pending-1"), trail("accepted"), trail("pending-2"), trail("pending-3")],
      trail_edges: ["pending-1", "accepted", "pending-2", "pending-3"].map((id) => ({
        from_trail_id: TRAIL, to_trail_id: id, edge_type: "related", strength: 0.5,
        review_state: id === "accepted" ? "accepted" : "pending",
      })),
    });

    it("refuses a server-capped candidate response rather than composing review pages", async () => {
      const db = makeRulesDb(seed());
      const reads = cappedReads(db, { cap: 2, reverseUnorderedReviews: true });
      const result = await relatedTrails(db, TRAIL);
      assert.deepEqual(result, { refusal: "db_error", edges: [] });
      assert.equal(reads.filter((query) => query.table === "trail_edges").length, 1);
    });

    it("authorizes only explicitly accepted candidates from the same bounded response", async () => {
      const db = makeRulesDb(seed());
      const reads = cappedReads(db);
      const result = await relatedTrails(db, TRAIL);
      assert.equal(result.refusal, null);
      assert.deepEqual(result.edges.map((edge) => edge.trail.id), ["accepted"]);
      const edgeReads = reads.filter((query) => query.table === "trail_edges");
      assert.equal(edgeReads.length, 2);
      for (const query of edgeReads) {
        assert.ok(query.columns.includes("review_state") && query.columns.includes("strength"));
        assert.equal(query.reviewFiltered, false, "pointer fallback requires evidence of all corresponding declarations");
        assert.equal(query.countRequested, true);
        assert.equal(query.limit, TRAIL_READ_PAGE_SIZE);
        assert.equal(query.offset, 0);
      }
    });

    for (const failure of ["error", "malformed", "throw"] as const) {
      it(`discards outgoing candidates when the incoming review response is ${failure}`, async () => {
        const db = makeRulesDb(seed());
        let reviewReads = 0;
        cappedReads(db, { result: (query) => {
          if (query.table !== "trail_edges" || !query.columns.includes("review_state")) return undefined;
          reviewReads += 1;
          if (reviewReads === 1) return undefined;
          if (failure === "throw") throw new Error("transport failed");
          return { data: null, error: failure === "error" ? { code: "57014" } : null };
        } });
        const result = await relatedTrails(db, TRAIL);
        assert.equal(result.refusal, "db_error");
        assert.deepEqual(result.edges, []);
        assert.equal(reviewReads, 2);
      });
    }

    it("a null review payload is unknown, never an empty deny list", async () => {
      const db = makeRulesDb(seed());
      cappedReads(db, { result: (query) => query.table === "trail_edges" && query.columns.includes("review_state")
        ? { data: null, error: null } : undefined });
      assert.deepEqual(await relatedTrails(db, TRAIL), { refusal: "db_error", edges: [] });
    });

    for (const code of ["42703", "PGRST204", "42P01"]) {
      it(`does not treat incoming ${code} after a successful modern read as a pre-review schema`, async () => {
        const db = makeRulesDb(seed());
        let reviewReads = 0;
        cappedReads(db, { result: (query) => {
          if (query.table !== "trail_edges" || !query.columns.includes("review_state")) return undefined;
          reviewReads += 1;
          return reviewReads === 2 ? { data: null, error: { code } } : undefined;
        } });
        assert.deepEqual(await relatedTrails(db, TRAIL), { refusal: "db_error", edges: [] });
        assert.equal(reviewReads, 2);
      });
    }

    it("an empty successful outgoing response still establishes the modern schema", async () => {
      const db = makeRulesDb({ trails: [trail()], trail_edges: [] });
      let reviewReads = 0;
      cappedReads(db, { result: (query) => {
        if (query.table !== "trail_edges" || !query.columns.includes("review_state")) return undefined;
        reviewReads += 1;
        return reviewReads === 2 ? { data: null, error: { code: "42703" } } : undefined;
      } });
      assert.deepEqual(await relatedTrails(db, TRAIL), { refusal: "db_error", edges: [] });
    });

    for (const code of ["42703", "PGRST204"]) {
      it(`preserves proposal child navigation when the first read confirms legacy ${code}`, async () => {
        const db = makeRulesDb({
          trails: [trail(), trail("child", { parent_trail_id: TRAIL })],
          trail_edges: [{ from_trail_id: TRAIL, to_trail_id: "child", edge_type: "child", strength: 0.8 }],
        });
        const reads = cappedReads(db, { result: (query) => query.table === "trail_edges" && query.columns.includes("review_state")
          ? { data: null, error: { code, message: "column trail_edges.review_state does not exist" } } : undefined });
        const result = await relatedTrails(db, TRAIL);
        assert.equal(result.refusal, null);
        assert.deepEqual(result.edges.map((edge) => [edge.trail.id, edge.strength]), [["child", 0.8]]);
        const edgeReads = reads.filter((query) => query.table === "trail_edges");
        assert.equal(edgeReads.length, 3);
        assert.equal(edgeReads.filter((query) => query.columns.includes("review_state")).length, 1);
      });
    }

    it("an unrelated missing-column error does not authorize a legacy retry", async () => {
      const db = makeRulesDb(seed());
      const reads = cappedReads(db, { result: (query) => query.table === "trail_edges" && query.columns.includes("review_state")
        ? { data: null, error: { code: "42703", message: "column trail_edges.strength does not exist" } } : undefined });
      assert.deepEqual(await relatedTrails(db, TRAIL), { refusal: "trails_unavailable", edges: [] });
      assert.equal(reads.filter((query) => query.table === "trail_edges").length, 1);
    });

    it("an incomplete legacy retry cannot establish pointer fallback permission", async () => {
      const db = makeRulesDb({ trails: [trail(), trail("child", { parent_trail_id: TRAIL })] });
      cappedReads(db, { result: (query) => {
        if (query.table !== "trail_edges") return undefined;
        return query.columns.includes("review_state")
          ? { data: null, error: { code: "42703", message: "column trail_edges.review_state does not exist" } }
          : { data: [], error: null };
      } });
      assert.deepEqual(await relatedTrails(db, TRAIL), { refusal: "db_error", edges: [] });
    });

    it("an absent edge table is unavailable, never evidence of absent declarations", async () => {
      const db = makeRulesDb({ trails: [trail(), trail("child", { parent_trail_id: TRAIL })] }, { missing: ["trail_edges"] });
      assert.deepEqual(await relatedTrails(db, TRAIL), { refusal: "trails_unavailable", edges: [] });
    });

    for (const reviewState of ["pending", "rejected", "unknown", null, undefined]) {
      it(`a ${String(reviewState)} child declaration cannot be bypassed by either parent pointer`, async () => {
        const db = makeRulesDb({
          trails: [trail(), trail("child", { parent_trail_id: TRAIL })],
          trail_edges: [{ from_trail_id: TRAIL, to_trail_id: "child", edge_type: "child", strength: 1, review_state: reviewState }],
        });
        assert.deepEqual(await relatedTrails(db, TRAIL), { refusal: null, edges: [] });
        assert.deepEqual(await relatedTrails(db, "child"), { refusal: null, edges: [] });
      });
    }

    for (const declared of [false, true]) {
      it(`preserves bidirectional parent navigation with ${declared ? "an accepted declaration" : "proven declaration absence"}`, async () => {
        const db = makeRulesDb({
          trails: [trail(), trail("child", { parent_trail_id: TRAIL })],
          trail_edges: declared ? [{ from_trail_id: TRAIL, to_trail_id: "child", edge_type: "child", strength: 0.8, review_state: "accepted" }] : [],
        });
        const down = await relatedTrails(db, TRAIL);
        const up = await relatedTrails(db, "child");
        assert.equal(down.refusal, null);
        assert.equal(up.refusal, null);
        assert.deepEqual(down.edges.map((edge) => [edge.trail.id, edge.direction, edge.strength]), [["child", "out", declared ? 0.8 : 1]]);
        assert.deepEqual(up.edges.map((edge) => [edge.trail.id, edge.direction, edge.strength]), [[TRAIL, "in", declared ? 0.8 : 1]]);
      });
    }

    for (const count of [undefined, null, -1, 0.5, 0, 2, TRAIL_READ_PAGE_SIZE + 1]) {
      it(`cannot infer child-edge absence from an invalid or incomplete count ${String(count)}`, async () => {
        const db = makeRulesDb({ trails: [trail(), trail("child", { parent_trail_id: TRAIL })] });
        cappedReads(db, { result: (query) => query.table === "trail_edges" ? {
          data: [{ from_trail_id: TRAIL, to_trail_id: "other", edge_type: "related", strength: 1, review_state: "accepted" }],
          error: null, count,
        } : undefined });
        assert.deepEqual(await relatedTrails(db, TRAIL), { refusal: "db_error", edges: [] });
      });
    }

    it("cannot infer pointer absence from a malformed edge identity", async () => {
      const db = makeRulesDb({ trails: [trail(), trail("child", { parent_trail_id: TRAIL })] });
      cappedReads(db, { result: (query) => query.table === "trail_edges"
        ? { data: [{ review_state: "pending" }], error: null, count: 1 } : undefined });
      assert.deepEqual(await relatedTrails(db, TRAIL), { refusal: "db_error", edges: [] });
    });

    for (const direction of ["out", "in"] as const) {
      it(`accepts the exact ${TRAIL_READ_PAGE_SIZE}-edge ${direction} snapshot without an extra page`, async () => {
        const neighbours = Array.from({ length: TRAIL_READ_PAGE_SIZE }, (_, index) => `neighbour-${index}`);
        const db = makeRulesDb({
          trails: [trail(), ...neighbours.map((id) => trail(id))],
          trail_edges: neighbours.map((id, index) => ({
            from_trail_id: direction === "out" ? TRAIL : id, to_trail_id: direction === "out" ? id : TRAIL,
            edge_type: "related", strength: 1, review_state: index === 0 ? "accepted" : "pending",
          })),
        });
        const reads = cappedReads(db);
        const result = await relatedTrails(db, TRAIL);
        assert.equal(result.refusal, null);
        assert.deepEqual(result.edges.map((edge) => [edge.trail.id, edge.direction]), [[neighbours[0], direction]]);
        assert.equal(reads.filter((query) => query.table === "trail_edges").length, 2);
      });
    }
  });

  describe("DC-04/DC-05 — archived Trails no longer influence a follower's Discovery ranking", () => {
    it("a retained follow on an archived, approved Trail contributes neither IDs nor affinity", async () => {
      const db = makeRulesDb({
        trails: [trail(TRAIL, { lifecycle_status: "archived" })],
        trail_follows: [{ trail_id: TRAIL, user_id: VIEWER }], content_trails: [member("place")],
      });
      assert.deepEqual(await loadViewerTrailModifier(db, VIEWER, ["place"], { nowMs: NOW }), {
        refusal: null, trailAffinity: {}, followedTrailIds: [],
      });
      assert.ok(!db.reads.includes("content_trails"));
      assert.deepEqual(db.writes, []);
    });
  });

  describe("Trail complete-read budgets and consistency", () => {
    it("a count that disappears on a later page cannot certify completion", async () => {
      const result = await readBoundedTrailRows(async (from) => ({ data: [{ id: from }], error: null, count: from === 0 ? 2 : null }));
      assert.equal(result.data, null);
      assert.equal(result.error?.code, "TRAIL_READ_INCOMPLETE");
    });

    it("accepts an exactly measured row budget without an unbounded probe", async () => {
      let calls = 0;
      const result = await readBoundedTrailRows(async (from, to) => {
        calls += 1;
        return { data: Array.from({ length: to - from + 1 }, (_, index) => ({ id: from + index })), error: null, count: MAX_TRAIL_READ_ROWS };
      });
      assert.equal(result.error, null);
      assert.equal(result.data?.length, MAX_TRAIL_READ_ROWS);
      assert.equal(calls, MAX_TRAIL_READ_ROWS / TRAIL_READ_PAGE_SIZE);
    });

    it("refuses a known over-budget result without fetching more pages", async () => {
      let calls = 0;
      const result = await readBoundedTrailRows(async () => {
        calls += 1;
        return { data: [{ id: "first" }], error: null, count: MAX_TRAIL_READ_ROWS + 1 };
      });
      assert.equal(result.data, null);
      assert.equal(result.error?.code, "TRAIL_READ_INCOMPLETE");
      assert.equal(calls, 1);
    });

    it("a full row budget without a total is unknown rather than a fabricated complete result", async () => {
      let calls = 0;
      const result = await readBoundedTrailRows(async (from, to) => {
        calls += 1;
        return { data: Array.from({ length: to - from + 1 }, (_, index) => ({ id: from + index })), error: null };
      });
      assert.equal(result.data, null);
      assert.equal(result.error?.code, "TRAIL_READ_INCOMPLETE");
      assert.equal(calls, MAX_TRAIL_READ_ROWS / TRAIL_READ_PAGE_SIZE);
    });

    it("a server that returns one row forever still exhausts a bounded request budget", async () => {
      let calls = 0;
      const result = await readBoundedTrailRows(async (from) => {
        calls += 1;
        return { data: [{ id: from }], error: null };
      });
      assert.equal(result.data, null);
      assert.equal(result.error?.code, "TRAIL_READ_INCOMPLETE");
      assert.equal(calls, MAX_TRAIL_READ_PAGES);
    });

    for (const changedCount of [1, 3]) {
      it(`discards all rows when the total changes from 2 to ${changedCount} between pages`, async () => {
        const result = await readBoundedTrailRows(async (from) => ({ data: [{ id: from }], error: null, count: from === 0 ? 2 : changedCount }));
        assert.equal(result.data, null);
        assert.equal(result.error?.code, "TRAIL_READ_INCOMPLETE");
      });
    }

    it("an empty page before the known total is reached is incomplete", async () => {
      const result = await readBoundedTrailRows(async (from) => ({ data: from === 0 ? [{ id: "first" }] : [], error: null, count: 2 }));
      assert.equal(result.data, null);
      assert.equal(result.error?.code, "TRAIL_READ_INCOMPLETE");
    });

    it("an empty successful query measures zero rather than unknown", async () => {
      assert.deepEqual(await readBoundedTrailRows(async () => ({ data: [], error: null, count: 0 })), { data: [], error: null });
    });
  });
});
