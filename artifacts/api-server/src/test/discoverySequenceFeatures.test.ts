/**
 * DC-09 — `04` §8's four behaviour chains, derived server-side.
 *
 * WHAT THE ROW ASKS FOR
 * =====================
 * `04` §8 names four high-value sequences and then states the rule this row is
 * two halves of: *"Sequence features should be derived downstream rather than
 * hard-coded into clients."*
 *
 * The PROHIBITION half already passed — no client computes a chain. This file
 * grades the OBLIGATION half: that the four chains exist as a derivation, over
 * the live 13-column `rank_events` schema, with no migration.
 *
 * WHAT THESE TESTS ARE NOT
 * ========================
 * They are not evidence that any chain has data. Discovery is dark in
 * production (13 `surface='discovery'` rows ever, latest 2026-08-15), so every
 * chain below is vacuous on the current corpus. That is a fact about traffic,
 * not about the derivation, and it is why the assertions here are about SHAPE
 * and about what the derivation refuses to claim.
 *
 * THE PROPERTY THAT MATTERS MOST
 * ==============================
 * Most of §8's step names have NOTHING in the 13-column schema that carries
 * them — no `trip_add` outcome token, no completion, no replay, no send, no
 * Trail object, no visit confirmation. A derivation that quietly reported 0 for
 * those steps would be claiming that the chain was measured and found empty.
 * They must come back `null` and NAMED.
 *
 * Run: node --import tsx/esm --test src/test/discoverySequenceFeatures.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BEHAVIOR_CHAINS,
  deriveSequenceFeatures,
  loadSequenceFeatures,
  type SequenceEvent,
} from "../lib/discoverySequenceFeatures.js";
import { loadPdeViewer } from "../lib/discoveryPde.js";

const S1 = "55555555-5555-4555-8555-555555555551";
const S2 = "55555555-5555-4555-8555-555555555552";

function ev(over: Partial<SequenceEvent>): SequenceEvent {
  return {
    user_id: "u-1",
    session_id: S1,
    item_id: "db/p1",
    outcome: "impression",
    served_at: "2026-09-01T00:00:00.000Z",
    ...over,
  };
}

/** A client whose rank_events read answers `rows`, or fails, in the PostgREST shape. */
function eventClient(opts: { rows?: any[]; error?: unknown; throws?: boolean } = {}) {
  const seen: any[] = [];
  const q: any = {
    select() { return q; },
    eq(col: string, v: any) { seen.push([col, v]); return q; },
    neq(col: string, v: any) { seen.push(["neq:" + col, v]); return q; },
    gte(col: string, v: any) { seen.push(["gte:" + col, v]); return q; },
    order() { return q; },
    limit() {
      if (opts.throws) return Promise.reject(new Error("connection reset"));
      return Promise.resolve({ data: opts.rows ?? null, error: opts.error ?? null });
    },
  };
  const client: any = { from(table: string) { seen.push(["from", table]); return q; } };
  return { client, seen };
}

const chain = (id: string) => BEHAVIOR_CHAINS.find((c) => c.id === id)!;
const feature = (f: ReturnType<typeof deriveSequenceFeatures>, id: string) =>
  f.chains.find((c) => c.id === id)!;

describe("DC-09 — the four chains are 04 §8's four chains, verbatim", () => {
  it("declares exactly four, in the order the spec lists them", () => {
    assert.equal(BEHAVIOR_CHAINS.length, 4, "§8 names four; a fifth would be invented and a third would be dropped");
    assert.deepEqual(BEHAVIOR_CHAINS.map((c) => c.chain), [
      "impression → place_open → save → trip_add",
      "video_complete → replay → send",
      "Trail open → place open → directions",
      "post → place visit → post-visit confirmation",
    ]);
  });

  it("every step says which rank_events.outcome stands for it, or WHY nothing does", () => {
    for (const c of BEHAVIOR_CHAINS) {
      for (const s of c.steps) {
        assert.ok(s.step.length > 0);
        if (s.outcome === null) {
          assert.ok(
            typeof s.unrepresentable === "string" && s.unrepresentable.length > 0,
            `${c.id}/${s.step}: a step with no token must say why, or the gap is invisible`,
          );
        } else {
          assert.equal(s.unrepresentable, null);
        }
      }
    }
  });

  it("the first chain is representable end to end; the other three are not", () => {
    assert.deepEqual(
      chain("impression_place_open_save_trip_add").steps.map((s) => s.outcome),
      ["impression", "tap", "save", "trip_add"],
      "migration 2894 admits a trip_add token of its own — it still must not borrow 'join'",
    );
    assert.equal(
      chain("impression_place_open_save_trip_add").steps[3].outcome, "trip_add",
      "'join' is the events/plans rung; borrowing it was refused and the refusal stands",
    );
    assert.deepEqual(chain("video_complete_replay_send").steps.map((s) => s.outcome), [null, null, null]);
    assert.deepEqual(chain("trail_open_place_open_directions").steps.map((s) => s.outcome), [null, "tap", null]);
    assert.deepEqual(
      chain("post_place_visit_confirmation").steps.map((s) => s.outcome),
      [null, null, null],
      "'attended' is a funnel token, not a visit confirmation (census-discovery DV-19)",
    );
  });
});

describe("DC-09 — derivation over the funnel", () => {
  const rows: SequenceEvent[] = [
    ev({ item_id: "db/p1", outcome: "save" }),        // reached impression, tap, save
    ev({ item_id: "db/p2", outcome: "tap" }),         // reached impression, tap
    ev({ item_id: "db/p3", outcome: "impression" }),  // reached impression
    ev({ item_id: "db/p4", outcome: "dismiss" }),     // impressed, then dismissed — NOT a tap
    ev({ item_id: "db/p5", outcome: "analytics" }),   // DRS scoring row — never a user event
    ev({ session_id: S2, item_id: "db/p1", outcome: "tap" }),
  ];

  it("counts distinct (session, item) pairs per step, monotone down the funnel", () => {
    const f = deriveSequenceFeatures(rows);
    const c = feature(f, "impression_place_open_save_trip_add");
    assert.equal(c.steps[0].reached, 5, "five non-analytics pairs were impressed");
    assert.equal(c.steps[1].reached, 3, "p1 and p2 in S1, and p1 in S2, reached the tap rung");
    assert.equal(c.steps[2].reached, 1, "only p1/S1 reached the save rung");
  });

  it("excludes outcome='analytics' — those are scored candidates, not events a user produced", () => {
    const f = deriveSequenceFeatures(rows);
    assert.equal(f.events, 5, "the analytics row is not a behaviour event and must not inflate any denominator");
  });

  it("a dismissed impression reached the impression step and NOT the place-open step", () => {
    const f = deriveSequenceFeatures([ev({ item_id: "db/p9", outcome: "dismiss" })]);
    const c = feature(f, "impression_place_open_save_trip_add");
    assert.equal(c.steps[0].reached, 1);
    assert.equal(c.steps[1].reached, 0, "a dismiss is terminal and is not a place open");
  });

  it("`exact` and `reached` are different questions and both are answered", () => {
    const f = deriveSequenceFeatures(rows);
    const c = feature(f, "impression_place_open_save_trip_add");
    assert.equal(c.steps[0].exact, 1, "only p3 STOPPED at impression");
    assert.equal(c.steps[0].reached, 5, "but five pairs passed through it");
  });

  // The guard this test has always carried — an unrepresentable step reports
  // null and never 0 — moved to a chain that still HAS one. It is unchanged in
  // force; `trip_add` merely stopped being an example of it (migration 2894).
  it("an unrepresentable step is null, NEVER 0 — on both counts", () => {
    const f = deriveSequenceFeatures(rows);
    const c = feature(f, "video_complete_replay_send");
    assert.equal(c.steps[0].step, "video_complete");
    assert.equal(c.steps[0].reached, null, "0 would assert that no video completed; nothing records it either way");
    assert.equal(c.steps[0].exact, null);
    assert.deepEqual(c.unrepresentableSteps, ["video_complete", "replay", "send"]);
    assert.equal(c.fullyRepresentable, false);
  });

  it("trip_add is a REAL step now: a token, no `unrepresentable`, and counts that are numbers", () => {
    const f = deriveSequenceFeatures([...rows, ev({ item_id: "db/p6", outcome: "trip_add" })]);
    const c = feature(f, "impression_place_open_save_trip_add");
    assert.equal(c.steps[3].step, "trip_add");
    assert.equal(c.steps[3].outcome, "trip_add");
    assert.equal(c.steps[3].unrepresentable, null);
    assert.equal(c.steps[3].reached, 1, "one pair reached the trip-add rung");
    assert.equal(c.steps[3].exact, 1);
    assert.deepEqual(c.unrepresentableSteps, []);
    assert.equal(c.fullyRepresentable, true, "every step of this chain now has a token");
  });

  it("a trip_add pair passed through every rung below it, and did NOT reach attended", () => {
    const f = deriveSequenceFeatures([ev({ item_id: "db/p7", outcome: "trip_add" })]);
    const c = feature(f, "impression_place_open_save_trip_add");
    assert.deepEqual(c.steps.map((s) => s.reached), [1, 1, 1, 1], "trip_add is above save, so it reached every step");
    assert.deepEqual(c.steps.map((s) => s.exact), [0, 0, 0, 1], "and stopped exactly at trip_add");
  });

  it("a chain with NO representable step reports no conversion at all", () => {
    const f = deriveSequenceFeatures(rows);
    const c = feature(f, "video_complete_replay_send");
    assert.equal(c.observedStart, null);
    assert.equal(c.observedEnd, null);
    assert.equal(c.observedConversion, null, "there is no observable prefix to divide");
    assert.deepEqual(c.unrepresentableSteps, ["video_complete", "replay", "send"]);
  });

  // Same guard, on the chain that is still a PREFIX. `Trail open → place open →
  // directions` observes only its middle step, so its conversion is 1 over a
  // window that answers neither end of the chain — and `fullyRepresentable:
  // false` is the one field that stops a reader quoting it as the chain's.
  it("observedConversion is the OBSERVABLE PREFIX's conversion, and is not the chain's", () => {
    const f = deriveSequenceFeatures(rows);
    const c = feature(f, "trail_open_place_open_directions");
    assert.equal(c.observedStart, 3);
    assert.equal(c.observedEnd, 3, "the only REPRESENTABLE step is place_open");
    assert.equal(c.observedConversion, 1);
    assert.equal(
      c.fullyRepresentable, false,
      "so a reader cannot quote observedConversion as the chain's conversion — the chain's ends are unrecorded",
    );
  });

  it("the first chain's observedConversion IS the chain's, because every step is recorded", () => {
    const f = deriveSequenceFeatures(rows);
    const c = feature(f, "impression_place_open_save_trip_add");
    assert.equal(c.observedStart, 5);
    assert.equal(c.observedEnd, 0, "no pair in this corpus reached trip_add — a real zero, over a step that is read");
    assert.equal(c.observedConversion, 0);
    assert.equal(c.fullyRepresentable, true);
  });

  it("no pair at all is zero reach for a representable step — which is NOT the same as null", () => {
    const f = deriveSequenceFeatures([]);
    const c = feature(f, "impression_place_open_save_trip_add");
    assert.equal(c.steps[0].reached, 0, "a corpus with no events really did have no impressions");
    assert.equal(c.steps[3].reached, 0, "and no trip adds — a read that RAN and found none, which is not null");
    assert.equal(
      feature(f, "video_complete_replay_send").steps[0].reached, null,
      "while a step nothing records is still null, never 0",
    );
    assert.equal(f.reason, "derived");
  });

  it("rows with no session_id are COVERAGE, not a chain — counted, never guessed into one", () => {
    const f = deriveSequenceFeatures([
      ev({ item_id: "db/p1", outcome: "save" }),
      ev({ session_id: null, item_id: "db/p2", outcome: "save" }),
    ]);
    assert.equal(f.unsessioned, 1, "a row with no session cannot be placed in a sequence and must say so");
    assert.equal(f.pairs, 1, "and must not be counted as one");
    assert.equal(f.sessions, 1);
  });
});

describe("DC-09 — loadSequenceFeatures fails closed", () => {
  it("reads rank_events scoped to the viewer and the discovery surface, inside a window", async () => {
    const { client, seen } = eventClient({ rows: [{ user_id: "u-1", session_id: S1, item_id: "db/p1", outcome: "save", served_at: "2026-09-01T00:00:00Z" }] });
    const f = await loadSequenceFeatures(client, "u-1");
    assert.equal(f.reason, "derived");
    assert.deepEqual(seen[0], ["from", "rank_events"]);
    assert.ok(seen.some(([c, v]) => c === "user_id" && v === "u-1"));
    assert.ok(seen.some(([c, v]) => c === "surface" && v === "discovery"));
    assert.ok(seen.some(([c]) => c === "gte:served_at"), "an unbounded history is not a feature window");
    assert.equal(feature(f, "impression_place_open_save_trip_add").steps[2].reached, 1);
  });

  it("a rejected read is `unreadable` with NO chain counts — never a corpus of zero", async () => {
    const f = await loadSequenceFeatures(eventClient({ error: { message: "denied" } }).client, "u-1");
    assert.equal(f.reason, "unreadable");
    assert.equal(f.events, 0);
    for (const c of f.chains) {
      for (const s of c.steps) {
        assert.equal(s.reached, null, `${c.id}/${s.step}: an unread corpus must report nothing, not zero`);
        assert.equal(s.exact, null);
      }
      assert.equal(c.observedConversion, null);
    }
  });

  it("a throwing read is `unreadable` and never escapes", async () => {
    const f = await loadSequenceFeatures(eventClient({ throws: true }).client, "u-1");
    assert.equal(f.reason, "unreadable");
    assert.equal(f.chains.length, 4, "the chains are still NAMED — a reader must see what was not derived");
  });

  it("no client is `no_client`, a different fact from a failed read", async () => {
    const f = await loadSequenceFeatures(null, "u-1");
    assert.equal(f.reason, "no_client");
    assert.equal(f.chains[0].steps[0].reached, null);
  });

  // MUTATION GUARD, added by the integrating lane after a surviving mutant.
  //
  // `fullyRepresentable` is the ONE field that stops a reader quoting
  // `observedConversion` as the chain's conversion. On the DERIVED path two
  // tests pin it. On the fail-closed path nothing did: forcing `unknownChains`
  // to return `fullyRepresentable: true` passed all seventeen tests, so a
  // refusal could have described a DIFFERENT chain from the one the derivation
  // describes — every step `null`, and the single flag saying the whole chain
  // is on file. A degraded answer must not be shaped better than a healthy one.
  //
  // The claim is structural, not about traffic: whether a step has a
  // `rank_events.outcome` standing for it cannot depend on whether a read
  // succeeded, so the refusal must report the SAME representability the
  // derivation does.
  for (const [label, load] of [
    ["a rejected read", () => loadSequenceFeatures(eventClient({ error: { message: "denied" } }).client, "u-1")],
    ["a throwing read", () => loadSequenceFeatures(eventClient({ throws: true }).client, "u-1")],
    ["no client at all", () => loadSequenceFeatures(null, "u-1")],
  ] as const) {
    it(`MUTATION GUARD: ${label} reports the SAME representability as the derivation, never a better one`, async () => {
      const refused = await loadSequenceFeatures(eventClient({ rows: [] }).client, "u-1");
      assert.equal(refused.reason, "derived", "control: an empty corpus is derived, not refused");
      const f = await load();
      assert.notEqual(f.reason, "derived");
      assert.equal(f.chains.length, refused.chains.length);
      for (const [i, c] of f.chains.entries()) {
        const d = refused.chains[i]!;
        assert.equal(c.id, d.id);
        assert.equal(
          c.fullyRepresentable, d.fullyRepresentable,
          `${c.id}: a refusal claimed representability the derivation does not`,
        );
        assert.deepEqual(
          c.unrepresentableSteps, d.unrepresentableSteps,
          `${c.id}: a refusal named a different set of unrepresentable steps`,
        );
      }
      // And the stronger fact this pins in its own right, now stated as the
      // INVARIANT rather than as a census of today's schema: `fullyRepresentable`
      // is true exactly when no step is unrepresentable. A `true` beside a
      // non-empty `unrepresentableSteps` is the mutation this kills — it is the
      // shape that lets a reader quote `observedConversion` as a chain's
      // conversion while the chain still ends at a step nothing records.
      for (const c of f.chains) {
        assert.equal(
          c.fullyRepresentable, c.unrepresentableSteps.length === 0,
          `${c.id}: fullyRepresentable=${c.fullyRepresentable} beside ${c.unrepresentableSteps.length} unrepresentable step(s)`,
        );
      }
      // On THIS schema exactly one of 04 §8's four chains is fully representable
      // (2894 gave trip_add a token); the other three still are not.
      assert.deepEqual(
        f.chains.map((c) => c.fullyRepresentable), [true, false, false, false],
      );
      assert.ok(f.chains.slice(1).every((c) => c.unrepresentableSteps.length > 0));
    });
  }
});

describe("DC-09 — discoveryPde consumes it behind its existing surface", () => {
  it("loadPdeViewer carries the sequence features on the viewer it already returns", async () => {
    const calls: string[] = [];
    const q: any = {
      select() { return q; },
      eq() { return q; },
      neq() { return q; },
      gte() { return q; },
      order() { return q; },
      maybeSingle: async () => ({ data: null, error: null }),
      limit: async () => ({ data: [{ user_id: "u-1", session_id: S1, item_id: "db/p1", outcome: "tap", served_at: "2026-09-01T00:00:00Z" }], error: null }),
      then: (res: any) => res({ data: [], error: null }),
    };
    const sc: any = { from(t: string) { calls.push(t); return q; } };

    const viewer = await loadPdeViewer(sc, "u-1", "paris");
    assert.ok(calls.includes("rank_events"));
    assert.ok(viewer.sequences, "the derivation must reach the engine, or it is a module nothing consumes");
    assert.equal(viewer.sequences!.chains.length, 4);
    assert.equal(viewer.sequences!.reason, "derived");
  });
});

// ── MUTATION GUARD, on the DERIVED path too ──────────────────────────────────
//
// The guard above runs only on the three refusal paths, because that is where a
// surviving mutant was found. The invariant it asserts — `fullyRepresentable`
// is true exactly when no step is unrepresentable — is structural and must hold
// on every path this module can return, including the healthy one. Without this
// half, a mutant that sets `fullyRepresentable: true` in `deriveSequenceFeatures`
// alone is invisible: the refusal path would agree with it, and the equality
// check above would pass with both sides wrong.
describe("DC-09 — representability is an invariant, not a per-path opinion", () => {
  const corpora: Array<[string, SequenceEvent[]]> = [
    ["an empty corpus", []],
    ["a corpus that reached trip_add", [ev({ item_id: "db/z1", outcome: "trip_add" })]],
    ["a corpus that stopped at impression", [ev({ item_id: "db/z2", outcome: "impression" })]],
  ];
  for (const [label, corpus] of corpora) {
    it(`MUTATION GUARD: ${label} reports fullyRepresentable iff nothing is unrepresentable`, () => {
      for (const c of deriveSequenceFeatures(corpus).chains) {
        assert.equal(
          c.fullyRepresentable, c.unrepresentableSteps.length === 0,
          `${c.id}: fullyRepresentable=${c.fullyRepresentable} beside ${c.unrepresentableSteps.length} unrepresentable step(s)`,
        );
        // And the two are both derived from the SAME step list, so a step with a
        // token may never appear in the unrepresentable names and vice versa.
        const named = new Set(c.unrepresentableSteps);
        for (const s of c.steps) {
          assert.equal(
            named.has(s.step), s.outcome === null,
            `${c.id}/${s.step}: the unrepresentable list disagrees with the step's own token`,
          );
        }
      }
    });
  }
});
