/**
 * trailRelationsRebuild.db.test.ts — census-discovery DV-72 (§61): `10` §10
 * "derived tables are rebuildable", for `trail_relations` (migration 3416).
 *
 *   R1  rebuild-equivalence: the table equals an INDEPENDENT TypeScript
 *       projection of the same source rows — declared edges verbatim, a parent
 *       pointer only where no declared child edge carries it, common content
 *       counted once per pair — lineage included
 *   R2  drop, rebuild, compare: every row back, identical in every column
 *   R3  a second rebuild at the same instant changes nothing and adds nothing
 *   R4  it is DERIVED, not maintained: a source change is invisible until the
 *       rebuild, and exactly reflected after it (edge removed, member detached,
 *       Trail deleted)
 *   R5  the posture: no client role reads, writes or rebuilds it; the service
 *       role cannot UPDATE a row, only replace the set
 */
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { HAVE_DB, exec, scalar, psql, rows } from "./localDb.js";

const TAG = `rel${randomUUID().slice(0, 8)}`;
const NOW = "2026-09-27T12:00:00.000Z";
const FEATURE_VERSION = "trail-relation-kinds-v1";
const MODEL_VERSION = "trail-relations-projection-v1";

interface Rel {
  from_trail_id: string; to_trail_id: string; relation: string; basis: string;
  declared_strength: number | null; shared_content_count: number | null;
  start_us: string; end_us: string; feature_version: string; model_version: string; computed_us: string;
}

const us = (col: string) => `((extract(epoch from ${col}) * 1000000)::bigint)::text`;

function trail(label: string, parent: string | null = null): string {
  const id = randomUUID();
  exec(`INSERT INTO public.trails (id, slug, title, lifecycle_status, parent_trail_id, created_at, updated_at)
        VALUES ('${id}', '${TAG}-${label}', '${TAG} ${label}', 'active', ${parent ? `'${parent}'` : "NULL"},
                now() - interval '3 days', now() - interval '${Math.floor(Math.random() * 48)} hours');`);
  return id;
}

function edge(from: string, to: string, type: string, strength: number): void {
  exec(`INSERT INTO public.trail_edges (from_trail_id, to_trail_id, edge_type, strength, updated_at)
        VALUES ('${from}', '${to}', '${type}', ${strength}, now() - interval '${Math.floor(Math.random() * 100)} minutes');`);
}

function member(trailId: string, sourceId: string, relationship: string, minutesAgo: number, signal: string | null = null): void {
  exec(`INSERT INTO public.content_trails (trail_id, source_type, source_id, relationship, signal, created_at)
        VALUES ('${trailId}', 'place', '${sourceId}', '${relationship}', ${signal ? `'${signal}'` : "NULL"}, now() - interval '${minutesAgo} minutes');`);
}

const mine = (ids: string[]) => `(${ids.map((i) => `'${i}'`).join(", ")})`;

/** The table, restricted to relations whose both ends are this suite's Trails. */
function projected(ids: string[]): Rel[] {
  return rows<Rel>(`SELECT from_trail_id::text, to_trail_id::text, relation, basis, declared_strength::float8 AS declared_strength,
                           shared_content_count, ${us("source_window_start")} AS start_us, ${us("source_window_end")} AS end_us,
                           feature_version, model_version, ${us("computed_at")} AS computed_us
                      FROM public.trail_relations
                     WHERE from_trail_id IN ${mine(ids)} AND to_trail_id IN ${mine(ids)}
                     ORDER BY from_trail_id, to_trail_id, relation COLLATE "C"`);
}

/** An independent projection of the same source rows, written from `05` §2 / 3416's header, not from its SQL. */
function expected(ids: string[]): Rel[] {
  const computed = String(Date.parse(NOW) * 1000);
  const trails = rows<{ id: string; parent: string | null; c: string; u: string }>(
    `SELECT id::text, parent_trail_id::text AS parent, ${us("created_at")} AS c, ${us("updated_at")} AS u FROM public.trails WHERE id IN ${mine(ids)}`);
  // (Not `AS t`: localDb.rows() aggregates its subquery under the alias `t`.)
  const edges = rows<{ f: string; to: string; type: string; s: number; u: string }>(
    `SELECT from_trail_id::text AS f, to_trail_id::text AS "to", edge_type AS type, strength::float8 AS s, ${us("updated_at")} AS u
       FROM public.trail_edges WHERE from_trail_id IN ${mine(ids)} AND to_trail_id IN ${mine(ids)}`);
  const members = rows<{ trail: string; content: string; at: string }>(
    `SELECT trail_id::text AS trail, source_type || ':' || source_id AS content, ${us("created_at")} AS at
       FROM public.content_trails WHERE trail_id IN ${mine(ids)}`);
  const big = (a: string, b: string) => (BigInt(a) < BigInt(b) ? a : b);
  const bigMax = (a: string, b: string) => (BigInt(a) > BigInt(b) ? a : b);
  const base = { feature_version: FEATURE_VERSION, model_version: MODEL_VERSION, computed_us: computed };
  const out: Rel[] = [];
  for (const e of edges) {
    out.push({ from_trail_id: e.f, to_trail_id: e.to, relation: e.type, basis: "declared_edge", declared_strength: e.s,
      shared_content_count: null, start_us: e.u, end_us: e.u, ...base });
  }
  for (const t of trails) {
    if (!t.parent || !ids.includes(t.parent)) continue;
    if (edges.some((e) => e.f === t.parent && e.to === t.id && e.type === "child")) continue;
    out.push({ from_trail_id: t.parent, to_trail_id: t.id, relation: "child", basis: "parent_pointer", declared_strength: null,
      shared_content_count: null, start_us: big(t.c, t.u), end_us: bigMax(t.c, t.u), ...base });
  }
  // content → trail → [first, last]
  const held = new Map<string, Map<string, [string, string]>>();
  for (const m of members) {
    const byTrail = held.get(m.content) ?? new Map<string, [string, string]>();
    const w = byTrail.get(m.trail);
    byTrail.set(m.trail, w ? [big(w[0], m.at), bigMax(w[1], m.at)] : [m.at, m.at]);
    held.set(m.content, byTrail);
  }
  const pairs = new Map<string, { n: number; start: string; end: string }>();
  for (const byTrail of held.values()) {
    const ts = [...byTrail.keys()].sort();
    for (let i = 0; i < ts.length; i++) for (let j = i + 1; j < ts.length; j++) {
      const [a, b] = [ts[i]!, ts[j]!];
      const [wa, wb] = [byTrail.get(a)!, byTrail.get(b)!];
      const key = `${a}|${b}`;
      const prev = pairs.get(key);
      const start = big(wa[0], wb[0]);
      const end = bigMax(wa[1], wb[1]);
      pairs.set(key, prev ? { n: prev.n + 1, start: big(prev.start, start), end: bigMax(prev.end, end) } : { n: 1, start, end });
    }
  }
  for (const [key, p] of pairs) {
    const [a, b] = key.split("|") as [string, string];
    out.push({ from_trail_id: a, to_trail_id: b, relation: "common_content", basis: "shared_content", declared_strength: null,
      shared_content_count: p.n, start_us: p.start, end_us: p.end, ...base });
  }
  return out.sort((x, y) => (x.from_trail_id + x.to_trail_id + x.relation < y.from_trail_id + y.to_trail_id + y.relation ? -1 : 1));
}

/** Rebuild AS the service role, the only role that may. */
function rebuildAsService(): number {
  const out = exec(`SET LOCAL ROLE service_role;\nSELECT public.rebuild_trail_relations('${NOW}');`, { single: true });
  return Number(out[out.length - 1]);
}
/** Every row of the table, every column, in a total order. */
const wholeTable = () => exec(`SELECT coalesce(string_agg(r::text, E'\\n' ORDER BY r::text), '') FROM public.trail_relations r;`).join("\n");

let ids: string[] = [];
let A = "", B = "", C = "", D = "", E = "";
const X = randomUUID();
const Y = randomUUID();
const Z = randomUUID();

before(() => {
  if (!HAVE_DB) return;
  assert.equal(scalar("SELECT to_regprocedure('public.rebuild_trail_relations(timestamptz)') IS NOT NULL;"), "t", "3416 must be applied");
  A = trail("a");
  B = trail("b");
  C = trail("c", A);            // a parent pointer with NO edge beside it
  D = trail("d", A);            // a parent pointer WITH its declared child edge
  E = trail("e");
  ids = [A, B, C, D, E];
  edge(A, D, "child", 1);
  edge(A, B, "related", 0.3);
  edge(B, E, "geographic_sub", 0.7);
  edge(E, A, "seasonal_variant", 0.45);
  member(A, X, "primary", 90);
  member(C, X, "supporting", 60);
  member(E, X, "signal", 30, "rooftop");
  member(A, Y, "supporting", 50);
  member(C, Y, "primary", 40);
  member(C, Y, "signal", 20, "food");     // two labels, one content: counted once
  member(B, Z, "primary", 10);
});

after(() => {
  if (!HAVE_DB) return;
  exec(`DELETE FROM public.trails WHERE slug LIKE '${TAG}-%';`);
  exec(`SET LOCAL ROLE service_role;\nSELECT public.rebuild_trail_relations(now());`, { single: true });
});

describe("R — DV-72: trail_relations is derived and rebuildable", { skip: !HAVE_DB }, () => {
  test("R1. rebuild-equivalence: the table equals an independent projection of the source rows, lineage included", () => {
    rebuildAsService();
    const got = projected(ids);
    const want = expected(ids);
    assert.deepEqual(got, want);
    // Not vacuous: all three bases, and a count above one.
    assert.deepEqual([...new Set(got.map((r) => r.basis))].sort(), ["declared_edge", "parent_pointer", "shared_content"]);
    assert.ok(got.some((r) => r.relation === "common_content" && r.shared_content_count === 2));
    assert.ok(!got.some((r) => r.basis === "parent_pointer" && r.to_trail_id === D), "a pointer its declared edge already carries is not listed twice");
  });

  test("R2. drop, rebuild, compare: every row comes back identical in every column", () => {
    rebuildAsService();
    const before = wholeTable();
    assert.ok(before.length > 0);
    exec(`SET LOCAL ROLE service_role;\nDELETE FROM public.trail_relations WHERE true;`, { single: true });
    assert.equal(scalar("SELECT count(*) FROM public.trail_relations;"), "0");
    rebuildAsService();
    assert.equal(wholeTable(), before);
  });

  test("R3. a second rebuild at the same instant changes nothing and adds no row", () => {
    const n1 = rebuildAsService();
    const first = wholeTable();
    const n2 = rebuildAsService();
    assert.equal(n2, n1);
    assert.equal(wholeTable(), first);
    assert.equal(scalar("SELECT count(*) FROM public.trail_relations;"), String(n1));
  });

  test("R4. derived, not maintained: a source change shows only after the rebuild, and exactly", () => {
    rebuildAsService();
    const stale = projected(ids);
    exec(`DELETE FROM public.trail_edges WHERE from_trail_id = '${A}' AND to_trail_id = '${B}';`);
    exec(`DELETE FROM public.content_trails WHERE trail_id = '${C}' AND source_id = '${Y}';`);
    exec(`DELETE FROM public.trails WHERE id = '${E}';`);
    assert.deepEqual(projected(ids.filter((i) => i !== E)), stale.filter((r) => r.from_trail_id !== E && r.to_trail_id !== E),
      "nothing maintains the projection between rebuilds (the Trail's deletion cascades, which is the FK, not a refresh)");
    rebuildAsService();
    ids = ids.filter((i) => i !== E);
    const after = projected(ids);
    assert.deepEqual(after, expected(ids));
    assert.ok(!after.some((r) => r.relation === "related"), "the removed edge is gone");
    assert.equal(after.find((r) => r.relation === "common_content" && r.from_trail_id === [A, C].sort()[0])?.shared_content_count, 1);
  });

  test("R5. no client role reads, writes or rebuilds it; the service role replaces rows and never edits one", () => {
    for (const role of ["anon", "authenticated"]) {
      for (const sql of [
        "SELECT count(*) FROM public.trail_relations;",
        `SELECT public.rebuild_trail_relations(now());`,
        `DELETE FROM public.trail_relations WHERE true;`,
      ]) {
        const r = psql(`BEGIN;\nSET LOCAL ROLE ${role};\n${sql}\nCOMMIT;`);
        assert.notEqual(r.status, 0, `${role}: ${sql}`);
        assert.match(r.stderr, /permission denied/, `${role}: ${sql}`);
      }
    }
    const upd = psql(`BEGIN;\nSET LOCAL ROLE service_role;\nUPDATE public.trail_relations SET shared_content_count = 99 WHERE true;\nCOMMIT;`);
    assert.notEqual(upd.status, 0);
    assert.match(upd.stderr, /permission denied/);
    assert.equal(scalar(`SELECT count(*) FROM pg_policy WHERE polrelid = 'public.trail_relations'::regclass AND NOT polpermissive;`), "4");
  });
});
