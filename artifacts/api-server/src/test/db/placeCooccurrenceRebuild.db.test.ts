/**
 * placeCooccurrenceRebuild.db.test.ts — census-discovery DV-72 (§95, lane
 * W11-X3; register D-W11X3-1): `10` §10 "derived tables are rebuildable", for
 * the Trail-derived `place_cooccurrence` (migration 3495). The shape of
 * trailRelationsRebuild.db.test.ts R1–R5.
 *
 *   R1  rebuild-equivalence: the table equals an INDEPENDENT TypeScript
 *       projection of the same source rows — places held by a common
 *       non-archived Trail, each pair once (a < b), several labels one
 *       membership, a Trail over the size cap contributing nothing — lineage
 *       included
 *   R2  drop, rebuild, compare: every row back, identical in every column
 *   R3  a second rebuild at the same instant changes nothing and adds nothing
 *   R4  derived, not maintained: a source change (member detached, Trail
 *       archived, Trail deleted) is invisible until the rebuild, and exact after
 *   R5  the posture: no client role reads, writes or rebuilds it; the service
 *       role cannot UPDATE a row; a people-derived basis is refused
 *   R6  3496's two flags exist and are FALSE
 */
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { HAVE_DB, exec, scalar, psql, rows } from "./localDb.js";

const TAG = `pco${randomUUID().slice(0, 8)}`;
const NOW = "2026-09-28T12:00:00.000Z";
const FEATURE_VERSION = "trail-place-membership-v1";
const MODEL_VERSION = "place-cooccurrence-shared-trail-v1";
const MAX_TRAIL_PLACES = 100;

interface Pair {
  place_a: string; place_b: string; basis: string; shared_trail_count: number;
  start_us: string; end_us: string; feature_version: string; model_version: string; computed_us: string;
}

const us = (col: string) => `((extract(epoch from ${col}) * 1000000)::bigint)::text`;

function trail(label: string, status = "active"): string {
  const id = randomUUID();
  exec(`INSERT INTO public.trails (id, slug, title, lifecycle_status) VALUES ('${id}', '${TAG}-${label}', '${TAG} ${label}', '${status}');`);
  return id;
}

function member(trailId: string, placeId: string, relationship: string, minutesAgo: number, signal: string | null = null, sourceType = "place"): void {
  exec(`INSERT INTO public.content_trails (trail_id, source_type, source_id, relationship, signal, created_at)
        VALUES ('${trailId}', '${sourceType}', '${placeId}', '${relationship}', ${signal ? `'${signal}'` : "NULL"}, now() - interval '${minutesAgo} minutes');`);
}

const inList = (ids: string[]) => `(${ids.map((i) => `'${i}'`).join(", ")})`;

/** The table, restricted to pairs whose both ends are this suite's places. */
function projected(places: string[]): Pair[] {
  return rows<Pair>(`SELECT place_a::text, place_b::text, basis, shared_trail_count,
                            ${us("source_window_start")} AS start_us, ${us("source_window_end")} AS end_us,
                            feature_version, model_version, ${us("computed_at")} AS computed_us
                       FROM public.place_cooccurrence
                      WHERE place_a IN ${inList(places)} AND place_b IN ${inList(places)}
                      ORDER BY place_a, place_b`);
}

/** An independent projection, written from 3495's header, not from its SQL. */
function expected(trailIds: string[], places: string[]): Pair[] {
  const computed = String(Date.parse(NOW) * 1000);
  const trails = new Map(rows<{ id: string; status: string }>(
    `SELECT id::text, lifecycle_status AS status FROM public.trails WHERE id IN ${inList(trailIds)}`).map((t) => [t.id, t.status]));
  const members = rows<{ trail: string; place: string; kind: string; at: string }>(
    `SELECT trail_id::text AS trail, source_id::text AS place, source_type AS kind, ${us("created_at")} AS at
       FROM public.content_trails WHERE trail_id IN ${inList(trailIds)}`);
  const lo = (a: string, b: string) => (BigInt(a) < BigInt(b) ? a : b);
  const hi = (a: string, b: string) => (BigInt(a) > BigInt(b) ? a : b);
  // trail → place → [first, last] (several labels are one membership)
  const byTrail = new Map<string, Map<string, [string, string]>>();
  for (const m of members) {
    if (m.kind !== "place") continue;
    const held = byTrail.get(m.trail) ?? new Map<string, [string, string]>();
    const w = held.get(m.place);
    held.set(m.place, w ? [lo(w[0], m.at), hi(w[1], m.at)] : [m.at, m.at]);
    byTrail.set(m.trail, held);
  }
  const pairs = new Map<string, { n: number; start: string; end: string }>();
  for (const [t, held] of byTrail) {
    if (trails.get(t) === "archived") continue;
    if (held.size > MAX_TRAIL_PLACES) continue;
    const ps = [...held.keys()].sort();
    for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
      const [a, b] = [ps[i]!, ps[j]!];
      const start = lo(held.get(a)![0], held.get(b)![0]);
      const end = hi(held.get(a)![1], held.get(b)![1]);
      const prev = pairs.get(`${a}|${b}`);
      pairs.set(`${a}|${b}`, prev ? { n: prev.n + 1, start: lo(prev.start, start), end: hi(prev.end, end) } : { n: 1, start, end });
    }
  }
  const out: Pair[] = [];
  for (const [k, p] of pairs) {
    const [a, b] = k.split("|") as [string, string];
    if (!places.includes(a) || !places.includes(b)) continue;
    out.push({ place_a: a, place_b: b, basis: "shared_trail", shared_trail_count: p.n, start_us: p.start, end_us: p.end,
      feature_version: FEATURE_VERSION, model_version: MODEL_VERSION, computed_us: computed });
  }
  return out.sort((x, y) => (x.place_a + x.place_b < y.place_a + y.place_b ? -1 : 1));
}

function rebuildAsService(): number {
  const out = exec(`SET LOCAL ROLE service_role;\nSELECT public.rebuild_place_cooccurrence('${NOW}');`, { single: true });
  return Number(out[out.length - 1]);
}
const wholeTable = () => exec(`SELECT coalesce(string_agg(r::text, E'\\n' ORDER BY r::text), '') FROM public.place_cooccurrence r;`).join("\n");

let T1 = "", T2 = "", T3 = "", TARCH = "", TBIG = "";
let trailIds: string[] = [];
const [P, Q, R, S, U] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
const places = [P, Q, R, S, U];
const bigPlaces: string[] = [];

before(() => {
  if (!HAVE_DB) return;
  assert.equal(scalar("SELECT to_regprocedure('public.rebuild_place_cooccurrence(timestamptz)') IS NOT NULL;"), "t", "3495 must be applied");
  T1 = trail("t1");
  T2 = trail("t2", "proposed");
  T3 = trail("t3", "stale");
  TARCH = trail("arch", "archived");
  TBIG = trail("big");
  trailIds = [T1, T2, T3, TARCH, TBIG];
  member(T1, P, "primary", 90);
  member(T1, Q, "supporting", 80);
  member(T1, Q, "signal", 20, "food");       // two labels, one membership
  member(T1, R, "supporting", 70);
  member(T2, P, "supporting", 60);         // (02 §4: one primary Trail per place)
  member(T2, Q, "supporting", 50);           // (P,Q) held by two Trails
  member(T3, S, "primary", 40);              // a Trail with one place: no pair
  member(T3, U, "primary", 35, null, "post"); // not a place: no pair
  member(TARCH, R, "primary", 30);
  member(TARCH, S, "supporting", 25);        // archived: (R,S) never appears
  // A Trail over the cap: holds U and S (and 100 others), contributes nothing.
  member(TBIG, U, "primary", 15);
  member(TBIG, S, "supporting", 14);
  const values: string[] = [];
  for (let i = 0; i < MAX_TRAIL_PLACES - 1; i++) {
    const id = randomUUID(); bigPlaces.push(id);
    values.push(`('${TBIG}', 'place', '${id}', 'supporting', now() - interval '10 minutes')`);
  }
  exec(`INSERT INTO public.content_trails (trail_id, source_type, source_id, relationship, created_at) VALUES ${values.join(",\n")};`);
});

after(() => {
  if (!HAVE_DB) return;
  exec(`DELETE FROM public.trails WHERE slug LIKE '${TAG}-%';`);
  exec(`SET LOCAL ROLE service_role;\nSELECT public.rebuild_place_cooccurrence(now());`, { single: true });
});

describe("R — DV-72: place_cooccurrence is Trail-derived, derived and rebuildable", { skip: !HAVE_DB }, () => {
  test("R1. rebuild-equivalence: the table equals an independent projection, lineage included", () => {
    rebuildAsService();
    const got = projected(places);
    assert.deepEqual(got, expected(trailIds, places));
    // Not vacuous: a count above one, and the three excluded cases are absent.
    const pq = [P, Q].sort();
    assert.equal(got.find((r) => r.place_a === pq[0] && r.place_b === pq[1])?.shared_trail_count, 2);
    const rs = [R, S].sort();
    assert.ok(!got.some((r) => r.place_a === rs[0] && r.place_b === rs[1]), "an archived Trail contributes no pair");
    const su = [S, U].sort();
    assert.ok(!got.some((r) => r.place_a === su[0] && r.place_b === su[1]), "a Trail over the cap contributes no pair");
    assert.equal(scalar(`SELECT count(*) FROM public.place_cooccurrence WHERE place_a IN ${inList(bigPlaces)} OR place_b IN ${inList(bigPlaces)};`), "0");
    assert.equal(got.length, 3);
  });

  test("R2. drop, rebuild, compare: every row comes back identical in every column", () => {
    rebuildAsService();
    const before = wholeTable();
    assert.ok(before.length > 0);
    exec(`SET LOCAL ROLE service_role;\nDELETE FROM public.place_cooccurrence WHERE true;`, { single: true });
    assert.equal(scalar("SELECT count(*) FROM public.place_cooccurrence;"), "0");
    rebuildAsService();
    assert.equal(wholeTable(), before);
  });

  test("R3. a second rebuild at the same instant changes nothing and adds no row", () => {
    const n1 = rebuildAsService();
    const first = wholeTable();
    const n2 = rebuildAsService();
    assert.equal(n2, n1);
    assert.equal(wholeTable(), first);
    assert.equal(scalar("SELECT count(*) FROM public.place_cooccurrence;"), String(n1));
  });

  test("R4. derived, not maintained: a source change shows only after the rebuild, and exactly", () => {
    rebuildAsService();
    const stale = projected(places);
    exec(`DELETE FROM public.content_trails WHERE trail_id = '${T1}' AND source_id = '${R}';`);
    exec(`UPDATE public.trails SET lifecycle_status = 'archived' WHERE id = '${T2}';`);
    assert.deepEqual(projected(places), stale, "nothing maintains the projection between rebuilds");
    rebuildAsService();
    const after = projected(places);
    assert.deepEqual(after, expected(trailIds, places));
    const pq = [P, Q].sort();
    assert.deepEqual(after.map((r) => [r.place_a, r.place_b, r.shared_trail_count]), [[pq[0], pq[1], 1]]);
    exec(`DELETE FROM public.trails WHERE id = '${T1}';`);
    rebuildAsService();
    assert.deepEqual(projected(places), []);
  });

  test("R5. no client role reads, writes or rebuilds it; the service role never edits a row; no people basis", () => {
    for (const role of ["anon", "authenticated"]) {
      for (const sql of [
        "SELECT count(*) FROM public.place_cooccurrence;",
        "SELECT public.rebuild_place_cooccurrence(now());",
        "DELETE FROM public.place_cooccurrence WHERE true;",
      ]) {
        const r = psql(`BEGIN;\nSET LOCAL ROLE ${role};\n${sql}\nCOMMIT;`);
        assert.notEqual(r.status, 0, `${role}: ${sql}`);
        assert.match(r.stderr, /permission denied/, `${role}: ${sql}`);
      }
    }
    const upd = psql(`BEGIN;\nSET LOCAL ROLE service_role;\nUPDATE public.place_cooccurrence SET shared_trail_count = 99 WHERE true;\nCOMMIT;`);
    assert.notEqual(upd.status, 0);
    assert.match(upd.stderr, /permission denied/);
    const itinerary = psql(`BEGIN;\nSET LOCAL ROLE service_role;\nINSERT INTO public.place_cooccurrence VALUES ('${[P, Q].sort()[0]}', '${[P, Q].sort()[1]}', 'itinerary', 1, now(), now(), 'x', 'y', now());\nROLLBACK;`);
    assert.notEqual(itinerary.status, 0);
    assert.match(itinerary.stderr, /place_cooccurrence_basis_trail_only/);
    assert.equal(scalar(`SELECT count(*) FROM pg_policy WHERE polrelid = 'public.place_cooccurrence'::regclass AND NOT polpermissive;`), "4");
  });

  test("R6. 3496's two flags exist and are FALSE", () => {
    assert.equal(scalar(`SELECT string_agg(flag || '=' || enabled::text, ',' ORDER BY flag) FROM public.feature_flags
                          WHERE flag IN ('discovery_place_cooccurrence_enabled', 'discovery_trend_post_convergence_enabled');`),
      "discovery_place_cooccurrence_enabled=false,discovery_trend_post_convergence_enabled=false");
  });
});
