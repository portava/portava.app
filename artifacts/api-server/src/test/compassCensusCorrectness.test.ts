/**
 * compassCensusCorrectness — the two census-compass BUILT-BUT-WRONG rows this
 * lane closed, each pinned by the claim its census row makes.
 *
 *   A. CX-04 (Sensing `:148`) — "nothing reads the model's prose back against
 *      the confidence band of its inputs". `compass/CompassGroundingEnvelope.ts`
 *      does, and these cases pin BOTH halves: it fires on a claim the turn's
 *      tool results cannot support, and it stays silent on a claim they can and
 *      on a claim the model already hedged. A guard that fires on correctly
 *      hedged prose gets turned off, so the negative cases are the load-bearing
 *      ones.
 *
 *   B. CH-03 (Highlights/Memories `:742`) — "a graph NODE built from a memory
 *      persists after that memory is deleted: the only pruning is of stale
 *      city/time-slice keys". `reconcileExperienceNodes` removes it, and
 *      REFUSES to remove anything in a batch whose deciding read failed —
 *      which is the case that separates a revocation from a truncation.
 *
 * Runtime: node:test + node:assert. No DB, no network.
 * Run: node --import tsx/esm --test src/test/compassCensusCorrectness.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  enforceCompassGroundingEnvelope,
  readGroundingEvidence,
  EMPTY_GROUNDING_EVIDENCE,
} from "../compass/CompassGroundingEnvelope.js";
import { reconcileExperienceNodes } from "../compass/CompassGraphEngine.js";

/* ── A tiny Supabase fake, scoped to the three tables the prune touches ────── */

type Row = Record<string, unknown>;

interface FakeOpts {
  /** Tables whose SELECT resolves with an error instead of rows. */
  failSelect?: Set<string>;
}

function makeFake(store: Record<string, Row[]>, opts: FakeOpts = {}) {
  const deletes: Array<{ table: string; ids: string[] }> = [];

  function builder(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let isDelete = false;
    let inIds: string[] | null = null;

    const b: any = new Proxy({}, {
      get(_t, prop: string) {
        if (prop === "then") {
          return (resolve: Function) => {
            if (isDelete) {
              const matched = (store[table] ?? []).filter((r) => filters.every((f) => f(r)));
              store[table] = (store[table] ?? []).filter((r) => !matched.includes(r));
              deletes.push({ table, ids: inIds ?? [] });
              return resolve({ data: matched, error: null });
            }
            if (opts.failSelect?.has(table)) {
              return resolve({ data: null, error: { message: `${table} unreadable` } });
            }
            return resolve({ data: (store[table] ?? []).filter((r) => filters.every((f) => f(r))), error: null });
          };
        }
        if (prop === "delete") return () => { isDelete = true; return b; };
        if (prop === "eq")  return (k: string, v: unknown) => { filters.push((r) => r[k] === v); return b; };
        if (prop === "neq") return (k: string, v: unknown) => { filters.push((r) => r[k] !== v); return b; };
        if (prop === "in")  return (k: string, v: unknown[]) => { inIds = v.map(String); filters.push((r) => v.includes(r[k] as never)); return b; };
        return (..._a: unknown[]) => b;
      },
    });
    return b;
  }

  return { client: { from: (name: string) => builder(name) } as any, deletes };
}

const NODE = (id: string, key: string) => ({ id, node_key: key, node_type: "experience" });

/* ── A. CX-04 — the output boundary ───────────────────────────────────────── */

describe("A. CX-04 — Compass prose is read back against the confidence band of its inputs", () => {
  it("A1 — a live claim with no verified_live datum anywhere in the turn is corrected, not published bare", () => {
    const toolResults = [
      { places: [{ id: "p1", name: "Bar One", confidence: { sourceClass: "historical", label: "Historical" } }] },
    ];
    const ev = readGroundingEvidence(toolResults);
    assert.equal(ev.hasVerifiedLive, false);
    assert.deepEqual(ev.sourceClasses, ["historical"]);

    const r = enforceCompassGroundingEnvelope("Bar One is packed right now — head over.", ev);
    assert.equal(r.ok, false);
    assert.deepEqual(r.violations.map((v) => v.kind), ["live_claim_without_verified_source"]);
    assert.match(r.text, /Grounding note:/);
    assert.match(r.text, /last-known/);
    // The model's own words survive. A boundary that deletes grounded prose to
    // punish one sentence tells the user less than it found.
    assert.match(r.text, /Bar One is packed right now/);
  });

  it("A2 — the SAME sentence is published untouched when a tool did check live", () => {
    const ev = readGroundingEvidence([
      { place: { id: "p1", liveStatus: { available: true }, confidence: { sourceClass: "verified_live" } } },
    ]);
    assert.equal(ev.hasVerifiedLive, true);
    const r = enforceCompassGroundingEnvelope("Bar One is packed right now — head over.", ev);
    assert.equal(r.ok, true);
    assert.equal(r.correction, null);
    assert.equal(r.text, "Bar One is packed right now — head over.");
  });

  it("A3 — a hedged sentence is never flagged, because the CONFIDENCE RULE asks for exactly that wording", () => {
    const ev = readGroundingEvidence([{ confidence: { sourceClass: "historical" } }]);
    for (const hedged of [
      "Live status can't be verified right now, so this is last-known: Bar One is usually packed at this hour.",
      "Based on past visits it is typically busy right now; I could not check live.",
    ]) {
      const r = enforceCompassGroundingEnvelope(hedged, ev);
      assert.equal(r.ok, true, `flagged a hedged sentence: ${hedged}`);
    }
  });

  it("A4 — the spec's own example: 'everyone is dancing' with no crowd datum", () => {
    const r = enforceCompassGroundingEnvelope(
      "Club Nine is worth the trip. Everyone is dancing.",
      EMPTY_GROUNDING_EVIDENCE,
    );
    assert.equal(r.ok, false);
    assert.ok(r.violations.some((v) => v.kind === "crowd_claim_without_observation"));
    assert.match(r.text, /no crowd reading/);
  });

  it("A5 — a crowd datum in the turn licenses the same sentence", () => {
    const ev = readGroundingEvidence([{ venue: { crowdLevel: "packed" } }]);
    assert.equal(ev.hasCrowdDatum, true);
    const r = enforceCompassGroundingEnvelope("Club Nine is worth the trip. Everyone is dancing.", ev);
    assert.equal(r.ok, true);
  });

  it("A6 — an invented wait time is caught; a measured one is not", () => {
    const bare = enforceCompassGroundingEnvelope("The queue is about 20 minutes.", EMPTY_GROUNDING_EVIDENCE);
    assert.equal(bare.ok, false);
    assert.ok(bare.violations.some((v) => v.kind === "wait_time_without_source"));

    const measured = readGroundingEvidence([{ venue: { queueWaitMinutes: 20 } }]);
    assert.equal(measured.hasWaitDatum, true);
    assert.equal(enforceCompassGroundingEnvelope("The queue is about 20 minutes.", measured).ok, true);
  });

  it("A7 — a NULL reading is not a reading: `waitMinutes: null` does not license a wait claim", () => {
    // The fail-open this closes: a tool that answers "I could not measure it"
    // must not count as evidence that it did.
    const ev = readGroundingEvidence([{ venue: { waitMinutes: null, crowdLevel: null } }]);
    assert.equal(ev.hasWaitDatum, false);
    assert.equal(ev.hasCrowdDatum, false);
  });

  it("A8 — evidence is read from ANY depth of a tool result, and from every tool in the turn", () => {
    const ev = readGroundingEvidence([
      { a: { b: { c: [{ confidence: { sourceClass: "community_reported" } }] } } },
      { d: [[{ confidence: { sourceClass: "verified_live" } }]] },
    ]);
    assert.equal(ev.hasVerifiedLive, true);
    assert.deepEqual(ev.sourceClasses, ["community_reported", "verified_live"]);
  });

  it("A9 — an ordinary answer with no current-conditions claim is never touched", () => {
    const r = enforceCompassGroundingEnvelope(
      "Three ideas for tonight: Bar One for cocktails, Club Nine for music, and the night market for food.",
      EMPTY_GROUNDING_EVIDENCE,
    );
    assert.equal(r.ok, true);
    assert.equal(r.correction, null);
  });

  it("A10 — one note per KIND, in a fixed order, however many sentences offend", () => {
    const r = enforceCompassGroundingEnvelope(
      "Bar One is busy right now. Club Nine is packed right now. The queue is 30 minutes.",
      EMPTY_GROUNDING_EVIDENCE,
    );
    assert.equal(r.ok, false);
    const notes = (r.correction ?? "").split("Grounding note:").join("");
    assert.equal(notes.match(/no source checked live/g)?.length, 1);
    assert.equal(notes.match(/no wait or queue reading/g)?.length, 1);
    assert.ok(notes.indexOf("no source checked live") < notes.indexOf("no wait or queue reading"));
  });
});

/* ── B. CH-03 — deleted Memories leave the graph ──────────────────────────── */

describe("B. CH-03 — an experience node whose Memory is gone is revoked", () => {
  it("B1 — a deleted Memory's node and its edges are removed; a live Memory's are not", async () => {
    const store: Record<string, Row[]> = {
      compass_graph_nodes: [NODE("n1", "mem-live"), NODE("n2", "mem-deleted")],
      memories: [{ id: "mem-live", state: "published", visibility: "public" }],
      compass_graph_edges: [
        { id: "e1", src_type: "person", src_key: "u1", dst_type: "experience", dst_key: "mem-deleted" },
        { id: "e2", src_type: "experience", src_key: "mem-deleted", dst_type: "city", dst_key: "cebu" },
        { id: "e3", src_type: "experience", src_key: "mem-live", dst_type: "city", dst_key: "cebu" },
      ],
    };
    const { client } = makeFake(store);
    const r = await reconcileExperienceNodes(client);

    assert.equal(r.examined, 2);
    assert.equal(r.nodesDeleted, 1);
    assert.equal(r.edgesDeleted, 2);
    assert.equal(r.undecided, 0);
    assert.equal(r.unresolved, false);
    assert.deepEqual(store.compass_graph_nodes!.map((n) => n.node_key), ["mem-live"]);
    assert.deepEqual(store.compass_graph_edges!.map((e) => e.id), ["e3"]);
  });

  it("B2 — EVERY rung that is not `public` is revoked, not just `only_me`", async () => {
    // THE ROW THIS CASE EXISTS FOR. Two lanes fixed CH-03 independently and one
    // of them screened on `visibility <> 'only_me'` — which keeps every NAMED
    // audience (friends_only, trip_crew, circle_only, custom) in the public
    // world model for good, because the builder no longer writes those rows but
    // an inherited one is never asked about again. The surviving sweep decides
    // through `isPublicWorldMemory`, the same predicate the builder gates its
    // write on, so `mem-friends` below is doomed. Under the discarded predicate
    // this test reads nodesDeleted: 5 instead of 6 and the node survives.
    const store: Record<string, Row[]> = {
      compass_graph_nodes: [
        NODE("n1", "mem-private"), NODE("n2", "mem-draft"), NODE("n3", "mem-friends"),
        NODE("n4", "mem-crew"), NODE("n5", "mem-archived"), NODE("n6", "mem-public"),
      ],
      memories: [
        { id: "mem-private", state: "published", visibility: "only_me" },
        { id: "mem-draft", state: "draft", visibility: "public" },
        { id: "mem-friends", state: "published", visibility: "friends_only" },
        { id: "mem-crew", state: "published", visibility: "trip_crew" },
        { id: "mem-archived", state: "archived", visibility: "public" },
        { id: "mem-public", state: "published", visibility: "public" },
      ],
      compass_graph_edges: [],
    };
    const { client } = makeFake(store);
    const r = await reconcileExperienceNodes(client);
    assert.equal(r.examined, 6);
    assert.equal(r.nodesDeleted, 5, "only the `public`, `published` Memory keeps its node");
    assert.deepEqual(store.compass_graph_nodes!.map((n) => n.node_key), ["mem-public"]);
  });

  it("B3 — AN UNREADABLE `memories` TABLE DELETES NOTHING, and says so", async () => {
    // This is the case that separates a revocation from a truncation: a read
    // that FAILS returns the same empty set as one where every memory is gone.
    const store: Record<string, Row[]> = {
      compass_graph_nodes: [NODE("n1", "mem-a"), NODE("n2", "mem-b")],
      memories: [{ id: "mem-a", state: "published", visibility: "public" }],
      compass_graph_edges: [],
    };
    const { client, deletes } = makeFake(store, { failSelect: new Set(["memories"]) });
    const r = await reconcileExperienceNodes(client);
    assert.equal(r.nodesDeleted, 0);
    assert.equal(r.edgesDeleted, 0);
    assert.equal(r.undecided, 2, "both keys were asked about and neither was answered for");
    assert.equal(r.unresolved, true);
    assert.equal(deletes.length, 0);
    assert.equal(store.compass_graph_nodes!.length, 2);
  });

  it("B4 — an unreadable node table is not an empty one, AND the report can tell them apart", async () => {
    // Written weak first, and the mutation said so: dropping the `error`
    // binding on the node read left this green, because an unreadable table and
    // an empty one produced the identical zero report. `unresolved` is what
    // makes the branch observable — the same fix `GraphRebuildReport` already
    // carries as `nodesFailed`.
    const broken: Record<string, Row[]> = { compass_graph_nodes: [NODE("n1", "mem-a")], memories: [], compass_graph_edges: [] };
    const brokenFake = makeFake(broken, { failSelect: new Set(["compass_graph_nodes"]) });
    const unreadable = await reconcileExperienceNodes(brokenFake.client);
    assert.deepEqual(unreadable, { examined: 0, nodesDeleted: 0, edgesDeleted: 0, undecided: 0, unresolved: true });
    assert.equal(brokenFake.deletes.length, 0);
    assert.equal(broken.compass_graph_nodes!.length, 1);

    const emptyStore: Record<string, Row[]> = { compass_graph_nodes: [], memories: [], compass_graph_edges: [] };
    const emptyFake = makeFake(emptyStore);
    const genuinelyEmpty = await reconcileExperienceNodes(emptyFake.client);
    assert.equal(genuinelyEmpty.unresolved, false);
    assert.notDeepEqual(unreadable, genuinelyEmpty);
  });

  it("B5 — a graph with no experience nodes is a no-op, not a scan of every edge", async () => {
    const store: Record<string, Row[]> = {
      compass_graph_nodes: [{ id: "c1", node_key: "cebu", node_type: "city" }],
      memories: [],
      compass_graph_edges: [{ id: "e1", src_type: "city", src_key: "cebu", dst_type: "time_slice", dst_key: "cebu|fri:evening" }],
    };
    const { client, deletes } = makeFake(store);
    const r = await reconcileExperienceNodes(client);
    assert.equal(r.examined, 0);
    assert.equal(deletes.length, 0);
    assert.equal(store.compass_graph_edges!.length, 1);
  });

  it("B6 — an unreadable EDGE table still revokes the nodes and reports zero edges, rather than aborting", async () => {
    const store: Record<string, Row[]> = {
      compass_graph_nodes: [NODE("n1", "mem-gone")],
      memories: [],
      compass_graph_edges: [{ id: "e1", src_type: "experience", src_key: "mem-gone", dst_type: "city", dst_key: "cebu" }],
    };
    const { client } = makeFake(store, { failSelect: new Set(["compass_graph_edges"]) });
    const r = await reconcileExperienceNodes(client);
    assert.equal(r.nodesDeleted, 1);
    assert.equal(r.edgesDeleted, 0);
  });
});

/* ── C. Reachability — a boundary nothing calls is not a boundary ─────────── */

describe("C. both builds are WIRED, not merely written", () => {
  const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), "utf8");

  it("C1 — /compass/ask grounds the answer on BOTH branches, from the same tool log", () => {
    const src = read("../routes/compass.ts");
    // Once in the streamed branch, once in the non-streamed one. A single call
    // site would mean one of the two publishes an unchecked answer, which is
    // the shape CX-04's gap had in the first place.
    assert.equal((src.match(/groundCompassAnswer\(_rawMessage, toolLog\)/g) ?? []).length, 2);
    assert.equal((src.match(/const message\s+= _grounded\.text;/g) ?? []).length, 2);
    // The streamed branch cannot un-say what it streamed, so it sends the
    // correction as one more delta rather than fixing only the stored record.
    assert.ok(
      src.includes("delta: `\\n\\n${_grounded.correction}`"),
      "the streamed branch does not emit the correction to the client",
    );
    // And the violation travels on the response rather than being swallowed.
    assert.equal((src.match(/groundingViolations: _grounded\.violations\.map\(\(v\) => v\.kind\)/g) ?? []).length, 2);
  });

  it("C2 — the scheduled rebuild sweeps BEFORE it derives anything from the graph", () => {
    const src = read("../compass/CompassGraphEngine.ts");
    const rebuild = src.slice(src.indexOf("export async function rebuildIntelligenceGraph"));
    const pruneAt = rebuild.indexOf("reconcileExperienceNodes(db)");
    const modelsAt = rebuild.indexOf("buildCityWorldModels(db)");
    const confidenceAt = rebuild.indexOf("computeCityConfidenceIndex(db)");
    assert.ok(pruneAt > 0, "rebuildIntelligenceGraph does not sweep at all");
    assert.ok(pruneAt < modelsAt, "world models are derived before the sweep");
    assert.ok(pruneAt < confidenceAt, "the confidence index is derived before the sweep");
    // The scheduler is the only production caller, and it is registered
    // unconditionally — so this runs on every deployment, not behind a flag.
    assert.match(read("../lib/intelligenceGraphScheduler.ts"), /rebuildIntelligenceGraph/);
    assert.match(read("../index.ts"), /startIntelligenceGraphScheduler\(\);/);
  });
});
