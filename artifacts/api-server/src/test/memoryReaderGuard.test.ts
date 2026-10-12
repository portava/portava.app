/**
 * RECON-W A1 — the owner's per-Memory controls reach every reader that hands a
 * Memory to someone other than the owner's own Memories screens.
 *
 * CENSUS: H80 (a photo's own audience, 3672), H48 / H49 / H73 (the owner's
 * place corrections, 3673), H87 / H187 (DO_NOT_RESURFACE), H92 / H188
 * (RETAIN_BUT_DO_NOT_PERSONALIZE), H210 (`canUseForPersonalization`), H10.
 *
 * READERS COVERED, one describe each:
 *   C — compass/MemoryCompassTools.ts (the model's eight Memory tools)
 *   G — compass/CompassGraphEngine.ts build, reconcileExperienceNodes and
 *       reconcileEdgeSupport (the world model + the owner's rediscovery source)
 *   T — lib/discoveryTrendPostConvergence.ts loadPublicMemoriesAtPlaces
 *   P — services/memory/memoryReaderGuard.ts canUseForPersonalization
 * For each: a hidden / controlled Memory never reaches the output; the owner's
 * corrected place wins; an UNREADABLE control table withholds; an ABSENT one
 * (3671/3672/3673 not applied — production today) serves as before, no crash.
 *
 * Run: node --import tsx/esm --test src/test/memoryReaderGuard.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { executeMemoryCompassTool } from "../compass/MemoryCompassTools.js";
import { buildGraphFromSources, reconcileExperienceNodes, reconcileEdgeSupport } from "../compass/CompassGraphEngine.js";
import { loadPublicMemoriesAtPlaces } from "../lib/discoveryTrendPostConvergence.js";
import { canUseForPersonalization, controlsExcluding, PERSONALIZATION_BLOCKING_CONTROLS, storedPlaceVerdict } from "../services/memory/memoryReaderGuard.js";

const ALICE = "aaaaaaaa-0000-4000-8000-000000000001";
const BOB = "bbbbbbbb-0000-4000-8000-000000000002";
const M1 = "33333333-0000-4000-8000-000000000001";
const M2 = "33333333-0000-4000-8000-000000000002";
const PLACE_A = "7a7a7a7a-0000-4000-8000-00000000000a";
const PLACE_B = "7a7a7a7a-0000-4000-8000-00000000000b";
const T0 = "2026-03-04T13:00:00.000Z";
const T1 = "2026-04-01T00:00:00.000Z";

type Err = { code?: string; message: string };
type ErrorRule = (table: string, cols: string) => Err | null;

function fakeDb(tables: Record<string, any[]>, errorOf: ErrorRule = () => null) {
  const db: Record<string, any[]> = Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.map((r) => ({ ...r }))]));
  const reads: string[] = [];
  function from(table: string) {
    const preds: Array<(r: any) => boolean> = [];
    let cols = "";
    let lim: number | null = null;
    let rng: [number, number] | null = null;
    let op: "select" | "upsert" | "insert" | "update" | "delete" = "select";
    let payload: any[] = [];
    const run = (): { data: any; error: Err | null } => {
      if (op === "upsert" || op === "insert") {
        const list = (db[table] ??= []);
        for (const p of payload) list.push({ id: `${table}-${list.length + 1}`, ...p });
        return { data: payload, error: null };
      }
      if (op === "delete") {
        const keep: any[] = [], gone: any[] = [];
        for (const r of db[table] ?? []) (preds.every((f) => f(r)) ? gone : keep).push(r);
        db[table] = keep;
        return { data: gone, error: null };
      }
      reads.push(table);
      const err = errorOf(table, cols);
      if (err) return { data: null, error: err };
      let rows = (db[table] ?? []).filter((r) => preds.every((f) => f(r)));
      if (rng) rows = rows.slice(rng[0], rng[1] + 1);
      if (lim !== null) rows = rows.slice(0, lim);
      return { data: rows, error: null };
    };
    const t: any = {
      select(c?: string) { if (op === "select") cols = String(c ?? ""); return p; },
      eq(c: string, v: unknown) { preds.push((r) => String(r[c]) === String(v)); return p; },
      neq(c: string, v: unknown) { preds.push((r) => String(r[c]) !== String(v)); return p; },
      in(c: string, vs: unknown[]) { const s = vs.map(String); preds.push((r) => s.includes(String(r[c]))); return p; },
      gte(c: string, v: unknown) { preds.push((r) => String(r[c]) >= String(v)); return p; },
      order() { return p; },
      limit(n: number) { lim = n; return p; },
      range(a: number, b: number) { rng = [a, b]; return p; },
      upsert(rows: any) { op = "upsert"; payload = Array.isArray(rows) ? rows : [rows]; return p; },
      insert(rows: any) { op = "insert"; payload = Array.isArray(rows) ? rows : [rows]; return p; },
      update() { op = "update"; return p; },
      delete() { op = "delete"; return p; },
      maybeSingle() { const r = run(); return Promise.resolve({ data: r.error ? null : (r.data?.[0] ?? null), error: r.error }); },
      single() { return t.maybeSingle(); },
      then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) { return Promise.resolve(run()).then(res, rej); },
    };
    const p: any = new Proxy(t, {
      get(o, k) {
        if (k in o) return o[k as string];
        if (k === "catch" || k === "finally") return undefined;
        return () => p;
      },
    });
    return p;
  }
  return { client: { from, rpc: async () => ({ data: null, error: { message: "rpc not modelled" } }) } as any, db, reads };
}

const ABSENT: Err = { code: "42P01", message: 'relation "x" does not exist' };
const DENIED: Err = { code: "42501", message: "permission denied" };
const on = (table: string, err: Err): ErrorRule => (t) => (t === table ? err : null);

function memory(over: Record<string, unknown>) {
  return {
    id: M1, owner_id: ALICE, title: "Dragon Bridge", caption: "fire show", visibility: "public", allowed_user_ids: [], hidden_user_ids: [],
    state: "published", trip_id: null, event_id: null, place_id: PLACE_A, canonical_location_id: null,
    starts_at: T0, ends_at: null, created_at: T0, updated_at: T0, location_city: "Da Nang", location_country: "Vietnam",
    location_lat: 16.06, location_lng: 108.22, ...over,
  };
}
const control = (memoryId: string, c: string, owner = ALICE) => ({ memory_id: memoryId, owner_id: owner, control: c, created_at: T0 });
const correction = (kind: "assert" | "reject", placeId: string, over: Record<string, unknown> = {}) => ({
  id: `c-${kind}-${placeId}`, memory_id: M1, owner_id: ALICE, field: "place", kind, place_id: placeId, canonical_location_id: null,
  created_at: T0, source: "memory_edit", ...over,
});
/** The PATCH that moved M1 from PLACE_A to PLACE_B: one write, assert + reject, one created_at. */
const MOVED = [correction("assert", PLACE_B), correction("reject", PLACE_A)];

function world(extra: Record<string, any[]> = {}) {
  return {
    memories: [memory({})],
    memory_items: [
      { id: "item-1", memory_id: M1, media_type: "image/jpeg", caption: "shared photo", position: 0, created_at: T0, visibility: null },
      { id: "item-2", memory_id: M1, media_type: "image/jpeg", caption: "secret photo", position: 1, created_at: T0, visibility: "only_me" },
    ],
    memory_tags: [],
    blocks: [],
    ...extra,
  };
}

const ids = (out: any, key = "memories") => ((out?.[key] ?? []) as any[]).map((m) => m.memory_id);

/* ─────────────────────────── C — Compass memory tools ─────────────────────────── */

describe("C — Compass memory tools honour the owner's per-Memory controls", () => {
  it("C1 H80: a photo the owner keeps to themself never reaches another viewer's evidence; the owner sees it", async () => {
    const bob: any = await executeMemoryCompassTool(fakeDb(world()).client, BOB, "memory_get_evidence", { memoryId: M1 });
    const captions = JSON.stringify(bob.attached_artifacts);
    assert.ok(captions.includes("shared photo"));
    assert.ok(!JSON.stringify(bob).includes("secret photo"), "the only_me caption reached the model");
    assert.equal(bob.attached_artifacts.length, 1);
    const alice: any = await executeMemoryCompassTool(fakeDb(world()).client, ALICE, "memory_get_evidence", { memoryId: M1 });
    assert.equal(alice.attached_artifacts.length, 2);
  });

  it("C2 H80: an unreadable hidden-photo read withholds the whole list (unavailable, never the captions)", async () => {
    const f = fakeDb(world(), (t, cols) => (t === "memory_items" && cols === "memory_id, position" ? DENIED : null));
    const bob: any = await executeMemoryCompassTool(f.client, BOB, "memory_get_evidence", { memoryId: M1 });
    assert.equal(bob.attached_artifacts, null);
    assert.equal(bob.attached_artifacts_unavailable, true);
    assert.ok(!JSON.stringify(bob).includes("photo\""));
  });

  it("C3 3672 unapplied (the visibility column is absent): every photo is served as before, no crash", async () => {
    const f = fakeDb(world(), (t, cols) => (t === "memory_items" && cols === "memory_id, position" ? { code: "42703", message: "column memory_items.visibility does not exist" } : null));
    const bob: any = await executeMemoryCompassTool(f.client, BOB, "memory_get_evidence", { memoryId: M1 });
    assert.equal(bob.attached_artifacts.length, 2);
  });

  for (const c of ["DO_NOT_RESURFACE", "KEEP_PRIVATE_FOREVER", "RETAIN_BUT_DO_NOT_PERSONALIZE"]) {
    it(`C4 H87/H187/H188: ${c} keeps the Memory out of every Compass tool, for the owner and for anyone else`, async () => {
      const w = world({ memory_resurfacing_preferences: [control(M1, c)] });
      const search: any = await executeMemoryCompassTool(fakeDb(w).client, ALICE, "memory_search", { query: "bridge" });
      assert.deepEqual(ids(search), []);
      const place: any = await executeMemoryCompassTool(fakeDb(w).client, ALICE, "memory_get_place_history", { placeId: PLACE_A });
      assert.deepEqual(ids(place, "visits"), []);
      const own: any = await executeMemoryCompassTool(fakeDb(w).client, ALICE, "memory_get", { memoryId: M1 });
      assert.equal(own.authorized, false);
      assert.match(own.reason, /does not bring it up/);
      const other: any = await executeMemoryCompassTool(fakeDb(w).client, BOB, "memory_get", { memoryId: M1 });
      assert.deepEqual(other, { authorized: false, reason: "That Memory is not available to this user." }, "another person's control is not told");
      const ev: any = await executeMemoryCompassTool(fakeDb(w).client, BOB, "memory_get_evidence", { memoryId: M1 });
      assert.equal(ev.authorized, false);
      assert.ok(!JSON.stringify(ev).includes("photo"));
    });
  }

  it("C5 DO_NOT_INCLUDE_IN_RECAPS is a recap control only: Compass still answers", async () => {
    const w = world({ memory_resurfacing_preferences: [control(M1, "DO_NOT_INCLUDE_IN_RECAPS")] });
    const search: any = await executeMemoryCompassTool(fakeDb(w).client, ALICE, "memory_search", { query: "bridge" });
    assert.deepEqual(ids(search), [M1]);
  });

  it("C6 a control set by someone who is not the Memory's owner is ignored", async () => {
    const w = world({ memory_resurfacing_preferences: [control(M1, "DO_NOT_RESURFACE", BOB)] });
    const search: any = await executeMemoryCompassTool(fakeDb(w).client, ALICE, "memory_search", { query: "bridge" });
    assert.deepEqual(ids(search), [M1]);
  });

  it("C7 unreadable controls: the tool refuses; absent (3671 unapplied): served as before", async () => {
    const denied: any = await executeMemoryCompassTool(fakeDb(world(), on("memory_resurfacing_preferences", DENIED)).client, ALICE, "memory_search", { query: "bridge" });
    assert.equal(denied.authorized, false);
    assert.match(denied.reason, /privacy settings/);
    const get: any = await executeMemoryCompassTool(fakeDb(world(), on("memory_resurfacing_preferences", DENIED)).client, ALICE, "memory_get", { memoryId: M1 });
    assert.equal(get.authorized, false);
    const absent: any = await executeMemoryCompassTool(fakeDb(world(), on("memory_resurfacing_preferences", ABSENT)).client, ALICE, "memory_search", { query: "bridge" });
    assert.deepEqual(ids(absent), [M1]);
  });

  it("C8 H48/H73: the owner's asserted place wins — place history finds it there, not at the stored pick", async () => {
    const w = world({ memory_corrections: MOVED });
    const atB: any = await executeMemoryCompassTool(fakeDb(w).client, ALICE, "memory_get_place_history", { placeId: PLACE_B });
    assert.deepEqual(ids(atB, "visits"), [M1]);
    const atA: any = await executeMemoryCompassTool(fakeDb(w).client, ALICE, "memory_get_place_history", { placeId: PLACE_A });
    assert.deepEqual(ids(atA, "visits"), []);
    const got: any = await executeMemoryCompassTool(fakeDb(w).client, BOB, "memory_get", { memoryId: M1 });
    assert.equal(got.memory.place_id, PLACE_B);
    const fix: any = await executeMemoryCompassTool(fakeDb(w).client, ALICE, "memory_suggest_correction", { memoryId: M1, patch: { placeId: PLACE_A } });
    assert.equal(fix.current_values.placeId, PLACE_B);
  });

  it("C9 H49: a rejected stored place (route-only rejection) is no place to Compass", async () => {
    const w = world({ memory_corrections: [correction("reject", PLACE_A, { source: "correction_route" })] });
    const atA: any = await executeMemoryCompassTool(fakeDb(w).client, BOB, "memory_get_place_history", { placeId: PLACE_A });
    assert.deepEqual(ids(atA, "visits"), []);
    const got: any = await executeMemoryCompassTool(fakeDb(w).client, BOB, "memory_get", { memoryId: M1 });
    assert.equal(got.memory.place_id, null);
  });

  it("C10 unreadable corrections: refused; absent (3673 unapplied): the stored place, as before", async () => {
    const denied: any = await executeMemoryCompassTool(fakeDb(world({ memory_corrections: MOVED }), on("memory_corrections", DENIED)).client, ALICE, "memory_get_place_history", { placeId: PLACE_A });
    assert.equal(denied.authorized, false);
    const absent: any = await executeMemoryCompassTool(fakeDb(world(), on("memory_corrections", ABSENT)).client, ALICE, "memory_get_place_history", { placeId: PLACE_A });
    assert.deepEqual(ids(absent, "visits"), [M1]);
  });
});

/* ─────────────────────────── G — intelligence graph ─────────────────────────── */

const graphWorld = (extra: Record<string, any[]> = {}) => ({
  memories: [memory({}), memory({ id: M2, owner_id: BOB, place_id: null, location_city: "Hanoi" })],
  ...extra,
});
const expNodes = (db: Record<string, any[]>) => (db.compass_graph_nodes ?? []).filter((n) => n.node_type === "experience").map((n) => n.node_key).sort();
const atPlace = (db: Record<string, any[]>) => (db.compass_graph_edges ?? []).filter((e) => e.edge_type === "at_place").map((e) => `${e.src_key}>${e.dst_key}`);

describe("G — the intelligence graph honours the owner's per-Memory controls", () => {
  it("G1 baseline: both public Memories become experiences; M1 is at its stored place", async () => {
    const f = fakeDb(graphWorld());
    await buildGraphFromSources(f.client);
    assert.deepEqual(expNodes(f.db), [M1, M2]);
    assert.deepEqual(atPlace(f.db), [`${M1}>${PLACE_A}`]);
  });

  for (const c of ["RETAIN_BUT_DO_NOT_PERSONALIZE", "KEEP_PRIVATE_FOREVER", "DO_NOT_RESURFACE"]) {
    it(`G2 H92/H188: ${c} writes no experience and no edge from that Memory`, async () => {
      const f = fakeDb(graphWorld({ memory_resurfacing_preferences: [control(M1, c)] }));
      await buildGraphFromSources(f.client);
      assert.deepEqual(expNodes(f.db), [M2]);
      assert.ok(!(f.db.compass_graph_edges ?? []).some((e) => e.src_key === M1 || e.dst_key === M1));
    });
  }

  it("G3 H48/H49: the owner's corrected place is the at_place edge; the rejected pick is not", async () => {
    const f = fakeDb(graphWorld({ memory_corrections: MOVED }));
    await buildGraphFromSources(f.client);
    assert.deepEqual(atPlace(f.db), [`${M1}>${PLACE_B}`]);
  });

  it("G4 unreadable controls or corrections: no Memory-derived fact at all; absent: as before", async () => {
    for (const t of ["memory_resurfacing_preferences", "memory_corrections"]) {
      const f = fakeDb(graphWorld(), on(t, DENIED));
      await buildGraphFromSources(f.client);
      assert.deepEqual(expNodes(f.db), [], t);
      const a = fakeDb(graphWorld(), on(t, ABSENT));
      await buildGraphFromSources(a.client);
      assert.deepEqual(expNodes(a.db), [M1, M2], t);
    }
  });

  it("G5 reconcileExperienceNodes retires a controlled Memory's node; an unreadable control table decides nothing", async () => {
    const built = fakeDb(graphWorld());
    await buildGraphFromSources(built.client);
    const graph = { compass_graph_nodes: built.db.compass_graph_nodes!, compass_graph_edges: built.db.compass_graph_edges! };
    const set = fakeDb({ ...graphWorld({ memory_resurfacing_preferences: [control(M1, "RETAIN_BUT_DO_NOT_PERSONALIZE")] }), ...graph });
    const r = await reconcileExperienceNodes(set.client);
    assert.equal(r.nodesDeleted, 1);
    assert.deepEqual(expNodes(set.db), [M2]);
    const denied = fakeDb({ ...graphWorld(), ...graph }, on("memory_resurfacing_preferences", DENIED));
    const d = await reconcileExperienceNodes(denied.client);
    assert.equal(d.nodesDeleted, 0);
    assert.equal(d.unresolved, true);
    assert.deepEqual(expNodes(denied.db), [M1, M2]);
  });

  it("G6 reconcileEdgeSupport (the replay) retires a controlled Memory's edges, and decides nothing on an unreadable control table", async () => {
    const built = fakeDb(graphWorld());
    await buildGraphFromSources(built.client);
    const graph = { compass_graph_nodes: built.db.compass_graph_nodes!, compass_graph_edges: built.db.compass_graph_edges! };
    const m1Edges = (db: Record<string, any[]>) => (db.compass_graph_edges ?? []).filter((e) => e.src_key === M1 || e.dst_key === M1).length;
    assert.ok(m1Edges(graph) > 0);
    const set = fakeDb({ ...graphWorld({ memory_resurfacing_preferences: [control(M1, "RETAIN_BUT_DO_NOT_PERSONALIZE")] }), ...graph });
    await reconcileEdgeSupport(set.client, { decay: null });
    assert.equal(m1Edges(set.db), 0);
    const denied = fakeDb({ ...graphWorld(), ...graph }, on("memory_resurfacing_preferences", DENIED));
    const d = await reconcileEdgeSupport(denied.client, { decay: null });
    assert.ok(m1Edges(denied.db) > 0, "a failed control read retired edges");
    assert.ok(d.undecided > 0);
  });
});

/* ─────────────────────────── T — Discovery place-trend count ─────────────────────────── */

describe("T — Discovery's place-trend count honours the owner's per-Memory controls", () => {
  const rows = () => [
    { id: M1, owner_id: ALICE, place_id: PLACE_A, created_at: T0, state: "published", visibility: "public" },
    { id: M2, owner_id: BOB, place_id: PLACE_A, created_at: T0, state: "published", visibility: "public" },
  ];
  const load = (extra: Record<string, any[]>, rule?: ErrorRule) => loadPublicMemoriesAtPlaces(fakeDb({ memories: rows(), ...extra }, rule).client, [PLACE_A], "2026-01-01T00:00:00.000Z");
  const owners = (got: any[] | null) => (got === null ? null : got.map((m) => m.id).sort());

  it("T1 RETAIN_BUT_DO_NOT_PERSONALIZE and KEEP_PRIVATE_FOREVER are not counted; DO_NOT_RESURFACE is", async () => {
    assert.deepEqual(owners(await load({})), [M1, M2]);
    assert.deepEqual(owners(await load({ memory_resurfacing_preferences: [control(M1, "RETAIN_BUT_DO_NOT_PERSONALIZE")] })), [M2]);
    assert.deepEqual(owners(await load({ memory_resurfacing_preferences: [control(M1, "KEEP_PRIVATE_FOREVER")] })), [M2]);
    assert.deepEqual(owners(await load({ memory_resurfacing_preferences: [control(M1, "DO_NOT_RESURFACE")] })), [M1, M2]);
  });

  it("T2 H49: a Memory whose stored place its owner rejected is not counted there; a later re-assertion of it counts again (OD-1012-PRIV-3)", async () => {
    assert.deepEqual(owners(await load({ memory_corrections: [correction("reject", PLACE_A)] })), [M2]);
    assert.deepEqual(owners(await load({ memory_corrections: [correction("reject", PLACE_A, { owner_id: BOB })] })), [M1, M2], "only the owner's rejection counts");
    assert.deepEqual(owners(await load({ memory_corrections: [correction("reject", PLACE_A), correction("assert", PLACE_A, { created_at: T1 })] })), [M1, M2], "the owner's later word wins: never a permanent disregard");
  });

  it("T3 unreadable controls or corrections: the count is unread (null); absent: every row, as before", async () => {
    for (const t of ["memory_resurfacing_preferences", "memory_corrections"]) {
      assert.equal(await load({}, on(t, DENIED)), null, t);
      assert.deepEqual(owners(await load({}, on(t, ABSENT))), [M1, M2], t);
    }
  });
});

/* ─────────────── L — the trend count: the owner's LATEST correction wins (W-HM-PRIV-2) ─────────────── */

describe("L — owner ruling OD-1012-PRIV-3: disputed places are excluded until reconciled, a valid later correction counts", () => {
  const T2 = "2026-05-01T00:00:00.000Z";
  const at = (ts: string) => ({ created_at: ts });
  const row = (over: Record<string, unknown> = {}) => ({ id: M1, owner_id: ALICE, place_id: PLACE_A, canonical_location_id: null, created_at: T0, state: "published", visibility: "public", ...over });
  const other = { id: M2, owner_id: BOB, place_id: PLACE_A, created_at: T0, state: "published", visibility: "public" };
  const load = (m1: Record<string, unknown>, corrections: any[], keys = [PLACE_A], rule?: ErrorRule) =>
    loadPublicMemoriesAtPlaces(fakeDb({ memories: [row(m1), other], memory_corrections: corrections }, rule).client, keys, "2026-01-01T00:00:00.000Z");
  const owners = (got: any[] | null) => (got === null ? null : got.map((m) => m.id).sort());
  const id = (k: string, ts: string) => `c-${k}-${ts}`;
  /** PATCH A -> B at t1, then B -> A at t2: the owner moved it away and back. Each PATCH is ONE insert (one created_at). */
  const AWAY_AND_BACK = [
    correction("reject", PLACE_A, { id: id("rA", T1), ...at(T1) }), correction("assert", PLACE_B, { id: id("aB", T1), ...at(T1) }),
    correction("reject", PLACE_B, { id: id("rB", T2), ...at(T2) }), correction("assert", PLACE_A, { id: id("aA", T2), ...at(T2) }),
  ];

  it("L1 ever rejected, then re-confirmed and reconciled onto the row: COUNTED (main dropped it for good)", async () => {
    assert.deepEqual(owners(await load({}, AWAY_AND_BACK)), [M1, M2]);
  });

  it("L2 relocated and reconciled: counted at the corrected place, not at the old one", async () => {
    const moved = [correction("reject", PLACE_A, at(T1)), correction("assert", PLACE_B, at(T1))];
    assert.deepEqual(owners(await load({ place_id: PLACE_B }, moved, [PLACE_B])), [M1]);
    assert.deepEqual(owners(await load({ place_id: PLACE_B }, moved, [PLACE_A])), [M2], "the old place never sees it");
  });

  it("L3 still disputed: only rejections, or a rejection after the latest assert (of its place or of any other) — excluded", async () => {
    assert.deepEqual(owners(await load({}, [correction("reject", PLACE_A, at(T1))])), [M2], "rejected, no place confirmed since");
    assert.deepEqual(owners(await load({}, [correction("reject", PLACE_B, at(T1))])), [M2], "a rejection with no assertion confirms nothing");
    assert.deepEqual(owners(await load({}, [...AWAY_AND_BACK, correction("reject", PLACE_A, { id: "late", created_at: "2026-06-01T00:00:00.000Z" })])), [M2], "re-rejected after the re-assertion");
    assert.deepEqual(owners(await load({}, [...AWAY_AND_BACK, correction("reject", PLACE_B, { id: "late", created_at: "2026-06-01T00:00:00.000Z" })])), [M2], "the latest word is a rejection: fail closed");
    assert.deepEqual(owners(await load({}, [correction("assert", PLACE_A, { id: "a", ...at(T1) }), correction("reject", PLACE_A, { id: "r", ...at(T1) })])), [M2], "a same-instant rejection of the asserted place wins the tie (H-15)");
  });

  it("L4 not reconciled: the latest assertion is not what the Memory row carries — excluded until it is", async () => {
    const moved = [correction("reject", PLACE_A, at(T1)), correction("assert", PLACE_B, at(T1))];
    assert.deepEqual(owners(await load({}, moved)), [M2], "asserted B, the row still says A");
    assert.deepEqual(owners(await load({}, [correction("assert", PLACE_A, { canonical_location_id: PLACE_B, ...at(T1) })])), [M2], "the asserted canonical location is not on the row");
    assert.deepEqual(owners(await load({ canonical_location_id: PLACE_B }, [correction("assert", PLACE_A, at(T1))])), [M2], "the row keeps a canonical location the assertion dropped");
    assert.deepEqual(owners(await load({ canonical_location_id: PLACE_B }, [correction("assert", PLACE_A, { canonical_location_id: PLACE_B, ...at(T1) })])), [M1, M2], "both values reconciled");
    assert.deepEqual(owners(await load({}, [correction("assert", "", { place_id: null, ...at(T1) })])), [M2], "the owner said it names no place");
  });

  it("L5 only the latest assert decides: an older assertion of the stored place does not outvote a newer one elsewhere", async () => {
    assert.deepEqual(owners(await load({}, [correction("assert", PLACE_A, { id: "old", ...at(T1) }), correction("assert", PLACE_B, { id: "new", ...at(T2) })])), [M2]);
    assert.deepEqual(owners(await load({}, [correction("assert", PLACE_B, { id: "old", ...at(T1) }), correction("assert", PLACE_A, { id: "new", ...at(T2) })])), [M1, M2]);
  });

  it("L6 unreadable correction state: the count is unread (null), never counted blind", async () => {
    assert.equal(await load({}, AWAY_AND_BACK, [PLACE_A], on("memory_corrections", DENIED)), null, "denied");
    assert.equal(await load({}, [...AWAY_AND_BACK, correction("assert", PLACE_A, { id: "bad", created_at: "not a time" })]), null, "an instant that cannot be read");
    const full = Array.from({ length: 1000 }, (_, i) => correction("reject", `p${i}`, { id: `f${i}`, memory_id: M2, owner_id: BOB }));
    assert.equal(await load({}, full), null, "a page that may be truncated");
    assert.deepEqual(owners(await load({}, AWAY_AND_BACK, [PLACE_A], on("memory_corrections", ABSENT))), [M1, M2], "3673 unapplied: as before");
  });

  it("L7 the pure verdict, clause by clause", () => {
    const v = (stored: Record<string, unknown>, rows: any[]) => storedPlaceVerdict(stored, rows);
    assert.equal(v({ place_id: PLACE_A }, []), "counts");
    assert.equal(v({ place_id: PLACE_A }, AWAY_AND_BACK), "counts");
    assert.equal(v({ place_id: PLACE_A }, AWAY_AND_BACK.slice(0, 2)), "disputed");
    assert.equal(v({ place_id: PLACE_B }, AWAY_AND_BACK.slice(0, 2)), "counts");
    assert.equal(v({ place_id: PLACE_A }, [correction("reject", PLACE_A, { created_at: "garbage" })]), "unreadable");
    assert.equal(v({ place_id: PLACE_A }, [{ ...correction("assert", PLACE_A), kind: "unknown" }]), "counts", "an unknown kind is no correction (the fold ignores it)"); assert.equal(v({ place_id: PLACE_A, canonical_location_id: null }, [correction("assert", PLACE_A, { id: "c-a", canonical_location_id: "X" }), { ...correction("reject", PLACE_A, { id: "c-r", place_id: null, canonical_location_id: "X" }) }]), "disputed", "s13: a same-instant canonical reject does not let the row's null canonical match (the SQL twin compares the assert's own canonical)");
  });
});

/* ─────────────────────────── P — canUseForPersonalization ─────────────────────────── */

describe("P — canUseForPersonalization(userId, memoryId) (H210)", () => {
  it("P1 false for the two personalization controls, true for the others and for none", async () => {
    for (const [c, want] of [["RETAIN_BUT_DO_NOT_PERSONALIZE", false], ["KEEP_PRIVATE_FOREVER", false], ["DO_NOT_RESURFACE", true], ["DO_NOT_INCLUDE_IN_RECAPS", true]] as const) {
      const f = fakeDb({ memory_resurfacing_preferences: [control(M1, c)] });
      assert.equal(await canUseForPersonalization(f.client, ALICE, M1), want, c);
    }
    assert.equal(await canUseForPersonalization(fakeDb({}).client, ALICE, M1), true);
  });

  it("P2 unreadable: false (fail closed); absent (3671 unapplied): true", async () => {
    assert.equal(await canUseForPersonalization(fakeDb({}, on("memory_resurfacing_preferences", DENIED)).client, ALICE, M1), false);
    assert.equal(await canUseForPersonalization(fakeDb({}, on("memory_resurfacing_preferences", ABSENT)).client, ALICE, M1), true);
  });

  it("P3 the reader → control mapping is CONTROL_EFFECTS', not retyped", () => {
    assert.deepEqual([...PERSONALIZATION_BLOCKING_CONTROLS].sort(), ["KEEP_PRIVATE_FOREVER", "RETAIN_BUT_DO_NOT_PERSONALIZE"]);
    assert.deepEqual([...controlsExcluding("compass_tools")].sort(), ["DO_NOT_RESURFACE", "KEEP_PRIVATE_FOREVER", "RETAIN_BUT_DO_NOT_PERSONALIZE"]);
    assert.deepEqual([...controlsExcluding("intelligence_graph")].sort(), ["DO_NOT_RESURFACE", "KEEP_PRIVATE_FOREVER", "RETAIN_BUT_DO_NOT_PERSONALIZE"]);
    assert.deepEqual([...controlsExcluding("aggregate_count")].sort(), ["KEEP_PRIVATE_FOREVER", "RETAIN_BUT_DO_NOT_PERSONALIZE"]);
  });
});

/* ─────────────────────────── S — the stored twin (3725) ─────────────────────────── */

describe("S — 3725: the stored trend twin carries the same exclusion as the loader", () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  const fnOf = (sql: string) => { const a = sql.indexOf("CREATE OR REPLACE FUNCTION public.discovery_trend_post_groups_v2("); return sql.slice(a, sql.indexOf("$fn$;", a) + 5); };
  const M3497 = readFileSync(resolve(dir, "../migrations/3497_discovery_trend_post_convergence_stored.sql"), "utf8");
  const M3725 = readFileSync(resolve(dir, "../migrations/3725_discovery_trend_post_owner_controls.sql"), "utf8");
  const R3725 = readFileSync(resolve(dir, "../../../../db/rollback/2026-10-11-3725-discovery-trend-post-owner-controls-rollback.sql"), "utf8");

  it("S1 3725's body is 3497's plus only the two NOT EXISTS clauses; the rollback restores 3497's byte for byte", () => {
    const before = fnOf(M3497).split("\n"), after = fnOf(M3725).split("\n");
    assert.deepEqual(before.filter((l) => !after.includes(l)), [], "a 3497 line was changed or lost");
    const added = after.filter((l) => !before.includes(l)).filter((l) => !l.trim().startsWith("--"));
    assert.deepEqual(added.map((l) => l.trim()), [
      "AND NOT EXISTS (SELECT 1 FROM public.memory_resurfacing_preferences rp",
      "WHERE rp.memory_id = m.id AND rp.owner_id = m.owner_id",
      "AND rp.control IN ('KEEP_PRIVATE_FOREVER', 'RETAIN_BUT_DO_NOT_PERSONALIZE'))",
      "AND NOT EXISTS (SELECT 1 FROM public.memory_corrections mc",
      "WHERE mc.memory_id = m.id AND mc.owner_id = m.owner_id",
      "AND mc.field = 'place' AND mc.kind = 'reject' AND mc.place_id = m.place_id)",
    ]);
    assert.ok(R3725.includes(fnOf(M3497)), "the rollback restores 3497's body");
  });

  it("S2 the SQL's controls are the loader's (aggregate_count), not a second list", () => {
    for (const body of [fnOf(M3725), fnOf(M3726)]) {
      const listed = [...body.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]).filter((c) => /_/.test(c!)).sort();
      assert.deepEqual(listed, [...controlsExcluding("aggregate_count")].sort());
    }
  });

  const M3726 = readFileSync(resolve(dir, "../migrations/3726_discovery_trend_post_latest_correction.sql"), "utf8");
  const R3726 = readFileSync(resolve(dir, "../../../../db/rollback/2026-10-12-3726-discovery-trend-post-latest-correction-rollback.sql"), "utf8");

  it("S3 3726 (W-HM-PRIV-2) replaces ONLY 3725's ever-rejected clause, with storedPlaceVerdict's clauses; the rollback restores 3725's body byte for byte", () => {
    const before = fnOf(M3725).split("\n"), after = fnOf(M3726).split("\n");
    const code = (ls: string[]) => ls.filter((l) => !l.trim().startsWith("--")).map((l) => l.trim());
    assert.deepEqual(code(before.filter((l) => !after.includes(l))), [
      "AND NOT EXISTS (SELECT 1 FROM public.memory_corrections mc",
      "WHERE mc.memory_id = m.id AND mc.owner_id = m.owner_id",
      "AND mc.field = 'place' AND mc.kind = 'reject' AND mc.place_id = m.place_id)",
    ], "3726 removes 3725's permanent-rejection clause and nothing else");
    assert.deepEqual(code(after.filter((l) => !before.includes(l))), [
      // no correction at all …
      "AND (NOT EXISTS (SELECT 1 FROM public.memory_corrections mc",
      "WHERE mc.memory_id = m.id AND mc.owner_id = m.owner_id AND mc.field = 'place')",
      // … or the latest assert names the stored place …
      "OR EXISTS (SELECT 1 FROM public.memory_corrections la",
      "WHERE la.memory_id = m.id AND la.owner_id = m.owner_id AND la.field = 'place' AND la.kind = 'assert'",
      "AND la.place_id = m.place_id",
      // … and the stored canonical location is reconciled to it …
      "AND la.canonical_location_id IS NOT DISTINCT FROM m.canonical_location_id",
      // … it IS the latest assert (instant, then id: compareCorrections) …
      "AND NOT EXISTS (SELECT 1 FROM public.memory_corrections lx",
      "WHERE lx.memory_id = m.id AND lx.owner_id = m.owner_id AND lx.field = 'place' AND lx.kind = 'assert'",
      "AND (lx.created_at, lx.id) > (la.created_at, la.id))",
      // … and no rejection after it, nor one at its instant naming its values (the fold's tie rule).
      "AND NOT EXISTS (SELECT 1 FROM public.memory_corrections rj",
      "WHERE rj.memory_id = m.id AND rj.owner_id = m.owner_id AND rj.field = 'place' AND rj.kind = 'reject'",
      "AND (rj.created_at > la.created_at",
      "OR (rj.created_at = la.created_at",
      "AND (rj.place_id = la.place_id OR rj.canonical_location_id = la.canonical_location_id))))))",
    ]);
    assert.ok(R3726.includes(fnOf(M3725)), "the rollback restores 3725's body");
    assert.match(M3726, /Apply 3725 first/, "3726 refuses to apply without 3725 (chain order)");
  });

  it("S4 the loader reads the column the verdict compares (canonical_location_id)", () => {
    const loader = readFileSync(resolve(dir, "../lib/discoveryTrendPostConvergence.ts"), "utf8");
    assert.match(loader, /\.select\("id, owner_id, place_id, canonical_location_id, created_at, state, visibility"\)/);
  });
});
